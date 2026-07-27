import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const scores = sqliteTable(
  "scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    playerName: text("player_name").notNull(),
    score: integer("score").notNull(),
    tickets: integer("tickets").notNull(),
    boots: integer("boots").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("scores_run_id_unique").on(table.runId),
    index("scores_rank_idx").on(table.score, table.createdAt),
  ],
);

export const scoreRateLimits = sqliteTable(
  "score_rate_limits",
  {
    sessionId: text("session_id").primaryKey(),
    sourceHash: text("source_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("score_rate_limits_source_created_idx").on(
      table.sourceHash,
      table.createdAt,
    ),
  ],
);
