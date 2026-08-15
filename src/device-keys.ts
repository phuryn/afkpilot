// Device key scheme — pure module (ported from a sibling project's API keys).
//
// A device token is `sk-device-<kid>.<secret>`: kid is a random UUID (the db
// lookup key), secret is 32 random bytes base64url. The database stores only
// kid + hmac, never the secret — hmac = base64url(HMAC-SHA256(pepper,
// userId+secret)). Mixing the owner's userId into the MAC binds the token to
// its account: a leaked row can't be replayed under a different user, because
// verify recomputes the MAC with the ROW's user_id and the PRESENTED secret and
// compares in constant time. Deps (randomUUID, randomBytes) are injected so the
// format round-trips deterministically in tests.

import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sk-device-";

export interface DeviceKeyDeps {
  randomUUID: () => string;
  randomBytes: (size: number) => Buffer;
}

/** Mint a fresh device key. token is what VS Code stores; kid+secret are the parts. */
export function issueDeviceKey(deps: DeviceKeyDeps): { kid: string; secret: string; token: string } {
  const kid = deps.randomUUID();
  const secret = deps.randomBytes(32).toString("base64url");
  return { kid, secret, token: `${PREFIX}${kid}.${secret}` };
}

/** Split a presented token back into {kid, secret}. null for anything malformed
 *  (wrong prefix, no dot, empty half) — callers must not hit the db on null. */
export function parseDeviceToken(token: string): { kid: string; secret: string } | null {
  if (!token.startsWith(PREFIX)) return null;
  const rest = token.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot >= rest.length - 1) return null; // need a non-empty kid AND secret
  return { kid: rest.slice(0, dot), secret: rest.slice(dot + 1) };
}

/** The stored MAC. userId is mixed in so the token is bound to its owner. */
export function hmacDeviceSecret(userId: string, secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${userId}${secret}`).digest("base64url");
}

/** Constant-time string compare — length-checked first (timingSafeEqual throws
 *  on unequal-length buffers), never an early-returning byte compare. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
