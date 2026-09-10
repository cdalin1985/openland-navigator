export async function GET(request: Request) {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  const query = new URL(request.url).searchParams.get("q")?.trim();

  if (!key) return Response.json({ enabled: false }, { status: 503 });
  if (!query) return Response.json({ error: "q is required" }, { status: 400 });

  const params = new URLSearchParams({ address: query, region: "us", key });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  const data = await response.json() as {
    status?: string;
    error_message?: string;
    results?: Array<{ formatted_address: string; geometry: { location: { lat: number; lng: number } } }>;
  };
  const result = data.results?.[0];

  if (!response.ok || !result) {
    return Response.json({ error: data.error_message || data.status || "No result" }, { status: response.ok ? 404 : response.status });
  }

  return Response.json({
    display_name: result.formatted_address,
    lon: String(result.geometry.location.lng),
    lat: String(result.geometry.location.lat),
  });
}
