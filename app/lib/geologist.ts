/**
 * Grounded prospecting evidence for one point, computed from USGS records with no AI.
 *
 * - Upstream sources: USGS NLDI finds the stream reach at the point and the
 *   drainage basin above it. USGS MRDS mines and prospects inside that basin
 *   are the ones whose material can actually wash down to this spot; a mine
 *   that is merely "uphill" in another drainage cannot.
 * - Gradient: USGS 3DEP elevations sampled along the reach show whether the
 *   creek flattens at the point, where heavy gold tends to drop out.
 *
 * This says nothing about whether digging is legal; that is land-status.ts.
 * Every lookup fails soft: a failed source is listed and the evidence level
 * becomes "unknown" rather than "none".
 */
import { distanceMiles, feetPerDegree, ringAcres } from "./land-status.ts";

export const NLDI_URL = "https://api.water.usgs.gov/nldi/linked-data";
export const MRDS_URL =
  "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer";
export const ELEVATION_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";

export type LonLat = [number, number];
const FT_PER_M = 3.28084;
const TIMEOUT_MS = 15000;

/** GET or POST (form-encoded) a JSON endpoint; throws on HTTP errors and ArcGIS error bodies. */
async function fetchJson(url: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
  const init: RequestInit = form
    ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }
    : {};
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  const error = data.error as { message?: string } | undefined;
  if (error) throw new Error(error.message || "Service error");
  return data;
}

/** Points every `stepFt` along a polyline, starting at its first vertex and ending at its last. */
export function sampleAlong(line: LonLat[], stepFt: number): LonLat[] {
  if (line.length < 2) return [...line];
  const k = feetPerDegree(line[0][1]);
  const out: LonLat[] = [line[0]];
  let carried = 0;
  for (let i = 1; i < line.length; i++) {
    const [x1, y1] = line[i - 1];
    const [x2, y2] = line[i];
    const segFt = Math.hypot((x2 - x1) * k.lon, (y2 - y1) * k.lat);
    let at = stepFt - carried;
    while (at <= segFt) {
      const t = at / segFt;
      out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
      at += stepFt;
    }
    carried = segFt - (at - stepFt);
  }
  const last = line[line.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
  return out;
}

export type Gradient = {
  /** Average slope (%) over the stretch just upstream of the point. */
  upstreamPct: number;
  /** Average slope (%) over the stretch just downstream of the point. */
  downstreamPct: number;
  /** True when the creek clearly flattens at the point (a classic place for heavy gold to settle). */
  flattens: boolean;
  /** How far the point is from the mapped stream line. */
  offStreamFt: number;
};

/**
 * Compare creek slope above and below the point from elevation samples along
 * the reach. Samples may be in either direction; they are oriented downhill.
 * Returns null when there isn't at least half a window of stream on each side.
 */
export function gradientAt(
  samples: Array<{ lon: number; lat: number; elevM: number }>,
  lon: number,
  lat: number,
  windowFt = 1000,
): Gradient | null {
  if (samples.length < 3) return null;
  const pts = samples[0].elevM < samples[samples.length - 1].elevM ? [...samples].reverse() : samples;
  const k = feetPerDegree(lat);
  const along = [0];
  for (let i = 1; i < pts.length; i++) {
    along.push(along[i - 1] + Math.hypot((pts[i].lon - pts[i - 1].lon) * k.lon, (pts[i].lat - pts[i - 1].lat) * k.lat));
  }
  let here = 0;
  let best = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot((p.lon - lon) * k.lon, (p.lat - lat) * k.lat);
    if (d < best) { best = d; here = i; }
  });
  let up = here;
  while (up > 0 && along[here] - along[up] < windowFt) up--;
  let down = here;
  while (down < pts.length - 1 && along[down] - along[here] < windowFt) down++;
  const upRun = along[here] - along[up];
  const downRun = along[down] - along[here];
  if (upRun < windowFt / 2 || downRun < windowFt / 2) return null;
  const upstreamPct = (((pts[up].elevM - pts[here].elevM) * FT_PER_M) / upRun) * 100;
  const downstreamPct = (((pts[here].elevM - pts[down].elevM) * FT_PER_M) / downRun) * 100;
  return {
    upstreamPct,
    downstreamPct,
    flattens: upstreamPct >= 1 && downstreamPct < upstreamPct * 0.6,
    offStreamFt: best,
  };
}

export type MineRecord = { id: string; name: string; status: string; gold: boolean };
export type EvidenceLevel = "strong" | "some" | "weak" | "none" | "unknown";

/** Rank what the upstream USGS mineral records say about a gold source. */
export function classifyUpstream(records: MineRecord[]): { level: EvidenceLevel; producers: string[]; prospects: string[]; otherSites: number } {
  // "Carbonate King Mine" and "Carbonate King" are the same site in MRDS; keep the first spelling.
  const key = (name: string) => name.toLowerCase().replace(/\b(mines?|claims?|lode|placers?|prospects?|group)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const unique = (list: MineRecord[]) => {
    const seen = new Map<string, string>();
    for (const r of list) if (!seen.has(key(r.name))) seen.set(key(r.name), r.name);
    return [...seen.values()];
  };
  const gold = records.filter(r => r.gold);
  const producers = unique(gold.filter(r => /^(Producer|Past Producer)$/i.test(r.status)));
  const producerKeys = new Set(producers.map(key));
  const prospects = unique(gold.filter(r => !/^(Producer|Past Producer)$/i.test(r.status))).filter(n => !producerKeys.has(key(n)));
  const otherSites = unique(records.filter(r => !r.gold)).length;
  const level: EvidenceLevel = producers.length ? "strong" : prospects.length ? "some" : records.length ? "weak" : "none";
  return { level, producers, prospects, otherSites };
}

export type UpstreamEvidence = {
  level: EvidenceLevel;
  producers: string[];
  prospects: string[];
  otherSites: number;
  gradient: Gradient | null;
  elevationFt: number | null;
  /** Distance from the point to the stream reach USGS matched it to. */
  reachDistanceFt: number | null;
  /** Area draining to that reach, in square miles. */
  drainageSqMi: number | null;
  /** Names of lookups that failed. */
  failed: string[];
};

/** Elevations (metres) at the given points from USGS 3DEP, in the same order; null where unavailable. */
async function elevations(points: LonLat[]): Promise<Array<number | null>> {
  const data = await fetchJson(`${ELEVATION_URL}/getSamples`, {
    geometry: JSON.stringify({ points, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryMultipoint",
    returnFirstValueOnly: "true",
    f: "json",
  });
  const samples = (data.samples as Array<{ locationId?: number; value?: string }> | undefined) ?? [];
  const out: Array<number | null> = points.map(() => null);
  samples.forEach((s, i) => {
    const idx = typeof s.locationId === "number" ? s.locationId : i;
    const v = Number(s.value);
    if (idx >= 0 && idx < out.length && Number.isFinite(v) && v > -500 && v < 6000) out[idx] = v;
  });
  return out;
}

/**
 * Gather upstream-source and gradient evidence for a point. Never throws:
 * failed lookups are listed in `failed`, and if the upstream basin or the
 * mineral records can't be read the level is "unknown".
 */
export async function upstreamEvidence(lon: number, lat: number): Promise<UpstreamEvidence> {
  const failed: string[] = [];
  let comid = "";
  let reach: LonLat[] = [];
  try {
    const pos = await fetchJson(`${NLDI_URL}/comid/position?f=json&coords=${encodeURIComponent(`POINT(${lon} ${lat})`)}`);
    const feature = (pos.features as Array<{ properties?: { comid?: string | number }; geometry?: { coordinates?: LonLat[] } }> | undefined)?.[0];
    comid = String(feature?.properties?.comid ?? "");
    reach = feature?.geometry?.coordinates ?? [];
    if (!comid) throw new Error("no stream found");
  } catch {
    failed.push("USGS stream network (NLDI)");
  }

  // Elevation along the reach (capped at ~150 samples) plus the point itself.
  const reachLengthFt = reach.length > 1 ? reach.slice(1).reduce((s, p, i) => s + distanceMiles(reach[i][1], reach[i][0], p[1], p[0]) * 5280, 0) : 0;
  const samplePts = reach.length > 1 ? sampleAlong(reach, Math.max(100, reachLengthFt / 150)) : [];
  const [basinResult, elevResult] = await Promise.allSettled([
    comid ? fetchJson(`${NLDI_URL}/comid/${comid}/basin?f=json`) : Promise.reject(new Error("no stream")),
    elevations([[lon, lat], ...samplePts]),
  ]);

  let elevationFt: number | null = null;
  let gradient: Gradient | null = null;
  if (elevResult.status === "fulfilled") {
    const [spot, ...along] = elevResult.value;
    elevationFt = spot === null ? null : Math.round(spot * FT_PER_M);
    const samples = samplePts.flatMap((p, i) => (along[i] === null ? [] : [{ lon: p[0], lat: p[1], elevM: along[i] as number }]));
    gradient = gradientAt(samples, lon, lat);
  } else {
    failed.push("USGS elevation (3DEP)");
  }

  const k = feetPerDegree(lat);
  const nearPts = samplePts.length ? samplePts : reach;
  const reachDistanceFt = nearPts.length ? Math.min(...nearPts.map(([x, y]) => Math.hypot((x - lon) * k.lon, (y - lat) * k.lat))) : null;
  let drainageSqMi: number | null = null;
  let records: MineRecord[] | null = null;
  if (basinResult.status === "fulfilled") {
    try {
      const geometry = (basinResult.value.features as Array<{ geometry?: { type?: string; coordinates?: unknown } }> | undefined)?.[0]?.geometry;
      const polygons: LonLat[][][] =
        geometry?.type === "MultiPolygon" ? (geometry.coordinates as LonLat[][][]) : geometry?.coordinates ? [geometry.coordinates as LonLat[][]] : [];
      const rings = polygons.flat();
      if (!rings.length) throw new Error("empty basin");
      drainageSqMi = polygons.reduce((sum, poly) => sum + ringAcres(poly[0]) - poly.slice(1).reduce((h, hole) => h + ringAcres(hole), 0), 0) / 640;
      const sites = await fetchJson(`${MRDS_URL}/0/query`, {
        f: "json",
        geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPolygon",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "DEP_ID,SITE_NAME,DEV_STAT",
        returnGeometry: "false",
        resultRecordCount: "2000",
      });
      const rows = ((sites.features as Array<{ attributes?: Record<string, unknown> }> | undefined) ?? []).map(f => f.attributes ?? {});
      const ids = [...new Set(rows.map(r => String(r.DEP_ID ?? "")).filter(Boolean))].slice(0, 300);
      const goldIds = new Set<string>();
      if (ids.length) {
        const commodities = await fetchJson(`${MRDS_URL}/10/query`, {
          f: "json",
          where: `Record_ID IN (${ids.map(id => `'${id.replace(/'/g, "''")}'`).join(",")})`,
          outFields: "Record_ID,Commodity_name",
          returnGeometry: "false",
          resultRecordCount: "2000",
        });
        for (const f of (commodities.features as Array<{ attributes?: Record<string, unknown> }> | undefined) ?? []) {
          if (/gold/i.test(String(f.attributes?.Commodity_name ?? ""))) goldIds.add(String(f.attributes?.Record_ID ?? ""));
        }
      }
      records = rows.map(r => ({
        id: String(r.DEP_ID ?? ""),
        name: String(r.SITE_NAME ?? "Unnamed site"),
        status: String(r.DEV_STAT ?? "Unknown"),
        gold: goldIds.has(String(r.DEP_ID ?? "")),
      }));
    } catch {
      failed.push("USGS mineral records (MRDS)");
    }
  } else if (comid) {
    failed.push("USGS upstream basin (NLDI)");
  }

  if (!records) return { level: "unknown", producers: [], prospects: [], otherSites: 0, gradient, elevationFt, reachDistanceFt, drainageSqMi, failed };
  return { ...classifyUpstream(records), gradient, elevationFt, reachDistanceFt, drainageSqMi, failed };
}

const list = (names: string[]) => names.slice(0, 4).join(", ") + (names.length > 4 ? `, +${names.length - 4} more` : "");

/** Plain-language report of the evidence, including what it can't prove. */
export function formatEvidence(e: UpstreamEvidence): string {
  const headline: Record<EvidenceLevel, string> = {
    strong: `STRONG upstream evidence: ${e.producers.length} past-producing gold mine(s) drain to this creek (${list(e.producers)})${e.prospects.length ? `, plus ${e.prospects.length} gold prospect(s)` : ""}.`,
    some: `SOME upstream evidence: ${e.prospects.length} gold prospect(s) or occurrence(s) drain to this creek (${list(e.prospects)}), but no past-producing gold mines.`,
    weak: `WEAK upstream evidence: ${e.otherSites} USGS mineral site(s) drain here, but none list gold.`,
    none: "NO upstream source found: USGS records show no mineral sites in this creek's upstream drainage.",
    unknown: `COULDN'T CHECK the upstream drainage (${e.failed.join(", ") || "lookup failed"}).`,
  };
  const g = e.gradient;
  const offStream = e.reachDistanceFt !== null && e.reachDistanceFt > 500;
  const matchedLine =
    e.reachDistanceFt === null
      ? null
      : `Matched stream: ${Math.round(e.reachDistanceFt).toLocaleString("en-US")} ft from your spot${e.drainageSqMi !== null ? `, draining about ${e.drainageSqMi < 10 ? e.drainageSqMi.toFixed(1) : Math.round(e.drainageSqMi).toLocaleString("en-US")} sq mi above it` : ""}.${offStream ? " ⚠️ Your spot isn't on this stream, so these results describe the nearest mapped creek." : ""}`;
  const gradientLine = !g
    ? "Creek gradient: not enough mapped stream around this point to measure."
    : `Creek gradient: ${g.upstreamPct.toFixed(1)}% just upstream, ${g.downstreamPct.toFixed(1)}% just downstream${g.flattens && !offStream ? " — the creek flattens here, where heavy gold tends to drop out." : "."}`;
  return [
    "🧭 UPSTREAM GOLD CHECK (USGS stream network + mineral records)",
    headline[e.level],
    ...(matchedLine ? [matchedLine] : []),
    gradientLine,
    `Elevation here: ${e.elevationFt === null ? "unknown" : `${e.elevationFt.toLocaleString("en-US")} ft`}.`,
    ...(e.failed.length && e.level !== "unknown" ? [`Couldn't check: ${e.failed.join(", ")}.`] : []),
    "This is evidence from USGS records, not proof of gold at this exact spot.",
  ].join("\n");
}
