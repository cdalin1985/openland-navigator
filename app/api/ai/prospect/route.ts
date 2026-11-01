import { NextResponse } from "next/server";
async function getElev(lon: number, lat: number) {
  try { const d = await (await fetch(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet&includeDate=false`)).json(); return Math.round(Number(d.value)); } catch { return null; }
}
export async function POST(req: Request) {
  try {
    const b = await req.json();
    const key = b.apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
    if (!key) return NextResponse.json({ error: "MISSING_KEY" }, { status: 400 });
    const z = 17, xT = Math.floor(((b.lon + 180) / 360) * Math.pow(2, z)), r = b.lat * Math.PI / 180, yT = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
    const [spotElev, tileBuf, ...mineElevs] = await Promise.all([
      getElev(b.lon, b.lat),
      fetch(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/17/${yT}/${xT}`).then(res => res.arrayBuffer()).catch(() => null),
      ...(b.mines || []).slice(0, 3).map((m: any) => m.lon && m.lat ? getElev(m.lon, m.lat) : Promise.resolve(null))
    ]);
    const mineSummary = (b.mines || []).slice(0, 3).map((m: any, i: number) => `${m.name} (${m.commodities?.join("/") || m.status}, ${m.distanceMiles} mi away, Elev: ${mineElevs[i] ? mineElevs[i] + " ft" : "?"} -> ${mineElevs[i] && spotElev ? (mineElevs[i] > spotElev ? "UPHILL by " + (mineElevs[i] - spotElev) + " ft [CAN FEED GOLD DOWN]" : "DOWNHILL by " + (spotElev - mineElevs[i]) + " ft [CANNOT WASH UPHILL]") : ""})`).join("; ");
    const prompt = `You are a brutally honest 30-year Montana mining geologist. Analyze this spot (GPS: ${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}, Elev: ${spotElev || "?"} ft) and the attached Zoom-17 Summer Aerial photo.
Data: Owner=${b.owner || "Public"} | Active Claims=${b.activeCount} | Lapsed Claims=${b.lapsedNames || "None"} | Nearby USGS Mines=${mineSummary || "None"} | Creek Bends=${b.bends || "None"}
Give a short, punchy 4-part field report:
1. GRADE (A+ to F) & GRAVITY CHECK: Can gold wash DOWNHILL from those USGS mines to ${spotElev} ft, or is it barren/uphill?
2. AERIAL PHOTO READOUT: What is physically visible in the photo (creek channel, gravel bars, trees, road pull-offs, or dry hillside)?
3. WHERE TO DIG FIRST: Exact beginner instructions (where to park & put your shovel) and legality ($0 casual panning vs claim).
4. FLIP VERDICT: Worth $225 to stake & flip or skip?`;
    const parts: any[] = [{ text: prompt }];
    if (tileBuf) parts.push({ inlineData: { mimeType: "image/jpeg", data: Buffer.from(tileBuf).toString("base64") } });
    const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) });
    let gData = await gRes.json();
    if (gData?.error) {
      const mList = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`)).json();
      const fallbacks = (mList.models || []).filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent") && /gemini/i.test(m.name) && !/2\.5-flash$|3\.0-flash$/i.test(m.name)).map((m: any) => m.name);
      for (const fb of fallbacks.slice(0, 3)) {
        const r2 = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/${fb}:generateContent?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }] }) })).json();
        if (r2?.candidates?.[0]?.content?.parts?.[0]?.text) { gData = r2; break; }
      }
    }
    const rawText = gData?.candidates?.[0]?.content?.parts?.[0]?.text || gData?.error?.message || "Retry in 30s.";
    const text = `⛰️ USGS ELEVATION: ${spotElev || "?"} ft\n📍 GRAVITY CHECK: ${mineSummary || "No nearby mines"}\n\n` + rawText;
    return NextResponse.json({ report: text, spotElev });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 500 }); }
}