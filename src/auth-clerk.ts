// Clerk-backed SessionVerifier — the impure edge over @clerk/backend's JWT
// verify. The pure claim shape + entitlement gate live in auth.ts; this module
// only turns a raw token into a verified payload.
//
// Config is injected (constructor deps), never read from process.env here —
// main.ts maps CLERK_SECRET_KEY / CLERK_ISSUER / CLERK_AUTHORIZED_PARTIES onto
// these fields. In @clerk/backend v3 the package-root `verifyToken` RESOLVES to
// the verified JWT payload directly and THROWS on any failure (bad/expired) —
// it does NOT return a { data, errors } wrapper (that shape belongs to the
// internal machine-token verifier). So verify() takes the resolved payload as
// the claims and the try/catch collapses every thrown failure to null.
// verifyToken has no `issuer` option in this version (it's derived from the
// secret key's JWKS), so CLERK_ISSUER is enforced as a post-verify `iss` claim
// check — a belt that pins tokens to our instance. Verified against the live
// dev instance by test/auth-clerk.integration.test.ts.
//
// azp note: the library's own authorizedParties option REQUIRES the token to
// carry an allowlisted `azp` — but Clerk omits the claim entirely for native
// (non-Origin) sign-ins, and native FAPI forbids sending Origin alongside
// Authorization, so a non-browser client can NEVER produce one. That made the
// deployed relay reject every legitimately signed-in native session (found by
// the auth canary, 2026-08-14). So azp is enforced HERE as a post-verify check
// with Clerk's documented semantics (auth.ts azpAllowed): absent azp passes,
// present-but-unlisted azp — a token minted for some other origin — rejects.
// Boundary stated precisely: ClerkJS browser tokens carry azp whenever the
// browser sent an Origin (normal operation); Clerk documents privacy cases
// where it is omitted, and such tokens now verify like native ones
// (signature + expiry + issuer pin still apply). azp is a supplementary
// origin-binding belt, not the load-bearing gate.

import { verifyToken } from "@clerk/backend";
import { azpAllowed, parseSessionClaims, type SessionClaims, type SessionVerifier } from "./auth.js";

export interface ClerkSessionVerifierDeps {
  /** CLERK_SECRET_KEY — authorizes the JWKS fetch + selects the instance. */
  secretKey: string;
  /** CLERK_ISSUER — expected `iss`; set = reject tokens from any other instance. */
  issuer?: string;
  /** CLERK_AUTHORIZED_PARTIES — allowlist a PRESENT azp must match; absent azp
   *  (native sign-ins) passes. undefined/empty = don't check. */
  authorizedParties?: string[];
}

export class ClerkSessionVerifier implements SessionVerifier {
  constructor(private readonly deps: ClerkSessionVerifierDeps) {}

  async verify(token: string): Promise<SessionClaims | null> {
    if (!token) return null;
    try {
      // verifyToken RESOLVES to the verified payload and THROWS on failure.
      // authorizedParties deliberately NOT passed — see the azp note above.
      const payload = await verifyToken(token, {
        secretKey: this.deps.secretKey,
      });
      const claims = payload as unknown as Record<string, unknown>;
      if (this.deps.issuer && claims.iss !== this.deps.issuer) return null;
      if (!azpAllowed(claims.azp, this.deps.authorizedParties)) return null;
      return parseSessionClaims(claims);
    } catch {
      return null;
    }
  }
}
