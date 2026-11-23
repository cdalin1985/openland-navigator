/**
 * Request handlers for claim alerts. Kept apart from the route files so tests can
 * pass in a store, an email sender and secrets (the routes read the real ones
 * from the Cloudflare runtime; see app/lib/alerts-deps.ts).
 *
 * Identity: Sign in with ChatGPT. Sites signs people in at /signin-with-chatgpt
 * and passes their verified email to the server in the
 * `oai-authenticated-user-email` header (OpenAI Sites docs, "Data and
 * connections"). Local tests send that header themselves.
 */
import { parseClaimChanges } from "./claim-changes.ts";
import { MAX_WATCHES_PER_PERSON, MAX_WATCH_SQ_MI, buildDigest, changesForWatch, defaultWatchName, eventKey, watchBoxProblem } from "./alerts.ts";
import type { AlertsStore } from "./alerts-store.ts";
import { emailEnabled, sendWithResend, type EmailConfig } from "./email.ts";
import type { BBox } from "./offline.ts";
import { rejectCrossSite } from "./same-origin.ts";

export type AlertsDeps = {
  store: AlertsStore;
  email: EmailConfig;
  /** Shared secret the nightly GitHub workflow sends to /api/alerts/run. */
  runSecret?: string;
  send?: typeof sendWithResend;
  now?: () => Date;
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The signed-in person's email (from Sign in with ChatGPT), lower-cased, or null. */
export function userEmail(request: Request): string | null {
  return request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase() || null;
}

/** Equal-length comparison that doesn't stop at the first difference. */
export function secretsMatch(given: string, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Hex SHA-256 of a string (Web Crypto, available on Workers and Node). */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

const publicWatch = (w: Awaited<ReturnType<AlertsStore["listWatches"]>>[number]) => ({ id: w.id, name: w.name, box: [w.minLon, w.minLat, w.maxLon, w.maxLat], createdAt: w.createdAt });

/** GET /api/watches: the signed-in person's watch areas (401 when signed out). */
export async function handleListWatches(request: Request, deps: AlertsDeps): Promise<Response> {
  const email = userEmail(request);
  if (!email) return json({ signedIn: false }, 401);
  const watches = await deps.store.listWatches(email);
  return json({ signedIn: true, email, emailEnabled: emailEnabled(deps.email), watches: watches.map(publicWatch), limits: { maxWatches: MAX_WATCHES_PER_PERSON, maxSqMi: MAX_WATCH_SQ_MI } });
}

/** POST /api/watches { box: [w, s, e, n], name? }: save a watch area. */
export async function handleCreateWatch(request: Request, deps: AlertsDeps): Promise<Response> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const email = userEmail(request);
  if (!email) return json({ error: "Sign in with ChatGPT to save alert areas" }, 401);
  const body = (await request.json().catch(() => null)) as { box?: unknown; name?: unknown } | null;
  const problem = watchBoxProblem(body?.box);
  if (problem) return json({ error: problem }, 400);
  if ((await deps.store.countWatches(email)) >= MAX_WATCHES_PER_PERSON) return json({ error: `You can watch up to ${MAX_WATCHES_PER_PERSON} areas. Remove one first.` }, 400);
  const box = (body!.box as number[]).map(v => Math.round(v * 1e5) / 1e5) as BBox;
  const name = (typeof body?.name === "string" ? body.name : "").replace(/\s+/g, " ").trim().slice(0, 80) || defaultWatchName(box);
  const watch = await deps.store.createWatch({ email, name, minLon: box[0], minLat: box[1], maxLon: box[2], maxLat: box[3], unsubscribeToken: randomToken() });
  return json({ watch: publicWatch(watch) }, 201);
}

/** DELETE /api/watches/:id: remove one of the signed-in person's watch areas. */
export async function handleDeleteWatch(request: Request, deps: AlertsDeps, id: string): Promise<Response> {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const email = userEmail(request);
  if (!email) return json({ error: "Sign in with ChatGPT first" }, 401);
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return json({ error: "Bad watch id" }, 400);
  return (await deps.store.deleteWatch(email, n)) ? json({ deleted: n }) : json({ error: "No such watch area" }, 404);
}

const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
  `<body style="font-family:Arial,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;line-height:1.5">${body}</body></html>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * /api/alerts/unsubscribe?token=…  GET shows a confirm button (so link scanners in
 * mail apps can't unsubscribe anyone by fetching the link); POST removes the watch.
 * POST is also the one-click unsubscribe that mail apps send (RFC 8058).
 */
export async function handleUnsubscribe(request: Request, deps: AlertsDeps): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!/^[0-9a-f]{32}$/.test(token)) return page("Link not valid", "<p>This unsubscribe link isn't valid.</p>", 400);
  if (request.method === "POST") {
    const removed = await deps.store.deleteByToken(token);
    return page("Alerts stopped", removed ? "<p>Done. You won't get alerts for that area any more.</p>" : "<p>Those alerts were already stopped.</p>");
  }
  const watch = await deps.store.findByToken(token);
  if (!watch) return page("Alerts stopped", "<p>Those alerts were already stopped.</p>");
  return page("Stop alerts", `<p>Stop OpenLand claim alerts for <b>${escapeHtml(watch.name)}</b>?</p>` +
    `<form method="post"><button type="submit" style="padding:10px 16px;font-size:16px">Stop alerts for this area</button></form>`);
}

/**
 * POST /api/alerts/run with the nightly change list as the body and
 * `Authorization: Bearer <ALERTS_RUN_SECRET>`. Emails each watch its unsent changes.
 * Without email configured it reports what it would send and records nothing,
 * so switching email on later doesn't skip anything still inside the window.
 */
export async function handleRun(request: Request, deps: AlertsDeps): Promise<Response> {
  if (!deps.runSecret) return json({ error: "ALERTS_RUN_SECRET isn't set on this Site" }, 503);
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!secretsMatch(given, deps.runSecret)) return json({ error: "Not allowed" }, 401);
  let changes;
  try {
    changes = parseClaimChanges(await request.json());
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Bad change list" }, 400);
  }
  const now = deps.now?.() ?? new Date();
  const origin = new URL(request.url).origin;
  const send = deps.send ?? sendWithResend;
  const enabled = emailEnabled(deps.email);
  const summary = { watches: 0, withChanges: 0, changes: 0, sent: 0, failed: 0, dryRun: !enabled, errors: [] as string[] };
  for (const watch of await deps.store.allWatches()) {
    summary.watches++;
    const list = changesForWatch(changes, watch, await deps.store.sentKeys(watch.id), now);
    if (!list.length) continue;
    summary.withChanges++;
    summary.changes += list.length;
    if (!enabled) continue;
    const unsubscribeUrl = `${origin}/api/alerts/unsubscribe?token=${watch.unsubscribeToken}`;
    const digest = buildDigest(watch, list, origin, unsubscribeUrl);
    const result = await send(deps.email, {
      to: watch.email,
      ...digest,
      headers: { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      // Same watch + same changes = same key, so a retried run can't send a duplicate.
      idempotencyKey: `watch-${watch.id}-${await sha256(list.map(eventKey).sort().join("|"))}`,
    });
    if (result.ok) {
      summary.sent++;
      await deps.store.recordSends(watch.id, list.map(eventKey));
    } else {
      summary.failed++;
      summary.errors.push(`watch ${watch.id}: ${result.error}`);
    }
  }
  return json(summary, summary.failed ? 502 : 200);
}
