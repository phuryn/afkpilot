# Authentication

The relay uses two credentials with different purposes:

- a Clerk session proves the browser user's identity;
- a device token proves that an uplink is the previously linked host.

The browser credential is checked when a device is approved and whenever a browser client connects. The uplink is deliberately session-free: possession of a valid device token is its credential. Ownership and configured access checks are enforced when the browser attaches to that device.

## Session verification

`SessionVerifier` in `src/auth.ts` is the server's narrow verification seam. It returns normalized `SessionClaims` or `null`.

`src/main.ts` selects the implementation:

- with `CLERK_SECRET_KEY`, `ClerkSessionVerifier` calls Clerk's backend `verifyToken()`, optionally pins the issuer, applies the authorized-party rule, and extracts the user ID and user-scoped feature claims;
- without `CLERK_SECRET_KEY`, `MockSessionVerifier(true)` supplies a fixed development user with wildcard features, including when no token is present.

Mock verification is for local contributor use. It is what makes `npm start` useful without a Clerk account; do not use it as evidence that a deployed route is authenticated.

### Session-token transport

REST routes read a session token from `Authorization: Bearer <session-token>`. They may also use the same-origin `__session` cookie.

The browser WebSocket upgrade to `/client` uses the `__session` cookie. Browser WebSocket APIs cannot attach an arbitrary Authorization header, so the remote page relies on ClerkJS to maintain this cookie on the relay origin before opening the socket.

Tokens are verified, not decoded and trusted.

### Authorized-party behavior

`CLERK_AUTHORIZED_PARTIES` is a post-verification `azp` allowlist:

- unset, empty, or `*`: do not apply an `azp` restriction;
- verified token with no `azp`: pass;
- verified token with an `azp`: it must be a string present in the configured comma-separated list.

The absent-`azp` case is intentional. Native sign-in flows produce valid session tokens without an authorized-party claim. A browser-issued token normally carries one. Rejecting only a present-but-unlisted value preserves native sign-in while preventing a token issued for an unexpected web origin from being used.

## Device linking and tokens

`POST /api/link/start` creates a short-lived, one-time link code in memory. The extension opens the corresponding browser page and polls the status endpoint. An authenticated browser approves the code, associating the new device with the verified user.

The returned device token has this shape:

```text
sk-device-<kid>.<secret>
```

`kid` is the public lookup identifier. `secret` is random base64url material. The relay computes HMAC-SHA-256 with `DEVICE_KEYS_PEPPER` over the owning user ID and secret, stores only the key ID and HMAC, and compares verification results in constant time. The plaintext token is returned once to the extension and stored in the host secret store.

Revocation marks the device record revoked and disconnects its active uplink and clients. Device records may be in memory or Supabase; their security semantics are the same.

## WebSocket enforcement

The two upgrades have different trust requirements.

### `/uplink?token=...`

No Clerk session is required. The relay parses and verifies the device token against the device registry, then registers that device in the in-memory `Hub`. A second live uplink for the same device is rejected. The first valid uplink frame must be a compatible `hello`.

This permits a headless IDE or desktop process to reconnect without a browser session while keeping the credential revocable.

### `/client?device=...`

The relay enforces, in order:

1. a requested device ID;
2. a verified browser session;
3. the configured entitlement rule and any enabled fallback limit;
4. ownership of that device by the verified user;
5. successful attachment to the live routing hub.

`RELAY_REQUIRED_FEATURE` controls the entitlement check. When it is unset, the feature gate is open. When it is set, the normalized Clerk feature set must contain that feature unless the configured fallback limit admits the session. A connection with neither required feature nor remaining fallback is rejected.

The relevant WebSocket close codes are:

| Code | Meaning |
| --- | --- |
| `4001` | Invalid or revoked device token on the uplink. |
| `4002` | A live uplink already exists for that device. |
| `4003` | The client did not identify an owned device. |
| `4004` | The client has no verified browser session. |
| `4005` | The configured entitlement/fallback check did not admit the client. |
| `4006` | The uplink did not provide a compatible initial protocol hello. |

The exact frame behavior is maintained in [relay protocol](relay-protocol.md).

## Data boundary

Clerk verifies browser identity; the device registry stores host ownership; the `Hub` holds live sockets. The relay does not persist prompts, source code, responses, or per-message metadata. It stores only device records and aggregate usage counters when Supabase is enabled. See [security](security.md) for the broader threat model and [variables and secrets](variables-secrets.md) for configuration.
