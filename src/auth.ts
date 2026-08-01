import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthConfig {
  ENVIRONMENT?: string;
  AUTH_MODE?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
}

export interface Identity { email: string; subject: string }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function allowedEmails(config: AuthConfig): Set<string> {
  return new Set((config.ALLOWED_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export async function requireIdentity(request: Request, config: AuthConfig): Promise<Identity> {
  const allowed = allowedEmails(config);
  if (config.AUTH_MODE === "test" && config.ENVIRONMENT === "test") {
    const email = request.headers.get("x-mnemosyne-test-user")?.toLowerCase();
    if (!email || !allowed.has(email)) throw new Response("Forbidden", { status: 403 });
    return { email, subject: `test:${email}` };
  }

  if (config.AUTH_MODE !== "access") throw new Response("Authentication is not configured", { status: 503 });
  const domain = config.CF_ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const audience = config.CF_ACCESS_AUD;
  if (!domain || !audience || allowed.size === 0) throw new Response("Authentication is not configured", { status: 503 });
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) throw new Response("Unauthorized", { status: 401 });

  const issuer = `https://${domain}`;
  let keySet = keySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keySet);
  }
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keySet, { issuer, audience }));
  } catch {
    throw new Response("Unauthorized", { status: 401 });
  }
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email || !allowed.has(email)) throw new Response("Forbidden", { status: 403 });
  return { email, subject: payload.sub ?? email };
}
