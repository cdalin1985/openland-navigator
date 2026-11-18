#!/usr/bin/env node
/**
 * Builds app/data/mt-cabins.json: every Forest Service rental cabin / lookout /
 * guard station / bunkhouse inside the state of Montana, plus the BLM rental cabins
 * and houses that recreation.gov lists in Montana, with coordinates and a verified
 * recreation.gov booking link.
 *
 * Sources (all public, no API key):
 *   1. USFS "Recreation Opportunities" layer (the data behind the Forest Service
 *      Interactive Visitor Map), activity "Cabin Rentals" -> names + coordinates:
 *      https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationOpportunities_01/MapServer/0
 *   2. US Census TIGERweb state boundary -> keeps only points inside Montana
 *      (the layer has no state field, so a bounding box alone pulls in ID/WY/ND/SD):
 *      https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0
 *   3. recreation.gov public JSON (the same calls the website makes) -> every
 *      booking link is checked against the live facility record before it is kept.
 *
 * Booking-link rule: a cabin only gets `bookUrl` when the recreation.gov facility
 * is a Forest Service facility in Montana, is not deactivated, and sits near the
 * Forest Service point. Where the Forest Service text carries no usable link, the
 * facility is found by name on recreation.gov and must also match on name and sit
 * within 3 km. Anything that cannot be verified gets `bookUrl: null` and the app
 * shows the Forest Service's own rental instructions instead of a guessed link.
 *
 * Usage:   node scripts/build-mt-cabins.mjs [--report] [--force]
 *   --report   print the full audit, write nothing
 *   --force    write even if the result has far fewer cabins/links than the existing file
 * Behind an HTTPS proxy:  NODE_USE_ENV_PROXY=1 node scripts/build-mt-cabins.mjs
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REC_LAYER = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationOpportunities_01/MapServer/0/query";
const STATES_LAYER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0/query";
const RG = "https://www.recreation.gov";
const UA = { "user-agent": "Mozilla/5.0 (compatible; openland-navigator-cabin-builder/1.0)" };
/** Generous envelope around Montana; the exact boundary test happens locally. */
const MT_ENVELOPE = "-116.2,44.2,-103.9,49.2";
const OUT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../app/data/mt-cabins.json");
const REPORT_ONLY = process.argv.includes("--report");

async function getJson(base, params, headers = {}) {
  const url = `${base}?${new URLSearchParams({ f: "json", ...params })}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}`);
  const json = await res.json();
  if (json.error) throw new Error(`${base}: ${JSON.stringify(json.error)}`);
  return json;
}

/** Montana outline as a list of rings of [lon, lat]. */
async function fetchMontanaRings() {
  const json = await getJson(STATES_LAYER, {
    where: "STUSAB='MT'", returnGeometry: "true", outSR: "4326", geometryPrecision: "5", outFields: "NAME",
  });
  const rings = json.features?.[0]?.geometry?.rings;
  if (!rings?.length) throw new Error("TIGERweb returned no Montana geometry");
  return rings;
}

/** Even-odd point-in-polygon across every ring (holes and multipart handled). */
function insideRings(lon, lat, rings) {
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

/** Smallest distance in km from a point to any ring edge (flat-earth approximation, fine at this scale). */
function distanceToBorderKm(lon, lat, rings) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
      const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Great-circle distance in km. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = d => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

async function fetchCabinRecords() {
  const records = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const json = await getJson(REC_LAYER, {
      where: "markeractivity='Cabin Rentals'",
      geometry: MT_ENVELOPE, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
      outFields: "recareaname,recareaid,forestname,openstatus,reservation_info",
      returnGeometry: "true", outSR: "4326", orderByFields: "objectid",
      resultOffset: String(offset), resultRecordCount: String(pageSize),
    });
    records.push(...(json.features ?? []));
    if (!json.exceededTransferLimit) break;
  }
  return records;
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&nbsp;": " ", "&#39;": "'" };
const decode = s => s.replace(/&(?:amp|lt|gt|quot|nbsp|#39);/g, m => ENTITIES[m]);
const toText = html => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/**
 * Read the Forest Service's free-text reservation info. Returns the recreation.gov
 * campground id when the text names exactly one in the current URL form, any
 * retired-form links worth following (they 301 to the current page), and plain text.
 */
export function parseReservation(html) {
  const raw = decode(html ?? "");
  const ids = new Set([...raw.matchAll(/recreation\.gov\/camping\/campgrounds\/(\d+)/gi)].map(m => m[1]));
  const hrefs = [...raw.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const legacy = hrefs.filter(h => /recreation\.gov\/camping\/[^/]+\/r\/campgroundDetails\.do/i.test(h));
  return { campgroundId: ids.size === 1 ? [...ids][0] : null, ambiguous: ids.size > 1, legacy, text: toText(html ?? "") };
}

/** Words that appear in almost every cabin name, so they carry no identifying weight. */
const GENERIC = new Set(["cabin", "cabins", "lookout", "guard", "station", "rental", "rentals", "ranger", "tower", "house", "the", "foot", "nf", "national", "forest", "and", "of"]);
/** Distinctive lowercase tokens of a facility name. */
export function nameTokens(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t && !GENERIC.has(t));
}
/** True when one name's distinctive words are all present in the other's. */
export function namesAgree(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return small.every(t => big.includes(t));
}

/**
 * Cabin, lookout, guard station or house — picks the map icon and the popup label.
 * "House" is the larger buildings rented whole: bunkhouses, the Savenac cookhouse and
 * cottages, homesteads, and BLM's Henneberry House. Names like "Antone Station" are
 * plain rental cabins (the Forest Service page calls it "the Antone Cabin").
 */
export function kindOf(name) {
  if (/lookout/i.test(name)) return "Lookout";
  if (/guard station|ranger station|ranger'?s house/i.test(name)) return "Guard station";
  if (/bunkhouse|cookhouse|cottage|homestead|\bhouse\b/i.test(name)) return "House";
  return "Cabin";
}

/** recreation.gov agency names this build accepts, and the short code stored in the data. */
const AGENCIES = { "USDA Forest Service": "USFS", "Bureau of Land Management": "BLM" };

/** Run `fn` over `items` with a small, polite concurrency. */
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function rg(path) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${RG}${path}`, { headers: UA, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue; }
      // 404 means "not found"; 3xx is read by the retired-link lookup. Anything else (403 block, 4xx) is a hard failure.
      if (res.status !== 200 && res.status !== 404 && !(res.status >= 300 && res.status < 400)) throw new Error(`recreation.gov ${RG}${path} returned HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`recreation.gov ${path} kept failing`);
}

/** Live recreation.gov facility record, or null when it does not exist. */
async function fetchFacility(id) {
  const res = await rg(`/api/camps/campgrounds/${id}`);
  if (res.status !== 200) return null;
  const c = (await res.json()).campground;
  if (!c) return null;
  return {
    id: String(c.facility_id), name: String(c.facility_name ?? ""), state: c.state, org: c.org_code,
    deactivated: !!c.is_deactivated, lat: Number(c.facility_latitude), lon: Number(c.facility_longitude),
  };
}

const monthStart = offset => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString();
};
const bookableMemo = new Map();
/**
 * True when recreation.gov has at least one bookable site defined for the facility.
 * Some pages exist only as information (e.g. Mt. Wam Lookout says it "does not offer
 * reservations through Recreation.gov"); those return zero sites. Two months are tried
 * (next month and ~7 months out) so a seasonal closure alone cannot hide a real cabin.
 */
function hasBookableSites(id) {
  if (!bookableMemo.has(id)) {
    bookableMemo.set(id, (async () => {
      for (const offset of [1, 7]) {
        const res = await rg(`/api/camps/availability/campground/${id}/month?start_date=${encodeURIComponent(monthStart(offset))}`);
        if (res.status !== 200) continue;
        const json = await res.json().catch(() => null);
        if (json?.campsites && Object.keys(json.campsites).length > 0) return true;
      }
      return false;
    })());
  }
  return bookableMemo.get(id);
}

/** Why a facility is not an acceptable booking page for this cabin (empty = acceptable). */
function facilityProblems(f, cabin, maxKm) {
  const problems = [];
  if (f.org !== "FS") problems.push(`agency ${f.org}`);
  // recreation.gov leaves `state` blank for many facilities, so only a non-empty wrong state is a failure;
  // the distance check below is what actually ties the facility to the (Montana-verified) Forest Service point.
  if (f.state && f.state !== "Montana") problems.push(`state ${f.state}`);
  if (f.deactivated) problems.push("deactivated");
  const km = haversineKm(cabin.lat, cabin.lon, f.lat, f.lon);
  if (!(km <= maxKm)) problems.push(`${Number.isFinite(km) ? km.toFixed(1) : "?"} km from the Forest Service point`);
  return problems;
}

/** Find a cabin on recreation.gov by name. Needs name AND location (within 3 km) agreement. */
async function findByName(cabin, log) {
  const res = await rg(`/api/search/suggest?q=${encodeURIComponent(cabin.name)}`);
  if (res.status !== 200) return null;
  const hits = ((await res.json()).inventory_suggestions ?? []).filter(s => s.entity_type === "campground" && s.org_name === "USDA Forest Service" && s.state_code === "Montana");
  const good = [];
  for (const h of hits) {
    if (!namesAgree(cabin.name, h.name)) continue;
    const km = haversineKm(cabin.lat, cabin.lon, Number(h.lat), Number(h.lng));
    if (km > 3) { log.push(`NEAR MISS ${cabin.name}: recreation.gov "${h.name}" (id ${h.entity_id}) is ${km.toFixed(1)} km away, so it was not linked`); continue; }
    good.push(h);
  }
  const ids = [...new Set(good.map(h => String(h.entity_id)))];
  return ids.length === 1 ? ids[0] : null;
}

/** Resolve and verify the recreation.gov booking id for one cabin. */
async function resolveBooking(cabin, res, log) {
  let id = res.campgroundId, source = "forest-service-text";
  if (!id && !res.ambiguous && res.legacy.length === 1) {
    const r = await rg(new URL(res.legacy[0]).pathname + new URL(res.legacy[0]).search);
    const m = (r.headers.get("location") ?? "").match(/\/camping\/campgrounds\/(\d+)/);
    if (m) { id = m[1]; source = "retired-link-redirect"; }
  }
  if (id) {
    const f = await fetchFacility(id);
    const problems = f ? facilityProblems(f, cabin, 10) : ["facility not found"];
    if (!problems.length && !(await hasBookableSites(id))) problems.push("no bookable sites on recreation.gov");
    if (!problems.length) return { id, source, recName: f.name, nameMatch: namesAgree(cabin.name, f.name) };
    log.push(`REJECTED ${cabin.name}: Forest Service-supplied id ${id} (${f?.name ?? "?"}) failed: ${problems.join(", ")}`);
  }
  const found = await findByName(cabin, log);
  if (found) {
    const f = await fetchFacility(found);
    const problems = f ? facilityProblems(f, cabin, 3) : ["facility not found"];
    if (!problems.length && !(await hasBookableSites(found))) problems.push("no bookable sites on recreation.gov");
    if (!problems.length) return { id: found, source: "name-search", recName: f.name, nameMatch: namesAgree(cabin.name, f.name) };
    log.push(`REJECTED ${cabin.name}: name-search id ${found} failed: ${problems.join(", ")}`);
  }
  return null;
}

const EXTRA_TERMS = ["cabin", "lookout", "guard station", "ranger station", "bunkhouse", "cottage", "homestead", "cookhouse", "station", "house"];
const EXTRA_NAME = /cabin|lookout|guard station|ranger station|bunkhouse|cottage|homestead|cookhouse|station|\bhouse\b/i;
const EXTRA_SKIP = /campground|trailhead|group|picnic|day use|boat|horse|\brv\b|shuttle|ticket|permit|tour/i;

/**
 * Montana rental cabins that recreation.gov lists but the USFS layer does not:
 * Forest Service ones the layer misses, and BLM's (the USFS layer has no BLM sites).
 * Name-filtered client-side (the search is fuzzy), reservable only.
 */
async function fetchRecGovCabins() {
  const found = new Map();
  for (const term of EXTRA_TERMS) {
    for (let start = 0; start < 1000;) {
      const p = new URLSearchParams({ q: term, exact: "false", size: "50", start: String(start) });
      p.append("fq", "state_code:Montana");
      const res = await rg(`/api/search?${p}`);
      if (res.status !== 200) break;
      const json = await res.json();
      const rows = json.results ?? [];
      for (const r of rows) {
        if (r.entity_type !== "campground" || !AGENCIES[r.org_name] || r.state_code !== "Montana" || r.reservable === false) continue;
        if (!EXTRA_NAME.test(r.name) || EXTRA_SKIP.test(r.name)) continue;
        found.set(String(r.entity_id), r);
      }
      start += rows.length;
      if (!rows.length || start >= (json.total ?? 0)) break;
    }
  }
  return [...found.values()];
}

/** "ANNA CREEK CABIN" -> "Anna Creek Cabin"; mixed-case names are left alone. */
const prettyName = s => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_, a, b) => a + b.toUpperCase()) : s).trim();
/**
 * Display-name cleanup shared by both sources so one place never appears under two spellings:
 * "Silvertip Cabin Rental Cabin" -> "Silvertip Cabin", "Garver Mtn. Lookout Rental" -> "Garver Mountain Lookout",
 * "Sex Peak. Lookout Rental" -> "Sex Peak Lookout", "Meadow Peak Lookout (MT)" -> "Meadow Peak Lookout".
 */
export const cleanName = s => s
  .replace(/\s*\(MT\)\s*$/i, "")
  .replace(/\bMtn\b\.?/gi, "Mountain")
  .replace(/\bMt\.(?=\s)/gi, "Mount")
  .replace(/(\w)\.\s+/g, "$1 ")
  .replace(/\bCabin Rental Cabin$/i, "Cabin")
  .replace(/\s+Rental$/i, "")
  .replace(/\s+/g, " ")
  .trim();

/** Problems (empty = OK) when `next` is much smaller than `previous`, e.g. after a blocked or partial fetch. */
export function checkAgainstPrevious(previous, next) {
  const problems = [];
  if (previous.length >= 20 && next.length < 0.9 * previous.length) {
    problems.push(`cabin count dropped from ${previous.length} to ${next.length}`);
  }
  const linked = list => list.filter(c => c.bookUrl).length;
  const before = linked(previous), after = linked(next);
  if (before >= 20 && after < 0.9 * before) problems.push(`linked cabins dropped from ${before} to ${after}`);
  return problems;
}

function readPreviousCabins() {
  try {
    const cabins = JSON.parse(readFileSync(OUT_FILE, "utf8")).cabins;
    return Array.isArray(cabins) ? cabins : [];
  } catch {
    return [];
  }
}

async function main() {
  const [rings, records, recGov] = await Promise.all([fetchMontanaRings(), fetchCabinRecords(), fetchRecGovCabins()]);
  const log = [];
  const candidates = [];
  const outside = [], campgrounds = [], seen = new Set();

  for (const r of records) {
    const a = r.attributes ?? {};
    const lon = r.geometry?.x, lat = r.geometry?.y;
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const name = String(a.recareaname ?? "").trim();
    if (!insideRings(lon, lat, rings)) { outside.push(`${name} (${a.forestname})`); continue; }
    if (/campground/i.test(name)) { campgrounds.push(name); continue; }
    if (seen.has(a.recareaid)) continue;
    seen.add(a.recareaid);
    const km = distanceToBorderKm(lon, lat, rings);
    if (km < 3) log.push(`NEAR BORDER ${name}: ${km.toFixed(2)} km from the Montana line (inside)`);
    candidates.push({
      a, res: parseReservation(a.reservation_info),
      cabin: { id: a.recareaid, name, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 },
    });
  }

  const resolved = await pool(candidates, 4, async ({ cabin, res }) => resolveBooking(cabin, res, log));

  const cabins = candidates.map(({ a, res, cabin }, i) => {
    const b = resolved[i];
    if (b && !b.nameMatch) log.push(`NAME DIFFERS ${cabin.name} -> recreation.gov "${b.recName}" (id ${b.id}, via ${b.source}; location agrees)`);
    return {
      id: cabin.id,
      src: "usfs",
      agency: "USFS",
      name: cleanName(cabin.name),
      kind: kindOf(cabin.name),
      forest: String(a.forestname ?? "").replace(/\s+National Forests?$/i, " NF").trim(),
      status: String(a.openstatus ?? "").toLowerCase() || "unknown",
      lat: cabin.lat,
      lon: cabin.lon,
      /** Verified recreation.gov booking page, or null when none could be verified. */
      bookUrl: b ? `${RG}/camping/campgrounds/${b.id}` : null,
      /** Forest Service rental text, kept only when there is no verified link. */
      note: b ? "" : res.text.slice(0, 400),
    };
  });

  // Add Montana rentals that recreation.gov lists but the USFS layer lacks (including every BLM one).
  const haveIds = new Set(resolved.filter(Boolean).map(b => b.id));
  const added = [];
  for (const r of recGov) {
    const id = String(r.entity_id);
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (haveIds.has(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!insideRings(lon, lat, rings)) { log.push(`SKIPPED recreation.gov-only "${r.name}" (id ${id}): coordinates fall outside Montana`); continue; }
    if (!(await hasBookableSites(id))) { log.push(`SKIPPED recreation.gov-only "${r.name}" (id ${id}): no bookable sites on recreation.gov`); continue; }
    // Same place as a Forest Service entry we could not link? Attach the link instead of adding a duplicate.
    // Only unlinked entries are candidates: a cabin that already has its own verified id is a different facility.
    const agency = AGENCIES[r.org_name];
    const twin = agency === "USFS" && cabins.find(c => !c.bookUrl && namesAgree(c.name, cleanName(String(r.name))) && haversineKm(c.lat, c.lon, lat, lon) <= 3);
    if (twin) {
      twin.bookUrl = `${RG}/camping/campgrounds/${id}`; twin.note = "";
      log.push(`MATCHED ${twin.name} -> recreation.gov "${r.name}" (id ${id}) by name and location`);
      continue;
    }
    const name = cleanName(prettyName(String(r.name)));
    added.push(name);
    cabins.push({
      id: Number(id), src: "recreation.gov", agency, name, kind: kindOf(name),
      // recreation.gov's BLM "parent" names are recreation areas or misspelled offices ("Dillion"), so BLM rows just say BLM.
      forest: agency === "BLM" ? "Bureau of Land Management" : String(r.parent_name ?? "").replace(/\s+National Forests?$/i, " NF").trim(),
      status: "unknown",
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
      bookUrl: `${RG}/camping/campgrounds/${id}`, note: "",
    });
  }
  if (added.length) log.push(`ADDED FROM RECREATION.GOV (not in the USFS cabin layer): ${added.sort().join("; ")}`);
  cabins.sort((x, y) => x.name.localeCompare(y.name));

  const bySource = {};
  resolved.forEach(b => { const k = b ? b.source : "UNRESOLVED"; bySource[k] = (bySource[k] ?? 0) + 1; });
  console.log(`Records in envelope: ${records.length}. Inside Montana: ${candidates.length + campgrounds.length}. Kept as cabins: ${cabins.length}.`);
  console.log(`Booking links by source: ${JSON.stringify(bySource)}`);
  if (campgrounds.length) console.log(`Dropped (named "Campground", not a rental cabin): ${campgrounds.join("; ")}`);
  if (outside.length) console.log(`Dropped (outside Montana): ${outside.join("; ")}`);
  log.forEach(l => console.log(l));
  const unresolved = cabins.filter(c => !c.bookUrl);
  if (unresolved.length) console.log(`Unresolved (${unresolved.length}):\n  ${unresolved.map(c => `${c.name} [${c.forest}] — ${c.note || "(no text)"}`).join("\n  ")}`);

  const problems = checkAgainstPrevious(readPreviousCabins(), cabins);
  if (REPORT_ONLY) {
    if (problems.length) { console.log(`WARNING: ${problems.join("; ")} compared with the existing data file`); process.exitCode = 1; }
    return;
  }
  if (problems.length && !process.argv.includes("--force")) {
    problems.forEach(p => console.error(p));
    console.error("Refusing to overwrite app/data/mt-cabins.json (pass --force to override).");
    process.exit(1);
  }
  const payload = {
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: [
      "USDA Forest Service Recreation Opportunities (EDW_RecreationOpportunities_01), activity 'Cabin Rentals'",
      "US Census Bureau TIGERweb state boundary (Montana)",
      "Recreation.gov facility records, Forest Service and BLM (booking links verified against the live site)",
    ],
    count: cabins.length,
    cabins,
  };
  await mkdir(dirname(OUT_FILE), { recursive: true });
  writeFileSync(`${OUT_FILE}.tmp`, `${JSON.stringify(payload, null, 1)}\n`);
  renameSync(`${OUT_FILE}.tmp`, OUT_FILE);
  console.log(`Wrote ${cabins.length} cabins to ${OUT_FILE}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
