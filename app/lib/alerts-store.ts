/**
 * Claim-alert storage on the Site's D1 database (Drizzle). Tested against a real
 * local D1 (Miniflare) in tests/alerts-store.test.mjs.
 */
import { and, count, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "../../db/schema.ts";
import type { Watch } from "./alerts.ts";

type Db = DrizzleD1Database<typeof schema>;
const { alertSends, watches } = schema;
/** D1 allows 100 bound values per query; each sent-row uses 2. */
const SEND_ROWS_PER_INSERT = 40;

export type NewWatch = { email: string; name: string; minLon: number; minLat: number; maxLon: number; maxLat: number; unsubscribeToken: string };

export type AlertsStore = {
  listWatches(email: string): Promise<Watch[]>;
  countWatches(email: string): Promise<number>;
  createWatch(watch: NewWatch): Promise<Watch>;
  /** Delete a watch if it belongs to `email`; false when there's no such watch. */
  deleteWatch(email: string, id: number): Promise<boolean>;
  findByToken(token: string): Promise<Watch | null>;
  deleteByToken(token: string): Promise<boolean>;
  allWatches(): Promise<Watch[]>;
  sentKeys(watchId: number): Promise<Set<string>>;
  recordSends(watchId: number, keys: string[]): Promise<void>;
};

export function alertsStore(db: Db): AlertsStore {
  const removeWatch = async (id: number) => {
    // Delete the sent-log explicitly rather than relying on D1 cascading the foreign key.
    await db.delete(alertSends).where(eq(alertSends.watchId, id));
    await db.delete(watches).where(eq(watches.id, id));
  };
  return {
    listWatches: email => db.select().from(watches).where(eq(watches.email, email)).orderBy(watches.id),
    countWatches: async email => (await db.select({ n: count() }).from(watches).where(eq(watches.email, email)))[0]?.n ?? 0,
    createWatch: async watch => (await db.insert(watches).values(watch).returning())[0],
    deleteWatch: async (email, id) => {
      const [found] = await db.select({ id: watches.id }).from(watches).where(and(eq(watches.id, id), eq(watches.email, email)));
      if (!found) return false;
      await removeWatch(found.id);
      return true;
    },
    findByToken: async token => (await db.select().from(watches).where(eq(watches.unsubscribeToken, token)))[0] ?? null,
    deleteByToken: async token => {
      const [found] = await db.select({ id: watches.id }).from(watches).where(eq(watches.unsubscribeToken, token));
      if (!found) return false;
      await removeWatch(found.id);
      return true;
    },
    allWatches: () => db.select().from(watches).orderBy(watches.id),
    sentKeys: async watchId => new Set((await db.select({ k: alertSends.eventKey }).from(alertSends).where(eq(alertSends.watchId, watchId))).map(r => r.k)),
    recordSends: async (watchId, keys) => {
      for (let i = 0; i < keys.length; i += SEND_ROWS_PER_INSERT) {
        await db.insert(alertSends).values(keys.slice(i, i + SEND_ROWS_PER_INSERT).map(eventKey => ({ watchId, eventKey }))).onConflictDoNothing();
      }
    },
  };
}
