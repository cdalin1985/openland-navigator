/**
 * Unit tests for app/lib/geologist.ts (run with `npm run test:unit`).
 * Network calls are stubbed; nothing here touches USGS services.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { classifyUpstream, formatEvidence, gradientAt, sampleAlong, upstreamEvidence } from "../app/lib/geologist.ts";
import { feetPerDegree, offsetByFeet } from "../app/lib/land-status.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const origin = { lon: -112.3, lat: 46.75 };
const at = (e, n) => { const p = offsetByFeet(origin, e, n); return [p.lon, p.lat]; };

test("sampleAlong spaces points evenly and keeps both ends", () => {
  const line = [at(0, 0), at(0, 400), at(0, 1000)];
  const pts = sampleAlong(line, 100);
  assert.equal(pts.length, 11);
  const k = feetPerDegree(origin.lat);
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot((pts[i][0] - pts[i - 1][0]) * k.lon, (pts[i][1] - pts[i - 1][1]) * k.lat);
    assert.ok(Math.abs(d - 100) < 0.5, `segment ${i} is ${d} ft`);
  }
  assert.deepEqual(pts.at(-1), line.at(-1));
});

/** A creek flowing south: 5% slope for 1500 ft above the origin, 1% for 1500 ft below it. */
function creekSamples() {
  const out = [];
  for (let n = 1500; n >= -1500; n -= 100) {
    const dropFt = n >= 0 ? (1500 - n) * 0.05 : 75 + -n * 0.01;
    const [lon, lat] = at(0, n);
    out.push({ lon, lat, elevM: (6000 - dropFt) / 3.28084 });
  }
  return out;
}

test("gradientAt measures the slope above and below the point and spots a flattening", () => {
  const g = gradientAt(creekSamples(), origin.lon, origin.lat);
  assert.ok(Math.abs(g.upstreamPct - 5) < 0.05, `up ${g.upstreamPct}`);
  assert.ok(Math.abs(g.downstreamPct - 1) < 0.05, `down ${g.downstreamPct}`);
  assert.equal(g.flattens, true);
  assert.ok(g.offStreamFt < 1);
  // Same answer if the samples arrive in the uphill direction.
  const reversed = gradientAt(creekSamples().reverse(), origin.lon, origin.lat);
  assert.ok(Math.abs(reversed.upstreamPct - 5) < 0.05 && reversed.flattens);
  // A point 500 ft east of the creek reports its distance from the stream line.
  const off = offsetByFeet(origin, 500, 0);
  assert.ok(Math.abs(gradientAt(creekSamples(), off.lon, off.lat).offStreamFt - 500) < 1);
  // Not enough stream on one side → no measurement.
  const top = at(0, 1450);
  assert.equal(gradientAt(creekSamples(), top[0], top[1]), null);
});

test("classifyUpstream ranks gold producers above prospects above non-gold sites", () => {
  const r = (name, status, gold) => ({ id: name, name, status, gold });
  const strong = classifyUpstream([r("Shannon Mine", "Past Producer", true), r("Shannon Mine", "Past Producer", true), r("Cruse Mine", "Prospect", true), r("Lime Pit", "Producer", false)]);
  assert.equal(strong.level, "strong");
  assert.deepEqual(strong.producers, ["Shannon Mine"]);
  assert.deepEqual(strong.prospects, ["Cruse Mine"]);
  assert.equal(strong.otherSites, 1);
  assert.equal(classifyUpstream([r("Gold Hill", "Occurrence", true)]).level, "some");
  assert.equal(classifyUpstream([r("Gravel Pit", "Producer", false)]).level, "weak");
  assert.equal(classifyUpstream([]).level, "none");
  // MRDS often lists one site under two spellings.
  assert.deepEqual(classifyUpstream([r("Carbonate King Mine", "Past Producer", true), r("Carbonate King", "Producer", true)]).producers, ["Carbonate King Mine"]);
});

test("upstreamEvidence uses only mines inside the upstream basin and measures the gradient", async () => {
  const reach = [];
  for (let n = 1500; n >= -1500; n -= 250) reach.push(at(0, n));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/comid/position")) return json({ features: [{ properties: { comid: "3021932" }, geometry: { type: "LineString", coordinates: reach } }] });
    if (u.includes("/basin")) return json({ features: [{ geometry: { type: "Polygon", coordinates: [[at(-3000, -2000), at(3000, -2000), at(3000, 9000), at(-3000, 9000), at(-3000, -2000)]] } }] });
    if (u.includes("getSamples")) {
      const pts = JSON.parse(new URLSearchParams(String(init.body)).get("geometry")).points;
      const k = feetPerDegree(origin.lat);
      return json({ samples: pts.map(([, y], i) => {
        const n = (y - origin.lat) * k.lat;
        const dropFt = n >= 0 ? (1500 - n) * 0.05 : 75 + -n * 0.01;
        return { locationId: i, value: String((6000 - dropFt) / 3.28084) };
      }) });
    }
    if (u.includes("/FeatureServer/0/query")) return json({ features: [{ attributes: { DEP_ID: "10001", SITE_NAME: "Shannon Mine", DEV_STAT: "Past Producer" } }, { attributes: { DEP_ID: "10002", SITE_NAME: "Sand Pit", DEV_STAT: "Producer" } }] });
    if (u.includes("/FeatureServer/10/query")) return json({ features: [{ attributes: { Record_ID: "10001", Commodity_name: "Gold" } }, { attributes: { Record_ID: "10002", Commodity_name: "Sand and Gravel" } }] });
    return json({ error: { message: `unexpected ${u}` } });
  };
  const e = await upstreamEvidence(origin.lon, origin.lat);
  assert.equal(e.level, "strong");
  assert.deepEqual(e.producers, ["Shannon Mine"]);
  assert.equal(e.otherSites, 1);
  assert.ok(e.gradient && e.gradient.flattens, JSON.stringify(e.gradient));
  assert.equal(e.elevationFt, 5925);
  assert.deepEqual(e.failed, []);
  assert.ok(e.reachDistanceFt < 1, `reach distance ${e.reachDistanceFt}`);
  assert.ok(Math.abs(e.drainageSqMi - 66_000_000 / 27_878_400) < 0.01, `drainage ${e.drainageSqMi}`);
  assert.match(formatEvidence(e), /Matched stream: 0 ft from your spot, draining about 2\.4 sq mi above it\./);
  assert.ok(calls.some(u => u.includes("/FeatureServer/0/query")), "MRDS was queried with the basin polygon");
  assert.match(formatEvidence(e), /STRONG upstream evidence: 1 past-producing gold mine\(s\) drain to this creek \(Shannon Mine\)/);
  assert.match(formatEvidence(e), /flattens here/);
  assert.match(formatEvidence(e), /not proof of gold/);
});

test("upstreamEvidence reports 'unknown', never 'none', when the stream network is down", async () => {
  globalThis.fetch = async url => (String(url).includes("getSamples") ? json({ samples: [{ locationId: 0, value: "1800" }] }) : json({ error: { message: "down" } }));
  const e = await upstreamEvidence(origin.lon, origin.lat);
  assert.equal(e.level, "unknown");
  assert.ok(e.failed.includes("USGS stream network (NLDI)"));
  assert.equal(e.elevationFt, 5906);
  assert.match(formatEvidence(e), /COULDN'T CHECK the upstream drainage/);
  assert.doesNotMatch(formatEvidence(e), /NO upstream source/);
});

test("formatEvidence warns when the spot is far from the matched stream", () => {
  const report = formatEvidence({ level: "none", producers: [], prospects: [], otherSites: 0, gradient: { upstreamPct: 6, downstreamPct: 2, flattens: true, offStreamFt: 900 }, elevationFt: 4000, reachDistanceFt: 900, drainageSqMi: 2.2, failed: [] });
  assert.match(report, /Matched stream: 900 ft from your spot, draining about 2\.2 sq mi above it\. ⚠️ Your spot isn't on this stream/);
  assert.doesNotMatch(report, /flattens here/);
});
