/**
 * D1 tables (Drizzle). Generate the SQL migration after changing this file:
 *   npm run db:generate
 * Sites applies the generated SQL in ./drizzle to the real D1 database on publish.
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Claim-alert watch areas. Each belongs to the email address that Sign in with
 * ChatGPT reported when it was created; alerts for it go to that address.
 */
export const watches = sqliteTable(
  "watches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    minLon: real("min_lon").notNull(),
    minLat: real("min_lat").notNull(),
    maxLon: real("max_lon").notNull(),
    maxLat: real("max_lat").notNull(),
    /** Random secret in every alert email's one-click unsubscribe link. */
    unsubscribeToken: text("unsubscribe_token").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  table => [index("watches_email_idx").on(table.email)],
);

/** Changes already emailed for a watch, so a re-run or a retry never sends one twice. */
export const alertSends = sqliteTable(
  "alert_sends",
  {
    watchId: integer("watch_id").notNull().references(() => watches.id, { onDelete: "cascade" }),
    /** "<date>:<kind>:<BLM case number>", unique per change. */
    eventKey: text("event_key").notNull(),
    sentAt: text("sent_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  table => [primaryKey({ columns: [table.watchId, table.eventKey] })],
);
