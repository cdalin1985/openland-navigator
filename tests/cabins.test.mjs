// Montana Forest Service cabin data + search.
// Run with: node --test tests/cabins.test.mjs   (Node strips TypeScript types on import, no build step)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkAgainstPrevious } from "../scripts/build-mt-cabins.mjs";
import { cabinSubtitle, RESERVATION_PHONE, searchCabins } from "../app/lib/cabins.ts";

const data = JSON.parse(readFileSync(new URL("../app/data/mt-cabins.json", import.meta.url), "utf8"));
const { cabins } = data;

test("data file is internally consistent", () => {
  assert.equal(data.count, cabins.length);
  assert.ok(cabins.length >= 100, `expected 100+ Montana cabins, got ${cabins.length}`);
  assert.equal(new Set(cabins.map(c => c.id)).size, cabins.length, "ids are unique");
  for (const c of cabins) {
    assert.ok(c.name && c.name === c.name.trim(), `name present: ${JSON.stringify(c.name)}`);
    assert.ok(["Cabin", "Lookout", "Guard station"].includes(c.kind), `${c.name}: kind ${c.kind}`);
    assert.ok(["usfs", "recreation.gov"].includes(c.src), `${c.name}: src ${c.src}`);
    // Montana's bounding box (the build also tests the real state outline).
    assert.ok(c.lat > 44.3 && c.lat < 49.1 && c.lon > -116.1 && c.lon < -103.9, `${c.name}: coordinates ${c.lat},${c.lon}`);
    assert.ok(c.bookUrl === null || /^https:\/\/www\.recreation\.gov\/camping\/campgrounds\/\d+$/.test(c.bookUrl), `${c.name}: bookUrl ${c.bookUrl}`);
    if (!c.bookUrl) assert.equal(typeof c.note, "string");
  }
  assert.ok(cabins.filter(c => c.bookUrl).length / cabins.length > 0.95, "nearly every cabin has a verified booking link");
});

test("campgrounds and information-only listings are not presented as rentable cabins", () => {
  assert.equal(cabins.filter(c => /campground/i.test(c.name)).length, 0);
  // Mt. Wam Lookout's recreation.gov page says it offers no reservations there.
  assert.equal(cabins.filter(c => c.bookUrl?.endsWith("/234385")).length, 0);
});

// Independent cross-check: these ids come from recreation.gov's own Montana camping listing
// page (fetched separately from the build pipeline), not from the Forest Service layer.
const LISTED_ON_RECREATION_GOV = [
  ["Anna Creek", 253198], ["Antone", 234318], ["Basin Station", 234365], ["Battle Ridge", 234336],
  ["Beaver Creek", 234367], ["Ben Rover", 234342], ["Big Creek", 234299], ["Bear Creek Cabin", 234320],
  ["Birch Creek", 234406], ["Black Butte", 234364], ["Bloody Dick", 234392], ["Cabin Creek", 234368],
  ["Calf Creek", 234409], ["Canyon Creek", 234353], ["Challenge", 234340], ["Crandall Creek", 234659],
  ["Crystal Lake", 234422], ["Cummings", 234453],
];
test("booking links agree with recreation.gov's own Montana listing", () => {
  for (const [fragment, id] of LISTED_ON_RECREATION_GOV) {
    const hit = cabins.find(c => c.bookUrl === `https://www.recreation.gov/camping/campgrounds/${id}`);
    assert.ok(hit, `${fragment}: no cabin links to facility ${id}`);
    assert.ok(hit.name.toLowerCase().includes(fragment.toLowerCase()), `${fragment}: facility ${id} is "${hit.name}"`);
  }
});

test("a cabin with no verified booking link says so instead of inventing one", () => {
  const unlinked = cabins.filter(c => !c.bookUrl);
  assert.ok(unlinked.length <= 3, `expected at most a few unlinked cabins, got ${unlinked.map(c => c.name)}`);
});

const sample = [
  { id: 1, src: "usfs", name: "Hogback Homestead", kind: "Cabin", forest: "Lolo NF", status: "open", lat: 46.4, lon: -113.7, bookUrl: null, note: "" },
  { id: 2, src: "usfs", name: "Wood's Cabin", kind: "Cabin", forest: "Bitterroot NF", status: "open", lat: 46.0, lon: -114.0, bookUrl: null, note: "" },
  { id: 3, src: "usfs", name: "Garnet Mountain Lookout", kind: "Lookout", forest: "Custer Gallatin NF", status: "open", lat: 45.3, lon: -111.2, bookUrl: null, note: "" },
  { id: 4, src: "usfs", name: "Rillway Cabin", kind: "Cabin", forest: "Helena-Lewis and Clark NF", status: "open", lat: 47.0, lon: -112.0, bookUrl: null, note: "" },
  { id: 5, src: "usfs", name: "Garnet Pass Cabin", kind: "Cabin", forest: "Lolo NF", status: "open", lat: 46.8, lon: -113.4, bookUrl: null, note: "" },
];

test("search matches partial names, ignoring case and apostrophes", () => {
  assert.deepEqual(searchCabins(sample, "hogb").map(c => c.id), [1]);
  assert.deepEqual(searchCabins(sample, "WOODS").map(c => c.id), [2]);
  assert.deepEqual(searchCabins(sample, "wood's cabin").map(c => c.id), [2]);
});

test("search ranks the name that starts with the query first", () => {
  assert.deepEqual(searchCabins(sample, "garnet").map(c => c.id), [3, 5]); // tie on score, then alphabetical by name
  assert.equal(searchCabins(sample, "garnet mountain")[0].id, 3);
});

test("a kind word finds that kind", () => {
  assert.deepEqual(searchCabins(sample, "lookout").map(c => c.id), [3]);
});

test("a town search does not return every cabin in the forest named after it", () => {
  assert.deepEqual(searchCabins(sample, "helena"), []);
  assert.deepEqual(searchCabins(sample, "lolo"), []);
  // ...but a name word plus a forest word still narrows correctly.
  assert.deepEqual(searchCabins(sample, "rillway helena").map(c => c.id), [4]);
});

test("search ignores coordinates, very short input and nonsense", () => {
  assert.deepEqual(searchCabins(sample, "46.4, -113.7"), []);
  assert.deepEqual(searchCabins(sample, "h"), []);
  assert.deepEqual(searchCabins(sample, "zzzzzz"), []);
});

test("search respects the result limit", () => {
  assert.equal(searchCabins(cabins, "cabin", 4).length, 4);
});

test("real data: well-known cabins can be found by name", () => {
  assert.equal(searchCabins(cabins, "anna creek")[0]?.bookUrl, "https://www.recreation.gov/camping/campgrounds/253198");
  assert.ok(searchCabins(cabins, "hogback").some(c => c.name === "Hogback Homestead"));
});

test("subtitle and phone helpers", () => {
  assert.equal(cabinSubtitle(sample[2]), "Lookout · Custer Gallatin NF");
  assert.equal(RESERVATION_PHONE, "1-877-444-6777");
});

test("checkAgainstPrevious guards against shrinking data", () => {
  const make = (n, linked) => Array.from({ length: n }, (_, i) => ({ id: i, bookUrl: i < linked ? `https://x/${i}` : null }));
  assert.deepEqual(checkAgainstPrevious(make(110, 100), make(110, 100)), []);
  assert.equal(checkAgainstPrevious(make(110, 100), make(55, 50)).length > 0, true, "half the cabins");
  assert.equal(checkAgainstPrevious(make(110, 100), make(110, 10)).length > 0, true, "links 100 -> 10");
  assert.deepEqual(checkAgainstPrevious(make(19, 19), make(1, 0)), []);
});
