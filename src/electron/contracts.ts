import { z } from "zod";

export const searchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200).transform((value) => value.normalize("NFC")),
  limit: z.number().int().min(1).max(20).default(10)
}).strict();

export const documentRequestSchema = z.object({
  documentId: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export const healthResultSchema = z.object({
  status: z.enum(["ok", "unavailable", "rejected"]),
  snapshotState: z.enum(["fresh", "stale", "incomplete", "rejected", "unavailable"]),
  documentCount: z.number().int().nonnegative(),
  message: z.string().max(240)
}).strict();

export const searchHitSchema = z.object({
  documentId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(300),
  excerpt: z.string().max(500),
  domain: z.string().max(120).nullable(),
  authority: z.enum(["control", "canonical", "current", "redirect", "evidence"])
}).strict();

export const searchResultSchema = z.object({
  hits: z.array(searchHitSchema).max(20),
  snapshotState: z.enum(["fresh", "stale", "incomplete", "rejected", "unavailable"])
}).strict();

export const documentResultSchema = z.object({
  documentId: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().max(300),
  body: z.string(),
  authority: z.enum(["control", "canonical", "current", "redirect", "evidence"])
}).strict();

export const personalOpsResultSchema = z.object({
  tasks: z.object({ total: z.number().int().nonnegative(), byStatus: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  schedule: z.object({ total: z.number().int().nonnegative(), byStatus: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  inbox: z.object({ total: z.number().int().nonnegative(), open: z.number().int().nonnegative() }).strict(),
  issueCount: z.number().int().nonnegative(),
  generatedAt: z.string()
}).strict();

export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type DocumentRequest = z.infer<typeof documentRequestSchema>;
export type HealthResult = z.infer<typeof healthResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type DocumentResult = z.infer<typeof documentResultSchema>;
export type PersonalOpsResult = z.infer<typeof personalOpsResultSchema>;

export interface MnemosyneApi {
  health(): Promise<HealthResult>;
  search(request: SearchRequest): Promise<SearchResult>;
  getDocument(request: DocumentRequest): Promise<DocumentResult>;
  personalOps(): Promise<PersonalOpsResult>;
}

export const IPC_CHANNELS = Object.freeze({
  health: "mnemosyne:health",
  search: "mnemosyne:search",
  getDocument: "mnemosyne:get-document",
  personalOps: "mnemosyne:personal-ops"
});
