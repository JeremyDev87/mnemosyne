export interface RuntimeConfig {
  ownerGithubAccountId: string | undefined;
  databaseUrl: string | undefined;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const rawOwnerId = env.OWNER_GITHUB_ACCOUNT_ID?.trim();
  const ownerGithubAccountId = rawOwnerId ? assertSafeOwnerId(rawOwnerId) : undefined;
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  return { ownerGithubAccountId, databaseUrl };
}

export function assertSafeOwnerId(value: string | undefined): string {
  if (!value || !/^[0-9]+$/.test(value)) throw new Error("OWNER_GITHUB_ACCOUNT_ID must be an immutable numeric GitHub account ID");
  return value;
}
