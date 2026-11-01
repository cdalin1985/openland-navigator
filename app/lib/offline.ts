/**
 * Offline areas: save an area's land records and USGS map tiles on the phone
 * before a trip, then answer land checks from that copy when there's no signal.
 *
 * Storage: a small index in localStorage; area data (JSON) and USGS tiles in
 * Cache Storage. Google tiles are never cached (Google's terms forbid it).
 * Offline answers go through the same landVerdict as online ones, marked with
 * the date the data was saved, because claims and closures change.
 */
import {
  CADASTRAL_URL,
  CLAIMS_CLOSED_URL,
  CLAIMS_URL,
  NHD_FLOWLINE_URL,
  WILDERNESS_URL,
  WITHDRAWALS_URL,
  checkLandAt,
  classifyLand,
  closuresFrom,
  feetPerDegree,
  type ArcgisFeature,
  type Attributes,
  type LandLookup,
} from "./land-status.ts";

export const TILE_CACHE = "openland-tiles-v1";
export const SHELL_CACHE = "openland-shell-v1";
export const DATA_CACHE = "openland-offline-data-v1";
const INDEX_KEY = "openland-offline-areas";
const DATA_PREFIX = "/__openland_offline__/";

/** Public-domain USGS tile layers the app draws (imagery, topo, water labels). */
export const USGS_TILE_TEMPLATES = [
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}",
];
export const MIN_TILE_ZOOM = 10;
/** USGS caches stop at zoom 16 (checked live); the map upscales beyond that. */
export const MAX_TILE_ZOOM = 16;
export const MAX_AREA_SQ_MI = 25;
/** Rough average size of a USGS tile, for the download estimate. */
const AVG_TILE_BYTES = 15_000;
/** Same 25 m buffer the online claim check uses. */
const CLAIM_BUFFER_FT = 82;

export type BBox = [number, number, number, number];
/** Attributes plus rings (polygons) or paths (lines), coordinates rounded to 6 decimals. */
export type StoredFeature = { a: Attributes; g: number[][][] };
export type OfflineLayers = {
  active: StoredFeature[];
  closed: StoredFeature[];
  parcels: StoredFeature[];
  publicLands: StoredFeature[];
  withdrawals: StoredFeature[];
  wilderness: StoredFeature[];
  flowlines: StoredFeature[];
};
export type OfflineArea = { id: string; name: string; bbox: BBox; savedAt: string; tileUrls: string[]; layers: OfflineLayers };
export type OfflineAreaSummary = { id: string; name: string; bbox: BBox; savedAt: string; tileCount: number; featureCount: number; bytes: number };

// ---------- geometry ----------

/** Even-odd point-in-polygon across all rings, so holes and multipart polygons work. */
export function pointInRings(lon: number, lat: number, rings: number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance in feet from a point to any edge of the rings (or paths). */
export function distanceToRingsFt(lon: number, lat: number, rings: number[][][]): number {
  const k = feetPerDegree(lat);
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * k.lon, ay = (ring[i - 1][1] - lat) * k.lat;
      const bx = (ring[i][0] - lon) * k.lon, by = (ring[i][1] - lat) * k.lat;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

export function inBBox(lon: number, lat: number, [minLon, minLat, maxLon, maxLat]: BBox): boolean {
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/** Area of a lon/lat box in square miles. */
export function areaSqMi([minLon, minLat, maxLon, maxLat]: BBox): number {
  const k = feetPerDegree((minLat + maxLat) / 2);
  return (((maxLon - minLon) * k.lon) / 5280) * (((maxLat - minLat) * k.lat) / 5280);
}

/** Web-Mercator XYZ tile index range covering a box at zoom z. */
export function tileRange([minLon, minLat, maxLon, maxLat]: BBox, z: number) {
  const n = 2 ** z;
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const ty = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };
  return { x0: tx(minLon), x1: tx(maxLon), y0: ty(maxLat), y1: ty(minLat) };
}

/** Every tile URL needed to show the box from minZ to maxZ for each template. */
export function tileUrlsFor(bbox: BBox, minZ = MIN_TILE_ZOOM, maxZ = MAX_TILE_ZOOM, templates = USGS_TILE_TEMPLATES): string[] {
  const urls: string[] = [];
  for (let z = minZ; z <= maxZ; z++) {
    const { x0, x1, y0, y1 } = tileRange(bbox, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const t of templates) urls.push(t.replace("{z}", String(z)).replace("{y}", String(y)).replace("{x}", String(x)));
      }
    }
  }
  return urls;
}

/** What saving this box would cost, before downloading anything. */
export function estimateArea(bbox: BBox): { sqMi: number; tiles: number; megabytes: number; tooBig: boolean } {
  const sqMi = areaSqMi(bbox);
  const tiles = tileUrlsFor(bbox).length;
  return { sqMi, tiles, megabytes: (tiles * AVG_TILE_BYTES) / 1e6, tooBig: sqMi > MAX_AREA_SQ_MI };
}

// ---------- offline land check ----------

/**
 * Answer a land check from a saved area, mirroring checkLandAt (claims within
 * 25 m, containing parcel and public-land polygons, active closures). Returns
 * null when the point is outside the saved area.
 */
export function offlineLandCheck(area: OfflineArea, lon: number, lat: number): LandLookup | null {
  if (!inBBox(lon, lat, area.bbox)) return null;
  const inside = (f: StoredFeature) => pointInRings(lon, lat, f.g);
  const near = (f: StoredFeature) => inside(f) || distanceToRingsFt(lon, lat, f.g) <= CLAIM_BUFFER_FT;
  const active = area.layers.active.filter(near).map(f => f.a);
  const closed = area.layers.closed.filter(near).map(f => f.a);
  const parcel = area.layers.parcels.find(inside)?.a ?? null;
  const publicOwner = String(area.layers.publicLands.find(inside)?.a.OWNER ?? "");
  const parcelOwner = parcel ? String(parcel.OwnerName ?? "") : "";
  const restrictions = closuresFrom(
    area.layers.withdrawals.filter(inside).map(f => f.a),
    area.layers.wilderness.filter(inside).map(f => f.a),
  );
  return {
    check: {
      category: classifyLand(publicOwner, parcelOwner),
      ownerName: publicOwner || parcelOwner || "No owner record found",
      activeClaims: active.length,
      closedClaims: closed.length,
      closures: restrictions.closed,
      cautions: restrictions.cautions,
      failed: [],
      checkedAt: new Date().toISOString(),
      offlineSavedAt: area.savedAt,
    },
    parcel,
    publicOwner,
    active,
    closed,
  };
}

const SAFETY_LOOKUPS = new Set(["BLM active claims", "county parcels", "public land ownership"]);

/**
 * Land check that falls back to saved offline data. Online first (unless the
 * phone says it's offline); if a safety lookup fails and a saved area covers
 * the point, answer from that area. Otherwise the online result stands, which
 * fails closed ("couldn't verify").
 */
export async function checkLandSmart(
  lon: number,
  lat: number,
  signal?: AbortSignal,
  deps: { findArea?: (lon: number, lat: number) => Promise<OfflineArea | null>; isOffline?: () => boolean } = {},
): Promise<LandLookup> {
  const findArea = deps.findArea ?? findOfflineAreaFor;
  const offlineNow = (deps.isOffline ?? (() => typeof navigator !== "undefined" && navigator.onLine === false))();
  if (offlineNow) {
    const area = await findArea(lon, lat);
    const local = area ? offlineLandCheck(area, lon, lat) : null;
    if (local) return local;
  }
  const online = await checkLandAt(lon, lat, signal);
  const unsafe = online.check.activeClaims === null || online.check.failed.some(name => SAFETY_LOOKUPS.has(name));
  if (!unsafe || offlineNow) return online;
  const area = await findArea(lon, lat);
  return (area && offlineLandCheck(area, lon, lat)) || online;
}

/** Saved stream lines near a point, shaped like NHD query results, for offline bend spots. */
export async function offlineFlowlines(lon: number, lat: number): Promise<ArcgisFeature[] | null> {
  const area = await findOfflineAreaFor(lon, lat);
  if (!area) return null;
  return area.layers.flowlines
    .filter(f => distanceToRingsFt(lon, lat, f.g) < 1700)
    .map(f => ({ attributes: f.a, geometry: { paths: f.g } }));
}

// ---------- storage ----------

const memo = new Map<string, OfflineArea>();

/** Saved areas, newest first. Never throws (storage can be unavailable). */
export function listAreas(): OfflineAreaSummary[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) || "[]") as OfflineAreaSummary[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.savedAt.localeCompare(a.savedAt)) : [];
  } catch {
    return [];
  }
}

function writeIndex(areas: OfflineAreaSummary[]) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(areas));
  } catch {
    // Storage full or blocked: the area data is still in Cache Storage.
  }
}

export async function loadArea(id: string): Promise<OfflineArea | null> {
  const hit = memo.get(id);
  if (hit) return hit;
  try {
    const res = await (await caches.open(DATA_CACHE)).match(`${DATA_PREFIX}${id}.json`);
    if (!res) return null;
    const area = (await res.json()) as OfflineArea;
    memo.set(id, area);
    return area;
  } catch {
    return null;
  }
}

/** The newest saved area that contains the point, if any. */
export async function findOfflineAreaFor(lon: number, lat: number): Promise<OfflineArea | null> {
  for (const summary of listAreas()) {
    if (inBBox(lon, lat, summary.bbox)) {
      const area = await loadArea(summary.id);
      if (area) return area;
    }
  }
  return null;
}

/** All saved areas' data (for drawing saved claims and closures while offline). */
export async function loadAllAreas(): Promise<OfflineArea[]> {
  const areas = await Promise.all(listAreas().map(a => loadArea(a.id)));
  return areas.filter((a): a is OfflineArea => a !== null);
}

/** Delete an area and any tiles no other saved area still uses. */
export async function deleteArea(id: string): Promise<void> {
  const area = await loadArea(id);
  const others = (await loadAllAreas()).filter(a => a.id !== id);
  const keep = new Set(others.flatMap(a => a.tileUrls));
  try {
    if (area) {
      const tiles = await caches.open(TILE_CACHE);
      await Promise.all(area.tileUrls.filter(u => !keep.has(u)).map(u => tiles.delete(u)));
    }
    await (await caches.open(DATA_CACHE)).delete(`${DATA_PREFIX}${id}.json`);
  } finally {
    memo.delete(id);
    writeIndex(listAreas().filter(a => a.id !== id));
  }
}

// ---------- download ----------

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const compact = (f: ArcgisFeature): StoredFeature | null => {
  const g = f.geometry?.rings ?? f.geometry?.paths;
  return g?.length ? { a: f.attributes ?? {}, g: g.map(r => r.map(([x, y]) => [round6(x), round6(y)])) } : null;
};

/** Query every feature intersecting the box, following ArcGIS paging. Throws on any error. */
async function queryBox(layerUrl: string, bbox: BBox, params: Record<string, string>, signal?: AbortSignal): Promise<StoredFeature[]> {
  const out: StoredFeature[] = [];
  let offset = 0;
  for (let page = 0; page < 25; page++) {
    const q = new URLSearchParams({
      f: "json",
      geometry: bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: "1000",
      ...params,
    });
    const res = await fetch(`${layerUrl}/query?${q}`, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { features?: ArcgisFeature[]; exceededTransferLimit?: boolean; error?: { message?: string } };
    if (data.error) throw new Error(data.error.message || "ArcGIS query failed");
    const feats = data.features ?? [];
    for (const f of feats) {
      const c = compact(f);
      if (c) out.push(c);
    }
    if (!data.exceededTransferLimit || !feats.length) break;
    offset += feats.length;
  }
  return out;
}

/** Big polygons (national forests) are generalized to about 1 m, far below the data's own accuracy. */
const GENERALIZE = { maxAllowableOffset: "0.00001" };

/**
 * Download everything needed for offline land checks and USGS maps in the
 * box, store it, and return its summary. Land records must all succeed;
 * individual missing tiles (outside USGS coverage) are skipped.
 */
export async function downloadArea(
  bbox: BBox,
  name: string,
  onProgress: (done: number, total: number, label: string) => void,
  signal?: AbortSignal,
): Promise<OfflineAreaSummary> {
  const est = estimateArea(bbox);
  if (est.tooBig) throw new Error(`This view is ${est.sqMi.toFixed(0)} sq mi; zoom in to ${MAX_AREA_SQ_MI} sq mi or less.`);
  const layerJobs: Array<[keyof OfflineLayers, string, Record<string, string>]> = [
    ["active", `${CLAIMS_URL}/0`, { outFields: "CSE_NAME,CSE_NR,LEG_CSE_NR,BLM_PROD,CSE_DISP,RCRD_ACRS,CSE_META" }],
    ["closed", `${CLAIMS_CLOSED_URL}/0`, { outFields: "CSE_NAME,CSE_NR,LEG_CSE_NR,BLM_PROD,CSE_DISP,RCRD_ACRS,CSE_META" }],
    ["parcels", `${CADASTRAL_URL}/1`, { outFields: "OwnerName,PropType,PropAccess,CountyName,LegalDescriptionShort,GISAcres,PARCELID,AddressLine1,CityStateZip,TotalValue" }],
    ["publicLands", `${CADASTRAL_URL}/2`, { outFields: "OWNER", ...GENERALIZE }],
    ["withdrawals", WITHDRAWALS_URL, { outFields: "BLM_PROD,CSE_DISP,SEG_MIN,CSE_NAME", where: "CSE_DISP IN ('Authorized','Interim','Pending')", ...GENERALIZE }],
    ["wilderness", WILDERNESS_URL, { outFields: "wildernessname", ...GENERALIZE }],
    ["flowlines", NHD_FLOWLINE_URL, { outFields: "gnis_name,ftype" }],
  ];
  const tileUrls = tileUrlsFor(bbox);
  const total = layerJobs.length + tileUrls.length;
  let done = 0;
  const layers = {} as OfflineLayers;
  for (const [key, url, params] of layerJobs) {
    onProgress(done, total, `Saving ${key}…`);
    layers[key] = await queryBox(url, bbox, params, signal);
    done++;
  }

  const tileCache = await caches.open(TILE_CACHE);
  let tileBytes = 0;
  const saved: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tileUrls.length) {
      const url = tileUrls[next++];
      try {
        const res = await fetch(url, { mode: "cors", signal });
        const type = res.headers.get("content-type") || "";
        if (res.ok && type.startsWith("image/")) {
          const blob = await res.blob();
          tileBytes += blob.size;
          await tileCache.put(url, new Response(blob, { headers: { "content-type": type } }));
          saved.push(url);
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      done++;
      if (done % 10 === 0 || done === total) onProgress(done, total, "Saving map tiles…");
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  // Keep the app itself loadable with no signal: the page and its built assets.
  try {
    const shell = await caches.open(SHELL_CACHE);
    const assets = performance.getEntriesByType("resource").map(e => e.name).filter(u => u.startsWith(`${location.origin}/assets/`));
    await shell.addAll([location.origin + "/", ...assets]);
  } catch {
    // The service worker also caches these as they load.
  }

  const savedAt = new Date().toISOString();
  const id = `${savedAt.replace(/\D/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const area: OfflineArea = { id, name, bbox, savedAt, tileUrls: saved, layers };
  const json = JSON.stringify(area);
  await (await caches.open(DATA_CACHE)).put(`${DATA_PREFIX}${id}.json`, new Response(json, { headers: { "content-type": "application/json" } }));
  memo.set(id, area);
  const summary: OfflineAreaSummary = {
    id,
    name,
    bbox,
    savedAt,
    tileCount: saved.length,
    featureCount: Object.values(layers).reduce((s, l) => s + l.length, 0),
    bytes: json.length + tileBytes,
  };
  writeIndex([summary, ...listAreas().filter(a => a.id !== id)]);
  onProgress(total, total, "Saved");
  return summary;
}
