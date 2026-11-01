/**
 * Land-status, stream-bend and claim-staking helpers for OpenLand Navigator.
 *
 * Plain TypeScript with no React or OpenLayers imports, so it runs under
 * `node --test` using Node's built-in type stripping. Two rules shape it:
 *
 *  1. Fail closed. A lookup that errors means "couldn't verify", never "open".
 *     ArcGIS REST reports query errors as HTTP 200 with an `error` body, so
 *     every response is checked for that, not just for `res.ok`.
 *  2. Say what the data cannot prove. BLM maps each claim onto the
 *     quarter-section blocks it touches, new claims can take up to 90 days to
 *     reach BLM, and mineral withdrawals are not checked here yet.
 */

export const CLAIMS_URL =
  "https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/MapServer";
export const CLAIMS_CLOSED_URL =
  "https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Closed/MapServer";
export const CADASTRAL_URL = "https://gisservice.mt.gov/arcgis/rest/services/msdi_cadastral_map_v1/MapServer";
export const NHD_FLOWLINE_URL = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6";

/** BLM fees for recording one new claim, read from blm.gov on 2026-11-01. Fees change; re-check before filing. */
export const BLM_FEES = {
  processing: 25,
  location: 49,
  maintenancePerUnit: 200,
  verifiedOn: "2026-11-01",
  sourceUrl: "https://www.blm.gov/programs/energy-and-minerals/mining-and-minerals/locatable-minerals/mining-claims/fees",
} as const;

/** Montana county recording fee for a standard document under MCA 7-4-2637 (2025 code), read on 2026-11-01. */
export const COUNTY_RECORDING_FEE = { firstPage: 20, additionalPage: 10 } as const;

export type Attributes = Record<string, unknown>;
export type ArcgisFeature = {
  attributes?: Attributes;
  geometry?: { paths?: number[][][]; rings?: number[][][]; x?: number; y?: number };
};

/**
 * Run an ArcGIS REST query and return its features.
 *
 * Throws on network failure, a non-2xx status, an ArcGIS `error` body (which
 * arrives with HTTP 200), or a body with no `features` array, so callers can
 * never mistake a failed lookup for "nothing here".
 */
export async function arcgisFeatures(url: string, signal?: AbortSignal): Promise<ArcgisFeature[]> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { features?: ArcgisFeature[]; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message || "ArcGIS query failed");
  if (!Array.isArray(data.features)) throw new Error("ArcGIS response had no features array");
  return data.features;
}

/** Build the query string for a point-intersect ArcGIS query in WGS84. */
export function pointQuery(lon: number, lat: number, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    f: "json",
    geometry: `${lon},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
    ...extra,
  }).toString();
}

export type LandCategory =
  | "blm"
  | "usfs"
  | "stateTrust"
  | "noCollecting"
  | "otherPublic"
  | "private"
  | "unknown";

/**
 * Classify who manages the surface at a point.
 *
 * `publicOwner` is the OWNER value from the Montana Public Lands layer (for
 * example "US Bureau of Land Management"); `parcelOwner` is the county
 * parcel's OwnerName. If the two disagree (public layer says BLM or USFS but
 * the parcel names a private owner) the answer is "unknown": ask first.
 */
export function classifyLand(publicOwner: string, parcelOwner: string): LandCategory {
  const pub = publicOwner.trim();
  const parcel = parcelOwner.trim().toUpperCase();
  const parcelLooksPublic =
    /BUREAU OF LAND MANAGEMENT|\bBLM\b|FOREST SERVICE|\bUSFS\b|\bUSDA\b|UNITED STATES|\bUSA\b|\bUSDI\b|STATE OF MONTANA|\bDNRC\b|NATIONAL PARK|FISH (AND|&) WILDLIFE|\bTOWN OF\b|\bCITY OF\b|\bCOUNTY\b/.test(parcel);
  if (pub) {
    let fromPublic: LandCategory = "otherPublic";
    if (/bureau of land management/i.test(pub)) fromPublic = "blm";
    else if (/forest service/i.test(pub)) fromPublic = "usfs";
    else if (/state trust/i.test(pub)) fromPublic = "stateTrust";
    else if (/national park|fish and wildlife/i.test(pub)) fromPublic = "noCollecting";
    if ((fromPublic === "blm" || fromPublic === "usfs") && parcel && !parcelLooksPublic) return "unknown";
    return fromPublic;
  }
  if (!parcel) return "unknown";
  if (/BUREAU OF LAND MANAGEMENT|\bBLM\b/.test(parcel)) return "blm";
  if (/FOREST SERVICE|\bUSFS\b/.test(parcel)) return "usfs";
  if (/\bDNRC\b/.test(parcel)) return "stateTrust";
  if (/NATIONAL PARK|FISH (AND|&) WILDLIFE SERVICE/.test(parcel)) return "noCollecting";
  if (parcelLooksPublic) return "otherPublic";
  return "private";
}

export type LandCheck = {
  category: LandCategory;
  /** Best available owner text for display. */
  ownerName: string;
  /** Active, filed or under-review claims within 25 m; null when the BLM lookup failed. */
  activeClaims: number | null;
  /** Closed claims within 25 m; null when the BLM lookup failed. */
  closedClaims: number | null;
  /** Human-readable names of lookups that failed. */
  failed: string[];
  checkedAt: string;
};

export type LandLookup = {
  check: LandCheck;
  parcel: Attributes | null;
  publicOwner: string;
  active: Attributes[];
  closed: Attributes[];
};

/**
 * Look up claims and ownership at one point, in parallel.
 *
 * Never throws: each failed source is listed in `check.failed`, and
 * ownership becomes "unknown" if either ownership source failed.
 */
export async function checkLandAt(lon: number, lat: number, signal?: AbortSignal): Promise<LandLookup> {
  const near = pointQuery(lon, lat, { distance: "25", units: "esriSRUnit_Meter" });
  const at = pointQuery(lon, lat);
  const [act, closed, parcel, pub] = await Promise.allSettled([
    arcgisFeatures(`${CLAIMS_URL}/0/query?${near}`, signal),
    arcgisFeatures(`${CLAIMS_CLOSED_URL}/0/query?${near}`, signal),
    arcgisFeatures(`${CADASTRAL_URL}/1/query?${at}`, signal),
    arcgisFeatures(`${CADASTRAL_URL}/2/query?${at}`, signal),
  ]);
  const failed: string[] = [];
  if (act.status === "rejected") failed.push("BLM active claims");
  if (closed.status === "rejected") failed.push("BLM closed claims");
  if (parcel.status === "rejected") failed.push("county parcels");
  if (pub.status === "rejected") failed.push("public land ownership");

  const parcelAttrs = parcel.status === "fulfilled" ? parcel.value[0]?.attributes ?? null : null;
  const publicOwner = pub.status === "fulfilled" ? String(pub.value[0]?.attributes?.OWNER ?? "") : "";
  const parcelOwner = parcelAttrs ? String(parcelAttrs.OwnerName ?? "") : "";
  const ownershipChecked = parcel.status === "fulfilled" && pub.status === "fulfilled";
  const category = ownershipChecked ? classifyLand(publicOwner, parcelOwner) : "unknown";
  const active = act.status === "fulfilled" ? act.value.map(f => f.attributes ?? {}) : [];
  const closedList = closed.status === "fulfilled" ? closed.value.map(f => f.attributes ?? {}) : [];

  return {
    check: {
      category,
      ownerName: publicOwner || parcelOwner || "No owner record found",
      activeClaims: act.status === "fulfilled" ? active.length : null,
      closedClaims: closed.status === "fulfilled" ? closedList.length : null,
      failed,
      checkedAt: new Date().toISOString(),
    },
    parcel: parcelAttrs,
    publicOwner,
    active,
    closed: closedList,
  };
}

export type PanningAnswer = "likely" | "ask" | "no" | "unknown";
export type Verdict = {
  /** Drives the badge colour; "caution" = likely OK to pan, but research before staking. */
  tone: PanningAnswer | "caution";
  badge: string;
  detail: string;
  /** Whether casual hand-panning is likely allowed at this exact point. */
  panning: PanningAnswer;
  /** One-line version for dig-spot and claim-box lists. */
  short: string;
};

const CLAIM_DATA_CAVEAT =
  "BLM maps claims onto quarter-section blocks, new claims can take up to 90 days to reach BLM, and withdrawals (wilderness, recreation sites) are not checked yet. Look for corner posts and signs before you dig.";

/** Turn a LandCheck into the user-facing verdict. Unknown always beats open. */
export function landVerdict(check: LandCheck): Verdict {
  const safetyFailures = check.failed.filter(name => name !== "BLM closed claims");
  if (check.activeClaims === null || safetyFailures.length) {
    return {
      tone: "unknown",
      panning: "unknown",
      badge: "⚠️ COULDN'T VERIFY — DON'T DIG OR STAKE YET",
      detail: `Could not check: ${safetyFailures.join(", ") || "BLM active claims"}. Try again with better signal.`,
      short: "⚠️ Couldn't verify this spot",
    };
  }
  if (check.activeClaims > 0) {
    return {
      tone: "no",
      panning: "no",
      badge: `🛑 ${check.activeClaims} ACTIVE MINING CLAIM(S) RECORDED HERE`,
      detail:
        "Panning or digging on someone's claim takes their minerals. Get the claimant's permission. BLM shades the whole quarter-section block a claim touches, so the real claim may be smaller than the shaded area.",
      short: "🛑 Active claim recorded",
    };
  }
  switch (check.category) {
    case "stateTrust":
      return {
        tone: "no",
        panning: "no",
        badge: "🚫 STATE TRUST LAND — NO PANNING OR STAKING",
        detail:
          "Montana DNRC's recreation rules exclude mineral exploration and taking valuable rocks or minerals from general recreational use, and federal claims can't be staked on state land.",
        short: "🚫 State trust land",
      };
    case "noCollecting":
      return {
        tone: "no",
        panning: "no",
        badge: "🚫 NATIONAL PARK / WILDLIFE REFUGE — NO COLLECTING",
        detail: `${check.ownerName} land. Removing minerals is not allowed.`,
        short: "🚫 Park / refuge",
      };
    case "private":
      return {
        tone: "ask",
        panning: "ask",
        badge: "🏠 PRIVATE LAND — LANDOWNER PERMISSION REQUIRED",
        detail:
          "Montana's stream access law covers uses like fishing and floating; it does not give you the gold. Ask the landowner first.",
        short: "🏠 Private land — ask first",
      };
    case "otherPublic":
      return {
        tone: "ask",
        panning: "ask",
        badge: `❓ OTHER PUBLIC LAND (${check.ownerName.toUpperCase()}) — ASK THE AGENCY`,
        detail: "This isn't BLM or National Forest land, so the federal casual-use rules may not apply. Ask the managing agency.",
        short: "❓ Other public land — ask first",
      };
    case "unknown":
      return {
        tone: "ask",
        panning: "ask",
        badge: "❓ OWNERSHIP UNCLEAR — ASK FIRST",
        detail: "No clear owner record, or the state and county records disagree. Treat it as private until you know.",
        short: "❓ Ownership unclear",
      };
    case "blm":
    case "usfs": {
      const land = check.category === "blm" ? "BLM land" : "National Forest";
      if (check.closedClaims) {
        return {
          tone: "caution",
          panning: "likely",
          badge: `🔍 ${land.toUpperCase()} · CLOSED CLAIM ON FILE — RESEARCH BEFORE RESTAKING`,
          detail: `${land} with no active claim found within 25 m, and ${check.closedClaims} closed claim(s) on record. Closed is not the same as open: check MLRS for newer claims. ${CLAIM_DATA_CAVEAT}`,
          short: `🟡 ${land}, no active claim found — verify`,
        };
      }
      return {
        tone: "likely",
        panning: "likely",
        badge: `🟡 ${land.toUpperCase()} · LIKELY OPEN FOR CASUAL PANNING — VERIFY`,
        detail: `${land} with no active claim found within 25 m in BLM records. Hand panning is casual use on open federal land. ${CLAIM_DATA_CAVEAT}`,
        short: `🟡 ${land}, no active claim found — verify`,
      };
    }
  }
}

/** Great-circle distance in statute miles (haversine). */
export function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Feet per degree of latitude and longitude at a latitude, on the WGS84 ellipsoid. */
export function feetPerDegree(lat: number): { lat: number; lon: number } {
  const a = 6378137;
  const e2 = 0.00669437999014;
  const phi = (lat * Math.PI) / 180;
  const w = 1 - e2 * Math.sin(phi) ** 2;
  const metresLat = ((Math.PI / 180) * a * (1 - e2)) / w ** 1.5;
  const metresLon = ((Math.PI / 180) * a * Math.cos(phi)) / Math.sqrt(w);
  return { lat: metresLat / 0.3048, lon: metresLon / 0.3048 };
}

/** Move a WGS84 point by a distance in feet east and north. */
export function offsetByFeet(center: { lon: number; lat: number }, eastFt: number, northFt: number) {
  const k = feetPerDegree(center.lat);
  return { lon: center.lon + eastFt / k.lon, lat: center.lat + northFt / k.lat };
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compass8(eastward: number, northward: number): string {
  const bearing = ((Math.atan2(eastward, northward) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
}

export type BendSpot = {
  lon: number;
  lat: number;
  name: string;
  turnDeg: number;
  /** Compass side of the channel line that is the inside of the bend. */
  insideSide: string;
  distanceMiles: number;
};

/** NHD feature type for natural streams and rivers (excludes ditches, pipelines and artificial paths). */
const STREAM_RIVER_FTYPE = 460;

/**
 * Find the sharpest named-stream bends near a point from NHD flowlines.
 *
 * Turns are measured in feet (not raw degrees, which distort east-west
 * distances) over a window of `windowFt` either side of each vertex, so
 * digitizing kinks a few feet long don't count as bends. Returns at most
 * three spots at least ~200 ft apart, sharpest and closest first.
 */
export function findBendSpots(
  features: ArcgisFeature[],
  lon: number,
  lat: number,
  { windowFt = 80, minTurnDeg = 30, maxMiles = 0.35 } = {},
): BendSpot[] {
  const k = feetPerDegree(lat);
  const candidates: Array<{ spot: BendSpot; score: number }> = [];
  for (const feature of features) {
    const name = String(feature.attributes?.gnis_name ?? "").trim();
    if (!name || Number(feature.attributes?.ftype) !== STREAM_RIVER_FTYPE) continue;
    for (const path of feature.geometry?.paths ?? []) {
      const pts = path.map(([x, y]) => ({ lon: x, lat: y, e: (x - lon) * k.lon, n: (y - lat) * k.lat }));
      const along: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        along.push(along[i - 1] + Math.hypot(pts[i].e - pts[i - 1].e, pts[i].n - pts[i - 1].n));
      }
      for (let i = 1; i < pts.length - 1; i++) {
        let j = i - 1;
        while (j > 0 && along[i] - along[j] < windowFt) j--;
        let m = i + 1;
        while (m < pts.length - 1 && along[m] - along[i] < windowFt) m++;
        if (along[i] - along[j] < windowFt || along[m] - along[i] < windowFt) continue;
        const v1 = { e: pts[i].e - pts[j].e, n: pts[i].n - pts[j].n };
        const v2 = { e: pts[m].e - pts[i].e, n: pts[m].n - pts[i].n };
        const cross = v1.e * v2.n - v1.n * v2.e;
        const turnDeg = Math.abs((Math.atan2(cross, v1.e * v2.e + v1.n * v2.n) * 180) / Math.PI);
        if (turnDeg < minTurnDeg) continue;
        const miles = distanceMiles(lat, lon, pts[i].lat, pts[i].lon);
        if (miles > maxMiles) continue;
        const len = Math.hypot(v1.e + v2.e, v1.n + v2.n) || 1;
        const d = { e: (v1.e + v2.e) / len, n: (v1.n + v2.n) / len };
        const inside = cross > 0 ? { e: -d.n, n: d.e } : { e: d.n, n: -d.e };
        candidates.push({
          spot: {
            lon: pts[i].lon,
            lat: pts[i].lat,
            name,
            turnDeg,
            insideSide: compass8(inside.e, inside.n),
            distanceMiles: miles,
          },
          score: turnDeg - miles * 40,
        });
      }
    }
  }
  const picked: BendSpot[] = [];
  for (const { spot } of candidates.sort((a, b) => b.score - a.score)) {
    if (picked.every(p => distanceMiles(spot.lat, spot.lon, p.lat, p.lon) > 0.04)) picked.push(spot);
    if (picked.length === 3) break;
  }
  return picked;
}

export type ClaimKind = "placer" | "lode";
export const CLAIM_SHAPES: Record<ClaimKind, { widthFt: number; lengthFt: number; label: string }> = {
  placer: { widthFt: 660, lengthFt: 1320, label: "Placer: 20 acres (1,320 × 660 ft)" },
  lode: { widthFt: 600, lengthFt: 1500, label: "Lode: 1,500 × 600 ft (≈20.66 acres)" },
};

/**
 * Corners of a claim rectangle centred on `center`, rotated clockwise by
 * `angleDeg` from north. Returned as [lon, lat] in the order NW, NE, SE, SW
 * (as they would be at 0°).
 */
export function stakeBoxCorners(
  center: { lon: number; lat: number },
  angleDeg: number,
  kind: ClaimKind,
): Array<[number, number]> {
  const { widthFt, lengthFt } = CLAIM_SHAPES[kind];
  const hw = widthFt / 2;
  const hl = lengthFt / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [-hw, hl],
    [hw, hl],
    [hw, -hl],
    [-hw, -hl],
  ].map(([x, y]) => {
    const p = offsetByFeet(center, x * cos + y * sin, -x * sin + y * cos);
    return [p.lon, p.lat] as [number, number];
  });
}

export type StakePacketInput = {
  kind: ClaimKind;
  center: { lon: number; lat: number };
  angleDeg: number;
  corners: Array<[number, number]>;
  county?: string;
  legal?: string;
  /** Verdicts for the box centre and each corner; null while still checking. */
  pointChecks: Array<{ label: string; verdict: Verdict }> | null;
};

/** Format a coordinate pair as "lat, lon" to 6 decimals (~0.1 m). */
const fmt = ([lon, lat]: [number, number]) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

/**
 * Build the copyable staking checklist for the box exactly as drawn.
 *
 * Contains no sales copy and no invented facts: every figure is computed
 * from the drawn box or read from a cited source with its check date.
 */
export function buildStakingPacket(input: StakePacketInput): string {
  const shape = CLAIM_SHAPES[input.kind];
  const blmTotal = BLM_FEES.processing + BLM_FEES.location + BLM_FEES.maintenancePerUnit;
  const blocked = !input.pointChecks
    ? ["Land check still running — don't stake until it finishes."]
    : input.pointChecks.filter(p => p.verdict.panning !== "likely").map(p => `${p.label}: ${p.verdict.short}`);
  const labels = input.angleDeg === 0 ? ["NW", "NE", "SE", "SW"] : ["1", "2", "3", "4"];
  return [
    "=== MONTANA MINING CLAIM — STAKING CHECKLIST (DRAFT, NOT A SURVEY) ===",
    ...(blocked.length ? ["", "⚠️ STOP — these points did not check out as open BLM/USFS land with no active claim:", ...blocked.map(b => `  • ${b}`)] : []),
    "",
    `Claim type: ${shape.label}`,
    `Box centre (not your discovery point): ${fmt([input.center.lon, input.center.lat])}`,
    `Rotation: ${input.angleDeg}° clockwise from north`,
    ...input.corners.map((c, i) => `Corner ${labels[i]}: ${fmt(c)}`),
    "Coordinates come from a map tap and phone GPS (often several metres off). Planning aid only.",
    `County (parcel record): ${input.county || "verify"} · PLSS (county record, verify on the BLM plat): ${input.legal || "verify"}`,
    ...(input.pointChecks ? ["", "Land check (BLM + Montana cadastral):", ...input.pointChecks.map(p => `  • ${p.label}: ${p.verdict.short}`)] : []),
    "",
    "STEPS & DEADLINES (verify current rules before acting):",
    "1. Confirm the ground is open: BLM MLRS (https://mlrs.blm.gov), county records, withdrawals/wilderness, and posts on the ground.",
    "2. Make a discovery of a valuable mineral deposit. Re-staking a closed claim needs the same discovery work as a new one (MCA 82-2-105).",
    "3. Post a notice at the discovery point: claim name, locator name(s), date, approximate dimensions (MCA 82-2-101(1)).",
    "4. Within 30 days: monument every corner (e.g. a 4-inch-square post 4 ft 6 in long, set 1 ft deep, with a mound), each marked with the claim name and corner (MCA 82-2-101(2)).",
    `5. Within 60 days of posting: record a notarized certificate of location with the county clerk, including directions and distances from the discovery point (MCA 82-2-102). County fee: $${COUNTY_RECORDING_FEE.firstPage} first page + $${COUNTY_RECORDING_FEE.additionalPage} each extra page (MCA 7-4-2637).`,
    `6. Within 90 days of location: file with BLM and pay $${BLM_FEES.processing} processing + $${BLM_FEES.location} location + $${BLM_FEES.maintenancePerUnit} maintenance = $${blmTotal} per claim (placer: $${BLM_FEES.maintenancePerUnit} per 20 acres). Fees per ${BLM_FEES.sourceUrl} on ${BLM_FEES.verifiedOn}.`,
    `7. Every year by September 1: $${BLM_FEES.maintenancePerUnit} maintenance per claim (or a small-miner waiver if eligible), plus the county filing under MCA 82-2-103.`,
    "",
    "WARNING: In Montana, filing a certificate for a claim that was not first posted and monumented on the ground is a felony (MCA 82-2-115: up to 5 years and/or $5,000).",
  ].join("\n");
}
