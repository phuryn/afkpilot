import { describe, it, expect } from "vitest";
import { LinkStore, makeLinkCode, LINK_TTL_MS } from "../src/link-store.js";

function makeStore(codes: string[] = ["AAAA2222", "BBBB3333"]) {
  let t = 1000;
  let i = 0;
  const store = new LinkStore({ now: () => t, randomCode: () => codes[i++ % codes.length] });
  return { store, advance: (ms: number) => (t += ms) };
}

describe("LinkStore", () => {
  it("start -> pending -> approve -> poll hands back the token", () => {
    const { store } = makeStore();
    const { code } = store.start("Dev box");
    expect(store.info(code)).toEqual({ status: "pending", deviceName: "Dev box" });
    expect(store.poll(code)).toEqual({ status: "pending" });
    expect(store.approve(code, "tok-1")).toBe(true);
    expect(store.poll(code)).toEqual({ status: "approved", token: "tok-1" });
    // a lost poll response must not strand the device — approved keeps answering
    expect(store.poll(code)).toEqual({ status: "approved", token: "tok-1" });
  });

  it("unknown and expired codes are distinct terminal states", () => {
    const { store, advance } = makeStore();
    expect(store.poll("NOPE")).toEqual({ status: "unknown" });
    const { code } = store.start("Dev box");
    advance(LINK_TTL_MS + 1);
    expect(store.poll(code)).toEqual({ status: "expired" });
    expect(store.approve(code, "tok")).toBe(false); // expired can't be approved
    // record is dropped on expiry — a later poll reports unknown, not expired
    expect(store.poll(code)).toEqual({ status: "unknown" });
  });

  it("regenerates on code collision", () => {
    const { store } = makeStore(["SAME1111", "SAME1111", "OTHER222"]);
    expect(store.start("a").code).toBe("SAME1111");
    expect(store.start("b").code).toBe("OTHER222");
  });

  it("custom ttl is honored", () => {
    let t = 0;
    const store = new LinkStore({ now: () => t, randomCode: () => "X", ttlMs: 100 });
    const { code } = store.start("d");
    t = 101;
    expect(store.poll(code).status).toBe("expired");
  });

  it("carries optional client metadata through info for approve to persist", () => {
    const { store } = makeStore();
    const { code } = store.start("DESKTOP-RHFLCK3 (Windows 11)", "inst-1", {
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(store.info(code)).toEqual({
      status: "pending",
      deviceName: "DESKTOP-RHFLCK3 (Windows 11)",
      installId: "inst-1",
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
  });
});

describe("makeLinkCode", () => {
  it("is 8 chars from the unambiguous alphabet", () => {
    const code = makeLinkCode((max) => max - 1);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(makeLinkCode(() => 0)).toBe("AAAAAAAA");
  });
});
