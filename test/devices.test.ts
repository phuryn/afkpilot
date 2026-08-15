import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { InMemoryDeviceRegistry, MOCK_USER_ID } from "../src/devices.js";

function makeRegistry() {
  let n = 0;
  let t = 1000;
  return new InMemoryDeviceRegistry({
    now: () => t++,
    randomUUID: () => `kid-${++n}`,
    randomBytes: (size) => randomBytes(size),
    randomId: () => `dev-${n}`,
  });
}

describe("InMemoryDeviceRegistry (mock auth)", () => {
  it("issues, verifies, and lists devices by user", async () => {
    const reg = makeRegistry();
    const a = await reg.issue("Laptop", MOCK_USER_ID);
    const b = await reg.issue("Desktop", MOCK_USER_ID);
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^sk-device-.+\..+$/); // production token shape even in dev
    expect(await reg.verify(a.token)).toMatchObject({ deviceId: a.deviceId, name: "Laptop", userId: MOCK_USER_ID });
    expect(await reg.verify("bogus")).toBeNull();
    expect((await reg.listByUser(MOCK_USER_ID)).map((d) => d.name)).toEqual(["Laptop", "Desktop"]);
  });

  it("listByUser returns only that user's live devices, oldest first", async () => {
    const reg = makeRegistry();
    await reg.issue("A", "user-a");
    await reg.issue("B", "user-b");
    await reg.issue("C", "user-a");
    expect((await reg.listByUser("user-a")).map((d) => d.name)).toEqual(["A", "C"]);
    expect((await reg.listByUser("user-b")).map((d) => d.name)).toEqual(["B"]);
    expect(await reg.listByUser("nobody")).toEqual([]);
  });

  it("findOwned matches device+user and returns null otherwise", async () => {
    const reg = makeRegistry();
    const a = await reg.issue("Laptop", "user-a");
    const b = await reg.issue("Desktop", "user-b");
    expect(await reg.findOwned(a.deviceId, "user-a")).toMatchObject({ deviceId: a.deviceId, name: "Laptop", userId: "user-a" });
    expect(await reg.findOwned(a.deviceId, "user-b")).toBeNull();
    expect(await reg.findOwned(b.deviceId, "user-a")).toBeNull();
    expect(await reg.findOwned("missing", "user-a")).toBeNull();
  });

  it("revoke kills the token", async () => {
    const reg = makeRegistry();
    const { deviceId, token } = await reg.issue("Laptop", MOCK_USER_ID);
    expect(await reg.revoke(deviceId)).toBe(true);
    expect(await reg.verify(token)).toBeNull();
    expect(await reg.revoke(deviceId)).toBe(false);
    expect(await reg.findOwned(deviceId, MOCK_USER_ID)).toBeNull();
    expect(await reg.listByUser(MOCK_USER_ID)).toEqual([]);
  });

  it("round-trips optional client metadata and omits it when absent", async () => {
    const reg = makeRegistry();
    const withMeta = await reg.issue("DESKTOP-RHFLCK3 (Windows 11)", MOCK_USER_ID, "inst-1", {
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    const bare = await reg.issue("Old box", MOCK_USER_ID);
    expect(await reg.verify(withMeta.token)).toMatchObject({
      deviceId: withMeta.deviceId,
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
      installId: "inst-1",
    });
    const listed = await reg.listByUser(MOCK_USER_ID);
    expect(listed.find((d) => d.deviceId === withMeta.deviceId)).toMatchObject({
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    const bareRec = listed.find((d) => d.deviceId === bare.deviceId);
    expect(bareRec?.clientLabel).toBeUndefined();
    expect(bareRec?.platform).toBeUndefined();
    expect(bareRec?.osLabel).toBeUndefined();
  });

  it("updateClient mutates only client metadata", async () => {
    const reg = makeRegistry();
    const { deviceId, token } = await reg.issue("Old box", MOCK_USER_ID);
    await reg.updateClient(deviceId, {
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    expect(await reg.verify(token)).toMatchObject({
      deviceId,
      name: "Old box",
      userId: MOCK_USER_ID,
      clientLabel: "VS Code extension",
      platform: "win",
      osLabel: "Windows 11",
    });
    await reg.updateClient(deviceId, { clientLabel: "Cursor" });
    const rec = await reg.verify(token);
    expect(rec?.clientLabel).toBe("Cursor");
    expect(rec?.platform).toBe("win");
    expect(rec?.osLabel).toBe("Windows 11");
    expect(rec?.name).toBe("Old box");
    expect(rec?.userId).toBe(MOCK_USER_ID);
  });
});
