#!/usr/bin/env node
/**
 * Nightly Montana claim watch. Reads every BLM mining claim in Montana (open and
 * closed), compares it with the previous night's snapshot, and keeps a rolling list
 * of changes the app shows as "Recently closed in Montana".
 *
 * Usage:   node scripts/mt-claim-watch.mjs --dir <folder> [--force]
 *   Reads and writes <folder>/mt-claims-snapshot.json and <folder>/mt-claim-changes.json.
 *   --force  record changes even when open claims fell by more than 25% overnight
 *            (normally treated as a bad BLM read and refused, so it can't flood the list).
 * Behind an HTTPS proxy:  NODE_USE_ENV_PROXY=1 node scripts/mt-claim-watch.mjs --dir claim-data
 *
 * Run nightly by .github/workflows/mt-claim-watch.yml, which keeps the folder on the
 * `data` branch. The first run only records a baseline; changes appear from the next night.
 * Any failed or incomplete BLM read stops the run without writing anything.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLAIMS_CLOSED_URL, CLAIMS_URL } from "../app/lib/land-status.ts";
import { MONTANA_BBOX } from "../app/lib/claim-markers.ts";
import { fetchMontanaRings, insideRings } from "./build-mt-cabins.mjs";
import { WINDOW_DAYS, checkShrink, diffSnapshots, mergeEvents, toEntries } from "./claim-watch-core.mjs";

const args = process.argv.slice(2);
const dirIndex = args.indexOf("--dir");
if (dirIndex < 0 || !args[dirIndex + 1]) {
  console.error("Usage: node scripts/mt-claim-watch.mjs --dir <folder> [--force]");
  process.exit(2);
}
const DIR = resolve(args[dirIndex + 1]);
const FORCE = args.includes("--force");
const SNAPSHOT_FILE = join(DIR, "mt-claims-snapshot.json");
const CHANGES_FILE = join(DIR, "mt-claim-changes.json");
const FIELDS = "OBJECTID,CSE_NAME,CSE_NR,LEG_CSE_NR,BLM_PROD,CSE_DISP,RCRD_ACRS";
const PAGE_SIZE = 2000; // BLM's maxRecordCount

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** POST an ArcGIS query, retrying network errors, 5xx and ArcGIS error bodies (which arrive as HTTP 200). */
async function query(layerUrl, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${layerUrl}/0/query`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ f: "json", ...params }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`ArcGIS error: ${JSON.stringify(json.error)}`);
      return json;
    } catch (err) {
      if (attempt >= 3) throw new Error(`${layerUrl}: ${err.message}`);
      await sleep(5000 * (attempt + 1));
    }
  }
}

/** Every feature of one BLM claim layer inside Montana's bounding box. Throws if the read comes up short. */
async function fetchLayer(layerUrl, label) {
  const area = { where: "1=1", geometry: MONTANA_BBOX.join(","), geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects" };
  const { count } = await query(layerUrl, { ...area, returnCountOnly: "true" });
  if (!Number.isFinite(count)) throw new Error(`${label}: BLM returned no count`);
  const byId = new Map();
  for (let offset = 0; offset < count + PAGE_SIZE; offset += PAGE_SIZE) {
    const json = await query(layerUrl, {
      ...area, outFields: FIELDS, returnGeometry: "true", outSR: "4326",
      maxAllowableOffset: "0.0005", geometryPrecision: "5", orderByFields: "OBJECTID",
      resultOffset: String(offset), resultRecordCount: String(PAGE_SIZE),
    });
    if (!Array.isArray(json.features)) throw new Error(`${label}: response had no features array`);
    for (const f of json.features) byId.set(f.attributes?.OBJECTID, f);
    if (json.features.length === 0) break;
  }
  // BLM edits records during the day, so allow a sliver of drift between the count and the pages, never a real gap.
  if (byId.size < count * 0.995) throw new Error(`${label}: read ${byId.size} of ${count} records; refusing a partial snapshot`);
  console.log(`${label}: ${byId.size} records in the Montana box (BLM count ${count})`);
  return [...byId.values()];
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function writeAtomic(file, data) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}

async function main() {
  const takenAt = new Date().toISOString();
  const today = takenAt.slice(0, 10);
  const [rings, openFeatures, closedFeatures] = await Promise.all([
    fetchMontanaRings(),
    fetchLayer(CLAIMS_URL, "Open claims"),
    fetchLayer(CLAIMS_CLOSED_URL, "Closed claims"),
  ]);
  const inMontana = ([lon, lat]) => insideRings(lon, lat, rings);
  const open = toEntries(openFeatures, inMontana);
  const closed = toEntries(closedFeatures, inMontana);
  const next = { version: 1, takenAt, notClosed: open.entries, closed: closed.entries };
  const counts = { notClosed: Object.keys(next.notClosed).length, closed: Object.keys(next.closed).length };
  console.log(`Inside Montana: ${counts.notClosed} open, ${counts.closed} closed`);

  const prev = readJson(SNAPSHOT_FILE);
  const prevChanges = readJson(CHANGES_FILE);
  let tonight = [];
  if (prev?.notClosed && prev?.closed) {
    const problem = checkShrink(prev, next);
    if (problem && !FORCE) {
      console.error(`${problem} overnight. That looks like an incomplete BLM read, so nothing was recorded. Re-run with --force if it's real.`);
      process.exit(1);
    }
    tonight = diffSnapshots(prev, next, today, open.shapes);
  } else {
    console.log("No previous snapshot: recording a baseline. Changes start from the next run.");
  }

  const changes = {
    version: 1,
    generatedAt: takenAt,
    trackingSince: prevChanges?.trackingSince ?? today,
    windowDays: WINDOW_DAYS,
    counts,
    events: mergeEvents(Array.isArray(prevChanges?.events) ? prevChanges.events : [], tonight, today),
  };
  mkdirSync(DIR, { recursive: true });
  writeAtomic(SNAPSHOT_FILE, next);
  writeAtomic(CHANGES_FILE, changes);
  const byKind = tonight.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
  console.log(`Tonight: ${JSON.stringify(byKind)}. Events kept (last ${WINDOW_DAYS} days): ${changes.events.length}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
