import { describe, it, expect } from "vitest";
import { issueDeviceKey, parseDeviceToken, hmacDeviceSecret, safeEqual } from "../src/device-keys.js";

const deps = {
  randomUUID: () => "11111111-1111-1111-1111-111111111111",
  randomBytes: (n: number) => Buffer.alloc(n, 7),
};

describe("issueDeviceKey / parseDeviceToken", () => {
  it("round-trips the sk-device-<kid>.<secret> format", () => {
    const { kid, secret, token } = issueDeviceKey(deps);
    expect(token).toBe(`sk-device-${kid}.${secret}`);
    const parsed = parseDeviceToken(token)!;
    expect(parsed).toEqual({ kid, secret });
  });

  it("secret is url-safe base64 of the random bytes", () => {
    const { secret } = issueDeviceKey(deps);
    expect(secret).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(secret).not.toMatch(/[+/=]/);
  });

  it("rejects garbage, wrong prefix, and missing/empty halves", () => {
    expect(parseDeviceToken("")).toBeNull();
    expect(parseDeviceToken("garbage")).toBeNull();
    expect(parseDeviceToken("sk-device-")).toBeNull();
    expect(parseDeviceToken("sk-device-kidonly")).toBeNull(); // no dot
    expect(parseDeviceToken("sk-device-kid.")).toBeNull(); // empty secret
    expect(parseDeviceToken("sk-device-.secret")).toBeNull(); // empty kid
    expect(parseDeviceToken("wrong-kid.secret")).toBeNull(); // wrong prefix
  });

  it("splits on the FIRST dot (secret may contain dots)", () => {
    expect(parseDeviceToken("sk-device-a.b.c")).toEqual({ kid: "a", secret: "b.c" });
  });
});

describe("hmacDeviceSecret", () => {
  it("is deterministic for identical inputs", () => {
    expect(hmacDeviceSecret("user_A", "sec", "pep")).toBe(hmacDeviceSecret("user_A", "sec", "pep"));
  });

  it("differs per user — binds the token to its owner", () => {
    expect(hmacDeviceSecret("user_A", "sec", "pep")).not.toBe(hmacDeviceSecret("user_B", "sec", "pep"));
  });

  it("differs per secret and per pepper", () => {
    expect(hmacDeviceSecret("u", "s1", "pep")).not.toBe(hmacDeviceSecret("u", "s2", "pep"));
    expect(hmacDeviceSecret("u", "s", "pep1")).not.toBe(hmacDeviceSecret("u", "s", "pep2"));
  });

  it("returns url-safe base64 (no +/=)", () => {
    expect(hmacDeviceSecret("u", "s", "pep")).not.toMatch(/[+/=]/);
  });
});

describe("safeEqual", () => {
  it("true only for identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("false (never throws) for different lengths", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("x", "")).toBe(false);
  });
});
