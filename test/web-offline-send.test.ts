import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Behavioural extract of the offline-send helpers in web/chat.html. The
// lifecycle suite is the full product check; these pin the decisions that
// fail silently if they regress: a refused live send must re-enter the
// existing outbox, and identity-complete is not a license to keep sending
// into a Device-offline grace window.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const helpersStart = html.indexOf("function isDeviceOfflineError(data)");
const helpersEnd = html.indexOf("function persistOutboxMessage(raw, message)");
const helpers = html.slice(helpersStart, helpersEnd);

const {
  isDeviceOfflineError,
  outboxAfterPersist,
  shouldReenterIdentityOnDeviceOffline,
  liveSendDisposition,
} = new Function(
  `${helpers}; return { isDeviceOfflineError, outboxAfterPersist, shouldReenterIdentityOnDeviceOffline, liveSendDisposition };`,
)() as {
  isDeviceOfflineError: (data: unknown) => boolean;
  outboxAfterPersist: (current: string[], raw: string, message: unknown) => string[];
  shouldReenterIdentityOnDeviceOffline: (restoreComplete: boolean, mournableCount: number) => boolean;
  liveSendDisposition: (opts: {
    socketOpen?: boolean;
    identityRestoreComplete?: boolean;
    deviceOffline?: boolean;
    offlineHold?: boolean;
    isRestoreMessage?: boolean;
    changesIdentity?: boolean;
  }) => "send" | "outbox" | "abandon-and-send";
};

const deviceOfflineHandler = html.slice(
  html.indexOf("Swallowing the banner must not swallow the send"),
  html.indexOf("Anything that isn't an error means the device is alive"),
);

const sendPath = html.slice(
  html.indexOf("var disposition = liveSendDisposition"),
  html.indexOf("getState: function ()"),
);

describe("offline live-send hold", () => {
  it("matches the relay's fixed Device offline prefix and nothing else", () => {
    expect(isDeviceOfflineError({
      type: "error",
      text: "Device offline — VS Code isn't connected to the relay.",
    })).toBe(true);
    expect(isDeviceOfflineError({ type: "error", text: "Device offline" })).toBe(true);
    expect(isDeviceOfflineError({ type: "error", text: "Free plan limit reached (20 messages this week)." })).toBe(false);
    expect(isDeviceOfflineError({ type: "error", text: "Slow down — at most 20 messages per minute." })).toBe(false);
    expect(isDeviceOfflineError({ type: "sessions", activeId: "s1" })).toBe(false);
    expect(isDeviceOfflineError(null)).toBe(false);
  });

  it("folds a refused live send into the existing outbox, deduping only by queuedSendId", () => {
    const first = JSON.stringify({ type: "send", text: "hello" });
    const withId = JSON.stringify({ type: "send", text: "once", queuedSendId: "q1" });
    const dupId = JSON.stringify({ type: "send", text: "twice", queuedSendId: "q1" });
    const repeat = JSON.stringify({ type: "send", text: "hello" });

    let queue: string[] = [];
    queue = outboxAfterPersist(queue, first, JSON.parse(first));
    queue = outboxAfterPersist(queue, withId, JSON.parse(withId));
    queue = outboxAfterPersist(queue, dupId, JSON.parse(dupId));
    queue = outboxAfterPersist(queue, repeat, JSON.parse(repeat));

    expect(queue).toEqual([first, withId, repeat]);
  });

  it("re-opens identity restore only when a confirmed tab now holds user work", () => {
    expect(shouldReenterIdentityOnDeviceOffline(true, 1)).toBe(true);
    expect(shouldReenterIdentityOnDeviceOffline(true, 0)).toBe(false);
    expect(shouldReenterIdentityOnDeviceOffline(false, 1)).toBe(false);
    expect(shouldReenterIdentityOnDeviceOffline(false, 0)).toBe(false);
  });

  it("does not send ordinary work live during Device-offline grace", () => {
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: true,
      deviceOffline: false,
      offlineHold: false,
      isRestoreMessage: false,
      changesIdentity: false,
    })).toBe("send");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: true,
      deviceOffline: false,
      offlineHold: true,
      isRestoreMessage: false,
      changesIdentity: false,
    })).toBe("outbox");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: true,
      deviceOffline: true,
      offlineHold: false,
      isRestoreMessage: false,
      changesIdentity: false,
    })).toBe("outbox");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: false,
      deviceOffline: false,
      offlineHold: false,
      isRestoreMessage: false,
      changesIdentity: false,
    })).toBe("outbox");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: false,
      deviceOffline: false,
      offlineHold: true,
      isRestoreMessage: true,
      changesIdentity: false,
    })).toBe("send");
    expect(liveSendDisposition({
      socketOpen: false,
      identityRestoreComplete: true,
      isRestoreMessage: false,
      changesIdentity: false,
    })).toBe("outbox");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: false,
      deviceOffline: false,
      offlineHold: false,
      isRestoreMessage: false,
      changesIdentity: true,
    })).toBe("abandon-and-send");
  });

  it("holds the refused send and re-enters restore before swallowing the banner", () => {
    expect(deviceOfflineHandler).toContain("holdLiveOutboundInOutbox()");
    expect(deviceOfflineHandler).toContain("beginDeviceOfflineGrace()");
    expect(deviceOfflineHandler).toContain("shouldReenterIdentityOnDeviceOffline");
    expect(deviceOfflineHandler).toContain("beginIdentityRestore()");
    expect(deviceOfflineHandler.indexOf("holdLiveOutboundInOutbox()"))
      .toBeLessThan(deviceOfflineHandler.indexOf("beginDeviceOfflineGrace()"));
    expect(deviceOfflineHandler).toContain("return;");
    expect(deviceOfflineHandler).not.toContain("dispatchEvent");
  });

  it("remembers a live send so Device offline can put it back in the outbox", () => {
    expect(sendPath).toContain("rememberLiveOutbound(s, m)");
    expect(sendPath.indexOf('disposition === "send"'))
      .toBeLessThan(sendPath.indexOf("rememberLiveOutbound(s, m)"));
    expect(html).toContain("rememberLiveOutbound(raw, JSON.parse(raw))");
  });
});
