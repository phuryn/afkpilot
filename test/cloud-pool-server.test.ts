/**
 * The pool, through the real server.
 *
 * Three of these are the reason the rest exists:
 *
 *  - a handover code works ONCE, because it buys a device token;
 *  - a readiness report without the right secret is refused, because otherwise
 *    guessing a name puts a half-built machine in front of the next person;
 *  - an open with a stocked shelf does not build anything, which is the entire
 *    point of having one.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createRelayServer, type RelayServer } from "../src/server";
import { Hub } from "../src/hub";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices";
import { LinkStore } from "../src/link-store";
import { InMemoryEnvironmentStore } from "../src/environment-store";
import { InMemoryEnvironmentPoolStore } from "../src/environment-pool-store";
import { HandoverCodes } from "../src/environment-handover";
import { WakeCoordinator } from "../src/environment-waker";
import { ProvisionCoordinator, spriteNameFor } from "../src/environment-provisioner";
import { randomUUID, randomBytes } from "node:crypto";
import { join } from "node:path";

let handle: RelayServer | undefined;
let base = "";
let created: string[] = [];
let execs: { id: string; argv: string[] }[] = [];
let pool: InMemoryEnvironmentPoolStore;
let environments: InMemoryEnvironmentStore;
let handover: HandoverCodes;
let codeSeq = 0;

const PUBLIC = "https://relay.example";

async function boot() {
  created = [];
  execs = [];
  codeSeq = 0;
  pool = new InMemoryEnvironmentPoolStore(() => 1_700_000_000_000);
  environments = new InMemoryEnvironmentStore(() => 1_700_000_000_000);
  handover = new HandoverCodes(() => 1_700_000_000_000, () => `code-${++codeSeq}`);
  handle = createRelayServer({
    host: "127.0.0.1",
    port: 0,
    webRoot: join(process.cwd(), "web"),
    store: new LinkStore({ now: Date.now, randomCode: () => randomUUID().slice(0, 8) }),
    devices: new InMemoryDeviceRegistry({
      now: () => 1_700_000_000_000, randomUUID, randomBytes, randomId: () => randomUUID(),
    }),
    sessions: { verify: async () => ({ userId: MOCK_USER_ID, features: [] }) },
    hub: new Hub(),
    environments,
    pool,
    handover,
    publicUrl: PUBLIC,
    waker: new WakeCoordinator({ wake: async () => ({ ok: true }) }),
    provisioner: new ProvisionCoordinator({
      create: async (userId: string) => { created.push(spriteNameFor(userId)); return { ok: true, externalId: spriteNameFor(userId) }; },
      createNamed: async (name: string) => { created.push(name); return { ok: true, externalId: name }; },
      exec: async (id: string, argv: readonly string[]) => {
        execs.push({ id, argv: [...argv] });
        return { ok: true as const, exitCode: 0, output: "" };
      },
      destroy: async () => true,
    }),
    pingIntervalMs: 0,
    log: () => {},
  });
  await new Promise<void>((r, j) => {
    if (handle!.server.listening) return r();
    handle!.server.once("listening", () => r());
    handle!.server.once("error", j);
  });
  base = `http://127.0.0.1:${handle.port()}`;
}

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });

beforeEach(async () => { await boot(); });
afterEach(async () => { await handle?.close(); handle = undefined; });

describe("opening with a stocked shelf", () => {
  it("takes a machine instead of building one", async () => {
    // The whole point. Building took twenty-five minutes; this is a token
    // handover.
    await pool.add("afkpilot-pool-aaa", "s");
    await pool.markReady("afkpilot-pool-aaa", "s", 1_000);

    const body = await (await post("/api/cloud/open")).json() as { ok: boolean; deviceId: string };
    expect(body.ok).toBe(true);
    expect(created).toEqual([]);
    expect((await environments.find(body.deviceId))?.externalId).toBe("afkpilot-pool-aaa");
  });

  it("hands the machine its identity, and only via a code", async () => {
    await pool.add("afkpilot-pool-aaa", "s");
    await pool.markReady("afkpilot-pool-aaa", "s", 1_000);
    const raw = await (await post("/api/cloud/open")).text();

    expect(execs.length).toBe(1);
    expect(execs[0].id).toBe("afkpilot-pool-aaa");
    const script = execs[0].argv.join(" ");
    expect(script).toContain("x-handover-code: code-1");
    // The token is what the code BUYS. It must not also be sitting in the
    // command line, which is where the provider's control-plane record keeps it.
    expect(script).not.toMatch(/sk-device-/);
    expect(raw).not.toMatch(/sk-device-/);
  });

  it("forgets the pool row once the environment row owns the machine", async () => {
    await pool.add("afkpilot-pool-aaa", "s");
    await pool.markReady("afkpilot-pool-aaa", "s", 1_000);
    await post("/api/cloud/open");
    expect(await pool.counts(1_700_000_000_000)).toEqual({ ready: 0, building: 0 });
    expect(await pool.claim()).toBeNull();
  });

  it("gives two accounts two different machines", async () => {
    // The shelf must never hand the same box to two people.
    await pool.add("afkpilot-pool-aaa", "s");
    await pool.markReady("afkpilot-pool-aaa", "s", 1_000);
    await pool.add("afkpilot-pool-bbb", "s");
    await pool.markReady("afkpilot-pool-bbb", "s", 2_000);

    const first = await (await post("/api/cloud/open")).json() as { deviceId: string };
    await environments.remove(first.deviceId); // pretend it is a different account
    const second = await (await post("/api/cloud/open")).json() as { deviceId: string };

    const a = (await environments.find(second.deviceId))?.externalId;
    expect(execs.map((e) => e.id)).toEqual(["afkpilot-pool-aaa", "afkpilot-pool-bbb"]);
    expect(a).toBe("afkpilot-pool-bbb");
  });
});

describe("opening with an empty shelf", () => {
  it("builds on demand, which is what always happened", async () => {
    // An empty pool is not a failure. It is the slow path, and the slow path is
    // the one every open used before a pool existed.
    const body = await (await post("/api/cloud/open")).json() as { ok: boolean; provisioned: boolean };
    expect(body.ok).toBe(true);
    expect(body.provisioned).toBe(true);
    expect(created).toEqual([spriteNameFor(MOCK_USER_ID)]);
  });

  it("INSTALLS on the machine it just made", async () => {
    // The bug this pins shipped and was found in production. Setup ran only for
    // a machine taken off the shelf, so opening a cloud environment while the
    // pool was empty produced a sprite that nothing was ever installed on. It
    // came up, sat there, and the picker counted "creating" upwards for an hour
    // and a half because nothing was ever going to link.
    await post("/api/cloud/open");
    // Not awaited by the handler — the person gets their response while the
    // machine takes minutes — so wait for the work it kicked off.
    for (let i = 0; i < 50 && execs.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const scripts = execs.map((e) => e.argv.join(" "));
    expect(scripts.some((s) => s.includes("sprite-env services create afkpilot")))
      .toBe(true);
    expect(scripts.some((s) => s.includes("x-handover-code:"))).toBe(true);
    expect(execs.every((e) => e.id === spriteNameFor(MOCK_USER_ID))).toBe(true);
  });

  it("does not re-run the installer on a machine off the shelf", async () => {
    // A pooled machine is already installed. Registering the service again
    // would restart an install that has already finished.
    await pool.add("afkpilot-pool-aaa", "s");
    await pool.markReady("afkpilot-pool-aaa", "s", 1_000);
    await post("/api/cloud/open");
    for (let i = 0; i < 25 && execs.length < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const scripts = execs.map((e) => e.argv.join(" "));
    expect(scripts.some((s) => s.includes("services create afkpilot"))).toBe(false);
    expect(scripts.some((s) => s.includes("x-handover-code:"))).toBe(true);
  });
});

describe("a machine reporting itself ready", () => {
  it("is accepted with its own secret", async () => {
    await pool.add("afkpilot-pool-aaa", "sekret");
    const res = await post("/api/environment/pool/ready", { name: "afkpilot-pool-aaa", secret: "sekret" });
    expect(res.status).toBe(200);
    expect((await pool.counts(1_700_000_000_000)).ready).toBe(1);
  });

  it("is refused without it, and says nothing useful to a guesser", async () => {
    await pool.add("afkpilot-pool-aaa", "sekret");
    const wrong = await post("/api/environment/pool/ready", { name: "afkpilot-pool-aaa", secret: "nope" });
    const ghost = await post("/api/environment/pool/ready", { name: "afkpilot-pool-zzz", secret: "nope" });
    expect(wrong.status).toBe(403);
    expect(ghost.status).toBe(403);
    // Identical answers: a caller who is guessing learns nothing from either.
    expect(await wrong.json()).toEqual(await ghost.json());
    expect((await pool.counts(1_700_000_000_000)).ready).toBe(0);
  });

  it("rejects a request with nothing in it", async () => {
    expect((await post("/api/environment/pool/ready", {})).status).toBe(400);
  });
});

describe("handover", () => {
  it("gives a machine its env file, once", async () => {
    const code = handover.mint({ deviceId: "d1", token: "sk-device-abc", relayUrl: "wss://relay.example" });

    const first = await post("/api/environment/handover", undefined, { "x-handover-code": code });
    expect(first.status).toBe(200);
    const body = await first.text();
    expect(body).toContain("GROK_RELAY_DEVICE_TOKEN=sk-device-abc");
    expect(body).toContain("GROK_RELAY_URL=wss://relay.example");
    expect(body).toContain("GROK_CLOUD_ENVIRONMENT=1");

    // ONCE. The code buys a device token; a replayable one is a device token
    // anybody who saw a log line can collect.
    const second = await post("/api/environment/handover", undefined, { "x-handover-code": code });
    expect(second.status).toBe(403);
  });

  it("refuses a missing or wrong code", async () => {
    expect((await post("/api/environment/handover")).status).toBe(403);
    expect((await post("/api/environment/handover", undefined, { "x-handover-code": "made-up" })).status).toBe(403);
  });

  it("is served as text that nothing will try to interpret", async () => {
    const code = handover.mint({ deviceId: "d1", token: "t", relayUrl: "wss://r" });
    const res = await post("/api/environment/handover", undefined, { "x-handover-code": code });
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // A credential must not sit in a cache on the way back.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the bootstrap script", () => {
  it("is served, and carries no secrets", async () => {
    // It is fetched by a machine that has not proved anything yet, so it is
    // public by construction. Anything secret in here would be secret to
    // nobody.
    const res = await fetch(`${base}/api/environment/pool-bootstrap.sh`);
    expect(res.status).toBe(200);
    const script = await res.text();
    expect(script).toContain("#!/usr/bin/env bash");
    // The relay is baked in once, as a variable — a machine has no
    // configuration of its own and must not have to be told where home is.
    expect(script).toContain(`RELAY="${PUBLIC}"`);
    expect(script).toContain("$RELAY/api/environment/pool/ready");
    expect(script).not.toMatch(/sk-device-|SPRITES_TOKEN|SUPABASE|Bearer /);
  });
});
