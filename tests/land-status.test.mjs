/**
 * Unit tests for app/lib/land-status.ts (run with `npm run test:unit`).
 *
 * Node strips the TypeScript types on import, so no build step is needed.
 * The fetch-based tests stub globalThis.fetch; nothing here touches the network.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  arcgisFeatures,
  buildStakingPacket,
  checkLandAt,
  classifyLand,
  feetPerDegree,
  findBendSpots,
  landVerdict,
  offsetByFeet,
  stakeBoxCorners,
} from "../app/lib/land-status.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const baseCheck = { category: "blm", ownerName: "US Bureau of Land Management", activeClaims: 0, closedClaims: 0, failed: [], checkedAt: "2026-11-01T00:00:00Z" };

test("arcgisFeatures throws on ArcGIS's HTTP-200 error body instead of returning no features", async () => {
  globalThis.fetch = async () => json({ error: { code: 400, message: "Failed to execute query." } });
  await assert.rejects(() => arcgisFeatures("https://example.test/query"), /Failed to execute query/);
});

test("arcgisFeatures throws when the features array is missing, and returns features otherwise", async () => {
  globalThis.fetch = async () => json({});
  await assert.rejects(() => arcgisFeatures("https://example.test/query"), /no features array/);
  globalThis.fetch = async () => json({ features: [{ attributes: { A: 1 } }] });
  assert.deepEqual(await arcgisFeatures("https://example.test/query"), [{ attributes: { A: 1 } }]);
});

test("checkLandAt fails closed when the BLM claims service errors", async () => {
  globalThis.fetch = async url => {
    if (String(url).includes("Mining_Claims_Not_Closed")) return json({ error: { code: 500, message: "down" } });
    if (String(url).includes("/2/query")) return json({ features: [{ attributes: { OWNER: "US Bureau of Land Management" } }] });
    if (String(url).includes("/1/query")) return json({ features: [{ attributes: { OwnerName: "USDI BUREAU OF LAND MANAGEMENT R" } }] });
    return json({ features: [] });
  };
  const { check } = await checkLandAt(-112.3, 46.75);
  assert.equal(check.activeClaims, null);
  assert.deepEqual(check.failed, ["BLM active claims"]);
  const verdict = landVerdict(check);
  assert.equal(verdict.panning, "unknown");
  assert.match(verdict.badge, /COULDN'T VERIFY/);
});

test("checkLandAt treats a network rejection on ownership as unknown ownership", async () => {
  globalThis.fetch = async url => {
    if (String(url).includes("/2/query")) throw new TypeError("network down");
    return json({ features: [] });
  };
  const { check } = await checkLandAt(-112.3, 46.75);
  assert.equal(check.category, "unknown");
  assert.equal(landVerdict(check).panning, "unknown");
});

test("classifyLand uses the public-lands owner and refuses to guess on conflicts", () => {
  assert.equal(classifyLand("US Bureau of Land Management", "USDI BUREAU OF LAND MANAGEMENT R"), "blm");
  assert.equal(classifyLand("US Forest Service", "USDA FOREST SERVICE"), "usfs");
  assert.equal(classifyLand("US Bureau of Land Management", "SMITH RANCH LLC"), "unknown");
  assert.equal(classifyLand("Montana State Trust Lands", "STATE OF MONTANA DNRC"), "stateTrust");
  assert.equal(classifyLand("US Fish and Wildlife Service", ""), "noCollecting");
  assert.equal(classifyLand("National Park Service", ""), "noCollecting");
  assert.equal(classifyLand("City Government", "TOWN OF VIRGINIA CITY"), "otherPublic");
  assert.equal(classifyLand("US Bureau of Reclamation", ""), "otherPublic");
  assert.equal(classifyLand("", "71 RANCH LP"), "private");
  assert.equal(classifyLand("", ""), "unknown");
});

test("landVerdict only says 'likely' for open BLM/USFS land with no active claim", () => {
  assert.equal(landVerdict(baseCheck).panning, "likely");
  assert.equal(landVerdict({ ...baseCheck, category: "usfs" }).panning, "likely");
  assert.equal(landVerdict({ ...baseCheck, activeClaims: 2 }).panning, "no");
  assert.equal(landVerdict({ ...baseCheck, category: "stateTrust" }).panning, "no");
  assert.equal(landVerdict({ ...baseCheck, category: "noCollecting" }).panning, "no");
  assert.equal(landVerdict({ ...baseCheck, category: "private" }).panning, "ask");
  assert.equal(landVerdict({ ...baseCheck, category: "otherPublic" }).panning, "ask");
  assert.equal(landVerdict({ ...baseCheck, category: "unknown" }).panning, "ask");
  const closed = landVerdict({ ...baseCheck, closedClaims: 1 });
  assert.equal(closed.tone, "caution");
  assert.equal(closed.panning, "likely");
  // A failed closed-claims lookup alone doesn't block casual panning.
  assert.equal(landVerdict({ ...baseCheck, closedClaims: null, failed: ["BLM closed claims"] }).panning, "likely");
  for (const category of ["blm", "usfs", "private", "stateTrust", "noCollecting", "otherPublic", "unknown"]) {
    assert.doesNotMatch(landVerdict({ ...baseCheck, category }).badge + landVerdict({ ...baseCheck, category }).detail, /100%|JACKPOT|LEGAL TO STAKE/);
  }
});

test("feetPerDegree matches the WGS84 ellipsoid at Helena's latitude", () => {
  const k = feetPerDegree(46.7);
  assert.ok(Math.abs(k.lat - 364_712) / 364_712 < 0.001, `lat ${k.lat}`);
  assert.ok(Math.abs(k.lon - 250_920) / 250_920 < 0.001, `lon ${k.lon}`);
});

/** Shoelace area in square feet of [lon, lat] corners, using local feet-per-degree. */
function areaSqFt(corners) {
  const k = feetPerDegree(corners[0][1]);
  const pts = corners.map(([lon, lat]) => [lon * k.lon, lat * k.lat]);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

test("stakeBoxCorners keeps legal dimensions at any rotation", () => {
  const center = { lon: -112.3, lat: 46.75 };
  const k = feetPerDegree(center.lat);
  const [nw, ne, , sw] = stakeBoxCorners(center, 0, "placer");
  assert.ok(Math.abs((ne[0] - nw[0]) * k.lon - 660) < 0.5);
  assert.ok(Math.abs((nw[1] - sw[1]) * k.lat - 1320) < 0.5);
  for (const angle of [0, 35, 90, 145]) {
    assert.ok(Math.abs(areaSqFt(stakeBoxCorners(center, angle, "placer")) - 871_200) < 50, `placer ${angle}`);
    assert.ok(Math.abs(areaSqFt(stakeBoxCorners(center, angle, "lode")) - 900_000) < 50, `lode ${angle}`);
  }
  // Rotating 90° clockwise turns the long north-south axis east-west.
  const [a, b] = stakeBoxCorners(center, 90, "placer");
  assert.ok(Math.abs(Math.hypot((b[0] - a[0]) * k.lon, (b[1] - a[1]) * k.lat) - 660) < 0.5);
  assert.ok(Math.abs((a[1] - b[1]) * k.lat) > 600, "NW→NE edge now runs north-south");
});

/** Build an NHD-like flowline from points given in feet east/north of an origin. */
function flowline(name, ftype, feetPoints, origin = { lon: -112.3, lat: 46.75 }) {
  const path = feetPoints.map(([e, n]) => { const p = offsetByFeet(origin, e, n); return [p.lon, p.lat]; });
  return { attributes: { gnis_name: name, ftype }, geometry: { paths: [path] } };
}

test("findBendSpots finds a real bend and its inside bank, but ignores ditches and digitizing kinks", () => {
  const origin = { lon: -112.3, lat: 46.75 };
  // Flows north for 300 ft, then turns 90° to the east: the inside of that bend is to the south-east.
  const bend = [];
  for (let n = -300; n <= 0; n += 10) bend.push([0, n]);
  for (let e = 10; e <= 300; e += 10) bend.push([e, 0]);
  const spots = findBendSpots([flowline("Silver Creek", 460, bend)], origin.lon, origin.lat);
  assert.equal(spots.length, 1);
  assert.ok(spots[0].turnDeg > 60, `turn ${spots[0].turnDeg}`);
  assert.equal(spots[0].insideSide, "SE");
  assert.equal(spots[0].name, "Silver Creek");

  assert.deepEqual(findBendSpots([flowline("Big Ditch", 336, bend)], origin.lon, origin.lat), []);

  // A straight creek with one 5-ft sideways jog (a digitizing kink) is not a bend.
  const kink = [];
  for (let n = -300; n <= 300; n += 20) kink.push([n === 0 ? 5 : 0, n]);
  assert.deepEqual(findBendSpots([flowline("Straight Creek", 460, kink)], origin.lon, origin.lat), []);
});

test("buildStakingPacket uses verified fees, warns about MCA 82-2-115, and invents nothing", () => {
  const center = { lon: -112.3, lat: 46.75 };
  const corners = stakeBoxCorners(center, 0, "placer");
  const ok = landVerdict(baseCheck);
  const packet = buildStakingPacket({
    kind: "placer", center, angleDeg: 0, corners, county: "Lewis and Clark", legal: "S35, T12 N, R06 W",
    pointChecks: [{ label: "Centre", verdict: ok }, { label: "Corner NE", verdict: landVerdict({ ...baseCheck, category: "private" }) }],
  });
  assert.match(packet, /\$274 per claim/);
  assert.match(packet, /82-2-115/);
  assert.match(packet, /Within 30 days/);
  assert.match(packet, /STOP/);
  assert.match(packet, /Corner NE: 🏠 Private land/);
  assert.match(packet, /Corner NW: 46\.75/);
  assert.doesNotMatch(packet, /eBay|GoldBay|Gold & Silver|PLSS Verified|Restake Candidate/i);
  assert.doesNotMatch(buildStakingPacket({ kind: "lode", center, angleDeg: 20, corners, pointChecks: [{ label: "Centre", verdict: ok }] }), /STOP/);
  assert.match(buildStakingPacket({ kind: "lode", center, angleDeg: 20, corners, pointChecks: null }), /still running/);
});
