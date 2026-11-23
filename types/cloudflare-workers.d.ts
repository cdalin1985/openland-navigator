/**
 * Minimal types for the Cloudflare Workers runtime module the app imports
 * (db/index.ts, app/lib/alerts-deps.ts). The full @cloudflare/workers-types
 * package isn't installed; this covers only what the code uses.
 */
declare module "cloudflare:workers" {
  import type { AnyD1Database } from "drizzle-orm/d1";
  /** The running Worker's bindings and variables: the D1 database `DB`, plus Site secrets. */
  export const env: { DB?: AnyD1Database } & Record<string, unknown>;
}
