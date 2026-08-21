import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Identity restore used to let the host's interim empty session name the
// header. A new socket is a new client id, so the host binds that session
// and announces it while the remembered conversation is still on screen.
// These pin the gate: id match, never the title text, and the window is
// body.identity-restoring + identityTarget.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const gateSrc = html.slice(
  html.indexOf("function identityRestoreInFlight()"),
  html.indexOf("function maybeFinishIdentityRestore("),
);
const connectSrc = html.slice(
  html.indexOf("function connect()"),
  html.indexOf("function abandonSocketAndRedial"),
);
const messageHandlerSrc = connectSrc.slice(
  connectSrc.indexOf('addEventListener("message"'),
  connectSrc.indexOf('addEventListener("close"'),
);
const finishRestoreSrc = html.slice(
  html.indexOf("function finishIdentityRestore()"),
  html.indexOf("function abandonIdentityRestore("),
);
const abandonRestoreSrc = html.slice(
  html.indexOf("function abandonIdentityRestore("),
  html.indexOf("function voiceCaptureActive()"),
);
const beginRestoreSrc = html.slice(
  html.indexOf("function beginIdentityRestore()"),
  html.indexOf("function isIdentityRestoreMessage("),
);
const cacheSrc = html.slice(
  html.indexOf("function publishCachedSessionName(identity, title)"),
  html.indexOf("function queuedSendTexts()"),
);

const TARGET = { id: "sess-walkthrough", repoCwd: "/repo" };
const INTERIM_NAME = {
  type: "sessionName",
  sessionId: "sess-interim-empty",
  name: "New session",
  cwd: "/repo",
};
const TARGET_NAME = {
  type: "sessionName",
  sessionId: TARGET.id,
  name: "AI prototyping walkthrough",
  cwd: "/repo",
};
const TARGET_UNNAMED = {
  type: "sessionName",
  sessionId: TARGET.id,
  name: "New session",
  cwd: "/repo",
};

function makeGate(opts?: { restoring?: boolean; target?: { id: string; repoCwd: string } | null }) {
  const classes = new Set<string>();
  if (opts?.restoring !== false) classes.add("identity-restoring");
  const target = opts && "target" in opts ? opts.target : TARGET;
  return new Function(
    "document",
    `
      var identityTarget = ${JSON.stringify(target)};
      ${gateSrc}
      return {
        inboundSessionNameApplies: inboundSessionNameApplies,
        inboundFrameForRenderer: inboundFrameForRenderer,
        identityRestoreInFlight: identityRestoreInFlight,
        setTarget: function (value) { identityTarget = value; },
        addRestoring: function () { document.body.classList.add("identity-restoring"); },
        removeRestoring: function () { document.body.classList.remove("identity-restoring"); },
      };
    `,
  )({
    body: {
      classList: {
        add: (c: string) => { classes.add(c); },
        remove: (c: string) => { classes.delete(c); },
        contains: (c: string) => classes.has(c),
      },
    },
  }) as {
    inboundSessionNameApplies: (data: unknown) => boolean;
    inboundFrameForRenderer: (data: unknown) => unknown;
    identityRestoreInFlight: () => boolean;
    setTarget: (value: { id: string; repoCwd: string } | null) => void;
    addRestoring: () => void;
    removeRestoring: () => void;
  };
}

function headerAfter(rt: ReturnType<typeof makeGate>, start: string, frames: unknown[]) {
  let title = start;
  for (const data of frames) {
    const frame = rt.inboundFrameForRenderer(data) as { type?: string; name?: string } | null;
    if (!frame || frame.type !== "sessionName") continue;
    title = String(frame.name || "New session");
  }
  return title;
}

describe("inbound session name during identity restore", () => {
  it("restore in flight, host announces the interim session: header keeps the conversation's name", () => {
    const rt = makeGate();
    expect(rt.identityRestoreInFlight()).toBe(true);
    expect(rt.inboundSessionNameApplies(INTERIM_NAME)).toBe(false);
    expect(rt.inboundFrameForRenderer(INTERIM_NAME)).toBeNull();
    expect(headerAfter(rt, TARGET_NAME.name, [INTERIM_NAME])).toBe(TARGET_NAME.name);
  });

  it("restore resolves: the real name shows", () => {
    const rt = makeGate();
    expect(rt.inboundSessionNameApplies(TARGET_NAME)).toBe(true);
    expect(headerAfter(rt, TARGET_NAME.name, [INTERIM_NAME, TARGET_NAME])).toBe(TARGET_NAME.name);

    rt.setTarget(null);
    rt.removeRestoring();
    expect(rt.identityRestoreInFlight()).toBe(false);
    expect(rt.inboundSessionNameApplies(TARGET_NAME)).toBe(true);
    expect(headerAfter(rt, TARGET_NAME.name, [TARGET_NAME])).toBe(TARGET_NAME.name);
  });

  it("restore abandoned: the host's next name shows", () => {
    const rt = makeGate();
    expect(headerAfter(rt, TARGET_NAME.name, [INTERIM_NAME])).toBe(TARGET_NAME.name);

    rt.setTarget(null);
    rt.removeRestoring();
    expect(rt.inboundSessionNameApplies(INTERIM_NAME)).toBe(true);
    expect(headerAfter(rt, TARGET_NAME.name, [INTERIM_NAME])).toBe("New session");
  });

  it("a genuinely new session outside a restore: New session shows as today", () => {
    const rt = makeGate({ restoring: false, target: null });
    expect(rt.identityRestoreInFlight()).toBe(false);
    expect(rt.inboundSessionNameApplies(INTERIM_NAME)).toBe(true);
    expect(headerAfter(rt, "", [INTERIM_NAME])).toBe("New session");
  });

  it("does not guess from the title text — a restored conversation named New session still shows", () => {
    const rt = makeGate();
    expect(rt.inboundSessionNameApplies(TARGET_UNNAMED)).toBe(true);
    expect(headerAfter(rt, "AI prototyping walkthrough", [TARGET_UNNAMED])).toBe("New session");
    expect(gateSrc).not.toMatch(/data\.name/);
    expect(gateSrc).not.toMatch(/msg\.name/);
  });

  it("the restore window is identityTarget plus body.identity-restoring", () => {
    const noClass = makeGate({ restoring: false });
    expect(noClass.identityRestoreInFlight()).toBe(false);
    expect(noClass.inboundSessionNameApplies(INTERIM_NAME)).toBe(true);

    const noTarget = makeGate({ target: null });
    expect(noTarget.identityRestoreInFlight()).toBe(false);
    expect(noTarget.inboundSessionNameApplies(INTERIM_NAME)).toBe(true);

    expect(gateSrc).toContain("identityTarget");
    expect(gateSrc).toContain("identity-restoring");
    expect(beginRestoreSrc).toContain('classList.add("identity-restoring")');
    expect(finishRestoreSrc).toContain("identityTarget = null");
    expect(finishRestoreSrc).toContain("revealRestoredTranscript()");
    expect(abandonRestoreSrc).toContain("finishIdentityRestore()");
    expect(finishRestoreSrc.indexOf("identityTarget = null"))
      .toBeLessThan(finishRestoreSrc.indexOf("revealRestoredTranscript()"));
    const revealSrc = html.slice(
      html.indexOf("function revealRestoredTranscript()"),
      html.indexOf("function noteIdentityReplay(data)"),
    );
    expect(revealSrc).toContain('classList.remove("identity-restoring")');
  });
});

describe("interim sessions.activeId during identity restore", () => {
  const interimSessions = {
    type: "sessions",
    activeId: INTERIM_NAME.sessionId,
    entries: [{ id: INTERIM_NAME.sessionId, displayName: "New session" }],
  };
  const targetSessions = {
    type: "sessions",
    activeId: TARGET.id,
    entries: [{ id: TARGET.id, displayName: TARGET_NAME.name }],
  };

  it("strips a foreign activeId so the interim session cannot become the header", () => {
    const rt = makeGate();
    const frame = rt.inboundFrameForRenderer(interimSessions) as {
      type: string;
      activeId?: string;
      entries: unknown[];
    };
    expect(frame).toBeTruthy();
    expect(frame.type).toBe("sessions");
    expect(frame.activeId).toBeUndefined();
    expect(frame.entries).toEqual(interimSessions.entries);
    expect(Object.prototype.hasOwnProperty.call(frame, "activeId")).toBe(false);
  });

  it("keeps the restored session's activeId so the real name can bind", () => {
    const rt = makeGate();
    expect(rt.inboundFrameForRenderer(targetSessions)).toEqual(targetSessions);
  });

  it("after abandon, the host's next catalog identity is left intact", () => {
    const rt = makeGate();
    rt.setTarget(null);
    rt.removeRestoring();
    expect(rt.inboundFrameForRenderer(interimSessions)).toEqual(interimSessions);
  });
});

describe("the wrapper, not a timer, is what drops the interim name", () => {
  it("rewrites the frame before dispatch and still finishes restore from the original", () => {
    expect(messageHandlerSrc).toContain("inboundFrameForRenderer(data)");
    expect(messageHandlerSrc.indexOf("inboundFrameForRenderer(data)"))
      .toBeLessThan(messageHandlerSrc.indexOf("window.dispatchEvent"));
    expect(messageHandlerSrc).toContain("if (renderData)");
    expect(messageHandlerSrc).toContain("maybeFinishIdentityRestore(data)");
    expect(messageHandlerSrc.indexOf("window.dispatchEvent"))
      .toBeLessThan(messageHandlerSrc.indexOf("maybeFinishIdentityRestore(data)"));
    expect(gateSrc).not.toContain("setTimeout");
    expect(gateSrc).not.toContain("setInterval");
  });

  it("a cache paint publishes the remembered id's name so a reload does not fall back", () => {
    expect(cacheSrc).toContain("publishCachedSessionName(identity, cache.title)");
    expect(cacheSrc).toContain('type: "sessionName"');
    expect(cacheSrc).toContain("sessionId: identity.id");
    expect(cacheSrc.indexOf("applyTranscriptCache(messagesEl, cache)"))
      .toBeLessThan(cacheSrc.indexOf("publishCachedSessionName(identity, cache.title)"));
  });
});
