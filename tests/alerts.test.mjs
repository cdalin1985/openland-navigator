/**
 * Claim alerts: matching, email content and the request handlers, with an
 * in-memory store and a fake email sender. The SQL store is tested separately
 * against a real local D1 in tests/alerts-store.test.mjs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALERT_WINDOW_DAYS, MAX_WATCHES_PER_PERSON, boxSquareMiles, buildDigest, changesForWatch, eventKey, watchBoxProblem,
} from "../app/lib/alerts.ts";
import { handleCreateWatch, handleDeleteWatch, handleListWatches, handleRun, handleUnsubscribe, secretsMatch, userEmail } from "../app/lib/alerts-api.ts";

const now = new Date("2026-11-23T12:00:00Z");
const box = [-112.2, 46.4, -111.9, 46.6];
const watch = { id: 1, email: "a@example.com", name: "Elkhorns", minLon: -112.2, minLat: 46.4, maxLon: -111.9, maxLat: 46.6, unsubscribeToken: "a".repeat(32), createdAt: "2026-11-20 08:00:00" };
const ev = (o) => ({ date: "2026-11-22", kind: "closed", id: "MT1", name: "Lucky", type: "placer", acres: 20, lon: -112.0, lat: 46.5, covered: false, ...o });

test("watch boxes: Montana only, not empty, not bigger than the limit", () => {
  assert.equal(watchBoxProblem(box), "");
  assert.match(watchBoxProblem([1, 2, 3]), /four numbers/);
  assert.match(watchBoxProblem([-112, 46.5, -112, 46.6]), /empty/);
  assert.match(watchBoxProblem([-100, 30, -99, 31]), /Montana only/);
  assert.match(watchBoxProblem([-114, 45, -110, 48]), /Zoom in/);
  assert.ok(Math.abs(boxSquareMiles([-112, 46, -111, 47]) - 3302) < 40, "1° × 1° at 46.5°N is about 3,300 sq mi");
});

test("a watch gets in-box, recent, unsent changes of the emailed kinds only", () => {
  const changes = { events: [
    ev({ id: "IN" }),
    ev({ id: "OUT", lon: -110 }),
    ev({ id: "NEW", kind: "new" }),
    ev({ id: "BACK", kind: "reopened" }),
    ev({ id: "DROP", kind: "removed" }),
    ev({ id: "REV", reversed: true }),
    ev({ id: "OLD", date: "2026-11-01" }),
    ev({ id: "BEFORE", date: "2026-11-19" }),
    ev({ id: "SENT" }),
  ] };
  const sent = new Set([eventKey(ev({ id: "SENT" }))]);
  const got = changesForWatch(changes, watch, sent, now).map(e => e.id).sort();
  assert.deepEqual(got, ["BACK", "IN", "NEW"]);
  assert.ok(ALERT_WINDOW_DAYS >= 3);
});

test("the email lists each section, links each claim and escapes names", () => {
  const d = buildDigest({ ...watch, name: "<Elk & co>" }, [ev({ name: "A<b>" }), ev({ id: "MT2", kind: "new", name: "Fresh", covered: undefined })], "https://site.example/", "https://site.example/api/alerts/unsubscribe?token=x");
  assert.equal(d.subject, "OpenLand: 1 claim closed, 1 new claim filed in <Elk & co>");
  assert.match(d.text, /Claims that closed:\n- A<b> \(Placer claim, 20\.0 ac, MT1, seen 2026-11-22, no active claim mapped on this spot\)/);
  assert.match(d.text, /https:\/\/site\.example\/\?lat=46\.50000&lon=-112\.00000/);
  assert.match(d.html, /&lt;Elk &amp; co&gt;/);
  assert.match(d.html, /A&lt;b&gt;/);
  assert.doesNotMatch(d.html, /<b>A/);
  assert.match(d.text, /Stop alerts for this area: https:\/\/site\.example\/api\/alerts\/unsubscribe\?token=x/);
  assert.match(d.text, /Closed is not the same as open to stake/);
});

/** In-memory store with the same behaviour as app/lib/alerts-store.ts. */
function memoryStore() {
  let next = 1;
  const rows = [], sends = new Map();
  return {
    rows, sends,
    listWatches: async email => rows.filter(r => r.email === email),
    countWatches: async email => rows.filter(r => r.email === email).length,
    createWatch: async w => { const r = { ...w, id: next++, createdAt: "2026-11-21 00:00:00" }; rows.push(r); return r; },
    deleteWatch: async (email, id) => { const i = rows.findIndex(r => r.id === id && r.email === email); if (i < 0) return false; rows.splice(i, 1); sends.delete(id); return true; },
    findByToken: async t => rows.find(r => r.unsubscribeToken === t) ?? null,
    deleteByToken: async t => { const i = rows.findIndex(r => r.unsubscribeToken === t); if (i < 0) return false; sends.delete(rows[i].id); rows.splice(i, 1); return true; },
    allWatches: async () => [...rows],
    sentKeys: async id => new Set(sends.get(id) ?? []),
    recordSends: async (id, keys) => sends.set(id, [...(sends.get(id) ?? []), ...keys]),
  };
}
const req = (method, path, { headers = {}, body } = {}) => new Request(`https://site.example${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const asUser = { "oai-authenticated-user-email": " A@Example.com " };

test("identity comes only from Sign in with ChatGPT's header", () => {
  assert.equal(userEmail(req("GET", "/", { headers: asUser })), "a@example.com");
  assert.equal(userEmail(req("GET", "/")), null);
  assert.equal(userEmail(req("GET", "/", { headers: { "oai-authenticated-user-email": "   " } })), null);
});

test("listing and saving watch areas requires sign-in and validates the box", async () => {
  const store = memoryStore();
  const deps = { store, email: {} };
  assert.equal((await handleListWatches(req("GET", "/api/watches"), deps)).status, 401);
  const created = await handleCreateWatch(req("POST", "/api/watches", { headers: asUser, body: { box, name: "  My   creek  " } }), deps);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).watch.name, "My creek");
  assert.match(store.rows[0].unsubscribeToken, /^[0-9a-f]{32}$/);
  assert.equal((await handleCreateWatch(req("POST", "/api/watches", { headers: asUser, body: { box: [-100, 30, -99, 31] } }), deps)).status, 400);
  assert.equal((await handleCreateWatch(req("POST", "/api/watches", { headers: { ...asUser, "sec-fetch-site": "cross-site" }, body: { box } }), deps)).status, 403);
  const list = await (await handleListWatches(req("GET", "/api/watches", { headers: asUser }), deps)).json();
  assert.equal(list.emailEnabled, false);
  assert.deepEqual(list.watches.map(w => w.box), [box]);
  for (let i = 1; i < MAX_WATCHES_PER_PERSON; i++) await handleCreateWatch(req("POST", "/api/watches", { headers: asUser, body: { box } }), deps);
  const over = await handleCreateWatch(req("POST", "/api/watches", { headers: asUser, body: { box } }), deps);
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /up to 10 areas/);
});

test("people can only delete their own watch areas", async () => {
  const store = memoryStore();
  const deps = { store, email: {} };
  await handleCreateWatch(req("POST", "/api/watches", { headers: asUser, body: { box } }), deps);
  const other = { "oai-authenticated-user-email": "b@example.com" };
  assert.equal((await handleDeleteWatch(req("DELETE", "/api/watches/1", { headers: other }), deps, "1")).status, 404);
  assert.equal(store.rows.length, 1);
  assert.equal((await handleDeleteWatch(req("DELETE", "/api/watches/1", { headers: asUser }), deps, "1")).status, 200);
  assert.equal(store.rows.length, 0);
});

test("unsubscribe: GET only asks, POST stops the alerts", async () => {
  const store = memoryStore();
  const deps = { store, email: {} };
  await store.createWatch({ ...watch, unsubscribeToken: "b".repeat(32) });
  const ask = await handleUnsubscribe(req("GET", `/api/alerts/unsubscribe?token=${"b".repeat(32)}`), deps);
  assert.match(await ask.text(), /Stop alerts for this area/);
  assert.equal(store.rows.length, 1, "a link scanner fetching the URL doesn't unsubscribe anyone");
  const done = await handleUnsubscribe(req("POST", `/api/alerts/unsubscribe?token=${"b".repeat(32)}`), deps);
  assert.match(await done.text(), /won't get alerts/);
  assert.equal(store.rows.length, 0);
  assert.equal((await handleUnsubscribe(req("GET", "/api/alerts/unsubscribe?token=nope"), deps)).status, 400);
});

const changesFile = (events) => ({ version: 1, generatedAt: "2026-11-23T09:30:00Z", trackingSince: "2026-11-18", windowDays: 120, counts: { notClosed: 1, closed: 1 }, events });

test("the nightly run needs the shared secret", async () => {
  const deps = { store: memoryStore(), email: {}, runSecret: "s3cret-value" };
  assert.equal((await handleRun(req("POST", "/api/alerts/run", { body: changesFile([]) }), deps)).status, 401);
  assert.equal((await handleRun(req("POST", "/api/alerts/run", { headers: { authorization: "Bearer wrong-value!" }, body: changesFile([]) }), deps)).status, 401);
  assert.equal((await handleRun(req("POST", "/api/alerts/run", { headers: { authorization: "Bearer s3cret-value" }, body: changesFile([]) }), { ...deps, runSecret: undefined })).status, 503);
  assert.ok(secretsMatch("abc", "abc") && !secretsMatch("abc", "abd") && !secretsMatch("", ""));
});

test("without email configured the run reports what it would send and records nothing", async () => {
  const store = memoryStore();
  await store.createWatch({ ...watch });
  let calls = 0;
  const deps = { store, email: {}, runSecret: "k", send: async () => { calls++; return { ok: true, id: "x" }; }, now: () => now };
  const res = await handleRun(req("POST", "/api/alerts/run", { headers: { authorization: "Bearer k" }, body: changesFile([ev({})]) }), deps);
  assert.deepEqual(await res.json(), { watches: 1, withChanges: 1, changes: 1, sent: 0, failed: 0, dryRun: true, errors: [] });
  assert.equal(calls, 0);
  assert.equal(store.sends.size, 0);
});

test("with email configured each change is sent once, with unsubscribe headers; failures retry next run", async () => {
  const store = memoryStore();
  await store.createWatch({ ...watch });
  const sent = [];
  let fail = true;
  const send = async (cfg, msg) => { if (fail) return { ok: false, error: "Resend HTTP 500" }; sent.push({ cfg, msg }); return { ok: true, id: "em_1" }; };
  const deps = { store, email: { apiKey: "re_test", from: "OpenLand <a@x.dev>" }, runSecret: "k", send, now: () => now };
  const run = () => handleRun(req("POST", "/api/alerts/run", { headers: { authorization: "Bearer k" }, body: changesFile([ev({}), ev({ id: "MT2", kind: "new" })]) }), deps);
  const first = await run();
  assert.equal(first.status, 502);
  assert.equal((await first.json()).failed, 1);
  assert.equal(store.sends.size, 0, "a failed send isn't recorded, so the next run retries it");
  fail = false;
  const second = await (await run()).json();
  assert.equal(second.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.to, "a@example.com");
  assert.match(sent[0].msg.headers["List-Unsubscribe"], /^<https:\/\/site\.example\/api\/alerts\/unsubscribe\?token=a{32}>$/);
  assert.equal(sent[0].msg.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(sent[0].msg.idempotencyKey, /^watch-1-[0-9a-f]{64}$/);
  const third = await (await run()).json();
  assert.equal(third.sent, 0, "already-sent changes aren't emailed again");
  assert.equal(sent.length, 1);
});
