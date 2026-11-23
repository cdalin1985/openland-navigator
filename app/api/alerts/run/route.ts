/** POST: email watch areas their new claim changes (called by the nightly GitHub workflow). See app/lib/alerts-api.ts. */
import { handleRun } from "../../../lib/alerts-api";
import { withAlerts } from "../../../lib/alerts-deps";

export async function POST(request: Request) {
  return withAlerts(deps => handleRun(request, deps));
}
