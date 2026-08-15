// Clerk session claims + the verification seam — pure module.
//
// The relay never stores subscription state: Clerk's session token v2 carries
// the user's active plans (`pla`) and enabled features (`fea`) as
// comma-separated scope-prefixed slugs ("u:pro", "uo:remote", "o:dashboard").
// v1 is users-only (no organizations), so only u:/uo:-scoped entries count —
// entitlement checks read the verified JWT and touch nothing else.
//
// server.ts codes against SessionVerifier; main.ts picks the implementation:
// ClerkSessionVerifier (auth-clerk.ts, networkless JWT verify) or the mock
// (dev — everything is MOCK_USER_ID, mirroring the mock DeviceRegistry story).

import { MOCK_USER_ID } from "./devices.js";

export interface SessionClaims {
  userId: string;
  /** Active plan slugs for the USER (u:/uo: scope; o: ignored — no orgs in v1). */
  plans: string[];
  /** Enabled feature slugs for the USER (same scoping). */
  features: string[];
}

/** Split a "u:pro,o:team,uo:remote" claim into user-scoped slugs. */
function userScoped(claim: unknown): string[] {
  if (typeof claim !== "string" || !claim) return [];
  const out: string[] = [];
  for (const entry of claim.split(",")) {
    const [scope, slug] = entry.trim().split(":", 2);
    if ((scope === "u" || scope === "uo") && slug) out.push(slug);
  }
  return out;
}

/** Parse a verified Clerk JWT payload. null = no usable subject. */
export function parseSessionClaims(payload: Record<string, unknown>): SessionClaims | null {
  const sub = payload.sub;
  if (typeof sub !== "string" || !sub) return null;
  return { userId: sub, plans: userScoped(payload.pla), features: userScoped(payload.fea) };
}

export const hasPlan = (c: SessionClaims, slug: string): boolean => c.plans.includes(slug);
export const hasFeature = (c: SessionClaims, slug: string): boolean => c.features.includes(slug);

export interface SessionVerifier {
  /** Verify a session token. null = missing/invalid/expired — never throws. */
  verify(token: string): Promise<SessionClaims | null>;
}

/** Dev verifier: any non-empty token is MOCK_USER_ID with every entitlement.
 *  `permissive` also treats an ABSENT token as the mock user — the dev web pages
 *  don't send session tokens yet, so /client + /api/devices must still work.
 *  main.ts only enables it in mock mode; Clerk mode uses a different class. */
export class MockSessionVerifier implements SessionVerifier {
  constructor(private readonly permissive = false) {}
  async verify(token: string): Promise<SessionClaims | null> {
    if (!token && !this.permissive) return null;
    return { userId: MOCK_USER_ID, plans: [], features: ["*"] };
  }
}

/**
 * The azp (authorized-party) decision, per Clerk's documented semantics: the
 * claim binds a token to the browser origin it was minted for, and "could be
 * omitted" — native (non-browser) sign-ins have no Origin, so their tokens
 * NEVER carry one. Absent azp therefore passes; a PRESENT azp outside the
 * allowlist is a token minted for some other origin and is rejected. With no
 * allowlist configured there is nothing to check. Malformed (non-string but
 * non-null) azp fails closed when an allowlist is configured.
 */
export function azpAllowed(azp: unknown, authorizedParties: string[] | undefined): boolean {
  if (!authorizedParties || authorizedParties.length === 0) return true;
  if (azp === undefined || azp === null) return true;
  return typeof azp === "string" && authorizedParties.includes(azp);
}

/** The entitlement gate. Configured feature unset = gate open (dev / launch
 *  ramp); "*" in features = wildcard (mock verifier). */
export function entitled(claims: SessionClaims, requiredFeature: string | undefined): boolean {
  if (!requiredFeature) return true;
  return claims.features.includes("*") || hasFeature(claims, requiredFeature);
}

/** Pull the session token off an incoming request: Authorization: Bearer
 *  (REST calls from pages) or the __session cookie (what ClerkJS sets on our
 *  origin — and the only thing a browser WebSocket upgrade can carry). */
export function sessionTokenFromRequest(headers: {
  authorization?: string;
  cookie?: string;
}): string {
  const auth = headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  const cookie = headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "__session") return rest.join("=");
    }
  }
  return "";
}
