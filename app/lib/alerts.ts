/**
 * Claim-alert logic with no database or network access (unit-tested in tests/alerts.test.mjs).
 *
 * A watch is a map box someone saved while signed in with ChatGPT. After each
 * nightly claim check (scripts/mt-claim-watch.mjs), the GitHub workflow posts the
 * change list to /api/alerts/run, which emails each watch the changes inside its
 * box that it hasn't been sent yet. Only claims closing, new filings and BLM
 * reversing a closure are emailed; claims BLM silently drops are left out
 * (they're usually data clean-up, not news).
 */
import type { ClaimChange, ClaimChanges } from "./claim-changes.ts";
import { MONTANA_BBOX } from "./claim-markers.ts";
import type { BBox } from "./offline.ts";

/** Most watch areas one person can keep. */
export const MAX_WATCHES_PER_PERSON = 10;
/** Largest watch area, in square miles (a large Montana county is about 5,000). */
export const MAX_WATCH_SQ_MI = 5_000;
/** Only changes this recent are emailed, so a new watch (or a late first send) isn't flooded with history. */
export const ALERT_WINDOW_DAYS = 7;
const SQ_MI_PER_SQ_DEG_AT_EQUATOR = 69.17 * 69.17;
const EMAILED_KINDS = new Set(["closed", "new", "reopened"]);

export type Watch = { id: number; email: string; name: string; minLon: number; minLat: number; maxLon: number; maxLat: number; unsubscribeToken: string; createdAt: string };

/** Square miles covered by a lon/lat box (flat approximation, fine at this scale). */
export function boxSquareMiles([minLon, minLat, maxLon, maxLat]: BBox): number {
  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  return (maxLon - minLon) * (maxLat - minLat) * SQ_MI_PER_SQ_DEG_AT_EQUATOR * Math.cos(midLat);
}

/** Why a box can't be watched, or "" when it can. */
export function watchBoxProblem(box: unknown): string {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(v => typeof v === "number" && Number.isFinite(v))) return "The area must be four numbers: west, south, east, north.";
  const [minLon, minLat, maxLon, maxLat] = box as BBox;
  if (!(minLon < maxLon && minLat < maxLat)) return "The area is empty.";
  if (maxLon < MONTANA_BBOX[0] || minLon > MONTANA_BBOX[2] || maxLat < MONTANA_BBOX[1] || minLat > MONTANA_BBOX[3]) return "Alerts cover Montana only; this area is outside it.";
  const sqMi = boxSquareMiles(box as BBox);
  if (sqMi > MAX_WATCH_SQ_MI) return `This area is about ${Math.round(sqMi).toLocaleString("en-US")} sq mi. Zoom in until it's ${MAX_WATCH_SQ_MI.toLocaleString("en-US")} sq mi or less.`;
  return "";
}

/** A short default name for a box, from its centre. */
export function defaultWatchName([minLon, minLat, maxLon, maxLat]: BBox): string {
  return `Area near ${((minLat + maxLat) / 2).toFixed(3)}, ${((minLon + maxLon) / 2).toFixed(3)}`;
}

/** Unique key for one change, used to avoid emailing it twice. */
export const eventKey = (e: Pick<ClaimChange, "date" | "kind" | "id">) => `${e.date}:${e.kind}:${e.id}`;

/**
 * The changes to email for one watch: inside its box, an emailed kind, a closure BLM
 * hasn't since reversed, dated within the window and no earlier than the day the
 * watch was created, and not already sent.
 */
export function changesForWatch(changes: Pick<ClaimChanges, "events">, watch: Watch, alreadySent: Set<string>, now: Date = new Date()): ClaimChange[] {
  const cutoff = now.getTime() - ALERT_WINDOW_DAYS * 86_400_000;
  const createdDay = String(watch.createdAt).slice(0, 10);
  return changes.events.filter(e =>
    EMAILED_KINDS.has(e.kind)
    && !(e.kind === "closed" && e.reversed)
    && e.lon >= watch.minLon && e.lon <= watch.maxLon && e.lat >= watch.minLat && e.lat <= watch.maxLat
    && Date.parse(`${e.date}T23:59:59Z`) >= cutoff
    && e.date >= createdDay
    && !alreadySent.has(eventKey(e)));
}

const TYPE_LABEL: Record<string, string> = { placer: "Placer claim", lode: "Lode claim", millsite: "Mill site", tunnel: "Tunnel site", other: "Claim" };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export type Digest = { subject: string; text: string; html: string };

/**
 * One email for one watch. `siteUrl` is the app's address; each change links to
 * `?lat=&lon=`, which opens the map there and runs the land check.
 */
export function buildDigest(watch: Watch, changes: ClaimChange[], siteUrl: string, unsubscribeUrl: string): Digest {
  const closed = changes.filter(c => c.kind === "closed");
  const filed = changes.filter(c => c.kind === "new");
  const reopened = changes.filter(c => c.kind === "reopened");
  const counts = [
    closed.length ? `${plural(closed.length, "claim")} closed` : "",
    filed.length ? `${plural(filed.length, "new claim")} filed` : "",
    reopened.length ? `${plural(reopened.length, "closure")} reversed` : "",
  ].filter(Boolean).join(", ");
  const subject = `OpenLand: ${counts} in ${watch.name}`;
  const link = (c: ClaimChange) => `${siteUrl.replace(/\/$/, "")}/?lat=${c.lat.toFixed(5)}&lon=${c.lon.toFixed(5)}`;
  const line = (c: ClaimChange) => {
    const bits = [TYPE_LABEL[c.type] ?? "Claim", c.acres ? `${c.acres.toFixed(1)} ac` : "", c.id, `seen ${c.date}`];
    if (c.kind === "closed") bits.push(c.covered ? "an active claim is mapped on this spot" : "no active claim mapped on this spot");
    return { text: `- ${c.name} (${bits.filter(Boolean).join(", ")})\n  ${link(c)}`, html: `<li><a href="${escapeHtml(link(c))}">${escapeHtml(c.name)}</a> <span style="color:#555">${escapeHtml(bits.filter(Boolean).join(" · "))}</span></li>` };
  };
  const sections: Array<[string, ClaimChange[]]> = [
    ["Claims that closed", closed],
    ["New claims filed", filed],
    ["Closures BLM reversed (claim is active again)", reopened],
  ];
  const caution = "Closed is not the same as open to stake. Open each claim in OpenLand to run the land check (withdrawals, wilderness, private land, newer claims), and confirm in BLM's MLRS before you stake. BLM maps claims to survey squares, not staked corners.";
  const why = `You get this because you asked OpenLand Navigator to watch "${watch.name}". Stop alerts for this area: ${unsubscribeUrl}`;
  const text = [
    `Changes in BLM's Montana claim records for ${watch.name}:`,
    ...sections.filter(([, list]) => list.length).flatMap(([title, list]) => ["", `${title}:`, ...list.map(c => line(c).text)]),
    "",
    caution,
    "",
    why,
  ].join("\n");
  const html = [
    `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">`,
    `<p>Changes in BLM's Montana claim records for <b>${escapeHtml(watch.name)}</b>:</p>`,
    ...sections.filter(([, list]) => list.length).map(([title, list]) => `<h3 style="margin:16px 0 4px">${escapeHtml(title)}</h3><ul>${list.map(c => line(c).html).join("")}</ul>`),
    `<p style="color:#444">${escapeHtml(caution)}</p>`,
    `<p style="color:#666;font-size:12px">You get this because you asked OpenLand Navigator to watch "${escapeHtml(watch.name)}". <a href="${escapeHtml(unsubscribeUrl)}">Stop alerts for this area</a>.</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}
