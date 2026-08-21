import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Behavioural extract of the rendered-window transcript cache in web/chat.html.
// The cache is a first-paint optimisation: sessionStorage, write on hide,
// paint before the host replay, ignore anything that isn't this session.

const html = readFileSync(new URL("../web/chat.html", import.meta.url), "utf8");

const cacheSrc = html.slice(
  html.indexOf("function parseTranscriptCache(raw)"),
  html.indexOf("function queuedSendTexts()"),
);
const connectSrc = html.slice(html.indexOf("function connect()"), html.indexOf("function abandonSocketAndRedial"));
const beginRestoreSrc = html.slice(
  html.indexOf("function beginIdentityRestore()"),
  html.indexOf("function isIdentityRestoreMessage("),
);
const resumeSrc = html.slice(
  html.indexOf("function onResumeVisible"),
  html.indexOf("function persistStandaloneInstall()"),
);
const messageHandlerSrc = connectSrc.slice(
  connectSrc.indexOf('addEventListener("message"'),
  connectSrc.indexOf('addEventListener("close"'),
);

const TRANSCRIPT_CACHE_KEY = "grok.remote.transcript:test";
const TRANSCRIPT_CACHE_VERSION = 1;

type AttrMap = Record<string, string>;

type FakeNode = {
  id: string;
  tagName: string;
  className: string;
  hidden: boolean;
  textContent: string;
  scrollTop: number;
  scrollHeight: number;
  parentElement: FakeNode | null;
  parentNode: FakeNode | null;
  ownerDocument: FakeDoc | null;
  children: FakeNode[];
  attributes: AttrMap;
  _outer: string;
  get firstChild(): FakeNode | null;
  get nextSibling(): FakeNode | null;
  get outerHTML(): string;
  get innerHTML(): string;
  set innerHTML(html: string);
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  hasAttribute: (name: string) => boolean;
  removeAttribute: (name: string) => void;
  querySelector: (sel: string) => FakeNode | null;
  querySelectorAll: (sel: string) => FakeNode[];
  appendChild: (child: FakeNode) => FakeNode;
  insertBefore: (child: FakeNode, before: FakeNode | null) => FakeNode;
  remove: () => void;
  cloneNode: (deep?: boolean) => FakeNode;
};

type FakeDoc = {
  nodes: Record<string, FakeNode>;
  body: { classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean } };
  createElement: (tag: string) => FakeNode;
  getElementById: (id: string) => FakeNode | null;
};

function tokenClass(className: string, cls: string) {
  return className.split(/\s+/).includes(cls);
}

function matches(node: FakeNode, sel: string): boolean {
  if (sel === "*") return true;
  if (sel === "script") return node.tagName === "SCRIPT";
  if (sel.startsWith(".")) return tokenClass(node.className, sel.slice(1));
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  return node.tagName === sel.toUpperCase();
}

function walkQuery(root: FakeNode, sel: string, out: FakeNode[]) {
  for (const child of root.children) {
    if (matches(child, sel)) out.push(child);
    walkQuery(child, sel, out);
  }
}

function parseTopLevel(html: string, owner: FakeDoc | null): FakeNode[] {
  const out: FakeNode[] = [];
  const re = /<([a-zA-Z0-9]+)([^>]*)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const node = fakeNode({ tag: match[1], ownerDocument: owner, outer: match[0] });
    const attrs = match[2];
    const idM = /(?:^|\s)id="([^"]*)"/.exec(attrs);
    if (idM) node.id = idM[1];
    const classM = /(?:^|\s)class="([^"]*)"/.exec(attrs);
    if (classM) node.className = classM[1];
    node.textContent = match[3].replace(/<[^>]+>/g, "");
    if (/class="[^"]*\bmsg\b/.test(match[3]) && !tokenClass(node.className, "msg")) {
      const inner = fakeNode({ tag: "div", className: "msg", ownerDocument: owner });
      inner.parentElement = node;
      inner.parentNode = node;
      node.children.push(inner);
    }
    if (/<script/i.test(match[3])) {
      const script = fakeNode({ tag: "script", ownerDocument: owner });
      script.parentElement = node;
      script.parentNode = node;
      node.children.push(script);
    }
    out.push(node);
  }
  return out;
}

function fakeNode(init?: {
  tag?: string;
  id?: string;
  className?: string;
  html?: string;
  outer?: string;
  attrs?: AttrMap;
  ownerDocument?: FakeDoc | null;
  children?: FakeNode[];
}): FakeNode {
  const node: FakeNode = {
    id: init?.id || "",
    tagName: (init?.tag || "div").toUpperCase(),
    className: init?.className || "",
    hidden: false,
    textContent: "",
    scrollTop: 0,
    scrollHeight: 800,
    parentElement: null,
    parentNode: null,
    ownerDocument: init?.ownerDocument || null,
    children: init?.children ? init.children.slice() : [],
    attributes: { ...(init?.attrs || {}) },
    _outer: init?.outer || init?.html || "",
    get firstChild() {
      return this.children[0] || null;
    },
    get nextSibling() {
      const parent = this.parentElement;
      if (!parent) return null;
      const idx = parent.children.indexOf(this);
      return idx >= 0 ? parent.children[idx + 1] || null : null;
    },
    get outerHTML() {
      if (this._outer) return this._outer;
      const attrs = this.id ? ` id="${this.id}"` : "";
      const cls = this.className ? ` class="${this.className}"` : "";
      return `<${this.tagName.toLowerCase()}${attrs}${cls}>${this.textContent}</${this.tagName.toLowerCase()}>`;
    },
    get innerHTML() {
      return this.children.map((c) => c.outerHTML).join("");
    },
    set innerHTML(html: string) {
      this.children = parseTopLevel(html, this.ownerDocument);
      for (const child of this.children) {
        child.parentElement = this;
        child.parentNode = this;
        child.ownerDocument = this.ownerDocument;
      }
    },
    getAttribute(name: string) {
      if (name === "id") return this.id || null;
      if (name === "class") return this.className || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
      if (name === "id") {
        this.id = value;
        if (this.ownerDocument) this.ownerDocument.nodes[value] = this;
      }
      if (name === "class") this.className = value;
    },
    hasAttribute(name: string) {
      return this.getAttribute(name) != null;
    },
    removeAttribute(name: string) {
      delete this.attributes[name];
      if (name === "id") this.id = "";
      if (name === "src") delete this.attributes.src;
    },
    querySelector(sel: string) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel: string) {
      const out: FakeNode[] = [];
      walkQuery(this, sel, out);
      return out;
    },
    appendChild(child: FakeNode) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
      if (child.id && this.ownerDocument) this.ownerDocument.nodes[child.id] = child;
      return child;
    },
    insertBefore(child: FakeNode, before: FakeNode | null) {
      if (child.parentElement) child.remove();
      child.parentElement = this;
      child.parentNode = this;
      child.ownerDocument = this.ownerDocument;
      const idx = before ? this.children.indexOf(before) : -1;
      if (idx < 0) this.children.push(child);
      else this.children.splice(idx, 0, child);
      if (child.id && this.ownerDocument) this.ownerDocument.nodes[child.id] = child;
      return child;
    },
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      parent.children = parent.children.filter((c) => c !== this);
      this.parentElement = null;
      this.parentNode = null;
    },
    cloneNode() {
      const copy = fakeNode({
        tag: this.tagName.toLowerCase(),
        id: this.id,
        className: this.className,
        outer: this.outerHTML,
        attrs: { ...this.attributes },
        ownerDocument: this.ownerDocument,
      });
      copy.textContent = this.textContent;
      copy.children = this.children.map((c) => {
        const kid = c.cloneNode(true);
        kid.parentElement = copy;
        kid.parentNode = copy;
        return kid;
      });
      return copy;
    },
  };
  if (init?.html) node.textContent = init.html.replace(/<[^>]+>/g, "");
  return node;
}

function fakeDoc() {
  const nodes: Record<string, FakeNode> = {};
  const classes = new Set<string>();
  const doc: FakeDoc = {
    nodes,
    body: {
      classList: {
        add: (c) => { classes.add(c); },
        remove: (c) => { classes.delete(c); },
        contains: (c) => classes.has(c),
      },
    },
    createElement(tag: string) {
      return fakeNode({ tag, ownerDocument: doc });
    },
    getElementById(id: string) {
      return nodes[id] || null;
    },
  };
  const messages = fakeNode({ tag: "main", id: "messages", className: "messages", ownerDocument: doc });
  const welcome = fakeNode({ tag: "div", id: "welcome", className: "welcome", ownerDocument: doc });
  const title = fakeNode({ tag: "span", id: "session-head-title", ownerDocument: doc });
  messages.appendChild(welcome);
  nodes.messages = messages;
  nodes.welcome = welcome;
  nodes["session-head-title"] = title;
  return { doc, messages, welcome, title, classes };
}

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map<string, string>(Object.entries(initial || {}));
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
    removeItem(key: string) {
      map.delete(key);
    },
    get size() {
      return map.size;
    },
    dump() {
      return Object.fromEntries(map);
    },
  };
}

function msgEl(text: string, extras?: { pending?: boolean; hiddenOpen?: boolean }) {
  const attrs: AttrMap = {};
  if (extras?.pending) attrs["data-pending-clear"] = "1";
  if (extras?.hiddenOpen) attrs["data-pending-open-hide"] = "1";
  const node = fakeNode({
    tag: "div",
    className: "msg user",
    html: `<div class="msg user"><div class="body">${text}</div></div>`,
    outer: `<div class="msg user"><div class="body">${text}</div></div>`,
    attrs,
  });
  node.textContent = text;
  return node;
}

function historyHead() {
  return fakeNode({ tag: "div", id: "history-head", outer: '<div id="history-head" aria-hidden="true"></div>' });
}

type CacheFns = {
  parseTranscriptCache: (raw: unknown) => {
    sessionId: string;
    html: string;
    hasOlder: boolean;
    title: string;
  } | null;
  cacheMatchesSession: (cache: unknown, sessionId: string | null) => boolean;
  snapshotRenderedTranscript: (messagesEl: FakeNode | null) => { html: string; hasOlder: boolean; title: string } | null;
  persistRenderedTranscript: () => boolean;
  restoreRenderedTranscript: () => boolean;
  applyTranscriptCache: (messagesEl: FakeNode, cache: { html: string; hasOlder?: boolean; title?: string }) => boolean;
};

function loadFns(opts: {
  doc: FakeDoc;
  storage: ReturnType<typeof memoryStorage>;
  identity?: { id: string; repoCwd: string } | null;
  painted?: boolean;
  prefixRemaining?: number;
  quotaFail?: boolean;
}): CacheFns {
  const identity = opts.identity === undefined ? { id: "sess-1", repoCwd: "/repo" } : opts.identity;
  const storage = opts.storage;
  if (opts.quotaFail) {
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
  }
  return new Function(
    "document",
    "sessionStorage",
    "window",
    "TRANSCRIPT_CACHE_KEY",
    "TRANSCRIPT_CACHE_VERSION",
    "rememberedIdentity",
    "transcriptHasConversation",
    `${cacheSrc}; return {
      parseTranscriptCache,
      cacheMatchesSession,
      snapshotRenderedTranscript,
      persistRenderedTranscript,
      restoreRenderedTranscript,
      applyTranscriptCache,
    };`,
  )(
    opts.doc,
    storage,
    { __grokHistory: { prefixRemaining: () => opts.prefixRemaining || 0 } },
    TRANSCRIPT_CACHE_KEY,
    TRANSCRIPT_CACHE_VERSION,
    () => identity,
    () => {
      if (opts.painted) return true;
      const messages = opts.doc.getElementById("messages");
      return !!(messages && messages.querySelector(".msg"));
    },
  ) as CacheFns;
}

describe("transcript cache format", () => {
  it("accepts a v1 payload with a session id and rendered html", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    const parsed = fns.parseTranscriptCache(JSON.stringify({
      v: 1,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      hasOlder: true,
      title: "Fix the login",
    }));
    expect(parsed).toEqual({
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      hasOlder: true,
      title: "Fix the login",
    });
  });

  it("rejects missing, corrupt, or wrong-version payloads", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    expect(fns.parseTranscriptCache(null)).toBeNull();
    expect(fns.parseTranscriptCache("")).toBeNull();
    expect(fns.parseTranscriptCache("{not json")).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 2, sessionId: "s", html: "<div class='msg'></div>" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 1, sessionId: "", html: "<div class='msg'></div>" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 1, sessionId: "s", html: "" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 1, html: "<div class='msg'></div>" }))).toBeNull();
  });

  it("matches only the remembered session id", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    const cache = fns.parseTranscriptCache(JSON.stringify({
      v: 1,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
    }));
    expect(fns.cacheMatchesSession(cache, "sess-1")).toBe(true);
    expect(fns.cacheMatchesSession(cache, "sess-other")).toBe(false);
    expect(fns.cacheMatchesSession(cache, null)).toBe(false);
    expect(fns.cacheMatchesSession(null, "sess-1")).toBe(false);
  });
});

describe("hide -> reload -> paint before the host", () => {
  it("writes the rendered window on hide and paints it on a fresh document before any host frame", () => {
    const live = fakeDoc();
    live.title.textContent = "Fix the login";
    live.messages.appendChild(msgEl("hello from cache"));
    live.messages.appendChild(historyHead());
    const storage = memoryStorage();
    const writer = loadFns({ doc: live.doc, storage, prefixRemaining: 3 });
    expect(writer.persistRenderedTranscript()).toBe(true);
    const stored = JSON.parse(storage.getItem(TRANSCRIPT_CACHE_KEY) || "null");
    expect(stored.v).toBe(1);
    expect(stored.sessionId).toBe("sess-1");
    expect(stored.html).toContain("hello from cache");
    expect(stored.hasOlder).toBe(true);
    expect(stored.title).toBe("Fix the login");
    expect(stored.html).not.toContain("history-head");
    expect(stored).not.toHaveProperty("prefix");
    expect(stored).not.toHaveProperty("historyPrefix");

    const reload = fakeDoc();
    const reader = loadFns({ doc: reload.doc, storage });
    expect(reload.messages.querySelector(".msg")).toBeNull();
    expect(reader.restoreRenderedTranscript()).toBe(true);
    expect(reload.messages.querySelector(".msg")?.textContent).toContain("hello from cache");
    expect(reload.welcome.hidden).toBe(true);
    expect(reload.doc.getElementById("history-head")).toBeTruthy();
    expect(reload.title.textContent).toBe("Fix the login");
    expect(reload.messages.scrollTop).toBe(reload.messages.scrollHeight);
  });

  it("a cache for a different session id is ignored, not shown", () => {
    const storage = memoryStorage({
      [TRANSCRIPT_CACHE_KEY]: JSON.stringify({
        v: 1,
        sessionId: "sess-A",
        html: '<div class="msg user"><div class="body">conversation A</div></div>',
        hasOlder: false,
        title: "A",
      }),
    });
    const page = fakeDoc();
    const fns = loadFns({
      doc: page.doc,
      storage,
      identity: { id: "sess-B", repoCwd: "/repo" },
    });
    expect(fns.restoreRenderedTranscript()).toBe(false);
    expect(page.messages.querySelector(".msg")).toBeNull();
    expect(page.welcome.hidden).toBe(false);
    expect(page.title.textContent).toBe("");
  });

  it("no cache, corrupt cache, and quota failure all fall back to today's empty transcript", () => {
    const empty = fakeDoc();
    expect(loadFns({ doc: empty.doc, storage: memoryStorage() }).restoreRenderedTranscript()).toBe(false);
    expect(empty.messages.querySelector(".msg")).toBeNull();

    const corrupt = fakeDoc();
    expect(loadFns({
      doc: corrupt.doc,
      storage: memoryStorage({ [TRANSCRIPT_CACHE_KEY]: "{not json" }),
    }).restoreRenderedTranscript()).toBe(false);
    expect(corrupt.messages.querySelector(".msg")).toBeNull();

    const live = fakeDoc();
    live.messages.appendChild(msgEl("will not fit"));
    const quota = memoryStorage();
    const writer = loadFns({ doc: live.doc, storage: quota, quotaFail: true });
    expect(writer.persistRenderedTranscript()).toBe(false);
    expect(quota.dump()).toEqual({});

    const afterQuota = fakeDoc();
    expect(loadFns({ doc: afterQuota.doc, storage: quota }).restoreRenderedTranscript()).toBe(false);
    expect(afterQuota.messages.querySelector(".msg")).toBeNull();
  });

  it("the older-messages marker survives a persist/restore round trip", () => {
    const live = fakeDoc();
    live.messages.appendChild(msgEl("tail of a long conversation"));
    live.messages.appendChild(historyHead());
    const storage = memoryStorage();
    expect(loadFns({ doc: live.doc, storage, prefixRemaining: 12 }).persistRenderedTranscript()).toBe(true);
    expect(JSON.parse(storage.getItem(TRANSCRIPT_CACHE_KEY) || "{}").hasOlder).toBe(true);

    const reload = fakeDoc();
    const reader = loadFns({ doc: reload.doc, storage });
    expect(reader.restoreRenderedTranscript()).toBe(true);
    expect(reload.doc.getElementById("history-head")).toBeTruthy();
    expect(reader.persistRenderedTranscript()).toBe(true);
    expect(JSON.parse(storage.getItem(TRANSCRIPT_CACHE_KEY) || "{}").hasOlder).toBe(true);
  });

  it("skips pending-clear nodes and never treats an empty transcript as something to store", () => {
    const live = fakeDoc();
    live.messages.appendChild(msgEl("ghost", { pending: true }));
    const storage = memoryStorage();
    expect(loadFns({ doc: live.doc, storage }).persistRenderedTranscript()).toBe(false);
    expect(storage.getItem(TRANSCRIPT_CACHE_KEY)).toBeNull();
  });
});

describe("paint then reconcile", () => {
  it("a matching cache paints so the restore veil is not used", () => {
    const storage = memoryStorage({
      [TRANSCRIPT_CACHE_KEY]: JSON.stringify({
        v: 1,
        sessionId: "sess-1",
        html: '<div class="msg user"><div class="body">already on screen</div></div>',
        hasOlder: false,
        title: "",
      }),
    });
    const page = fakeDoc();
    const fns = loadFns({ doc: page.doc, storage });
    expect(fns.restoreRenderedTranscript()).toBe(true);
    expect(page.messages.querySelector(".msg")?.textContent).toContain("already on screen");
    // The wrapper's veil keys off emptiness. A painted cache is the same
    // path as a mid-session reconnect: identity-restoring holds the
    // pending-clear, the transcript stays visible.
    expect(beginRestoreSrc).toContain("restoreRenderedTranscript()");
    expect(beginRestoreSrc.indexOf("restoreRenderedTranscript()"))
      .toBeLessThan(beginRestoreSrc.indexOf('classList.add("identity-restoring")'));
    expect(beginRestoreSrc.indexOf('classList.add("identity-restoring")'))
      .toBeLessThan(beginRestoreSrc.indexOf("transcriptHasConversation()"));
  });

  it("does not wipe the painted window when the host replay arrives", () => {
    const noteReplaySrc = html.slice(
      html.indexOf("function noteIdentityReplay(data)"),
      html.indexOf("function finishIdentityRestore()"),
    );
    expect(noteReplaySrc).not.toContain("persistRenderedTranscript");
    expect(noteReplaySrc).not.toContain("applyTranscriptCache");
    expect(noteReplaySrc).not.toContain("restoreRenderedTranscript");
    expect(messageHandlerSrc).not.toContain("persistRenderedTranscript");
    expect(messageHandlerSrc).not.toContain("applyTranscriptCache");
  });
});

describe("write only on hide", () => {
  it("persists from visibility hidden and pagehide, never from inbound frames", () => {
    const hiddenSrc = resumeSrc.slice(
      resumeSrc.indexOf('document.addEventListener("visibilitychange"'),
      resumeSrc.indexOf('window.addEventListener("pagehide"'),
    );
    expect(hiddenSrc).toContain('document.visibilityState === "hidden"');
    expect(hiddenSrc).toContain("persistRenderedTranscript()");
    expect(hiddenSrc.indexOf("persistRenderedTranscript()"))
      .toBeLessThan(hiddenSrc.indexOf("onResumeVisible"));
    expect(hiddenSrc.indexOf("return"))
      .toBeLessThan(hiddenSrc.indexOf("onResumeVisible"));

    const pagehideSrc = resumeSrc.slice(
      resumeSrc.indexOf('window.addEventListener("pagehide"'),
      resumeSrc.indexOf('window.addEventListener("pageshow"'),
    );
    expect(pagehideSrc).toContain("persistRenderedTranscript()");

    expect(messageHandlerSrc).not.toContain("persistRenderedTranscript");
    expect(connectSrc).toContain("restoreRenderedTranscript()");
    expect(connectSrc.indexOf("restoreRenderedTranscript()"))
      .toBeLessThan(connectSrc.indexOf("new WebSocket("));
    expect(html).not.toContain("indexedDB");
    expect(html).not.toContain("IndexedDB");
  });

  it("does not cache the unrendered prefix — scroll-up is a host load", () => {
    const snapshotSrc = html.slice(
      html.indexOf("function snapshotRenderedTranscript"),
      html.indexOf("function persistRenderedTranscript"),
    );
    expect(snapshotSrc).toContain('id === "history-head"');
    expect(snapshotSrc).toContain("hasOlder");
    expect(snapshotSrc).toContain("historyPrefixRemaining()");
    expect(snapshotSrc).not.toContain("state.historyPrefix");
    expect(cacheSrc).not.toContain("loadEarlierHistory");
    expect(cacheSrc).not.toContain("addEventListener(\"scroll\"");
  });
});
