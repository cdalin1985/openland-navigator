export async function GET() {
  const key = process.env.GOOGLE_MAPS_BROWSER_KEY;

  if (!key) {
    return Response.json({ enabled: false });
  }

  return Response.json({ enabled: true, key });
}
