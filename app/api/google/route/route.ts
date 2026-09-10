type Coordinate = [number, number];
type GoogleRoute = {
  distanceMeters?: number;
  duration?: string;
  polyline?: { encodedPolyline?: string };
  routeLabels?: string[];
};

export async function POST(request: Request) {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return Response.json({ enabled: false }, { status: 503 });

  const payload = await request.json() as { origin?: Coordinate; destination?: Coordinate };
  if (!valid(payload.origin) || !valid(payload.destination)) {
    return Response.json({ error: "Valid origin and destination coordinates are required" }, { status: 400 });
  }

  const [originLongitude, originLatitude] = payload.origin;
  const [destinationLongitude, destinationLatitude] = payload.destination;
  const baseRequest = {
    origin: { location: { latLng: { latitude: originLatitude, longitude: originLongitude } } },
    destination: { location: { latLng: { latitude: destinationLatitude, longitude: destinationLongitude } } },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    polylineQuality: "HIGH_QUALITY",
    languageCode: "en-US",
    units: "IMPERIAL",
  };

  const requests = await Promise.all([
    compute(key, { ...baseRequest, computeAlternativeRoutes: true }),
    compute(key, { ...baseRequest, computeAlternativeRoutes: false, routeModifiers: { avoidHighways: true } }),
    compute(key, { ...baseRequest, computeAlternativeRoutes: false, routeModifiers: { avoidTolls: true } }),
  ]);

  const candidates: Array<GoogleRoute & { optionLabel: string }> = [];
  requests[0].routes?.forEach((route, index) => candidates.push({
    ...route,
    optionLabel: index === 0 ? "Recommended" : `Alternative ${index + 1}`,
  }));
  if (requests[1].routes?.[0]) candidates.push({ ...requests[1].routes[0], optionLabel: "Avoid highways" });
  if (requests[2].routes?.[0]) candidates.push({ ...requests[2].routes[0], optionLabel: "Avoid tolls" });

  const seen = new Set<string>();
  const routes = candidates.filter(route => {
    const encoded = route.polyline?.encodedPolyline;
    if (!encoded || seen.has(encoded)) return false;
    seen.add(encoded);
    return true;
  }).slice(0, 5);

  if (!routes.length) {
    const failed = requests.find(result => result.error);
    return Response.json({ error: failed?.error || "No routes found" }, { status: 502 });
  }
  return Response.json({ routes });
}

async function compute(key: string, body: Record<string, unknown>) {
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.routeLabels",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json() as { routes?: GoogleRoute[]; error?: { message?: string } };
  return { routes: data.routes, error: response.ok ? undefined : data.error?.message || `Google Routes error ${response.status}` };
}

function valid(value: Coordinate | undefined): value is Coordinate {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}
