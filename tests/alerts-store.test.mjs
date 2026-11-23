/**
 * Claim-alert storage against a real local D1 database (Miniflare, the same
 * engine Cloudflare's tools use), with the generated migration in ./drizzle applied.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { drizzle } from "drizzle-orm/d1";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as schema from "../db/schema.ts";
import { alertsStore } from "../app/lib/alerts-store.ts";
import { handleRun } from "../app/lib/alerts-api.ts";

let mf, store;
before(async () => {
  // Miniflare 5 (installed with wrangler) changed its options format; its converter accepts the simpler v4 form.
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: ["DB"] }));
  const d1 = await mf.getD1Database("DB");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(new URL(file, dir), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await d1.prepare(statement).run();
    }
  }
  store = alertsStore(drizzle(d1, { schema }));
});
after(async () => { await mf?.dispose(); });

const area = (email, token) => ({ email, name: "Elkhorns", minLon: -112.2, minLat: 46.4, maxLon: -111.9, maxLat: 46.6, unsubscribeToken: token });

test("watches are stored per person and only the owner can delete one", async () => {
  const a = await store.createWatch(area("a@example.com", "1".repeat(32)));
  await store.createWatch(area("b@example.com", "2".repeat(32)));
  assert.equal(a.email, "a@example.com");
  assert.match(a.createdAt, /^\d{4}-\d{2}-\d{2} /, "D1 fills created_at");
  assert.equal(await store.countWatches("a@example.com"), 1);
  assert.deepEqual((await store.listWatches("b@example.com")).map(w => w.unsubscribeToken), ["2".repeat(32)]);
  assert.equal(await store.deleteWatch("b@example.com", a.id), false, "someone else's watch");
  assert.equal(await store.deleteWatch("a@example.com", a.id), true);
  assert.equal(await store.countWatches("a@example.com"), 0);
});

test("unsubscribe tokens are unique and removing by token also clears the sent log", async () => {
  const w = await store.createWatch(area("c@example.com", "3".repeat(32)));
  await assert.rejects(() => store.createWatch(area("d@example.com", "3".repeat(32))), "duplicate token is refused");
  await store.recordSends(w.id, ["k1", "k2"]);
  assert.equal((await store.findByToken("3".repeat(32))).id, w.id);
  assert.equal(await store.deleteByToken("3".repeat(32)), true);
  assert.equal(await store.findByToken("3".repeat(32)), null);
  assert.equal((await store.sentKeys(w.id)).size, 0);
  assert.equal(await store.deleteByToken("3".repeat(32)), false);
});

test("sent keys survive D1's 100-value limit and duplicates are ignored", async () => {
  const w = await store.createWatch(area("e@example.com", "4".repeat(32)));
  const keys = Array.from({ length: 130 }, (_, i) => `2026-11-22:closed:MT${i}`);
  await store.recordSends(w.id, keys);
  await store.recordSends(w.id, keys.slice(0, 10));
  assert.equal((await store.sentKeys(w.id)).size, 130);
});

test("a full nightly run against the real database sends once per change", async () => {
  const w = await store.createWatch(area("f@example.com", "5".repeat(32)));
  const sent = [];
  const deps = { store, email: { apiKey: "re_test", from: "OpenLand <a@x.dev>" }, runSecret: "k", send: async (_c, msg) => { sent.push(msg.to); return { ok: true, id: "em" }; }, now: () => new Date() };
  const today = new Date().toISOString().slice(0, 10);
  const body = { version: 1, generatedAt: new Date().toISOString(), trackingSince: today, windowDays: 120, counts: { notClosed: 1, closed: 1 }, events: [
    { date: today, kind: "closed", id: "MT9", name: "Lucky", type: "placer", acres: 20, lon: -112.0, lat: 46.5, covered: false },
  ] };
  const run = () => handleRun(new Request("https://site.example/api/alerts/run", { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
  // Watches saved by the earlier tests share this area, so count only this test's recipient.
  const first = await (await run()).json();
  assert.ok(first.sent >= 1);
  assert.equal(sent.filter(to => to === "f@example.com").length, 1);
  const second = await (await run()).json();
  assert.equal(second.sent, 0);
  assert.equal(sent.filter(to => to === "f@example.com").length, 1);
  assert.equal((await store.sentKeys(w.id)).size, 1);
});
