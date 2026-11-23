/** DELETE: remove one of the signed-in person's claim-alert areas. See app/lib/alerts-api.ts. */
import { handleDeleteWatch } from "../../../lib/alerts-api";
import { withAlerts } from "../../../lib/alerts-deps";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return withAlerts(deps => handleDeleteWatch(request, deps, id));
}
