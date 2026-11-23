/**
 * Quick-jump spots in the map's top bar.
 *
 * Each is a point on a USGS-mapped creek where the app's own land check said
 * "likely open for casual panning" on the date below: public land (BLM or
 * National Forest), no active claim within 25 m, no withdrawal or wilderness
 * closure. Claims change, so tapping a spot re-runs the live land check there.
 * Re-verify all of them with `npm run check:hotspots`.
 *
 * Labels name a mineral only for historic placer-gold gulches; none promises
 * what's in the gravel.
 *
 * Checked 2026-11-22. Dropped that day:
 * - Marysville: every one of 220 creek points within about 6 miles had active claims.
 * - Philipsburg: the 90 creek points nearest the old button were all private land.
 * Moved that day (the old points were private land, city land or outside the gulch):
 * Hauser Lake, Confederate Gulch, Virginia City/Alder Gulch, Elliston.
 */
export type Hotspot = { label: string; lon: number; lat: number; zoom: number; note: string };

export const HOTSPOTS_CHECKED = "2026-11-22";

export const HOTSPOTS: Hotspot[] = [
  { label: "🪙 Confederate Gulch (Boulder Creek)", lon: -111.41, lat: 46.58821, zoom: 15, note: "National Forest, 0.9 mi from the Diamond City site" },
  { label: "🪙 Alder Gulch", lon: -111.94621, lat: 45.26744, zoom: 15, note: "BLM land, about 2 mi above Virginia City" },
  { label: "📍 Elliston Creek", lon: -112.44864, lat: 46.52454, zoom: 15, note: "National Forest, near Elliston" },
  { label: "📍 Spokane Creek", lon: -111.80495, lat: 46.65598, zoom: 15, note: "BLM land, near Hauser Lake" },
];
