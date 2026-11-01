/**
 * Same-origin guard for API routes that spend paid quota (Google Maps, Gemini).
 *
 * Browsers send `Sec-Fetch-Site` on every request. Anything other than
 * "same-origin" (or "none", for a URL typed into the address bar) means
 * another site's page is calling us, so the request is refused. That stops
 * other websites spending our quota through their visitors' browsers.
 *
 * It does NOT stop scripted abuse: curl sends no such header. That needs
 * real authentication plus a rate-limit store (KV or D1), which this app
 * doesn't have yet.
 */
export function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return Response.json({ error: "Cross-site requests are not allowed" }, { status: 403 });
  }
  return null;
}
