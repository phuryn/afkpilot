// Live-Clerk canaries — pin the ONE assumption fake verifiers can't: the real
// wire shape of Clerk session-token claims (pla/fea) for the two dev test
// users, and that ClerkSessionVerifier + the relay's gates read them right.
// Runs only when .env carries CLERK_SECRET_KEY (skips otherwise), against the
// dev instance's test users:
//   first+clerk_test@example.com  — signed up, NO plan/feature
//   second+clerk_test@example.com — subscribed to Remote Max (feature "remote")
//
// Backend-minted tokens (sessions.createSession + getToken) carry NO azp
// claim — same as every native (non-browser) sign-in, which can never produce
// one. Since 2026-08-14 the verifier enforces azp itself (azpAllowed): absent
// azp PASSES even with authorizedParties configured — pinned live below,
// because the deployed relay used to 401 every native session (found by the
// auth canary). Present-but-unlisted azp still rejects (unit-tested in
// auth.test.ts; only a real browser mints a present azp).
// Session JWTs live ~60s: each test minting is close enough to its assertions.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClerkClient, type ClerkClient } from "@clerk/backend";
import { ClerkSessionVerifier } from "../src/auth-clerk.js";
import { entitled, hasFeature } from "../src/auth.js";
import { LinkStore, makeLinkCode } from "../src/link-store.js";
import { InMemoryDeviceRegistry } from "../src/devices.js";
import { Hub } from "../src/hub.js";
import { createRelayServer, CLOSE_ENTITLEMENT_REQUIRED, type RelayServer } from "../src/server.js";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const secretKey = process.env.CLERK_SECRET_KEY;
const issuer = process.env.CLERK_ISSUER || undefined;
const enabled = !!secretKey;

const FEATURE = "remote";
const FIRST = "first+clerk_test@example.com";
const SECOND = "second+clerk_test@example.com";
const SLOW = 30_000; // real network; generous so a slow Clerk API can't flake us

const clerk: ClerkClient | null = enabled ? createClerkClient({ secretKey: secretKey! }) : null;
const mintedSessions: string[] = [];

async function mint(email: string): Promise<{ userId: string; token: string }> {
  const { data: users } = await clerk!.users.getUserList({ emailAddress: [email] });
  if (users.length !== 1) throw new Error(`Clerk dev instance must have exactly one user ${email} (found ${users.length})`);
  const session = await clerk!.sessions.createSession({ userId: users[0].id });
  mintedSessions.push(session.id);
  const { jwt } = await clerk!.sessions.getToken(session.id);
  if (!jwt) throw new Error(`no jwt for ${email}'s session`);
  return { userId: users[0].id, token: jwt };
}

const rawPayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

const verifier = () => new ClerkSessionVerifier({ secretKey: secretKey!, issuer, authorizedParties: undefined });

let first: { userId: string; token: string };
let second: { userId: string; token: string };

beforeAll(async () => {
  if (!enabled) return;
  [first, second] = await Promise.all([mint(FIRST), mint(SECOND)]);
}, SLOW);

afterAll(async () => {
  // Best-effort: revoked sessions can't outlive the test run.
  for (const id of mintedSessions) {
    try {
      await clerk!.sessions.revokeSession(id);
    } catch {
      /* already expired / rate-limited — fine */
    }
  }
}, SLOW);

describe.skipIf(!enabled)("ClerkSessionVerifier (live dev instance)", () => {
  it(
    "verifies real tokens and reads the pla/fea wire format the way src/auth.ts bets",
    async () => {
      const v = verifier();
      const firstClaims = await v.verify(first.token);
      const secondClaims = await v.verify(second.token);

      // Show the true wire strings in the report — this is the canary's point.
      console.log(`[canary] ${FIRST}: pla=${JSON.stringify(rawPayload(first.token).pla)} fea=${JSON.stringify(rawPayload(first.token).fea)}`);
      console.log(`[canary] ${SECOND}: pla=${JSON.stringify(rawPayload(second.token).pla)} fea=${JSON.stringify(rawPayload(second.token).fea)}`);

      expect(firstClaims).not.toBeNull();
      expect(secondClaims).not.toBeNull();
      expect(firstClaims!.userId).toBe(first.userId);
      expect(secondClaims!.userId).toBe(second.userId);
      expect(firstClaims!.userId).not.toBe(secondClaims!.userId);

      // The entitlement bit differs in exactly the way the two users differ.
      expect(hasFeature(secondClaims!, FEATURE)).toBe(true);
      expect(entitled(secondClaims!, FEATURE)).toBe(true);
      expect(secondClaims!.plans.length).toBeGreaterThan(0); // Remote Max, whatever its slug
      expect(hasFeature(firstClaims!, FEATURE)).toBe(false);
      expect(entitled(firstClaims!, FEATURE)).toBe(false);
    },
    SLOW,
  );

  it("collapses garbage and wrong-issuer tokens to null", { timeout: SLOW }, async () => {
    expect(await verifier().verify("not-a-jwt")).toBeNull();
    expect(await verifier().verify("")).toBeNull();
    const pinned = new ClerkSessionVerifier({ secretKey: secretKey!, issuer: "https://wrong.example", authorizedParties: undefined });
    expect(await pinned.verify(second.token)).toBeNull(); // signature fine, iss pin fails
  });

  it("accepts an azp-absent native token WITH authorizedParties configured", { timeout: SLOW }, async () => {
    // The deployed-relay shape: CLERK_AUTHORIZED_PARTIES set. Backend-minted
    // tokens (like every native sign-in) carry no azp and must PASS — the old
    // behavior (library-enforced azp) 401'd every non-browser session, which
    // the auth canary exists to catch against live deployments.
    expect(rawPayload(second.token).azp).toBeUndefined(); // the premise, pinned live
    const guarded = new ClerkSessionVerifier({
      secretKey: secretKey!,
      issuer,
      authorizedParties: ["https://afkpilot.com"],
    });
    const claims = await guarded.verify(second.token);
    expect(claims).not.toBeNull();
    expect(claims!.userId).toBe(second.userId);
  });
});

// ---------------------------------------------------------------------------
// One real-JWT e2e per user: the whole link → uplink → /client choreography
// through a relay running the REAL verifier + the real feature gate.
// ---------------------------------------------------------------------------

describe.skipIf(!enabled)("relay e2e with real Clerk JWTs", () => {
  const webRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
  let relay: RelayServer;
  let base: string;
  let wsBase: string;

  beforeAll(async () => {
    let n = 0;
    relay = createRelayServer({
      host: "127.0.0.1",
      port: 0,
      webRoot,
      store: new LinkStore({ now: Date.now, randomCode: () => makeLinkCode(() => (n++ * 7) % 32) }),
      devices: new InMemoryDeviceRegistry({
        now: Date.now,
        randomUUID: () => `ckid-${++n}`,
        randomBytes: (size) => cryptoRandomBytes(size),
        randomId: () => `cdev-${++n}`,
      }),
      sessions: verifier(),
      requiredFeature: FEATURE,
      hub: new Hub(),
      log: () => {},
    });
    await new Promise<void>((r) => relay.server.once("listening", () => r()));
    base = `http://127.0.0.1:${relay.port()}`;
    wsBase = `ws://127.0.0.1:${relay.port()}`;
  });

  afterAll(async () => {
    await relay.close();
  });

  it(
    "entitled user links + chats over a __session cookie; unentitled closes 4005",
    async () => {
      // Tokens are ~60s; mint fresh ones so this test never races the clock.
      const [f, s] = await Promise.all([mint(FIRST), mint(SECOND)]);

      // Link a device as second (Bearer on approve — what link.html sends).
      const started = await (
        await fetch(`${base}/api/link/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "canary box" }),
        })
      ).json();
      const approved = await fetch(`${base}/api/link/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ code: started.code }),
      });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({ ok: true, deviceId: expect.any(String) });
      const polled = await (
        await fetch(`${base}/api/link/poll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: started.code }),
        })
      ).json();
      expect(polled.status).toBe("approved");

      // Extension-sim uplink comes online with the device token.
      const uplink = new WebSocket(`${wsBase}/uplink?token=${encodeURIComponent(polled.token)}`);
      await new Promise<void>((resolve, reject) => {
        uplink.once("open", resolve);
        uplink.once("error", reject);
      });
      uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: "canary box" } }));

      const mine = await (
        await fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${s.token}` } })
      ).json();
      expect(mine.devices).toHaveLength(1);
      const deviceId: string = mine.devices[0].deviceId;

      // Browser-sim client rides the __session cookie (what chat.html does).
      const browser = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`, {
        headers: { cookie: `__session=${s.token}` },
      });
      const routed = new Promise<Record<string, unknown>>((resolve) => {
        uplink.on("message", (raw) => {
          const m = JSON.parse(raw.toString());
          if (m.t === "msg") resolve(m);
        });
      });
      await new Promise<void>((resolve, reject) => {
        browser.once("open", resolve);
        browser.once("error", reject);
      });
      browser.send(JSON.stringify({ type: "send", text: "hello from the canary" }));
      expect((await routed).msg).toEqual({ type: "send", text: "hello from the canary" });

      // first (signed in, no Remote Max) on the same device: entitlement gate
      // fires before ownership — 4005.
      const closeCode = await new Promise<number>((resolve) => {
        const ws = new WebSocket(`${wsBase}/client?device=${encodeURIComponent(deviceId)}`, {
          headers: { cookie: `__session=${f.token}` },
        });
        ws.on("close", (c) => resolve(c));
        ws.on("error", () => {
          /* close carries the code */
        });
      });
      expect(closeCode).toBe(CLOSE_ENTITLEMENT_REQUIRED);

      browser.close();
      uplink.close();
    },
    SLOW,
  );
});
