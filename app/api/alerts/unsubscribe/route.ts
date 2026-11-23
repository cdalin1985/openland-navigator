/** GET: confirm page; POST: stop alerts for one area (also mail apps' one-click unsubscribe). See app/lib/alerts-api.ts. */
import { handleUnsubscribe } from "../../../lib/alerts-api";
import { withAlerts } from "../../../lib/alerts-deps";

export async function GET(request: Request) {
  return withAlerts(deps => handleUnsubscribe(request, deps));
}

export async function POST(request: Request) {
  return withAlerts(deps => handleUnsubscribe(request, deps));
}
