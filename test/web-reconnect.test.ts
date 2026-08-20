import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Behavioural extract of the connection-identity helpers in web/chat.html.
// The legacy-host suite is the product check (a stale error after a real
// redial). These pin the decisions that fail silently if they regress: a
// live CONNECTING/OPEN socket must not be replaced, and a superseded
// socket must not close the one that replaced it.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const helpersStart = html.indexOf("function socketIsLive(socket)");
const helpersEnd = html.indexOf("function connect()");
const helpers = html.slice(helpersStart, helpersEnd);
const connectSrc = html.slice(html.indexOf("function connect()"), html.indexOf("function domReady()"));

const WS = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { socketIsLive } = new Function(
  "WebSocket",
  `${helpers}; return { socketIsLive };`,
)(WS) as {
  socketIsLive: (socket: { readyState: number } | null | undefined) => boolean;
};

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
