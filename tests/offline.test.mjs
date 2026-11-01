/**
 * Unit tests for app/lib/offline.ts (run with `npm run test:unit`).
 * Network calls are stubbed; storage-backed functions aren't exercised here.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { landVerdict, offsetByFeet } from "../app/lib/land-status.ts";
import {
  MAX_AREA_SQ_MI,
  checkLandSmart,
  distanceToRingsFt,
  estimateArea,
  offlineLandCheck,
  pointInRings,
  tileRange,
  tileUrlsFor,
} from "../app/lib/offline.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const origin = { lon: -112.43, lat: 46.52 };
const at = (e, n) => { const p = offsetByFeet(origin, e, n); return [p.lon, p.lat]; };
/** A square ring of `size` feet centred `e`,`n` feet from the origin. */
const square = (e, n, size) => [at(e - size / 2, n - size / 2), at(e + size / 2, n - size / 2), at(e + size / 2, n + size / 2), at(e - size / 2, n + size / 2), at(e - size / 2, n - size / 2)];

test("pointInRings handles holes and distanceToRingsFt measures to the nearest edge", () => {
  const rings = [square(0, 0, 2000), square(0, 0, 400)];
  assert.equal(pointInRings(...at(600, 0), rings), true);
  assert.equal(pointInRings(...at(0, 0), rings), false, "inside the hole");
  assert.equal(pointInRings(...at(1500, 0), rings), false);
  assert.ok(Math.abs(distanceToRingsFt(...at(1100, 0), [square(0, 0, 2000)]) - 100) < 1);
});

test("tile math covers the box and the size estimate enforces the area limit", () => {
  const box = [origin.lon - 0.02, origin.lat - 0.015, origin.lon + 0.02, origin.lat + 0.015];
  const r = tileRange(box, 16);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
  const urls = tileUrlsFor(box, 15, 16, ["t/{z}/{y}/{x}"]);
  const expected = [15, 16].reduce((n, z) => { const t = tileRange(box, z); return n + (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1); }, 0);
  assert.equal(urls.length, expected);
  assert.match(urls[0], /^t\/15\/\d+\/\d+$/);
  assert.equal(estimateArea(box).tooBig, false);
  assert.equal(estimateArea([-113, 46, -112, 47]).tooBig, true, `limit is ${MAX_AREA_SQ_MI} sq mi`);
});

/** A saved area: National Forest everywhere, one active claim, one wilderness, one private parcel. */
function area() {
  return {
    id: "a1", name: "Test", savedAt: new Date().toISOString(), tileUrls: [],
    bbox: [origin.lon - 0.05, origin.lat - 0.05, origin.lon + 0.05, origin.lat + 0.05],
    layers: {
      active: [{ a: { CSE_NAME: "Lucky #1", CSE_NR: "MT1" }, g: [square(3000, 0, 600)] }],
      closed: [],
      parcels: [{ a: { OwnerName: "SMITH RANCH LLC", CountyName: "Powell" }, g: [square(-3000, 0, 1000)] }],
      publicLands: [{ a: { OWNER: "US Forest Service" }, g: [square(0, 0, 9000)] }],
      withdrawals: [],
      wilderness: [{ a: { wildernessname: "Test Wilderness" }, g: [square(0, 3000, 1000)] }],
      flowlines: [],
    },
  };
}

test("offlineLandCheck mirrors the online rules and marks the save date", () => {
  const a = area();
  const open = offlineLandCheck(a, origin.lon, origin.lat);
  assert.equal(open.check.category, "usfs");
  const openVerdict = landVerdict(open.check);
  assert.equal(openVerdict.panning, "likely");
  assert.match(openVerdict.badge, /^📴 /);
  assert.match(openVerdict.detail, /Offline data saved/);
  // 50 ft outside the claim polygon still counts (same 25 m buffer as online).
  assert.equal(landVerdict(offlineLandCheck(a, ...at(3350, 0)).check).panning, "no");
  assert.equal(landVerdict(offlineLandCheck(a, ...at(0, 3000)).check).staking, "no", "wilderness closes the land");
  assert.equal(landVerdict(offlineLandCheck(a, ...at(-3000, 0)).check).panning, "ask", "private parcel inside USFS → ask");
  assert.equal(offlineLandCheck(a, origin.lon + 1, origin.lat), null, "outside the saved box");
  const old = { ...a, savedAt: "2026-01-01T00:00:00Z" };
  assert.match(landVerdict(offlineLandCheck(old, origin.lon, origin.lat).check).detail, /over 30 days old/);
});

test("checkLandSmart uses saved data only when the safety lookups fail or the phone is offline", async () => {
  const a = area();
  const findArea = async () => a;
  // Online and healthy → the online answer, no offline marker.
  globalThis.fetch = async url => (String(url).includes("/2/query") ? json({ features: [{ attributes: { OWNER: "US Bureau of Land Management" } }] }) : json({ features: [] }));
  const online = await checkLandSmart(origin.lon, origin.lat, undefined, { findArea, isOffline: () => false });
  assert.equal(online.check.category, "blm");
  assert.equal(online.check.offlineSavedAt, undefined);
  // Claims service down → saved area answers.
  globalThis.fetch = async url => (String(url).includes("Mining_Claims_Not_Closed") ? json({ error: { message: "down" } }) : json({ features: [] }));
  const fallback = await checkLandSmart(origin.lon, origin.lat, undefined, { findArea, isOffline: () => false });
  assert.equal(fallback.check.category, "usfs");
  assert.ok(fallback.check.offlineSavedAt);
  // Phone offline → saved area answers without touching the network.
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("offline"); };
  const offline = await checkLandSmart(origin.lon, origin.lat, undefined, { findArea, isOffline: () => true });
  assert.ok(offline.check.offlineSavedAt);
  assert.equal(calls, 0);
  // Offline with no saved area → still fails closed.
  const none = await checkLandSmart(origin.lon, origin.lat, undefined, { findArea: async () => null, isOffline: () => true });
  assert.equal(landVerdict(none.check).panning, "unknown");
});
