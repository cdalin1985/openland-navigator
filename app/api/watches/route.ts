/** GET: the signed-in person's claim-alert areas. POST { box, name? }: save one. See app/lib/alerts-api.ts. */
import { handleCreateWatch, handleListWatches } from "../../lib/alerts-api";
import { withAlerts } from "../../lib/alerts-deps";

export async function GET(request: Request) {
  return withAlerts(deps => handleListWatches(request, deps));
}

export async function POST(request: Request) {
  return withAlerts(deps => handleCreateWatch(request, deps));
}
