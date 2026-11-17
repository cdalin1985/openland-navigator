/**
 * Mining-claim map icons: one marker per BLM claim in the current view, placed at
 * the centre of the shape BLM draws for it, so claims stand out the way the rental
 * cabins do. The shapes come from the same BLM MLRS layers that paint the pink
 * (active) and cyan (closed) claim areas.
 *
 * BLM usually maps a claim to the survey square it falls in (a quarter-quarter or
 * quarter section), not to its staked corners, so several claims often share one
 * shape and therefore one marker position. The map clusters those into a count.
 *
 * Closed claims are also compared with the active claims in the same view. A closed
 * claim whose centre lies inside an active claim's shape has an active claim mapped
 * on the same spot now. That comparison only reads BLM's map; tapping a marker runs
 * the full land check, which is what decides whether ground is open to stake.
 */
import { CLAIMS_CLOSED_URL, CLAIMS_URL, arcgisFeatures, type ArcgisFeature } from "./land-status.ts";
import { pointInRings, type BBox } from "./offline.ts";

export type ClaimType = "lode" | "placer" | "millsite" | "tunnel" | "other";
export type ClaimStatus = "active" | "closed";
export type ClaimMarker = {
  /** BLM case number, or the record id when BLM left it blank. */
  id: string;
  status: ClaimStatus;
  type: ClaimType;
  name: string;
  /** BLM's wording, e.g. "Active", "Filed", "Under Review", "Closed". */
  disposition: string;
  acres: number | null;
  lon: number;
  lat: number;
  /** Closed claims only: true = an active claim is mapped on its centre, false = none is, null = not checked. */
  covered: boolean | null;
};
export type ClaimMarkerResult = {
  active: ClaimMarker[];
  closed: ClaimMarker[];
  /** True when a layer held more claims than one view loads, so some icons are missing (zoom in). */
  truncated: boolean;
  /** Layers whose lookup failed. A failure is reported, never shown as "no claims here". */
  failed: ClaimStatus[];
  /** False when closed claims couldn't be compared with active ones (they're all `covered: null`). */
  coverChecked: boolean;
};

/** Claim icons load from this zoom level in (about 30 miles across on a phone). */
export const MARKER_MIN_ZOOM = 11;
/** BLM's maxRecordCount on both claim layers. */
const PAGE_SIZE = 2000;
/** Pages per layer per view: up to 4,000 claims. Busier views say "zoom in". */
const MAX_PAGES = 2;
const OUT_FIELDS = "OBJECTID,CSE_NAME,CSE_NR,LEG_CSE_NR,BLM_PROD,CSE_DISP,RCRD_ACRS";

/** Lode, placer, mill site or tunnel site, from BLM's product name (its capitalisation varies). */
export function claimTypeOf(product: unknown): ClaimType {
  const p = String(product ?? "").toLowerCase();
  if (p.includes("placer")) return "placer";
  if (p.includes("lode")) return "lode";
  if (p.includes("mill")) return "millsite";
  if (p.includes("tunnel")) return "tunnel";
  return "other";
}

/** Signed area (degrees²) and area-weighted centre of one ring of [lon, lat]. */
function ringStats(ring: number[][]): { area: number; center: [number, number] } {
  // Measure from the first vertex so small claims don't lose precision against large longitudes.
  const [ox, oy] = ring[0];
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] - ox, yi = ring[i][1] - oy, xj = ring[j][0] - ox, yj = ring[j][1] - oy;
    const cross = xj * yi - xi * yj;
    twiceArea += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (Math.abs(twiceArea) < 1e-14) {
    // Degenerate (a line or a point): use the average vertex.
    const n = ring.length;
    return { area: 0, center: [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n] };
  }
  return { area: twiceArea / 2, center: [ox + cx / (3 * twiceArea), oy + cy / (3 * twiceArea)] };
}

/** Where to put a claim's marker: the centre of its largest part. Null when it has no shape. */
export function markerPoint(rings: number[][][] | undefined): [number, number] | null {
  const usable = (rings ?? []).filter(r => Array.isArray(r) && r.length >= 3);
  if (!usable.length) return null;
  let best = ringStats(usable[0]);
  for (const ring of usable.slice(1)) {
    const s = ringStats(ring);
    if (Math.abs(s.area) > Math.abs(best.area)) best = s;
  }
  return [Math.round(best.center[0] * 1e6) / 1e6, Math.round(best.center[1] * 1e6) / 1e6];
}

/** Turn BLM features into markers, dropping any without a shape. */
export function toMarkers(features: ArcgisFeature[], status: ClaimStatus): ClaimMarker[] {
  const out: ClaimMarker[] = [];
  for (const f of features) {
    const point = markerPoint(f.geometry?.rings);
    if (!point) continue;
    const a = f.attributes ?? {};
    const text = (k: string) => (a[k] == null ? "" : String(a[k]).trim());
    const acres = Number(a.RCRD_ACRS);
    out.push({
      id: text("CSE_NR") || text("LEG_CSE_NR") || `record-${text("OBJECTID")}`,
      status,
      type: claimTypeOf(a.BLM_PROD),
      name: text("CSE_NAME") || "Unnamed claim",
      disposition: text("CSE_DISP") || (status === "closed" ? "Closed" : "Not closed"),
      acres: Number.isFinite(acres) && acres > 0 ? acres : null,
      lon: point[0],
      lat: point[1],
      covered: null,
    });
  }
  return out;
}

/** Mark each closed claim as covered (an active claim mapped on its centre) or not. */
export function markCovered(closed: ClaimMarker[], activeShapes: number[][][][]): ClaimMarker[] {
  return closed.map(c => ({ ...c, covered: activeShapes.some(rings => pointInRings(c.lon, c.lat, rings)) }));
}

/** Map units per pixel at a zoom level, in degrees: used to simplify shapes to about one pixel. */
export function degreesPerPixel(zoom: number): number {
  return 156543.03392 / 2 ** zoom / 111319.49;
}

/** Fetch one claim layer for a box, paging up to MAX_PAGES. */
async function fetchLayer(url: string, bbox: BBox, zoom: number, signal?: AbortSignal): Promise<{ features: ArcgisFeature[]; truncated: boolean }> {
  const features: ArcgisFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const qp = new URLSearchParams({
      f: "json",
      where: "1=1",
      geometry: bbox.map(v => v.toFixed(5)).join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: OUT_FIELDS,
      returnGeometry: "true",
      outSR: "4326",
      maxAllowableOffset: degreesPerPixel(zoom).toFixed(6),
      geometryPrecision: "6",
      orderByFields: "OBJECTID",
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
    });
    const batch = await arcgisFeatures(`${url}/0/query?${qp}`, signal);
    features.push(...batch);
    if (batch.length < PAGE_SIZE) return { features, truncated: false };
  }
  return { features, truncated: true };
}

/**
 * Load claim markers for a map box. Active claims are always fetched when either
 * kind is wanted, because the closed-claim "covered" check needs them; if that
 * lookup fails or is cut short, closed claims are left unchecked (covered: null).
 */
export async function loadClaimMarkers(
  bbox: BBox,
  zoom: number,
  want: { active: boolean; closed: boolean },
  signal?: AbortSignal,
): Promise<ClaimMarkerResult> {
  const result: ClaimMarkerResult = { active: [], closed: [], truncated: false, failed: [], coverChecked: false };
  if (!want.active && !want.closed) return result;
  const [active, closed] = await Promise.allSettled([
    fetchLayer(CLAIMS_URL, bbox, zoom, signal),
    want.closed ? fetchLayer(CLAIMS_CLOSED_URL, bbox, zoom, signal) : Promise.resolve({ features: [], truncated: false }),
  ]);
  if (active.status === "fulfilled") {
    if (want.active) {
      result.active = toMarkers(active.value.features, "active");
      result.truncated ||= active.value.truncated;
    }
  } else if (want.active) {
    result.failed.push("active");
  }
  if (closed.status === "fulfilled") {
    result.closed = toMarkers(closed.value.features, "closed");
    result.truncated ||= closed.value.truncated;
    const activeComplete = active.status === "fulfilled" && !active.value.truncated;
    if (activeComplete) {
      const shapes = active.value.features.map(f => f.geometry?.rings).filter((r): r is number[][][] => Array.isArray(r) && r.length > 0);
      result.closed = markCovered(result.closed, shapes);
      result.coverChecked = true;
    }
  } else if (want.closed) {
    result.failed.push("closed");
  }
  return result;
}

/** One line describing what the claim icons in view show, or why some are missing. */
export function markerNote(r: Omit<ClaimMarkerResult, "active">): string {
  const notes: string[] = [];
  if (r.failed.length === 2) notes.push("Couldn't load claim icons from BLM. The pink and cyan claim areas still show; tap a spot to check it.");
  else if (r.failed.includes("active")) notes.push("Couldn't load active claim icons from BLM. Tap a spot to check it.");
  else if (r.failed.includes("closed")) notes.push("Couldn't load closed claim icons from BLM. Tap a spot to check it.");
  if (r.closed.length && !r.coverChecked) notes.push("Closed claims couldn't be compared with active ones, so they're grey.");
  if (r.truncated) notes.push("Too many claims here to show every icon. Zoom in to see them all.");
  return notes.join(" ");
}
