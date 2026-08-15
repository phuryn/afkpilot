import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../web/auth.js", import.meta.url), "utf8");
const start = src.indexOf("function identityFromClerkUser(user)");
const end = src.indexOf("function fapiHost", start);
const identityFromClerkUser = new Function(
  `${src.slice(start, end)}; return identityFromClerkUser;`,
)() as (user: unknown) => string | null;

describe("signed-in identity text", () => {
  it("prefers the primary email", () => {
    expect(identityFromClerkUser({
      primaryEmailAddress: { emailAddress: "me@example.com" },
      username: "me",
      id: "user_1",
    })).toBe("me@example.com");
  });

  it("falls back to username, then id", () => {
    expect(identityFromClerkUser({ username: "me", id: "user_1" })).toBe("me");
    expect(identityFromClerkUser({ id: "user_1" })).toBe("user_1");
  });

  it("returns nothing without a user — mock mode must not invent an identity", () => {
    expect(identityFromClerkUser(null)).toBeNull();
    expect(identityFromClerkUser(undefined)).toBeNull();
    expect(identityFromClerkUser({})).toBeNull();
    expect(identityFromClerkUser({ primaryEmailAddress: { emailAddress: "" }, username: "" })).toBeNull();
  });
});
