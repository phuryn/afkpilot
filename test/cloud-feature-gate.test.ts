// Who may open a cloud machine.
//
// The owner asked why a free account on DEV can still open one: the gate is
// `RELAY_CLOUD_FEATURE`, it is UNSET there, and unset means open to everyone by
// design (`main.ts` logs "cloud access: OPEN to every account"). That is a
// deployment switch, not a bug — but the function it turns on had no test at
// all, which is a poor thing to discover while deciding whether to charge for
// the feature.
import { describe, expect, it } from "vitest";
import { mayUseCloud, cloudRowState } from "../src/environments";

describe("the cloud entitlement gate", () => {
  it("is open to everyone when no feature is configured", () => {
    // The launch position, and what DEV runs today.
    expect(mayUseCloud([], undefined)).toBe(true);
    expect(mayUseCloud(["remote"], undefined)).toBe(true);
  });

  it("refuses an account that lacks the configured feature", () => {
    expect(mayUseCloud([], "sprite")).toBe(false);
    // Having the PAID feature is not the same as having the cloud one: that
    // separation is the whole reason for a second flag, so the preview can be
    // ended in the Clerk dashboard without touching `remote`.
    expect(mayUseCloud(["remote"], "sprite")).toBe(false);
  });

  it("admits an account that carries it", () => {
    expect(mayUseCloud(["sprite"], "sprite")).toBe(true);
    expect(mayUseCloud(["remote", "sprite"], "sprite")).toBe(true);
  });

  it("admits the keyless mock verifier's wildcard", () => {
    // `features: ["*"]` is the contributor path (no Clerk keys). It must pass
    // every gate or keyless dev cannot see the product.
    expect(mayUseCloud(["*"], "sprite")).toBe(true);
  });

  it("is case- and whitespace-exact, so a typo closes the gate rather than opening it", () => {
    expect(mayUseCloud(["Sprite"], "sprite")).toBe(false);
    expect(mayUseCloud([" sprite"], "sprite")).toBe(false);
  });

  it("hands an unentitled account a row that offers the upgrade", () => {
    // Never a hidden row: a machine that only appears once you have paid is a
    // product nobody discovers.
    expect(cloudRowState({ entitled: false })).toBe("upgrade");
    // …and entitlement is re-checked even when a machine already exists, so a
    // lapsed plan cannot keep waking one.
    expect(cloudRowState({
      entitled: false,
      environment: { deviceId: "d", userId: "u", provider: "sprite", externalId: "x", createdAt: 1, readyAt: 2 },
    })).toBe("upgrade");
  });
});
