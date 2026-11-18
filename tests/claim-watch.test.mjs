/**
 * Tests for the nightly Montana claim watch: snapshot comparison
 * (scripts/claim-watch-core.mjs) and the app's reader (app/lib/claim-changes.ts).
 * Run with `npm run test:unit`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { WINDOW_DAYS, checkShrink, claimId, coveredBy, diffSnapshots, mergeEvents, toEntries } from "../scripts/claim-watch-core.mjs";
import { daysSinceUpdate, parseClaimChanges, recentClosureIds, summarize } from "../app/lib/claim-changes.ts";

const square = (x, y, size) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]];
const feature = (attrs, x, y, size = 0.004) => ({ attributes: attrs, geometry: { rings: [square(x, y, size)] } });
const entry = (name, lon, lat) => [name, "placer", "Active", 20, lon, lat];

test("claim ids match the map icons' ids", () => {
  assert.equal(claimId({ CSE_NR: " MT1 ", LEG_CSE_NR: "MMC9" }), "MT1");
  assert.equal(claimId({ LEG_CSE_NR: "MMC9" }), "MMC9");
  assert.equal(claimId({ OBJECTID: 5 }), "record-5");
});

test("snapshot entries keep only claims whose marker point passes the Montana test", () => {
  const { entries, shapes } = toEntries([
    feature({ CSE_NR: "MT1", CSE_NAME: "In", BLM_PROD: "PLACER CLAIM", CSE_DISP: "Active", RCRD_ACRS: 20 }, -112, 46),
    feature({ CSE_NR: "ID1", CSE_NAME: "Out", BLM_PROD: "Lode Claim" }, -117, 46),
  ], ([lon]) => lon > -116);
  assert.deepEqual(Object.keys(entries), ["MT1"]);
  assert.deepEqual(entries.MT1.slice(0, 4), ["In", "placer", "Active", 20]);
  assert.equal(shapes.length, 1);
  assert.ok(coveredBy(shapes, -111.998, 46.002));
  assert.ok(!coveredBy(shapes, -111.9, 46.002));
});

test("closures, new filings, drops and reopenings are told apart", () => {
  const prev = {
    notClosed: { A: entry("Stays", -112, 46), B: entry("Lapses", -112.1, 46.1), C: entry("Vanishes", -112.2, 46.2) },
    closed: { D: entry("Old closed", -112.3, 46.3) },
  };
  const next = {
    notClosed: { A: prev.notClosed.A, D: entry("Old closed", -112.3, 46.3), E: entry("Brand new", -112.4, 46.4) },
    closed: { B: entry("Lapses", -112.1, 46.1) },
  };
  // An active claim (A's ground) is mapped over B's centre.
  const active = toEntries([feature({ CSE_NR: "A" }, -112.11, 46.09, 0.02)]).shapes;
  const events = diffSnapshots(prev, next, "2026-11-18", active);
  const byKind = Object.fromEntries(events.map(e => [e.kind, e]));
  assert.deepEqual(events.map(e => [e.kind, e.id]).sort(), [["closed", "B"], ["new", "E"], ["removed", "C"], ["reopened", "D"]]);
  assert.equal(byKind.closed.covered, true);
  assert.equal(byKind.closed.date, "2026-11-18");
  assert.equal(byKind.closed.name, "Lapses");
  assert.equal(byKind.new.covered, undefined);
});

test("a sharp overnight drop in open claims is flagged as a bad read", () => {
  const many = n => ({ notClosed: Object.fromEntries(Array.from({ length: n }, (_, i) => [`MT${i}`, entry("x", 0, 0)])), closed: {} });
  assert.equal(checkShrink(many(2000), many(1900)), "");
  assert.match(checkShrink(many(2000), many(1000)), /fell from 2000 to 1000/);
  assert.equal(checkShrink(many(10), many(1)), "", "tiny baselines aren't judged");
});

test("the running list marks reversed closures, drops old events and puts newest first", () => {
  const old = { date: "2026-01-01", kind: "closed", id: "Z" };
  const closedB = { date: "2026-11-10", kind: "closed", id: "B" };
  const merged = mergeEvents([closedB, old], [{ date: "2026-11-18", kind: "reopened", id: "B" }], "2026-11-18");
  assert.deepEqual(merged.map(e => [e.date, e.kind, e.id]), [["2026-11-18", "reopened", "B"], ["2026-11-10", "closed", "B"]]);
  assert.equal(merged[1].reversed, true);
  assert.ok(WINDOW_DAYS >= 90);
});

const file = {
  version: 1, generatedAt: "2026-11-18T09:30:00Z", trackingSince: "2026-11-01", windowDays: 120,
  counts: { notClosed: 18447, closed: 693 },
  events: [
    { date: "2026-11-17", kind: "closed", id: "MT1", name: "Lucky", type: "placer", acres: 20, lon: -112, lat: 46, covered: false },
    { date: "2026-11-16", kind: "closed", id: "MT2", name: "Back", type: "lode", acres: null, lon: -112, lat: 46, covered: false, reversed: true },
    { date: "2026-09-01", kind: "closed", id: "MT3", name: "Old", type: "lode", acres: 20, lon: -112, lat: 46 },
    { date: "2026-11-15", kind: "new", id: "MT4", name: "Fresh", type: "lode", acres: 20, lon: -112, lat: 46 },
    { date: "2026-11-15", kind: "bogus", id: "MT5", name: "Bad", type: "lode", acres: 20, lon: -112, lat: 46 },
  ],
};
const now = new Date("2026-11-18T15:00:00Z");

test("the app reads the change file and rejects a malformed one", () => {
  const c = parseClaimChanges(file);
  assert.equal(c.events.length, 4, "an event with an unknown kind is dropped");
  assert.throws(() => parseClaimChanges({ events: [] }), /expected format/);
  assert.throws(() => parseClaimChanges(null), /expected format/);
});

test("recent closures exclude reversed and older ones; staleness and summary are counted", () => {
  const c = parseClaimChanges(file);
  assert.deepEqual([...recentClosureIds(c, now)], ["MT1"]);
  assert.equal(daysSinceUpdate(c, now), 0);
  assert.equal(daysSinceUpdate(c, new Date("2026-11-21T10:00:00Z")), 3);
  const s = summarize(c, now);
  assert.deepEqual(s.closures.map(e => e.id), ["MT1", "MT2", "MT3"]);
  assert.equal(s.newLast30, 1);
  assert.equal(s.removedLast30, 0);
});
