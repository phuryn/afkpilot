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
    expect(resumeSrc).not.toContain("pagehide");
    expect(connectSrc).toContain("isTransportProbeMessage(data)");
    expect(connectSrc).toContain("onTransportProbeReply()");
  });
});
