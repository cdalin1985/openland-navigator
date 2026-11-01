/**
 * POST /api/ai/prospect: describe the aerial photo and nearby USGS records for one point.
 *
 * The model only describes what it can see. It is never asked whether digging
 * or staking is legal, never asked for a grade, and never asked for a claim
 * value; land status comes from the deterministic checks in
 * app/lib/land-status.ts. The caller must send their own Gemini key: there is
 * deliberately no server-key fallback until this route has auth and rate limits.
 */
import { NextResponse } from "next/server";
import { rejectCrossSite } from "../../../lib/same-origin";

/** Listed on ai.google.dev/gemini-api/docs/models as of 2026-11-01. */
const MODEL = "gemini-3.8-flash";

type Mine = { name?: unknown; status?: unknown; commodities?: unknown; distanceMiles?: unknown; lon?: unknown; lat?: unknown };
type Body = { lon?: unknown; lat?: unknown; mines?: unknown; bends?: unknown; apiKey?: unknown };
type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** USGS 3DEP point elevation in feet, or null if unavailable or out of a plausible range. */
async function getElevationFt(lon: number, lat: number): Promise<number | null> {
  try {
    const res = await fetch(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet&includeDate=false`);
    if (!res.ok) return null;
    const value = Number(((await res.json()) as { value?: unknown }).value);
    return Number.isFinite(value) && value > -1000 && value < 20000 ? Math.round(value) : null;
  } catch {
    return null;
  }
}

/** The zoom-17 Esri World Imagery tile containing the point (about 210 m across at 47°N), or null. */
async function getTile(lon: number, lat: number): Promise<{ mimeType: string; data: string } | null> {
  const z = 17;
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  try {
    const res = await fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`);
    const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!res.ok || !mimeType.startsWith("image/")) return null;
    return { mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const blocked = rejectCrossSite(req);
  if (blocked) return blocked;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const lon = num(body.lon);
  const lat = num(body.lat);
  if (lon === null || lat === null || lat < 44 || lat > 49.5 || lon < -116.5 || lon > -103.5) {
    return NextResponse.json({ error: "lat and lon must be numbers inside Montana" }, { status: 400 });
  }
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!key) return NextResponse.json({ error: "MISSING_KEY" }, { status: 400 });

  const mines = (Array.isArray(body.mines) ? (body.mines as Mine[]) : []).slice(0, 3).flatMap(m => {
    const mLon = num(m.lon);
    const mLat = num(m.lat);
    if (mLon === null || mLat === null) return [];
    return [{
      name: String(m.name ?? "Unnamed").slice(0, 80),
      status: String(m.status ?? "").slice(0, 40),
      commodities: Array.isArray(m.commodities) ? m.commodities.map(String).slice(0, 4).join("/") : "",
      distanceMiles: num(m.distanceMiles),
      lon: mLon,
      lat: mLat,
    }];
  });
  const bends = typeof body.bends === "string" ? body.bends.slice(0, 600) : "";

  const [spotElev, tile, ...mineElevs] = await Promise.all([
    getElevationFt(lon, lat),
    getTile(lon, lat),
    ...mines.map(m => getElevationFt(m.lon, m.lat)),
  ]);
  const mineSummary = mines.map((m, i) => {
    const elev = mineElevs[i] as number | null;
    const relative = elev !== null && spotElev !== null
      ? `${Math.abs(elev - spotElev)} ft ${elev > spotElev ? "higher" : "lower"} than this spot`
      : "elevation unknown";
    return `${m.name} (${m.commodities || m.status || "commodity not listed"}, ${m.distanceMiles ?? "?"} mi away, ${relative}; same drainage NOT checked)`;
  }).join("; ");

  const prompt = [
    `You are a careful field geologist describing a Montana location for a beginner gold panner. Point: ${lat.toFixed(5)}, ${lon.toFixed(5)}, elevation ${spotElev ?? "unknown"} ft.`,
    tile
      ? "The attached image is one aerial map tile, roughly 200 m across, that contains the point somewhere inside it. The point is not marked and may not be centred."
      : "No aerial image was available.",
    `Nearby USGS mineral records (straight-line distance; whether they drain to this creek has NOT been checked): ${mineSummary || "none"}.`,
    `Candidate creek bends from USGS stream lines: ${bends || "none"}.`,
    "Reply in 3 short sections:",
    "1. WHAT THE PHOTO SHOWS: channel, gravel bars, exposed bedrock, old workings or tailings, roads or pull-offs, vegetation. Say plainly if the image is unclear.",
    "2. WHERE A BEGINNER COULD LOOK FIRST, IF THE APP'S LAND CHECK SAYS IT IS OPEN: inside bends, bar heads, bedrock cracks, behind boulders. Tie each to something visible, or say nothing is visible.",
    "3. WHAT THIS CAN'T TELL YOU: the biggest unknowns.",
    "Do NOT say whether digging, panning or staking is legal. Do NOT grade the spot. Do NOT estimate claim value or a sale price. Land status is checked separately by the app.",
  ].join("\n");

  const parts: Part[] = [{ text: prompt }];
  if (tile) parts.push({ inlineData: tile });

  try {
    const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts }] }),
    });
    const gData = (await gRes.json()) as GeminiResponse;
    const text = gData.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("").trim();
    if (!gRes.ok || !text) {
      return NextResponse.json({ error: gData.error?.message || `Gemini error ${gRes.status}` }, { status: gRes.ok ? 502 : gRes.status });
    }
    const header = `⛰️ USGS ELEVATION: ${spotElev ?? "?"} ft\n📍 NEARBY USGS RECORDS: ${mineSummary || "none"}\n\n`;
    return NextResponse.json({ report: header + text, spotElev });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI request failed" }, { status: 502 });
  }
}
