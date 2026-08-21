import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// Behavioural extract of the connection-identity helpers in web/chat.html.
// The legacy-host suite is the product check (a stale error after a real
// redial). These pin the decisions that fail silently if they regress: a
// live CONNECTING/OPEN socket must not be replaced, and a superseded
// socket must not close the one that replaced it.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const helpersStart = html.indexOf("function socketIsLive(socket)");
const helpersEnd = html.indexOf("function connect()");
const helpers = html.slice(helpersStart, helpersEnd);
const connectSrc = html.slice(html.indexOf("function connect()"), html.indexOf("function abandonSocketAndRedial"));
const abandonSrc = html.slice(
  html.indexOf("function abandonSocketAndRedial"),
  html.indexOf("function onResumeVisible"),
);
const onResumeFn = html.slice(
  html.indexOf("function onResumeVisible"),
  html.indexOf("document.addEventListener(\"visibilitychange\""),
);
const resumeSrc = html.slice(html.indexOf("function onResumeVisible"), html.indexOf("function domReady()"));

const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

type FakeSocket = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
};

const { socketIsLive, isTransportProbeMessage, transportProbePayload } = new Function(
  "WebSocket",
  "window",
  `${helpers}; return { socketIsLive, isTransportProbeMessage, transportProbePayload };`,
)(WS, {}) as {
  socketIsLive: (socket: { readyState: number } | null | undefined) => boolean;
  isTransportProbeMessage: (data: unknown) => boolean;
  transportProbePayload: () => string;
};

function makeResumeRuntime(opts?: { probeTimeoutMs?: number }) {
  const stats = {
    connectCalls: 0,
    connectNoops: 0,
    connectDials: 0,
    closeCalls: 0,
    showReconnecting: 0,
    parkCalls: 0,
    probeSends: 0,
    voiceReady: [] as boolean[],
    sent: [] as string[],
  };
  let nextId = 1;

  function hangingSocket(readyState = WS.OPEN): FakeSocket {
    return {
      readyState,
      send(data: string) {
        stats.probeSends += 1;
        stats.sent.push(data);
      },
      close() {
        stats.closeCalls += 1;
      },
    };
  }

  function liveSocket(readyState = WS.CONNECTING): FakeSocket {
    return {
      readyState,
      send(data: string) {
        stats.probeSends += 1;
        stats.sent.push(data);
      },
      close() {
        stats.closeCalls += 1;
        this.readyState = WS.CLOSING;
      },
    };
  }

  const hooks = {
    showReconnecting: () => { stats.showReconnecting += 1; },
    setVoice: (value: boolean) => { stats.voiceReady.push(value); },
    hangingSocket,
    liveSocket,
    stats,
  };

  const runtime = new Function(
    "WebSocket",
    "window",
    "hooks",
    `
      var ws = null;
      ${helpers}
      function parkLiveOutboundForReplacement() { hooks.stats.parkCalls += 1; }
      function showReconnecting() { hooks.showReconnecting(); }
      function setVoiceTransportReady(value) { hooks.setVoice(value); }
      function connect() {
        hooks.stats.connectCalls += 1;
        if (socketIsLive(ws)) {
          hooks.stats.connectNoops += 1;
          return Promise.resolve();
        }
        hooks.stats.connectDials += 1;
        ws = hooks.liveSocket();
        return Promise.resolve();
      }
      ${abandonSrc}
      ${onResumeFn}
      return {
        onResumeVisible: onResumeVisible,
        onTransportProbeReply: onTransportProbeReply,
        getWs: function () { return ws; },
        setWs: function (socket) { ws = socket; },
        hangingSocket: hooks.hangingSocket,
        liveSocket: hooks.liveSocket,
      };
    `,
  )(WS, { __grokProbeTimeoutMs: opts?.probeTimeoutMs ?? 50 }, hooks) as {
    onResumeVisible: () => void;
    onTransportProbeReply: () => void;
    getWs: () => FakeSocket | null;
    setWs: (socket: FakeSocket | null) => void;
    hangingSocket: (readyState?: number) => FakeSocket;
    liveSocket: (readyState?: number) => FakeSocket;
  };

  return {
    ...runtime,
    stats,
  };
}

describe("socket generation", () => {
  it("treats CONNECTING and OPEN as live, and nothing else", () => {
    expect(socketIsLive(null)).toBe(false);
    expect(socketIsLive(undefined)).toBe(false);
    expect(socketIsLive({ readyState: WS.CONNECTING })).toBe(true);
    expect(socketIsLive({ readyState: WS.OPEN })).toBe(true);
    expect(socketIsLive({ readyState: WS.CLOSING })).toBe(false);
    expect(socketIsLive({ readyState: WS.CLOSED })).toBe(false);
  });

  it("connect() is a no-op while a socket is already CONNECTING or OPEN", () => {
    const firstCheck = connectSrc.indexOf("if (socketIsLive(ws)) return Promise.resolve();");
    const tokenWait = connectSrc.indexOf("return finalRemoteTabToken()");
    const secondCheck = connectSrc.indexOf("if (socketIsLive(ws)) return;", tokenWait);
    const constructed = connectSrc.indexOf("new WebSocket(");
    expect(firstCheck).toBeGreaterThan(-1);
    expect(secondCheck).toBeGreaterThan(-1);
    expect(firstCheck).toBeLessThan(tokenWait);
    expect(tokenWait).toBeLessThan(secondCheck);
    expect(secondCheck).toBeLessThan(constructed);
  });

  it("listeners close over their own socket and ignore a superseded one", () => {
    expect(connectSrc).toContain("var socket = new WebSocket(");
    expect(connectSrc).toContain("ws = socket;");
    expect(connectSrc).toMatch(/addEventListener\("open", function \(\) \{\s*if \(ws !== socket\) return;/);
    expect(connectSrc).toMatch(/addEventListener\("message", function \(e\) \{\s*if \(ws !== socket\) return;/);
    expect(connectSrc).toMatch(/addEventListener\("close", function \(e\) \{\s*if \(ws !== socket\) return;/);
    expect(connectSrc).toMatch(/addEventListener\("error", function \(\) \{\s*if \(ws !== socket\) return;/);
  });

  it("a stale error closes its own socket, never the module-level successor", () => {
    const errorAt = connectSrc.indexOf('addEventListener("error"');
    const errorHandler = connectSrc.slice(errorAt, connectSrc.indexOf("});", errorAt) + 3);
    expect(errorHandler).toContain("try { socket.close(); }");
    expect(errorHandler).not.toContain("ws.close()");
  });

  it("4004 still re-enters connect() after the current socket has closed", () => {
    expect(connectSrc).toContain("if (e.code === 4004) { gateSignIn().then(connect); return; }");
    expect(connectSrc.indexOf("if (ws !== socket) return;"))
      .toBeLessThan(connectSrc.indexOf("gateSignIn().then(connect)"));
  });
});

describe("resume probe", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not reintroduce a hide-duration threshold", () => {
    expect(html).not.toContain("HIDDEN_STALE_MS");
    expect(html).not.toContain("hiddenDurationIsStale");
    expect(html).not.toContain("resumeShouldCloseSocket");
    expect(html).not.toContain("pageHiddenAt");
    expect(html).toContain('var TRANSPORT_PROBE_TYPE = "transportProbe"');
    expect(isTransportProbeMessage({ type: "transportProbe" })).toBe(true);
    expect(isTransportProbeMessage({ type: "send" })).toBe(false);
    expect(JSON.parse(transportProbePayload())).toEqual({ type: "transportProbe" });
  });

  it("probes on resume and does nothing else when the reply arrives", () => {
    vi.useFakeTimers();
    const rt = makeResumeRuntime();
    const open = rt.liveSocket(WS.OPEN);
    rt.setWs(open);
    rt.onResumeVisible();
    expect(rt.stats.probeSends).toBe(1);
    expect(rt.stats.connectCalls).toBe(0);
    expect(rt.stats.showReconnecting).toBe(0);
    rt.onTransportProbeReply();
    vi.advanceTimersByTime(1_000);
    expect(rt.stats.connectDials).toBe(0);
    expect(rt.stats.connectCalls).toBe(0);
    expect(rt.stats.closeCalls).toBe(0);
    expect(rt.stats.parkCalls).toBe(0);
    expect(rt.getWs()).toBe(open);
    expect(open.readyState).toBe(WS.OPEN);
    expect(rt.stats.showReconnecting).toBe(0);
    expect(rt.stats.voiceReady).toEqual([]);
  });

  it("visibilitychange plus pageshow still produce one probe, not two replacements", () => {
    vi.useFakeTimers();
    const rt = makeResumeRuntime();
    const open = rt.liveSocket(WS.OPEN);
    rt.setWs(open);
    rt.onResumeVisible();
    rt.onResumeVisible();
    expect(rt.stats.probeSends).toBe(1);
    rt.onTransportProbeReply();
    vi.advanceTimersByTime(1_000);
    expect(rt.stats.connectDials).toBe(0);
    expect(rt.getWs()).toBe(open);
  });

  it("an unanswered probe abandons the socket and dials exactly once", () => {
    vi.useFakeTimers();
    const rt = makeResumeRuntime();
    const hanging = rt.hangingSocket(WS.OPEN);
    rt.setWs(hanging);
    rt.onResumeVisible();
    rt.onResumeVisible();
    expect(rt.stats.probeSends).toBe(1);
    expect(rt.stats.connectDials).toBe(0);
    vi.advanceTimersByTime(50);
    expect(rt.stats.closeCalls).toBe(1);
    expect(hanging.readyState).toBe(WS.OPEN);
    expect(rt.stats.connectDials).toBe(1);
    expect(rt.stats.connectNoops).toBe(0);
    expect(rt.stats.parkCalls).toBe(1);
    expect(rt.stats.showReconnecting).toBe(1);
    expect(rt.getWs()).not.toBe(hanging);
    expect(socketIsLive(rt.getWs())).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(rt.stats.connectDials).toBe(1);
  });

  it("a later resume is not blocked by a socket left in CLOSING", () => {
    vi.useFakeTimers();
    const rt = makeResumeRuntime();
    const hanging = rt.hangingSocket(WS.OPEN);
    rt.setWs(hanging);
    rt.onResumeVisible();
    vi.advanceTimersByTime(50);
    expect(rt.stats.connectDials).toBe(1);
    expect(rt.getWs()).not.toBe(hanging);

    const next = rt.liveSocket(WS.OPEN);
    rt.setWs(next);
    rt.onResumeVisible();
    vi.advanceTimersByTime(50);
    expect(rt.stats.connectDials).toBe(2);
    expect(rt.getWs()).not.toBe(next);
    expect(next.readyState).toBe(WS.CLOSING);
  });

  it("a resume during voice capture does not interrupt a healthy socket", () => {
    vi.useFakeTimers();
    const rt = makeResumeRuntime();
    const open = rt.liveSocket(WS.OPEN);
    rt.setWs(open);
    rt.onResumeVisible();
    rt.onTransportProbeReply();
    vi.advanceTimersByTime(1_000);
    expect(rt.stats.closeCalls).toBe(0);
    expect(rt.stats.connectCalls).toBe(0);
    expect(rt.getWs()).toBe(open);
    expect(open.readyState).toBe(WS.OPEN);
    expect(rt.stats.showReconnecting).toBe(0);
    expect(rt.stats.voiceReady).toEqual([]);
  });

  it("abandons a dead socket without waiting on close, and does not restore from the resume path", () => {
    expect(abandonSrc).toContain("ws = null");
    expect(abandonSrc).toContain("stale.close()");
    expect(abandonSrc).toContain("parkLiveOutboundForReplacement()");
    expect(abandonSrc).toMatch(/\bconnect\s*\(/);
    expect(resumeSrc).toContain("abandonSocketAndRedial()");
    expect(resumeSrc).not.toContain("beginIdentityRestore");
    expect(resumeSrc).not.toContain("readyMessage");
    expect(resumeSrc).toContain('document.addEventListener("visibilitychange"');
    expect(resumeSrc).toContain('window.addEventListener("pageshow"');
    expect(resumeSrc).toContain('window.addEventListener("pagehide"');
    const pagehideSrc = resumeSrc.slice(
      resumeSrc.indexOf('window.addEventListener("pagehide"'),
      resumeSrc.indexOf('window.addEventListener("pageshow"'),
    );
    expect(pagehideSrc).toContain("persistRenderedTranscript()");
    expect(pagehideSrc).not.toContain("onResumeVisible");
    expect(pagehideSrc).not.toContain("abandonSocketAndRedial");
    expect(connectSrc).toContain("isTransportProbeMessage(data)");
    expect(connectSrc).toContain("onTransportProbeReply()");
  });
});

const veilFns = html.slice(
  html.indexOf("function hideReconnectIndicator()"),
  html.indexOf("function readyMessage()"),
);
const finishRestoreSrc = html.slice(
  html.indexOf("function applyRestoreScroll()"),
  html.indexOf("function abandonIdentityRestore("),
);
const restoreCss = html.slice(
  html.indexOf("/* The identity-restore veil:"),
  html.indexOf("/* Message actions (Copy + timestamp)"),
);
const abandonRestoreSrc = html.slice(
  html.indexOf("function abandonIdentityRestore("),
  html.indexOf("function voiceCaptureActive()"),
);
const beginRestoreSrc = html.slice(
  html.indexOf("function beginIdentityRestore()"),
  html.indexOf("function isIdentityRestoreMessage("),
);
const showHostTooOldSrc = html.slice(
  html.indexOf("function showHostTooOld(version)"),
  html.indexOf("var firstConnect = true"),
);
const noticeSrc = html.slice(
  html.indexOf("function notice(html)"),
  html.indexOf("function gateSignIn()"),
);
const persistOfflineSrc = html.slice(
  html.indexOf("function handlePersistentDeviceOffline"),
  html.indexOf("function beginDeviceOfflineGrace"),
);

type VeilEl = {
  id: string;
  hidden: boolean;
  className: string;
  innerHTML: string;
  textContent: string;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  querySelector: (sel: string) => VeilEl | null;
  appendChild: (child: VeilEl) => VeilEl;
};

function fakeEl(): VeilEl {
  const classes = new Set<string>();
  const el: VeilEl = {
    id: "",
    hidden: false,
    className: "",
    innerHTML: "",
    textContent: "",
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
    },
    querySelector: (sel) => sel === ".panel" ? panel : null,
    appendChild: (child) => child,
  };
  const panel = {
    hidden: false,
    className: "",
    innerHTML: "",
    classList: el.classList,
    querySelector: () => null,
    appendChild: (child: VeilEl) => child,
  } as VeilEl;
  return el;
}

function makeVeilRuntime(opts?: { remembered?: { id: string; repoCwd: string } | null; painted?: boolean }) {
  const remembered = { value: opts?.remembered === undefined ? null : opts.remembered };
  let painted = !!opts?.painted;
  const events: string[] = [];
  const extraNodes: Record<string, VeilEl> = {};
  const bodyClasses = new Set<string>();
  const body = {
    classList: {
      add: (c: string) => { bodyClasses.add(c); },
      remove: (c: string) => {
        if (c === "identity-restore-veil" && bodyClasses.has(c)) events.push("reveal");
        bodyClasses.delete(c);
      },
      toggle: () => undefined,
      contains: (c: string) => bodyClasses.has(c),
    },
    appendChild: (child: VeilEl) => {
      if (child && child.id) extraNodes[child.id] = child;
      return child;
    },
  };
  const msgStub = { className: "msg" };
  let scrollTop = 0;
  const messagesNode = {
    textContent: "",
    hidden: false,
    scrollHeight: 800,
    querySelector: (sel?: string) => (painted && sel === ".msg" ? msgStub : null),
  };
  Object.defineProperty(messagesNode, "scrollTop", {
    configurable: true,
    enumerable: true,
    get() { return scrollTop; },
    set(value: number) {
      events.push("scroll");
      scrollTop = value;
    },
  });
  const nodes: Record<string, { textContent: string; hidden: boolean; querySelector: (sel?: string) => unknown }> = {
    messages: messagesNode,
    "reconnecting-indicator": { textContent: "Reconnecting…", hidden: true, querySelector: () => null },
    "host-too-old-copy": { textContent: "", hidden: false, querySelector: () => null },
    "host-too-old": { textContent: "", hidden: true, querySelector: () => null },
    app: { textContent: "", hidden: false, querySelector: () => null },
  };

  const runtime = new Function(
    "WebSocket",
    "document",
    "remembered",
    `
      var hostBlocked = false;
      var overlayEl = null;
      var overlayHideTimer = null;
      var identityTarget = null;
      var identityRestoreComplete = false;
      var identityReplayDepth = 0;
      var identityTimer = null;
      var identityFailTimer = null;
      var identityRepoConfirmed = false;
      var identitySessionConfirmed = false;
      var identityEverCompleted = false;
      var resyncScrollTop = null;
      var restoreTimer = null;
      var ws = { readyState: WebSocket.OPEN };
      var deviceOffline = false;
      var offlineHold = null;
      function overlay() {
        if (!overlayEl) {
          overlayEl = document.createElement("div");
          overlayEl.className = "auth-overlay";
          overlayEl.innerHTML = '<div class="panel"></div>';
          document.body.appendChild(overlayEl);
        }
        overlayEl.hidden = false;
        return overlayEl.querySelector(".panel");
      }
      function hideOverlay() { if (overlayEl) overlayEl.hidden = true; }
      ${noticeSrc}
      function forgetUnbouncedLiveOutbound() {}
      function setVoiceTransportReady() {}
      function recoverAuthoredFromLiveOutbound() {}
      function reportOutboxFailure() {}
      function rememberedIdentity() { return remembered.value; }
      function clearIdentityFailTimer() {
        if (identityFailTimer) { clearTimeout(identityFailTimer); identityFailTimer = null; }
      }
      function armIdentityFailTimer() {}
      function identityRestoreTimeoutMs() { return 15000; }
      function reportOutboxDelay() {}
      function restoreRenderedTranscript() { return false; }
      ${showHostTooOldSrc}
      ${veilFns}
      ${finishRestoreSrc}
      ${abandonRestoreSrc}
      ${beginRestoreSrc}
      return {
        showReconnecting: showReconnecting,
        syncReconnectPresentation: syncReconnectPresentation,
        settleReconnectVeil: settleReconnectVeil,
        finishIdentityRestore: finishIdentityRestore,
        abandonIdentityRestore: abandonIdentityRestore,
        beginIdentityRestore: beginIdentityRestore,
        showHostTooOld: showHostTooOld,
        notice: notice,
        noteIdentityReplay: noteIdentityReplay,
        identityRestoring: function () { return document.body.classList.contains("identity-restoring"); },
        restoreVeilUp: function () { return document.body.classList.contains("identity-restore-veil"); },
        replayDepth: function () { return identityReplayDepth; },
        setResyncScrollTop: function (value) { resyncScrollTop = value; },
        setHostBlocked: function (v) { hostBlocked = v; },
        veilUp: function () {
          return !!(overlayEl && !overlayEl.hidden && overlayEl.classList.contains("reconnecting"));
        },
        overlayVisible: function () {
          return !!(overlayEl && !overlayEl.hidden);
        },
        indicatorUp: function () {
          var el = document.getElementById("reconnecting-indicator");
          return !!(el && !el.hidden);
        },
      };
    `,
  )(WS, {
    body,
    createElement: fakeEl,
    getElementById: (id: string) => extraNodes[id] || nodes[id] || null,
  }, remembered) as {
    showReconnecting: () => void;
    syncReconnectPresentation: () => void;
    settleReconnectVeil: () => void;
    finishIdentityRestore: () => void;
    abandonIdentityRestore: (reason: string) => void;
    beginIdentityRestore: () => void;
    showHostTooOld: (version: string) => void;
    notice: (html: string) => void;
    noteIdentityReplay: (data: { type: string; active?: boolean }) => void;
    identityRestoring: () => boolean;
    restoreVeilUp: () => boolean;
    replayDepth: () => number;
    setResyncScrollTop: (value: number | null) => void;
    setHostBlocked: (value: boolean) => void;
    veilUp: () => boolean;
    overlayVisible: () => boolean;
    indicatorUp: () => boolean;
  };

  return {
    ...runtime,
    events,
    extraNodes,
    scrollTop: () => scrollTop,
    setPainted: (value: boolean) => { painted = value; },
  };
}

describe("reconnect veil", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an inbound frame during an in-progress restore does not lift the veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    expect(rt.veilUp()).toBe(true);

    rt.settleReconnectVeil();
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(true);
  });

  it("lifts the veil when the restore completes", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.settleReconnectVeil();
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(true);

    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);
    vi.advanceTimersByTime(449);
    expect(rt.veilUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rt.veilUp()).toBe(false);
  });

  it("a burst of inbound frames closer than the hide delay still lifts the veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(100);
      rt.settleReconnectVeil();
    }
    expect(rt.veilUp()).toBe(false);
  });

  it("lifts the veil on a single quiet frame after restore", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);

    rt.settleReconnectVeil();
    vi.advanceTimersByTime(449);
    expect(rt.veilUp()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(rt.veilUp()).toBe(false);
  });

  it("notice() cancels a pending hide and drops the veil styling", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);

    rt.notice("Device not found.");
    expect(rt.veilUp()).toBe(false);
    expect(rt.overlayVisible()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
    expect(rt.overlayVisible()).toBe(true);
  });

  it("the host-blocked path still drops the veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);

    rt.showHostTooOld("2.0.4");
    expect(rt.veilUp()).toBe(false);
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
  });

  it("lifts the veil when the restore is abandoned", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    rt.settleReconnectVeil();
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(true);

    rt.abandonIdentityRestore("the conversation could not be restored.");
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
  });

  it("a reconnect with nothing to restore still lifts the veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: null });
    rt.showReconnecting();
    expect(rt.veilUp()).toBe(true);

    rt.beginIdentityRestore();
    expect(rt.veilUp()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
  });

  it("hostBlocked still suppresses the veil", () => {
    vi.useFakeTimers();
    const blocked = makeVeilRuntime({ remembered: null });
    blocked.setHostBlocked(true);
    blocked.showReconnecting();
    expect(blocked.veilUp()).toBe(false);

    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    expect(rt.veilUp()).toBe(true);
    rt.showHostTooOld("2.0.4");
    expect(rt.veilUp()).toBe(false);
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
  });

  it("a painted conversation takes the small indicator, not the veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    rt.showReconnecting();
    expect(rt.veilUp()).toBe(false);
    expect(rt.overlayVisible()).toBe(false);
    expect(rt.indicatorUp()).toBe(true);

    rt.beginIdentityRestore();
    rt.syncReconnectPresentation();
    expect(rt.identityRestoring()).toBe(true);
    expect(rt.veilUp()).toBe(false);
    expect(rt.indicatorUp()).toBe(true);
  });

  it("an empty transcript still takes today's veil", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);
  });

  it("a painted reconnect that then empties takes the overlay", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    expect(rt.veilUp()).toBe(false);
    expect(rt.indicatorUp()).toBe(true);

    rt.setPainted(false);
    rt.syncReconnectPresentation();
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);
    expect(rt.overlayVisible()).toBe(true);

    rt.finishIdentityRestore();
    expect(rt.veilUp()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(rt.veilUp()).toBe(false);
    expect(rt.indicatorUp()).toBe(false);
  });

  it("an empty reconnect does not flash the indicator when content arrives", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.showReconnecting();
    rt.beginIdentityRestore();
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);

    rt.setPainted(true);
    rt.syncReconnectPresentation();
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);

    rt.finishIdentityRestore();
    vi.advanceTimersByTime(449);
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(rt.veilUp()).toBe(false);
    expect(rt.indicatorUp()).toBe(false);
  });

  it("a terminal notice still wins after the overlay takes over an emptied transcript", () => {
    vi.useFakeTimers();
    const rt = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    rt.showReconnecting();
    rt.setPainted(false);
    rt.syncReconnectPresentation();
    expect(rt.veilUp()).toBe(true);
    expect(rt.indicatorUp()).toBe(false);

    rt.notice("Device not found.");
    expect(rt.veilUp()).toBe(false);
    expect(rt.indicatorUp()).toBe(false);
    expect(rt.overlayVisible()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(rt.overlayVisible()).toBe(true);
    expect(rt.veilUp()).toBe(false);
  });

  it("the indicator clears on restore complete, abandon, and notice", () => {
    vi.useFakeTimers();
    const complete = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    complete.showReconnecting();
    complete.beginIdentityRestore();
    expect(complete.indicatorUp()).toBe(true);
    expect(complete.identityRestoring()).toBe(true);
    complete.finishIdentityRestore();
    expect(complete.identityRestoring()).toBe(false);
    expect(complete.indicatorUp()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(complete.indicatorUp()).toBe(false);
    expect(complete.veilUp()).toBe(false);

    const abandoned = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    abandoned.showReconnecting();
    abandoned.beginIdentityRestore();
    expect(abandoned.indicatorUp()).toBe(true);
    abandoned.abandonIdentityRestore("the conversation could not be restored.");
    vi.advanceTimersByTime(450);
    expect(abandoned.indicatorUp()).toBe(false);

    const noticed = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    noticed.showReconnecting();
    expect(noticed.indicatorUp()).toBe(true);
    noticed.notice("Device not found.");
    expect(noticed.indicatorUp()).toBe(false);
    expect(noticed.veilUp()).toBe(false);
    expect(noticed.overlayVisible()).toBe(true);
    vi.advanceTimersByTime(450);
    expect(noticed.indicatorUp()).toBe(false);
    expect(noticed.overlayVisible()).toBe(true);
  });

  it("hostBlocked shows neither the veil nor the indicator", () => {
    vi.useFakeTimers();
    const blocked = makeVeilRuntime({ painted: true });
    blocked.setHostBlocked(true);
    blocked.showReconnecting();
    expect(blocked.veilUp()).toBe(false);
    expect(blocked.indicatorUp()).toBe(false);

    const rt = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    rt.showReconnecting();
    expect(rt.indicatorUp()).toBe(true);
    rt.showHostTooOld("2.0.4");
    expect(rt.indicatorUp()).toBe(false);
    expect(rt.veilUp()).toBe(false);
    vi.advanceTimersByTime(450);
    expect(rt.indicatorUp()).toBe(false);
  });

  it("keys hide on restore complete, not on the inbound-frame call site", () => {
    expect(connectSrc).toContain("settleReconnectVeil()");
    expect(connectSrc).toContain("noteIdentityReplay(data)");
    expect(connectSrc.indexOf("window.dispatchEvent")).toBeLessThan(connectSrc.indexOf("noteIdentityReplay(data)"));
    expect(veilFns).toContain("identityTarget && !identityRestoreComplete");
    expect(finishRestoreSrc).toContain("settleReconnectVeil()");
    expect(finishRestoreSrc).toContain("revealRestoredTranscript()");
    expect(finishRestoreSrc.indexOf("identityTarget = null"))
      .toBeLessThan(finishRestoreSrc.indexOf("settleReconnectVeil()"));
    expect(finishRestoreSrc.indexOf("identityRestoreComplete = true"))
      .toBeLessThan(finishRestoreSrc.indexOf("settleReconnectVeil()"));
    expect(abandonRestoreSrc).toContain("finishIdentityRestore()");
    expect(abandonRestoreSrc).toContain("identityReplayDepth = 0");
    expect(beginRestoreSrc).toContain("finishIdentityRestore()");
    expect(beginRestoreSrc).toContain("restoreRenderedTranscript()");
    expect(beginRestoreSrc.indexOf("restoreRenderedTranscript()"))
      .toBeLessThan(beginRestoreSrc.indexOf('classList.add("identity-restoring")'));
    expect(showHostTooOldSrc).toContain("clearReconnectPresentation(true)");
    expect(showHostTooOldSrc).toContain("identity-restore-veil");
    expect(noticeSrc).toContain("clearReconnectPresentation(false)");
    expect(persistOfflineSrc).toContain("clearReconnectPresentation(true)");
    expect(persistOfflineSrc).toContain("identity-restore-veil");
    expect(veilFns).toContain("messagesEl.querySelector(\".msg\")");
    expect(veilFns).toContain("clearReconnectPresentation(true)");
    expect(veilFns).toContain("syncReconnectPresentation()");
    expect(veilFns).toContain("new MutationObserver");
  });
});

describe("cold restore transcript veil", () => {
  it("hides the transcript for the whole replay, not just while empty", () => {
    expect(restoreCss).toContain("body.identity-restore-veil #messages { visibility: hidden; }");
    expect(restoreCss).not.toContain(":has(.msg:not(.error))");
    expect(html).not.toContain("body.identity-restoring #messages:not(:has(.msg:not(.error)))");
  });

  it("errors punch through while the rest stays hidden, and the note stays up", () => {
    expect(restoreCss).toContain("body.identity-restore-veil #messages .msg.error { visibility: visible; }");
    expect(restoreCss).toContain("body.identity-restore-veil #identity-restoring-note { display: flex; }");
    expect(restoreCss).toContain("body.identity-restore-veil #session-head-title { visibility: hidden; }");
  });

  it("does not use a timer to decide the replay is done", () => {
    const noteReplaySrc = html.slice(
      html.indexOf("function noteIdentityReplay(data)"),
      html.indexOf("function finishIdentityRestore()"),
    );
    expect(noteReplaySrc).toContain('data.type !== "historyReplay"');
    expect(noteReplaySrc).not.toContain("setTimeout");
    expect(noteReplaySrc).not.toContain("restoreTimer");
  });

  it("applies scroll before lifting the veil, not after", () => {
    const liftSrc = html.slice(
      html.indexOf("function liftIdentityRestoreVeil()"),
      html.indexOf("function revealRestoredTranscript()"),
    );
    expect(liftSrc.indexOf("applyRestoreScroll()"))
      .toBeLessThan(liftSrc.indexOf("identity-restore-veil"));
  });

  it("cold restore: #messages stays hidden across the whole replay and becomes visible once, after the replay ends", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    expect(rt.identityRestoring()).toBe(true);
    expect(rt.restoreVeilUp()).toBe(true);
    expect(rt.extraNodes["identity-restoring-note"]?.textContent).toBe("Restoring conversation…");

    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    expect(rt.restoreVeilUp()).toBe(true);
    rt.setPainted(true);
    expect(rt.restoreVeilUp()).toBe(true);

    rt.finishIdentityRestore();
    expect(rt.restoreVeilUp()).toBe(true);
    expect(rt.identityRestoring()).toBe(true);
    expect(rt.events).not.toContain("reveal");

    rt.noteIdentityReplay({ type: "historyReplay", active: false });
    expect(rt.restoreVeilUp()).toBe(false);
    expect(rt.identityRestoring()).toBe(false);
    expect(rt.events.filter((e) => e === "reveal")).toEqual(["reveal"]);
  });

  it("the revealed view is the settled one — scroll is applied before reveal, not after", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    rt.finishIdentityRestore();
    expect(rt.events).toEqual([]);

    rt.noteIdentityReplay({ type: "historyReplay", active: false });
    expect(rt.events).toEqual(["scroll", "reveal"]);
    expect(rt.scrollTop()).toBe(800);
  });

  it("a restore that finishes after the replay still scrolls before revealing", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    rt.noteIdentityReplay({ type: "historyReplay", active: false });
    expect(rt.restoreVeilUp()).toBe(true);
    expect(rt.events).toEqual([]);

    rt.finishIdentityRestore();
    expect(rt.events).toEqual(["scroll", "reveal"]);
    expect(rt.restoreVeilUp()).toBe(false);
  });

  it("an error during restore does not lift the veil", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    rt.setPainted(true);
    expect(rt.restoreVeilUp()).toBe(true);
    expect(rt.identityRestoring()).toBe(true);
    expect(rt.extraNodes["identity-restoring-note"]).toBeTruthy();
  });

  it("restore abandoned: the transcript is revealed rather than left hidden", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    expect(rt.restoreVeilUp()).toBe(true);

    rt.abandonIdentityRestore("the conversation could not be restored.");
    expect(rt.restoreVeilUp()).toBe(false);
    expect(rt.identityRestoring()).toBe(false);
    expect(rt.replayDepth()).toBe(0);
    expect(rt.events).toEqual(["scroll", "reveal"]);
  });

  it("painted-conversation reconnect is never hidden", () => {
    const rt = makeVeilRuntime({
      remembered: { id: "sess-1", repoCwd: "/repo" },
      painted: true,
    });
    rt.beginIdentityRestore();
    expect(rt.identityRestoring()).toBe(true);
    expect(rt.restoreVeilUp()).toBe(false);
    expect(rt.extraNodes["identity-restoring-note"]).toBeUndefined();

    rt.noteIdentityReplay({ type: "historyReplay", active: true });
    expect(rt.restoreVeilUp()).toBe(false);
    rt.noteIdentityReplay({ type: "historyReplay", active: false });
    expect(rt.restoreVeilUp()).toBe(false);

    rt.finishIdentityRestore();
    expect(rt.identityRestoring()).toBe(false);
    expect(rt.restoreVeilUp()).toBe(false);
    expect(rt.events).toEqual([]);
  });

  it("a cold restore without a replay still reveals on completion", () => {
    const rt = makeVeilRuntime({ remembered: { id: "sess-1", repoCwd: "/repo" } });
    rt.beginIdentityRestore();
    expect(rt.restoreVeilUp()).toBe(true);
    rt.finishIdentityRestore();
    expect(rt.restoreVeilUp()).toBe(false);
    expect(rt.events).toEqual(["scroll", "reveal"]);
  });

  it("puts the restoring note on screen before hiding the transcript", () => {
    expect(beginRestoreSrc.indexOf("identity-restoring-note"))
      .toBeLessThan(beginRestoreSrc.indexOf('classList.add("identity-restore-veil")'));
  });
});
