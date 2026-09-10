type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryTypeDisplayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  currentOpeningHours?: { openNow?: boolean; weekdayDescriptions?: string[] };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
};

export async function GET(request: Request) {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim();
  const latitude = Number(url.searchParams.get("lat"));
  const longitude = Number(url.searchParams.get("lon"));

  if (!key) return Response.json({ enabled: false }, { status: 503 });
  if (!query) return Response.json({ error: "q is required" }, { status: 400 });

  const body: Record<string, unknown> = {
    textQuery: query,
    pageSize: 6,
    regionCode: "US",
    languageCode: "en",
  };
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    body.locationBias = {
      circle: { center: { latitude, longitude }, radius: 50000 },
    };
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.primaryTypeDisplayName",
        "places.rating",
        "places.userRatingCount",
        "places.currentOpeningHours",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.googleMapsUri",
      ].join(","),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json() as { places?: GooglePlace[]; error?: { message?: string } };
  if (!response.ok) {
    return Response.json({ error: data.error?.message || "Places search failed" }, { status: response.status });
  }

  const places = (data.places || []).flatMap(place => {
    const lat = place.location?.latitude;
    const lon = place.location?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return [];
    return [{
      id: place.id || `${lat},${lon}`,
      name: place.displayName?.text || "Unnamed place",
      address: place.formattedAddress || "Address unavailable",
      lat,
      lon,
      category: place.primaryTypeDisplayName?.text || "Place",
      rating: place.rating,
      ratingCount: place.userRatingCount,
      openNow: place.currentOpeningHours?.openNow,
      hours: place.currentOpeningHours?.weekdayDescriptions || [],
      phone: place.nationalPhoneNumber,
      website: place.websiteUri,
      googleMapsUrl: place.googleMapsUri,
    }];
  });

  return Response.json({ places });
}
