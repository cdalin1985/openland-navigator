/**
 * Pure logic for the nightly Montana claim watch (scripts/mt-claim-watch.mjs):
 * turn BLM features into a snapshot, compare two nights' snapshots, and keep the
 * rolling change list the app reads as "Recently closed in Montana".
 * No network or file access here, so all of it is unit-tested.
 *
 * Snapshot shape: { version, takenAt, notClosed: { [id]: Entry }, closed: { [id]: Entry } }
 * Entry: [name, type, BLM disposition, acres or null, lon, lat]
 */
import { claimTypeOf, markerPoint } from "../app/lib/claim-markers.ts";
import { pointInRings } from "../app/lib/offline.ts";

/** Changes older than this many days drop off the list. */
export const WINDOW_DAYS = 120;
/** A night whose open-claim count falls by more than this share is treated as a bad BLM read, not real closures. */
export const MAX_SHRINK = 0.25;

/** Same id rule as the map icons (app/lib/claim-markers.ts toMarkers), so the map can highlight listed claims. */
export function claimId(a) {
  const text = k => (a?.[k] == null ? "" : String(a[k]).trim());
  return text("CSE_NR") || text("LEG_CSE_NR") || `record-${text("OBJECTID")}`;
}

/**
 * Snapshot entries for features whose marker point passes `keep` (e.g. "inside Montana"),
 * plus each kept claim's shape and bounding box for the "active claim on it" check.
 */
export function toEntries(features, keep = () => true) {
  const entries = {};
  const shapes = [];
  for (const f of features) {
    const rings = f.geometry?.rings;
    const point = markerPoint(rings);
    if (!point || !keep(point)) continue;
    const a = f.attributes ?? {};
    const acres = Number(a.RCRD_ACRS);
    const id = claimId(a);
    entries[id] = [
      String(a.CSE_NAME ?? "").trim() || "Unnamed claim",
      claimTypeOf(a.BLM_PROD),
      String(a.CSE_DISP ?? "").trim(),
      Number.isFinite(acres) && acres > 0 ? acres : null,
      point[0],
      point[1],
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of rings) for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    shapes.push({ id, box: [minX, minY, maxX, maxY], rings });
  }
  return { entries, shapes };
}

/** True when any shape contains the point (bounding boxes first, so 40,000 shapes stay fast). */
export function coveredBy(shapes, lon, lat) {
  return shapes.some(s => lon >= s.box[0] && lon <= s.box[2] && lat >= s.box[1] && lat <= s.box[3] && pointInRings(lon, lat, s.rings));
}

/** A reason to distrust tonight's read (open claims fell sharply), or "" when it looks normal. */
export function checkShrink(prev, next) {
  const before = Object.keys(prev.notClosed ?? {}).length;
  const after = Object.keys(next.notClosed ?? {}).length;
  if (before >= 1000 && after < before * (1 - MAX_SHRINK)) return `Open claims fell from ${before} to ${after}`;
  return "";
}

/**
 * What changed between two snapshots, all dated `date` (YYYY-MM-DD):
 * - closed:   open last night, in BLM's closed map now. `covered` = an active claim is mapped on its centre.
 * - removed:  open last night, now in neither map (BLM dropped it; check MLRS).
 * - new:      open now, in neither map last night (newly filed or newly mapped).
 * - reopened: closed last night, open now (BLM reversed a closure).
 */
export function diffSnapshots(prev, next, date, activeShapes = []) {
  const events = [];
  const ev = (kind, id, e, extra = {}) => ({ date, kind, id, name: e[0], type: e[1], acres: e[3], lon: e[4], lat: e[5], ...extra });
  for (const id of Object.keys(prev.notClosed)) {
    if (id in next.notClosed) continue;
    if (id in next.closed) {
      const e = next.closed[id];
      events.push(ev("closed", id, e, { covered: coveredBy(activeShapes, e[4], e[5]) }));
    } else {
      events.push(ev("removed", id, prev.notClosed[id]));
    }
  }
  for (const id of Object.keys(next.notClosed)) {
    if (id in prev.notClosed) continue;
    events.push(ev(id in prev.closed ? "reopened" : "new", id, next.notClosed[id]));
  }
  return events;
}

/**
 * Add tonight's events to the running list: a reopening marks that claim's earlier
 * closure as reversed; anything older than WINDOW_DAYS drops off; newest first.
 */
export function mergeEvents(prevEvents, newEvents, date) {
  const reopened = new Set(newEvents.filter(e => e.kind === "reopened").map(e => e.id));
  const kept = prevEvents.map(e => (e.kind === "closed" && reopened.has(e.id) ? { ...e, reversed: true } : e));
  const cutoff = Date.parse(`${date}T00:00:00Z`) - WINDOW_DAYS * 86_400_000;
  return [...newEvents, ...kept]
    .filter(e => Date.parse(`${e.date}T00:00:00Z`) >= cutoff)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
