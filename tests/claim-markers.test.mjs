/**
 * Unit tests for app/lib/claim-markers.ts (run with `npm run test:unit`).
 * BLM's services are stubbed; the live layers were checked separately.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  MONTANA_BBOX,
  claimTypeOf,
  clipToMontana,
  degreesPerPixel,
  loadClaimMarkers,
  markCovered,
  markerNote,
  markerPoint,
  toMarkers,
} from "../app/lib/claim-markers.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
/** A closed square ring with its south-west corner at (x, y). */
const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const feature = (rings, attributes) => ({ attributes, geometry: { rings } });

test("claim types follow BLM's product names whatever their capitalisation", () => {
  assert.equal(claimTypeOf("PLACER CLAIM"), "placer");
  assert.equal(claimTypeOf("Placer Claim - National Park"), "placer");
  assert.equal(claimTypeOf("Lode Claim"), "lode");
  assert.equal(claimTypeOf("MILL SITE"), "millsite");
  assert.equal(claimTypeOf("Tunnel Site"), "tunnel");
  assert.equal(claimTypeOf(undefined), "other");
});

test("a marker sits at the centre of the claim's largest part", () => {
  const [lon, lat] = markerPoint([square(-112.5, 46.5, 0.002)]);
  assert.ok(Math.abs(lon - -112.499) < 1e-6 && Math.abs(lat - 46.501) < 1e-6);
  // Two parts: the big one wins, not the average of both.
  const big = markerPoint([square(-112, 46, 0.0001), square(-111, 45, 0.01)]);
  assert.ok(Math.abs(big[0] - -110.995) < 1e-6 && Math.abs(big[1] - 45.005) < 1e-6);
  // An L shape's area-weighted centre, not its vertex average.
  const L = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2], [0, 0]];
  const [cx, cy] = markerPoint([L]);
  assert.ok(Math.abs(cx - 5 / 6) < 1e-6 && Math.abs(cy - 5 / 6) < 1e-6);
  assert.equal(markerPoint(undefined), null);
  assert.equal(markerPoint([[[0, 0], [1, 1]]]), null, "fewer than 3 points is not a shape");
});

test("BLM records become markers with readable fields", () => {
  const [m] = toMarkers([feature([square(-112, 46, 0.001)], { CSE_NAME: " Lucky #1 ", CSE_NR: "MT101", BLM_PROD: "Placer Claim", CSE_DISP: "Active", RCRD_ACRS: 20 })], "active");
  assert.deepEqual({ ...m, lon: undefined, lat: undefined }, {
    id: "MT101", status: "active", type: "placer", name: "Lucky #1", disposition: "Active", acres: 20, covered: null, lon: undefined, lat: undefined,
  });
  const [blank] = toMarkers([feature([square(0, 0, 1)], { OBJECTID: 7, LEG_CSE_NR: "" })], "closed");
  assert.equal(blank.id, "record-7");
  assert.equal(blank.name, "Unnamed claim");
  assert.equal(blank.disposition, "Closed");
  assert.equal(blank.acres, null);
  assert.equal(toMarkers([{ attributes: { CSE_NR: "x" } }], "active").length, 0, "no shape, no marker");
});

test("a closed claim is 'covered' only when an active claim is mapped on its centre", () => {
  const closed = toMarkers([
    feature([square(0, 0, 1)], { CSE_NR: "OLD1" }),
    feature([square(5, 5, 1)], { CSE_NR: "OLD2" }),
  ], "closed");
  const active = [[square(-1, -1, 3)]];
  const result = markCovered(closed, active);
  assert.equal(result.find(c => c.id === "OLD1").covered, true);
  assert.equal(result.find(c => c.id === "OLD2").covered, false);
});

test("shapes are simplified to about a pixel for the zoom level", () => {
  assert.ok(Math.abs(degreesPerPixel(11) - 0.000686) < 0.00001);
  assert.ok(degreesPerPixel(15) < degreesPerPixel(11) / 15);
});

const box = [-112.1, 46.4, -112.0, 46.5];
const activeFeature = feature([square(-112.06, 46.44, 0.01)], { CSE_NR: "MT1", BLM_PROD: "Lode Claim", CSE_DISP: "Active" });
const closedUnder = feature([square(-112.056, 46.444, 0.002)], { CSE_NR: "MT2", BLM_PROD: "PLACER CLAIM", CSE_DISP: "Closed" });
const closedOpen = feature([square(-112.02, 46.41, 0.002)], { CSE_NR: "MT3", BLM_PROD: "PLACER CLAIM", CSE_DISP: "Closed" });

test("loading a view returns both kinds and checks closed claims against active ones", async () => {
  const urls = [];
  globalThis.fetch = async url => {
    urls.push(String(url));
    return json({ features: String(url).includes("Not_Closed") ? [activeFeature] : [closedUnder, closedOpen] });
  };
  const r = await loadClaimMarkers(box, 12, { active: true, closed: true });
  assert.deepEqual(r.failed, []);
  assert.equal(r.truncated, false);
  assert.equal(r.coverChecked, true);
  assert.deepEqual(r.active.map(m => m.id), ["MT1"]);
  assert.deepEqual(r.closed.map(m => [m.id, m.covered]), [["MT2", true], ["MT3", false]]);
  assert.equal(markerNote(r), "");
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("geometryType"), "esriGeometryEnvelope");
  assert.equal(q.get("outSR"), "4326");
  assert.equal(q.get("resultRecordCount"), "2000");
});

test("a failed active lookup is reported and leaves closed claims unchecked, never 'open'", async () => {
  globalThis.fetch = async url => (String(url).includes("Not_Closed") ? json({ error: { code: 500, message: "down" } }) : json({ features: [closedUnder, closedOpen] }));
  const r = await loadClaimMarkers(box, 12, { active: true, closed: true });
  assert.deepEqual(r.failed, ["active"]);
  assert.equal(r.coverChecked, false);
  assert.ok(r.closed.every(m => m.covered === null));
  assert.match(markerNote(r), /Couldn't load active claim icons/);
  assert.match(markerNote(r), /outlines \(not checked\)/);
});

test("with active icons switched off, active claims are still fetched for the check but not returned", async () => {
  globalThis.fetch = async url => json({ features: String(url).includes("Not_Closed") ? [activeFeature] : [closedUnder] });
  const r = await loadClaimMarkers(box, 12, { active: false, closed: true });
  assert.equal(r.active.length, 0);
  assert.equal(r.closed[0].covered, true);
  // ...and if that hidden lookup fails, the closed icons say they weren't checked.
  globalThis.fetch = async url => (String(url).includes("Not_Closed") ? Promise.reject(new TypeError("offline")) : json({ features: [closedUnder] }));
  const r2 = await loadClaimMarkers(box, 12, { active: false, closed: true });
  assert.deepEqual(r2.failed, []);
  assert.equal(r2.closed[0].covered, null);
  assert.match(markerNote(r2), /couldn't be compared/);
});

test("a full page means more claims than one view loads: say so instead of hiding it", async () => {
  const many = Array.from({ length: 2000 }, (_, i) => feature([square(-112.05 + i * 1e-6, 46.45, 0.001)], { CSE_NR: `MT${i}` }));
  let calls = 0;
  globalThis.fetch = async url => { calls++; return json({ features: String(url).includes("Not_Closed") ? many : [] }); };
  const r = await loadClaimMarkers(box, 11, { active: true, closed: true });
  assert.equal(r.truncated, true);
  assert.equal(r.coverChecked, false, "an incomplete active set can't clear a closed claim");
  assert.equal(calls, 3, "two pages of active claims, one of closed");
  assert.match(markerNote(r), /Zoom in/);
});

test("nothing is fetched when both claim layers are switched off", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ features: [] }); };
  const r = await loadClaimMarkers(box, 12, { active: false, closed: false });
  assert.equal(calls, 0);
  assert.deepEqual(r.active, []);
});

test("zoomed out, only closed claims load (whole box, clipped to Montana) and they're marked not checked", async () => {
  const urls = [];
  globalThis.fetch = async url => { urls.push(String(url)); return json({ features: [closedUnder, closedOpen] }); };
  const r = await loadClaimMarkers([-125, 40, -100, 52], 6, { active: true, closed: true });
  assert.equal(urls.length, 1, "no active-claim lookup when zoomed out");
  assert.ok(urls[0].includes("Mining_Claims_Closed"));
  const q = new URL(urls[0]).searchParams;
  assert.equal(q.get("geometry"), MONTANA_BBOX.map(v => v.toFixed(5)).join(","));
  assert.equal(q.get("maxAllowableOffset"), "0.000500", "small claims are never simplified away");
  assert.equal(q.get("where"), "CSE_NR LIKE 'MT%'", "zoomed out, only Montana case numbers");
  assert.equal(r.zoomedOut, true);
  assert.equal(r.coverChecked, false);
  assert.deepEqual(r.failed, []);
  assert.ok(r.closed.every(m => m.covered === null));
  assert.equal(markerNote(r), "", "not checking while zoomed out is expected, not an error");
});

test("zoomed out with closed claims switched off, nothing loads", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ features: [] }); };
  await loadClaimMarkers(box, 8, { active: true, closed: false });
  assert.equal(calls, 0);
});

test("boxes are clipped to Montana; a box outside it loads nothing", async () => {
  assert.deepEqual(clipToMontana([-120, 45, -110, 50]), [-116.05, 45, -110, 49]);
  assert.equal(clipToMontana([-100, 30, -90, 35]), null);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ features: [] }); };
  const r = await loadClaimMarkers([-100, 30, -90, 35], 12, { active: true, closed: true });
  assert.equal(calls, 0);
  assert.deepEqual(r.failed, []);
});
