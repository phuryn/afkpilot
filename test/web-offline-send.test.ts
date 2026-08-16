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
  isNonRetryableRelayBounce,
  inboundFrameProvesDeviceAlive,
  sendCorrelationId,
  outboxAfterPersist,
  outboxAfterAck,
  shouldReenterIdentityOnDeviceOffline,
  liveSendDisposition,
  liveOutboundAfterRemember,
  liveOutboundAfterAck,
  liveOutboundHeldByOffline,
  liveOutboundAfterOfflineHold,
  liveOutboundAfterNamedDrop,
} = new Function(
  `${helpers}; return {
    isDeviceOfflineError,
    isNonRetryableRelayBounce,
    inboundFrameProvesDeviceAlive,
    sendCorrelationId,
    outboxAfterPersist,
    outboxAfterAck,
    shouldReenterIdentityOnDeviceOffline,
    liveSendDisposition,
    liveOutboundAfterRemember,
    liveOutboundAfterAck,
    liveOutboundHeldByOffline,
    liveOutboundAfterOfflineHold,
    liveOutboundAfterNamedDrop,
  };`,
)() as {
  isDeviceOfflineError: (data: unknown) => boolean;
  isNonRetryableRelayBounce: (data: unknown) => boolean;
  inboundFrameProvesDeviceAlive: (data: unknown) => boolean;
  sendCorrelationId: (message: unknown) => string;
  outboxAfterPersist: (current: string[], raw: string, message: unknown) => string[];
  outboxAfterAck: (current: string[], data: unknown) => string[];
  shouldReenterIdentityOnDeviceOffline: (restoreComplete: boolean, mournableCount: number) => boolean;
  liveSendDisposition: (opts: {
    socketOpen?: boolean;
    identityRestoreComplete?: boolean;
    deviceOffline?: boolean;
    offlineHold?: boolean;
    isRestoreMessage?: boolean;
    changesIdentity?: boolean;
  }) => "send" | "outbox" | "abandon-and-send";
  liveOutboundAfterRemember: (
    current: Array<{ raw: string; message: unknown }>,
    raw: string,
    message: unknown,
  ) => Array<{ raw: string; message: unknown }>;
  liveOutboundAfterAck: (
    current: Array<{ raw: string; message: unknown }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown }>;
  liveOutboundHeldByOffline: (
    current: Array<{ raw: string; message: unknown }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown }>;
  liveOutboundAfterOfflineHold: (
    current: Array<{ raw: string; message: unknown }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown }>;
  liveOutboundAfterNamedDrop: (
    current: Array<{ raw: string; message: unknown }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown }>;
};

const deviceOfflineHandler = html.slice(
  html.indexOf("Swallowing the banner must not swallow the send"),
  html.indexOf("A host error is still a live uplink"),
);

const sendPath = html.slice(
  html.indexOf("var disposition = liveSendDisposition"),
  html.indexOf("getState: function ()"),
);

const DEVICE_OFFLINE = {
  type: "error",
  text: "Device offline — VS Code isn't connected to the relay.",
};

function sendRaw(text: string, submissionId: string): string {
  return JSON.stringify({ type: "send", text, submissionId });
}

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

  it("treats a host error as proof of a live uplink, but not Device offline", () => {
    expect(inboundFrameProvesDeviceAlive({ type: "error", text: "CLI failed to start" })).toBe(true);
    expect(inboundFrameProvesDeviceAlive({ type: "error", text: "Free plan limit reached (20 messages this week)." })).toBe(true);
    expect(inboundFrameProvesDeviceAlive({ type: "sessions", activeId: "s1" })).toBe(true);
    expect(inboundFrameProvesDeviceAlive(DEVICE_OFFLINE)).toBe(false);
    expect(isNonRetryableRelayBounce({ type: "error", text: "Free plan limit reached (20 messages this week)." })).toBe(true);
    expect(isNonRetryableRelayBounce({ type: "error", text: "Slow down — at most 20 messages per minute." })).toBe(true);
    expect(isNonRetryableRelayBounce(DEVICE_OFFLINE)).toBe(false);
  });

  it("folds a refused live send into the existing outbox, deduping by queuedSendId or submissionId", () => {
    const first = JSON.stringify({ type: "send", text: "hello" });
    const withId = JSON.stringify({ type: "send", text: "once", queuedSendId: "q1" });
    const dupId = JSON.stringify({ type: "send", text: "twice", queuedSendId: "q1" });
    const repeat = JSON.stringify({ type: "send", text: "hello" });
    const withSub = sendRaw("sid", "sub-1");
    const dupSub = sendRaw("sid-again", "sub-1");

    let queue: string[] = [];
    queue = outboxAfterPersist(queue, first, JSON.parse(first));
    queue = outboxAfterPersist(queue, withId, JSON.parse(withId));
    queue = outboxAfterPersist(queue, dupId, JSON.parse(dupId));
    queue = outboxAfterPersist(queue, repeat, JSON.parse(repeat));
    queue = outboxAfterPersist(queue, withSub, JSON.parse(withSub));
    queue = outboxAfterPersist(queue, dupSub, JSON.parse(dupSub));

    expect(queue).toEqual([first, withId, repeat, withSub]);
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
    expect(deviceOfflineHandler).toContain("holdLiveOutboundInOutbox(data)");
    expect(deviceOfflineHandler).toContain("beginDeviceOfflineGrace()");
    expect(deviceOfflineHandler).toContain("shouldReenterIdentityOnDeviceOffline");
    expect(deviceOfflineHandler).toContain("beginIdentityRestore()");
    expect(deviceOfflineHandler.indexOf("holdLiveOutboundInOutbox(data)"))
      .toBeLessThan(deviceOfflineHandler.indexOf("beginDeviceOfflineGrace()"));
    expect(deviceOfflineHandler).toContain("return;");
    expect(deviceOfflineHandler).not.toContain("dispatchEvent");
    expect(deviceOfflineHandler).not.toContain("clearLiveOutbound");
  });

  it("remembers a live send so Device offline can put it back in the outbox", () => {
    expect(sendPath).toContain("rememberLiveOutbound(s, m)");
    expect(sendPath.indexOf('disposition === "send"'))
      .toBeLessThan(sendPath.indexOf("rememberLiveOutbound(s, m)"));
    expect(html).toContain("rememberLiveOutbound(raw, JSON.parse(raw))");
    expect(html).toContain("acknowledgeLiveOutbound(data)");
    expect(html).toContain("forgetUnbouncedLiveOutbound()");
  });

  it("an unrelated frame during the increment await does not erase the retry record", () => {
    // Host emits a snapshot or a generic error, then dies, while usage.increment
    // is still awaiting. Clearing on that traffic reconstitutes the original
    // silent loss: the later Device-offline bounce finds nothing to hold.
    const raw = sendRaw("typed during increment", "sub-inc");
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "sessions", activeId: "s1" });
    live = liveOutboundAfterAck(live, { type: "initialState", cwd: "/tmp" });
    live = liveOutboundAfterAck(live, { type: "error", text: "CLI failed to start" });
    expect(live).toHaveLength(1);
    expect(sendCorrelationId(live[0].message)).toBe("sub-inc");

    const bounce = { ...DEVICE_OFFLINE, submissionId: "sub-inc" };
    const held = liveOutboundHeldByOffline(live, bounce);
    expect(held.map((e) => e.raw)).toEqual([raw]);
  });

  it("a later offline bounce does not replay an accepted prompt whose ack was lost", () => {
    const rawA = sendRaw("already accepted", "sub-a");
    const rawB = sendRaw("later action", "sub-b");
    let live = liveOutboundAfterRemember([], rawA, JSON.parse(rawA));
    live = liveOutboundAfterRemember(live, rawB, JSON.parse(rawB));

    // A's userMessage was lost with the host. B is the send the bounce names.
    const bounceB = { ...DEVICE_OFFLINE, submissionId: "sub-b" };
    const held = liveOutboundHeldByOffline(live, bounceB);
    expect(held.map((e) => sendCorrelationId(e.message))).toEqual(["sub-b"]);

    live = liveOutboundAfterOfflineHold(live, bounceB);
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-a"]);

    let queue: string[] = [];
    for (const entry of held) {
      queue = outboxAfterPersist(queue, entry.raw, entry.message);
    }
    // Confirmed restore drops the unbounced accepted prompt rather than
    // flushing it a second time.
    expect(queue).toEqual([rawB]);
  });

  it("clears only the echoed submission, including an old host's text-only userMessage", () => {
    const rawA = sendRaw("first", "sub-a");
    const rawB = sendRaw("second", "sub-b");
    let live = liveOutboundAfterRemember([], rawA, JSON.parse(rawA));
    live = liveOutboundAfterRemember(live, rawB, JSON.parse(rawB));

    live = liveOutboundAfterAck(live, { type: "userMessage", text: "first", submissionId: "sub-a" });
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-b"]);

    const rawOld = sendRaw("legacy text", "sub-old");
    live = liveOutboundAfterRemember(live, rawOld, JSON.parse(rawOld));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "legacy text" });
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-b"]);

    live = liveOutboundAfterAck(live, { type: "userMessage", text: "steer note", steer: true });
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-b"]);
  });

  it("pulls an already-held send out of the outbox when its userMessage finally arrives", () => {
    const raw = sendRaw("held then acked", "sub-hold");
    let queue = outboxAfterPersist([], raw, JSON.parse(raw));
    queue = outboxAfterAck(queue, { type: "userMessage", text: "held then acked", submissionId: "sub-hold" });
    expect(queue).toEqual([]);
  });

  it("a quota bounce drops that send so it cannot ride a later Device-offline retry", () => {
    const raw = sendRaw("over quota", "sub-q");
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterNamedDrop(live, {
      type: "error",
      text: "Free plan limit reached (20 messages this week).",
      submissionId: "sub-q",
    });
    expect(live).toEqual([]);
    expect(liveOutboundHeldByOffline(live, { ...DEVICE_OFFLINE, submissionId: "sub-q" })).toEqual([]);
  });

  it("an untagged Device-offline bounce does not sweep id-bearing prompts", () => {
    const raw = sendRaw("named", "sub-named");
    const untagged = JSON.stringify({ type: "queueSend", text: "busy" });
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterRemember(live, untagged, JSON.parse(untagged));
    const held = liveOutboundHeldByOffline(live, DEVICE_OFFLINE);
    expect(held.map((e) => e.raw)).toEqual([untagged]);
  });

  it("an error-only returning host still clears grace and re-arms the fail timer", () => {
    expect(html).toContain("inboundFrameProvesDeviceAlive(data)");
    expect(html).toContain("A host error is still a live uplink");
    expect(html).not.toMatch(/if \(data && data\.type !== "error"\) \{\s*clearOfflineGrace/);
    const graceBlock = html.slice(
      html.indexOf("A host error is still a live uplink"),
      html.indexOf("Quota bounce: surface the wall"),
    );
    expect(graceBlock).toContain("clearOfflineGrace()");
    expect(graceBlock).toContain("armIdentityFailTimer()");
    expect(graceBlock).toContain("data.type === \"error\"");
    expect(graceBlock).toContain("readyMessage()");
    expect(graceBlock.indexOf("data.type === \"error\""))
      .toBeLessThan(graceBlock.indexOf("readyMessage()"));
  });
});
