import type { IndexDatabase, PreparedStatementLike } from "./indexer";

interface D1HttpConfig {
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

interface D1Response {
  success?: boolean;
  errors?: Array<{ message?: string }>;
}

export class CloudflareD1HttpDatabase implements IndexDatabase {
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
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ sql, params })
    });
    const payload = await response.json() as D1Response;
    if (!response.ok || payload.success === false) {
      const detail = payload.errors?.map((error) => error.message).filter(Boolean).join("; ") || `HTTP ${response.status}`;
      throw new Error(`Cloudflare D1 query failed: ${detail}`);
    }
  }
}
