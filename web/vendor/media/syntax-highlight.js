// A small, dependency-free syntax highlighter for the file panel.
//
// WHY HAND-ROLLED. Everything this renders runs under a strict CSP — the VS
// Code webview, the Electron app, and the relay's browser client all forbid
// remote script. A CDN highlighter is simply not loadable, and vendoring
// Prism/highlight.js would put ~200KB of someone else's parser inside the vsix
// and inside every phone page load, to colour files people are mostly skimming.
// This is deliberately a SCANNABILITY tool, not a compiler: it wants comments
// to recede and strings/keywords to separate, and it accepts being approximate
// at the edges (a regex in JS, a nested template literal, SQL inside a string).
// If it is ever wrong the cost is a miscoloured token, never a wrong byte —
// nothing here feeds what gets saved.
//
// SAFETY. The only thing that is not negotiable: every character of source is
// HTML-escaped before it reaches the DOM. `highlightCode` returns markup, so it
// is the one function in this file that could turn a file's contents into
// script if it were sloppy. Text is escaped on BOTH paths — inside a token and
// between tokens — and the tests pin it.
//
// RULE AUTHORS: every rule regex must use NON-capturing groups `(?:…)` only.
// Rules are combined into one alternation and the matching rule is identified
// by its group index, so a stray capturing group silently shifts every token
// type after it. `test/syntax-highlight.test.ts` asserts this mechanically.
(function (root) {
  "use strict";

  /** Files above this are painted as plain text. The panel already caps a
   *  preview at 2MB; running seven alternating regexes over that much source on
   *  the UI thread is what a phone would feel, so the highlighter opts out long
   *  before the viewer does. */
  const MAX_HIGHLIGHT_BYTES = 256 * 1024;

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------- language resolution ----------

  // Extension → language id. Deliberately a superset of what the panel will
  // preview: resolving a language is free, and the viewer decides separately
  // whether a file opens in-panel at all.
  const LANG_BY_EXT = {
    js: "js", mjs: "js", cjs: "js", jsx: "js",
    ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
    java: "java", c: "c", h: "c", cpp: "c", cc: "c", cxx: "c", hpp: "c", hh: "c",
    cs: "cs", go: "go", rs: "rust", swift: "swift", kt: "kotlin", kts: "kotlin",
    php: "php", dart: "dart", scala: "scala", groovy: "groovy",
    py: "py", pyi: "py", pyw: "py",
    rb: "rb", erb: "rb",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh", bat: "sh", cmd: "sh",
    ps1: "ps1", psm1: "ps1", psd1: "ps1",
    yml: "yaml", yaml: "yaml",
    toml: "toml", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "ini",
    json: "json", jsonc: "json",
    sql: "sql",
    css: "css", scss: "css", sass: "css", less: "css", styl: "css",
    html: "markup", htm: "markup", xhtml: "markup", xml: "markup", svg: "markup",
    vue: "markup", svelte: "markup",
    diff: "diff", patch: "diff",
  };

  // Extensionless names that are real languages. Matched case-insensitively on
  // the basename, which is why `Dockerfile` and `Makefile` work at all.
  const LANG_BY_NAME = {
    dockerfile: "sh", containerfile: "sh", makefile: "make", gnumakefile: "make",
    ".env": "ini", ".gitignore": "ini", ".gitattributes": "ini", ".editorconfig": "ini",
    ".bashrc": "sh", ".zshrc": "sh", ".profile": "sh",
  };

  /** Language id for a path, or "" when we have no ruleset for it (the caller
   *  then paints plain escaped text — never a guess). */
  function languageForPath(pathStr) {
    if (typeof pathStr !== "string" || !pathStr) return "";
    const base = (pathStr.split(/[\\/]/).pop() || "").toLowerCase();
    if (!base) return "";
    if (Object.prototype.hasOwnProperty.call(LANG_BY_NAME, base)) return LANG_BY_NAME[base];
    const dot = base.lastIndexOf(".");
    // A leading-dot name like `.env` is a NAME, not an extension — handled above.
    if (dot <= 0) return "";
    const ext = base.slice(dot + 1);
    return Object.prototype.hasOwnProperty.call(LANG_BY_EXT, ext) ? LANG_BY_EXT[ext] : "";
  }

  // ---------- keywords ----------

  const words = (list) => list.trim().split(/\s+/);

  const KEYWORDS = {
    js: words(`
      as async await break case catch class const continue debugger default delete do else
      export extends finally for from function get if import in instanceof let new of return
      set static super switch this throw try typeof var void while with yield
      true false null undefined NaN Infinity
    `),
    ts: words(`
      abstract as async await break case catch class const continue declare default delete do
      else enum export extends finally for from function get if implements import in infer
      instanceof interface is keyof let namespace new of private protected public readonly
      return satisfies set static super switch this throw try type typeof var void while yield
      true false null undefined any never unknown string number boolean object symbol bigint
    `),
    java: words(`
      abstract assert boolean break byte case catch char class const continue default do double
      else enum extends final finally float for goto if implements import instanceof int
      interface long native new package private protected public return short static strictfp
      super switch synchronized this throw throws transient try void volatile while var
      true false null
    `),
    c: words(`
      auto break case char const continue default do double else enum extern float for goto if
      inline int long register restrict return short signed sizeof static struct switch typedef
      union unsigned void volatile while class namespace template typename public private
      protected virtual override final new delete this nullptr true false using constexpr
      include define ifdef ifndef endif pragma
    `),
    cs: words(`
      abstract as base bool break byte case catch char checked class const continue decimal
      default delegate do double else enum event explicit extern finally fixed float for foreach
      goto if implicit in int interface internal is lock long namespace new object operator out
      override params private protected public readonly ref return sbyte sealed short sizeof
      stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe
      ushort using var virtual void volatile while async await true false null
    `),
    go: words(`
      break case chan const continue default defer else fallthrough for func go goto if import
      interface map package range return select struct switch type var
      bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune
      string uint uint8 uint16 uint32 uint64 uintptr true false nil iota make new len cap append
    `),
    rust: words(`
      as async await break const continue crate dyn else enum extern false fn for if impl in let
      loop match mod move mut pub ref return self Self static struct super trait true type unsafe
      use where while bool char f32 f64 i8 i16 i32 i64 i128 isize str u8 u16 u32 u64 u128 usize
      String Vec Option Some None Result Ok Err
    `),
    swift: words(`
      associatedtype class deinit enum extension fileprivate func import init inout internal let
      open operator private protocol public rethrows static struct subscript typealias var break
      case continue default defer do else fallthrough for guard if in repeat return switch where
      while as Any catch false is nil super self Self throw throws true try
    `),
    kotlin: words(`
      as break by catch class companion const constructor continue crossinline data delegate do
      dynamic else enum external false final finally for fun get if import in infix init inline
      interface internal is lateinit noinline null object open operator out override package
      private protected public reified return sealed set super suspend this throw true try
      typealias val var vararg when where while
    `),
    php: words(`
      abstract and array as break callable case catch class clone const continue declare default
      do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends
      final finally fn for foreach function global goto if implements include include_once
      instanceof insteadof interface isset list match namespace new or print private protected
      public readonly require require_once return static switch throw trait try unset use var
      while xor yield true false null
    `),
    dart: words(`
      abstract as assert async await break case catch class const continue covariant default
      deferred do dynamic else enum export extends extension external factory false final finally
      for get hide if implements import in interface is late library mixin new null on operator
      part required rethrow return set show static super switch sync this throw true try typedef
      var void while with yield
    `),
    scala: words(`
      abstract case catch class def do else extends false final finally for forSome if implicit
      import lazy match new null object override package private protected return sealed super
      this throw trait try true type val var while with yield
    `),
    groovy: words(`
      as assert break case catch class const continue def default do else enum extends false
      finally for goto if implements import in instanceof interface new null package return
      static super switch this throw throws trait true try while
    `),
    py: words(`
      and as assert async await break class continue def del elif else except finally for from
      global if import in is lambda nonlocal not or pass raise return try while with yield
      True False None self cls print len range int str float bool list dict set tuple
    `),
    rb: words(`
      alias and begin break case class def defined do else elsif end ensure false for if in
      module next nil not or redo rescue retry return self super then true undef unless until
      when while yield require require_relative attr_accessor attr_reader attr_writer puts
    `),
    sh: words(`
      if then else elif fi case esac for while until do done in function select time coproc
      return break continue exit export local readonly declare typeset unset shift source alias
      set trap eval exec echo cd pwd test true false
    `),
    ps1: words(`
      if elseif else switch foreach for while do until break continue return function filter
      workflow param begin process end try catch finally throw trap class enum using in
      Write-Output Write-Host Get-ChildItem Set-Location New-Item Remove-Item Test-Path
      true false null
    `),
    make: words(`
      ifeq ifneq ifdef ifndef else endif define endef include export unexport override
      vpath
    `),
    sql: words(`
      add all alter and any as asc begin between by cascade case cast check column commit
      constraint create cross current_date current_time current_timestamp database default
      delete desc distinct drop else end except exists foreign from full grant group having if
      in index inner insert intersect into is join key left like limit not null offset on or
      order outer primary references rename replace return revoke right rollback select set
      table then to transaction trigger truncate union unique update using values view when
      where with array bigint boolean char date decimal double float int integer json jsonb
      numeric real serial smallint text time timestamp uuid varchar
    `),
  };

  // ---------- rule shapes ----------

  // Shared fragments. Each is a complete, self-contained NON-capturing pattern.
  // End of INPUT. Not `$`: every ruleset compiles with the `m` flag (so `^` can
  // anchor line-oriented rules like YAML keys and diff markers), and under `m`
  // a `$` means end of LINE — which made an unterminated `/*` stop at the first
  // newline and paint the rest of a commented-out file as live code.
  const EOI = `(?![\\s\\S])`;
  // THE CLOSING QUOTE IS OPTIONAL, and that is a performance decision before it
  // is a rendering one. With it mandatory, an unterminated quote makes the match
  // FAIL, so the scanner retries at the next quote, and the next — each one
  // scanning to end of input. Measured: the same 60KB blob took 1638ms with its
  // final quote missing and 4ms with it present, and the curve is quadratic, so
  // a file at MAX_HIGHLIGHT_BYTES freezes the UI thread for ~30s. Optional, the
  // match always succeeds on the first (maximal) attempt, so there is no
  // backtracking at all — and colouring an unterminated string to the end is
  // what every real editor does anyway.
  //
  // The body of an ordinary string also stops at a newline. That is a TRADE,
  // taken deliberately: with the close optional, a lone quote would otherwise
  // tint the rest of the FILE, and lone quotes are common — a contraction in a
  // YAML or INI value (`msg: don't panic`), an apostrophe in shell, a `/can't/`
  // regex. Stopping at the newline bounds every one of those to its own line.
  // What it costs is the reverse case: shell, SQL, YAML, Ruby and PowerShell
  // all permit a quoted value to span physical lines, and those literals are
  // split, with the closing quote able to open a false string for the rest of
  // ITS line. Both are miscolourings and neither touches a byte that is saved;
  // the bounded one is chosen because contractions are far more common than
  // multi-line literals, and because a mistake confined to one line is one the
  // eye corrects for free. Escapes still consume any character, so a deliberate
  // line continuation keeps working, and template literals genuinely span lines
  // so only they take `[\s\S]`.
  const DQ_STRING = `"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"?`;
  const SQ_STRING = `'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'?`;
  const TICK_STRING = "`(?:\\\\[\\s\\S]|[^`\\\\])*`?";
  const NUMBER = `\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b`;
  const SLASH_COMMENT = `\\/\\/[^\\n]*`;
  const BLOCK_COMMENT = `\\/\\*[\\s\\S]*?(?:\\*\\/|${EOI})`;
  const HASH_COMMENT = `#[^\\n]*`;
  const DASH_COMMENT = `--[^\\n]*`;

  /** Word-boundary alternation for a keyword list. Longest-first so `constructor`
   *  is not eaten as `const` + `ructor`. */
  function keywordPattern(list) {
    const escaped = [...list]
      .sort((a, b) => b.length - a.length)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return `\\b(?:${escaped.join("|")})\\b`;
  }

  /** C-family shape: line + block comments, three string forms, numbers,
   *  keywords, capitalised identifiers as types, `name(` as calls. */
  function clikeRules(lang) {
    return [
      { type: "com", re: `${SLASH_COMMENT}|${BLOCK_COMMENT}` },
      { type: "str", re: `${TICK_STRING}|${DQ_STRING}|${SQ_STRING}` },
      { type: "num", re: NUMBER },
      { type: "kw", re: keywordPattern(KEYWORDS[lang] || KEYWORDS.js) },
      { type: "typ", re: `\\b[A-Z][A-Za-z0-9_]*\\b` },
      { type: "fn", re: `\\b[A-Za-z_$][\\w$]*(?=\\s*\\()` },
    ];
  }

  /** `#`-comment shape, for the scripting/config half of the world. */
  function hashRules(lang) {
    return [
      { type: "com", re: HASH_COMMENT },
      // Python's triple quotes first, or the pair would close on the inner one.
      { type: "str", re: `"""[\\s\\S]*?(?:"""|${EOI})|'''[\\s\\S]*?(?:'''|${EOI})|${DQ_STRING}|${SQ_STRING}` },
      { type: "num", re: NUMBER },
      { type: "kw", re: keywordPattern(KEYWORDS[lang] || KEYWORDS.sh) },
      { type: "fn", re: `\\b[A-Za-z_][\\w]*(?=\\s*\\()` },
    ];
  }

  const RULES = {
    json: [
      // A key is a string followed by a colon — the only structure JSON has,
      // and the one thing worth seeing at a glance when scanning config.
      { type: "prop", re: `${DQ_STRING}(?=\\s*:)` },
      { type: "str", re: DQ_STRING },
      { type: "num", re: `-?${NUMBER}` },
      { type: "kw", re: `\\b(?:true|false|null)\\b` },
    ],
    yaml: [
      { type: "com", re: HASH_COMMENT },
      // Anchored to the line so a colon inside prose is not a key.
      { type: "prop", re: `^[ \\t]*(?:- )?[A-Za-z_][\\w.-]*(?=\\s*:)` },
      { type: "str", re: `${DQ_STRING}|${SQ_STRING}` },
      { type: "num", re: NUMBER },
      { type: "kw", re: `\\b(?:true|false|null|yes|no|on|off|~)\\b` },
    ],
    toml: [
      { type: "com", re: HASH_COMMENT },
      { type: "typ", re: `^[ \\t]*\\[{1,2}[^\\]\\n]*\\]{1,2}` },
      { type: "prop", re: `^[ \\t]*[A-Za-z_][\\w.-]*(?=\\s*=)` },
      { type: "str", re: `"""[\\s\\S]*?(?:"""|${EOI})|${DQ_STRING}|${SQ_STRING}` },
      { type: "num", re: NUMBER },
      { type: "kw", re: `\\b(?:true|false)\\b` },
    ],
    ini: [
      { type: "com", re: `[#;][^\\n]*` },
      { type: "typ", re: `^[ \\t]*\\[[^\\]\\n]*\\]` },
      { type: "prop", re: `^[ \\t]*[A-Za-z_.][\\w.-]*(?=\\s*=)` },
      { type: "str", re: `${DQ_STRING}|${SQ_STRING}` },
      { type: "num", re: NUMBER },
    ],
    sql: [
      { type: "com", re: `${DASH_COMMENT}|${BLOCK_COMMENT}` },
      // SQL strings are single-quoted; a double-quoted run is a quoted
      // IDENTIFIER, which reads better as a property than as a string.
      { type: "str", re: SQ_STRING },
      { type: "prop", re: DQ_STRING },
      { type: "num", re: NUMBER },
      { type: "kw", re: `(?:${keywordPattern(KEYWORDS.sql)})`, flags: "i" },
      { type: "fn", re: `\\b[A-Za-z_][\\w]*(?=\\s*\\()` },
    ],
    css: [
      { type: "com", re: BLOCK_COMMENT },
      { type: "str", re: `${DQ_STRING}|${SQ_STRING}` },
      { type: "kw", re: `@[A-Za-z-]{1,64}` },
      // BOUNDED ON PURPOSE, and the bound is load-bearing rather than tidy.
      // Unlike every other lookahead rule here this one has no `\b` to anchor
      // it, so it is attempted at EVERY position; unbounded, each attempt
      // consumes to end-of-file and then backtracks one character at a time,
      // which is quadratic. Measured before the cap: 40KB took 2.3s, 80KB 45s,
      // 160KB 201s — all inside MAX_HIGHLIGHT_BYTES, all on the UI thread. No
      // CSS property is 64 characters long. See the perf test.
      { type: "prop", re: `[A-Za-z-]{1,64}(?=\\s*:)` },
      // The two branches are disjoint and the digit runs are bounded, and both
      // properties are load-bearing. This was written `-?\d*\.?\d+…`, where
      // `\d*` and `\d+` overlap: for a run of digits followed by anything that
      // fails the tail, the engine can split the run at every position, and it
      // tries all of them. Measured on that version — on a TWO KILOBYTE input,
      // far below every limit here: 500 digits 1.2s, 1500 digits 2.7s, 2000
      // digits 12.8s. Worse than the quadratic rules, and reachable from a
      // stylesheet holding one long number.
      { type: "num", re: `#[0-9a-fA-F]{3,8}\\b|-?(?:\\d{1,20}(?:\\.\\d{1,20})?|\\.\\d{1,20})(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\\b` },
      { type: "typ", re: `[.#][A-Za-z_-][\\w-]*|::?[a-z-]+` },
    ],
    markup: [
      { type: "com", re: `<!--[\\s\\S]*?(?:-->|${EOI})` },
      // A whole tag is one token so its inner attributes cannot be mistaken for
      // document text; the pieces are re-scanned by the nested pass below.
      // Bounded for the same reason as the CSS rule above: an unclosed `<` runs
      // `[^>]*` to end of input and backtracks, once per `<` in the file.
      //
      // The bound is 512 rather than something roomier because the cost is
      // O(n x bound) even when bounded — at 4096 a 90KB file of unclosed tags
      // took 2s, which is the same order as the bug this replaced. What it buys
      // is a tag longer than 512 characters (a large inline SVG `path d="…"`)
      // rendering as plain text instead of a coloured tag. That is the right
      // way round: the panel opens `.svg` as an IMAGE anyway, so it is only
      // reachable inside HTML/XML, and a missed colour costs nothing while a
      // two-second freeze costs the frame.
      { type: "tag", re: `<\\/?[A-Za-z][^>]{0,512}>|<!DOCTYPE[^>]{0,512}>` },
    ],
    diff: [
      { type: "com", re: `^(?:diff |index |--- |\\+\\+\\+ )[^\\n]*` },
      { type: "typ", re: `^@@[^\\n]*` },
      { type: "add", re: `^\\+[^\\n]*` },
      { type: "del", re: `^-[^\\n]*` },
    ],
    make: [
      { type: "com", re: HASH_COMMENT },
      // Special targets are matched by their own rule, not through the keyword
      // list: `keywordPattern` wraps every word in `\b…\b`, and a leading `\b`
      // before `.PHONY`'s dot demands a word character to its left, so it could
      // never match at the start of a line — which is the only place it appears.
      { type: "kw", re: `^\\.[A-Z_]+\\b` },
      { type: "prop", re: `^[A-Za-z_.][\\w.-]*(?=\\s*:(?!=))` },
      { type: "str", re: `${DQ_STRING}|${SQ_STRING}` },
      { type: "kw", re: keywordPattern(KEYWORDS.make) },
    ],
  };

  for (const lang of ["js", "ts", "java", "c", "cs", "go", "rust", "swift", "kotlin", "php", "dart", "scala", "groovy"]) {
    RULES[lang] = clikeRules(lang);
  }
  for (const lang of ["py", "rb", "sh", "ps1"]) {
    RULES[lang] = hashRules(lang);
  }

  // Host / VS Code language ids → highlighter ids. Unknown stays "" so the
  // caller paints escaped text rather than guessing a ruleset.
  const LANG_BY_ID = {
    powershell: "ps1", shellscript: "sh", bat: "sh", cmd: "sh",
    javascript: "js", javascriptreact: "js",
    typescript: "ts", typescriptreact: "ts",
    python: "py", ruby: "rb", rust: "rust", go: "go", java: "java",
    csharp: "cs", php: "php", dart: "dart", scala: "scala", groovy: "groovy",
    swift: "swift", kotlin: "kotlin",
    json: "json", jsonc: "json", yaml: "yaml", yml: "yaml",
    toml: "toml", ini: "ini", css: "css",
    html: "markup", xml: "markup", svg: "markup",
    sql: "sql", diff: "diff",
    markdown: "", plaintext: "",
  };

  /** Highlighter id for a host language id, or "" when we have no ruleset. */
  function languageForId(id) {
    if (typeof id !== "string" || !id) return "";
    const key = id.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LANG_BY_ID, key)) return LANG_BY_ID[key];
    return Object.prototype.hasOwnProperty.call(RULES, key) ? key : "";
  }

  // ---------- the scanner ----------

  const compiled = new Map();

  /** Combine a language's rules into ONE alternation, remembering which group
   *  index belongs to which token type. Rules must contain no capturing groups
   *  (see the header note) — each is wrapped in exactly one here. */
  function compile(lang) {
    if (compiled.has(lang)) return compiled.get(lang);
    const rules = RULES[lang];
    if (!rules) {
      compiled.set(lang, null);
      return null;
    }
    // A rule asking for case-insensitivity (SQL) makes the whole alternation
    // insensitive. That is safe here because no other rule in that language
    // distinguishes case.
    const insensitive = rules.some((r) => r.flags && r.flags.indexOf("i") !== -1);
    const entry = {
      re: new RegExp(rules.map((r) => `(${r.re})`).join("|"), insensitive ? "gmi" : "gm"),
      types: rules.map((r) => r.type),
    };
    compiled.set(lang, entry);
    return entry;
  }

  function span(type, text) {
    return `<span class="hl-${type}">${escapeHtml(text)}</span>`;
  }

  /**
   * Highlight `text` as `lang`, returning HTML.
   *
   * Returns plainly-escaped HTML (no spans) when the language is unknown or the
   * file is too big — never null, so callers have exactly one code path and can
   * never accidentally assign raw source to innerHTML.
   */
  function highlightCode(text, lang) {
    const source = typeof text === "string" ? text : "";
    const entry = source.length > MAX_HIGHLIGHT_BYTES ? null : compile(lang);
    if (!entry) return escapeHtml(source);

    let out = "";
    let last = 0;
    entry.re.lastIndex = 0;
    let match;
    while ((match = entry.re.exec(source)) !== null) {
      // A rule that can match empty would spin forever; step past it instead.
      if (match[0] === "") {
        entry.re.lastIndex += 1;
        continue;
      }
      if (match.index > last) out += escapeHtml(source.slice(last, match.index));
      let type = "";
      for (let i = 0; i < entry.types.length; i++) {
        if (match[i + 1] !== undefined) {
          type = entry.types[i];
          break;
        }
      }
      out += type ? renderToken(type, match[0], lang) : escapeHtml(match[0]);
      last = match.index + match[0].length;
    }
    if (last < source.length) out += escapeHtml(source.slice(last));
    return out;
  }

  /** Most tokens are a flat span. A markup tag is the exception: it is captured
   *  whole so attributes cannot leak into document text, then re-scanned here so
   *  the tag name, attribute names and quoted values each get their own colour. */
  function renderToken(type, text, lang) {
    if (type !== "tag" || lang !== "markup") return span(type, text);
    const inner = /^(<\/?)([A-Za-z][\w:-]*)([\s\S]*?)(\/?>)$/.exec(text);
    if (!inner) return span("tag", text);
    let attrs = "";
    let last = 0;
    const attrRe = /([A-Za-z_:][\w:.-]*)(\s*=\s*)("(?:[^"]*)"|'(?:[^']*)'|[^\s>]+)?/g;
    let m;
    while ((m = attrRe.exec(inner[3])) !== null) {
      if (m.index > last) attrs += escapeHtml(inner[3].slice(last, m.index));
      attrs += span("atr", m[1]) + escapeHtml(m[2]);
      if (m[3] !== undefined) attrs += span("str", m[3]);
      last = m.index + m[0].length;
    }
    if (last < inner[3].length) attrs += escapeHtml(inner[3].slice(last));
    return (
      `<span class="hl-tag">${escapeHtml(inner[1])}${span("tagname", inner[2])}` +
      `${attrs}${escapeHtml(inner[4])}</span>`
    );
  }

  const api = {
    escapeHtml,
    highlightCode,
    languageForPath,
    languageForId,
    MAX_HIGHLIGHT_BYTES,
    // Exposed for the rule-hygiene test, which walks every ruleset.
    _rules: RULES,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokSyntaxHighlight = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
