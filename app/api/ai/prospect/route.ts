/**
 * POST /api/ai/prospect: upstream gold evidence for a point, plus an optional AI photo read.
 *
 * Always returns the deterministic USGS evidence from app/lib/geologist.ts
 * (mines in the creek's upstream basin, creek gradient, elevation); no key
 * needed. If the caller sends their own Gemini key, Gemini also describes a
 * 2025 NAIP aerial photo centred on the point, as structured JSON. The model
 * never decides legality, grades the spot, or prices a claim. There is
 * deliberately no server-key fallback until this route has auth and rate limits.
 */
import { NextResponse } from "next/server";
import { formatEvidence, upstreamEvidence, type UpstreamEvidence } from "../../../lib/geologist";
import { NAIP_2025_URL, feetPerDegree } from "../../../lib/land-status";
import { rejectCrossSite } from "../../../lib/same-origin";

/** Listed on ai.google.dev/gemini-api/docs/models as of 2026-11-01. */
const MODEL = "gemini-3.8-flash";
/** Half-width of the aerial image in metres (the image covers about 300 m × 300 m). */
const IMAGE_HALF_WIDTH_M = 150;

type Body = { lon?: unknown; lat?: unknown; apiKey?: unknown };
type Part = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};
type PhotoRead = { photo?: string; where_to_look?: string[]; unknowns?: string[]; image_quality?: string };

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Gemini response schema (OpenAPI subset, as in the generateContent reference). */
const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    photo: { type: "string", description: "What is visible: stream channel, gravel bars, exposed bedrock, old workings or tailings, roads or pull-offs, vegetation. Say plainly if unclear." },
    where_to_look: { type: "array", items: { type: "string" }, description: "Up to 3 places a beginner could look first, each tied to something visible in the photo. Empty if nothing is visible." },
    unknowns: { type: "array", items: { type: "string" }, description: "The biggest things this photo and data cannot tell you." },
    image_quality: { type: "string", description: "good, fair or poor" },
  },
  required: ["photo", "where_to_look", "unknowns", "image_quality"],
};

/** A 512 px 2025 NAIP aerial image (USDA, ~0.3 m/pixel, Montana State Library) centred on the point, or null. */
async function getAerial(lon: number, lat: number): Promise<{ mimeType: string; data: string } | null> {
  const k = feetPerDegree(lat);
  const dLat = IMAGE_HALF_WIDTH_M / 0.3048 / k.lat;
  const dLon = IMAGE_HALF_WIDTH_M / 0.3048 / k.lon;
  const params = new URLSearchParams({
    bbox: `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`,
    bboxSR: "4326", imageSR: "3857", size: "512,512", format: "jpg", f: "image",
  });
  try {
    const res = await fetch(`${NAIP_2025_URL}/exportImage?${params}`, { signal: AbortSignal.timeout(15000) });
    const mimeType = res.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!res.ok || !mimeType.startsWith("image/")) return null;
    return { mimeType, data: Buffer.from(await res.arrayBuffer()).toString("base64") };
  } catch {
    return null;
  }
}

/** Facts the model may use, stated so it can't mistake them for a verdict. */
function evidenceForPrompt(e: UpstreamEvidence): string {
  const g = e.gradient;
  return [
    `Upstream USGS mineral records (inside this creek's drainage basin): evidence level "${e.level}"; past-producing gold mines: ${e.producers.join(", ") || "none"}; gold prospects: ${e.prospects.join(", ") || "none"}.`,
    g ? `Creek slope: ${g.upstreamPct.toFixed(1)}% just upstream, ${g.downstreamPct.toFixed(1)}% just downstream${g.flattens ? " (flattens here)" : ""}.` : "Creek slope: not measured.",
  ].join(" ");
}

/** Format the model's structured photo read; falls back to its raw text if it isn't valid JSON. */
function formatPhotoRead(text: string): string {
  let read: PhotoRead | null = null;
  try {
    read = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as PhotoRead;
  } catch {
    read = null;
  }
  const bullets = (items?: string[]) => (items?.length ? items.slice(0, 4).map(i => `  • ${i}`).join("\n") : "  • (nothing stated)");
  if (!read || typeof read.photo !== "string") return `🤖 AI PHOTO READ (Gemini · 2025 NAIP aerial)\n${text}`;
  return [
    "🤖 AI PHOTO READ (Gemini · 2025 NAIP aerial, centred on your spot)",
    `What the photo shows: ${read.photo}`,
    "Where to look first (only if the land check says it's open):",
    bullets(read.where_to_look),
    "What this can't tell you:",
    bullets(read.unknowns),
    `Image quality: ${read.image_quality ?? "not stated"}`,
  ].join("\n");
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

  const [evidence, aerial] = await Promise.all([upstreamEvidence(lon, lat), key ? getAerial(lon, lat) : Promise.resolve(null)]);
  const evidenceText = formatEvidence(evidence);
  if (!key) {
    return NextResponse.json({ report: `${evidenceText}\n\n🔑 Add your Gemini key for an AI read of the 2025 aerial photo of this spot.`, evidence });
  }

  const prompt = [
    `You are a careful field geologist helping a beginner gold panner in Montana. Point: ${lat.toFixed(5)}, ${lon.toFixed(5)}.`,
    aerial ? "The attached image is a 2025 summer aerial photo (USDA NAIP), about 300 m across, centred exactly on the point. North is up." : "No aerial image was available; say so in 'photo'.",
    `Known facts from USGS records (already computed; do not restate them as your own conclusions): ${evidenceForPrompt(evidence)}`,
    "Describe only what the photo shows and where a beginner could look first if the land is open: inside bends, the upstream end of gravel bars, bedrock cracks, behind boulders.",
    "Do NOT say whether digging, panning or staking is legal. Do NOT grade the spot. Do NOT estimate claim value or a sale price.",
  ].join("\n");
  const parts: Part[] = [{ text: prompt }];
  if (aerial) parts.push({ inlineData: aerial });

  try {
    const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: "application/json", responseSchema: PHOTO_SCHEMA },
      }),
      signal: AbortSignal.timeout(45000),
    });
    const gData = (await gRes.json()) as GeminiResponse;
    const text = gData.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("").trim();
    if (!gRes.ok || !text) {
      const reason = gData.error?.message || `Gemini error ${gRes.status}`;
      return NextResponse.json({ report: `${evidenceText}\n\n🤖 AI photo read unavailable: ${reason}`, evidence });
    }
    return NextResponse.json({ report: `${evidenceText}\n\n${formatPhotoRead(text)}`, evidence });
  } catch (e) {
    const reason = e instanceof Error ? e.message : "request failed";
    return NextResponse.json({ report: `${evidenceText}\n\n🤖 AI photo read unavailable: ${reason}`, evidence });
  }
}
