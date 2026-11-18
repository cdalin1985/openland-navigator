/**
 * The nightly Montana claim-change list ("Recently closed in Montana").
 *
 * scripts/mt-claim-watch.mjs runs every night in GitHub Actions
 * (.github/workflows/mt-claim-watch.yml), compares BLM's Montana claims with the
 * night before, and publishes mt-claim-changes.json on the repo's `data` branch.
 * The app reads it straight from GitHub (public, CORS-enabled, cached ~5 minutes).
 *
 * A missing, unreadable or malformed file is an error, never "no closures".
 */
import type { ClaimType } from "./claim-markers.ts";

export const CLAIM_CHANGES_URL = "https://raw.githubusercontent.com/cdalin1985/openland-navigator/data/mt-claim-changes.json";
/** Closures this recent get a highlight ring on the map. */
export const RECENT_DAYS = 30;
/** The job runs nightly; data older than this means it has stopped. */
export const STALE_AFTER_DAYS = 2;

export type ChangeKind = "closed" | "new" | "removed" | "reopened";
export type ClaimChange = {
  /** Night the change was first seen (YYYY-MM-DD, UTC). */
  date: string;
  kind: ChangeKind;
  /** BLM case number (same id as the map icons). */
  id: string;
  name: string;
  type: ClaimType;
  acres: number | null;
  lon: number;
  lat: number;
  /** Closures only: an active claim is mapped on the spot. */
  covered?: boolean;
  /** Closures only: BLM later reopened the claim. */
  reversed?: boolean;
};
export type ClaimChanges = {
  generatedAt: string;
  trackingSince: string;
  windowDays: number;
  counts: { notClosed: number; closed: number };
  events: ClaimChange[];
};

const KINDS = new Set<ChangeKind>(["closed", "new", "removed", "reopened"]);
const TYPES = new Set<ClaimType>(["lode", "placer", "millsite", "tunnel", "other"]);
const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Check the file's shape. Throws on anything malformed; bad individual events are dropped. */
export function parseClaimChanges(raw: unknown): ClaimChanges {
  const d = raw as Partial<ClaimChanges> | null;
  if (!d || typeof d !== "object" || !isDate(d.generatedAt) || !isDate(d.trackingSince) || !Array.isArray(d.events)
    || !d.counts || !isNum(d.counts.notClosed) || !isNum(d.counts.closed)) {
    throw new Error("The claim-change file is not in the expected format");
  }
  const events = d.events.filter((e): e is ClaimChange =>
    !!e && isDate(e.date) && KINDS.has(e.kind) && typeof e.id === "string" && typeof e.name === "string"
    && TYPES.has(e.type) && isNum(e.lon) && isNum(e.lat) && (e.acres === null || isNum(e.acres)));
  return { generatedAt: d.generatedAt, trackingSince: d.trackingSince, windowDays: isNum(d.windowDays) ? d.windowDays : 120, counts: d.counts, events };
}

/** Fetch and check the change list. Throws on any failure. */
export async function loadClaimChanges(signal?: AbortSignal): Promise<ClaimChanges> {
  // A plain controller rather than AbortSignal.any, which older iPhones (before iOS 17.4) lack.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });
  try {
    const res = await fetch(CLAIM_CHANGES_URL, { signal: controller.signal, cache: "no-cache" });
    if (res.status === 404) throw new Error("The nightly claim check hasn't published any results yet");
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    return parseClaimChanges(await res.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

const DAY = 86_400_000;
const dayStart = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);

/** Ids of claims seen closing in the last `days` days that BLM hasn't reopened. */
export function recentClosureIds(changes: ClaimChanges, now: Date = new Date(), days = RECENT_DAYS): Set<string> {
  const cutoff = now.getTime() - days * DAY;
  return new Set(changes.events.filter(e => e.kind === "closed" && !e.reversed && dayStart(e.date) >= cutoff - DAY).map(e => e.id));
}

/** Whole days since the job last published (0 = today). */
export function daysSinceUpdate(changes: ClaimChanges, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(changes.generatedAt)) / DAY));
}

/** Closures newest first, then everything else that happened in the last `days` days, by kind. */
export function summarize(changes: ClaimChanges, now: Date = new Date(), days = RECENT_DAYS) {
  const cutoff = now.getTime() - days * DAY;
  const recent = changes.events.filter(e => dayStart(e.date) >= cutoff - DAY);
  return {
    closures: changes.events.filter(e => e.kind === "closed"),
    newLast30: recent.filter(e => e.kind === "new").length,
    removedLast30: recent.filter(e => e.kind === "removed").length,
  };
}
