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
const TRANSCRIPT_CACHE_VERSION = 2;

type AttrMap = Record<string, string>;

type FakeNode = {
  id: string;
  tagName: string;
  className: string;
  hidden: boolean;
  textContent: string;
  scrollTop: number;
  scrollHeight: number;
  offsetWidth: number;
  offsetHeight: number;
  style: { width?: string; height?: string };
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
    offsetWidth: 0,
    offsetHeight: 0,
    style: {},
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
      const styled = !!(this.style && (this.style.width || this.style.height));
      if (this._outer && this.children.length === 0 && !styled) return this._outer;
      const tag = this.tagName.toLowerCase();
      let attrs = "";
      if (this.id) attrs += ` id="${this.id}"`;
      if (this.className) attrs += ` class="${this.className}"`;
      for (const [name, value] of Object.entries(this.attributes)) {
        if (name === "id" || name === "class") continue;
        attrs += ` ${name}="${value}"`;
      }
      if (styled) {
        const bits = [
          this.style.width ? `width: ${this.style.width}` : "",
          this.style.height ? `height: ${this.style.height}` : "",
        ].filter(Boolean);
        if (bits.length) attrs += ` style="${bits.join("; ")}"`;
      }
      const inner = this.children.length
        ? this.children.map((c) => c.outerHTML).join("")
        : this.textContent;
      return `<${tag}${attrs}>${inner}</${tag}>`;
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
        outer: this.children.length ? "" : this._outer,
        attrs: { ...this.attributes },
        ownerDocument: this.ownerDocument,
      });
      copy.textContent = this.textContent;
      copy.style = { ...this.style };
      copy.offsetWidth = this.offsetWidth;
      copy.offsetHeight = this.offsetHeight;
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

function memoryStorage(initial?: Record<string, string>, maxBytes?: number) {
  const map = new Map<string, string>(Object.entries(initial || {}));
  function used() {
    let n = 0;
    for (const [k, v] of map) n += k.length + v.length;
    return n;
  }
  return {
    getItem(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key: string, value: string) {
      const next = String(value);
      if (maxBytes != null) {
        const other = used() - (map.has(key) ? key.length + map.get(key)!.length : 0);
        if (other + key.length + next.length > maxBytes) {
          const err = new Error("QuotaExceededError");
          err.name = "QuotaExceededError";
          throw err;
        }
      }
      map.set(key, next);
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

function msgEl(text: string, extras?: { pending?: boolean; hiddenOpen?: boolean; optimistic?: boolean }) {
  const attrs: AttrMap = {};
  if (extras?.pending) attrs["data-pending-clear"] = "1";
  if (extras?.hiddenOpen) attrs["data-pending-open-hide"] = "1";
  if (extras?.optimistic) attrs["data-optimistic"] = "1";
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

function generatedImageMsg(src: string, size: { w: number; h: number }) {
  const wrap = fakeNode({ tag: "div", className: "generated-image msg assistant" });
  const img = fakeNode({ tag: "img", attrs: { src } });
  img.offsetWidth = size.w;
  img.offsetHeight = size.h;
  wrap.appendChild(img);
  return wrap;
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
    scroll: { atBottom: true } | { atBottom: false; top: number } | null;
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
  identity?: { id: string; repoCwd: string; cwd?: string } | null;
  painted?: boolean;
  prefixRemaining?: number;
  quotaFail?: boolean;
  dispatched?: unknown[];
}): CacheFns {
  const identity = opts.identity === undefined ? { id: "sess-1", repoCwd: "/repo" } : opts.identity;
  const storage = opts.storage;
  const dispatched = opts.dispatched;
  if (opts.quotaFail) {
    storage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
  }
  return new Function(
    "document",
    "sessionStorage",
    "window",
    "MessageEvent",
    "TRANSCRIPT_CACHE_KEY",
    "TRANSCRIPT_CACHE_VERSION",
    "rememberedIdentity",
    "transcriptHasConversation",
    `function armCachedViewScroll() {}
    function snapshotTranscriptScroll() { return { atBottom: true }; }
    function applyCachedTranscriptScroll(el) {
      if (el) el.scrollTop = el.scrollHeight;
      armCachedViewScroll();
    }
    ${cacheSrc}; return {
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
    {
      __grokHistory: { prefixRemaining: () => opts.prefixRemaining || 0 },
      dispatchEvent(event: { data?: unknown }) {
        if (dispatched) dispatched.push(event && event.data);
        return true;
      },
    },
    function MessageEvent(this: { type: string; data: unknown }, type: string, init?: { data?: unknown }) {
      this.type = type;
      this.data = init && init.data;
    },
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
  it("accepts a v2 payload with a session id and rendered html", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    const parsed = fns.parseTranscriptCache(JSON.stringify({
      v: 2,
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
      scroll: null,
    });
  });

  it("accepts scrollTop and ignores a stale text-anchor shape", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    expect(fns.parseTranscriptCache(JSON.stringify({
      v: 2,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      scroll: { atBottom: true },
    }))?.scroll).toEqual({ atBottom: true });
    expect(fns.parseTranscriptCache(JSON.stringify({
      v: 2,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      scroll: { atBottom: false, top: 120 },
    }))?.scroll).toEqual({ atBottom: false, top: 120 });
    expect(fns.parseTranscriptCache(JSON.stringify({
      v: 2,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      scroll: { atBottom: false, top: 0 },
    }))?.scroll).toEqual({ atBottom: false, top: 0 });
    expect(fns.parseTranscriptCache(JSON.stringify({
      v: 2,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      scroll: { atBottom: false, key: "two", y: 12 },
    }))?.scroll).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({
      v: 2,
      sessionId: "sess-1",
      html: '<div class="msg">hi</div>',
      scroll: { atBottom: false, top: -1 },
    }))?.scroll).toBeNull();
  });

  it("rejects missing, corrupt, or wrong-version payloads", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    expect(fns.parseTranscriptCache(null)).toBeNull();
    expect(fns.parseTranscriptCache("")).toBeNull();
    expect(fns.parseTranscriptCache("{not json")).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 1, sessionId: "s", html: "<div class='msg'></div>" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 3, sessionId: "s", html: "<div class='msg'></div>" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 2, sessionId: "", html: "<div class='msg'></div>" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 2, sessionId: "s", html: "" }))).toBeNull();
    expect(fns.parseTranscriptCache(JSON.stringify({ v: 2, html: "<div class='msg'></div>" }))).toBeNull();
  });

  it("matches only the remembered session id", () => {
    const { doc } = fakeDoc();
    const fns = loadFns({ doc, storage: memoryStorage() });
    const cache = fns.parseTranscriptCache(JSON.stringify({
      v: 2,
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
    expect(stored.v).toBe(2);
    expect(stored.sessionId).toBe("sess-1");
    expect(stored.html).toContain("hello from cache");
    expect(stored.hasOlder).toBe(true);
    expect(stored.title).toBe("Fix the login");
    expect(stored.scroll).toEqual({ atBottom: true });
    expect(stored.html).not.toContain("history-head");
    expect(stored).not.toHaveProperty("prefix");
    expect(stored).not.toHaveProperty("historyPrefix");

    const reload = fakeDoc();
    const dispatched: unknown[] = [];
    const reader = loadFns({ doc: reload.doc, storage, dispatched });
    expect(reload.messages.querySelector(".msg")).toBeNull();
    expect(reader.restoreRenderedTranscript()).toBe(true);
    expect(reload.messages.querySelector(".msg")?.textContent).toContain("hello from cache");
    expect(reload.welcome.hidden).toBe(true);
    expect(reload.doc.getElementById("history-head")).toBeTruthy();
    expect(reload.title.textContent).toBe("Fix the login");
    expect(reload.messages.scrollTop).toBe(reload.messages.scrollHeight);
    expect(dispatched).toEqual([{
      type: "sessionName",
      sessionId: "sess-1",
      name: "Fix the login",
      cwd: "",
      repoCwd: "/repo",
    }]);
  });

  it("a cache for a different session id is ignored, not shown", () => {
    const storage = memoryStorage({
      [TRANSCRIPT_CACHE_KEY]: JSON.stringify({
        v: 2,
        sessionId: "sess-A",
        html: '<div class="msg user"><div class="body">conversation A</div></div>',
        hasOlder: false,
        title: "A",
        scroll: { atBottom: false, top: 40 },
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

  it("strips image payloads, keeps the box, and still fits next to the outbox", () => {
    const live = fakeDoc();
    live.messages.appendChild(msgEl("caption"));
    const payload = "data:image/png;base64," + "A".repeat(8000);
    live.messages.appendChild(generatedImageMsg(payload, { w: 320, h: 180 }));
    const storage = memoryStorage({}, 2500);
    expect(loadFns({ doc: live.doc, storage }).persistRenderedTranscript()).toBe(true);
    const stored = JSON.parse(storage.getItem(TRANSCRIPT_CACHE_KEY) || "null");
    expect(stored.html).toContain("caption");
    expect(stored.html).not.toContain("data:");
    expect(stored.html).toContain("width: 320px");
    expect(stored.html).toContain("height: 180px");

    const outboxKey = "afk-outbox:test";
    storage.setItem(outboxKey, JSON.stringify([JSON.stringify({ type: "send", text: "queued" })]));
    expect(storage.getItem(outboxKey)).toContain("queued");

    const reload = fakeDoc();
    expect(loadFns({ doc: reload.doc, storage }).restoreRenderedTranscript()).toBe(true);
    expect(reload.messages.querySelector(".msg")?.textContent).toContain("caption");
  });

  it("does not cache an optimistic message; the outbox still owns it", () => {
    const live = fakeDoc();
    live.messages.appendChild(msgEl("confirmed"));
    live.messages.appendChild(msgEl("still in flight", { optimistic: true }));
    const storage = memoryStorage();
    const outboxKey = "afk-outbox:test";
    storage.setItem(outboxKey, JSON.stringify([JSON.stringify({ type: "send", text: "still in flight" })]));
    expect(loadFns({ doc: live.doc, storage }).persistRenderedTranscript()).toBe(true);
    const stored = JSON.parse(storage.getItem(TRANSCRIPT_CACHE_KEY) || "null");
    expect(stored.html).toContain("confirmed");
    expect(stored.html).not.toContain("still in flight");
    expect(storage.getItem(outboxKey)).toContain("still in flight");

    const onlyOptimistic = fakeDoc();
    onlyOptimistic.messages.appendChild(msgEl("only echo", { optimistic: true }));
    const empty = memoryStorage();
    expect(loadFns({ doc: onlyOptimistic.doc, storage: empty }).persistRenderedTranscript()).toBe(false);
    expect(empty.getItem(TRANSCRIPT_CACHE_KEY)).toBeNull();
  });
});

describe("paint then reconcile", () => {
  it("a matching cache paints so the restore veil is not used", () => {
    const storage = memoryStorage({
      [TRANSCRIPT_CACHE_KEY]: JSON.stringify({
        v: 2,
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
    expect(snapshotSrc).toContain("data-optimistic");
    expect(snapshotSrc).toContain("stripCachedMediaPayloads");
    expect(snapshotSrc).not.toContain("state.historyPrefix");
    expect(cacheSrc).not.toContain("loadEarlierHistory");
    expect(cacheSrc).not.toContain("addEventListener(\"scroll\"");
  });
});

const scrollSrc = html.slice(
  html.indexOf("function armCachedViewScroll()"),
  html.indexOf("function finishIdentityRestore()"),
);
const sendResumeSrc = html.slice(
  html.indexOf("if (m && m.type === \"resumeSession\" && restoreMsg)"),
  html.indexOf("} else if (disposition === \"abandon-and-send\")"),
);

type LayoutRow = {
  id: string;
  className: string;
  textContent: string;
  height: number;
  isConnected: boolean;
  parentElement: LayoutMessages | null;
  parentNode: LayoutMessages | null;
  bodyText: string;
  get offsetTop(): number;
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
  querySelector: (sel: string) => { textContent: string } | null;
  getAttribute: (name: string) => string | null;
};

type LayoutMessages = {
  id: string;
  children: LayoutRow[];
  get clientHeight(): number;
  get scrollHeight(): number;
  get scrollTop(): number;
  set scrollTop(value: number);
  getBoundingClientRect: () => { top: number; bottom: number; height: number };
  contains: (node: unknown) => boolean;
  dispatchEvent: (event: unknown) => boolean;
  hooks: {
    noteIntent: (() => void) | null;
    onScroll: (() => void) | null;
  };
  atBottomHistory: boolean[];
};

// chat.js default for shouldStickToBottom when no line-height is supplied.
const RENDERER_STICK_THRESHOLD = 40;
const RENDERER_INTENT_MS = 750;

function layoutTranscript(opts?: { clientHeight?: number; rowHeight?: number; texts?: string[] }) {
  let clientHeight = opts?.clientHeight ?? 250;
  const rowHeight = opts?.rowHeight ?? 100;
  const events: string[] = [];
  const atBottomHistory: boolean[] = [];
  const pointerDownTargets: unknown[] = [];
  let scrollTop = 0;
  let stickToBottom = true;
  let userScrollIntentUntil = 0;
  const children: LayoutRow[] = [];
  const noteUserScrollIntent = () => {
    userScrollIntentUntil = Date.now() + RENDERER_INTENT_MS;
  };
  const hasUserScrollIntent = () => Date.now() < userScrollIntentUntil;
  const recomputePinFromScroll = () => {
    // chat.js scroll listener: only a latched gesture may change the pin.
    if (!hasUserScrollIntent()) return;
    const distanceFromBottom = messages.scrollHeight - (scrollTop + clientHeight);
    stickToBottom = distanceFromBottom <= RENDERER_STICK_THRESHOLD;
  };
  const eventTarget = (event: unknown) => {
    if (event && typeof event === "object" && "target" in event) {
      return (event as { target: unknown }).target;
    }
    return undefined;
  };
  const messages: LayoutMessages = {
    id: "messages",
    children,
    atBottomHistory,
    hooks: { noteIntent: null, onScroll: null },
    get clientHeight() {
      return clientHeight;
    },
    get scrollHeight() {
      return children.reduce((sum, row) => sum + row.height, 0);
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      events.push("scroll");
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      scrollTop = Math.max(0, Math.min(Number(value) || 0, max));
      atBottomHistory.push(max > 0 && scrollTop >= max);
      recomputePinFromScroll();
    },
    getBoundingClientRect() {
      return { top: 0, bottom: clientHeight, height: clientHeight };
    },
    contains(node: unknown) {
      return children.includes(node as LayoutRow);
    },
    dispatchEvent(event: unknown) {
      if (event && typeof event === "object" && eventTarget(event) == null) {
        Object.defineProperty(event, "target", { value: this, configurable: true });
      }
      const type = event && typeof event === "object" && "type" in event
        ? String((event as { type: string }).type)
        : "event";
      events.push(type);
      if (type === "wheel" || type === "touchstart") {
        noteUserScrollIntent();
      } else if (type === "pointerdown") {
        pointerDownTargets.push(eventTarget(event));
        // chat.js: if (e.target === messagesEl) noteUserScrollIntent();
        if (eventTarget(event) === this) noteUserScrollIntent();
      } else if (type === "keydown") {
        const key = event && typeof event === "object" && "key" in event
          ? String((event as { key: string }).key)
          : "";
        if (eventTarget(event) === this &&
            (key === "PageUp" || key === "PageDown" || key === "Home" || key === "End" ||
             key === "ArrowUp" || key === "ArrowDown" || key === " ")) {
          noteUserScrollIntent();
        }
      }
      if (type === "pointerdown" || type === "touchstart" || type === "wheel" || type === "keydown") {
        this.hooks.noteIntent?.();
      }
      if (type === "scroll") {
        recomputePinFromScroll();
        this.hooks.onScroll?.();
      }
      return true;
    },
  };
  function resizeScrollport(nextHeight: number) {
    // chat.js ResizeObserver: pinned readers get re-pinned; scrolled-up
    // readers keep their top line.
    if (nextHeight === clientHeight) return;
    clientHeight = nextHeight;
    if (stickToBottom) messages.scrollTop = messages.scrollHeight;
  }
  function rendererGesture(type: string, target: unknown = messages, key?: string) {
    const event = key
      ? Object.assign(new Event(type, { bubbles: true }), { key })
      : new Event(type, { bubbles: true });
    Object.defineProperty(event, "target", { value: target, configurable: true });
    messages.dispatchEvent(event);
  }
  function relayout() {
    for (const row of children) {
      row.parentElement = messages;
      row.parentNode = messages;
    }
  }
  function addRow(text: string, height = rowHeight): LayoutRow {
    const row: LayoutRow = {
      id: "",
      className: "msg",
      textContent: text,
      height,
      isConnected: true,
      parentElement: messages,
      parentNode: messages,
      bodyText: text,
      get offsetTop() {
        let y = 0;
        for (const child of children) {
          if (child === row) return y;
          y += child.height;
        }
        return y;
      },
      getBoundingClientRect() {
        const top = this.offsetTop - messages.scrollTop;
        return { top, bottom: top + this.height, height: this.height };
      },
      querySelector(sel: string) {
        return sel === ".body" ? { textContent: this.bodyText } : null;
      },
      getAttribute() {
        return null;
      },
    };
    children.push(row);
    relayout();
    return row;
  }
  const welcome: LayoutRow = {
    id: "welcome",
    className: "welcome",
    textContent: "",
    height: 0,
    isConnected: true,
    parentElement: messages,
    parentNode: messages,
    bodyText: "",
    get offsetTop() { return 0; },
    getBoundingClientRect() {
      return { top: 0, bottom: 0, height: 0 };
    },
    querySelector() { return null; },
    getAttribute() { return null; },
  };
  children.push(welcome);
  for (const text of opts?.texts || ["one", "two", "three", "four", "five"]) {
    addRow(text);
  }
  return {
    messages,
    children,
    events,
    addRow,
    atBottomHistory,
    pointerDownTargets,
    get stickToBottom() { return stickToBottom; },
    resizeScrollport,
    rendererGesture,
  };
}

function loadScrollFns(messages: LayoutMessages) {
  const bodyClasses = new Set<string>();
  const fns = new Function(
    "document",
    "Event",
    `
      var cachedViewLive = false;
      var cachedViewUserScrolled = false;
      var cachedViewGesturePending = false;
      var cachedViewPinnedToBottom = false;
      var cachedViewHoldPlace = false;
      var cachedViewScrollTop = null;
      var restoringCachedView = false;
      var identityReplayDepth = 0;
      var identityRestoreComplete = false;
      var identityTarget = null;
      var pendingResumeReplay = false;
      var connectSnapshotOpen = false;
      var snapshotHadReplay = false;
      var resyncScrollTop = null;
      var restoreTimer = null;
      var readerScrollTop = null;
      var readerAwayFromBottom = false;
      ${scrollSrc}
      return {
        armCachedViewScroll: armCachedViewScroll,
        noteCachedViewUserIntent: noteCachedViewUserIntent,
        onCachedViewScroll: onCachedViewScroll,
        applyRestoreScroll: applyRestoreScroll,
        settleCachedViewScroll: settleCachedViewScroll,
        maybeFinishCachedViewScroll: maybeFinishCachedViewScroll,
        snapshotTranscriptScroll: snapshotTranscriptScroll,
        applyCachedTranscriptScroll: applyCachedTranscriptScroll,
        notePendingResumeReplay: notePendingResumeReplay,
        noteConnectSnapshot: noteConnectSnapshot,
        noteIdentityReplay: noteIdentityReplay,
        finishIdentity: function () {
          identityTarget = null;
          identityRestoreComplete = true;
          maybeFinishCachedViewScroll();
        },
        setIdentityTarget: function (value) { identityTarget = value; },
        userScrolled: function () { return cachedViewUserScrolled; },
        holdPlace: function () { return cachedViewHoldPlace; },
        gesturePending: function () { return cachedViewGesturePending; },
        live: function () { return cachedViewLive; },
        pinnedToBottom: function () { return cachedViewPinnedToBottom; },
        pendingResume: function () { return pendingResumeReplay; },
      };
    `,
  )(
    {
      body: {
        classList: {
          add: (c: string) => { bodyClasses.add(c); },
          remove: (c: string) => { bodyClasses.delete(c); },
          contains: (c: string) => bodyClasses.has(c),
        },
      },
      getElementById: (id: string) => (id === "messages" ? messages : null),
    },
    Event,
  ) as {
    armCachedViewScroll: () => void;
    noteCachedViewUserIntent: () => void;
    onCachedViewScroll: () => void;
    applyRestoreScroll: () => void;
    settleCachedViewScroll: () => boolean;
    maybeFinishCachedViewScroll: () => boolean;
    snapshotTranscriptScroll: (messages: LayoutMessages) =>
      { atBottom: true } | { atBottom: false; top: number };
    applyCachedTranscriptScroll: (
      messages: LayoutMessages,
      scroll: { atBottom: true } | { atBottom: false; top: number } | null,
    ) => void;
    notePendingResumeReplay: () => void;
    noteConnectSnapshot: (data: { type: string }) => void;
    noteIdentityReplay: (data: { type: string; active?: boolean }) => void;
    finishIdentity: () => void;
    setIdentityTarget: (value: { id: string } | null) => void;
    userScrolled: () => boolean;
    holdPlace: () => boolean;
    gesturePending: () => boolean;
    live: () => boolean;
    pinnedToBottom: () => boolean;
    pendingResume: () => boolean;
  };
  messages.hooks.noteIntent = fns.noteCachedViewUserIntent;
  messages.hooks.onScroll = fns.onCachedViewScroll;
  return fns;
}

function pinToBottom(messages: LayoutMessages) {
  messages.scrollTop = messages.scrollHeight;
}

function isFlushBottom(messages: LayoutMessages) {
  return messages.scrollTop >= messages.scrollHeight - messages.clientHeight;
}

function hostYankToBottom(fns: ReturnType<typeof loadScrollFns>, messages: LayoutMessages) {
  // chat.js forceScrollToBottom writes scrollTop; the scroll event fires
  // in the same turn. After this returns there has been no frame at the
  // bottom unless the hold was not armed.
  pinToBottom(messages);
  fns.onCachedViewScroll();
}

function heldRestore(page: ReturnType<typeof layoutTranscript>, top = 100) {
  const fns = loadScrollFns(page.messages);
  pinToBottom(page.messages);
  fns.armCachedViewScroll();
  userScrollTo(fns, page.messages, top);
  fns.setIdentityTarget({ id: "s1" });
  return fns;
}

function snapshotReplayThenIdentity(fns: ReturnType<typeof loadScrollFns>, page: ReturnType<typeof layoutTranscript>) {
  // Discarded-tab snapshot: resumeSession is already on the wire, then the
  // snapshot's own historyReplay runs, then repos/sessions confirm identity.
  fns.notePendingResumeReplay();
  fns.noteConnectSnapshot({ type: "initialState" });
  fns.noteIdentityReplay({ type: "historyReplay", active: true });
  hostYankToBottom(fns, page.messages);
  fns.noteIdentityReplay({ type: "historyReplay", active: false });
  fns.noteConnectSnapshot({ type: "repos" });
  fns.noteConnectSnapshot({ type: "sessions" });
  fns.finishIdentity();
}

function resumeSessionReplay(fns: ReturnType<typeof loadScrollFns>, page: ReturnType<typeof layoutTranscript>) {
  fns.noteIdentityReplay({ type: "historyReplay", active: true });
  hostYankToBottom(fns, page.messages);
  fns.noteIdentityReplay({ type: "historyReplay", active: false });
}

function userScrollTo(fns: ReturnType<typeof loadScrollFns>, messages: LayoutMessages, top: number) {
  fns.noteCachedViewUserIntent();
  messages.scrollTop = top;
  fns.onCachedViewScroll();
}

function replayRows(
  page: ReturnType<typeof layoutTranscript>,
  spec: { texts: string[]; heights: number[] },
) {
  for (const row of page.children.slice()) {
    if (row.id === "welcome") continue;
    row.isConnected = false;
    row.parentElement = null;
    row.parentNode = null;
    page.children.splice(page.children.indexOf(row), 1);
  }
  for (let i = 0; i < spec.texts.length; i++) {
    page.addRow(spec.texts[i], spec.heights[i]);
  }
}

function rowByText(page: ReturnType<typeof layoutTranscript>, text: string) {
  return page.children.find((row) => row.id !== "welcome" && row.bodyText === text);
}

describe("cached view scroll across host replay", () => {
  it("keeps the stored scrollTop when they scrolled the cache", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    userScrollTo(fns, page.messages, 100);
    expect(page.messages.scrollTop).toBe(100);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(100);
  });

  it("lands at the bottom when the cache was painted and the reader did not scroll", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    replayRows(page, {
      texts: ["one", "two", "three", "four", "five"],
      heights: [100, 100, 100, 100, 100],
    });
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(page.messages.scrollHeight - page.messages.clientHeight);
  });

  it("stays at the bottom when replay brings new messages", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six", "seven"],
      heights: [100, 100, 100, 100, 100, 100, 100],
    });
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(page.messages.scrollHeight - page.messages.clientHeight);
    const newest = rowByText(page, "seven");
    expect(newest).toBeTruthy();
    const rect = newest!.getBoundingClientRect();
    expect(rect.bottom).toBeLessThanOrEqual(page.messages.clientHeight + 1);
    expect(rect.top).toBeLessThan(page.messages.clientHeight);
  });

  it("settle without a user scroll does not move the view", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    const top = page.messages.scrollTop;
    expect(fns.settleCachedViewScroll()).toBe(false);
    expect(page.messages.scrollTop).toBe(top);
  });

  it("does not treat a programmatic paint scroll as the reader moving", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    fns.armCachedViewScroll();
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(fns.userScrolled()).toBe(false);
    userScrollTo(fns, page.messages, 50);
    expect(fns.userScrolled()).toBe(true);
  });

  it("a stick-to-bottom yank during the same touch does not eat the stored scrollTop", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    fns.noteCachedViewUserIntent();
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(fns.holdPlace()).toBe(false);

    page.messages.scrollTop = 100;
    fns.onCachedViewScroll();
    expect(fns.holdPlace()).toBe(true);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(100);
  });

  it("a yank after the reader has left the bottom is undone immediately, through replay", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    userScrollTo(fns, page.messages, 100);

    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(page.messages.scrollTop).toBe(100);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(page.messages.scrollTop).toBe(100);
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(100);
  });

  it("keeps the held scrollTop through a second replay after the first has settled", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    userScrollTo(fns, page.messages, 100);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(fns.settleCachedViewScroll()).toBe(true);
    expect(fns.live()).toBe(true);
    expect(page.messages.scrollTop).toBe(100);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six", "seven"],
      heights: [100, 100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(page.messages.scrollTop).toBe(100);
    fns.applyRestoreScroll();
    expect(fns.live()).toBe(false);
    expect(page.messages.scrollTop).toBe(100);
  });

  it("a gesture that leaves the reader at the bottom still lands on new messages", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.armCachedViewScroll();
    userScrollTo(fns, page.messages, 80);
    userScrollTo(fns, page.messages, page.messages.scrollHeight);
    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    pinToBottom(page.messages);
    fns.applyRestoreScroll();
    expect(page.messages.scrollTop).toBe(page.messages.scrollHeight - page.messages.clientHeight);
    const newest = rowByText(page, "arrived-while-away");
    expect(newest!.getBoundingClientRect().bottom).toBeLessThanOrEqual(page.messages.clientHeight + 1);
  });

  it("restores by scrollTop, with no text matching left", () => {
    expect(html).not.toContain("rowAnchorKey");
    expect(html).not.toContain("findTranscriptRowByKey");
    expect(html).not.toContain("captureTranscriptScrollAnchor");
    expect(html).not.toContain("restoreTranscriptScrollAnchor");
    expect(html).not.toContain("resolveCachedViewSentinel");
    expect(html).not.toContain("cachedViewAnchor");
    expect(scrollSrc).toContain("cachedViewScrollTop");
    expect(scrollSrc).toContain("messagesEl.scrollTop");
    expect(scrollSrc).not.toContain("setTimeout");
    expect(scrollSrc).not.toContain("sessionStorage");
    const applyCachedSrc = html.slice(
      html.indexOf("function applyCachedTranscriptScroll"),
      html.indexOf("function clearCachedViewScroll()"),
    );
    expect(applyCachedSrc).toContain("cachedViewHoldPlace = true");
    expect(applyCachedSrc).toContain("scroll.top");
    expect(applyCachedSrc).not.toContain("key");
    const applyCacheSrc = html.slice(
      html.indexOf("function applyTranscriptCache"),
      html.indexOf("function publishCachedSessionName"),
    );
    expect(applyCacheSrc.indexOf("while (holder.firstChild)"))
      .toBeLessThan(applyCacheSrc.indexOf("applyCachedTranscriptScroll"));
  });

  it("scrolled-up restore lands at the stored scrollTop", () => {
    const live = layoutTranscript({ texts: ["Done", "Yes", "Done", "Yes", "Done"] });
    const liveFns = loadScrollFns(live.messages);
    pinToBottom(live.messages);
    liveFns.armCachedViewScroll();
    userScrollTo(liveFns, live.messages, 100);
    expect(live.messages.scrollTop).toBe(100);
    const stored = liveFns.snapshotTranscriptScroll(live.messages);
    expect(stored).toEqual({ atBottom: false, top: 100 });

    const reload = layoutTranscript({ texts: ["Done", "Yes", "Done", "Yes", "Done"] });
    const reloadFns = loadScrollFns(reload.messages);
    reload.atBottomHistory.length = 0;
    reloadFns.applyCachedTranscriptScroll(reload.messages, stored);
    expect(reload.messages.scrollTop).toBe(100);
    expect(reloadFns.holdPlace()).toBe(true);
    expect(reloadFns.gesturePending()).toBe(false);
    expect(isFlushBottom(reload.messages)).toBe(false);
    expect(reload.atBottomHistory.some(Boolean)).toBe(false);

    hostYankToBottom(reloadFns, reload.messages);
    expect(reload.messages.scrollTop).toBe(100);
    expect(isFlushBottom(reload.messages)).toBe(false);

    replayRows(reload, {
      texts: ["Done", "Yes", "Done", "Yes", "Done", "later"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    hostYankToBottom(reloadFns, reload.messages);
    expect(reload.messages.scrollTop).toBe(100);
    reloadFns.applyRestoreScroll();
    expect(reload.messages.scrollTop).toBe(100);
  });

  it("at-bottom cache: bottom throughout, and replayed new messages are visible", () => {
    const live = layoutTranscript();
    const liveFns = loadScrollFns(live.messages);
    pinToBottom(live.messages);
    liveFns.armCachedViewScroll();
    const stored = liveFns.snapshotTranscriptScroll(live.messages);
    expect(stored).toEqual({ atBottom: true });

    const reload = layoutTranscript();
    const reloadFns = loadScrollFns(reload.messages);
    reloadFns.applyCachedTranscriptScroll(reload.messages, stored);
    expect(isFlushBottom(reload.messages)).toBe(true);
    expect(reloadFns.holdPlace()).toBe(false);
    expect(reloadFns.gesturePending()).toBe(false);

    hostYankToBottom(reloadFns, reload.messages);
    expect(isFlushBottom(reload.messages)).toBe(true);
    expect(reloadFns.holdPlace()).toBe(false);

    replayRows(reload, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    hostYankToBottom(reloadFns, reload.messages);
    reloadFns.applyRestoreScroll();
    expect(isFlushBottom(reload.messages)).toBe(true);
    expect(reloadFns.holdPlace()).toBe(false);
    const newest = rowByText(reload, "arrived-while-away");
    expect(newest).toBeTruthy();
    expect(newest!.getBoundingClientRect().bottom).toBeLessThanOrEqual(reload.messages.clientHeight + 1);
  });

  it("a gesture after a restored position is what survives the replay", () => {
    const live = layoutTranscript();
    const liveFns = loadScrollFns(live.messages);
    pinToBottom(live.messages);
    liveFns.armCachedViewScroll();
    userScrollTo(liveFns, live.messages, 100);
    const stored = liveFns.snapshotTranscriptScroll(live.messages);
    expect(stored).toEqual({ atBottom: false, top: 100 });

    const reload = layoutTranscript({
      texts: ["one", "two", "three", "four", "five", "six", "seven"],
    });
    const reloadFns = loadScrollFns(reload.messages);
    reloadFns.applyCachedTranscriptScroll(reload.messages, stored);
    expect(reload.messages.scrollTop).toBe(100);

    userScrollTo(reloadFns, reload.messages, 200);
    expect(reload.messages.scrollTop).toBe(200);
    expect(reloadFns.holdPlace()).toBe(true);

    replayRows(reload, {
      texts: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
      heights: [100, 100, 100, 100, 100, 100, 100, 100],
    });
    hostYankToBottom(reloadFns, reload.messages);
    reloadFns.applyRestoreScroll();
    expect(reload.messages.scrollTop).toBe(200);
  });

  it("snapshot replay, identity confirms, then a resumeSession replay: the place survives all of it", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    expect(page.messages.scrollTop).toBe(100);

    snapshotReplayThenIdentity(fns, page);
    expect(fns.live()).toBe(true);
    expect(page.messages.scrollTop).toBe(100);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six", "seven"],
      heights: [100, 100, 100, 100, 100, 100, 100],
    });
    resumeSessionReplay(fns, page);
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.live()).toBe(false);
    expect(fns.pendingResume()).toBe(false);
  });

  it("a restore with only one replay still settles once identity confirms", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    fns.notePendingResumeReplay();
    fns.noteConnectSnapshot({ type: "initialState" });
    fns.noteConnectSnapshot({ type: "setBusy" });
    fns.noteIdentityReplay({ type: "historyReplay", active: true });
    hostYankToBottom(fns, page.messages);
    fns.noteIdentityReplay({ type: "historyReplay", active: false });
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.live()).toBe(true);

    fns.noteConnectSnapshot({ type: "sessions" });
    fns.finishIdentity();
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.live()).toBe(false);
  });

  it("a restore with no historyReplay settles when identity confirms", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    fns.notePendingResumeReplay();
    fns.noteConnectSnapshot({ type: "initialState" });
    fns.noteConnectSnapshot({ type: "setBusy" });
    fns.noteConnectSnapshot({ type: "sessions" });
    fns.finishIdentity();
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.live()).toBe(false);
  });

  it("a gesture during the window still wins and ends the lock", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    snapshotReplayThenIdentity(fns, page);
    expect(fns.live()).toBe(true);

    userScrollTo(fns, page.messages, 50);
    expect(page.messages.scrollTop).toBe(50);
    expect(fns.holdPlace()).toBe(true);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    resumeSessionReplay(fns, page);
    expect(page.messages.scrollTop).toBe(50);
    expect(fns.live()).toBe(false);

    const bottom = layoutTranscript();
    const bottomFns = heldRestore(bottom, 80);
    snapshotReplayThenIdentity(bottomFns, bottom);
    userScrollTo(bottomFns, bottom.messages, bottom.messages.scrollHeight);
    expect(bottomFns.holdPlace()).toBe(false);
    replayRows(bottom, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    resumeSessionReplay(bottomFns, bottom);
    expect(isFlushBottom(bottom.messages)).toBe(true);
    expect(bottomFns.live()).toBe(false);
  });

  it("the scroll-to-bottom button still works once the restore is over", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    snapshotReplayThenIdentity(fns, page);
    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "six"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    resumeSessionReplay(fns, page);
    expect(fns.live()).toBe(false);
    expect(page.messages.scrollTop).toBe(100);

    hostYankToBottom(fns, page.messages);
    expect(isFlushBottom(page.messages)).toBe(true);
  });

  it("at-bottom restore stays at the bottom across snapshot then resumeSession replay", () => {
    const live = layoutTranscript();
    const liveFns = loadScrollFns(live.messages);
    pinToBottom(live.messages);
    liveFns.armCachedViewScroll();
    const stored = liveFns.snapshotTranscriptScroll(live.messages);
    expect(stored).toEqual({ atBottom: true });

    const reload = layoutTranscript();
    const reloadFns = loadScrollFns(reload.messages);
    reloadFns.applyCachedTranscriptScroll(reload.messages, stored);
    reloadFns.setIdentityTarget({ id: "s1" });
    expect(isFlushBottom(reload.messages)).toBe(true);
    expect(reloadFns.holdPlace()).toBe(false);

    snapshotReplayThenIdentity(reloadFns, reload);
    expect(isFlushBottom(reload.messages)).toBe(true);

    replayRows(reload, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    resumeSessionReplay(reloadFns, reload);
    expect(isFlushBottom(reload.messages)).toBe(true);
    expect(reloadFns.live()).toBe(false);
    const newest = rowByText(reload, "arrived-while-away");
    expect(newest).toBeTruthy();
    expect(newest!.getBoundingClientRect().bottom).toBeLessThanOrEqual(reload.messages.clientHeight + 1);
  });

  it("restore resumeSession arms the lock on the send, not a timer", () => {
    expect(sendResumeSrc).toContain("notePendingResumeReplay()");
    expect(sendResumeSrc).toContain("armIdentityFailTimer()");
    expect(scrollSrc).toContain("pendingResumeReplay");
    expect(scrollSrc).not.toContain("setTimeout");
    expect(connectSrc.indexOf("noteConnectSnapshot(data)"))
      .toBeLessThan(connectSrc.indexOf("maybeFinishIdentityRestore(data)"));
    expect(connectSrc.indexOf("maybeFinishIdentityRestore(data)"))
      .toBeLessThan(connectSrc.indexOf("noteIdentityReplay(data)"));
  });

  it("a sessions frame after identity ends the lock when resumeSession does not replay", () => {
    const page = layoutTranscript();
    const fns = heldRestore(page, 100);
    snapshotReplayThenIdentity(fns, page);
    expect(fns.live()).toBe(true);
    expect(fns.pendingResume()).toBe(true);

    fns.noteConnectSnapshot({ type: "sessions" });
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.live()).toBe(false);
    expect(fns.pendingResume()).toBe(false);
  });

  it("reload cache paint never calls applyRestoreScroll — a reader who moved is held by the cached-view path", () => {
    expect(beginRestoreSrc.indexOf("restoreRenderedTranscript()"))
      .toBeLessThan(beginRestoreSrc.indexOf("transcriptHasConversation()"));
    const revealSrc = html.slice(
      html.indexOf("function revealRestoredTranscript()"),
      html.indexOf("function noteIdentityReplay(data)"),
    );
    expect(revealSrc).not.toContain("applyRestoreScroll");
    const finishSrc = html.slice(
      html.indexOf("function finishIdentityRestore()"),
      html.indexOf("function abandonIdentityRestore("),
    );
    expect(finishSrc).toContain("maybeFinishCachedViewScroll()");
    expect(html.slice(
      html.indexOf("function liftIdentityRestoreVeil()"),
      html.indexOf("function revealRestoredTranscript()"),
    )).toContain("applyRestoreScroll()");
    const applyCallers = html.split("applyRestoreScroll()");
    expect(applyCallers.length).toBe(3);
  });

  it("restoring a scrolled-up place clears the renderer pin: a subsequent scrollport height change does NOT move the view", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    expect(page.stickToBottom).toBe(true);

    fns.applyCachedTranscriptScroll(page.messages, { atBottom: false, top: 100 });
    expect(page.messages.scrollTop).toBe(100);
    expect(page.stickToBottom).toBe(false);

    const top = page.messages.scrollTop;
    page.resizeScrollport(180);
    expect(page.messages.scrollTop).toBe(top);
    expect(page.stickToBottom).toBe(false);

    // Replay yank then settle — the phone sequence. Restore must leave
    // the pin clear so the next height change does not re-pin.
    pinToBottom(page.messages);
    fns.onCachedViewScroll();
    expect(page.messages.scrollTop).toBe(100);
    expect(fns.settleCachedViewScroll()).toBe(true);
    expect(page.messages.scrollTop).toBe(100);
    expect(page.stickToBottom).toBe(false);
    page.resizeScrollport(220);
    expect(page.messages.scrollTop).toBe(100);
  });

  it("restoring an at-bottom place leaves the pin set: a height change still follows the bottom, and replayed messages stay visible", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    expect(page.stickToBottom).toBe(true);

    fns.applyCachedTranscriptScroll(page.messages, { atBottom: true });
    expect(isFlushBottom(page.messages)).toBe(true);
    expect(page.stickToBottom).toBe(true);
    expect(page.pointerDownTargets).toEqual([]);

    page.resizeScrollport(180);
    expect(isFlushBottom(page.messages)).toBe(true);
    expect(page.stickToBottom).toBe(true);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    if (page.stickToBottom) page.messages.scrollTop = page.messages.scrollHeight;
    expect(isFlushBottom(page.messages)).toBe(true);
    const newest = rowByText(page, "arrived-while-away");
    expect(newest).toBeTruthy();
    expect(newest!.getBoundingClientRect().bottom).toBeLessThanOrEqual(page.messages.clientHeight + 1);
  });

  it("a genuine gesture after the restore still behaves as today", () => {
    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.applyCachedTranscriptScroll(page.messages, { atBottom: false, top: 100 });
    expect(page.stickToBottom).toBe(false);

    page.rendererGesture("wheel");
    userScrollTo(fns, page.messages, 50);
    expect(page.messages.scrollTop).toBe(50);
    expect(page.stickToBottom).toBe(false);
    expect(fns.holdPlace()).toBe(true);

    page.rendererGesture("wheel");
    userScrollTo(fns, page.messages, page.messages.scrollHeight);
    expect(isFlushBottom(page.messages)).toBe(true);
    expect(page.stickToBottom).toBe(true);
    expect(fns.holdPlace()).toBe(false);

    replayRows(page, {
      texts: ["one", "two", "three", "four", "five", "arrived-while-away"],
      heights: [100, 100, 100, 100, 100, 100],
    });
    if (page.stickToBottom) page.messages.scrollTop = page.messages.scrollHeight;
    expect(isFlushBottom(page.messages)).toBe(true);
    const newest = rowByText(page, "arrived-while-away");
    expect(newest!.getBoundingClientRect().bottom).toBeLessThanOrEqual(page.messages.clientHeight + 1);

    const away = layoutTranscript();
    const awayFns = loadScrollFns(away.messages);
    pinToBottom(away.messages);
    awayFns.applyCachedTranscriptScroll(away.messages, { atBottom: true });
    expect(away.stickToBottom).toBe(true);
    away.rendererGesture("pointerdown", away.messages);
    userScrollTo(awayFns, away.messages, 80);
    expect(away.messages.scrollTop).toBe(80);
    expect(away.stickToBottom).toBe(false);
  });

  it("the dispatch targets the scrollport itself, as the renderer's listener requires", () => {
    const chatJs = readFileSync(new URL("../web/vendor/media/chat.js", import.meta.url), "utf8");
    expect(chatJs).toContain("if (e.target === messagesEl) noteUserScrollIntent()");

    const signalSrc = html.slice(
      html.indexOf("function signalUserScrollToRenderer"),
      html.indexOf("function noteCachedViewUserIntent"),
    );
    expect(signalSrc).toContain("messagesEl.dispatchEvent(new Event(\"pointerdown\"");
    expect(signalSrc).not.toContain("new Event(\"scroll\")");

    const page = layoutTranscript();
    const fns = loadScrollFns(page.messages);
    pinToBottom(page.messages);
    fns.applyCachedTranscriptScroll(page.messages, { atBottom: false, top: 100 });
    expect(page.pointerDownTargets.length).toBeGreaterThan(0);
    expect(page.pointerDownTargets.every((t) => t === page.messages)).toBe(true);

    const childPage = layoutTranscript();
    pinToBottom(childPage.messages);
    expect(childPage.stickToBottom).toBe(true);
    const child = childPage.children[1];
    childPage.rendererGesture("pointerdown", child);
    childPage.messages.scrollTop = 100;
    expect(childPage.stickToBottom).toBe(true);
  });
});
