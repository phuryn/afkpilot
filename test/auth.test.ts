import { describe, it, expect } from "vitest";
import {
  parseSessionClaims,
  hasPlan,
  hasFeature,
  entitled,
  sessionTokenFromRequest,
  MockSessionVerifier,
  azpAllowed,
} from "../src/auth.js";

describe("azpAllowed (authorized-party post-check)", () => {
  const PARTIES = ["https://afkpilot.com", "https://staging.example.com"];

  it("passes an ABSENT azp — native sign-ins can never carry one", () => {
    expect(azpAllowed(undefined, PARTIES)).toBe(true);
    expect(azpAllowed(null, PARTIES)).toBe(true);
  });

  it("passes a present azp on the allowlist (the browser case)", () => {
    expect(azpAllowed("https://afkpilot.com", PARTIES)).toBe(true);
  });

  it("rejects a present azp off the allowlist — a token minted for another origin", () => {
    expect(azpAllowed("https://evil.example", PARTIES)).toBe(false);
  });

  it("rejects malformed non-string azp when an allowlist is configured (fail closed)", () => {
    expect(azpAllowed(42, PARTIES)).toBe(false);
    expect(azpAllowed(["https://afkpilot.com"], PARTIES)).toBe(false);
  });

  it("checks nothing when no allowlist is configured", () => {
    expect(azpAllowed("https://anything.example", undefined)).toBe(true);
    expect(azpAllowed("https://anything.example", [])).toBe(true);
    expect(azpAllowed(undefined, undefined)).toBe(true);
  });
});

describe("parseSessionClaims (Clerk session token v2)", () => {
  it("takes user-scoped plans/features, ignores org-scoped ones", () => {
    const c = parseSessionClaims({
      sub: "user_123",
      pla: "u:pro,o:team_plan",
      fea: "u:remote,uo:dashboard,o:impersonation",
    })!;
    expect(c.userId).toBe("user_123");
    expect(c.plans).toEqual(["pro"]);
    expect(c.features).toEqual(["remote", "dashboard"]);
    expect(hasPlan(c, "pro")).toBe(true);
    expect(hasPlan(c, "team_plan")).toBe(false);
    expect(hasFeature(c, "remote")).toBe(true);
    expect(hasFeature(c, "impersonation")).toBe(false);
  });

  it("tolerates absent/malformed claims", () => {
    expect(parseSessionClaims({})).toBeNull();
    expect(parseSessionClaims({ sub: "" })).toBeNull();
    const c = parseSessionClaims({ sub: "user_1", pla: 42, fea: "garbage,u:,:x" })!;
    expect(c.plans).toEqual([]);
    expect(c.features).toEqual([]);
  });
});

describe("entitled", () => {
  const claims = { userId: "u", plans: ["free"], features: ["remote"] };
  it("open gate when no feature is required", () => {
    expect(entitled(claims, undefined)).toBe(true);
    expect(entitled(claims, "")).toBe(true);
  });
  it("checks the required feature, honors the mock wildcard", () => {
    expect(entitled(claims, "remote")).toBe(true);
    expect(entitled(claims, "other")).toBe(false);
    expect(entitled({ userId: "u", plans: [], features: ["*"] }, "other")).toBe(true);
  });
});

describe("sessionTokenFromRequest", () => {
  it("prefers the Bearer header", () => {
    expect(sessionTokenFromRequest({ authorization: "Bearer abc", cookie: "__session=xyz" })).toBe("abc");
  });
  it("falls back to the __session cookie (WS upgrades)", () => {
    expect(sessionTokenFromRequest({ cookie: "a=1; __session=tok.en=; b=2" })).toBe("tok.en=");
  });
  it("empty when neither is present", () => {
    expect(sessionTokenFromRequest({})).toBe("");
  });
});

describe("MockSessionVerifier", () => {
  it("any non-empty token is the mock user with wildcard entitlement", async () => {
    const v = new MockSessionVerifier();
    expect(await v.verify("")).toBeNull();
    const c = (await v.verify("anything"))!;
    expect(c.userId).toBe("mock");
    expect(entitled(c, "whatever")).toBe(true);
  });
});
