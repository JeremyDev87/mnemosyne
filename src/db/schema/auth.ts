import { bigint, timestamp, varchar } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";

export const githubAccount = pgTable("github_account", {
  githubAccountId: bigint("github_account_id", { mode: "number" }).primaryKey(),
  loginSnapshot: varchar("login_snapshot", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});
