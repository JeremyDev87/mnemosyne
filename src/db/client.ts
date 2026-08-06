export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required for the database adapter");
  return value;
}

export function assertNoDatabaseSideEffect(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MNEMOSYNE_ALLOW_REMOTE_DB === "true") throw new Error("remote database access requires an explicit external-ops lane");
}
