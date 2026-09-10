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
  LEG_CSE_NR?: string; RCRD_ACRS?: number; QLTY?: string; MC_PATENTED?: string;
};
type MineralRecord = {
  id: string; name: string; status: string; url: string; grade: string;
  distanceMiles: number; commodities: string[];
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

const ROOT = "https://gisservice.mt.gov/arcgis/rest/services";
const CAD = `${ROOT}/msdi_cadastral_map_v1/MapServer`;
const NAIP = `${ROOT}/MSDI_Framework/msdi_naip2025_provisional_image_v1/ImageServer`;
const CLAIMS = "https://gis.blm.gov/nlsdb/rest/services/Mining_Claims/MiningClaims/MapServer";
const MRDS = "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Mineral_Resources_Data_System_MRDS_Compact_Version/FeatureServer";
const GEONAMES = "https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer";
const TRANSPORTATION = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer";
const REFERENCE_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Reference_Overlay/MapServer";
const HYDRO_LABELS = "https://tiles.arcgis.com/tiles/P3ePLMYs2RVChkJx/arcgis/rest/services/Esri_Hydro_Reference_Overlay/MapServer";
const money = (n?: number) => n ? `$${n.toLocaleString()}` : "Not listed";

export default function Home() {
  const target = useRef<HTMLDivElement>(null);
  const map = useRef<Map | null>(null);
  const vectors = useRef(new VectorSource());
  const overlays = useRef<Record<string, ImageLayer<ImageArcGISRest>>>({});
  const labelLayers = useRef<Array<ImageLayer<ImageArcGISRest> | TileLayer<XYZ>>>([]);
  const baseLayers = useRef<{ streetFallback?: TileLayer<OSM>; satelliteFallback?: ImageLayer<ImageArcGISRest>; street?: TileLayer<XYZ>; satellite?: TileLayer<XYZ> }>({});
  const [base, setBase] = useState<"satellite" | "street">("satellite");
  const [layers, setLayers] = useState(false);
  const [active, setActive] = useState({ labels: true, parcels: true, public: true, easements: false, claims: true });
  const [parcel, setParcel] = useState<Parcel | null>(null);
  const [parcelOpen, setParcelOpen] = useState(false);
  const [parcelMessage, setParcelMessage] = useState("");
  const [claim, setClaim] = useState<MiningClaim | null>(null);
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
  const [busy, setBusy] = useState(false);
  const [navTab, setNavTab] = useState<NavTab>("explore");
  const [savedLocations, setSavedLocations] = useState<SavedLocation[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem("openland-saved-locations") || "[]") as SavedLocation[]; }
    catch { return []; }
  });

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
          distanceMiles: mineralDistanceMiles(lat, lon, y as number, x as number),
        }];
      }).sort((a, b) => a.distanceMiles - b.distanceMiles).slice(0, 20);

      const commodityMap = new Map<string, string[]>();
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

      const records: MineralRecord[] = nearby.slice(0, 6).map(record => ({
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
    const satelliteFallback = new ImageLayer({ source: new ImageArcGISRest({ url: NAIP }), visible: true });
    baseLayers.current = { streetFallback, satelliteFallback };
    const publicLand = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:2", FORMAT: "png32" } }), opacity: .5 });
    const easements = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:3", FORMAT: "png32" } }), opacity: .55, visible: false });
    const claims = new ImageLayer({ source: new ImageArcGISRest({ url: CLAIMS, params: { LAYERS: "show:1", FORMAT: "png32" } }), opacity: .82, minZoom: 7 });
    const parcels = new ImageLayer({ source: new ImageArcGISRest({ url: CAD, params: { LAYERS: "show:1", FORMAT: "png32" } }), opacity: .9, minZoom: 9 });
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
      minZoom: 10,
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
    overlays.current = { parcels, public: publicLand, easements, claims };
    labelLayers.current = [lowZoomReference, hydroLabels, roadLabels, geographicNames];
    const vector = new VectorLayer({
      source: vectors.current,
      style: f => f.get("kind") === "route"
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
      layers: [streetFallback, satelliteFallback, publicLand, easements, claims, parcels, lowZoomReference, hydroLabels, roadLabels, geographicNames, vector],
      view: new View({ center: fromLonLat([-111.493, 47.523]), zoom: 12.3, minZoom: 5, maxZoom: 20 }),
    });
    instance.on("singleclick", async e => {
      setNavTab("explore");
      const [lon, lat] = toLonLat(e.coordinate);
      setClickedLocation({ lon, lat });
      if (claims.getVisible()) {
        const claimParams = new URLSearchParams({
          f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
          inSR: "4326", spatialRel: "esriSpatialRelIntersects",
          outFields: "CSE_NAME,CSE_DISP,BLM_PROD,CSE_NR,LEG_CSE_NR,RCRD_ACRS,QLTY,MC_PATENTED",
          returnGeometry: "false",
        });
        try {
          const claimData = await (await fetch(`${CLAIMS}/1/query?${claimParams}`)).json();
          const claimRecord = claimData.features?.[0]?.attributes as MiningClaim | undefined;
          if (claimRecord) {
            setClaim(claimRecord); setClaimOpen(true); setParcelOpen(false);
            setSelectedPlace(null); setPlaceResults([]);
            return;
          }
        } catch { /* continue to the parcel lookup */ }
      }
      setParcel(null); setParcelOpen(true); setParcelMessage("Loading official parcel record…");
      setMinerals(null); setMineralsError(""); setMineralsLoading(true);
      setClaimOpen(false);
      const p = new URLSearchParams({
        f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint",
        inSR: "4326", spatialRel: "esriSpatialRelIntersects",
        outFields: "OwnerName,AddressLine1,CityStateZip,GISAcres,PropAccess,PropType,TotalValue,PARCELID,CountyName,LegalDescriptionShort",
        returnGeometry: "false",
      });
      try {
        const data = await (await fetch(`${CAD}/1/query?${p}`)).json();
        const record = data.features?.[0]?.attributes;
        if (record) {
          setParcel(record); setParcelMessage("Official Montana cadastral record");
          void loadMinerals(lon, lat);
        } else {
          setParcelMessage("No parcel record returned here"); setMineralsLoading(false);
        }
      } catch { setParcelMessage("Parcel service is temporarily unavailable"); setMineralsLoading(false); }
    });
    map.current = instance;
    void (async () => {
      try {
        const config = await (await fetch("/api/google/config")).json() as { enabled?: boolean; key?: string };
        if (!config.enabled || !config.key) return;
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

  function toggle(key: keyof typeof active) {
    const next = !active[key];
    setActive(a => ({ ...a, [key]: next }));
    if (key === "labels") labelLayers.current.forEach(layer => layer.setVisible(next));
    else overlays.current[key]?.setVisible(next);
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
    setNavTab(tab); setLayers(false); setParcelOpen(false); setClaimOpen(false); setPlaceResults([]);
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
      map.current.getView().fit(selected.getGeometry()!, { padding: [130, 35, 230, 35], duration: 500, maxZoom: 16 });
    }
    setRoute(choice);
  }

  return <main className="shell">
    <div ref={target} className="map" />
    <header>
      <b className="logo">OL</b>
      <form onSubmit={search}><span>⌕</span><input aria-label="Search" placeholder="Where to? Address, place or coordinates" value={query} onChange={e => setQuery(e.target.value)} /><button>{busy ? "…" : "Go"}</button></form>
      <button className="icon" aria-label="Layers" onClick={() => { setNavTab("explore"); setLayers(v => !v); }}>▱</button>
    </header>
    <div className="live"><i/> LIVE PUBLIC DATA · MONTANA · {googleMaps ? "GOOGLE MAPS" : "OPEN MAP"}</div>
    <div className="tools"><button onClick={locate}>⌾</button><button onClick={() => map.current?.getView().adjustZoom(1)}>＋</button><button onClick={() => map.current?.getView().adjustZoom(-1)}>−</button></div>

    {layers && <aside className="panel layer-panel">
      <div className="panel-title"><div><small>MAP DISPLAY</small><h2>Layers</h2></div><button onClick={() => setLayers(false)}>×</button></div>
      <div className="bases">
        <button className={base === "satellite" ? "selected sat" : "sat"} onClick={() => setBase("satellite")}><b>Satellite</b><span>{googleMaps ? "Google" : "2025 NAIP"}</span></button>
        <button className={base === "street" ? "selected streets" : "streets"} onClick={() => setBase("street")}><b>Street</b><span>{googleMaps ? "Google" : "Open map"}</span></button>
      </div>
      <h3>MAP REFERENCE</h3>
      <Layer color="#ffffff" title="Names & map features" sub="Roads, peaks, rivers, creeks, gulches + places" on={active.labels} click={() => toggle("labels")} />
      <h3>LAND INTELLIGENCE</h3>
      <Layer color="#ffb65c" title="Private parcels" sub="Boundaries + owner records" on={active.parcels} click={() => toggle("parcels")} />
      <Layer color="#62f3aa" title="Public lands" sub="BLM, USFS, state + local" on={active.public} click={() => toggle("public")} />
      <Layer color="#e600a9" title="Active mining claims" sub="Official BLM MLRS claim areas" on={active.claims} click={() => toggle("claims")} />
      <Layer color="#c8a7ff" title="Conservation easements" sub="Recorded protected land" on={active.easements} click={() => toggle("easements")} />
      <div className="legend"><span><i className="blm"/>BLM</span><span><i className="usfs"/>USFS</span><span><i className="state"/>State</span><span><i className="local"/>Local</span></div>
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
      <button className="panel-route" onClick={() => routeToMapPoint(claim.CSE_NAME || "Selected mining claim")}>Show routes here ➜</button>
      <p className="record-note">BLM commonly maps claims to the affected PLSS quarter-section. Staked claim boundaries may differ from this display.</p>
    </aside>}

    {parcelOpen && <aside className="panel parcel">
      <button className="close" onClick={() => setParcelOpen(false)}>×</button><small>{parcelMessage}</small>
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
      <div className="destination-buttons"><button className="save-destination" aria-label="Save destination" onClick={saveCurrentDestination}>☆</button><button onClick={navigate}>{route ? "Re-route" : "Navigate"} ➜</button></div>
    </section>}
    {navTab === "explore" && !destination && !parcelOpen && !claimOpen && placeResults.length === 0 && <div className="panel hint"><b>◎</b><span><strong>Tap the map</strong><small>Owners, public land and active mining claims</small></span></div>}

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
        {savedLocations.length ? <div className="saved-list">{savedLocations.map(item => <div key={item.id}><button onClick={() => selectSaved(item)}><span><b>{item.label}</b><small>{item.type} · {item.lat.toFixed(4)}, {item.lon.toFixed(4)}</small></span><em>›</em></button><button aria-label={`Remove ${item.label}`} className="remove-saved" onClick={() => persistSaved(savedLocations.filter(saved => saved.id !== item.id))}>×</button></div>)}</div>
        : <div className="tab-empty"><b>No saved locations yet</b><p>Use the ☆ button on a parcel, claim, place, or destination. Saved items stay on this phone.</p><button onClick={() => openTab("explore")}>Find a place</button></div>}
      </div>}
      {navTab === "more" && <div className="tab-content">
        <div className="quick-grid"><button onClick={() => { openTab("explore"); locate(); }}><b>⌾</b><span>My location</span></button><button onClick={() => { openTab("explore"); setLayers(true); }}><b>▱</b><span>Map layers</span></button><button onClick={() => { setBase(base === "satellite" ? "street" : "satellite"); openTab("explore"); }}><b>◫</b><span>{base === "satellite" ? "Street map" : "Satellite"}</span></button><button onClick={clearMap}><b>⌫</b><span>Clear route</span></button></div>
        <div className="about-card"><small>DATA SOURCES</small><p>Google Maps, Montana State Library cadastral data, BLM MLRS active claims, USGS GNIS geographic names, USGS transportation, and USGS mineral records.</p></div>
        <div className="about-card"><small>IPHONE APP</small><p>In Safari, tap Share, then <b>Add to Home Screen</b> to keep OpenLand beside your other navigation apps.</p></div>
      </div>}
    </section>}

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
