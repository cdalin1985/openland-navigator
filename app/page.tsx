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
import { fromLonLat, toLonLat } from "ol/proj";
import { Circle, Fill, Stroke, Style } from "ol/style";
import "ol/ol.css";

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
  LEG_CSE_NR?: string; RCRD_ACRS?: number; QLTY?: string; MC_PATENTED?: string; extraInfo?: string;
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

const ROOT = "https://gisservice.mt.gov/arcgis/rest/services";
const CAD = `${ROOT}/msdi_cadastral_map_v1/MapServer`;
const NAIP = `${ROOT}/MSDI_Framework/msdi_naip2025_provisional_image_v1/ImageServer`;
const CLAIMS = "https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/MapServer";
const CLAIMS_CLOSED = "https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Closed/MapServer";
const MRDS = "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer";
const GEONAMES = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer";
const TRANSPORTATION = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer";
const REFERENCE_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer";
const HYDRO_LABELS = "https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Esri_Hydro_Reference_Overlay/MapServer";
const money = (n?: number) => n ? `$${n.toLocaleString()}` : "Not listed";


function normClaim(raw: any): MiningClaim {
  if (!raw) return {};
  const extras: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (v == null || v === "" || /^OBJECTID|GLOBALID|SHAPE/i.test(k)) continue;
    if (/DATE|DT|LOC_|CLOSED|CUST|NAME|OWNER|MTR|TWP|RNG|SEC|ST_/i.test(k) && !/CSE_NAME|CASE_NAME/i.test(k)) {
      const val = typeof v === "number" && v > 100000000000 ? new Date(v).toISOString().slice(0, 10) : String(v);
      extras.push(k + ": " + val);
    }
  }
  return {
    CSE_NAME: raw.CSE_NAME || raw.cse_name || raw.CASE_NAME || raw.case_name || "Unnamed Claim",
    CSE_DISP: raw.CSE_DISP || raw.cse_disp || raw.CASE_DISP || "Recorded",
    BLM_PROD: raw.BLM_PROD || raw.blm_prod || raw.CLAIM_TYPE || "Mining Claim",
    CSE_NR: raw.CSE_NR || raw.cse_nr || raw.SERIAL_NR || raw.serial_nr || raw.LEG_CSE_NR || raw.leg_cse_nr || "N/A",
    LEG_CSE_NR: raw.LEG_CSE_NR || raw.leg_cse_nr || "",
    RCRD_ACRS: Number(raw.RCRD_ACRS ?? raw.rcrd_acrs ?? raw.ACRES ?? 0) || undefined,
    QLTY: raw.QLTY || raw.qlty || "",
    MC_PATENTED: raw.MC_PATENTED || raw.mc_patented || "",
    extraInfo: extras.slice(0, 6).join(" | "),
  };
}

export default function Home() {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const streetViewModeRef = useRef(false);
  const vectors = useRef(new VectorSource());
  const overlays = useRef<Record<string, any>>({});
  const inspectRef = useRef<((lon: number, lat: number) => void) | null>(null);
  const labelLayers = useRef<Array<ImageLayer<ImageArcGISRest> | TileLayer<XYZ>>>([]);
  const baseLayers = useRef<Record<string, any>>({});
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
  const [stakeCorners, setStakeCorners] = useState<string[]>([]);
  const [stakeAngle, setStakeAngle] = useState(0);
  const [clearSky, setClearSky] = useState(false);
  const [aiReport, setAiReport] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [geminiKey, setGeminiKey] = useState(() => typeof window !== "undefined" ? localStorage.getItem("openland-gemini-key") || "" : "");
  const [keyBoxOpen, setKeyBoxOpen] = useState(false);
  const [appMode, setAppMode] = useState<"beginner" | "staker">("beginner");
  const [digSpots, setDigSpots] = useState<Array<{ label: string; tip: string; lon: number; lat: number }>>([]);
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

  async function findDigSpots(lon: number, lat: number) {
    setDigSpots([]);
    vectors.current.getFeatures().filter(f => f.get("kind") === "digSpot").forEach(f => vectors.current.removeFeature(f));
    try {
      const q = new URLSearchParams({ f: "json", geometry: lon + "," + lat, geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326", spatialRel: "esriSpatialRelIntersects", distance: "500", units: "esriSRUnit_Meter", outFields: "*", returnGeometry: "true" });
      const d = await (await fetch("https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query?" + q)).json();
      const bends: Array<{ label: string; tip: string; lon: number; lat: number; score: number }> = [];
      for (const feat of (d.features || [])) {
        const name = feat.attributes?.gnis_name || feat.attributes?.GNIS_NAME || "Mountain Creek";
        for (const path of (feat.geometry?.paths || [])) {
          for (let i = 1; i < path.length - 1; i++) {
            const [x1, y1] = path[i - 1], [x2, y2] = path[i], [x3, y3] = path[i + 1];
            let ang = Math.abs((Math.atan2(y3 - y2, x3 - x2) - Math.atan2(y2 - y1, x2 - x1)) * 180 / Math.PI);
            if (ang > 180) ang = 360 - ang;
            const dist = mineralDistanceMiles(lat, lon, y2, x2);
            if ((feat.attributes?.gnis_name || feat.attributes?.GNIS_NAME) && ang >= 20 && dist < 0.35) {
              bends.push({ lon: x2, lat: y2, score: ang - dist * 40, label: name + " — " + Math.round(ang) + "° Inside Bend", tip: "Water slows on the inside curve of this " + Math.round(ang) + "° bend. Pan the inside gravel bar behind cobbles & down to clay/bedrock." });
            }
          }
        }
      }
      const top = bends.sort((a, b) => b.score - a.score).filter((b, i, arr) => arr.slice(0, i).every(p => mineralDistanceMiles(b.lat, b.lon, p.lat, p.lon) > 0.04)).slice(0, 3);
      top.forEach(s => { const p = new Feature(new Point(fromLonLat([s.lon, s.lat]))); p.set("kind", "digSpot"); vectors.current.addFeature(p); });
      setDigSpots(top);
    } catch {}
  }
  async function runAiGeologist() {
    if (!clickedLocation) return;
    if (!geminiKey.trim()) { setKeyBoxOpen(true); return; }
    setAiLoading(true); setAiReport(""); setKeyBoxOpen(false);
    try {
      const res = await fetch("/api/ai/prospect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lon: clickedLocation.lon, lat: clickedLocation.lat, owner: parcel?.OwnerName, activeCount: activeClaimsList.length, lapsedNames: lapsedClaimsList.map(x => x.CSE_NAME).join(", "), mines: minerals?.records || [], bends: digSpots.map(s => s.label + " at " + s.lat.toFixed(5) + "," + s.lon.toFixed(5)).join("; "), apiKey: geminiKey.trim() }) });
      const d = await res.json();
      setAiReport(d.report || d.error || "No response");
    } catch { setAiReport("AI request failed."); } finally { setAiLoading(false); }
  }
  async function loadMinerals(lon: number, lat: number) {
    try {
      const siteQuery = new URLSearchParams({
        f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", spatialRel: "esriSpatialRelIntersects", distance: "10",
        units: "esriSRUnit_StatuteMile", outFields: "DEP_ID,SITE_NAME,DEV_STAT,URL,Grade",
        returnGeometry: "true", outSR: "4326", resultRecordCount: "100",
      });
      const siteResponse = await fetch(`${MRDS}/0/query?${siteQuery}`);
      if (!siteResponse.ok) throw new Error("USGS mineral service unavailable");
      const siteData = await siteResponse.json() as {
        features?: Array<{ attributes?: { DEP_ID?: string; SITE_NAME?: string; DEV_STAT?: string; URL?: string; Grade?: string }; geometry?: { x?: number; y?: number } }>;
      };
      const nearby = (siteData.features || []).flatMap(feature => {
        const id = feature.attributes?.DEP_ID;
        const x = feature.geometry?.x; const y = feature.geometry?.y;
        if (!id || !Number.isFinite(x) || !Number.isFinite(y)) return [];
        return [{
          id, name: feature.attributes?.SITE_NAME || "Unnamed mineral record",
          status: feature.attributes?.DEV_STAT || "Unknown",
          url: feature.attributes?.URL || `https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=${id}`,
          grade: feature.attributes?.Grade || "—",
          distanceMiles: mineralDistanceMiles(lat, lon, y as number, x as number), lon: x as number, lat: y as number }];
      }).sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 20);

      const commodityMap = new globalThis.Map<string, string[]>();
      if (nearby.length) {
        const ids = nearby.map(record => `'${record.id.replace(/'/g, "''")}'`).join(",");
        const commodityQuery = new URLSearchParams({
          f: "json", where: `Record_ID IN (${ids})`,
          outFields: "Record_ID,Commodity_name,Importance", returnGeometry: "false", resultRecordCount: "500",
        });
        const commodityResponse = await fetch(`${MRDS}/10/query?${commodityQuery}`);
        if (commodityResponse.ok) {
          const commodityData = await commodityResponse.json() as { features?: Array<{ attributes?: { Record_ID?: string; Commodity_name?: string } }> };
          (commodityData.features || []).forEach(feature => {
            const id = feature.attributes?.Record_ID; const name = feature.attributes?.Commodity_name;
            if (!id || !name) return;
            const list = commodityMap.get(id) || [];
            if (!list.includes(name)) list.push(name);
            commodityMap.set(id, list);
          });
        }
      }

      vectors.current.getFeatures().filter(f => f.get("kind") === "mine").forEach(f => vectors.current.removeFeature(f)); nearby.slice(0, 20).forEach((r: any) => { if (r.lon && r.lat) { const mf = new Feature(new Point(fromLonLat([r.lon, r.lat]))); mf.set("kind", "mine"); vectors.current.addFeature(mf); } }); const records: MineralRecord[] = nearby.slice(0, 8).map(record => ({
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
      setMineralsError("Public mineral records are temporarily unavailable");
    } finally {
      setMineralsLoading(false);
    }
  }

  useEffect(() => {
    if (!target.current) return;
    const streetFallback = new TileLayer({ source: new OSM(), visible: false });
    const satelliteFallback = new TileLayer({
      source: new XYZ({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        maxZoom: 19,
        crossOrigin: "anonymous",
      }),
      visible: true,
    });
    baseLayers.current = { streetFallback, satelliteFallback };
    const publicLand = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:2", FORMAT: "png32" } }), opacity: .5 });
    const easements = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:3", FORMAT: "png32" } }), opacity: .55, visible: false });
    const closedClaims = new ImageLayer({
      className: "ol-layer ol-lapsed-claims",
      source: new ImageArcGISRest({
        url: CLAIMS_CLOSED,
        params: { LAYERS: "show:0", FORMAT: "png32" },
      }),
      opacity: 0.85,
      visible: true,
    });
    const claims = new ImageLayer({
      className: "ol-layer ol-active-claims", source: new ImageArcGISRest({ url: CLAIMS, params: { LAYERS: "show:0", FORMAT: "png32" } }), opacity: .82 });
    const parcels = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:1", FORMAT: "png32" } }), opacity: .9, minZoom: 9, visible: false });
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
      controls: [],
      layers: [streetFallback, satelliteFallback, publicLand, easements, claims, closedClaims, parcels, lowZoomReference, hydroLabels, roadLabels, geographicNames, vector],
      view: new View({ center: fromLonLat([-112.035, 46.685]), zoom: 11.2, minZoom: 5, maxZoom: 20 }),
    });
    const runInspect = async (lon: number, lat: number) => {
      setNavTab("explore");
      setClickedLocation({ lon, lat });
      setCopiedDossier(false);
      setAiReport("");
      setStakeCorners([]);

      vectors.current.getFeatures().filter(f => f.get("kind") === "tap").forEach(f => vectors.current.removeFeature(f));
      const tapPin = new Feature(new Point(fromLonLat([lon, lat])));
      tapPin.set("kind", "tap");
      vectors.current.addFeature(tapPin);

      setParcel(null); setClaim(null); setActiveClaimsList([]); setLapsedClaimsList([]);
      setClaimOpen(false); setParcelOpen(true); setSelectedPlace(null); setPlaceResults([]);
      setParcelMessage("Checking BLM Active Claims, Lapsed Claims & Land Status…");
      setMinerals(null); setMineralsError(""); setMineralsLoading(true);
      void loadMinerals(lon, lat);
      void findDigSpots(lon, lat);

      const cp = new URLSearchParams({
        f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", spatialRel: "esriSpatialRelIntersects",
        distance: "25", units: "esriSRUnit_Meter",
        outFields: "*", returnGeometry: "false",
      });
      const pp = new URLSearchParams({
        f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", spatialRel: "esriSpatialRelIntersects",
        outFields: "*", returnGeometry: "false",
      });

      const [actRes, lapRes, parRes, pubRes] = await Promise.allSettled([
        fetch(`${CLAIMS}/0/query?${cp}`).then(r => r.json()),
        fetch(`${CLAIMS_CLOSED}/0/query?${cp}`).then(r => r.json()),
        fetch(`${CAD}/1/query?${pp}`).then(r => r.json()),
        fetch(`${CAD}/2/query?${pp}`).then(r => r.json()),
      ]);

      if (actRes.status === "fulfilled") {
        const list = (actRes.value?.features || []).map((f: any) => normClaim(f.attributes)).filter((c: MiningClaim) => c.CSE_NAME);
        setActiveClaimsList(list);
        if (list[0]) setClaim(list[0]);
      }
      if (lapRes.status === "fulfilled") {
        const list = (lapRes.value?.features || []).map((f: any) => normClaim(f.attributes)).filter((c: MiningClaim) => c.CSE_NAME);
        setLapsedClaimsList(list);
      }

      const rec = (parRes.status === "fulfilled" ? parRes.value?.features?.[0]?.attributes : undefined) as Parcel | undefined;
      const pubAttr = (pubRes.status === "fulfilled" ? pubRes.value?.features?.[0]?.attributes : undefined) as Record<string, any> | undefined;
      const pubAgency = pubAttr
        ? (pubAttr.Owner || pubAttr.OWNER || pubAttr.Agency || pubAttr.AGENCY || pubAttr.ManagingAgency ||
           Object.values(pubAttr).find(v => typeof v === "string" && /BLM|BUREAU|FOREST|USFS|USDA|STATE|DNRC|FISH|FEDERAL/i.test(v)) || "")
        : "";

      if (rec) {
        if (!rec.OwnerName && pubAgency) rec.OwnerName = String(pubAgency);
        setParcel(rec);
        setParcelMessage("Official Montana & BLM Land Intelligence");
      } else if (pubAgency) {
        setParcel({ OwnerName: String(pubAgency), PropType: "Public Land", PropAccess: "Public Access" });
        setParcelMessage("Official Montana Public Land Record");
      } else {
        setParcel({ OwnerName: "Public / Unsubdivided Federal Tract", PropType: "Public Domain" });
        setParcelMessage("Official Montana & BLM Land Intelligence");
      }
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
        setGoogleBrowserKey(config.key);
        const [satelliteSession, streetSession] = await Promise.all([
          createGoogleTileSession(config.key, "satellite"),
          createGoogleTileSession(config.key, "roadmap"),
        ]);
        const makeSource = (session: string) => new XYZ({
          url: `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${session}&key=${config.key}`,
          crossOrigin: "anonymous",
          maxZoom: 22,
        });
        const googleSatellite = new TileLayer({ source: makeSource(satelliteSession), visible: true });
        const googleStreet = new TileLayer({ source: makeSource(streetSession), visible: false });
        baseLayers.current = { ...baseLayers.current, satellite: googleSatellite, street: googleStreet };
        instance.getLayers().insertAt(2, googleStreet);
        instance.getLayers().insertAt(2, googleSatellite);
        baseLayers.current.satelliteFallback?.setVisible(false);
        baseLayers.current.streetFallback?.setVisible(false);
        setGoogleMaps(true);
      } catch {
        setGoogleMaps(false);
      }
    })();
    return () => { instance.setTarget(undefined); map.current = null; };
  }, []);

  useEffect(() => {
    baseLayers.current.satellite?.setVisible(base === "satellite");
    baseLayers.current.street?.setVisible(base === "street");
    baseLayers.current.satelliteFallback?.setVisible(!googleMaps && base === "satellite");
    baseLayers.current.streetFallback?.setVisible(!googleMaps && base === "street");
  }, [base, googleMaps]);

  
  async function scanAreaForLapsedClaims() {
    if (!map.current) return;
    setScanOpen(true);
    setScanLoading(true);
    setScanResults([]);
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
        resultRecordCount: "60",
      });
      const res = await (await fetch(`${CLAIMS_CLOSED}/0/query?${qp}`)).json();
      const seen = new Set<string>();
      const items: Array<MiningClaim & { lon?: number; lat?: number }> = [];
      for (const f of (res.features || [])) {
        const c = normClaim(f.attributes);
        const key = `${c.CSE_NR}-${c.CSE_NAME}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ring = f.geometry?.rings?.[0];
        let lon: number | undefined, lat: number | undefined;
        if (Array.isArray(ring) && ring.length) {
          lon = ring.reduce((s: number, p: number[]) => s + p[0], 0) / ring.length;
          lat = ring.reduce((s: number, p: number[]) => s + p[1], 0) / ring.length;
        }
        items.push({ ...c, lon, lat });
      }
      setScanResults(items);
    } catch {
      setScanResults([]);
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
      map.current.getView().fit((selected.getGeometry() as any), { padding: [130, 35, 230, 35], duration: 500, maxZoom: 16 });
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
          <strong style={{ fontSize: "12px", letterSpacing: "0.4px" }}>💎 LAPSED CLAIMS IN THIS VIEW ({scanResults.length})</strong>
          <button onClick={() => setScanOpen(false)} style={{ background: "none", border: "none", color: "#fff", fontSize: "16px", cursor: "pointer" }}>×</button>
        </div>
        <div style={{ padding: "10px", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
          {scanLoading && <div style={{ fontSize: "12px", color: "#94a3b8", padding: "12px" }}>Scanning BLM Closed Claims database in this view…</div>}
          {!scanLoading && scanResults.length === 0 && (
            <div style={{ fontSize: "12px", color: "#94a3b8", padding: "12px" }}>No recently closed claims found in this exact map window. Try zooming out slightly or clicking another gold district!</div>
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
        🔎 Scan Screen for Lapsed Claims
      </button>
      <button onClick={() => setAppMode(appMode === "beginner" ? "staker" : "beginner")} style={{ background: appMode === "beginner" ? "linear-gradient(135deg, #16a34a, #15803d)" : "linear-gradient(135deg, #eab308, #ca8a04)", color: appMode === "beginner" ? "#fff" : "#000", border: "1px solid #fff", borderRadius: "999px", padding: "6px 14px", fontSize: "11px", fontWeight: 900, whiteSpace: "nowrap", cursor: "pointer" }}>{appMode === "beginner" ? "🪣 Mode: Beginner Panning (Tap for Staker)" : "📐 Mode: Claim Staker & Flipper (Tap for Beginner)"}</button>
      <button onClick={() => { const next = !clearSky; setClearSky(next); if (next) { baseLayers.current.satelliteFallback?.setSource(new XYZ({ url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", maxZoom: 19, crossOrigin: "anonymous" })); baseLayers.current.satellite?.setVisible(false); baseLayers.current.satelliteFallback?.setVisible(true); } else { baseLayers.current.satelliteFallback?.setSource(new XYZ({ url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", maxZoom: 20, crossOrigin: "anonymous" })); if (googleMaps && baseLayers.current.satellite) { baseLayers.current.satellite.setVisible(true); baseLayers.current.satelliteFallback?.setVisible(false); } } }} style={{ background: clearSky ? "#eab308" : "rgba(15,23,42,0.92)", color: clearSky ? "#000" : "#fde047", border: "1px solid #facc15", borderRadius: "999px", padding: "6px 12px", fontSize: "11px", fontWeight: 800, whiteSpace: "nowrap", cursor: "pointer" }}>{clearSky ? "☀️ Summer Aerial: ON" : "☀️ Clear Clouds (Summer Aerial)"}</button>
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
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>✅ You can claim this!</small>
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
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>🛑 Someone owns it</small>
                  </span>
                </span>
                <input type="checkbox" checked={active.claims} onChange={() => toggle("claims")} style={{ accentColor: "#ff00b7", width: "16px", height: "16px", cursor: "pointer" }} />
              </label>

              {/* 3. Lapsed Claims */}
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: "rgba(255,255,255,0.04)", padding: "6px 8px", borderRadius: "8px" }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
                  <span style={{ width: "14px", height: "14px", background: "#06b6d4", borderRadius: "3px", border: "1px solid #fff", flexShrink: 0 }} />
                  <span>
                    <strong style={{ color: "#38bdf8" }}>Old Lapsed Claims</strong>
                    <small style={{ display: "block", color: "#94a3b8", fontSize: "10px" }}>💎 Open to restake!</small>
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
      <Layer color="#f59e0b" title="Public Lands" sub="Yellow = BLM Claimable · Blue = State · Green = USFS" on={active.public} click={() => toggle("public")} />
      <Layer color="#06b6d4" title="Lapsed Claims (Restakeable)" sub="Cyan areas · Historic BLM claims open to restaking" on={active.closedClaims} click={() => toggle("closedClaims")} />
      <Layer color="#ff00b7" title="Active Mining Claims" sub="Pink areas · Staked claims recorded with BLM" on={active.claims} click={() => toggle("claims")} />
      <Layer color="#a855f7" title="Conservation Easements" sub="Purple areas · Protected land" on={active.easements} click={() => toggle("easements")} />
      <div className="legend" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", fontSize: "11px", marginTop: "12px", background: "rgba(0,0,0,0.3)", padding: "10px", borderRadius: "8px" }}>
        <span><span style={{ display: "inline-block", width: "12px", height: "12px", background: "#f59e0b", borderRadius: "2px", marginRight: "6px" }}/><b>Yellow:</b> BLM (Claimable)</span>
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
        <div><span>PATENTED</span><b>{claim.MC_PATENTED === "Y" ? "Yes" : claim.MC_PATENTED === "N" ? "No" : "Not listed"}</b></div>
        <div><span>MAP QUALITY</span><b>{claim.QLTY || "—"}</b></div>
      </div>
      {clickedLocation && <button className="panel-save" onClick={() => saveLocation(claim.CSE_NAME || "Selected mining claim", "claim", clickedLocation.lon, clickedLocation.lat)}>☆ Save claim</button>}
      {clickedLocation && googleBrowserKey && <button className="panel-street" onClick={() => openStreetView(clickedLocation.lon, clickedLocation.lat, claim.CSE_NAME || "Selected mining claim")}><StreetViewIcon/> Street View</button>}
      <button className="panel-route" onClick={() => routeToMapPoint(claim.CSE_NAME || "Selected mining claim")}>Show routes here ➜</button>
      <p className="record-note">BLM commonly maps claims to the affected PLSS quarter-section. Staked claim boundaries may differ from this display.</p>
    </aside>}

    {parcelOpen && <aside className="panel parcel">
      <button className="close" onClick={() => setParcelOpen(false)}>×</button><small>{parcelMessage}</small>
      {(() => {
        const owner = (parcel?.OwnerName || "").toUpperCase();
        const isBLM = owner.includes("BLM") || owner.includes("BUREAU OF LAND MANAGEMENT") || owner.includes("PUBLIC DOMAIN");
        const isUSFS = owner.includes("FOREST SERVICE") || owner.includes("USFS") || owner.includes("USDA");
        const isState = owner.includes("STATE OF MONTANA") || owner.includes("DNRC");
        const activeAcres = activeClaimsList.reduce((s, c) => s + (c.RCRD_ACRS || 0), 0);
        let bg = "#334155", badge = "🔍 INSPECTING GROUND", msg = "Checking public land and claim records…";
        if (activeClaimsList.length > 0) {
          bg = "#be185d";
          badge = `🛑 ${activeClaimsList.length} ACTIVE CLAIM(S) RECORDED (${activeAcres.toFixed(0)} ACRES)`;
          msg = `Active: ${activeClaimsList.slice(0, 3).map(c => `${c.CSE_NAME} (${c.CSE_NR || c.LEG_CSE_NR})`).join(", ")}. Note: If total claimed acres are less than the 160-acre section, open ground may still exist nearby!`;
        } else if ((isBLM || isUSFS) && lapsedClaimsList.length > 0) {
          bg = "#0e7490";
          badge = `💎 JACKPOT: ${lapsedClaimsList.length} LAPSED CLAIM(S) ON OPEN ${isBLM ? "BLM" : "USFS"} LAND!`;
          msg = `Zero active claims! Past miners staked: ${lapsedClaimsList.slice(0, 3).map(c => `${c.CSE_NAME} (${c.CSE_NR || c.LEG_CSE_NR})`).join(", ")}. Prime restake candidate!`;
        } else if (isBLM) {
          bg = "#b45309";
          badge = "✅ OPEN BLM LAND — LEGAL TO STAKE!";
          msg = "Managed by BLM with zero active claims recorded here.";
        } else if (isUSFS) {
          bg = "#15803d";
          badge = "🌲 NATIONAL FOREST — OPEN UNLESS WITHDRAWN";
          msg = "USFS land with zero active claims. Verify no wilderness/recreation withdrawal applies.";
        } else if (isState) {
          bg = "#1d4ed8";
          badge = "🚫 STATE TRUST LAND — NO FEDERAL STAKING";
          msg = "Requires a Montana DNRC state mineral lease.";
        } else if (parcel?.OwnerName) {
          bg = "#9a3412";
          badge = "🏠 PRIVATE PROPERTY — OFF LIMITS";
          msg = `Private surface owner (${parcel.OwnerName}).${lapsedClaimsList.length ? ` (${lapsedClaimsList.length} historic closed claims on file).` : ""}`;
        }
        return (
          <div style={{ background: bg, padding: "12px", borderRadius: "10px", marginTop: "8px", marginBottom: "10px", color: "#fff", border: "1px solid rgba(255,255,255,0.25)" }}>
            <div style={{ fontWeight: 900, fontSize: "12px", letterSpacing: "0.4px", marginBottom: "4px" }}>{badge}</div>
            <div style={{ fontSize: "12px", lineHeight: "1.4", opacity: 0.95 }}>{msg}</div>
            {lapsedClaimsList.length > 0 && activeClaimsList.length > 0 && (
              <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px solid rgba(255,255,255,0.2)", fontSize: "11px", color: "#a5f3fc" }}>
                💎 Also in this section: <b>{lapsedClaimsList.length} Lapsed Claim(s)</b> ({lapsedClaimsList.slice(0, 2).map(c => c.CSE_NAME).join(", ")})
              </div>
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
                {aiReport && <div style={{ marginTop: "8px", fontSize: "11px", lineHeight: "1.45", color: "#e0e7ff", whiteSpace: "pre-wrap", maxHeight: "240px", overflowY: "auto", background: "rgba(0,0,0,0.4)", padding: "8px", borderRadius: "6px" }}>{aiReport}</div>}
              </div>
            )}
            {digSpots.length > 0 && (
              <div style={{ marginTop: "8px", background: "rgba(20, 83, 45, 0.85)", padding: "9px", borderRadius: "8px", border: "1px solid #4ade80" }}>
                <div style={{ fontSize: "10px", fontWeight: 900, color: "#86efac", marginBottom: "4px" }}>
                  🟢 WHERE TO PHYSICALLY DIG (USGS CREEK-BEND ANALYSIS):
                </div>
                <div style={{ fontSize: "10px", color: "#dcfce7", marginBottom: "6px" }}>
                  {activeClaimsList.length === 0 ? "✅ Open ground! Casual hand-panning & shovel digging is 100% legal here for $0 (no claim needed)." : "⚠️ Active claim in section—verify you are outside active posts before digging."}
                </div>
                {digSpots.map((s, i) => (
                  <div key={i} onClick={() => map.current?.getView().animate({ center: fromLonLat([s.lon, s.lat]), zoom: 17.2, duration: 600 })} style={{ background: "rgba(0,0,0,0.35)", padding: "6px 8px", borderRadius: "6px", marginTop: "4px", cursor: "pointer", borderLeft: "3px solid #22c55e" }}>
                    <div style={{ fontWeight: 800, fontSize: "11px", color: "#4ade80" }}>🪣 Spot #{i + 1}: {s.label} (Tap to Zoom)</div>
                    <div style={{ fontSize: "10px", color: "#f1f5f9", marginTop: "2px" }}>{s.tip}</div>
                    <div style={{ fontSize: "9px", color: "#fde047", fontFamily: "monospace", marginTop: "2px" }}>GPS: {s.lat.toFixed(5)}, {s.lon.toFixed(5)}</div>
                  </div>
                ))}
              </div>
            )}
            {clickedLocation && (
              <button onClick={() => {
                const isLode = lapsedClaimsList.some(c => /LODE/i.test(c.BLM_PROD || "") || (c.RCRD_ACRS && c.RCRD_ACRS > 20.3));
                const widthFt = isLode ? 600 : 660;
                const lengthFt = isLode ? 1500 : 1320;
                const lat = clickedLocation.lat;
                const lon = clickedLocation.lon;
                const dLat = (lengthFt / 2) / 364000;
                const dLon = (widthFt / 2) / (364000 * Math.cos(lat * Math.PI / 180));
                const nw: [number, number] = [lon - dLon, lat + dLat];
                const ne: [number, number] = [lon + dLon, lat + dLat];
                const se: [number, number] = [lon + dLon, lat - dLat];
                const sw: [number, number] = [lon - dLon, lat - dLat];

                vectors.current.getFeatures().filter(f => f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f));
                const box = new Feature(new LineString([nw, ne, se, sw, nw].map(c => fromLonLat(c))));
                box.set("kind", "stakeBox");
                vectors.current.addFeature(box);
                [nw, ne, se, sw].forEach(c => {
                  const pt = new Feature(new Point(fromLonLat(c)));
                  pt.set("kind", "stakeBox");
                  vectors.current.addFeature(pt);
                });
                map.current?.getView().animate({ center: fromLonLat([lon, lat]), zoom: 15.8, duration: 600 });

                const cornerLabels = [
                  "NW Corner #1: " + nw[1].toFixed(6) + ", " + nw[0].toFixed(6),
                  "NE Corner #2: " + ne[1].toFixed(6) + ", " + ne[0].toFixed(6),
                  "SE Corner #3: " + se[1].toFixed(6) + ", " + se[0].toFixed(6),
                  "SW Corner #4: " + sw[1].toFixed(6) + ", " + sw[0].toFixed(6),
                ];
                setStakeCorners(cornerLabels);

                const targetName = lapsedClaimsList[0]?.CSE_NAME || "Montana Prospect #1";
                const claimKind = isLode ? "20.66-Acre Lode Claim (1,500ft x 600ft)" : "20.00-Acre Placer Claim (1,320ft x 660ft)";
                const packet = [
                  "=== MONTANA 20-ACRE CLAIM STAKING & FLIP PACKET ===",
                  "Target Name: " + targetName + " (Restake Candidate)",
                  "Claim Dimensions: " + claimKind,
                  "Center GPS: " + lat.toFixed(6) + ", " + lon.toFixed(6),
                  "Google Maps Link: https://www.google.com/maps?q=" + lat + "," + lon,
                  "",
                  "--- 4 GPS CORNER POST COORDINATES (WALK WITH PHONE GPS) ---",
                  ...cornerLabels,
                  "",
                  "--- MONTANA COUNTY & BLM CERTIFICATE OF LOCATION INFO ---",
                  "County: " + (parcel?.CountyName || "Verify County") + " County, Montana",
                  "Surface Management: " + (parcel?.OwnerName || "Federal Public Land"),
                  "PLSS Legal Description: " + (parcel?.LegalDescriptionShort || "See BLM Map"),
                  "Prior BLM Serial #: " + (lapsedClaimsList[0]?.CSE_NR || "None") + (lapsedClaimsList[0]?.extraInfo ? " (" + lapsedClaimsList[0].extraInfo + ")" : ""),
                  "Montana Filing Deadlines: Post Monument on Ground -> Record at County Clerk within 60 days (MCA 82-2-102) -> File with BLM Montana State Office (Billings) within 90 days (43 CFR 3833).",
                  "",
                  "--- READY-TO-POST EBAY / GOLDBAY CLAIM LISTING COPY ---",
                  "TITLE: 20-Acre Montana " + (isLode ? "Hard-Rock Lode" : "Placer Gold") + " Mining Claim - Historic '" + targetName + "' Area (" + (parcel?.CountyName || "MT") + " County)",
                  "HIGHLIGHTS:",
                  "• Located on open " + (parcel?.OwnerName || "Federal") + " public land in " + (parcel?.CountyName || "Montana") + " County (" + (parcel?.LegalDescriptionShort || "PLSS Verified") + ").",
                  "• Covers the historic '" + targetName + "' claim area (Former BLM Serial #" + (lapsedClaimsList[0]?.CSE_NR || "N/A") + ").",
                  "• USGS Mineral Records within 10 miles document: " + (minerals?.commodities?.join(", ") || "Gold & Silver") + " (" + (minerals?.reportedProductionCount || 0) + " past producing mines nearby).",
                  "• Full 20-acre footprint mapped with 4 GPS corner coordinates.",
                ].join("\n");
                navigator.clipboard.writeText(packet);
              }} style={{ marginTop: "6px", width: "100%", background: "linear-gradient(135deg, #eab308, #ca8a04)", color: "#0f172a", border: "1px solid #fef08a", borderRadius: "6px", padding: "7px 10px", fontSize: "11px", fontWeight: 900, cursor: "pointer" }}>
                📐 Draw 20-Acre Claim Box & Copy Staking/Flip Packet
              </button>
            )}
            {minerals && minerals.records.length > 0 && <div style={{ marginTop: "8px", background: "rgba(15,23,42,0.7)", padding: "8px", borderRadius: "8px", border: "1px solid #f97316" }}><div style={{ fontSize: "10px", fontWeight: 800, color: "#fdba74", marginBottom: "4px" }}>🟠 NEARBY USGS MINES (TAP 🎯 TO SNAP TO SHAFT):</div>{minerals.records.slice(0, 4).map((r: any) => <button key={r.id} onClick={() => { if (r.lon && r.lat) { map.current?.getView().animate({ center: fromLonLat([r.lon, r.lat]), zoom: 15.8, duration: 600 }); inspectRef.current?.(r.lon, r.lat); } }} style={{ width: "100%", marginTop: "4px", background: "rgba(249,115,22,0.22)", border: "1px solid #f97316", color: "#fff", borderRadius: "5px", padding: "5px 8px", fontSize: "11px", fontWeight: 700, cursor: "pointer", display: "flex", justifyContent: "space-between" }}><span>🎯 {r.name} ({r.commodities.slice(0, 2).join(", ") || r.status})</span><span>{r.distanceMiles < 0.1 ? "HERE!" : r.distanceMiles.toFixed(1) + " mi"}</span></button>)}</div>}
            {stakeCorners.length > 0 && (
              <div style={{ marginTop: "8px", background: "rgba(0,0,0,0.45)", padding: "8px", borderRadius: "6px", fontSize: "10px", fontFamily: "monospace", border: "1px solid #facc15" }}>
                <div style={{ color: "#facc15", fontWeight: 800, marginBottom: "6px", display: "flex", justifyContent: "space-between" }}><span>✅ 20-ACRE BOX ({stakeAngle}°)</span><span style={{ display: "flex", gap: "3px" }}>{[["⬅️",-1,0],["⬆️",0,1],["⬇️",0,-1],["➡️",1,0]].map(([lbl,dx,dy]: any) => <button key={lbl} onClick={() => { if (!clickedLocation) return; const nLon = clickedLocation.lon + dx * 0.00035, nLat = clickedLocation.lat + dy * 0.00027; setClickedLocation({ lon: nLon, lat: nLat }); const isLode = lapsedClaimsList.some(x => /LODE/i.test(x.BLM_PROD || "") || (x.RCRD_ACRS && x.RCRD_ACRS > 20.3)); const hw = isLode ? 300 : 330, hl = isLode ? 750 : 660, rad = stakeAngle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), fLat = 364000, fLon = 364000 * Math.cos(nLat * Math.PI / 180); const pts: [number, number][] = [[-hw, hl], [hw, hl], [hw, -hl], [-hw, -hl]].map(([x, y]) => [nLon + (x * cos + y * sin) / fLon, nLat + (-x * sin + y * cos) / fLat]); vectors.current.getFeatures().filter(f => f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f)); const b = new Feature(new LineString([...pts, pts[0]].map(p => fromLonLat(p)))); b.set("kind", "stakeBox"); vectors.current.addFeature(b); pts.forEach(p => { const pt = new Feature(new Point(fromLonLat(p))); pt.set("kind", "stakeBox"); vectors.current.addFeature(pt); }); setStakeCorners(pts.map((p, i) => "Corner #" + (i + 1) + ": " + p[1].toFixed(6) + ", " + p[0].toFixed(6))); }} style={{ background: "#334155", border: "1px solid #facc15", borderRadius: "4px", padding: "1px 5px", cursor: "pointer", fontSize: "10px" }}>{lbl}</button>)}</span></div><div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px" }}><span>Rotate:</span><input type="range" min={0} max={180} step={5} value={stakeAngle} onChange={e => { const deg = +e.target.value; setStakeAngle(deg); if (!clickedLocation) return; const isLode = lapsedClaimsList.some(x => /LODE/i.test(x.BLM_PROD || "") || (x.RCRD_ACRS && x.RCRD_ACRS > 20.3)); const hw = isLode ? 300 : 330, hl = isLode ? 750 : 660, rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), fLat = 364000, fLon = 364000 * Math.cos(clickedLocation.lat * Math.PI / 180); const pts: [number, number][] = [[-hw, hl], [hw, hl], [hw, -hl], [-hw, -hl]].map(([x, y]) => [clickedLocation.lon + (x * cos + y * sin) / fLon, clickedLocation.lat + (-x * sin + y * cos) / fLat]); vectors.current.getFeatures().filter(f => f.get("kind") === "stakeBox").forEach(f => vectors.current.removeFeature(f)); const b = new Feature(new LineString([...pts, pts[0]].map(p => fromLonLat(p)))); b.set("kind", "stakeBox"); vectors.current.addFeature(b); pts.forEach(p => { const pt = new Feature(new Point(fromLonLat(p))); pt.set("kind", "stakeBox"); vectors.current.addFeature(pt); }); setStakeCorners(pts.map((p, i) => "Corner #" + (i + 1) + ": " + p[1].toFixed(6) + ", " + p[0].toFixed(6))); }} style={{ flex: 1, accentColor: "#facc15" }} /></div>
                {stakeCorners.map((c, i) => <div key={i}>{c}</div>)}
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

function mineralDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1); const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 3958.7613 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
