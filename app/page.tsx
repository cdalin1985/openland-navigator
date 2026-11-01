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
import OSM from "ol/source/OSM";
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
  arcgisFeatures, buildStakingPacket, checkLandAt, distanceMiles, findBendSpots, landVerdict, offsetByFeet, stakeBoxCorners,
  type Attributes, type BendSpot, type ClaimKind, type LandCheck, type Verdict,
} from "./lib/land-status";

type Parcel = {
  OwnerName?: string; AddressLine1?: string; CityStateZip?: string;
  GISAcres?: number; PropAccess?: string; PropType?: string;
  TotalValue?: number; PARCELID?: string; CountyName?: string;
  LegalDescriptionShort?: string;
};
type Destination = { display_name: string; lon: string; lat: string };
type RouteResult = { miles: string; minutes: number; provider: "Google Traffic" | "Open route" };
type RouteChoice = RouteResult & { index: number; label: string; encodedPolyline: string };
type Place = {
  id: string; name: string; address: string; lat: number; lon: number; category: string;
  rating?: number; ratingCount?: number; openNow?: boolean; hours?: string[];
  phone?: string; website?: string; googleMapsUrl?: string;
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
type StreetViewTarget = { lon: number; lat: number; label: string };
type StreetViewPanoramaData = { location?: { pano?: string; description?: string } };
type StreetViewPanoramaInstance = { setVisible: (visible: boolean) => void };
type StreetViewLibrary = {
  StreetViewPanorama: new (element: HTMLElement, options: Record<string, unknown>) => StreetViewPanoramaInstance;
  StreetViewService: new () => {
    getPanorama: (
      request: { location: { lat: number; lng: number }; radius: number; preference: "nearest" },
      callback: (data: StreetViewPanoramaData | null, status: string) => void,
    ) => Promise<unknown>;
  };
  StreetViewStatus: { OK: string };
};
type GoogleMapsNamespace = { importLibrary: (name: "streetView") => Promise<StreetViewLibrary> };

declare global {
  interface Window {
    google?: { maps?: GoogleMapsNamespace };
    __openlandStreetViewReady?: () => void;
  }
}

let googleMapsLoader: Promise<GoogleMapsNamespace> | null = null;

const ESRI_IMAGERY_ATTRIBUTION = "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community";
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
  const streetViewModeRef = useRef(false);
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
  const [base, setBase] = useState<"satellite" | "street">("satellite");
  const [layers, setLayers] = useState(false);
  const [keyOpen, setKeyOpen] = useState(true);
  const [active, setActive] = useState({ closedClaims: true, parcels: false, public: true, easements: false, claims: true, places: true, roads: true, water: true, peaks: true });
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
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeChoices, setRouteChoices] = useState<RouteChoice[]>([]);
  const [googleMaps, setGoogleMaps] = useState(false);
  const [googleBrowserKey, setGoogleBrowserKey] = useState("");
  const [streetViewMode, setStreetViewMode] = useState(false);
  const [streetView, setStreetView] = useState<StreetViewTarget | null>(null);
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

  /** Draw the claim box, then re-check land status at its centre and corners (debounced). */
  function redrawStakeBox(center: { lon: number; lat: number }, angleDeg: number, kind: ClaimKind) {
    const corners = stakeBoxCorners(center, angleDeg, kind);
    vectors.current.getFeatures().filter(f => f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f));
    const box = new Feature(new LineString([...corners, corners[0]].map(c => fromLonLat(c))));
    box.set("kind", "stakeBox");
    vectors.current.addFeature(box);
    corners.forEach(c => { const pt = new Feature(new Point(fromLonLat(c))); pt.set("kind", "stakeBox"); vectors.current.addFeature(pt); });
    setStakeCenter(center); setStakeAngle(angleDeg); setClaimKind(kind); setStakeCorners(corners);
    setStakeChecks(null); setStakeCopied(false);
    const seq = ++stakeSeq.current;
    window.clearTimeout(stakeTimer.current);
    stakeTimer.current = window.setTimeout(async () => {
      const labels = angleDeg === 0 ? ["Corner NW", "Corner NE", "Corner SE", "Corner SW"] : ["Corner 1", "Corner 2", "Corner 3", "Corner 4"];
      const points: Array<[string, [number, number]]> = [["Centre", [center.lon, center.lat]], ...corners.map((c, i): [string, [number, number]] => [labels[i], c])];
      const results: Array<{ label: string; verdict: Verdict }> = [];
      for (const [label, [lon, lat]] of points) {
        if (seq !== stakeSeq.current) return;
        results.push({ label, verdict: landVerdict((await checkLandAt(lon, lat)).check) });
      }
      if (seq === stakeSeq.current) setStakeChecks(results);
    }, 700);
  }

  /** Copy the checklist for the box exactly as drawn now (corners, rotation, land checks). */
  function copyStakePacket() {
    if (!stakeCenter) return;
    const packet = buildStakingPacket({
      kind: claimKind, center: stakeCenter, angleDeg: stakeAngle, corners: stakeCorners,
      county: parcel?.CountyName, legal: parcel?.LegalDescriptionShort, pointChecks: stakeChecks,
    });
    void navigator.clipboard.writeText(packet)
      .then(() => { setStakeCopied(true); window.setTimeout(() => setStakeCopied(false), 3000); })
      .catch(() => setStakeCopied(false));
  }

  useEffect(() => {
    if (!target.current) return;
    const streetFallback = new TileLayer({ source: new OSM(), visible: false });
    const satelliteFallback = new TileLayer({
      source: new XYZ({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 19,
        crossOrigin: "anonymous",
        attributions: ESRI_IMAGERY_ATTRIBUTION,
      }),
      visible: true,
    });
    baseLayers.current = { streetFallback, satelliteFallback };
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
    overlays.current = { closedClaims, parcels, public: publicLand, easements, claims, places: lowZoomReference, water: hydroLabels, roads: roadLabels, peaks: geographicNames };
    labelLayers.current = [lowZoomReference, hydroLabels, roadLabels, geographicNames];
    const vector = new VectorLayer({
      source: vectors.current,
      style: f => f.get("kind") === "digSpot" ? new Style({ image: new Circle({ radius: 9, fill: new Fill({ color: "#22c55e" }), stroke: new Stroke({ color: "#ffffff", width: 3 }) }), zIndex: 38 }) : f.get("kind") === "mine" ? new Style({ image: new Circle({ radius: 8, fill: new Fill({ color: "#f97316" }), stroke: new Stroke({ color: "#fef08a", width: 3 }) }), zIndex: 34 }) : f.get("kind") === "stakeBox"
        ? new Style({
            stroke: new Stroke({ color: "#facc15", width: 3.5, lineDash: [8, 6] }),
            image: new Circle({ radius: 6, fill: new Fill({ color: "#facc15" }), stroke: new Stroke({ color: "#000", width: 2 }) }),
            zIndex: 35,
          })
        : f.get("kind") === "route"
        ? new Style({
            stroke: new Stroke({
              color: f.get("selected") ? "#62f3aa" : ["#5bbcff", "#ffb65c", "#c8a7ff", "#ff6b7a"][f.get("routeIndex") % 4],
              width: f.get("selected") ? 7 : 4,
            }),
            zIndex: f.get("selected") ? 20 : 10,
          })
        : new Style({ image: new Circle({ radius: 9, fill: new Fill({ color: "#62f3aa" }), stroke: new Stroke({ color: "#fff", width: 4 }) }) }),
    });
    const instance = new Map({
      target: target.current,
      controls: [new Attribution({ collapsible: false })],
      layers: [streetFallback, satelliteFallback, publicLand, easements, claims, closedClaims, parcels, lowZoomReference, hydroLabels, roadLabels, geographicNames, vector],
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
      if (streetViewModeRef.current) {
        streetViewModeRef.current = false;
        setStreetViewMode(false);
        setStreetView({ lon, lat, label: "Selected road" });
        setParcelOpen(false); setClaimOpen(false); setPlaceResults([]); setLayers(false);
        return;
      }
      await runInspect(lon, lat);
    });
    map.current = instance;
    void (async () => {
      try {
        const config = await (await fetch("/api/google/config")).json() as { enabled?: boolean; key?: string };
        if (!config.enabled || !config.key) return;
        const key = config.key;
        setGoogleBrowserKey(key);
        const [satelliteSession, streetSession] = await Promise.all([
          createGoogleTileSession(key, "satellite"),
          createGoogleTileSession(key, "roadmap"),
        ]);
        const makeSource = (session: string) => new XYZ({
          url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${key}`,
          crossOrigin: "anonymous",
          maxZoom: 22,
          attributions: "Google",
        });
        const googleSatellite = new TileLayer({ source: makeSource(satelliteSession), visible: true });
        const googleStreet = new TileLayer({ source: makeSource(streetSession), visible: false });
        baseLayers.current = { ...baseLayers.current, satellite: googleSatellite, street: googleStreet };
        instance.getLayers().insertAt(2, googleStreet);
        instance.getLayers().insertAt(2, googleSatellite);
        baseLayers.current.satelliteFallback?.setVisible(false);
        baseLayers.current.streetFallback?.setVisible(false);
        // Map Tiles API policy: show the copyright string the viewport endpoint returns for this view.
        const updateCopyright = async () => {
          const layer = googleSatellite.getVisible() ? googleSatellite : googleStreet.getVisible() ? googleStreet : null;
          if (!layer) return;
          const [west, south, east, north] = transformExtent(instance.getView().calculateExtent(instance.getSize()), "EPSG:3857", "EPSG:4326");
          const params = new URLSearchParams({
            session: layer === googleSatellite ? satelliteSession : streetSession, key,
            zoom: String(Math.round(instance.getView().getZoom() ?? 0)),
            north: String(Math.min(north, 89.9)), south: String(Math.max(south, -89.9)), east: String(east), west: String(west),
          });
          const res = await fetch(`https://tile.googleapis.com/tile/v1/viewport?${params}`);
          if (!res.ok) return;
          const data = await res.json() as { copyright?: string };
          layer.getSource()?.setAttributions(data.copyright ? `Google · ${data.copyright}` : "Google");
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
    baseLayers.current.satellite?.setVisible(base === "satellite");
    baseLayers.current.street?.setVisible(base === "street");
    baseLayers.current.satelliteFallback?.setVisible(!googleMaps && base === "satellite");
    baseLayers.current.streetFallback?.setVisible(!googleMaps && base === "street");
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
    });
  }

  async function search(e: FormEvent) {
    e.preventDefault(); if (!query.trim() || !map.current) return; setBusy(true); setNavTab("explore");
    try {
      const [centerLon, centerLat] = toLonLat(map.current.getView().getCenter() || fromLonLat([-111.493, 47.523]));
      const placesResponse = await fetch(`/api/google/places?q=${encodeURIComponent(query)}&lat=${centerLat}&lon=${centerLon}`);
      if (placesResponse.ok) {
        const placesData = await placesResponse.json() as { places?: Place[] };
        if (placesData.places?.length) {
          setPlaceResults(placesData.places); setSelectedPlace(null); setDestination(null); setRoute(null); setRouteChoices([]);
          setParcelOpen(false); setClaimOpen(false);
          return;
        }
      }
      const googleResponse = await fetch(`/api/google/geocode?q=${encodeURIComponent(query)}`);
      if (googleResponse.ok) {
        const found = await googleResponse.json() as Destination;
        setDestination(found); setRoute(null); setRouteChoices([]); setPlaceResults([]); setSelectedPlace(null);
        map.current.getView().animate({ center: fromLonLat([+found.lon, +found.lat]), zoom: 15, duration: 700 });
        return;
      }
      const p = new URLSearchParams({ q: query, format: "jsonv2", limit: "1", countrycodes: "us" });
      const found = (await (await fetch(`https://nominatim.openstreetmap.org/search?${p}`)).json())[0] as Destination;
      if (!found) return;
      setDestination(found); setRoute(null); setRouteChoices([]); setPlaceResults([]); setSelectedPlace(null);
      map.current.getView().animate({ center: fromLonLat([+found.lon, +found.lat]), zoom: 15, duration: 700 });
    } finally { setBusy(false); }
  }

  function choosePlace(place: Place) {
    setNavTab("explore");
    setSelectedPlace(place); setPlaceResults([]); setRoute(null); setRouteChoices([]);
    setDestination({ display_name: `${place.name}, ${place.address}`, lon: String(place.lon), lat: String(place.lat) });
    map.current?.getView().animate({ center: fromLonLat([place.lon, place.lat]), zoom: 16, duration: 700 });
  }

  function routeToMapPoint(label: string) {
    if (!clickedLocation) return;
    setDestination({ display_name: label, lon: String(clickedLocation.lon), lat: String(clickedLocation.lat) });
    setSelectedPlace(null); setPlaceResults([]); setRoute(null); setRouteChoices([]);
    setParcelOpen(false); setClaimOpen(false);
    setNavTab("explore");
    map.current?.getView().animate({ center: fromLonLat([clickedLocation.lon, clickedLocation.lat]), zoom: 16, duration: 450 });
  }

  function openTab(tab: NavTab) {
    streetViewModeRef.current = false; setStreetViewMode(false); setStreetView(null);
    setNavTab(tab); setLayers(false); setParcelOpen(false); setClaimOpen(false); setPlaceResults([]);
  }

  function openStreetView(lon: number, lat: number, label: string) {
    if (!googleBrowserKey) return;
    streetViewModeRef.current = false; setStreetViewMode(false);
    setLayers(false); setParcelOpen(false); setClaimOpen(false); setPlaceResults([]);
    setStreetView({ lon, lat, label });
  }

  function activateStreetView() {
    if (!googleBrowserKey) return;
    if (destination) {
      openStreetView(+destination.lon, +destination.lat, selectedPlace?.name || destination.display_name.split(",").slice(0, 2).join(","));
      return;
    }
    streetViewModeRef.current = true; setStreetViewMode(true); setStreetView(null);
    setNavTab("explore"); setLayers(false); setParcelOpen(false); setClaimOpen(false); setPlaceResults([]);
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
    setSelectedPlace(null); setRoute(null); setRouteChoices([]); setNavTab("explore");
    map.current?.getView().animate({ center: fromLonLat([item.lon, item.lat]), zoom: 16, duration: 650 });
  }

  function clearMap() {
    vectors.current.getFeatures().filter(feature => feature.get("kind") === "route").forEach(feature => vectors.current.removeFeature(feature));
    setDestination(null); setSelectedPlace(null); setRoute(null); setRouteChoices([]); setNavTab("explore");
  }

  function navigate() {
    if (!destination || !map.current) return;
    navigator.geolocation.getCurrentPosition(async pos => {
      const origin: [number, number] = [pos.coords.longitude, pos.coords.latitude];
      const destinationCoordinate: [number, number] = [+destination.lon, +destination.lat];
      try {
        const googleResponse = await fetch("/api/google/route", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin, destination: destinationCoordinate }),
        });
        if (googleResponse.ok) {
          const googleData = await googleResponse.json() as { routes?: Array<{ optionLabel?: string; distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }> };
          const choices = (googleData.routes || []).flatMap((googleRoute, index) => {
            const encodedPolyline = googleRoute.polyline?.encodedPolyline;
            if (!encodedPolyline || typeof googleRoute.distanceMeters !== "number" || !googleRoute.duration) return [];
            return [{
              index,
              label: googleRoute.optionLabel || (index === 0 ? "Recommended" : `Route ${index + 1}`),
              miles: (googleRoute.distanceMeters / 1609.344).toFixed(1),
              minutes: Math.round(parseFloat(googleRoute.duration) / 60),
              provider: "Google Traffic" as const,
              encodedPolyline,
            }];
          });
          if (choices.length && map.current) {
            drawRouteChoices(choices, map.current, vectors.current);
            setRouteChoices(choices); setRoute(choices[0]);
            return;
          }
        }
      } catch { /* fall through to the open routing service */ }
      const start = `${origin[0]},${origin[1]}`;
      const end = `${destination.lon},${destination.lat}`;
      const data = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${start};${end}?overview=full&geometries=geojson`)).json();
      const result = data.routes?.[0]; if (!result || !map.current) return;
      drawRoute(result.geometry.coordinates, map.current, vectors.current);
      setRouteChoices([]); setRoute({ miles: (result.distance / 1609.344).toFixed(1), minutes: Math.round(result.duration / 60), provider: "Open route" });
    });
  }

  function selectRouteChoice(choice: RouteChoice) {
    const routeFeatures = vectors.current.getFeatures().filter(feature => feature.get("kind") === "route");
    routeFeatures.forEach(feature => feature.set("selected", feature.get("routeIndex") === choice.index));
    const selected = routeFeatures.find(feature => feature.get("routeIndex") === choice.index);
    if (selected?.getGeometry() && map.current) {
      map.current.getView().fit((selected.getGeometry() as LineString), { padding: [130, 35, 230, 35], duration: 500, maxZoom: 16 });
    }
    setRoute(choice);
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

    <header>
      <b className="logo">OL</b>
      <form onSubmit={search}><span>⌕</span><input aria-label="Search" placeholder="Where to? Address, place or coordinates" value={query} onChange={e => setQuery(e.target.value)} /><button>{busy ? "…" : "Go"}</button></form>
      <button className="icon" aria-label="Layers" onClick={() => { setNavTab("explore"); setLayers(v => !v); }}>▱</button>
    </header>
    <div className="live"><i/> LIVE PUBLIC DATA · MONTANA · {googleMaps ? "GOOGLE MAPS" : "OPEN MAP"}</div>
    <div className="tools"><button aria-label="My location" onClick={locate}>⌾</button><button className={streetViewMode ? "street-view-tool active" : "street-view-tool"} aria-label="Street View" disabled={!googleBrowserKey} onClick={activateStreetView}><StreetViewIcon/></button><button aria-label="Zoom in" onClick={() => map.current?.getView().adjustZoom(1)}>＋</button><button aria-label="Zoom out" onClick={() => map.current?.getView().adjustZoom(-1)}>−</button></div>

    {layers && <aside className="panel layer-panel">
      <div className="panel-title"><div><small>MAP DISPLAY</small><h2>Layers</h2></div><button onClick={() => setLayers(false)}>×</button></div>
      <div className="bases">
        <button className={base === "satellite" ? "selected sat" : "sat"} onClick={() => setBase("satellite")}><b>Satellite</b><span>Google Hybrid</span></button>
        <button className={base === "street" ? "selected streets" : "streets"} onClick={() => setBase("street")}><b>Street</b><span>{googleMaps ? "Google" : "Open map"}</span></button>
      </div>
      <h3>MAP REFERENCE</h3>
      <Layer color="#ffffff" title="Cities & towns" sub="Towns, places & county labels" on={active.places} click={() => toggle("places")} />
      <Layer color="#ff9f43" title="Roads & highways" sub="Interstates, highways & road numbers" on={active.roads} click={() => toggle("roads")} />
      <Layer color="#54a0ff" title="Rivers, creeks & lakes" sub="Waterways, ditches & reservoirs" on={active.water} click={() => toggle("water")} />
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
      {clickedLocation && googleBrowserKey && <button className="panel-street" onClick={() => openStreetView(clickedLocation.lon, clickedLocation.lat, claim.CSE_NAME || "Selected mining claim")}><StreetViewIcon/> Street View</button>}
      <button className="panel-route" onClick={() => routeToMapPoint(claim.CSE_NAME || "Selected mining claim")}>Show routes here ➜</button>
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
                  <span>📐 {CLAIM_SHAPES[claimKind].label} · {stakeAngle}°</span>
                  <span style={{ display: "flex", gap: "3px" }}>{NUDGES.map(([label, eastFt, northFt]) => <button key={label} title="Move the box 100 ft" onClick={() => redrawStakeBox(offsetByFeet(stakeCenter, eastFt, northFt), stakeAngle, claimKind)} style={{ background: "#334155", border: "1px solid #facc15", borderRadius: "4px", padding: "1px 5px", cursor: "pointer", fontSize: "10px" }}>{label}</button>)}</span>
                </div>
                <div style={{ display: "flex", gap: "4px", marginBottom: "6px" }}>
                  {(["placer", "lode"] as const).map(kind => <button key={kind} onClick={() => redrawStakeBox(stakeCenter, stakeAngle, kind)} style={{ flex: 1, background: claimKind === kind ? "#facc15" : "#334155", color: claimKind === kind ? "#0f172a" : "#fff", border: "1px solid #facc15", borderRadius: "4px", padding: "3px", cursor: "pointer", fontSize: "10px", fontWeight: 800 }}>{kind === "placer" ? "Placer (loose gravel)" : "Lode (vein in rock)"}</button>)}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}><span>Rotate:</span><input type="range" min={0} max={180} step={5} value={stakeAngle} onChange={e => redrawStakeBox(stakeCenter, +e.target.value, claimKind)} style={{ flex: 1, accentColor: "#facc15" }} /></div>
                <div style={{ color: "#cbd5e1", marginBottom: "6px", fontFamily: "system-ui, sans-serif" }}>{claimKind === "placer" ? "On surveyed land, placers should follow the survey grid as closely as possible (43 CFR 3832.12). Keep 0° unless the land is unsurveyed." : "Lode claims run up to 1,500 ft along the vein and up to 300 ft each side of it."}</div>
                {stakeCorners.map((c, i) => <div key={i}>Corner {stakeAngle === 0 ? ["NW", "NE", "SE", "SW"][i] : i + 1}: {c[1].toFixed(6)}, {c[0].toFixed(6)}</div>)}
                <div style={{ marginTop: "6px", fontFamily: "system-ui, sans-serif" }}>{stakeChecks
                  ? stakeChecks.map(p => <div key={p.label} style={{ color: p.verdict.panning === "likely" ? "#86efac" : "#fca5a5" }}>{p.label}: {p.verdict.short}</div>)
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
        {clickedLocation && googleBrowserKey && <button className="panel-street" onClick={() => openStreetView(clickedLocation.lon, clickedLocation.lat, parcel.AddressLine1 || parcel.OwnerName || "Selected parcel")}><StreetViewIcon/> Street View</button>}
        <button className="panel-route" onClick={() => routeToMapPoint(parcel.AddressLine1 || parcel.OwnerName || "Selected parcel")}>Show routes here ➜</button>
        <details><summary>Legal record</summary><p>{parcel.LegalDescriptionShort}<br/>Parcel ID: {parcel.PARCELID}</p></details>
      </> : <div className="loading"><i/><i/><i/></div>}
    </aside>}

    {placeResults.length > 0 && !parcelOpen && !claimOpen && <section className="panel place-results">
      <div className="results-title"><div><small>GOOGLE PLACES</small><h2>Choose a result</h2></div><button onClick={() => setPlaceResults([])}>×</button></div>
      <div className="results-list">{placeResults.map(place => <button key={place.id} onClick={() => choosePlace(place)}>
        <span><b>{place.name}</b><small>{place.category} · {place.address}</small></span>
        <em>{place.openNow === true ? "Open" : place.openNow === false ? "Closed" : place.rating ? `★ ${place.rating}` : "›"}</em>
      </button>)}</div>
    </section>}

    {navTab === "explore" && destination && !parcelOpen && !claimOpen && placeResults.length === 0 && <section className="panel destination">
      <div><small>{route ? `${route.provider.toUpperCase()} ROUTE` : selectedPlace ? "GOOGLE PLACE" : "DESTINATION"}</small><h2>{selectedPlace?.name || destination.display_name.split(",").slice(0,2).join(",")}</h2>
        {selectedPlace && <p>{selectedPlace.category}{selectedPlace.rating ? ` · ★ ${selectedPlace.rating} (${selectedPlace.ratingCount || 0})` : ""}{selectedPlace.openNow === true ? " · Open now" : selectedPlace.openNow === false ? " · Closed" : ""}</p>}
        {route && <p>{route.miles} miles · {route.minutes} minutes</p>}
        {routeChoices.length > 1 && <div className="route-options">{routeChoices.map(choice => <button className={route === choice ? "selected" : ""} key={`${choice.index}-${choice.label}`} onClick={() => selectRouteChoice(choice)}>
          <b>{choice.label}</b><span>{choice.minutes} min · {choice.miles} mi</span>
        </button>)}</div>}
        {selectedPlace && <div className="place-actions">{selectedPlace.phone && <a href={`tel:${selectedPlace.phone}`}>Call</a>}{selectedPlace.website && <a href={selectedPlace.website} target="_blank" rel="noreferrer">Website</a>}</div>}
      </div>
      <div className="destination-buttons"><button className="save-destination" aria-label="Clear destination" onClick={clearMap} title="Close">×</button><button className="save-destination" aria-label="Save destination" onClick={saveCurrentDestination}>☆</button>{googleBrowserKey && <button className="street-destination" aria-label="Open Street View" onClick={() => openStreetView(+destination.lon, +destination.lat, selectedPlace?.name || destination.display_name.split(",").slice(0, 2).join(","))}><StreetViewIcon/></button>}<button onClick={navigate}>{route ? "Re-route" : "Navigate"} ➜</button></div>
    </section>}
    {navTab === "explore" && !destination && !parcelOpen && !claimOpen && placeResults.length === 0 && <div className={streetViewMode ? "panel hint street-hint" : "panel hint"}><b>{streetViewMode ? <StreetViewIcon/> : "◎"}</b><span><strong>{streetViewMode ? "Tap a road for Street View" : "Tap the map"}</strong><small>{streetViewMode ? "Choose a mapped road or roadside location" : "Owners, public land and active mining claims"}</small></span></div>}

    {navTab !== "explore" && <section className="panel nav-sheet">
      <div className="nav-sheet-title"><div><small>OPENLAND</small><h2>{navTab === "routes" ? "Routes" : navTab === "saved" ? "Saved places" : "More"}</h2></div><button onClick={() => openTab("explore")}>×</button></div>
      {navTab === "routes" && <div className="tab-content">
        {destination ? <>
          <div className="current-destination"><span>DESTINATION</span><b>{selectedPlace?.name || destination.display_name.split(",").slice(0, 2).join(",")}</b>{route ? <small>{route.minutes} min · {route.miles} mi · {route.provider}</small> : <small>Ready to calculate directions</small>}</div>
          {routeChoices.length > 1 && <div className="route-list">{routeChoices.map(choice => <button className={route === choice ? "selected" : ""} key={`${choice.index}-${choice.label}`} onClick={() => selectRouteChoice(choice)}><span><b>{choice.label}</b><small>{choice.provider}</small></span><em>{choice.minutes} min<br/>{choice.miles} mi</em></button>)}</div>}
          <div className="sheet-actions"><button onClick={navigate}>{route ? "Refresh routes" : "Get up to 5 routes"}</button><button className="secondary" onClick={saveCurrentDestination}>☆ Save</button></div>
        </> : <div className="tab-empty"><b>Choose a destination first</b><p>Search for a place or tap any parcel or active mining claim, then choose “Show routes here.”</p><button onClick={() => openTab("explore")}>Explore map</button></div>}
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
        <div className="quick-grid"><button onClick={() => { openTab("explore"); locate(); }}><b>⌾</b><span>My location</span></button><button onClick={() => { openTab("explore"); setLayers(true); }}><b>▱</b><span>Map layers</span></button><button onClick={() => { setBase(base === "satellite" ? "street" : "satellite"); openTab("explore"); }}><b>◫</b><span>{base === "satellite" ? "Street map" : "Satellite"}</span></button><button disabled={!googleBrowserKey} onClick={activateStreetView}><b><StreetViewIcon/></b><span>Street View</span></button><button onClick={clearMap}><b>⌫</b><span>Clear route</span></button></div>
        <div className="about-card"><small>DATA SOURCES</small><p>Google Maps, Montana State Library cadastral data, BLM MLRS active claims, USGS GNIS geographic names, USGS transportation, and USGS mineral records.</p></div>
        <div className="about-card"><small>IPHONE APP</small><p>In Safari, tap Share, then <b>Add to Home Screen</b> to keep OpenLand beside your other navigation apps.</p></div>
      </div>}
    </section>}

    {streetView && googleBrowserKey && <StreetViewViewer key={`${streetView.lat},${streetView.lon}`} target={streetView} apiKey={googleBrowserKey} onClose={() => setStreetView(null)} />}

    <nav aria-label="Primary"><button className={navTab === "explore" ? "active" : ""} onClick={() => openTab("explore")}>⌖<small>Explore</small></button><button className={navTab === "routes" ? "active" : ""} onClick={() => openTab("routes")}>↗<small>Routes</small></button><button className={navTab === "saved" ? "active" : ""} onClick={() => openTab("saved")}>☆<small>Saved</small></button><button className={navTab === "more" ? "active" : ""} onClick={() => openTab("more")}>☰<small>More</small></button></nav>
  </main>;
}

async function createGoogleTileSession(key: string, mapType: "satellite" | "roadmap") {
  const response = await fetch(`https://tile.googleapis.com/v1/createSession?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mapType, language: "en-US", region: "US" }),
  });
  if (!response.ok) throw new Error("Google tile session failed");
  const data = await response.json() as { session?: string };
  if (!data.session) throw new Error("Google tile session missing");
  return data.session;
}

function drawRoute(coordinates: number[][], currentMap: Map, source: VectorSource) {
  source.getFeatures().filter(f => f.get("kind") === "route").forEach(f => source.removeFeature(f));
  const line = new Feature(new LineString(coordinates.map(c => fromLonLat(c))));
  line.setProperties({ kind: "route", routeIndex: 0, selected: true }); source.addFeature(line);
  currentMap.getView().fit(line.getGeometry()!, { padding: [130, 35, 210, 35], duration: 700, maxZoom: 16 });
}

function drawRouteChoices(choices: RouteChoice[], currentMap: Map, source: VectorSource) {
  source.getFeatures().filter(feature => feature.get("kind") === "route").forEach(feature => source.removeFeature(feature));
  const features = choices.map(choice => {
    const feature = new Feature(new LineString(decodePolyline(choice.encodedPolyline).map(coordinate => fromLonLat(coordinate))));
    feature.setProperties({ kind: "route", routeIndex: choice.index, selected: choice.index === choices[0].index });
    return feature;
  });
  source.addFeatures(features);
  currentMap.getView().fit(features[0].getGeometry()!, { padding: [130, 35, 230, 35], duration: 700, maxZoom: 16 });
}

function decodePolyline(encoded: string): number[][] {
  const points: number[][] = [];
  let index = 0, latitude = 0, longitude = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte: number;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([longitude / 1e5, latitude / 1e5]);
  }
  return points;
}

function Layer({ color, title, sub, on, click }: { color: string; title: string; sub: string; on: boolean; click: () => void }) {
  return <button className="layer" onClick={click}><i style={{background: color}}/><span><b>{title}</b><small>{sub}</small></span><em className={on ? "switch on" : "switch"}><u/></em></button>;
}

function StreetViewIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2.6" fill="currentColor"/><path d="M8.2 10.2c0-1.8 1.5-3.2 3.3-3.2h1c1.8 0 3.3 1.4 3.3 3.2v2.3l2.1 2.1-1.7 1.7-2.3-2.3v7h-3v-5.2H9.2V21h-3v-8.6h2z" fill="currentColor"/></svg>;
}

function StreetViewViewer({ target, apiKey, onClose }: { target: StreetViewTarget; apiKey: string; onClose: () => void }) {
  const canvas = useRef<HTMLDivElement>(null);
  const [viewerState, setViewerState] = useState<"loading" | "ready" | "unavailable" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    let panorama: StreetViewPanoramaInstance | null = null;
    void loadGoogleMaps(apiKey)
      .then(maps => maps.importLibrary("streetView"))
      .then(library => {
        if (cancelled) return;
        const service = new library.StreetViewService();
        void service.getPanorama(
          { location: { lat: target.lat, lng: target.lon }, radius: 1000, preference: "nearest" },
          (data, status) => {
            if (cancelled) return;
            if (status !== library.StreetViewStatus.OK || !data?.location?.pano || !canvas.current) {
              setViewerState("unavailable");
              return;
            }
            panorama = new library.StreetViewPanorama(canvas.current, {
              pano: data.location.pano,
              pov: { heading: 0, pitch: 0 },
              zoom: 1,
              addressControl: true,
              clickToGo: true,
              fullscreenControl: true,
              linksControl: true,
              motionTracking: false,
              motionTrackingControl: false,
              panControl: true,
              zoomControl: true,
            });
            setViewerState("ready");
          },
        ).catch(() => {
          if (!cancelled) setViewerState("error");
        });
      })
      .catch(() => {
        if (!cancelled) setViewerState("error");
      });

    return () => {
      cancelled = true;
      panorama?.setVisible(false);
    };
  }, [apiKey, target.lat, target.lon]);

  const googleMapsUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${target.lat},${target.lon}`;

  return <section className="streetview-panel" aria-label={`Street View: ${target.label}`}>
    <div className="streetview-bar"><div><small>GOOGLE STREET VIEW</small><b>{target.label}</b></div><a href={googleMapsUrl} target="_blank" rel="noreferrer">Open in Maps</a><button aria-label="Close Street View" onClick={onClose}>×</button></div>
    <div className="streetview-canvas" ref={canvas} />
    {viewerState !== "ready" && <div className="streetview-status" role="status">
      {viewerState === "loading" ? <><i/><b>Finding nearby Street View…</b><span>Searching within 0.6 mile</span></> : <><StreetViewIcon/><b>{viewerState === "unavailable" ? "No Street View nearby" : "Street View could not load"}</b><span>{viewerState === "unavailable" ? "Try another point closer to a public road." : "Open the location in Google Maps or try again."}</span><a href={googleMapsUrl} target="_blank" rel="noreferrer">Open in Google Maps</a></>}
    </div>}
  </section>;
}

function loadGoogleMaps(apiKey: string) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (googleMapsLoader) return googleMapsLoader;

  googleMapsLoader = new Promise<GoogleMapsNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => reject(new Error("Google Maps timed out")), 15000);
    const finish = () => {
      window.clearTimeout(timeout);
      if (window.google?.maps) resolve(window.google.maps);
      else reject(new Error("Google Maps did not initialize"));
    };

    window.__openlandStreetViewReady = finish;
    script.dataset.openlandGoogleMaps = "true";
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=__openlandStreetViewReady`;
    script.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("Google Maps failed to load"));
    };
    document.head.appendChild(script);
  });

  return googleMapsLoader;
}
