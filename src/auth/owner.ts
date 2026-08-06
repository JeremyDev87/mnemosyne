export interface OwnerSession {
  authenticated: boolean;
  githubAccountId: string;
  expiresAt: number;
}

export interface OwnerIdentity {
  githubAccountId: string;
}

export type OwnerAuthorizationCode = "UNAUTHENTICATED" | "OWNER_NOT_CONFIGURED" | "NOT_OWNER" | "SESSION_EXPIRED" | "INVALID_OWNER_ID";

export class OwnerAuthorizationError extends Error {
  readonly code: OwnerAuthorizationCode;

  constructor(code: OwnerAuthorizationCode) {
    super(code === "INVALID_OWNER_ID" ? "INVALID_OWNER_ID: owner id must be immutable numeric" : code);
    this.name = "OwnerAuthorizationError";
    this.code = code;
  }
}

export function requireOwner(
  session: OwnerSession | null | undefined,
  configuredOwnerId: string | undefined,
  now = Date.now()
): OwnerIdentity {
  if (!session?.authenticated || !session.githubAccountId) throw new OwnerAuthorizationError("UNAUTHENTICATED");
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now) throw new OwnerAuthorizationError("SESSION_EXPIRED");
  if (!configuredOwnerId) throw new OwnerAuthorizationError("OWNER_NOT_CONFIGURED");
  if (!/^[0-9]+$/.test(configuredOwnerId)) throw new OwnerAuthorizationError("INVALID_OWNER_ID");
  if (session.githubAccountId !== configuredOwnerId) throw new OwnerAuthorizationError("NOT_OWNER");
  return { githubAccountId: session.githubAccountId };
}

export function privateNoStoreHeaders(): Headers {
  return new Headers({ "Cache-Control": "private, no-store", Vary: "Cookie, Authorization" });
}
