/**
 * Live dependencies for the claim-alert routes: the Site's D1 database and its
 * secrets, read from the Cloudflare runtime. Set these in the Site's settings
 * (Sites in ChatGPT > the site > More actions > Settings), never in code or
 * .openai/hosting.json:
 *   RESEND_API_KEY     Resend API key
 *   ALERTS_FROM        sender, e.g. "OpenLand Alerts <alerts@yourdomain.com>" (domain verified in Resend)
 *   ALERTS_RUN_SECRET  long random string; the same value goes in the GitHub secret of that name
 */
import { env } from "cloudflare:workers";
import { getDb } from "../../db";
import type { AlertsDeps } from "./alerts-api";
import { alertsStore } from "./alerts-store";

type AlertEnv = { RESEND_API_KEY?: string; ALERTS_FROM?: string; ALERTS_RUN_SECRET?: string };

export function liveAlertsDeps(): AlertsDeps {
  const e = env as unknown as AlertEnv;
  return {
    store: alertsStore(getDb()),
    email: { apiKey: e.RESEND_API_KEY, from: e.ALERTS_FROM },
    runSecret: e.ALERTS_RUN_SECRET,
  };
}

/** Run a handler, turning a missing database (alerts not set up on this Site yet) into a clear 503. */
export async function withAlerts(run: (deps: AlertsDeps) => Promise<Response>): Promise<Response> {
  let deps: AlertsDeps;
  try {
    deps = liveAlertsDeps();
  } catch {
    return Response.json({ error: "Claim alerts aren't set up on this site yet (no database)." }, { status: 503 });
  }
  try {
    return await run(deps);
  } catch (err) {
    const message = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}` : "";
    if (/no such table/i.test(message)) return Response.json({ error: "Claim alerts aren't set up on this site yet (database tables missing)." }, { status: 503 });
    return Response.json({ error: "Something went wrong with claim alerts. Try again." }, { status: 500 });
  }
}
