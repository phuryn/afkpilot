import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../web/host-version.js", import.meta.url), "utf8");
const root: { grokHostVersion?: {
  MIN_REMOTE_HOST: string;
  parseSemver: (raw: unknown) => { major: number; minor: number; patch: number } | null;
  hostTooOld: (extVersion: unknown) => boolean;
} } = {};
new Function("globalThis", src)(root);
const { hostTooOld, parseSemver, MIN_REMOTE_HOST } = root.grokHostVersion!;

describe("remote host version gate", () => {
  it("floors at 3.1.0", () => {
    expect(MIN_REMOTE_HOST).toBe("3.1.0");
  });

  it("does not gate when no version has arrived", () => {
    expect(hostTooOld(undefined)).toBe(false);
    expect(hostTooOld(null)).toBe(false);
    expect(hostTooOld("")).toBe(false);
    expect(hostTooOld("not-a-version")).toBe(false);
    expect(hostTooOld(310)).toBe(false);
  });

  it("gates anything below 3.1.0 and lets 3.1.0+ through", () => {
    expect(hostTooOld("2.0.4")).toBe(true);
    expect(hostTooOld("3.0.9")).toBe(true);
    expect(hostTooOld("v3.0.99")).toBe(true);
    expect(hostTooOld("3.1.0")).toBe(false);
    expect(hostTooOld("3.1.0-rc.1")).toBe(false);
    expect(hostTooOld("3.5.0")).toBe(false);
    expect(hostTooOld("v10.0.0")).toBe(false);
  });

  it("parses a leading v and ignores a pre-release suffix", () => {
    expect(parseSemver("v2.0.4")).toEqual({ major: 2, minor: 0, patch: 4 });
    expect(parseSemver("3.1.0-rc.1")).toEqual({ major: 3, minor: 1, patch: 0 });
    expect(parseSemver("")).toBeNull();
  });
});
