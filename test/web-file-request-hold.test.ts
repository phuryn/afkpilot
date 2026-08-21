import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Behavioural extract of the restore-window file-request hold in web/chat.html.
// The renderer awaits list/read replies with a 30s timer; dropping them during
// identity restore left the panel hanging. Hold is in RAM only — never the
// tab-discard outbox — and is bounded by finishIdentityRestore / abandon.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const helpersStart = html.indexOf("function isDeviceOfflineError(data)");
const helpersEnd = html.indexOf("function persistOutboxMessage(raw, message, authored)");
const helpers = html.slice(helpersStart, helpersEnd);
const holdFns = html.slice(
  html.indexOf("function holdReadOnlyFileRequest(raw, message)"),
  html.indexOf("function armCachedViewScroll()"),
);
const sendPath = html.slice(
  html.indexOf("var authored = takePendingUiAuthored"),
  html.indexOf("getState: function ()"),
);
const finishSrc = html.slice(
  html.indexOf("function finishIdentityRestore()"),
  html.indexOf("function abandonIdentityRestore("),
);
const abandonSrc = html.slice(
  html.indexOf("function abandonIdentityRestore("),
  html.indexOf("function voiceCaptureActive()"),
);

const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

type HeldEntry = { raw: string; message: { type: string; cwd?: string; relPath?: string; requestId?: string } };

function MessageEventStub(this: { type: string; data: unknown }, type: string, init?: { data?: unknown }) {
  this.type = type;
  this.data = init && init.data;
}

function extractHelpers() {
  return new Function(
    `${helpers}; return {
      liveSendDisposition,
      outboxDispositionForMessage,
      isReadOnlyFileRequest,
      fileRequestFailureReply,
      heldFileRequestsAfterHold,
      takeHeldFileRequests,
      FILE_REQUEST_RESTORE_FAIL_REASON,
    };`,
  )() as {
    liveSendDisposition: (opts: {
      socketOpen?: boolean;
      identityRestoreComplete?: boolean;
      deviceOffline?: boolean;
      offlineHold?: boolean;
      isRestoreMessage?: boolean;
      changesIdentity?: boolean;
    }) => "send" | "outbox" | "abandon-and-send";
    outboxDispositionForMessage: (message: unknown, authored?: string) => "persist" | "recover" | "drop";
    isReadOnlyFileRequest: (message: unknown) => boolean;
    fileRequestFailureReply: (message: unknown, reason?: string) => {
      type: string;
      cwd: string;
      relPath: string;
      ok: false;
      reason: string;
      requestId?: string;
    } | null;
    heldFileRequestsAfterHold: (
      current: HeldEntry[],
      raw: string,
      message: unknown,
    ) => HeldEntry[];
    takeHeldFileRequests: (current: HeldEntry[]) => { taken: HeldEntry[]; next: HeldEntry[] };
    FILE_REQUEST_RESTORE_FAIL_REASON: string;
  };
}

const {
  liveSendDisposition,
  outboxDispositionForMessage,
  isReadOnlyFileRequest,
  fileRequestFailureReply,
  heldFileRequestsAfterHold,
  takeHeldFileRequests,
  FILE_REQUEST_RESTORE_FAIL_REASON,
} = extractHelpers();

function listRequest(relPath = "", requestId = "file-1") {
  return { type: "listProjectDir", cwd: "/work", relPath, requestId };
}
function readRequest(relPath = "src/a.ts", requestId = "file-2") {
  return { type: "readProjectFile", cwd: "/work", relPath, requestId };
}
function writeRequest() {
  return {
    type: "writeProjectFile",
    cwd: "/work",
    relPath: "src/a.ts",
    text: "x",
    stamp: { mtimeMs: 1, size: 1 },
    expectedAbsPath: "/work/src/a.ts",
    requestId: "file-w",
  };
}

function makeHoldRuntime(opts?: { identityRestoreComplete?: boolean; socketOpen?: boolean }) {
  const sent: string[] = [];
  const inbound: unknown[] = [];
  const persisted: string[] = [];
  const windowObj = {
    dispatchEvent(event: { data?: unknown }) {
      inbound.push(event.data);
    },
  };
  const ws = {
    readyState: opts?.socketOpen === false ? WS.CLOSED : WS.OPEN,
    send(raw: string) { sent.push(raw); },
  };

  const runtime = new Function(
    "WebSocket",
    "window",
    "MessageEvent",
    "hooks",
    `
      var identityRestoreComplete = hooks.identityRestoreComplete;
      var deviceOffline = false;
      var offlineHold = null;
      var heldFileRequests = [];
      var queue = [];
      var ws = hooks.ws;
      ${helpers}
      ${holdFns}
      function persistOutboxMessage(raw, message, authored) {
        if (outboxDispositionForMessage(message, authored) !== "persist") return;
        queue.push(raw);
        hooks.persisted.push(raw);
      }
      function post(m) {
        var s = JSON.stringify(m);
        var disposition = liveSendDisposition({
          socketOpen: !!(ws && ws.readyState === WebSocket.OPEN),
          identityRestoreComplete: identityRestoreComplete,
          deviceOffline: deviceOffline,
          offlineHold: !!offlineHold,
          isRestoreMessage: false,
          changesIdentity: false,
        });
        if (disposition === "send") {
          ws.send(s);
        } else {
          if (isReadOnlyFileRequest(m) && !identityRestoreComplete) {
            holdReadOnlyFileRequest(s, m);
          } else {
            persistOutboxMessage(s, m, "");
          }
        }
      }
      function finishIdentityRestore() {
        identityRestoreComplete = true;
        flushHeldFileRequests();
      }
      function abandonIdentityRestore() {
        failHeldFileRequests(FILE_REQUEST_RESTORE_FAIL_REASON);
        finishIdentityRestore();
      }
      return {
        post: post,
        finishIdentityRestore: finishIdentityRestore,
        abandonIdentityRestore: abandonIdentityRestore,
        flushHeldFileRequests: flushHeldFileRequests,
        held: function () { return heldFileRequests.slice(); },
        queue: function () { return queue.slice(); },
        identityComplete: function () { return identityRestoreComplete; },
        setDeviceOffline: function (value) { deviceOffline = !!value; },
      };
    `,
  )(WS, windowObj, MessageEventStub, {
    identityRestoreComplete: !!opts?.identityRestoreComplete,
    ws,
    persisted,
  }) as {
    post: (m: unknown) => void;
    finishIdentityRestore: () => void;
    abandonIdentityRestore: () => void;
    flushHeldFileRequests: () => void;
    held: () => HeldEntry[];
    queue: () => string[];
    identityComplete: () => boolean;
    setDeviceOffline: (value: boolean) => void;
  };

  return { ...runtime, sent, inbound, persisted };
}

describe("read-only file request hold during restore", () => {
  it("classifies list/read as the hold class and leaves writes and prompts out", () => {
    expect(isReadOnlyFileRequest(listRequest())).toBe(true);
    expect(isReadOnlyFileRequest(readRequest())).toBe(true);
    expect(isReadOnlyFileRequest(writeRequest())).toBe(false);
    expect(isReadOnlyFileRequest({ type: "send", text: "hi" })).toBe(false);
    expect(isReadOnlyFileRequest({ type: "mentionQuery", query: "a" })).toBe(false);
    expect(outboxDispositionForMessage(listRequest())).toBe("drop");
    expect(outboxDispositionForMessage(readRequest())).toBe("drop");
    expect(outboxDispositionForMessage(writeRequest())).toBe("drop");
  });

  it("failure replies echo cwd, relPath and requestId so the renderer fence still matches", () => {
    const list = listRequest("src", "file-9");
    const reply = fileRequestFailureReply(list, FILE_REQUEST_RESTORE_FAIL_REASON);
    expect(reply).toEqual({
      type: "projectDirListing",
      cwd: "/work",
      relPath: "src",
      ok: false,
      reason: FILE_REQUEST_RESTORE_FAIL_REASON,
      requestId: "file-9",
    });
    const read = fileRequestFailureReply(readRequest("lib/b.ts", "file-8"));
    expect(read).toMatchObject({
      type: "projectFileContent",
      cwd: "/work",
      relPath: "lib/b.ts",
      ok: false,
      requestId: "file-8",
    });
    expect(fileRequestFailureReply(writeRequest())).toBeNull();
  });

  it("a file request during restore is held, then sent once restore completes", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    const msg = listRequest();
    rt.post(msg);
    expect(rt.sent).toEqual([]);
    expect(rt.persisted).toEqual([]);
    expect(rt.queue()).toEqual([]);
    expect(rt.held().map((e) => e.message.requestId)).toEqual(["file-1"]);
    expect(rt.identityComplete()).toBe(false);

    rt.finishIdentityRestore();
    expect(rt.identityComplete()).toBe(true);
    expect(rt.sent).toEqual([JSON.stringify(msg)]);
    expect(rt.held()).toEqual([]);
    expect(rt.inbound).toEqual([]);
    expect(rt.persisted).toEqual([]);
  });

  it("an abandoned restore fails the held requests instead of leaving them pending", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    const msg = readRequest("README.md", "file-3");
    rt.post(msg);
    expect(rt.sent).toEqual([]);

    rt.abandonIdentityRestore();
    expect(rt.sent).toEqual([]);
    expect(rt.held()).toEqual([]);
    expect(rt.inbound).toEqual([{
      type: "projectFileContent",
      cwd: "/work",
      relPath: "README.md",
      ok: false,
      reason: FILE_REQUEST_RESTORE_FAIL_REASON,
      requestId: "file-3",
    }]);
    expect(rt.persisted).toEqual([]);
  });

  it("a file request with no restore in flight sends immediately", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: true });
    const msg = listRequest();
    rt.post(msg);
    expect(rt.sent).toEqual([JSON.stringify(msg)]);
    expect(rt.held()).toEqual([]);
    expect(rt.persisted).toEqual([]);
    expect(rt.inbound).toEqual([]);
  });

  it("held requests never enter the persisted outbox", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    rt.post(listRequest());
    rt.post(readRequest());
    expect(rt.persisted).toEqual([]);
    expect(rt.queue()).toEqual([]);
    rt.finishIdentityRestore();
    expect(rt.persisted).toEqual([]);
    expect(rt.queue()).toEqual([]);

    const abandoned = makeHoldRuntime({ identityRestoreComplete: false });
    abandoned.post(listRequest());
    abandoned.abandonIdentityRestore();
    expect(abandoned.persisted).toEqual([]);
    expect(abandoned.queue()).toEqual([]);
  });

  it("multiple held requests all send, in order", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    const list = listRequest("", "file-a");
    const nested = listRequest("src", "file-b");
    const read = readRequest("src/a.ts", "file-c");
    rt.post(list);
    rt.post(nested);
    rt.post(read);
    expect(rt.held().map((e) => e.message.requestId)).toEqual(["file-a", "file-b", "file-c"]);
    rt.finishIdentityRestore();
    expect(rt.sent).toEqual([
      JSON.stringify(list),
      JSON.stringify(nested),
      JSON.stringify(read),
    ]);
    expect(rt.held()).toEqual([]);
  });

  it("does not send held requests before identity confirms", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    rt.post(listRequest());
    rt.flushHeldFileRequests();
    expect(rt.sent).toEqual([]);
    expect(rt.inbound).toHaveLength(1);
    expect(rt.inbound[0]).toMatchObject({ ok: false, type: "projectDirListing" });
  });

  it("a write during restore is still dropped, not held or persisted", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    rt.post(writeRequest());
    expect(rt.held()).toEqual([]);
    expect(rt.sent).toEqual([]);
    expect(rt.persisted).toEqual([]);
    rt.finishIdentityRestore();
    expect(rt.sent).toEqual([]);
  });

  it("an offline finish fails held requests rather than sending them into a dead host", () => {
    const rt = makeHoldRuntime({ identityRestoreComplete: false });
    rt.post(listRequest());
    rt.setDeviceOffline(true);
    rt.finishIdentityRestore();
    expect(rt.sent).toEqual([]);
    expect(rt.inbound).toEqual([fileRequestFailureReply(listRequest(), FILE_REQUEST_RESTORE_FAIL_REASON)]);
  });

  it("the hold list is a copy-and-clear, and writes never append", () => {
    const list = JSON.stringify(listRequest());
    let held = heldFileRequestsAfterHold([], list, listRequest());
    held = heldFileRequestsAfterHold(held, JSON.stringify(writeRequest()), writeRequest());
    held = heldFileRequestsAfterHold(held, JSON.stringify(readRequest()), readRequest());
    expect(held.map((e) => e.message.type)).toEqual(["listProjectDir", "readProjectFile"]);
    const drained = takeHeldFileRequests(held);
    expect(drained.taken).toEqual(held);
    expect(drained.next).toEqual([]);
    expect(drained.taken).not.toBe(held);
  });

  it("wires the hold to the live send path and both restore endpoints", () => {
    expect(sendPath).toContain("isReadOnlyFileRequest(m) && !identityRestoreComplete");
    expect(sendPath).toContain("holdReadOnlyFileRequest(s, m)");
    expect(sendPath).toContain("persistOutboxMessage(s, m, authored)");
    expect(sendPath.indexOf("holdReadOnlyFileRequest(s, m)"))
      .toBeLessThan(sendPath.lastIndexOf("persistOutboxMessage(s, m, authored)"));
    expect(finishSrc).toContain("flushHeldFileRequests()");
    expect(finishSrc.indexOf("identityRestoreComplete = true"))
      .toBeLessThan(finishSrc.indexOf("flushHeldFileRequests()"));
    expect(abandonSrc).toContain("failHeldFileRequests(");
    expect(abandonSrc.indexOf("failHeldFileRequests("))
      .toBeLessThan(abandonSrc.indexOf("finishIdentityRestore()"));
    expect(html).not.toContain("outboxDispositionForMessage(message, authored) === \"persist\" && isReadOnlyFileRequest");
    expect(liveSendDisposition({
      socketOpen: true,
      identityRestoreComplete: false,
    })).toBe("outbox");
  });
});
