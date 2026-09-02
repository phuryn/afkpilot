import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

// Behavioural extract of the offline-send helpers in web/chat.html. The
// lifecycle suite is the full product check; these pin the decisions that
// fail silently if they regress: a refused live send must re-enter the
// existing outbox, and identity-complete is not a license to keep sending
// into a Device-offline grace window.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const helpersStart = html.indexOf("function isDeviceOfflineError(data)");
const helpersEnd = html.indexOf("function persistOutboxMessage(raw, message, authored)");
const helpers = html.slice(helpersStart, helpersEnd);

const {
  isDeviceOfflineError,
  isNonRetryableRelayBounce,
  inboundFrameProvesDeviceAlive,
  inboundFrameIsReplacementHostReturn,
  inboundFrameClearsOfflineHold,
  errorCodeFromFrame,
  sendCorrelationId,
  isUntaggedOfflineHoldExcluded,
  outboxAfterPersist,
  outboxAfterAck,
  shouldReenterIdentityOnDeviceOffline,
  liveSendDisposition,
  isQueueReleaseMessage,
  queueReleaseText,
  legacyOutboxAuthoredText,
  authoredTextFromAuthoringSurface,
  authoredStoreAfterPersist,
  authoredStoreAfterRemoveOne,
  authoredStoreAfterRemoveAll,
  outboxDispositionForMessage,
  liveOutboundAfterRemember,
  liveOutboundAfterAck,
  liveOutboundHeldByOffline,
  liveOutboundAfterOfflineHold,
  liveOutboundRecoveredByOffline,
  authoredTextsFromLiveOutbound,
  queueAfterDropUnreplayable,
  liveOutboundAfterNamedDrop,
  liveOutboundRecoveredByNonRetryable,
  liveOutboundAfterNonRetryable,
  liveOutboundParkedByReplacement,
  liveOutboundRecoveredByReplacement,
  isUserControlAction,
  noteControlActionSent,
  claimBouncedControlAction,
  forgetControlActions,
} = new Function(
  `${helpers}; return {
    isDeviceOfflineError,
    isNonRetryableRelayBounce,
    inboundFrameProvesDeviceAlive,
    inboundFrameIsReplacementHostReturn,
    inboundFrameClearsOfflineHold,
    errorCodeFromFrame,
    sendCorrelationId,
    isUntaggedOfflineHoldExcluded,
    outboxAfterPersist,
    outboxAfterAck,
    shouldReenterIdentityOnDeviceOffline,
    liveSendDisposition,
    isQueueReleaseMessage,
    queueReleaseText,
    legacyOutboxAuthoredText,
    authoredTextFromAuthoringSurface,
    authoredStoreAfterPersist,
    authoredStoreAfterRemoveOne,
    authoredStoreAfterRemoveAll,
    outboxDispositionForMessage,
    liveOutboundAfterRemember,
    liveOutboundAfterAck,
    liveOutboundHeldByOffline,
    liveOutboundAfterOfflineHold,
    liveOutboundRecoveredByOffline,
    authoredTextsFromLiveOutbound,
    queueAfterDropUnreplayable,
    liveOutboundAfterNamedDrop,
    liveOutboundRecoveredByNonRetryable,
    liveOutboundAfterNonRetryable,
    liveOutboundParkedByReplacement,
    liveOutboundRecoveredByReplacement,
    isUserControlAction,
    noteControlActionSent,
    claimBouncedControlAction,
    forgetControlActions,
  };`,
)() as {
  isDeviceOfflineError: (data: unknown) => boolean;
  isNonRetryableRelayBounce: (data: unknown) => boolean;
  inboundFrameProvesDeviceAlive: (data: unknown) => boolean;
  inboundFrameIsReplacementHostReturn: (data: unknown) => boolean;
  inboundFrameClearsOfflineHold: (data: unknown, captureActive: boolean) => boolean;
  errorCodeFromFrame: (data: unknown) => string;
  sendCorrelationId: (message: unknown) => string;
  isUntaggedOfflineHoldExcluded: (message: unknown) => boolean;
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
  isQueueReleaseMessage: (message: unknown) => boolean;
  queueReleaseText: (message: unknown) => string;
  legacyOutboxAuthoredText: (message: unknown) => string;
  authoredTextFromAuthoringSurface: (el: unknown) => string;
  authoredStoreAfterPersist: (store: string[], text: string) => string[];
  authoredStoreAfterRemoveOne: (store: string[], text: string) => string[];
  authoredStoreAfterRemoveAll: (store: string[], texts: string[]) => string[];
  outboxDispositionForMessage: (message: unknown, authored?: string) => "persist" | "recover" | "drop";
  liveOutboundAfterRemember: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    raw: string,
    message: unknown,
    authored?: string,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundAfterAck: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundHeldByOffline: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundAfterOfflineHold: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundRecoveredByOffline: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => string[];
  authoredTextsFromLiveOutbound: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
  ) => string[];
  queueAfterDropUnreplayable: (current: string[]) => { kept: string[]; recovered: string[] };
  liveOutboundAfterNamedDrop: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundRecoveredByNonRetryable: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => string[];
  liveOutboundAfterNonRetryable: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
    data: unknown,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundParkedByReplacement: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
  ) => Array<{ raw: string; message: unknown; authored?: string }>;
  liveOutboundRecoveredByReplacement: (
    current: Array<{ raw: string; message: unknown; authored?: string }>,
  ) => string[];
};

type SurfaceNode = {
  classList?: { contains: (name: string) => boolean };
  value?: string;
  hidden?: boolean;
  closest: (selector: string) => SurfaceNode | null;
  querySelector?: (selector: string) => SurfaceNode | null;
  querySelectorAll?: (selector: string) => SurfaceNode[];
};

function classListOf(...names: string[]) {
  return { contains: (name: string) => names.includes(name) };
}

const deviceOfflineHandler = html.slice(
  html.indexOf("Swallowing the banner must not swallow the send"),
  html.indexOf("A host error is still a live uplink"),
);

const sendPath = html.slice(
  html.indexOf("var authored = takePendingUiAuthored"),
  html.indexOf("getState: function ()"),
);

const DEVICE_OFFLINE = {
  type: "error",
  text: "Device offline — that machine isn't connected to the relay.",
};

function sendRaw(text: string, submissionId: string): string {
  return JSON.stringify({ type: "send", text, submissionId });
}

/** Resume-triggered replacement: the original frame may still land, and the
 *  successor may flush parked copies. A host that deduplicates by
 *  submissionId keeps one copy; an older host keeps every copy. */
function deliveriesAfterReplacementRedial(opts: {
  hostDedupes: boolean;
  originalLanded: boolean;
}): string[] {
  const raw = sendRaw("in-flight prompt", "sub-redial");
  const live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
  let queue: string[] = [];
  for (const entry of liveOutboundParkedByReplacement(live)) {
    queue = outboxAfterPersist(queue, entry.raw, entry.message);
  }
  const arrivals = [...(opts.originalLanded ? [raw] : []), ...queue];
  if (!opts.hostDedupes) return arrivals;
  const seen = new Set<string>();
  return arrivals.filter((item) => {
    const id = JSON.parse(item).submissionId as string;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

describe("offline live-send hold", () => {
  it("reads an additive error code and ignores host copy", () => {
    expect(errorCodeFromFrame({ type: "error", text: "anything", code: "interrupted-send" })).toBe("interrupted-send");
    expect(errorCodeFromFrame({ type: "error", text: "The session restarted while this message was being sent, so delivery is uncertain." })).toBe("");
    expect(errorCodeFromFrame({ type: "error", code: 1 })).toBe("");
    expect(errorCodeFromFrame({ type: "agentError", code: "interrupted-send" })).toBe("");
    expect(errorCodeFromFrame(null)).toBe("");
  });

  it("matches the relay's fixed Device offline prefix and nothing else", () => {
    expect(isDeviceOfflineError({
      type: "error",
      text: "Device offline — that machine isn't connected to the relay.",
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
    // ONE thing may speak here, and only when the bounce names something this
    // page just sent: a refused control action. The BANNER stays swallowed,
    // which is what this guard has always been protecting — a Device offline
    // right after reconnect is a race, not a state. Pinned as a CONDITIONAL so
    // an unconditional notice cannot creep back in.
    expect(deviceOfflineHandler).toContain(
      "if (claimBouncedControlAction(data)) announceControlActionNotSent();",
    );
  });

  it("remembers a live send so Device offline can put it back in the outbox", () => {
    expect(sendPath).toContain("rememberLiveOutbound(s, m, authored)");
    expect(sendPath.indexOf('disposition === "send"'))
      .toBeLessThan(sendPath.indexOf("rememberLiveOutbound(s, m, authored)"));
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

    // Kind-matching: a steer echo of the same words is not that send's ack.
    const sameText = sendRaw("hello", "sub-hello");
    live = liveOutboundAfterRemember(live, sameText, JSON.parse(sameText));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "hello", steer: true });
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-b", "sub-hello"]);
  });

  function recoveredByReplacement(
    live: Array<{ raw: string; message: unknown; authored?: string }>,
  ) {
    return liveOutboundRecoveredByReplacement(live);
  }

  it("an acknowledged queueSend leaves the list; a later replacement recovers nothing", () => {
    const raw = JSON.stringify({ type: "queueSend", text: "from the queue" });
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "queuedSends", items: ["from the queue"] });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);

    live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, {
      type: "queuedSends",
      items: ["from the queue"],
      queued: [{ text: "from the queue" }],
    });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);
  });

  it("an acknowledged steerSend leaves the list; a later replacement recovers nothing", () => {
    const raw = JSON.stringify({ type: "steerSend", text: "steer this now", fromQueue: true });
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "steer this now", steer: true });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);
  });

  it("a steer acknowledged via queuedSends is not recovered later", () => {
    const raw = JSON.stringify({ type: "steerSend", text: "steer this now" });
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "queuedSends", items: ["steer this now"] });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);

    live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, {
      type: "queuedSends",
      items: ["steer this now"],
      queued: [{ text: "steer this now" }],
    });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);
  });

  it("an unacknowledged queue send is still recovered exactly once", () => {
    const raw = JSON.stringify({ type: "queueSend", text: "still in flight" });
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "sessions", activeId: "s1" });
    live = liveOutboundAfterAck(live, { type: "queuedSends", items: [] });
    live = liveOutboundAfterAck(live, { type: "queuedSends", items: ["some other prompt"] });
    expect(live).toHaveLength(1);
    expect(recoveredByReplacement(live)).toEqual(["still in flight"]);
  });

  it("an ordinary acknowledged send still leaves, as today", () => {
    const raw = sendRaw("typed", "sub-typed");
    let live = liveOutboundAfterRemember([], raw, JSON.parse(raw));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "typed", submissionId: "sub-typed" });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);

    const legacy = sendRaw("legacy text", "sub-legacy");
    live = liveOutboundAfterRemember([], legacy, JSON.parse(legacy));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "legacy text" });
    expect(live).toEqual([]);
    expect(recoveredByReplacement(live)).toEqual([]);
  });

  it("two identical prompts, one acknowledged and one not: only the unacknowledged one is recovered", () => {
    const queued = JSON.stringify({ type: "queueSend", text: "hello" });
    const send = sendRaw("hello", "sub-hello");
    let live = liveOutboundAfterRemember([], queued, JSON.parse(queued));
    live = liveOutboundAfterRemember(live, send, JSON.parse(send));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "hello", submissionId: "sub-hello" });
    expect(live.map((e) => (e.message as { type: string }).type)).toEqual(["queueSend"]);
    expect(recoveredByReplacement(live)).toEqual(["hello"]);

    const first = JSON.stringify({ type: "queueSend", text: "hello" });
    const second = JSON.stringify({ type: "queueSend", text: "hello" });
    live = liveOutboundAfterRemember([], first, JSON.parse(first));
    live = liveOutboundAfterRemember(live, second, JSON.parse(second));
    live = liveOutboundAfterAck(live, { type: "queuedSends", items: ["hello"] });
    expect(live).toHaveLength(1);
    expect(recoveredByReplacement(live)).toEqual(["hello"]);

    const steer = JSON.stringify({ type: "steerSend", text: "hello" });
    live = liveOutboundAfterRemember([], send, JSON.parse(send));
    live = liveOutboundAfterRemember(live, steer, JSON.parse(steer));
    live = liveOutboundAfterAck(live, { type: "userMessage", text: "hello", steer: true });
    expect(live.map((e) => (e.message as { type: string }).type)).toEqual(["send"]);
    expect(recoveredByReplacement(live)).toEqual(["hello"]);
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

  it("an untagged bounce does not hold restore bookkeeping as if it were a prompt", () => {
    const resume = JSON.stringify({ type: "resumeSession", id: "s1", cwd: "/work/legacy" });
    const list = JSON.stringify({ type: "listSessions" });
    const send = JSON.stringify({ type: "send", text: "old-host prompt" });
    let live = liveOutboundAfterRemember([], resume, JSON.parse(resume));
    live = liveOutboundAfterRemember(live, list, JSON.parse(list));
    live = liveOutboundAfterRemember(live, send, JSON.parse(send));
    const held = liveOutboundHeldByOffline(live, DEVICE_OFFLINE);
    expect(held.map((e) => e.raw)).toEqual([send]);
  });

  it("recovers authored card text instead of holding the frame for replay", () => {
    const created = JSON.stringify({ type: "newSession" });
    const plan = JSON.stringify({
      type: "exitPlanAnswer",
      requestId: 1,
      verdict: "rejected",
      comment: "plan the auth part again",
    });
    const question = JSON.stringify({
      type: "questionAnswer",
      requestId: 2,
      answers: ["the free-text answer"],
    });
    const questionMap = JSON.stringify({
      type: "questionAnswer",
      requestId: 4,
      answers: { "What next?": "do the auth part" },
    });
    const permission = JSON.stringify({
      type: "permissionAnswer",
      requestId: 3,
      optionId: "allow_once",
    });
    const speech = JSON.stringify({ type: "summarizeSpeech", requestId: 9, text: "an agent reply" });
    const unknown = JSON.stringify({ type: "futureAuthoredFrame", text: "typed" });
    const prompt = sendRaw("later prompt", "sub-later");
    let live = liveOutboundAfterRemember([], created, JSON.parse(created));
    live = liveOutboundAfterRemember(live, plan, JSON.parse(plan), "plan the auth part again");
    live = liveOutboundAfterRemember(live, question, JSON.parse(question), "the free-text answer");
    live = liveOutboundAfterRemember(live, questionMap, JSON.parse(questionMap), "do the auth part");
    live = liveOutboundAfterRemember(live, permission, JSON.parse(permission));
    live = liveOutboundAfterRemember(live, speech, JSON.parse(speech));
    live = liveOutboundAfterRemember(live, unknown, JSON.parse(unknown));
    live = liveOutboundAfterRemember(live, prompt, JSON.parse(prompt));

    expect(isQueueReleaseMessage(JSON.parse(plan))).toBe(false);
    expect(isQueueReleaseMessage(JSON.parse(prompt))).toBe(true);
    expect(outboxDispositionForMessage(JSON.parse(plan))).toBe("drop");
    expect(outboxDispositionForMessage(JSON.parse(plan), "plan the auth part again")).toBe("recover");
    expect(outboxDispositionForMessage(JSON.parse(permission))).toBe("drop");
    expect(outboxDispositionForMessage(JSON.parse(created))).toBe("drop");
    expect(outboxDispositionForMessage(JSON.parse(speech), "")).toBe("drop");
    expect(outboxDispositionForMessage(JSON.parse(prompt))).toBe("persist");
    expect(legacyOutboxAuthoredText(JSON.parse(plan))).toBe("plan the auth part again");
    expect(legacyOutboxAuthoredText(JSON.parse(question))).toBe("the free-text answer");
    expect(legacyOutboxAuthoredText(JSON.parse(questionMap))).toBe("do the auth part");
    expect(legacyOutboxAuthoredText(JSON.parse(permission))).toBe("");
    expect(legacyOutboxAuthoredText(JSON.parse(speech))).toBe("");
    expect(legacyOutboxAuthoredText(JSON.parse(unknown))).toBe("");

    const held = liveOutboundHeldByOffline(live, DEVICE_OFFLINE);
    expect(held.map((e) => e.raw)).toEqual([]);
    expect(liveOutboundRecoveredByOffline(live, DEVICE_OFFLINE)).toEqual([
      "plan the auth part again",
      "the free-text answer",
      "do the auth part",
    ]);
    live = liveOutboundAfterOfflineHold(live, DEVICE_OFFLINE);
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-later"]);
    expect(isUntaggedOfflineHoldExcluded(JSON.parse(plan))).toBe(false);
    expect(isUntaggedOfflineHoldExcluded({ type: "resumeSession", id: "s1" })).toBe(true);
    expect(isUntaggedOfflineHoldExcluded({ type: "listSessions" })).toBe(true);
    expect(isUntaggedOfflineHoldExcluded({ type: "selectRepo", cwd: "/work" })).toBe(true);
  });

  it("strips unreplayable authored frames from a restored queue and keeps prompts", () => {
    const send = sendRaw("keep me", "sub-keep");
    const plan = JSON.stringify({
      type: "exitPlanAnswer",
      requestId: 1,
      verdict: "rejected",
      comment: "plan the auth part again",
    });
    const speech = JSON.stringify({ type: "summarizeSpeech", requestId: 9, text: "an agent reply" });
    const prefs = JSON.stringify({ type: "remotePreferences", showThinking: true });
    const stripped = queueAfterDropUnreplayable([send, plan, speech, prefs]);
    expect(stripped.kept).toEqual([send, prefs]);
    expect(stripped.recovered).toEqual(["plan the auth part again"]);
    expect(authoredTextsFromLiveOutbound([
      { raw: plan, message: JSON.parse(plan), authored: "plan the auth part again" },
    ])).toEqual(["plan the auth part again"]);
    expect(authoredTextsFromLiveOutbound([
      { raw: speech, message: JSON.parse(speech) },
    ])).toEqual([]);
  });

  it("captures typed text from the authoring control, not from frame fields", () => {
    const feedback: SurfaceNode = { value: "plan the auth part again", closest: () => null };
    const plan: SurfaceNode = {
      classList: classListOf("card", "plan"),
      closest: (sel) => sel === ".card.plan" ? plan : null,
      querySelector: (sel) => sel === ".plan-feedback" ? feedback : null,
    };
    const planBtn: SurfaceNode = {
      classList: classListOf(),
      closest: (sel) => {
        if (sel === ".card.plan") return plan;
        if (sel === ".card-actions") return plan;
        return null;
      },
    };
    expect(authoredTextFromAuthoringSurface(planBtn)).toBe("plan the auth part again");

    const other: SurfaceNode = { value: "do the auth part", hidden: false, closest: () => null };
    const question: SurfaceNode = {
      classList: classListOf("card", "question"),
      closest: (sel) => sel === ".card.question" ? question : null,
      querySelectorAll: (sel) => sel === ".question-other-input" ? [other] : [],
    };
    const submit: SurfaceNode = {
      classList: classListOf(),
      closest: (sel) => {
        if (sel === ".card.question") return question;
        if (sel === ".card-actions") return question;
        return null;
      },
    };
    expect(authoredTextFromAuthoringSurface(submit)).toBe("do the auth part");

    const name: SurfaceNode = {
      classList: classListOf("session-name-input"),
      value: "Sprint planning",
      closest: () => null,
    };
    expect(authoredTextFromAuthoringSurface(name)).toBe("Sprint planning");

    const phrase: SurfaceNode = {
      classList: classListOf("settings-text"),
      value: "okay grok",
      closest: () => null,
    };
    expect(authoredTextFromAuthoringSurface(phrase)).toBe("okay grok");

    const overlay = {
      classList: classListOf("confirm-overlay"),
      closest(sel: string) { return sel === ".confirm-overlay" ? this : null; },
      querySelector(sel: string) { return sel === ".confirm-input" ? confirmInput : null; },
    } as SurfaceNode;
    const confirmInput: SurfaceNode = {
      classList: classListOf("confirm-input"),
      value: "Rail title",
      closest: () => overlay,
    };
    const ok: SurfaceNode = {
      classList: classListOf("confirm-primary"),
      closest: (sel) => sel === ".confirm-overlay" ? overlay : null,
    };
    expect(authoredTextFromAuthoringSurface(ok)).toBe("Rail title");
    expect(authoredTextFromAuthoringSurface({
      classList: classListOf(),
      closest: () => null,
    })).toBe("");
  });

  it("keeps authored drafts in a durable store until they are removed", () => {
    let store = authoredStoreAfterPersist([], "plan the auth part again");
    store = authoredStoreAfterPersist(store, "Sprint planning");
    expect(store).toEqual(["plan the auth part again", "Sprint planning"]);
    store = authoredStoreAfterRemoveOne(store, "plan the auth part again");
    expect(store).toEqual(["Sprint planning"]);
    store = authoredStoreAfterRemoveAll(store, ["Sprint planning", "missing"]);
    expect(store).toEqual([]);
  });

  it("returns an untagged quota bounce's captured text instead of dropping it", () => {
    const plan = JSON.stringify({
      type: "exitPlanAnswer",
      requestId: 1,
      verdict: "rejected",
      comment: "plan the auth part again",
    });
    const prompt = sendRaw("over quota", "sub-q");
    let live = liveOutboundAfterRemember([], plan, JSON.parse(plan), "plan the auth part again");
    live = liveOutboundAfterRemember(live, prompt, JSON.parse(prompt));
    const quota = {
      type: "error",
      text: "Slow down — at most 20 messages per minute.",
    };
    expect(liveOutboundRecoveredByNonRetryable(live, quota)).toEqual([
      "plan the auth part again",
    ]);
    live = liveOutboundAfterNonRetryable(live, quota);
    expect(live.map((e) => sendCorrelationId(e.message))).toEqual(["sub-q"]);
  });

  it("an error-only returning host still clears grace and re-arms the fail timer", () => {
    expect(html).toContain("inboundFrameProvesDeviceAlive(data)");
    expect(html).toContain("A host error is still a live uplink");
    expect(html).not.toMatch(/if \(data && data\.type !== "error"\) \{\s*clearOfflineGrace/);
    const applyFn = html.slice(
      html.indexOf("function applyInboundDeviceAlive"),
      html.indexOf("function applyRememberedHostReturnIfIdle"),
    );
    expect(applyFn).toContain("clearOfflineGrace()");
    expect(applyFn).toContain("armIdentityFailTimer()");
    expect(applyFn).toContain("data.type === \"error\"");
    expect(applyFn).toContain("readyMessage()");
    expect(applyFn.indexOf("data.type === \"error\""))
      .toBeLessThan(applyFn.indexOf("readyMessage()"));
    const graceBlock = html.slice(
      html.indexOf("A host error is still a live uplink"),
      html.indexOf("Quota bounce: surface the wall"),
    );
    expect(graceBlock).toContain("applyInboundDeviceAlive(data)");
    expect(graceBlock).toContain("voiceCaptureActive()");
    expect(graceBlock).toContain("inboundFrameClearsOfflineHold");
    expect(graceBlock).toContain("inboundFrameIsReplacementHostReturn");
    expect(graceBlock).toContain("hostReturnDuringCapture");
    expect(graceBlock).not.toContain("inboundFrameProvesDeviceAlive(data) && !voiceCaptureActive()");
  });

  it("remembers a replacement-host snapshot during capture and applies it once the mic stops", () => {
    expect(inboundFrameIsReplacementHostReturn({ type: "initialState", cwd: "/work" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn({ type: "clearMessages" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn({ type: "sessions", activeId: "s1" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn({ type: "session" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn({ type: "repos" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn({ type: "setBusy", value: false })).toBe(false);
    expect(inboundFrameIsReplacementHostReturn({ type: "error", text: "CLI failed to start" })).toBe(true);
    expect(inboundFrameIsReplacementHostReturn(DEVICE_OFFLINE)).toBe(false);
    expect(inboundFrameClearsOfflineHold({ type: "error", text: "CLI failed to start" }, true)).toBe(false);

    expect(inboundFrameClearsOfflineHold({ type: "initialState" }, false)).toBe(true);
    expect(inboundFrameClearsOfflineHold({ type: "initialState" }, true)).toBe(false);
    expect(inboundFrameClearsOfflineHold({ type: "setBusy", value: false }, true)).toBe(false);
    expect(inboundFrameClearsOfflineHold({ type: "setBusy", value: false }, false)).toBe(true);
    expect(inboundFrameClearsOfflineHold(DEVICE_OFFLINE, false)).toBe(false);

    const persistFn = html.slice(
      html.indexOf("function handlePersistentDeviceOffline"),
      html.indexOf("function beginDeviceOfflineGrace"),
    );
    expect(persistFn).toContain("applyRememberedHostReturnIfIdle()");
    expect(persistFn).toContain("interruptRemoteVoice");
    expect(persistFn.indexOf("interruptRemoteVoice"))
      .toBeLessThan(persistFn.indexOf("applyRememberedHostReturnIfIdle()"));
    expect(html).toContain("function applyRememberedHostReturnIfIdle");
    expect(html).toContain("function applyInboundDeviceAlive");
  });

  it("probes a false-offline host once, not on a timer that races the flush", () => {
    const graceFn = html.slice(
      html.indexOf("function beginDeviceOfflineGrace"),
      html.indexOf("function flushRestoredOutbox"),
    );
    expect(graceFn).toContain("readyMessage()");
    expect(graceFn).not.toContain("setInterval");
    expect(graceFn).not.toContain("3000");
    expect(graceFn.indexOf("hostReturnDuringCapture = null"))
      .toBeLessThan(graceFn.indexOf("if (deviceOffline || offlineHold) return"));
  });

  it("does not persist uncorrelated frames into the outbox for later replay", () => {
    const persistFn = html.slice(
      html.indexOf("function persistOutboxMessage"),
      html.indexOf("var liveOutbound = []"),
    );
    expect(persistFn).toContain("outboxDispositionForMessage(message, authored)");
    expect(persistFn).toContain("recoverAuthoredTexts");
    expect(html).toContain("liveOutboundRecoveredByOffline");
    expect(html).toContain("recoverAuthoredFromLiveOutbound()");
    expect(html).toContain("queueAfterDropUnreplayable");
    expect(html).toContain("authoredTextFromAuthoringSurface");
    expect(html).toContain("takePendingUiAuthored");
    expect(html).toContain("afk-authored:");
    expect(html).toContain("authoredStoreAfterPersist(authoredDrafts");
    expect(html).not.toContain("pendingAuthoredRecovery");
    expect(html).not.toMatch(/if \(typeof message\.text === "string" && message\.text\) return message\.text/);
    expect(html.slice(
      html.indexOf("function handlePersistentDeviceOffline"),
      html.indexOf("function beginDeviceOfflineGrace"),
    )).toContain("flushPendingAuthoredRecovery()");
    expect(sendPath).toContain("takePendingUiAuthored()");
    expect(sendPath).toContain("isQueueReleaseMessage(m) || authored");
  });

  it("does not let a live capture's ready-probe snapshot cancel the persist timer", () => {
    const graceFn = html.slice(
      html.indexOf("function beginDeviceOfflineGrace"),
      html.indexOf("function flushRestoredOutbox"),
    );
    expect(graceFn).toContain("!voiceCaptureActive()");
    expect(graceFn.indexOf("!voiceCaptureActive()"))
      .toBeLessThan(graceFn.indexOf("readyMessage()"));
    expect(html).toContain("function voiceCaptureActive()");
  });

  it("closes a Device-offline identity re-entry when grace expires, without flushing", () => {
    const persistFn = html.slice(
      html.indexOf("function handlePersistentDeviceOffline"),
      html.indexOf("function beginDeviceOfflineGrace"),
    );
    expect(persistFn).toContain("identityEverCompleted");
    expect(persistFn).toContain("mournableQueueCount() === 0");
    expect(persistFn).toContain("finishIdentityRestore()");
    expect(persistFn).not.toContain("flushRestoredOutbox()");
  });

  function rememberLive(message: unknown, authored?: string) {
    const raw = JSON.stringify(message);
    return liveOutboundAfterRemember([], raw, message, authored);
  }

  function outboxAfterPark(live: ReturnType<typeof liveOutboundAfterRemember>) {
    let queue: string[] = [];
    for (const entry of liveOutboundParkedByReplacement(live)) {
      queue = outboxAfterPersist(queue, entry.raw, entry.message);
    }
    return queue;
  }

  it("text sent just before a socket replacement is not re-queued", () => {
    // Replaying an in-flight send treats "unacknowledged" as "not delivered".
    // The original can still land, and a second copy then runs the prompt
    // again. Replacement recovers the text instead; nothing is parked.
    const live = rememberLive({ type: "send", text: "sent-before-replace", submissionId: "sub-replace" });
    expect(liveOutboundParkedByReplacement(live)).toEqual([]);
    expect(outboxAfterPark(live)).toEqual([]);
  });

  it("a queue-release send in flight during a probe replacement returns to the composer once", () => {
    const queued = rememberLive({ type: "queueSend", text: "from the queue" });
    expect(liveOutboundParkedByReplacement(queued)).toEqual([]);
    expect(outboxAfterPark(queued)).toEqual([]);
    expect(liveOutboundRecoveredByReplacement(queued)).toEqual(["from the queue"]);

    const steered = rememberLive({ type: "steerSend", text: "steer this now", fromQueue: true });
    expect(liveOutboundParkedByReplacement(steered)).toEqual([]);
    expect(liveOutboundRecoveredByReplacement(steered)).toEqual(["steer this now"]);

    const flushed = rememberLive({ type: "send", text: "host flushed this", queuedSendId: "q1" });
    expect(liveOutboundRecoveredByReplacement(flushed)).toEqual(["host flushed this"]);

    // Authored capture of the same words must not double them.
    const alsoCaptured = rememberLive({ type: "queueSend", text: "from the queue" }, "from the queue");
    expect(liveOutboundRecoveredByReplacement(alsoCaptured)).toEqual(["from the queue"]);
  });

  it("a typed send in flight during a probe replacement is still recovered, never replayed", () => {
    const typed = rememberLive({ type: "send", text: "typed in this tab", submissionId: "sub-typed" });
    expect(liveOutboundParkedByReplacement(typed)).toEqual([]);
    expect(outboxAfterPark(typed)).toEqual([]);
    expect(liveOutboundRecoveredByReplacement(typed)).toEqual(["typed in this tab"]);

    const plan = JSON.stringify({
      type: "exitPlanAnswer", requestId: 1, verdict: "rejected",
    });
    const leftover = liveOutboundAfterRemember(typed, plan, JSON.parse(plan), "plan comment");
    expect(liveOutboundParkedByReplacement(leftover)).toEqual([]);
    expect(liveOutboundRecoveredByReplacement(leftover)).toEqual(["typed in this tab", "plan comment"]);
  });

  it("queue-release recovery sniffs .text only on send/queueSend/steerSend", () => {
    expect(queueReleaseText({ type: "queueSend", text: "busy" })).toBe("busy");
    expect(queueReleaseText({ type: "steerSend", text: "now" })).toBe("now");
    expect(queueReleaseText({ type: "send", text: "typed" })).toBe("typed");
    expect(queueReleaseText({ type: "summarizeSpeech", text: "an agent reply" })).toBe("");
    expect(queueReleaseText({ type: "exitPlanAnswer", text: "not a prompt", comment: "plan" })).toBe("");
    const speech = rememberLive({ type: "summarizeSpeech", requestId: 9, text: "an agent reply" });
    expect(liveOutboundRecoveredByReplacement(speech)).toEqual([]);
  });

  it("a send in flight during a resume-triggered redial arrives exactly once on a host that deduplicates", () => {
    expect(deliveriesAfterReplacementRedial({
      hostDedupes: true,
      originalLanded: true,
    })).toEqual([sendRaw("in-flight prompt", "sub-redial")]);
  });

  it("on a host that does not deduplicate, the same case does not deliver twice", () => {
    expect(deliveriesAfterReplacementRedial({
      hostDedupes: false,
      originalLanded: true,
    })).toEqual([sendRaw("in-flight prompt", "sub-redial")]);
    expect(deliveriesAfterReplacementRedial({
      hostDedupes: false,
      originalLanded: false,
    })).toEqual([]);
  });

  it("replacement recovers authored leftovers but does not re-queue in-flight sends", () => {
    const abandonSrc = html.slice(
      html.indexOf("function abandonSocketAndRedial"),
      html.indexOf("function onResumeVisible"),
    );
    expect(abandonSrc).toContain("parkLiveOutboundForReplacement()");
    expect(abandonSrc).toMatch(/parkLiveOutboundForReplacement\(\);[\s\S]*\bconnect\(\);/);
    const parkSrc = html.slice(
      html.indexOf("function parkLiveOutboundForReplacement"),
      html.indexOf("var strippedQueue"),
    );
    expect(parkSrc).not.toContain("persistOutboxMessage");
    expect(parkSrc).toContain("liveOutboundRecoveredByReplacement");
    expect(parkSrc).toContain("recoverAuthoredTexts(recovered)");
    expect(html).toContain("Your unsent text was returned to the input. Send it again if you still want it.");
    const finishSrc = html.slice(
      html.indexOf("function finishIdentityRestore"),
      html.indexOf("function abandonIdentityRestore"),
    );
    expect(finishSrc).toContain("forgetUnbouncedLiveOutbound()");
  });

  it("an ordinary reconnect with nothing in flight does not recover or replay", () => {
    expect(liveOutboundParkedByReplacement([])).toEqual([]);
    expect(liveOutboundRecoveredByReplacement([])).toEqual([]);
    const closeSrc = html.slice(
      html.indexOf('socket.addEventListener("close"'),
      html.indexOf('socket.addEventListener("error"'),
    );
    expect(closeSrc).not.toContain("parkLiveOutboundForReplacement");
    expect(closeSrc).not.toContain("liveOutboundRecoveredByReplacement");
    const finishSrc = html.slice(
      html.indexOf("function finishIdentityRestore"),
      html.indexOf("function abandonIdentityRestore"),
    );
    expect(finishSrc).toContain("forgetUnbouncedLiveOutbound()");
    expect(finishSrc).not.toContain("parkLiveOutboundForReplacement");
  });
});

describe("a control action that never reached the machine", () => {
  beforeEach(() => forgetControlActions());

  it("knows a person's control action from the rest of the traffic", () => {
    // The owner clicked these two and got silence.
    expect(isUserControlAction({ type: "cloneProject" })).toBe(true);
    expect(isUserControlAction({ type: "removeProjectFolder" })).toBe(true);
    expect(isUserControlAction({ type: "renameSession" })).toBe(true);
    expect(isUserControlAction({ type: "deleteSession" })).toBe(true);
    // A send has its own machinery — the outbox and the editable Not sent
    // block — and must not also raise the control notice.
    expect(isUserControlAction({ type: "send", text: "hi" })).toBe(false);
    expect(isUserControlAction({ type: "ready" })).toBe(false);
    expect(isUserControlAction({ type: "listProjectDir" })).toBe(false);
    expect(isUserControlAction(null)).toBe(false);
  });

  it("claims only a bounce naming something this page sent", () => {
    noteControlActionSent({ type: "cloneProject", submissionId: "ctl-a" });
    expect(claimBouncedControlAction({ submissionId: "ctl-a" })).toBe(true);
    // Once. A second bounce for the same id is not a second lost click.
    expect(claimBouncedControlAction({ submissionId: "ctl-a" })).toBe(false);
  });

  it("does not claim a SEND's bounce", () => {
    // The case that would double-report: a refused send already comes back as
    // an editable Not sent block, and must not also say a control action
    // failed. Correlation is what separates them.
    noteControlActionSent({ type: "cloneProject", submissionId: "ctl-a" });
    expect(claimBouncedControlAction({ submissionId: "send-42" })).toBe(false);
    expect(claimBouncedControlAction({})).toBe(false);
    expect(claimBouncedControlAction(null)).toBe(false);
  });

  it("remembers nothing for a frame with no id, and nothing for a send", () => {
    noteControlActionSent({ type: "cloneProject" });
    noteControlActionSent({ type: "send", submissionId: "send-1" });
    expect(claimBouncedControlAction({ submissionId: "send-1" })).toBe(false);
  });

  it("forgets everything once the host speaks again", () => {
    // Bounded on an EVENT rather than a timer: a frame from the host is proof
    // the uplink is back, so nothing outstanding is still worth reporting.
    noteControlActionSent({ type: "cloneProject", submissionId: "ctl-a" });
    forgetControlActions();
    expect(claimBouncedControlAction({ submissionId: "ctl-a" })).toBe(false);
  });
});
