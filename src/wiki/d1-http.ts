import type { IndexDatabase, PreparedStatementLike } from "./indexer";

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
}

interface D1Statement extends PreparedStatementLike {
  readonly sql: string;
  readonly params: unknown[];
}

class CloudflareD1PreparedStatement implements D1Statement {
  readonly params: unknown[];

  constructor(readonly sql: string, params: unknown[] = []) {
    this.params = params;
  }

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    return new CloudflareD1PreparedStatement(this.sql, values);
  }
}

interface D1QueryEnvelope {
  success?: boolean;
  results?: unknown[];
  error?: string;
}

interface D1Response {
  success?: boolean;
  result?: D1QueryEnvelope[];
  errors?: Array<{ message?: string }>;
}

export interface D1QueryDatabase {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface D1SchemaObject {
  name: string;
  type: string;
  sql: string | null;
}

export interface D1SchemaColumn {
  name: string;
  type: string;
}

export interface D1ImportStatus {
  state: string;
  documentCount: number;
  manifestHash: string | null;
}

export interface D1IndexedRow {
  path: string;
  hash: string;
}

export interface D1ImportSnapshot {
  objects: D1SchemaObject[];
  wikiPageColumns: D1SchemaColumn[];
  wikiFtsColumns: D1SchemaColumn[];
  indexStatusColumns: D1SchemaColumn[];
  status: D1ImportStatus | null;
  rows: D1IndexedRow[];
}

export class CloudflareD1HttpDatabase implements IndexDatabase, D1QueryDatabase {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: D1HttpConfig) {
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  prepare(sql: string): CloudflareD1PreparedStatement {
    return new CloudflareD1PreparedStatement(sql);
  }

  async batch(statements: D1Statement[]): Promise<void[]> {
    const results: void[] = [];
    for (const statement of statements) {
      await this.execute(statement.sql, statement.params);
      results.push(undefined);
    }
    return results;
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.request(sql, params);
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const envelopes = await this.request(sql, params);
    if (envelopes.length !== 1 || !Array.isArray(envelopes[0]?.results)) {
      throw new Error("Cloudflare D1 query returned a malformed result envelope");
    }
    return envelopes[0].results as T[];
  }

  private async request(sql: string, params: unknown[]): Promise<D1QueryEnvelope[]> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ sql, params })
    });
    const payload = await response.json() as D1Response;
    const nestedErrors = payload.result
      ?.filter((result) => result.success === false)
      .map((result) => result.error)
      .filter((message): message is string => Boolean(message)) ?? [];
    if (!response.ok || payload.success === false || nestedErrors.length > 0) {
      const detail = [
        ...(payload.errors?.map((error) => error.message).filter((message): message is string => Boolean(message)) ?? []),
        ...nestedErrors
      ].join("; ") || `HTTP ${response.status}`;
      throw new Error(`Cloudflare D1 query failed: ${detail}`);
    }
    return payload.result ?? [];
  }
}

export async function readD1ImportSnapshot(database: D1QueryDatabase): Promise<D1ImportSnapshot> {
  const [objects, wikiPageColumns, wikiFtsColumns, indexStatusColumns, statuses, rows] = await Promise.all([
    database.query<D1SchemaObject>(
      "SELECT name, type, sql FROM sqlite_schema WHERE name IN ('wiki_pages', 'wiki_fts', 'index_status', 'wiki_pages_authority_idx') ORDER BY name"
    ),
    database.query<D1SchemaColumn>("PRAGMA table_info(wiki_pages)"),
    database.query<D1SchemaColumn>("PRAGMA table_info(wiki_fts)"),
    database.query<D1SchemaColumn>("PRAGMA table_info(index_status)"),
    database.query<D1ImportStatus>(
      "SELECT state, document_count AS documentCount, manifest_hash AS manifestHash FROM index_status WHERE id = 1"
    ),
    database.query<D1IndexedRow>("SELECT path, hash FROM wiki_pages ORDER BY path")
  ]);
  return {
    objects,
    wikiPageColumns,
    wikiFtsColumns,
    indexStatusColumns,
    status: statuses.length === 1 ? statuses[0]! : null,
    rows
  };
}
