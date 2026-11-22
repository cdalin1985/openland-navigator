#!/usr/bin/env node
/**
 * Re-check the map's quick-jump spots (app/lib/hotspots.ts) with the app's own land
 * check. Exits 1 if any spot is no longer "likely open for casual panning" (a new
 * claim, a closure, a land change) or if a lookup fails, so it's safe to run on a schedule.
 *
 * Usage:   npm run check:hotspots
 * Behind an HTTPS proxy:  NODE_USE_ENV_PROXY=1 npm run check:hotspots
 */
import { checkLandAt, landVerdict } from "../app/lib/land-status.ts";
import { HOTSPOTS, HOTSPOTS_CHECKED } from "../app/lib/hotspots.ts";

let problems = 0;
console.log(`Spots last verified ${HOTSPOTS_CHECKED}; checking now:`);
for (const spot of HOTSPOTS) {
  let line;
  try {
    const { check } = await checkLandAt(spot.lon, spot.lat);
    const verdict = landVerdict(check);
    const ok = verdict.panning === "likely" && check.failed.length === 0;
    if (!ok) problems++;
    line = `${ok ? "OK  " : "FAIL"} ${spot.label} (${spot.lat}, ${spot.lon}): ${verdict.badge}${check.failed.length ? ` [couldn't check: ${check.failed.join(", ")}]` : ""}`;
  } catch (err) {
    problems++;
    line = `FAIL ${spot.label}: lookup error ${err.message}`;
  }
  console.log(line);
}
if (problems) {
  console.error(`${problems} spot(s) need attention: move or remove them in app/lib/hotspots.ts.`);
  process.exit(1);
}
