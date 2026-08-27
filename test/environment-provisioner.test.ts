/**
 * Provisioning — the operations that cost money.
 *
 * A wake that fires twice wastes a request. A create that fires twice is a
 * second machine somebody pays for, and a destroy at the wrong moment is
 * somebody's work. Everything pinned here is about those two asymmetries.
 */
import { describe, expect, it } from "vitest";
import {
  ProvisionCoordinator,
  parseSpriteLabels,
  spriteNameFor,
  spritesProvisioner,
  type ProvisionOutcome,
} from "../src/environment-provisioner";

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init) as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("naming a sprite", () => {
  it("is stable for a user, so a half-finished provision is recoverable", () => {
    // If the name were random, a create that succeeded and then failed before
    // writing its row would leave an orphan and make a second machine on retry.
    expect(spriteNameFor("user_abc")).toBe(spriteNameFor("user_abc"));
  });

  it("differs between users", () => {
    expect(spriteNameFor("user_abc")).not.toBe(spriteNameFor("user_def"));
  });

  it("never puts the user id in the name", () => {
    // A sprite name becomes a public hostname. A Clerk user id there is an
    // identifier leaking into DNS.
    const name = spriteNameFor("user_2abcDEF1234567890");
    expect(name).not.toContain("user_2abcDEF");
    expect(name).toMatch(/^afkpilot-u-[0-9a-f]{12}$/);
  });

  it("changes with a salt", () => {
    // Nothing passes one today. Pinned because the day a name must dodge a
    // sprite still being torn down, this is the seam that does it.
    expect(spriteNameFor("user_abc", "2")).not.toBe(spriteNameFor("user_abc"));
  });
});

describe("creating one", () => {
  it("asks for the derived name and reports it back", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    const p = spritesProvisioner({ token: "t", apiBase: "https://api.example", fetchImpl: impl });
    const out = await p.create("user_abc");
    expect(out).toEqual({ ok: true, externalId: spriteNameFor("user_abc") });
    expect(calls[0].url).toBe("https://api.example/v1/sprites");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: spriteNameFor("user_abc") });
  });

  it("adopts an existing sprite instead of making a second one", async () => {
    // 409 means a previous attempt already created it. Treating that as failure
    // and retrying is how one user ends up paying for two machines.
    const { impl } = fakeFetch(() => ({ status: 409 }));
    const p = spritesProvisioner({ token: "t", fetchImpl: impl });
    expect(await p.create("user_abc")).toEqual({ ok: true, externalId: spriteNameFor("user_abc") });
  });

  it("separates a limit the user can act on from a failure they cannot", async () => {
    for (const status of [402, 429]) {
      const { impl } = fakeFetch(() => ({ status }));
      const p = spritesProvisioner({ token: "t", fetchImpl: impl });
      expect(await p.create("u")).toEqual({ ok: false, kind: "quota" });
    }
    for (const status of [400, 401, 500, 503]) {
      const { impl } = fakeFetch(() => ({ status }));
      const p = spritesProvisioner({ token: "t", fetchImpl: impl });
      expect(await p.create("u")).toEqual({ ok: false, kind: "unavailable" });
    }
  });

  it("survives the network being gone", async () => {
    const impl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const p = spritesProvisioner({ token: "t", fetchImpl: impl });
    expect(await p.create("u")).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("destroying one", () => {
  it("accepts the provider's 204", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 204 }));
    const p = spritesProvisioner({ token: "t", apiBase: "https://api.example", fetchImpl: impl });
    expect(await p.destroy("afkpilot-u-abc")).toBe(true);
    expect(calls[0].url).toBe("https://api.example/v1/sprites/afkpilot-u-abc");
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("treats already-gone as destroyed", async () => {
    // Reset must not stall because a previous attempt got further than its
    // bookkeeping did.
    const { impl } = fakeFetch(() => ({ status: 404 }));
    const p = spritesProvisioner({ token: "t", fetchImpl: impl });
    expect(await p.destroy("gone")).toBe(true);
  });

  it("reports a real failure as one", async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const p = spritesProvisioner({ token: "t", fetchImpl: impl });
    expect(await p.destroy("x")).toBe(false);
  });
});

describe("one provision at a time", () => {
  it("makes one machine when two tabs open a cloud environment at once", async () => {
    // The expensive race. Two tabs, one first-open, must not become two sprites.
    let calls = 0;
    let release!: (v: ProvisionOutcome) => void;
    const gate = new Promise<ProvisionOutcome>((r) => { release = r; });
    const c = new ProvisionCoordinator({
      create: () => { calls += 1; return gate; },
      destroy: async () => true,
    });
    const both = Promise.all([c.create("u"), c.create("u")]);
    expect(calls).toBe(1);
    expect(c.provisioning("u")).toBe(true);
    release({ ok: true, externalId: "s" });
    expect(await both).toEqual([{ ok: true, externalId: "s" }, { ok: true, externalId: "s" }]);
    expect(c.provisioning("u")).toBe(false);
  });

  it("still provisions different users concurrently", async () => {
    const seen: string[] = [];
    const c = new ProvisionCoordinator({
      create: async (u) => { seen.push(u); return { ok: true, externalId: u }; },
      destroy: async () => true,
    });
    await Promise.all([c.create("a"), c.create("b")]);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("lets a later attempt through once the first settles", async () => {
    let calls = 0;
    const c = new ProvisionCoordinator({
      create: async () => { calls += 1; return { ok: false, kind: "unavailable" }; },
      destroy: async () => true,
    });
    await c.create("u");
    await c.create("u");
    expect(calls).toBe(2);
  });
});

describe("labels", () => {
  it("splits, trims and drops empties", () => {
    expect(parseSpriteLabels(" afkpilot , env:dev ,, ")).toEqual(["afkpilot", "env:dev"]);
  });

  it("is empty for unset or blank", () => {
    expect(parseSpriteLabels(undefined)).toEqual([]);
    expect(parseSpriteLabels("")).toEqual([]);
    expect(parseSpriteLabels("  , ,")).toEqual([]);
  });

  it("keeps order and drops duplicates, so a deploy produces a stable set", () => {
    // A label list that reshuffles between deploys makes diffing two sprites
    // harder than it needs to be.
    expect(parseSpriteLabels("b,a,b")).toEqual(["b", "a"]);
  });

  it("sends them on create", async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    const p = spritesProvisioner({ token: "t", labels: ["afkpilot", "env:dev"], fetchImpl: impl });
    await p.create("u");
    expect(JSON.parse(String(calls[0].init.body)).labels).toEqual(["afkpilot", "env:dev"]);
  });

  it("omits the field entirely when there are none", () => {
    // Not an empty array: a provider is entitled to treat "set to nothing"
    // differently from "not mentioned".
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    return spritesProvisioner({ token: "t", fetchImpl: impl }).create("u").then(() => {
      expect("labels" in JSON.parse(String(calls[0].init.body))).toBe(false);
    });
  });
});
