import { pgTable, text, timestamp, uuid, integer, bigint, varchar, primaryKey } from "drizzle-orm/pg-core";

export const snapshotGeneration = pgTable("snapshot_generation", {
  id: uuid("id").primaryKey(),
  sequence: bigint("sequence", { mode: "number" }).notNull().unique(),
  state: varchar("state", { length: 16 }).notNull(),
  policyDigest: varchar("policy_digest", { length: 64 }).notNull(),
  expectedCount: integer("expected_count").notNull(),
  expectedBytes: bigint("expected_bytes", { mode: "number" }).notNull(),
  expectedTreeHash: varchar("expected_tree_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true })
});

export const snapshotEntry = pgTable("snapshot_entry", {
  generationId: uuid("generation_id").notNull().references(() => snapshotGeneration.id),
  documentId: varchar("document_id", { length: 256 }).notNull(),
  relativePath: varchar("relative_path", { length: 512 }).notNull(),
  state: varchar("state", { length: 16 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  bytes: integer("bytes").notNull(),
  content: text("content").notNull(),
  provenance: varchar("provenance", { length: 128 }).notNull()
}, (table) => ({ pk: primaryKey({ columns: [table.generationId, table.documentId] }) }));

export const activeSnapshot = pgTable("active_snapshot", {
  singleton: integer("singleton").primaryKey(),
  generationId: uuid("generation_id").notNull().references(() => snapshotGeneration.id),
  sequence: bigint("sequence", { mode: "number" }).notNull()
});

export const ingestIdempotency = pgTable("ingest_idempotency", {
  key: varchar("key", { length: 256 }).primaryKey(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
});
