"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import Geolocation from "ol/Geolocation";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import TileLayer from "ol/layer/Tile";
import ImageLayer from "ol/layer/Image";
import VectorLayer from "ol/layer/Vector";
import XYZ from "ol/source/XYZ";
import ImageArcGISRest from "ol/source/ImageArcGISRest";
import VectorSource from "ol/source/Vector";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import { Circle, Fill, Stroke, Style } from "ol/style";
import "ol/ol.css";
import Attribution from "ol/control/Attribution";
import type BaseLayer from "ol/layer/Base";
import {
  CADASTRAL_URL as CAD, CLAIMS_CLOSED_URL as CLAIMS_CLOSED, CLAIMS_URL as CLAIMS, CLAIM_SHAPES, NHD_FLOWLINE_URL,
  aliquotHalves, arcgisFeatures, buildStakingPacket, checkLandAt, distanceMiles, findBendSpots, landVerdict, offsetByFeet,
  ringAcres, stakeBoxCorners, surveyUnitAt,
  type Attributes, type BendSpot, type ClaimKind, type Half, type LandCheck, type SurveyUnit, type Verdict,
} from "./lib/land-status";

const HALF_LABEL: Record<Half, string> = { N: "N½", S: "S½", E: "E½", W: "W½" };
type StakeSnap = { half: Half; description: string; acres: number };

type Parcel = {
  OwnerName?: string; AddressLine1?: string; CityStateZip?: string;
  GISAcres?: number; PropAccess?: string; PropType?: string;
  TotalValue?: number; PARCELID?: string; CountyName?: string;
  LegalDescriptionShort?: string;
};
type Destination = { display_name: string; lon: string; lat: string };
type Place = {
  id: string; name: string; address: string; lat: number; lon: number; category: string;
};
type MiningClaim = {
  CSE_NAME?: string; CSE_DISP?: string; BLM_PROD?: string; CSE_NR?: string;
  LEG_CSE_NR?: string; RCRD_ACRS?: number; CSE_META?: string;
};
type MineralRecord = {
  id: string; name: string; status: string; url: string; grade: string;
  distanceMiles: number; lon?: number; lat?: number; commodities: string[];
  evidence: "reported-production" | "documented-lead" | "reference-record";
};
type MineralIntel = {
  radiusMiles: number; records: MineralRecord[]; commodities: string[];
  reportedProductionCount: number; leadCount: number; source: string; sourceUrl: string;
};
type NavTab = "explore" | "routes" | "saved" | "more";
type SavedLocation = {
  id: string; label: string; type: "place" | "parcel" | "claim" | "map point";
  lon: number; lat: number;
};
/** Open turn-by-turn directions in Google Maps (Maps URLs need no API key). */
function openDirections(lat: number, lon: number) {
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, "_blank", "noopener");
}

const VERDICT_BG: Record<Verdict["tone"], string> = { unknown: "#7c2d12", no: "#991b1b", ask: "#9a3412", caution: "#0e7490", likely: "#a16207" };
/** Claim-box nudge buttons: label, feet east, feet north. */
const NUDGES: Array<[string, number, number]> = [["⬅️", -100, 0], ["⬆️", 0, 100], ["⬇️", 0, -100], ["➡️", 100, 0]];
const MRDS = "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer";
const GEONAMES = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer";
const TRANSPORTATION = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer";
const REFERENCE_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer";
const HYDRO_LABELS = "https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Esri_Hydro_Reference_Overlay/MapServer";
const money = (n?: number) => n ? `$${n.toLocaleString()}` : "Not listed";


/** Map a BLM MLRS claim record to the fields the panel shows (names checked against the live layer). */
function normClaim(raw: Attributes): MiningClaim {
  const s = (key: string) => (raw[key] == null || raw[key] === "" ? "" : String(raw[key]));
  return {
    CSE_NAME: s("CSE_NAME") || "Unnamed claim",
    CSE_DISP: s("CSE_DISP") || "Not listed",
    BLM_PROD: s("BLM_PROD") || "Mining claim",
    CSE_NR: s("CSE_NR") || s("LEG_CSE_NR") || "N/A",
    LEG_CSE_NR: s("LEG_CSE_NR"),
    RCRD_ACRS: Number(raw.RCRD_ACRS) || undefined,
    CSE_META: s("CSE_META"),
  };
}

export default function Home() {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const vectors = useRef(new VectorSource());
  const overlays = useRef<Record<string, BaseLayer>>({});
  const inspectRef = useRef<((lon: number, lat: number) => void) | null>(null);
  const labelLayers = useRef<Array<ImageLayer<ImageArcGISRest> | TileLayer<XYZ>>>([]);
  const baseLayers = useRef<Record<string, BaseLayer>>({});
  const googleCopyright = useRef<(() => void) | null>(null);
  const inspectSeq = useRef(0);
  const inspectAbort = useRef<AbortController | null>(null);
  const stakeSeq = useRef(0);
  const stakeTimer = useRef<number | undefined>(undefined);
  const [base, setBase] = useState<"usgs" | "topo" | "google">("usgs");
  const [layers, setLayers] = useState(false);
  const [keyOpen, setKeyOpen] = useState(true);
  const [active, setActive] = useState({ closedClaims: true, mvum: true, parcels: false, public: true, easements: false, claims: true, places: true, roads: true, water: true, peaks: true });
  const [parcel, setParcel] = useState<Parcel | null>(null);
  const [parcelOpen, setParcelOpen] = useState(false);
  const [parcelMessage, setParcelMessage] = useState("");
  const [claim, setClaim] = useState<MiningClaim | null>(null);
  const [activeClaimsList, setActiveClaimsList] = useState<MiningClaim[]>([]);
  const [lapsedClaimsList, setLapsedClaimsList] = useState<MiningClaim[]>([]);
  const [copiedDossier, setCopiedDossier] = useState(false);
  const [stakeCorners, setStakeCorners] = useState<Array<[number, number]>>([]);
  const [stakeCenter, setStakeCenter] = useState<{ lon: number; lat: number } | null>(null);
  const [claimKind, setClaimKind] = useState<ClaimKind>("placer");
  const [stakeChecks, setStakeChecks] = useState<Array<{ label: string; verdict: Verdict }> | null>(null);
  const [stakeCopied, setStakeCopied] = useState(false);
  const [stakeSnap, setStakeSnap] = useState<StakeSnap | null>(null);
  const [surveyUnit, setSurveyUnit] = useState<SurveyUnit | null>(null);
  const [surveyStatus, setSurveyStatus] = useState<"idle" | "loading" | "found" | "none" | "error">("idle");
  const [landCheck, setLandCheck] = useState<LandCheck | null>(null);
  const [scanError, setScanError] = useState("");
  const [stakeAngle, setStakeAngle] = useState(0);
  const [aiReport, setAiReport] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [geminiKey, setGeminiKey] = useState(() => typeof window !== "undefined" ? localStorage.getItem("openland-gemini-key") || "" : "");
  const [keyBoxOpen, setKeyBoxOpen] = useState(false);
  const [appMode, setAppMode] = useState<"beginner" | "staker">("beginner");
  const [digSpots, setDigSpots] = useState<Array<BendSpot & { verdict?: Verdict }>>([]);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanResults, setScanResults] = useState<Array<MiningClaim & { lon?: number; lat?: number }>>([]);
  const [claimOpen, setClaimOpen] = useState(false);
  const [minerals, setMinerals] = useState<MineralIntel | null>(null);
  const [mineralsLoading, setMineralsLoading] = useState(false);
  const [mineralsError, setMineralsError] = useState("");
  const [clickedLocation, setClickedLocation] = useState<{ lon: number; lat: number } | null>(null);
  const [query, setQuery] = useState("");
  const [destination, setDestination] = useState<Destination | null>(null);
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [placeResults, setPlaceResults] = useState<Place[]>([]);
  const [searchMessage, setSearchMessage] = useState("");
  const [googleMaps, setGoogleMaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [navTab, setNavTab] = useState<NavTab>("explore");
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("openland-saved-locations") || "[]") as SavedLocation[]; }
    catch { return []; }
  });

  /** Find up to 3 named-stream bends near the tap, then check land status at each spot. */
  async function findDigSpots(lon: number, lat: number, signal: AbortSignal, isCurrent: () => boolean) {
    setDigSpots([]);
    vectors.current.getFeatures().filter(f => f.get("kind") === "digSpot").forEach(f => vectors.current.removeFeature(f));
    try {
      const q = new URLSearchParams({ f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326", spatialRel: "esriSpatialRelIntersects", distance: "500", units: "esriSRUnit_Meter", outFields: "gnis_name,ftype", returnGeometry: "true" });
      const spots = findBendSpots(await arcgisFeatures(`${NHD_FLOWLINE_URL}/query?${q}`, signal), lon, lat);
      if (!isCurrent()) return;
      spots.forEach(s => { const p = new Feature(new Point(fromLonLat([s.lon, s.lat]))); p.set("kind", "digSpot"); vectors.current.addFeature(p); });
      setDigSpots(spots);
      const verdicts: Verdict[] = [];
      // One spot at a time to stay gentle on BLM's server.
      for (const s of spots) verdicts.push(landVerdict((await checkLandAt(s.lon, s.lat, signal)).check));
      if (!isCurrent()) return;
      setDigSpots(spots.map((s, i) => ({ ...s, verdict: verdicts[i] })));
    } catch {
      // No stream data: show no bend suggestions. Nothing here makes a legal claim.
    }
  }
  async function runAiGeologist() {
    if (!clickedLocation) return;
    if (!geminiKey.trim()) { setKeyBoxOpen(true); return; }
    const seq = inspectSeq.current;
    setAiLoading(true); setAiReport(""); setKeyBoxOpen(false);
    try {
      const res = await fetch("/api/ai/prospect", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lon: clickedLocation.lon, lat: clickedLocation.lat,
          mines: (minerals?.records || []).map(m => ({ name: m.name, status: m.status, commodities: m.commodities, distanceMiles: m.distanceMiles, lon: m.lon, lat: m.lat })),
          bends: digSpots.map(s => `${s.name} ~${Math.round(s.turnDeg)}° bend, inside bank ${s.insideSide}, at ${s.lat.toFixed(5)},${s.lon.toFixed(5)}`).join("; "),
          apiKey: geminiKey.trim(),
        }),
      });
      const d = await res.json() as { report?: string; error?: string };
      if (seq === inspectSeq.current) setAiReport(d.report || d.error || "No response");
    } catch { if (seq === inspectSeq.current) setAiReport("AI request failed."); } finally { setAiLoading(false); }
  }
  /** Load USGS MRDS records within 10 miles, nearest first, with their commodities. */
  async function loadMinerals(lon: number, lat: number, signal: AbortSignal, isCurrent: () => boolean) {
    try {
      const siteQuery = new URLSearchParams({
        f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", spatialRel: "esriSpatialRelIntersects", distance: "10",
        units: "esriSRUnit_StatuteMile", outFields: "DEP_ID,SITE_NAME,DEV_STAT,URL,Grade",
        // Fetch everything in range (busy districts exceed 100 records) so "nearest" really is nearest.
        returnGeometry: "true", outSR: "4326", resultRecordCount: "2000",
      });
      const nearby = (await arcgisFeatures(`${MRDS}/0/query?${siteQuery}`, signal)).flatMap(feature => {
        const a = feature.attributes ?? {};
        const id = a.DEP_ID ? String(a.DEP_ID) : "";
        const x = feature.geometry?.x; const y = feature.geometry?.y;
        if (!id || typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return [];
        return [{
          id, name: String(a.SITE_NAME || "Unnamed mineral record"),
          status: String(a.DEV_STAT || "Unknown"),
          url: String(a.URL || `https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${id}`),
          grade: String(a.Grade || "—"),
          distanceMiles: distanceMiles(lat, lon, y, x), lon: x, lat: y }];
      }).sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 20);

      const commodityMap = new globalThis.Map<string, string[]>();
      if (nearby.length) {
        const ids = nearby.map(record => `'${record.id.replace(/'/g, "''")}'`).join(",");
        const commodityQuery = new URLSearchParams({
          f: "json", where: `Record_ID IN (${ids})`,
          outFields: "Record_ID,Commodity_name,Importance", returnGeometry: "false", resultRecordCount: "500",
        });
        try {
          for (const feature of await arcgisFeatures(`${MRDS}/10/query?${commodityQuery}`, signal)) {
            const id = feature.attributes?.Record_ID; const name = feature.attributes?.Commodity_name;
            if (typeof id !== "string" || typeof name !== "string") continue;
            const list = commodityMap.get(id) || [];
            if (!list.includes(name)) list.push(name);
            commodityMap.set(id, list);
          }
        } catch { /* commodities are optional detail */ }
      }
      if (!isCurrent()) return;
      vectors.current.getFeatures().filter(f => f.get("kind") === "mine").forEach(f => vectors.current.removeFeature(f));
      nearby.forEach(r => { const mf = new Feature(new Point(fromLonLat([r.lon, r.lat]))); mf.set("kind", "mine"); vectors.current.addFeature(mf); });
      const records: MineralRecord[] = nearby.slice(0, 8).map(record => ({
        ...record,
        distanceMiles: Number(record.distanceMiles.toFixed(2)),
        commodities: commodityMap.get(record.id) || [],
        evidence: /^(Producer|Past Producer)$/i.test(record.status)
          ? "reported-production"
          : /^(Occurrence|Prospect)$/i.test(record.status) ? "documented-lead" : "reference-record",
      }));
      setMinerals({
        radiusMiles: 10, records,
        commodities: [...new Set(records.flatMap(record => record.commodities))].slice(0, 8),
        reportedProductionCount: records.filter(record => record.evidence === "reported-production").length,
        leadCount: records.filter(record => record.evidence === "documented-lead").length,
        source: "USGS Mineral Resources Data System (MRDS)",
        sourceUrl: "https://mrdata.usgs.gov/mrds/",
      });
    } catch {
      if (isCurrent()) setMineralsError("Public mineral records are temporarily unavailable");
    } finally {
      if (isCurrent()) setMineralsLoading(false);
    }
  }

  /**
   * Draw a claim polygon, then (debounced) re-check land status at its centre and
   * corners and, for a free placer box, look up the BLM survey unit under its centre.
   */
  function showStakeBox(center: { lon: number; lat: number }, corners: Array<[number, number]>, angleDeg: number, kind: ClaimKind, snap: StakeSnap | null) {
    vectors.current.getFeatures().filter(f => f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f));
    const box = new Feature(new LineString([...corners, corners[0]].map(c => fromLonLat(c))));
    box.set("kind", "stakeBox");
    vectors.current.addFeature(box);
    corners.forEach(c => { const pt = new Feature(new Point(fromLonLat(c))); pt.set("kind", "stakeBox"); vectors.current.addFeature(pt); });
    setStakeCenter(center); setStakeAngle(angleDeg); setClaimKind(kind); setStakeCorners(corners); setStakeSnap(snap);
    setStakeChecks(null); setStakeCopied(false);
    if (kind === "placer" && !snap) setSurveyStatus("loading");
    const seq = ++stakeSeq.current;
    window.clearTimeout(stakeTimer.current);
    stakeTimer.current = window.setTimeout(async () => {
      if (kind === "placer" && !snap) {
        try {
          const unit = await surveyUnitAt(center.lon, center.lat);
          if (seq !== stakeSeq.current) return;
          setSurveyUnit(unit); setSurveyStatus(unit ? "found" : "none");
        } catch {
          if (seq === stakeSeq.current) { setSurveyUnit(null); setSurveyStatus("error"); }
        }
      }
      const labels = snap || angleDeg === 0 ? ["Corner NW", "Corner NE", "Corner SE", "Corner SW"] : ["Corner 1", "Corner 2", "Corner 3", "Corner 4"];
      const points: Array<[string, [number, number]]> = [["Centre", [center.lon, center.lat]], ...corners.map((c, i): [string, [number, number]] => [labels[i], c])];
      const results: Array<{ label: string; verdict: Verdict }> = [];
      for (const [label, [lon, lat]] of points) {
        if (seq !== stakeSeq.current) return;
        results.push({ label, verdict: landVerdict((await checkLandAt(lon, lat)).check) });
      }
      if (seq === stakeSeq.current) setStakeChecks(results);
    }, 700);
  }

  /** Free rectangle: centred on `center`, rotated clockwise by `angleDeg`. */
  function redrawStakeBox(center: { lon: number; lat: number }, angleDeg: number, kind: ClaimKind) {
    showStakeBox(center, stakeBoxCorners(center, angleDeg, kind), angleDeg, kind, null);
  }

  /** Snap a 20-acre placer to one half of the BLM quarter-quarter under the box. */
  function snapToHalf(half: Half) {
    if (!surveyUnit || surveyUnit.kind !== "aliquot") return;
    const corners = aliquotHalves(surveyUnit.ring)[half];
    const center = { lon: corners.reduce((s, c) => s + c[0], 0) / 4, lat: corners.reduce((s, c) => s + c[1], 0) / 4 };
    const acres = (surveyUnit.acres ?? ringAcres(surveyUnit.ring)) / 2;
    showStakeBox(center, corners, 0, "placer", { half, description: `${HALF_LABEL[half]} ${surveyUnit.label}`, acres });
  }

  /** Copy the checklist for the box exactly as drawn now (corners, rotation or survey unit, land checks). */
  function copyStakePacket() {
    if (!stakeCenter) return;
    const packet = buildStakingPacket({
      kind: claimKind, center: stakeCenter, angleDeg: stakeAngle, corners: stakeCorners,
      county: parcel?.CountyName, legal: parcel?.LegalDescriptionShort, pointChecks: stakeChecks,
      surveyDescription: stakeSnap?.description, acres: stakeSnap?.acres,
    });
    void navigator.clipboard.writeText(packet)
      .then(() => { setStakeCopied(true); window.setTimeout(() => setStakeCopied(false), 3000); })
      .catch(() => setStakeCopied(false));
  }

  useEffect(() => {
    if (!target.current) return;
    const usgsImagery = new TileLayer({
      source: new XYZ({
        url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 16,
        crossOrigin: "anonymous",
        attributions: "USGS The National Map: Orthoimagery",
      }),
    });
    const naip = new ImageLayer({
      source: new ImageArcGISRest({
        url: "https://gisservice.mt.gov/arcgis/rest/services/MSDI_Framework/msdi_naip2025_provisional_image_v1/ImageServer",
        params: { FORMAT: "jpgpng" },
        attributions: "USDA NAIP 2025 (provisional) via Montana State Library",
      }),
      minZoom: 14,
    });
    const topo = new TileLayer({
      source: new XYZ({
        url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 16,
        crossOrigin: "anonymous",
        attributions: "USGS The National Map",
      }),
      visible: false,
    });
    baseLayers.current = { usgsImagery, naip, topo };
    const cadastralCredit = "Montana State Library (MSDI Cadastral)";
    const blmCredit = "BLM Mineral & Land Records System";
    const publicLand = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:2", FORMAT: "png32" }, attributions: cadastralCredit }), opacity: .5 });
    const easements = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:0", FORMAT: "png32" }, attributions: cadastralCredit }), opacity: .55, visible: false });
    const closedClaims = new ImageLayer({
      className: "ol-layer ol-lapsed-claims",
      source: new ImageArcGISRest({
        url: CLAIMS_CLOSED,
        params: { LAYERS: "show:0", FORMAT: "png32" },
        attributions: blmCredit,
      }),
      opacity: 0.85,
      visible: true,
    });
    const claims = new ImageLayer({
      className: "ol-layer ol-active-claims", source: new ImageArcGISRest({ url: CLAIMS, params: { LAYERS: "show:0", FORMAT: "png32" }, attributions: blmCredit }), opacity: .82 });
    const parcels = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:1", FORMAT: "png32" }, attributions: cadastralCredit }), opacity: .9, minZoom: 9, visible: false });
    const lowZoomReference = new TileLayer({
      source: new XYZ({
        url: `${REFERENCE_LABELS}/tile/{z}/{y}/{x}`,
        maxZoom: 13,
        crossOrigin: "anonymous",
        attributions: "Esri World Reference Overlay",
      }),
      maxZoom: 11,
    });
    const hydroLabels = new TileLayer({
      source: new XYZ({
        url: `${HYDRO_LABELS}/tile/{z}/{y}/{x}`,
        maxZoom: 19,
        crossOrigin: "anonymous",
        attributions: "Esri Hydro Reference Overlay",
      }),
      opacity: .9,
      minZoom: 8,
    });
    const roadLabels = new TileLayer({
      source: new XYZ({
        url: `${TRANSPORTATION}/tile/{z}/{y}/{x}`,
        maxZoom: 23,
        crossOrigin: "anonymous",
        attributions: "Esri World Transportation",
      }),
      minZoom: 6,
    });
    const mvum = new ImageLayer({
      source: new ImageArcGISRest({
        url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer",
        params: { LAYERS: "show:1,2", FORMAT: "png32", TRANSPARENT: true },
        attributions: "USFS Motor Vehicle Use Map",
      }),
      minZoom: 11,
    });
    const geographicNames = new ImageLayer({
      source: new ImageArcGISRest({
        url: GEONAMES,
        params: {
          LAYERS: "show:1,2,3,5,6,7,10",
          FORMAT: "png32",
          TRANSPARENT: true,
          DPI: 144,
        },
        attributions: "USGS Geographic Names Information System",
      }),
      minZoom: 11,
    });
    overlays.current = { closedClaims, parcels, public: publicLand, easements, claims, places: lowZoomReference, water: hydroLabels, roads: roadLabels, mvum, peaks: geographicNames };
    labelLayers.current = [lowZoomReference, hydroLabels, roadLabels, geographicNames];
    const vector = new VectorLayer({
      source: vectors.current,
      style: f => f.get("kind") === "digSpot" ? new Style({ image: new Circle({ radius: 9, fill: new Fill({ color: "#22c55e" }), stroke: new Stroke({ color: "#ffffff", width: 3 }) }), zIndex: 38 }) : f.get("kind") === "mine" ? new Style({ image: new Circle({ radius: 8, fill: new Fill({ color: "#f97316" }), stroke: new Stroke({ color: "#fef08a", width: 3 }) }), zIndex: 34 }) : f.get("kind") === "stakeBox"
        ? new Style({
            stroke: new Stroke({ color: "#facc15", width: 3.5, lineDash: [8, 6] }),
            image: new Circle({ radius: 6, fill: new Fill({ color: "#facc15" }), stroke: new Stroke({ color: "#000", width: 2 }) }),
            zIndex: 35,
          })
        : new Style({ image: new Circle({ radius: 9, fill: new Fill({ color: "#62f3aa" }), stroke: new Stroke({ color: "#fff", width: 4 }) }) }),
    });
    const instance = new Map({
      target: target.current,
      controls: [new Attribution({ collapsible: false })],
      layers: [usgsImagery, naip, topo, publicLand, easements, claims, closedClaims, parcels, lowZoomReference, hydroLabels, roadLabels, mvum, geographicNames, vector],
      view: new View({ center: fromLonLat([-112.035, 46.685]), zoom: 11.2, minZoom: 5, maxZoom: 20 }),
    });
    const runInspect = async (lon: number, lat: number) => {
      // Cancel the previous tap's lookups and ignore any of its late answers.
      inspectAbort.current?.abort();
      const controller = new AbortController();
      inspectAbort.current = controller;
      const seq = ++inspectSeq.current;
      const isCurrent = () => seq === inspectSeq.current;
      stakeSeq.current++;
      window.clearTimeout(stakeTimer.current);

      setNavTab("explore");
      setClickedLocation({ lon, lat });
      setCopiedDossier(false);
      setAiReport("");
      setStakeCorners([]); setStakeCenter(null); setStakeChecks(null); setStakeAngle(0);
      setStakeSnap(null); setSurveyUnit(null); setSurveyStatus("idle");

      vectors.current.getFeatures().filter(f => f.get("kind") === "tap" || f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f));
      const tapPin = new Feature(new Point(fromLonLat([lon, lat])));
      tapPin.set("kind", "tap");
      vectors.current.addFeature(tapPin);

      setParcel(null); setClaim(null); setActiveClaimsList([]); setLapsedClaimsList([]); setLandCheck(null);
      setClaimOpen(false); setParcelOpen(true); setSelectedPlace(null); setPlaceResults([]);
      setParcelMessage("Checking BLM claims and land ownership…");
      setMinerals(null); setMineralsError(""); setMineralsLoading(true);
      void loadMinerals(lon, lat, controller.signal, isCurrent);
      void findDigSpots(lon, lat, controller.signal, isCurrent);

      const { check, parcel: parcelAttrs, publicOwner, active, closed } = await checkLandAt(lon, lat, controller.signal);
      if (!isCurrent()) return;
      const activeList = active.map(normClaim);
      setActiveClaimsList(activeList);
      if (activeList[0]) setClaim(activeList[0]);
      setLapsedClaimsList(closed.map(normClaim));
      setParcel(parcelAttrs
        ? (parcelAttrs as Parcel)
        : { OwnerName: publicOwner || undefined, PropType: publicOwner ? "Public land (no county parcel record)" : "No county parcel record found" });
      setLandCheck(check);
      const checkedAt = new Date(check.checkedAt).toLocaleTimeString();
      setParcelMessage(check.failed.length ? `Some records couldn't be checked · ${checkedAt}` : `BLM + Montana cadastral records · checked ${checkedAt}`);
    };
    inspectRef.current = runInspect;

    instance.on("singleclick", async e => {
      const [lon, lat] = toLonLat(e.coordinate);
      await runInspect(lon, lat);
    });
    map.current = instance;
    void (async () => {
      try {
        const config = await (await fetch("/api/google/config")).json() as { enabled?: boolean; key?: string };
        if (!config.enabled || !config.key) return;
        const key = config.key;
        const satelliteSession = await createGoogleTileSession(key);
        const googleSatellite = new TileLayer({
          source: new XYZ({
            url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${satelliteSession}&key=${key}`,
            crossOrigin: "anonymous",
            maxZoom: 22,
            attributions: "Google Maps",
          }),
          visible: false,
        });
        baseLayers.current = { ...baseLayers.current, google: googleSatellite };
        instance.getLayers().insertAt(3, googleSatellite);
        // Map Tiles API policy: show the copyright string the viewport endpoint returns for this view.
        const updateCopyright = async () => {
          if (!googleSatellite.getVisible()) return;
          const [west, south, east, north] = transformExtent(instance.getView().calculateExtent(instance.getSize()), "EPSG:3857", "EPSG:4326");
          const params = new URLSearchParams({
            session: satelliteSession, key,
            zoom: String(Math.round(instance.getView().getZoom() ?? 0)),
            north: String(Math.min(north, 89.9)), south: String(Math.max(south, -89.9)), east: String(east), west: String(west),
          });
          const res = await fetch(`https://tile.googleapis.com/tile/v1/viewport?${params}`);
          if (!res.ok) return;
          const data = await res.json() as { copyright?: string };
          googleSatellite.getSource()?.setAttributions(data.copyright ? `Google Maps · ${data.copyright}` : "Google Maps");
        };
        googleCopyright.current = () => { void updateCopyright().catch(() => undefined); };
        instance.on("moveend", googleCopyright.current);
        googleCopyright.current();
        setGoogleMaps(true);
      } catch {
        setGoogleMaps(false);
      }
    })();
    return () => { inspectAbort.current?.abort(); window.clearTimeout(stakeTimer.current); instance.setTarget(undefined); map.current = null; };
  }, []);

  useEffect(() => {
    baseLayers.current.usgsImagery?.setVisible(base === "usgs");
    baseLayers.current.naip?.setVisible(base === "usgs");
    baseLayers.current.topo?.setVisible(base === "topo");
    baseLayers.current.google?.setVisible(base === "google");
    googleCopyright.current?.();
  }, [base, googleMaps]);

  
  /** List closed BLM claims in the current view. A failed lookup is shown as a failure, never as "none". */
  async function scanAreaForLapsedClaims() {
    if (!map.current) return;
    setScanOpen(true);
    setScanLoading(true);
    setScanResults([]);
    setScanError("");
    try {
      const ext = map.current.getView().calculateExtent(map.current.getSize());
      const [minLon, minLat] = toLonLat([ext[0], ext[1]]);
      const [maxLon, maxLat] = toLonLat([ext[2], ext[3]]);
      const qp = new URLSearchParams({
        f: "json",
        geometry: `${minLon},${minLat},${maxLon},${maxLat}`,
        geometryType: "esriGeometryEnvelope",
        inSR: "4326",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "*",
        returnGeometry: "true",
        resultRecordCount: "200",
      });
      const features = await arcgisFeatures(`${CLAIMS_CLOSED}/0/query?${qp}`);
      const seen = new Set<string>();
      const items: Array<MiningClaim & { lon?: number; lat?: number }> = [];
      for (const f of features) {
        const c = normClaim(f.attributes ?? {});
        const key = `${c.CSE_NR}-${c.CSE_NAME}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ring = f.geometry?.rings?.[0];
        let lon: number | undefined, lat: number | undefined;
        if (Array.isArray(ring) && ring.length) {
          lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
          lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        }
        items.push({ ...c, lon, lat });
      }
      setScanResults(items);
    } catch {
      setScanError("Couldn't reach BLM's closed-claims service. That is not the same as \"no closed claims\" — try again.");
    } finally {
      setScanLoading(false);
    }
  }

  function toggle(key: keyof typeof active) {
    const next = !active[key];
    setActive(a => ({ ...a, [key]: next }));
    overlays.current[key]?.setVisible(next);
  }

  function locate() {
    if (!map.current) return;
    const geo = new Geolocation({ tracking: true, trackingOptions: { enableHighAccuracy: true }, projection: map.current.getView().getProjection() });
    geo.once("change:position", () => {
      const pos = geo.getPosition(); if (!pos || !map.current) return;
      vectors.current.getFeatures().filter(f => f.get("kind") === "me").forEach(f => vectors.current.removeFeature(f));
      const me = new Feature(new Point(pos)); me.set("kind", "me"); vectors.current.addFeature(me);
      map.current.getView().animate({ center: pos, zoom: 15.5, duration: 650 });
      geo.setTracking(false);
    });
    geo.once("error", () => geo.setTracking(false));
  }

  async function search(e: FormEvent) {
    e.preventDefault(); if (!query.trim() || !map.current) return; setBusy(true); setNavTab("explore"); setSearchMessage("");
    try {
      const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
      if (coords) {
        const lat = Number(coords[1]); const lon = Number(coords[2]);
        if (lat >= 44 && lat <= 49.5 && lon >= -116.5 && lon <= -103.5) {
          setDestination({ display_name: `${lat}, ${lon}`, lat: String(lat), lon: String(lon) });
          setPlaceResults([]); setSelectedPlace(null); setParcelOpen(false); setClaimOpen(false);
          map.current.getView().animate({ center: fromLonLat([lon, lat]), zoom: 15, duration: 700 });
          return;
        }
      }
      const p = new URLSearchParams({ q: query, format: "jsonv2", limit: "5", countrycodes: "us", viewbox: "-116.05,49.0,-104.04,44.36", bounded: "0" });
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${p}`);
        if (!res.ok) throw new Error("Search failed");
        const data = await res.json() as Array<{ place_id: number | string; name?: string; display_name: string; lat: string; lon: string; type?: string; category?: string }>;
        const results: Place[] = data.map(r => ({
          id: String(r.place_id), name: r.name || r.display_name.split(",")[0], address: r.display_name,
          lat: Number(r.lat), lon: Number(r.lon), category: r.type || r.category || "Place",
        }));
        setPlaceResults(results); setSelectedPlace(null); setDestination(null);
        setSearchMessage(results.length ? "" : "No match — try a town, creek, or lat, lon");
      } catch {
        setPlaceResults([]); setSearchMessage("Search unavailable — try again");
      }
      setParcelOpen(false); setClaimOpen(false);
    } finally { setBusy(false); }
  }

  function choosePlace(place: Place) {
    setNavTab("explore");
    setSelectedPlace(place); setPlaceResults([]); 
    setDestination({ display_name: `${place.name}, ${place.address}`, lon: String(place.lon), lat: String(place.lat) });
    map.current?.getView().animate({ center: fromLonLat([place.lon, place.lat]), zoom: 16, duration: 700 });
  }

  function openTab(tab: NavTab) {
    setNavTab(tab); setLayers(false); setParcelOpen(false); setClaimOpen(false); setPlaceResults([]); setSearchMessage("");
  }

  function persistSaved(next: SavedLocation[]) {
    setSavedLocations(next);
    localStorage.setItem("openland-saved-locations", JSON.stringify(next));
  }

  function saveLocation(label: string, type: SavedLocation["type"], lon: number, lat: number) {
    const id = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    const item = { id, label, type, lon, lat };
    persistSaved([item, ...savedLocations.filter(saved => saved.id !== id)].slice(0, 50));
  }

  function saveCurrentDestination() {
    if (!destination) return;
    saveLocation(selectedPlace?.name || destination.display_name.split(",").slice(0, 2).join(","), selectedPlace ? "place" : "map point", +destination.lon, +destination.lat);
  }

  function selectSaved(item: SavedLocation) {
    setDestination({ display_name: item.label, lon: String(item.lon), lat: String(item.lat) });
    setSelectedPlace(null);  setNavTab("explore");
    map.current?.getView().animate({ center: fromLonLat([item.lon, item.lat]), zoom: 16, duration: 650 });
  }

  function clearMap() {
    setDestination(null); setSelectedPlace(null); setNavTab("explore");
  }

  return <main className="shell">
    <div ref={target} className="map" />

    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {/* Knocks out bright interior fill (alpha -> 0) and keeps only border lines in Hot Pink (#ff00b7) */}
        <filter id="pink-border-only" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="
            0 0 0 0 1.0
            0 0 0 0 0.0
            0 0 0 0 0.72
            -1.6 -1.6 -1.6 3.9 0
          " />
        </filter>
        {/* Knocks out bright interior fill (alpha -> 0) and keeps only border lines in Electric Cyan (#06b6d4) */}
        <filter id="cyan-border-only" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="
            0 0 0 0 0.02
            0 0 0 0 0.85
            0 0 0 0 0.98
            -1.6 -1.6 -1.6 3.9 0
          " />
        </filter>
      </defs>
    </svg>
    <style>{`
      .ol-active-claims canvas {
        filter: url(#pink-border-only) drop-shadow(0 0 1.5px #ff00b7);
      }
      .panel.parcel { top: 118px !important; bottom: 88px !important; max-height: calc(100vh - 208px) !important; width: 355px !important; }
      .ol-lapsed-claims canvas {
        filter: url(#cyan-border-only) drop-shadow(0 0 2px #06b6d4);
      }
    `}</style>

    {scanOpen && (
      <div style={{
        position: "absolute", top: "112px", left: "14px", zIndex: 28, width: "330px", maxHeight: "65vh",
        background: "rgba(15, 23, 42, 0.96)", backdropFilter: "blur(12px)", color: "#fff",
        borderRadius: "14px", border: "1px solid #06b6d4", boxShadow: "0 20px 40px rgba(0,0,0,0.7)",
        display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif"
      }}>
        <div style={{ padding: "10px 14px", background: "linear-gradient(90deg, #0e7490, #1e293b)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: "12px", letterSpacing: "0.4px" }}>CLOSED BLM CLAIMS IN THIS VIEW ({scanResults.length})</strong>
          <button onClick={() => setScanOpen(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: "16px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
          {scanLoading && <div style={{ fontSize: "12px", color: "#94a3b8", padding: "12px" }}>Checking BLM&apos;s closed-claim records for this view…</div>}
          {scanError && <div style={{ fontSize: "12px", color: "#fca5a5", padding: "12px" }}>{scanError}</div>}
          {!scanLoading && !scanError && scanResults.length === 0 && (
            <div style={{ fontSize: "12px", color: "#94a3b8", padding: "12px" }}>{"No closed claims in BLM's mapped records for this view. BLM's closed-claim map covers only a small set of recent closures, so this doesn't mean the ground is open."}</div>
          )}
          {scanResults.map((item, idx) => (
            <div key={idx} onClick={() => {
              if (item.lon && item.lat && map.current) {
                setScanOpen(false);
                map.current.getView().animate({ center: fromLonLat([item.lon, item.lat]), zoom: 14.2, duration: 600 });
                inspectRef.current?.(item.lon, item.lat);
              }
            }} style={{
              background: "rgba(255,255,255,0.06)", padding: "8px 10px", borderRadius: "8px",
              borderLeft: "3px solid #06b6d4", cursor: "pointer"
            }}>
              <div style={{ fontWeight: 800, fontSize: "13px", color: "#38bdf8" }}>{item.CSE_NAME}</div>
              <div style={{ fontSize: "11px", color: "#cbd5e1", marginTop: "2px" }}>
                Serial: <b>{item.CSE_NR}</b> · {item.BLM_PROD} {item.RCRD_ACRS ? `· ${item.RCRD_ACRS} ac` : ""}
              </div>
              <div style={{ fontSize: "10px", color: "#fbbf24", marginTop: "3px" }}>➜ Tap to zoom here & inspect BLM status</div>
            </div>
          ))}
        </div>
      </div>
    )}

    {/* ===== 1-TAP MONTANA GOLD & SAPPHIRE HOTSPOTS BAR ===== */}
    <div style={{
      position: "absolute",
      top: "74px",
      left: "14px",
      right: "295px",
      zIndex: 24,
      display: "flex",
      gap: "6px",
      overflowX: "auto",
      paddingBottom: "4px",
      scrollbarWidth: "none"
    }}>
            <button
        onClick={scanAreaForLapsedClaims}
        style={{
          background: "linear-gradient(135deg, #06b6d4, #0284c7)",
          color: "#ffffff",
          border: "1px solid #67e8f9",
          borderRadius: "999px",
          padding: "6px 14px",
          fontSize: "11px",
          fontWeight: 800,
          whiteSpace: "nowrap",
          cursor: "pointer",
          boxShadow: "0 4px 14px rgba(6, 182, 212, 0.5)"
        }}
      >
        🔎 Scan view for closed claims
      </button>
      <button onClick={() => setAppMode(appMode === "beginner" ? "staker" : "beginner")} style={{ background: appMode === "beginner" ? "linear-gradient(135deg, #16a34a, #15803d)" : "linear-gradient(135deg, #eab308, #ca8a04)", color: appMode === "beginner" ? "#fff" : "#000", border: "1px solid #fff", borderRadius: "999px", padding: "6px 14px", fontSize: "11px", fontWeight: 900, whiteSpace: "nowrap", cursor: "pointer" }}>{appMode === "beginner" ? "🪣 Mode: Beginner Panning (Tap for Staker)" : "📐 Mode: Claim Staker & Flipper (Tap for Beginner)"}</button>
      {[
        { label: "💎 Hauser Lake (Sapphires)", lon: -111.885, lat: 46.662, z: 12.8 },
        { label: "🪙 Marysville (Gold)", lon: -112.302, lat: 46.748, z: 13.2 },
        { label: "🪙 Confederate Gulch (Gold)", lon: -111.535, lat: 46.545, z: 13.0 },
        { label: "💎 Elliston (Quartz/Gold)", lon: -112.432, lat: 46.525, z: 13.0 },
        { label: "🪙 Virginia City (Alder Gulch)", lon: -111.945, lat: 45.293, z: 13.0 },
        { label: "💎 Philipsburg (Sapphires)", lon: -113.485, lat: 46.185, z: 12.8 }
      ].map(spot => (
        <button
          key={spot.label}
          onClick={() => map.current?.getView().animate({ center: fromLonLat([spot.lon, spot.lat]), zoom: spot.z, duration: 750 })}
          style={{
            background: "rgba(15, 23, 42, 0.9)",
            backdropFilter: "blur(10px)",
            color: "#f8fafc",
            border: "1px solid rgba(255,255,255,0.2)",
            borderRadius: "999px",
            padding: "6px 12px",
            fontSize: "11px",
            fontWeight: 700,
            whiteSpace: "nowrap",
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)"
          }}
        >
          {spot.label}
        </button>
      ))}
    </div>


    {/* ===== KID-PROOF FLOATING INTERACTIVE MAP KEY ===== */}
    {!layers && <div style={{
      position: "absolute",
      top: "74px",
      right: "14px",
      zIndex: 25,
      width: keyOpen ? "270px" : "130px",
      background: "rgba(15, 23, 42, 0.94)",
      backdropFilter: "blur(12px)",
      color: "#ffffff",
      borderRadius: "14px",
      border: "1px solid rgba(255, 255, 255, 0.18)",
      boxShadow: "0 20px 35px -5px rgba(0,0,0,0.6)",
      fontFamily: "system-ui, -apple-system, sans-serif",
      overflow: "hidden",
      transition: "all 0.2s ease"
    }}>
      {/* Header bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 14px",
        background: "rgba(255, 255, 255, 0.08)",
        borderBottom: keyOpen ? "1px solid rgba(255,255,255,0.12)" : "none",
        cursor: "pointer"
      }} onClick={() => setKeyOpen(!keyOpen)}>
        <span style={{ fontWeight: 800, fontSize: "12px", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: "6px" }}>
          🗺️ MAP KEY
        </span>
        <button style={{
          background: "rgba(255,255,255,0.15)",
          border: "none",
          color: "#fff",
          borderRadius: "6px",
          padding: "2px 8px",
          fontSize: "11px",
          fontWeight: 700,
          cursor: "pointer"
        }}>
          {keyOpen ? "Hide —" : "Show +"}
        </button>
      </div>

      {keyOpen && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: "12px", maxHeight: "75vh", overflowY: "auto" }}>
          
          {/* SECTION 1: WHAT CAN I CLAIM? */}
          <div>
            <div style={{ fontSize: "10px", fontWeight: 800, color: "#94a3b8", letterSpacing: "1px", marginBottom: "8px" }}>
              💎 CAN I STAKE A CLAIM HERE?
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {/* 1. Open BLM Land */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "6px 8px", borderRadius: "8px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                  <span style={{ width: "14px", height: "14px", background: "#f59e0b", borderRadius: "3px", border: "1px solid #fff", flexShrink: 0 }} />
                  <span>
                    <strong style={{ color: "#fbbf24" }}>Open BLM Land</strong>
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>Often open to claims — verify</small>
                  </span>
                </span>
                <input type="checkbox" checked={active.public} onChange={() => toggle("public")} style={{ accentColor: "#f59e0b", width: "16px", height: "16px", cursor: "pointer" }} />
              </label>

              {/* 2. Active Claims */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "6px 8px", borderRadius: "8px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                  <span style={{ width: "14px", height: "14px", background: "#ff00b7", borderRadius: "3px", border: "1px solid #fff", flexShrink: 0 }} />
                  <span>
                    <strong style={{ color: "#f472b6" }}>Already Taken</strong>
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>🛑 Claimed — don&apos;t dig without permission</small>
                  </span>
                </span>
                <input type="checkbox" checked={active.claims} onChange={() => toggle("claims")} style={{ accentColor: "#ff00b7", width: "16px", height: "16px", cursor: "pointer" }} />
              </label>

              {/* 3. Lapsed Claims */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "6px 8px", borderRadius: "8px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                  <span style={{ width: "14px", height: "14px", background: "#06b6d4", borderRadius: "3px", border: "1px solid #fff", flexShrink: 0 }} />
                  <span>
                    <strong style={{ color: "#38bdf8" }}>Closed Claims</strong>
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>Closed — research before restaking</small>
                  </span>
                </span>
                <input type="checkbox" checked={active.closedClaims} onChange={() => toggle("closedClaims")} style={{ accentColor: "#06b6d4", width: "16px", height: "16px", cursor: "pointer" }} />
              </label>

              {/* 4. Private Property */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "6px 8px", borderRadius: "8px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                  <span style={{ width: "14px", height: "14px", background: "#ff8800", borderRadius: "3px", border: "1px solid #fff", flexShrink: 0 }} />
                  <span>
                    <strong style={{ color: "#fb923c" }}>Private Land</strong>
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>🏠 Houses & private yards</small>
                  </span>
                </span>
                <input type="checkbox" checked={active.parcels} onChange={() => toggle("parcels")} style={{ accentColor: "#ff8800", width: "16px", height: "16px", cursor: "pointer" }} />
              </label>
            </div>
          </div>

          {/* SECTION 2: MAP FEATURES (TOUCH TO HIDE) */}
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: "10px" }}>
            <div style={{ fontSize: "10px", fontWeight: 800, color: "#94a3b8", letterSpacing: "1px", marginBottom: "8px" }}>
              🏷️ MAP LABELS & ROADS
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px" }}>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "5px 7px", borderRadius: "6px", fontSize: "11px" }}>
                <span>🛣️ Roads</span>
                <input type="checkbox" checked={active.roads} onChange={() => toggle("roads")} style={{ accentColor: "#ff9f43" }} />
              </label>

              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "5px 7px", borderRadius: "6px", fontSize: "11px" }}>
                <span>🚙 Legal FS roads</span>
                <input type="checkbox" checked={active.mvum} onChange={() => toggle("mvum")} style={{ accentColor: "#a3e635" }} />
              </label>

              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "5px 7px", borderRadius: "6px", fontSize: "11px" }}>
                <span>🌊 Waters</span>
                <input type="checkbox" checked={active.water} onChange={() => toggle("water")} style={{ accentColor: "#54a0ff" }} />
              </label>

              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "5px 7px", borderRadius: "6px", fontSize: "11px" }}>
                <span>⛰️ Peaks</span>
                <input type="checkbox" checked={active.peaks} onChange={() => toggle("peaks")} style={{ accentColor: "#1dd1a1" }} />
              </label>

              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "5px 7px", borderRadius: "6px", fontSize: "11px" }}>
                <span>🏙️ Towns</span>
                <input type="checkbox" checked={active.places} onChange={() => toggle("places")} style={{ accentColor: "#ffffff" }} />
              </label>
            </div>
          </div>

        </div>
      )}
    </div>
    } {/* ===== END MAP KEY ===== */}

    {/* eslint-disable-next-line @next/next/no-img-element */}
    {base === "google" && <img src="https://www.gstatic.com/images/branding/productlogos/maps_2025/v1/192px.svg" alt="Google Maps" style={{ position: "absolute", left: "12px", bottom: "92px", height: "22px", zIndex: 6 }} />}

    <header>
      <b className="logo">OL</b>
      <form onSubmit={search}><span>⌕</span><input aria-label="Search" placeholder="Where to? Address, place or coordinates" value={query} onChange={e => setQuery(e.target.value)} /><button>{busy ? "…" : "Go"}</button></form>
      <button className="icon" aria-label="Layers" onClick={() => { setNavTab("explore"); setLayers(v => !v); }}>▱</button>
    </header>
    <div className="live"><i/> LIVE PUBLIC DATA · MONTANA · {base === "usgs" ? "USGS IMAGERY" : base === "topo" ? "USGS TOPO" : "GOOGLE MAPS"}</div>
    <div className="tools"><button aria-label="My location" onClick={locate}>⌾</button><button aria-label="Zoom in" onClick={() => map.current?.getView().adjustZoom(1)}>＋</button><button aria-label="Zoom out" onClick={() => map.current?.getView().adjustZoom(-1)}>−</button></div>

    {layers && <aside className="panel layer-panel">
      <div className="panel-title"><div><small>MAP DISPLAY</small><h2>Layers</h2></div><button onClick={() => setLayers(false)}>×</button></div>
      <div className="bases">
        <button className={base === "usgs" ? "selected sat" : "sat"} onClick={() => setBase("usgs")}><b>Satellite</b><span>USGS + 2025 NAIP</span></button>
        <button className={base === "topo" ? "selected streets" : "streets"} onClick={() => setBase("topo")}><b>Topo</b><span>USGS contours</span></button>
        {googleMaps && <button className={base === "google" ? "selected sat" : "sat"} onClick={() => setBase("google")}><b>Google</b><span>Satellite</span></button>}
      </div>
      <h3>MAP REFERENCE</h3>
      <Layer color="#ffffff" title="Cities & towns" sub="Towns, places & county labels" on={active.places} click={() => toggle("places")} />
      <Layer color="#ff9f43" title="Roads & highways" sub="Interstates, highways & road numbers" on={active.roads} click={() => toggle("roads")} />
      <Layer color="#54a0ff" title="Rivers, creeks & lakes" sub="Waterways, ditches & reservoirs" on={active.water} click={() => toggle("water")} />
      <Layer color="#a3e635" title="Forest roads open to vehicles" sub="USFS Motor Vehicle Use Map — roads & trails legal to drive" on={active.mvum} click={() => toggle("mvum")} />
      <Layer color="#1dd1a1" title="Peaks, mountains & gulches" sub="Summits, mountain ranges & canyons" on={active.peaks} click={() => toggle("peaks")} />
      <h3>LAND INTELLIGENCE</h3>
      <Layer color="#ff8800" title="Private Property" sub="Orange grid · Private land (not claimable)" on={active.parcels} click={() => toggle("parcels")} />
      <Layer color="#f59e0b" title="Public Lands" sub="Yellow = BLM · Green = USFS · Blue = State (pale yellow = Reclamation, darker green = Fish & Wildlife)" on={active.public} click={() => toggle("public")} />
      <Layer color="#06b6d4" title="Closed Claims" sub="Cyan · Closed in BLM records — research before restaking" on={active.closedClaims} click={() => toggle("closedClaims")} />
      <Layer color="#ff00b7" title="Active Mining Claims" sub="Pink areas · Staked claims recorded with BLM" on={active.claims} click={() => toggle("claims")} />
      <Layer color="#a855f7" title="Conservation Easements" sub="Purple areas · Protected land" on={active.easements} click={() => toggle("easements")} />
      <div className="legend" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", fontSize: "11px", marginTop: "12px", background: "rgba(0,0,0,0.3)", padding: "10px", borderRadius: "8px" }}>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#f59e0b", borderRadius: "2px", marginRight: "6px" }}/><b>Yellow:</b> BLM</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#06b6d4", borderRadius: "2px", marginRight: "6px" }}/><b>Cyan:</b> Lapsed Claims</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#ff00b7", borderRadius: "2px", marginRight: "6px" }}/><b>Pink:</b> Active Claims</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#38bdf8", borderRadius: "2px", marginRight: "6px" }}/><b>Blue:</b> State (No Staking)</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#22c55e", borderRadius: "2px", marginRight: "6px" }}/><b>Green:</b> US Forest Service</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#ff8800", borderRadius: "2px", marginRight: "6px" }}/><b>Orange:</b> Private Property</span>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#a855f7", borderRadius: "2px", marginRight: "6px" }}/><b>Purple:</b> Easements</span>
      </div>
      <p className="warning">Reference data only—not a legal survey. Mining claims do not establish surface ownership or public access.</p>
    </aside>}

    {claimOpen && claim && <aside className="panel parcel claim-card">
      <button className="close" onClick={() => setClaimOpen(false)}>×</button>
      <small>ACTIVE FEDERAL MINING CLAIM · BLM MLRS</small>
      <h2>{claim.CSE_NAME || "Unnamed mining claim"}</h2>
      <p>{claim.BLM_PROD || "Mining claim"}<br/>Serial: {claim.CSE_NR || claim.LEG_CSE_NR || "Not listed"}</p>
      <strong className="access claim-status">● {claim.CSE_DISP || "ACTIVE"}</strong>
      <div className="facts">
        <div><span>CLAIM ACRES</span><b>{claim.RCRD_ACRS?.toFixed(2) || "—"}</b></div>
        <div><span>CLAIM TYPE</span><b>{claim.BLM_PROD || "—"}</b></div>
        <div><span>BLM MAPPED TO</span><b>{claim.CSE_META?.split("|")[0] || "—"}</b></div>
      </div>
      {clickedLocation && <button className="panel-save" onClick={() => saveLocation(claim.CSE_NAME || "Selected mining claim", "claim", clickedLocation.lon, clickedLocation.lat)}>☆ Save claim</button>}
      {clickedLocation && <button className="panel-route" onClick={() => openDirections(clickedLocation.lat, clickedLocation.lon)}>Directions in Google Maps ➜</button>}
      <p className="record-note">BLM commonly maps claims to the affected PLSS quarter-section. Staked claim boundaries may differ from this display.</p>
    </aside>}

    {parcelOpen && <aside className="panel parcel">
      <button className="close" onClick={() => setParcelOpen(false)}>×</button><small>{parcelMessage}</small>
      {(() => {
        const verdict = landCheck ? landVerdict(landCheck) : null;
        const bg = verdict ? VERDICT_BG[verdict.tone] : "#334155";
        const badge = verdict?.badge ?? "🔍 CHECKING CLAIMS & OWNERSHIP…";
        const claimNames = (list: MiningClaim[]) => list.slice(0, 3).map(c => `${c.CSE_NAME} (${c.CSE_NR})`).join(", ");
        const msg = verdict
          ? [verdict.detail, activeClaimsList.length ? `Active: ${claimNames(activeClaimsList)}.` : "", lapsedClaimsList.length ? `Closed on file: ${claimNames(lapsedClaimsList)}.` : ""].filter(Boolean).join(" ")
          : "Checking BLM claims and Montana land records…";
        return (
          <div style={{ background: bg, padding: "12px", borderRadius: "10px", marginTop: "8px", marginBottom: "10px", color: "#fff", border: "1px solid rgba(255,255,255,0.25)" }}>
            <div style={{ fontWeight: 900, fontSize: "12px", letterSpacing: "0.4px", marginBottom: "4px" }}>{badge}</div>
            <div style={{ fontSize: "12px", lineHeight: "1.4", opacity: 0.95 }}>{msg}</div>
            {verdict?.tone === "unknown" && clickedLocation && (
              <button onClick={() => inspectRef.current?.(clickedLocation.lon, clickedLocation.lat)} style={{ marginTop: "8px", width: "100%", background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: "6px", padding: "6px 10px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>↻ Re-check this spot</button>
            )}
            {clickedLocation && (
              <button onClick={() => {
                const text = [
                  "=== MONTANA PROSPECTOR TARGET DOSSIER ===",
                  `GPS: ${clickedLocation.lat.toFixed(5)}, ${clickedLocation.lon.toFixed(5)} (https://www.google.com/maps?q=${clickedLocation.lat},${clickedLocation.lon})`,
                  `Verdict: ${badge}`,
                  `Summary: ${msg}`,
                  `Surface Owner: ${parcel?.OwnerName || "Unknown"} (${parcel?.GISAcres?.toFixed(1) || "—"} acres, ${parcel?.CountyName || "—"} County)`,
                  `Legal: ${parcel?.LegalDescriptionShort || "—"}`,
                  `Active Claims (${activeClaimsList.length}): ${activeClaimsList.map(c => `${c.CSE_NAME} [#${c.CSE_NR || c.LEG_CSE_NR}, ${c.RCRD_ACRS || "?"} ac]`).join("; ") || "NONE"}`,
                  `Lapsed/Closed Claims (${lapsedClaimsList.length}): ${lapsedClaimsList.slice(0, 8).map(c => `${c.CSE_NAME} [#${c.CSE_NR || c.LEG_CSE_NR}, ${c.RCRD_ACRS || "?"} ac]`).join("; ") || "NONE"}`,
                  `USGS Nearby Minerals (10mi): ${minerals?.commodities?.join(", ") || "None listed"} (${minerals?.reportedProductionCount || 0} past producers)`
                ].join("\n");
                navigator.clipboard.writeText(text);
                setCopiedDossier(true);
                setTimeout(() => setCopiedDossier(false), 3000);
              }} style={{ marginTop: "8px", width: "100%", background: "rgba(0,0,0,0.35)", color: "#fff", border: "1px solid rgba(255,255,255,0.3)", borderRadius: "6px", padding: "6px 10px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>
                {copiedDossier ? "✅ Copied Target Dossier to Clipboard!" : "📋 Copy Prospector Target Dossier"}
              </button>
            )}
            {clickedLocation && (
              <div style={{ marginTop: "8px", background: "rgba(30, 27, 75, 0.85)", padding: "9px", borderRadius: "8px", border: "1px solid #818cf8" }}>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button onClick={runAiGeologist} style={{ flex: 1, background: "linear-gradient(135deg, #6366f1, #4f46e5)", color: "#fff", border: "1px solid #a5b4fc", borderRadius: "6px", padding: "7px 10px", fontSize: "11px", fontWeight: 900, cursor: "pointer" }}>
                    {aiLoading ? "🤖 Analyzing Aerial Photo & USGS Elevations…" : "🤖 Ask AI Geologist (Vision + Elevation)"}
                  </button>
                  <button onClick={() => setKeyBoxOpen(!keyBoxOpen)} title="Set Gemini API Key" style={{ background: "rgba(255,255,255,0.1)", border: "1px solid #818cf8", color: "#fff", borderRadius: "6px", padding: "0 8px", cursor: "pointer" }}>🔑</button>
                </div>
                {keyBoxOpen && (
                  <div style={{ marginTop: "6px", display: "flex", gap: "4px" }}>
                    <input type="password" placeholder="Paste Gemini Key (AIza...)" value={geminiKey} onChange={e => { setGeminiKey(e.target.value); localStorage.setItem("openland-gemini-key", e.target.value); }} style={{ flex: 1, background: "#0f172a", color: "#fff", border: "1px solid #818cf8", borderRadius: "4px", padding: "5px", fontSize: "11px" }} />
                    <button onClick={runAiGeologist} style={{ background: "#22c55e", color: "#000", border: "none", borderRadius: "4px", padding: "5px 8px", fontSize: "11px", fontWeight: 800, cursor: "pointer" }}>Go</button>
                  </div>
                )}
                {aiReport && <div style={{ marginTop: "8px", fontSize: "11px", lineHeight: "1.45", color: "#e0e7ff", whiteSpace: "pre-wrap", maxHeight: "240px", overflowY: "auto", background: "rgba(0,0,0,0.4)", padding: "8px", borderRadius: "6px" }}>{aiReport}{"\n\n— AI description of the photo and nearby records. Not a legal opinion or an assay."}</div>}
              </div>
            )}
            {digSpots.length > 0 && (
              <div style={{ marginTop: "8px", background: "rgba(20, 83, 45, 0.85)", padding: "9px", borderRadius: "8px", border: "1px solid #4ade80" }}>
                <div style={{ fontSize: "10px", fontWeight: 900, color: "#86efac", marginBottom: "4px" }}>
                  🟢 CREEK-BEND CANDIDATES (USGS STREAM LINES — A MAP GUESS, NOT A GOLD GUARANTEE)
                </div>
                <div style={{ fontSize: "10px", color: "#dcfce7", marginBottom: "6px" }}>
                  Each spot gets its own land check. Only dig where it says likely open, and look for claim posts first.
                </div>
                {digSpots.map((s, i) => (
                  <div key={`${s.lat},${s.lon}`} onClick={() => map.current?.getView().animate({ center: fromLonLat([s.lon, s.lat]), zoom: 17.2, duration: 600 })} style={{ background: "rgba(0,0,0,0.35)", padding: "6px 8px", borderRadius: "6px", marginTop: "4px", cursor: "pointer", borderLeft: "3px solid #22c55e" }}>
                    <div style={{ fontWeight: 800, fontSize: "11px", color: "#4ade80" }}>🪣 Spot #{i + 1}: {s.name}, ~{Math.round(s.turnDeg)}° bend (tap to zoom)</div>
                    <div style={{ fontSize: "10px", color: "#f1f5f9", marginTop: "2px" }}>Water slows on the inside of a bend, so gold can drop out on the inside gravel bar. Here the inside bank is the {s.insideSide} side. Try the upstream end of that bar, down to clay or bedrock.</div>
                    <div style={{ fontSize: "10px", fontWeight: 800, marginTop: "3px", color: !s.verdict ? "#fde68a" : s.verdict.panning === "likely" ? "#86efac" : "#fca5a5" }}>{s.verdict ? s.verdict.short : "Checking land status…"}</div>
                    <div style={{ fontSize: "9px", color: "#fde047", fontFamily: "monospace", marginTop: "2px" }}>GPS (mapped channel line): {s.lat.toFixed(5)}, {s.lon.toFixed(5)}</div>
                  </div>
                ))}
              </div>
            )}
            {clickedLocation && (
              <button onClick={() => {
                const center = stakeCenter ?? clickedLocation;
                redrawStakeBox(center, stakeAngle, claimKind);
                map.current?.getView().animate({ center: fromLonLat([center.lon, center.lat]), zoom: 15.8, duration: 600 });
              }} style={{ marginTop: "6px", width: "100%", background: "linear-gradient(135deg, #eab308, #ca8a04)", color: "#0f172a", border: "1px solid #fef08a", borderRadius: "6px", padding: "7px 10px", fontSize: "11px", fontWeight: 900, cursor: "pointer" }}>
                📐 Draw 20-acre claim box & check its corners
              </button>
            )}
            {minerals && minerals.records.length > 0 && <div style={{ marginTop: "8px", background: "rgba(15,23,42,0.7)", padding: "8px", borderRadius: "8px", border: "1px solid #f97316" }}><div style={{ fontSize: "10px", fontWeight: 800, color: "#fdba74", marginBottom: "4px" }}>🟠 NEARBY USGS MINES (TAP 🎯 TO SNAP TO SHAFT):</div>{minerals.records.slice(0, 4).map(r => <button key={r.id} onClick={() => { if (r.lon && r.lat) { map.current?.getView().animate({ center: fromLonLat([r.lon, r.lat]), zoom: 15.8, duration: 600 }); inspectRef.current?.(r.lon, r.lat); } }} style={{ width: "100%", marginTop: "4px", background: "rgba(249,115,22,0.22)", border: "1px solid #f97316", color: "#fff", borderRadius: "5px", padding: "5px 8px", fontSize: "11px", fontWeight: 700, cursor: "pointer", display: "flex", justifyContent: "space-between" }}><span>🎯 {r.name} ({r.commodities.slice(0, 2).join(", ") || r.status})</span><span>{r.distanceMiles < 0.1 ? "HERE!" : r.distanceMiles.toFixed(1) + " mi"}</span></button>)}</div>}
            {stakeCenter && stakeCorners.length > 0 && (
              <div style={{ marginTop: "8px", background: "rgba(0,0,0,0.45)", padding: "8px", borderRadius: "6px", fontSize: "10px", fontFamily: "monospace", border: "1px solid #facc15" }}>
                <div style={{ color: "#facc15", fontWeight: 800, marginBottom: "6px", display: "flex", justifyContent: "space-between", gap: "6px" }}>
                  <span>📐 {stakeSnap ? `Placer snapped: ${stakeSnap.description} (≈${stakeSnap.acres.toFixed(2)} ac)` : `${CLAIM_SHAPES[claimKind].label} · ${stakeAngle}°`}</span>
                  {!stakeSnap && <span style={{ display: "flex", gap: "3px" }}>{NUDGES.map(([label, eastFt, northFt]) => <button key={label} title="Move the box 100 ft" onClick={() => redrawStakeBox(offsetByFeet(stakeCenter, eastFt, northFt), stakeAngle, claimKind)} style={{ background: "#334155", border: "1px solid #facc15", borderRadius: "4px", padding: "1px 5px", cursor: "pointer", fontSize: "10px" }}>{label}</button>)}</span>}
                </div>
                <div style={{ display: "flex", gap: "4px", marginBottom: "6px" }}>
                  {(["placer", "lode"] as const).map(kind => <button key={kind} onClick={() => redrawStakeBox(stakeCenter, stakeSnap ? 0 : stakeAngle, kind)} style={{ flex: 1, background: claimKind === kind ? "#facc15" : "#334155", color: claimKind === kind ? "#0f172a" : "#fff", border: "1px solid #facc15", borderRadius: "4px", padding: "3px", cursor: "pointer", fontSize: "10px", fontWeight: 800 }}>{kind === "placer" ? "Placer (loose gravel)" : "Lode (vein in rock)"}</button>)}
                </div>
                {claimKind === "placer" && (
                  <div style={{ marginBottom: "6px", fontFamily: "system-ui, sans-serif", color: "#e2e8f0", background: "rgba(250,204,21,0.08)", padding: "6px", borderRadius: "4px" }}>
                    {stakeSnap ? (
                      <>Snapped to the BLM survey grid. Verify the description on the official BLM plat. <button onClick={() => redrawStakeBox(stakeCenter, 0, "placer")} style={{ marginLeft: "4px", background: "#334155", color: "#fff", border: "1px solid #facc15", borderRadius: "4px", padding: "1px 6px", cursor: "pointer", fontSize: "10px" }}>Unsnap (free box)</button></>
                    ) : surveyStatus === "loading" ? "Looking up the BLM survey grid…"
                      : surveyStatus === "error" ? "Couldn't reach BLM's survey grid. Draw the box again to retry."
                      : surveyStatus === "none" ? "No BLM survey unit found here. The land may be unsurveyed, where a metes-and-bounds placer (free box) is allowed."
                      : surveyStatus === "found" && surveyUnit?.kind === "aliquot" ? (
                        <>
                          <div>BLM survey unit here: <b>{surveyUnit.label}</b>{surveyUnit.acres ? ` (${surveyUnit.acres} ac)` : ""}. On surveyed land a placer should follow this grid (43 CFR 3832.12). Snap a 20-acre placer to:</div>
                          <div style={{ display: "flex", gap: "4px", marginTop: "4px" }}>{(["N", "S", "E", "W"] as const).map(half => <button key={half} onClick={() => snapToHalf(half)} style={{ flex: 1, background: "#facc15", color: "#0f172a", border: "none", borderRadius: "4px", padding: "3px", cursor: "pointer", fontSize: "10px", fontWeight: 900 }}>{HALF_LABEL[half]}</button>)}</div>
                        </>
                      )
                      : surveyStatus === "found" && surveyUnit ? `BLM survey unit here: ${surveyUnit.label}${surveyUnit.acres ? ` (${surveyUnit.acres} ac)` : ""}. Irregular unit: follow its lines on the official BLM plat. Snapping isn't available here.`
                      : null}
                  </div>
                )}
                {!stakeSnap && <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}><span>Rotate:</span><input type="range" min={0} max={180} step={5} value={stakeAngle} onChange={e => redrawStakeBox(stakeCenter, +e.target.value, claimKind)} style={{ flex: 1, accentColor: "#facc15" }} /></div>}
                {claimKind === "lode" && <div style={{ color: "#cbd5e1", marginBottom: "6px", fontFamily: "system-ui, sans-serif" }}>Lode claims run up to 1,500 ft along the vein and up to 300 ft each side of it.</div>}
                {stakeCorners.map((c, i) => <div key={i}>Corner {stakeSnap || stakeAngle === 0 ? ["NW", "NE", "SE", "SW"][i] : i + 1}: {c[1].toFixed(6)}, {c[0].toFixed(6)}</div>)}
                <div style={{ marginTop: "6px", fontFamily: "system-ui, sans-serif" }}>{stakeChecks
                  ? stakeChecks.map(p => <div key={p.label} style={{ color: p.verdict.staking === "likely" ? "#86efac" : "#fca5a5" }}>{p.label}: {p.verdict.short}</div>)
                  : <div style={{ color: "#fde68a" }}>Checking land status at the centre and 4 corners…</div>}</div>
                <button disabled={!stakeChecks} onClick={copyStakePacket} style={{ marginTop: "6px", width: "100%", background: stakeChecks ? "linear-gradient(135deg, #eab308, #ca8a04)" : "#475569", color: "#0f172a", border: "1px solid #fef08a", borderRadius: "6px", padding: "6px 10px", fontSize: "11px", fontWeight: 900, cursor: stakeChecks ? "pointer" : "wait" }}>{stakeCopied ? "✅ Copied staking checklist" : "📋 Copy staking checklist"}</button>
              </div>
            )}
          </div>
        );
      })()}
      {parcel ? <><h2>{parcel.OwnerName || "Owner not listed"}</h2><p>{parcel.AddressLine1 || "No situs address"}<br/>{parcel.CityStateZip}</p>
        <strong className="access">● {parcel.PropAccess || "ACCESS STATUS NOT RECORDED"}</strong>
        <div className="facts"><div><span>ACRES</span><b>{parcel.GISAcres?.toFixed(2) || "—"}</b></div><div><span>LAND TYPE</span><b>{parcel.PropType || "—"}</b></div><div><span>ASSESSED</span><b>{money(parcel.TotalValue)}</b></div><div><span>COUNTY</span><b>{parcel.CountyName || "—"}</b></div></div>
        <section className="mineral-intel">
          <div className="mineral-heading"><div><small>MINERAL INTELLIGENCE · USGS</small><b>What is documented nearby</b></div>{minerals && <span>{minerals.radiusMiles} mi</span>}</div>
          {mineralsLoading && <div className="mineral-loading"><i/><i/></div>}
          {mineralsError && <p className="mineral-empty">{mineralsError}</p>}
          {minerals && minerals.records.length === 0 && <p className="mineral-empty">No USGS MRDS mineral occurrence or production record was found within {minerals.radiusMiles} miles.</p>}
          {minerals && minerals.records.length > 0 && <>
            <div className="mineral-summary">
              <span className={minerals.reportedProductionCount ? "documented" : "quiet"}><b>{minerals.reportedProductionCount}</b> reported production</span>
              <span className={minerals.leadCount ? "potential" : "quiet"}><b>{minerals.leadCount}</b> occurrence / prospect</span>
            </div>
            {minerals.commodities.length > 0 && <div className="mineral-chips">{minerals.commodities.map(name => <span key={name}>{name}</span>)}</div>}
            <div className="mineral-records">{minerals.records.slice(0, 3).map(record => <a key={record.id} href={record.url} target="_blank" rel="noreferrer">
              <span><b>{record.name}</b><small>{record.commodities.join(" · ") || "Commodity not specified"}</small></span>
              <em>{record.distanceMiles < .1 ? "at/adjacent" : `${record.distanceMiles.toFixed(1)} mi`}<small>{record.status}</small></em>
            </a>)}</div>
          </>}
          <p className="mineral-note">A nearby occurrence or old production record is evidence—not proof of minerals beneath this exact parcel. MRDS locations and operating status can be dated; field verification, mineral rights, and permits are separate.</p>
        </section>
        {clickedLocation && <button className="panel-save" onClick={() => saveLocation(parcel.AddressLine1 || parcel.OwnerName || "Selected parcel", "parcel", clickedLocation.lon, clickedLocation.lat)}>☆ Save parcel</button>}
        {clickedLocation && <button className="panel-route" onClick={() => openDirections(clickedLocation.lat, clickedLocation.lon)}>Directions in Google Maps ➜</button>}
        <details><summary>Legal record</summary><p>{parcel.LegalDescriptionShort}<br/>Parcel ID: {parcel.PARCELID}</p></details>
      </> : <div className="loading"><i/><i/><i/></div>}
    </aside>}

    {(placeResults.length > 0 || searchMessage) && !parcelOpen && !claimOpen && <section className="panel place-results">
      <div className="results-title"><div><small>OPENSTREETMAP SEARCH</small><h2>Choose a result</h2></div><button onClick={() => { setPlaceResults([]); setSearchMessage(""); }}>×</button></div>
      <p style={{ margin: "4px 14px", fontSize: "10px", color: "#94a3b8" }}>Search © OpenStreetMap contributors (Nominatim)</p>
      {searchMessage && <p style={{ margin: "8px 14px", fontSize: "12px" }}>{searchMessage}</p>}
      <div className="results-list">{placeResults.map(place => <button key={place.id} onClick={() => choosePlace(place)}>
        <span><b>{place.name}</b><small>{place.category} · {place.address}</small></span>
        <em>›</em>
      </button>)}</div>
    </section>}

    {navTab === "explore" && destination && !parcelOpen && !claimOpen && placeResults.length === 0 && <section className="panel destination">
      <div><small>{selectedPlace ? "PLACE" : "DESTINATION"}</small><h2>{selectedPlace?.name || destination.display_name.split(",").slice(0,2).join(",")}</h2>
        {selectedPlace && <p>{selectedPlace.category}</p>}
      </div>
      <div className="destination-buttons"><button className="save-destination" aria-label="Clear destination" onClick={clearMap} title="Close">×</button><button className="save-destination" aria-label="Save destination" onClick={saveCurrentDestination}>☆</button><button onClick={() => openDirections(+destination.lat, +destination.lon)}>Directions in Google Maps ➜</button></div>
    </section>}
    {navTab === "explore" && !destination && !parcelOpen && !claimOpen && placeResults.length === 0 && !searchMessage && <div className="panel hint"><b>◎</b><span><strong>Tap the map</strong><small>Owners, public land and active mining claims</small></span></div>}

    {navTab !== "explore" && <section className="panel nav-sheet">
      <div className="nav-sheet-title"><div><small>OPENLAND</small><h2>{navTab === "routes" ? "Routes" : navTab === "saved" ? "Saved places" : "More"}</h2></div><button onClick={() => openTab("explore")}>×</button></div>
      {navTab === "routes" && <div className="tab-content">
        {destination ? <>
          <div className="current-destination"><span>DESTINATION</span><b>{selectedPlace?.name || destination.display_name.split(",").slice(0, 2).join(",")}</b><small>Opens turn-by-turn directions in Google Maps</small></div>
          <div className="sheet-actions"><button onClick={() => openDirections(+destination.lat, +destination.lon)}>Directions in Google Maps ➜</button><button className="secondary" onClick={saveCurrentDestination}>☆ Save</button></div>
        </> : <div className="tab-empty"><b>Choose a destination first</b><p>Search for a place or tap any parcel or active mining claim, then choose “Directions in Google Maps.”</p><button onClick={() => openTab("explore")}>Explore map</button></div>}
      </div>}
      {navTab === "saved" && <div className="tab-content">
        {destination && <button className="save-current" onClick={saveCurrentDestination}>☆ Save current destination</button>}
        {savedLocations.length ? <><button className="save-current" style={{ marginBottom: "8px", background: "#0e7490", color: "#fff" }} onClick={() => {
          const csv = ["Label,Type,Latitude,Longitude,GoogleMapsURL", ...savedLocations.map(s => [s.label.replace(/,/g, " "), s.type, s.lat, s.lon, "https://www.google.com/maps?q=" + s.lat + "," + s.lon].join(","))].join("\n");
          const blob = new Blob([csv], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "montana-prospector-targets.csv";
          a.click();
        }}>📥 Export Saved Targets (CSV Spreadsheet)</button><div className="saved-list">{savedLocations.map(item => <div key={item.id}><button onClick={() => selectSaved(item)}><span><b>{item.label}</b><small>{item.type} · {item.lat.toFixed(4)}, {item.lon.toFixed(4)}</small></span><em>›</em></button><button aria-label={`Remove ${item.label}`} className="remove-saved" onClick={() => persistSaved(savedLocations.filter(saved => saved.id !== item.id))}>×</button></div>)}</div></>
        : <div className="tab-empty"><b>No saved locations yet</b><p>Use the ☆ button on a parcel, claim, place, or destination. Saved items stay on this phone.</p><button onClick={() => openTab("explore")}>Find a place</button></div>}
      </div>}
      {navTab === "more" && <div className="tab-content">
        <div className="quick-grid"><button onClick={() => { openTab("explore"); locate(); }}><b>⌾</b><span>My location</span></button><button onClick={() => { openTab("explore"); setLayers(true); }}><b>▱</b><span>Map layers</span></button><button onClick={() => { setBase(base === "usgs" ? "topo" : base === "topo" && googleMaps ? "google" : "usgs"); openTab("explore"); }}><b>◫</b><span>{base === "usgs" ? "Topo map" : base === "topo" && googleMaps ? "Google satellite" : "USGS satellite"}</span></button><button onClick={clearMap}><b>⌫</b><span>Clear destination</span></button></div>
        <div className="about-card"><small>DATA SOURCES</small><p>Google Maps, Montana State Library cadastral data, BLM MLRS active claims, USGS GNIS geographic names, USGS transportation, and USGS mineral records.</p></div>
        <div className="about-card"><small>IPHONE APP</small><p>In Safari, tap Share, then <b>Add to Home Screen</b> to keep OpenLand beside your other navigation apps.</p></div>
      </div>}
    </section>}


    <nav aria-label="Primary"><button className={navTab === "explore" ? "active" : ""} onClick={() => openTab("explore")}>⌖<small>Explore</small></button><button className={navTab === "routes" ? "active" : ""} onClick={() => openTab("routes")}>↗<small>Routes</small></button><button className={navTab === "saved" ? "active" : ""} onClick={() => openTab("saved")}>☆<small>Saved</small></button><button className={navTab === "more" ? "active" : ""} onClick={() => openTab("more")}>☰<small>More</small></button></nav>
  </main>;
}

async function createGoogleTileSession(key: string) {
  const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType: "satellite", language: "en-US", region: "US" }),
  });
  if (!response.ok) throw new Error("Google tile session failed");
  const data = await response.json() as { session?: string };
  if (!data.session) throw new Error("Google tile session missing");
  return data.session;
}

function Layer({ color, title, sub, on, click }: { color: string; title: string; sub: string; on: boolean; click: () => void }) {
  return <button className="layer" onClick={click}><i style={{background: color}}/><span><b>{title}</b><small>{sub}</small></span><em className={on ? "switch on" : "switch"}><u/></em></button>;
}

