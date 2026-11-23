// Quick-jump spots: shape checks (the live land check is scripts/check-hotspots.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { MONTANA_BBOX } from "../app/lib/claim-markers.ts";
import { HOTSPOTS, HOTSPOTS_CHECKED } from "../app/lib/hotspots.ts";

test("every quick-jump spot is in Montana, labelled once, with a note and a check date", () => {
  assert.match(HOTSPOTS_CHECKED, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(HOTSPOTS.length >= 1);
  assert.equal(new Set(HOTSPOTS.map(h => h.label)).size, HOTSPOTS.length);
  for (const h of HOTSPOTS) {
    assert.ok(h.lon > MONTANA_BBOX[0] && h.lon < MONTANA_BBOX[2] && h.lat > MONTANA_BBOX[1] && h.lat < MONTANA_BBOX[3], h.label);
    assert.ok(h.note.length > 0 && h.zoom >= 13, h.label);
  }
});

test("labels don't promise minerals the check can't verify", () => {
  for (const h of HOTSPOTS) assert.doesNotMatch(h.label, /sapphire|quartz|💎/i, h.label);
});
