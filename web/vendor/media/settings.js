/**
 * Shared settings surface — a VIEW over existing gear prefs and actions.
 * No persistence of its own. Every control posts the same message the gear
 * already posts (or applies a client-owned pref the gear already applies).
 *
 * Loaded by the chat overlay (desktop / remote) and by the VS Code settings
 * tab. Snapshot-on-open is enough for the tab; changes still go host-ward
 * through the existing set* / open* messages so the sidebar cannot desync.
 */
(function (root) {
  const CATEGORIES = [
    { id: "general", title: "General", restore: true },
    { id: "voice", title: "Voice", restore: true },
    { id: "notifications", title: "Notifications", restore: true },
    { id: "providers", title: "Providers", restore: false },
    { id: "account", title: "Account", restore: false },
    { id: "advanced", title: "Advanced", restore: false },
    { id: "about", title: "About", restore: false },
  ];

  // Lucide-style stroke icons — same language as chat.js ICON. Labels stay
  // visible; color comes from the nav-item theme tokens.
  const NAV_ICONS = {
    general: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg>',
    voice: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>',
    notifications: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
    providers: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>',
    account: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    advanced: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
    about: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  };

  const GITHUB_REPO_URL = "https://github.com/phuryn/grok-build-vscode";
  const GITHUB_ISSUE_BUG_URL = GITHUB_REPO_URL + "/issues/new?labels=bug";
  const GITHUB_ISSUE_FEATURE_URL = GITHUB_REPO_URL + "/issues/new?labels=enhancement";
  const SUPPORT_MAILTO = "mailto:support@productcompass.pm";
  const ABOUT_DISCLAIMER =
    "Unofficial · community-built · MIT | " +
    "A VS Code UI for SpaceXAI’s Grok Build CLI - not affiliated with or endorsed by SpaceXAI (formerly xAI). " +
    "Grok, Grok Build, and xAI are trademarks of xAI; this project uses those names only to describe what it’s compatible with.";

  const TELEMETRY_COPY =
    "Anonymous usage stats only: a single session-start event with an anonymous install id — never prompts, code, file paths or names, and no identity. The IP address is discarded, never stored.";

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function purposeOf(snapshot) {
    return snapshot && snapshot.appPurpose === "coding" ? "coding" : "knowledge";
  }

  function providerOf(snapshot, id) {
    const list = (snapshot && snapshot.providers) || [];
    return list.find((p) => p && p.id === id) || { id, connected: false };
  }

  function providerAction(provider) {
    const connected = provider.connected === true;
    const needsLogin = connected && provider.needsLogin === true;
    if (needsLogin) return "Sign in again";
    return connected ? "Sign out" : "Connect";
  }

  function providerDescription(provider) {
    const connected = provider.connected === true;
    const needsLogin = connected && provider.needsLogin === true;
    if (needsLogin) return "This account is connected but needs to sign in again before it can be used.";
    if (connected) return "This account is connected on this machine.";
    return "Connect this account to use it for new conversations.";
  }

  function logsLabel(env) {
    return env && env.hostCaps && env.hostCaps.showOutput === false
      ? "Logs"
      : "Show extension logs";
  }

  function grokProvider(snapshot) {
    return ((snapshot && snapshot.providers) || []).find((p) => p && p.id === "grok" && p.connected);
  }

  function codexProvider(snapshot) {
    return ((snapshot && snapshot.providers) || []).find((p) => p && p.id === "codex" && p.connected);
  }

  function legacyProviders(env) {
    return !env || env.providersKnown !== true;
  }

  function showGrokAbout(snapshot, env) {
    return legacyProviders(env) || !!grokProvider(snapshot);
  }

  function remoteAbout(snapshot, env) {
    return !!(env && env.isRemote && snapshot && snapshot.hostKind);
  }

  function grokUpdateOf(snapshot) {
    return (snapshot && snapshot.grokUpdate) || {};
  }

  function grokCliVersion(snapshot) {
    const u = grokUpdateOf(snapshot);
    const grok = grokProvider(snapshot);
    return (grok && grok.cliVersion) || (snapshot && snapshot.cliVersion) || u.current || "";
  }

  function hasReportedProviderVersions(snapshot) {
    return ((snapshot && snapshot.providers) || []).some((p) =>
      p && p.connected && (p.cliVersion || p.adapterVersion));
  }

  function grokUpdateBlocked(snapshot) {
    const policy = grokUpdateOf(snapshot).policy;
    return !!(policy && policy.allow === false);
  }

  function canUpdateGrok(snapshot) {
    const u = grokUpdateOf(snapshot);
    if (grokUpdateBlocked(snapshot)) return false;
    return !!(u.error || u.updateAvailable);
  }

  function webAppVersion() {
    const meta = typeof document !== "undefined" && document.querySelector('meta[name="grok-web-version"]');
    return (meta && meta.getAttribute("content")) || "";
  }

  function versionLabel(value) {
    return value ? "v" + value : "—";
  }

  function grokUpdateStatusText(snapshot) {
    const u = grokUpdateOf(snapshot);
    if (u.checking) return "Checking for updates";
    if (grokUpdateBlocked(snapshot)) return "On the supported version";
    if (u.error) return "Couldn’t check — try updating anyway";
    if (u.updateAvailable) return "Update available · v" + (u.latest || "");
    if (u.current || u.latest) return "CLI is up to date";
    return "—";
  }

  /** One sentence, one control. Visibility is decided separately. */
  const ROWS = [
    {
      id: "appPurpose",
      category: "general",
      title: "Use this app for",
      description: "Knowledge work hides worktrees, thinking traces, and tool details. Coding unlocks those controls, still off by default.",
      kind: "select",
      options: [
        { value: "knowledge", label: "Knowledge work" },
        { value: "coding", label: "Coding" },
      ],
      defaultValue: "knowledge",
      get: (s) => purposeOf(s),
      message: (value) => ({ type: "setAppPurpose", value }),
    },
    {
      id: "telemetryDesktop",
      category: "general",
      title: "Anonymous usage stats",
      description: TELEMETRY_COPY,
      kind: "toggle",
      defaultValue: true,
      visible: (s, env) => !!(env && env.isDesktop && !env.isRemote),
      get: (s) => !s || s.telemetryEnabled !== false,
      message: (value) => ({ type: "setTelemetryEnabled", value }),
    },
    {
      id: "telemetryVsCode",
      category: "general",
      title: "Anonymous usage stats",
      description: TELEMETRY_COPY,
      kind: "action",
      actionLabel: "Open VS Code settings",
      visible: (s, env) => !!(env && !env.isRemote && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.telemetry.enabled" }),
    },
    {
      id: "telemetryRemote",
      category: "general",
      title: "Anonymous usage stats",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote),
      describe: (s) => {
        const known = s && typeof s.telemetryEnabled === "boolean";
        const state = known ? (s.telemetryEnabled ? "On. " : "Off. ") : "";
        return state + TELEMETRY_COPY;
      },
    },
    {
      id: "chatFontScale",
      category: "general",
      title: "Text size",
      description: "Chat text size on this device only. Keyboard zoom stays in sync with this slider.",
      kind: "range",
      min: 80,
      max: 160,
      step: 10,
      defaultValue: 100,
      visible: (s, env) => !!(env && env.clientOwnsFontScale),
      get: (s) => Math.round(((s && s.fontScale) || 1) * 100),
      localOnly: true,
    },
    {
      id: "openChatFontScale",
      category: "general",
      title: "Text size",
      description: "Chat zoom lives in VS Code settings so it can stay a user or workspace preference.",
      kind: "action",
      actionLabel: "Open VS Code settings",
      visible: (s, env) => !!(env && !env.isRemote && !env.clientOwnsFontScale && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.chatFontScale" }),
    },
    {
      id: "showThinking",
      category: "general",
      title: "Show thinking traces",
      description: "Show Grok's reasoning traces in chat, including on already-loaded sessions.",
      kind: "toggle",
      defaultValue: false,
      visible: (s) => purposeOf(s) === "coding",
      get: (s) => !!(s && s.showThinking),
      message: (value) => ({ type: "setShowThinking", value }),
    },
    {
      id: "expandCommandOutputs",
      category: "general",
      title: "Expand tool details",
      description: "Pre-open each command's IN/OUT block and each edit's inline diff instead of clicking a row to expand it.",
      kind: "toggle",
      defaultValue: false,
      visible: (s) => purposeOf(s) === "coding",
      get: (s) => !!(s && s.expandCommandOutputs),
      message: (value) => ({ type: "setExpandCommandOutputs", value }),
    },
    {
      id: "steerByDefault",
      category: "general",
      title: "Steer by default",
      description: "Send straight into the running turn instead of queueing until it finishes. Steering does not cancel work in progress.",
      kind: "toggle",
      defaultValue: false,
      visible: (s, env) => !env || env.steerSupported !== false,
      get: (s) => !!(s && s.steerByDefault),
      message: (value) => ({ type: "setSteerByDefault", value }),
    },
    {
      id: "voiceSendPhrase",
      category: "voice",
      title: "Send phrase",
      description: "Spoken phrase that submits the message when it ends a transcription. Leave empty to disable hands-free send.",
      kind: "text",
      placeholder: "grok send",
      defaultValue: "grok send",
      get: (s) => (s && typeof s.voiceSendPhrase === "string") ? s.voiceSendPhrase : "grok send",
      message: (value) => ({ type: "setVoiceSendPhrase", value }),
    },
    {
      id: "voiceKeyterms",
      category: "voice",
      title: "Dictionary terms",
      description: "Words or phrases that help streaming recognition spell project vocabulary. Press Enter to add a term.",
      kind: "tags",
      placeholder: "Add a term",
      defaultValue: [],
      get: (s) => (s && Array.isArray(s.voiceKeyterms)) ? s.voiceKeyterms : [],
      message: (value) => ({ type: "setVoiceKeyterms", value }),
    },
    {
      id: "voiceConfigured",
      category: "voice",
      title: "Voice input",
      description: "",
      kind: "action",
      actionLabel: "Open voice settings",
      describe: (s) => (s && s.voiceConfigured)
        ? "Voice is ready on this machine."
        : "Voice needs a key or a signed-in Grok account before the mic can start.",
      visible: (s, env) => !!(env && !env.isRemote && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok.voiceApiKey" }),
    },
    {
      id: "voiceConfiguredStatus",
      category: "voice",
      title: "Voice input",
      description: "",
      kind: "status",
      describe: (s) => (s && s.voiceConfigured)
        ? "Voice is ready on this machine."
        : "Voice is not configured on the desk that is hosting this session.",
      visible: (s, env) => !!(env && (env.isRemote || env.isDesktop)),
    },
    {
      id: "readRepliesAloud",
      category: "voice",
      title: "Read replies aloud",
      description: "Read completed replies aloud. Code blocks are skipped.",
      kind: "toggle",
      defaultValue: false,
      visible: (s, env) => !env || env.ttsAvailable !== false,
      get: (s) => !!(s && s.readRepliesAloud),
      message: (value) => ({ type: "setReadRepliesAloud", value }),
      localOnly: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "summarizeRepliesAloud",
      category: "voice",
      title: "Read simplified summaries",
      description: "Use xAI to speak a brief summary of each reply. This costs an extra call and falls back to the full text on failure.",
      kind: "toggle",
      defaultValue: true,
      visible: (s, env) => !env || env.ttsAvailable !== false,
      enabled: (s) => !!(s && s.readRepliesAloud),
      get: (s) => !!(s && s.summarizeRepliesAloud),
      message: (value) => ({ type: "setSummarizeRepliesAloud", value }),
      localOnly: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "ttsUnavailable",
      category: "voice",
      title: "Read replies aloud",
      description: "Speech synthesis is not supported in this client.",
      kind: "status",
      visible: (s, env) => !!(env && env.ttsAvailable === false),
    },
    {
      id: "soundNotifications",
      category: "notifications",
      title: "Sound notifications",
      description: "Play a short sound when a turn finishes or errors, only when the Grok panel is not focused.",
      kind: "toggle",
      defaultValue: false,
      get: (s) => !!(s && s.soundNotifications),
      message: (value) => ({ type: "setSoundNotifications", value }),
    },
    {
      id: "processingSound",
      category: "notifications",
      title: "Still-processing sound",
      description: "Play a quiet reminder while a turn is still working. It starts after seven seconds and repeats every eight seconds.",
      kind: "toggle",
      defaultValue: false,
      get: (s) => !!(s && s.processingSound),
      message: (value) => ({ type: "setProcessingSound", value }),
    },
    {
      id: "providerGrok",
      category: "providers",
      title: "Grok",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "grok")),
      actionLabel: (s) => providerAction(providerOf(s, "grok")),
      message: (s) => {
        const provider = providerOf(s, "grok");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "grok" }
          : { type: "runGrokLogin", provider: "grok" };
      },
    },
    {
      id: "providerCodex",
      category: "providers",
      title: "Codex",
      description: "",
      kind: "action",
      visible: (s, env) => !!(env && !env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "codex")),
      actionLabel: (s) => providerAction(providerOf(s, "codex")),
      message: (s) => {
        const provider = providerOf(s, "codex");
        return provider.connected && provider.needsLogin !== true
          ? { type: "logout", provider: "codex" }
          : { type: "runGrokLogin", provider: "codex" };
      },
    },
    {
      id: "providerGrokStatus",
      category: "providers",
      title: "Grok",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "grok")),
    },
    {
      id: "providerCodexStatus",
      category: "providers",
      title: "Codex",
      description: "",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && env.providersKnown),
      describe: (s) => providerDescription(providerOf(s, "codex")),
    },
    {
      id: "continueRemotely",
      category: "account",
      title: "Continue remotely",
      description: "Open AFK Pilot so you can keep this session going from another device.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === true),
      message: () => ({ type: "openRemotePortal", withHint: true }),
    },
    {
      id: "yourAccount",
      category: "account",
      title: "Your account",
      description: "Open the AFK Pilot account page for this linked device.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === true),
      message: () => ({ type: "openRemotePortal" }),
    },
    {
      id: "unlinkDevice",
      category: "account",
      title: "Unlink this device",
      description: "Stop advertising this machine to AFK Pilot. Other devices lose this desk until you link it again.",
      kind: "action",
      actionLabel: "Unlink…",
      visible: (s, env) => !!(env && !env.isRemote && env.isDesktop && env.remoteLinked === true),
      message: () => ({ type: "unlinkRemoteDevice" }),
    },
    {
      id: "remoteSignIn",
      category: "account",
      title: "Sign in",
      description: "Link this device to an AFK Pilot account so you can continue remotely.",
      kind: "action",
      actionLabel: "Link this device",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === false),
      message: () => ({ type: "remoteSignIn" }),
    },
    {
      id: "remoteHowItWorks",
      category: "account",
      title: "How it works",
      description: "AFK Pilot keeps this machine awake and lets you continue from a phone without storing prompts or code.",
      kind: "action",
      actionLabel: "Learn more",
      visible: (s, env) => !!(env && !env.isRemote && env.remoteLinked === false && !env.standalone),
      local: "explainRemote",
    },
    {
      id: "remoteAccountStatus",
      category: "account",
      title: "AFK Pilot",
      description: "This browser is signed in and talking to the linked desk.",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "remoteDeviceManager",
      category: "account",
      title: "Device manager",
      description: "Open the AFK Pilot device list for this account.",
      kind: "action",
      actionLabel: "Open",
      visible: (s, env) => !!(env && env.isRemote),
      local: "openDeviceManager",
    },
    {
      id: "openGlobalConfig",
      category: "advanced",
      title: "Open global config",
      description: "Open the user-level Grok config file on this machine.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      message: () => ({ type: "openGlobalConfig" }),
    },
    {
      id: "openProjectConfig",
      category: "advanced",
      title: "Open project config",
      description: "Open this project's Grok config file.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      message: () => ({ type: "openProjectConfig" }),
    },
    {
      id: "runMcpList",
      category: "advanced",
      title: "MCP servers",
      description: "List the MCP servers configured for the Grok CLI.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      message: () => ({ type: "runMcpList" }),
    },
    {
      id: "showLogs",
      category: "advanced",
      title: "Show logs",
      description: "Open the host log for this Grok client.",
      kind: "action",
      actionLabel: (s, env) => logsLabel(env),
      hostLocal: true,
      message: () => ({ type: "showLogs" }),
    },
    {
      id: "toggleDevTools",
      category: "advanced",
      title: "Toggle Developer Tools",
      description: "Open or close Chromium Developer Tools for this window.",
      kind: "action",
      actionLabel: "Toggle",
      hostLocal: true,
      visible: (s, env) => !!(env && env.hostCaps && env.hostCaps.toggleDevTools === true),
      message: () => ({ type: "toggleDevTools" }),
    },
    {
      id: "openVsCodeSettings",
      category: "advanced",
      title: "Open VS Code settings",
      description: "Open the host Settings editor focused on Grok.",
      kind: "action",
      actionLabel: "Open",
      hostLocal: true,
      visible: (s, env) => !!(env && !env.isDesktop),
      message: () => ({ type: "openSettings", section: "grok" }),
    },
    {
      id: "moveView",
      category: "advanced",
      title: "Move view",
      description: "Open the editor's own picker so you can move the Grok chat to another dock.",
      kind: "action",
      actionLabel: "Move view…",
      hostLocal: true,
      visible: (s, env) => !!(
        env &&
        env.hostCaps &&
        env.hostCaps.secondarySideBar === false &&
        env.hostCaps.relocateView !== false
      ),
      message: () => ({ type: "moveView", location: "pick" }),
    },
    {
      id: "hostConfigRemote",
      category: "advanced",
      title: "Host configuration",
      description: "Host config is managed on the desk.",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote),
    },
    {
      id: "aboutWebApp",
      category: "about",
      title: "Web app",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: () => versionLabel(webAppVersion()),
    },
    {
      id: "aboutConnectedTo",
      category: "about",
      title: "Connected to",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: (s) => {
        const gui = s && s.hostKind === "desktop" ? "Desktop app" : "Extension";
        return s && s.hostName ? `${s.hostName} · ${gui}` : gui;
      },
    },
    {
      id: "aboutHostProduct",
      category: "about",
      title: (s) => (s && s.hostKind === "desktop") ? "Grok Build Desktop" : "Grok Build extension",
      kind: "value",
      visible: (s, env) => remoteAbout(s, env),
      get: (s) => versionLabel(s && s.extVersion),
    },
    {
      id: "aboutThisExtension",
      category: "about",
      title: "This extension",
      kind: "value",
      visible: (s, env) => !remoteAbout(s, env),
      get: (s) => versionLabel(s && s.extVersion),
    },
    {
      id: "aboutGrokCli",
      category: "about",
      title: "Grok Build CLI",
      kind: "value",
      visible: (s, env) => {
        if (remoteAbout(s, env) && hasReportedProviderVersions(s)) return !!grokProvider(s);
        if (remoteAbout(s, env)) return true;
        return showGrokAbout(s, env);
      },
      get: (s) => versionLabel(grokCliVersion(s)),
    },
    {
      id: "aboutCodexCli",
      category: "about",
      title: "Codex CLI",
      kind: "value",
      visible: (s) => !!codexProvider(s),
      get: (s) => {
        const p = codexProvider(s);
        return versionLabel(p && p.cliVersion);
      },
    },
    {
      id: "aboutCodexAdapter",
      category: "about",
      title: "Codex ACP adapter",
      kind: "value",
      visible: (s) => !!codexProvider(s),
      get: (s) => {
        const p = codexProvider(s);
        return versionLabel(p && p.adapterVersion);
      },
    },
    {
      id: "aboutCodexUpdate",
      category: "about",
      title: "Codex updates",
      kind: "status",
      visible: (s) => !!codexProvider(s),
      describe: (s, env) => {
        const p = codexProvider(s);
        if (p && p.updateAvailable) {
          const latest = p.latestCliVersion ? ` · v${p.latestCliVersion}` : "";
          const where = env && env.isRemote
            ? "Update it at the desk — this device can’t."
            : "Update it at its install source.";
          return `Codex update available${latest}. ${where}`;
        }
        return env && env.isRemote
          ? "Codex updates are managed at the desk."
          : "Codex updates are managed at its install source.";
      },
    },
    {
      id: "aboutGrokUpdateStatus",
      category: "about",
      title: "Grok Build CLI updates",
      kind: "status",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env),
      describe: (s) => grokUpdateStatusText(s),
    },
    {
      id: "aboutGrokUpdatePolicy",
      category: "about",
      title: "Updates paused",
      kind: "status",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && grokUpdateBlocked(s),
      describe: (s) => {
        const policy = grokUpdateOf(s).policy;
        return (policy && policy.note) || "Updates are paused for compatibility.";
      },
    },
    {
      id: "aboutUpdateGrok",
      category: "about",
      title: "Update Grok Build CLI",
      description: "Download and install the latest Grok Build CLI on this machine.",
      kind: "action",
      actionLabel: "Update Grok Build CLI",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && canUpdateGrok(s),
      message: () => ({ type: "updateGrok" }),
    },
    {
      id: "aboutUpdateGrokBlocked",
      category: "about",
      title: "Update Grok Build CLI",
      description: "Updates are paused for compatibility.",
      kind: "action",
      actionLabel: "Update Grok Build CLI",
      visible: (s, env) => showGrokAbout(s, env) && !remoteAbout(s, env) && grokUpdateBlocked(s),
      enabled: () => false,
      message: () => ({ type: "updateGrok" }),
    },
    {
      id: "aboutRemoteCliUpdate",
      category: "about",
      title: "CLI update",
      kind: "status",
      visible: (s, env) => !!(env && env.isRemote && grokUpdateOf(s).updateAvailable),
      describe: (s) => {
        const latest = grokUpdateOf(s).latest;
        return `CLI update available${latest ? ` · v${latest}` : ""}. Update it at the desk — this device can’t.`;
      },
    },
    {
      id: "reportBug",
      category: "about",
      title: "Report a bug",
      description: "Open a new issue on the GitHub tracker.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_ISSUE_BUG_URL,
    },
    {
      id: "requestFeature",
      category: "about",
      title: "Request a feature",
      description: "Open a new issue on the GitHub tracker.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_ISSUE_FEATURE_URL,
    },
    {
      id: "contactSupport",
      category: "about",
      title: "Contact",
      description: "support@productcompass.pm",
      kind: "action",
      actionLabel: "Email",
      href: SUPPORT_MAILTO,
    },
    {
      id: "aboutRepo",
      category: "about",
      title: "phuryn/grok-build-vscode",
      description: "Source repository on GitHub.",
      kind: "action",
      actionLabel: "Open",
      href: GITHUB_REPO_URL,
    },
  ];

  function rowVisible(row, snapshot, env) {
    if (row.hostLocal && env && env.isRemote) return false;
    if (typeof row.visible === "function") return !!row.visible(snapshot, env);
    return true;
  }

  function rowEnabled(row, snapshot) {
    if (typeof row.enabled === "function") return !!row.enabled(snapshot);
    return true;
  }

  function rowTitle(row, snapshot, env) {
    if (typeof row.title === "function") return row.title(snapshot, env);
    return row.title;
  }

  function rowDescription(row, snapshot, env) {
    if (typeof row.describe === "function") return row.describe(snapshot, env);
    return row.description || "";
  }

  function rowActionLabel(row, snapshot, env) {
    if (typeof row.actionLabel === "function") return row.actionLabel(snapshot, env);
    return row.actionLabel || "Open";
  }

  function rowValue(row, snapshot) {
    return typeof row.get === "function" ? row.get(snapshot) : undefined;
  }

  function isLocalOnly(row, snapshot, env) {
    if (typeof row.localOnly === "function") return !!row.localOnly(snapshot, env);
    return row.localOnly === true;
  }

  function visibleRows(snapshot, env) {
    return ROWS.filter((row) => rowVisible(row, snapshot, env));
  }

  function visibleCategories(snapshot, env) {
    const rows = visibleRows(snapshot, env);
    const ids = new Set(rows.map((row) => row.category));
    return CATEGORIES.filter((cat) => ids.has(cat.id));
  }

  function searchHaystack(row, snapshot, env) {
    const cat = CATEGORIES.find((c) => c.id === row.category);
    return [
      rowTitle(row, snapshot, env),
      rowDescription(row, snapshot, env),
      cat ? cat.title : "",
      row.id,
    ].join(" ").toLowerCase();
  }

  function filterRows(query, snapshot, env) {
    const rows = visibleRows(snapshot, env);
    const q = String(query || "").trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => searchHaystack(row, snapshot, env).includes(q));
  }

  /** Toggles / selects / sliders restore. Free-text and list inputs never do
   *  (voice send phrase + dictionary terms are the canonical cases). */
  const RESTORABLE_KINDS = { toggle: true, select: true, range: true };

  function isRestorableKind(row) {
    return !!RESTORABLE_KINDS[row.kind];
  }

  function restoreTargets(categoryId, snapshot, env) {
    return ROWS.filter((row) =>
      row.category === categoryId &&
      isRestorableKind(row) &&
      row.defaultValue !== undefined &&
      rowVisible(row, snapshot, env) &&
      rowEnabled(row, snapshot));
  }

  function restoreChanges(categoryId, snapshot, env) {
    let next = snapshot;
    const out = [];
    for (const row of restoreTargets(categoryId, snapshot, env)) {
      if (!rowEnabled(row, next)) continue;
      if (rowValue(row, next) === row.defaultValue) continue;
      out.push(row);
      next = applyValue(row, row.defaultValue, next);
    }
    return out;
  }

  function restoreValueLabel(row, value) {
    if (row.kind === "toggle") return value ? "On" : "Off";
    if (row.kind === "select") {
      const opt = (row.options || []).find((o) => o.value === value);
      return opt ? opt.label : String(value);
    }
    if (row.kind === "range") return `${value}%`;
    return String(value);
  }

  function rowMessage(row, value, snapshot) {
    if (typeof row.message !== "function") return null;
    // Action rows that need the snapshot receive it as the sole argument.
    if (row.kind === "action") return row.message(snapshot);
    return row.message(value);
  }

  function applyValue(row, value, snapshot) {
    const next = { ...snapshot };
    switch (row.id) {
      case "appPurpose":
        next.appPurpose = value === "coding" ? "coding" : "knowledge";
        break;
      case "chatFontScale":
        next.fontScale = Number(value) / 100;
        break;
      case "showThinking":
        next.showThinking = !!value;
        break;
      case "expandCommandOutputs":
        next.expandCommandOutputs = !!value;
        break;
      case "steerByDefault":
        next.steerByDefault = !!value;
        break;
      case "readRepliesAloud":
        next.readRepliesAloud = !!value;
        if (!next.readRepliesAloud) next.summarizeRepliesAloud = false;
        break;
      case "summarizeRepliesAloud":
        next.summarizeRepliesAloud = !!value;
        break;
      case "soundNotifications":
        next.soundNotifications = !!value;
        break;
      case "processingSound":
        next.processingSound = !!value;
        break;
      case "voiceSendPhrase":
        next.voiceSendPhrase = String(value ?? "");
        break;
      case "voiceKeyterms":
        next.voiceKeyterms = Array.isArray(value) ? value.slice() : [];
        break;
      case "telemetryDesktop":
        next.telemetryEnabled = !!value;
        break;
      default:
        break;
    }
    return next;
  }

  function defaultEnv(partial) {
    return {
      isRemote: false,
      isDesktop: false,
      clientOwnsFontScale: false,
      ttsAvailable: true,
      steerSupported: true,
      providersKnown: false,
      remoteLinked: null,
      standalone: false,
      hostCaps: {},
      ...(partial || {}),
    };
  }

  function defaultSnapshot(partial) {
    return {
      appPurpose: "knowledge",
      showThinking: false,
      expandCommandOutputs: false,
      steerByDefault: false,
      fontScale: 1,
      soundNotifications: false,
      processingSound: false,
      readRepliesAloud: false,
      summarizeRepliesAloud: true,
      voiceConfigured: false,
      voiceSendPhrase: "grok send",
      voiceKeyterms: [],
      telemetryEnabled: true,
      providers: [],
      extVersion: "",
      cliVersion: "",
      hostKind: "",
      hostName: "",
      grokUpdate: null,
      ...(partial || {}),
    };
  }

  const FOCUSABLE_SEL = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

  const PHONE_NAV_MQ = "(max-width: 520px)";

  function matchPhoneNav(doc) {
    const win = doc && doc.defaultView;
    return !!(win && win.matchMedia && win.matchMedia(PHONE_NAV_MQ).matches);
  }

  function focusableControls(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE_SEL), (el) => {
      if (el.disabled) return false;
      if (typeof el.closest === "function" && el.closest("[hidden]")) return false;
      return el.getAttribute("tabindex") !== "-1";
    });
  }

  function describeFocus(container, el) {
    if (!el || !container.contains(el)) return null;
    if (el.id === "settings-search") {
      return {
        kind: "search",
        start: typeof el.selectionStart === "number" ? el.selectionStart : null,
        end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
      };
    }
    const row = typeof el.closest === "function" ? el.closest(".settings-row") : null;
    if (row && row.dataset.id) {
      if (el.tagName === "SELECT") return { kind: "control", id: row.dataset.id, sel: "select" };
      if (el.matches && el.matches("input[type=range]")) return { kind: "control", id: row.dataset.id, sel: "input[type=range]" };
      if (el.classList.contains("settings-switch")) return { kind: "control", id: row.dataset.id, sel: ".settings-switch" };
      if (el.classList.contains("settings-action")) return { kind: "control", id: row.dataset.id, sel: ".settings-action" };
      if (el.classList.contains("settings-text")) {
        return {
          kind: "control",
          id: row.dataset.id,
          sel: ".settings-text",
          start: typeof el.selectionStart === "number" ? el.selectionStart : null,
          end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
        };
      }
      if (el.classList.contains("settings-tags-input")) {
        return {
          kind: "control",
          id: row.dataset.id,
          sel: ".settings-tags-input",
          start: typeof el.selectionStart === "number" ? el.selectionStart : null,
          end: typeof el.selectionEnd === "number" ? el.selectionEnd : null,
        };
      }
    }
    if (el.classList.contains("settings-nav-item") && el.dataset.category) {
      return { kind: "nav", category: el.dataset.category };
    }
    if (el.classList.contains("settings-nav-select")) return { kind: "nav-select" };
    if (el.classList.contains("settings-restore")) return { kind: "restore" };
    if (el.classList.contains("settings-restore-confirm-go")) return { kind: "restore-go" };
    if (el.classList.contains("settings-restore-confirm-cancel")) return { kind: "restore-cancel" };
    if (el.classList.contains("settings-back")) return { kind: "back" };
    return null;
  }

  function applyFocus(container, desc) {
    if (!desc) return;
    let next = null;
    if (desc.kind === "search") next = container.querySelector("#settings-search");
    else if (desc.kind === "nav") {
      next = container.querySelector(`.settings-nav-item[data-category="${desc.category}"]`);
      if (next && typeof next.closest === "function" && next.closest("[hidden]")) {
        next = container.querySelector(".settings-nav-select");
      }
    }
    else if (desc.kind === "nav-select") {
      next = container.querySelector(".settings-nav-select");
      if (next && typeof next.closest === "function" && next.closest("[hidden]")) {
        next = container.querySelector(`.settings-nav-item[data-category="${next.value}"]`);
      }
    }
    else if (desc.kind === "restore") next = container.querySelector(".settings-restore");
    else if (desc.kind === "restore-go") next = container.querySelector(".settings-restore-confirm-go");
    else if (desc.kind === "restore-cancel") next = container.querySelector(".settings-restore-confirm-cancel");
    else if (desc.kind === "back") next = container.querySelector(".settings-back");
    else if (desc.kind === "control") {
      const row = container.querySelector(`.settings-row[data-id="${desc.id}"]`);
      next = row ? row.querySelector(desc.sel) : null;
    }
    if (!next || next.disabled) {
      // The focused control vanished or got disabled in this repaint (a live
      // update hid its row). Without a fallback, focus lands on BODY and the
      // modal containment leaks — fall back to search, then anything focusable.
      next = container.querySelector("#settings-search")
        || container.querySelector("button, [href], input, select, [tabindex]:not([tabindex='-1'])");
      if (!next) return;
      next.focus();
      return;
    }
    next.focus();
    if ((desc.kind === "search" || desc.sel === ".settings-text" || desc.sel === ".settings-tags-input") &&
        desc.start != null && typeof next.setSelectionRange === "function") {
      try { next.setSelectionRange(desc.start, desc.end != null ? desc.end : desc.start); } catch { /* */ }
    }
  }

  function coverSiblings(container, on) {
    const parent = container.parentElement;
    if (!parent) return;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === container) continue;
      if (on) {
        // Track ownership for BOTH attributes: cleanup must not strip an
        // inert some other surface set before settings opened.
        if (!sibling.hasAttribute("inert")) {
          sibling.setAttribute("inert", "");
          sibling.setAttribute("data-settings-inert", "1");
        }
        if (!sibling.hasAttribute("aria-hidden")) {
          sibling.setAttribute("aria-hidden", "true");
          sibling.setAttribute("data-settings-cover", "1");
        }
      } else {
        if (sibling.getAttribute("data-settings-inert") === "1") {
          sibling.removeAttribute("inert");
          sibling.removeAttribute("data-settings-inert");
        }
        if (sibling.getAttribute("data-settings-cover") === "1") {
          sibling.removeAttribute("aria-hidden");
          sibling.removeAttribute("data-settings-cover");
        }
      }
    }
  }

  function switchMarkup(on, disabled) {
    return `<button type="button" class="settings-switch${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}"${disabled ? " disabled" : ""}><span class="settings-switch-knob"></span></button>`;
  }

  function renderRow(row, snapshot, env) {
    const el = document.createElement("div");
    el.className = "settings-row";
    el.dataset.id = row.id;
    el.dataset.kind = row.kind || "";
    const enabled = rowEnabled(row, snapshot);
    if (!enabled) el.classList.add("is-disabled");
    const title = document.createElement("div");
    title.className = "settings-row-copy";
    const name = document.createElement("div");
    name.className = "settings-row-title";
    name.textContent = rowTitle(row, snapshot, env);
    const desc = document.createElement("div");
    desc.className = "settings-row-desc";
    desc.textContent = rowDescription(row, snapshot, env);
    title.appendChild(name);
    title.appendChild(desc);
    const control = document.createElement("div");
    control.className = "settings-row-control";
    const value = rowValue(row, snapshot);

    if (row.kind === "toggle") {
      control.innerHTML = switchMarkup(!!value, !enabled);
    } else if (row.kind === "select") {
      const select = document.createElement("select");
      select.className = "settings-select";
      select.setAttribute("aria-label", row.title);
      for (const opt of row.options || []) {
        const option = document.createElement("option");
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.value === value) option.selected = true;
        select.appendChild(option);
      }
      control.appendChild(select);
    } else if (row.kind === "range") {
      const wrap = document.createElement("div");
      wrap.className = "settings-range";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(row.min);
      input.max = String(row.max);
      input.step = String(row.step || 1);
      input.value = String(value);
      input.setAttribute("aria-label", row.title);
      if (row.id === "chatFontScale") input.id = "remote-font-scale";
      const out = document.createElement("output");
      out.textContent = `${value}%`;
      wrap.appendChild(input);
      wrap.appendChild(out);
      control.appendChild(wrap);
    } else if (row.kind === "text") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-text";
      input.value = String(value ?? "");
      input.setAttribute("aria-label", row.title);
      if (row.placeholder) input.placeholder = row.placeholder;
      control.appendChild(input);
    } else if (row.kind === "tags") {
      const wrap = document.createElement("div");
      wrap.className = "settings-tags";
      const list = document.createElement("div");
      list.className = "settings-tags-list";
      for (const term of Array.isArray(value) ? value : []) {
        const chip = document.createElement("span");
        chip.className = "settings-tag";
        chip.dataset.term = term;
        const label = document.createElement("span");
        label.textContent = term;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "settings-tag-remove";
        remove.setAttribute("aria-label", "Remove " + term);
        remove.textContent = "×";
        chip.appendChild(label);
        chip.appendChild(remove);
        list.appendChild(chip);
      }
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-tags-input";
      input.setAttribute("aria-label", row.title);
      input.placeholder = row.placeholder || "Add a term";
      wrap.appendChild(list);
      wrap.appendChild(input);
      control.appendChild(wrap);
    } else if (row.kind === "value") {
      const span = document.createElement("span");
      span.className = "settings-value";
      span.textContent = String(value ?? "—");
      control.appendChild(span);
    } else if (row.kind === "action") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-action";
      btn.textContent = rowActionLabel(row, snapshot, env);
      if (!enabled) btn.disabled = true;
      control.appendChild(btn);
    }

    el.appendChild(title);
    el.appendChild(control);
    return el;
  }

  function mount(container, opts) {
    if (!container) throw new Error("GrokSettings.mount requires a container");
    const env = defaultEnv({ ...(opts.env || {}), standalone: !!opts.standalone });
    let snapshot = defaultSnapshot(opts.snapshot);
    let categoryId = opts.category || "general";
    let query = "";
    let pendingRestore = null;
    let aboutChecked = false;
    const post = typeof opts.post === "function" ? opts.post : () => {};
    const apply = typeof opts.apply === "function" ? opts.apply : null;
    const onLocal = typeof opts.onLocal === "function" ? opts.onLocal : null;
    const onClose = typeof opts.onClose === "function" ? opts.onClose : null;
    let phoneNav = matchPhoneNav(container.ownerDocument);

    const modal = !opts.standalone;
    container.classList.add("settings-surface");
    container.setAttribute("role", "dialog");
    container.setAttribute("aria-label", "Settings");
    if (modal) {
      container.setAttribute("aria-modal", "true");
      coverSiblings(container, true);
    }

    function cats() {
      return visibleCategories(snapshot, env);
    }

    function ensureCategory() {
      const available = cats();
      if (!available.some((c) => c.id === categoryId)) {
        categoryId = available[0] ? available[0].id : "general";
      }
    }

    function commit(row, value) {
      const previous = snapshot;
      snapshot = applyValue(row, value, snapshot);
      const message = rowMessage(row, value, snapshot);
      const localOnly = isLocalOnly(row, previous, env);
      if (apply) apply(row.id, value, localOnly ? null : message, snapshot);
      else if (message && !localOnly) post(message);
      if (pendingRestore) pendingRestore = null;
      paint();
    }

    function dismissRestoreConfirm() {
      pendingRestore = null;
    }

    function beginRestoreConfirm() {
      const changes = restoreChanges(categoryId, snapshot, env);
      if (!changes.length) {
        pendingRestore = null;
        paint();
        return;
      }
      pendingRestore = changes;
      paint();
      const cancel = container.querySelector(".settings-restore-confirm-cancel");
      if (cancel) cancel.focus();
    }

    function cancelRestoreConfirm() {
      pendingRestore = null;
      paint();
    }

    function commitRestoreConfirm() {
      const targets = pendingRestore || [];
      pendingRestore = null;
      for (const row of targets) {
        if (!rowEnabled(row, snapshot)) continue;
        const current = rowValue(row, snapshot);
        if (current === row.defaultValue) continue;
        commit(row, row.defaultValue);
      }
      if (!targets.length) paint();
    }

    function openExternalHref(url) {
      if (env.isRemote) {
        window.open(url, "_blank", "noopener");
        return;
      }
      post({ type: "openUrl", url });
    }

    function maybeCheckAbout() {
      if (aboutChecked || categoryId !== "about" || query.trim() || env.isRemote) return;
      if (!legacyProviders(env) && !grokProvider(snapshot)) return;
      aboutChecked = true;
      snapshot = { ...snapshot, grokUpdate: { ...(snapshot.grokUpdate || {}), checking: true } };
      post({ type: "checkGrokUpdate" });
    }

    function runAction(row) {
      if (row.local) {
        if (onClose && !opts.standalone) onClose();
        if (onLocal) onLocal(row.local);
        return;
      }
      if (row.href) {
        openExternalHref(row.href);
        return;
      }
      const message = rowMessage(row, undefined, snapshot);
      if (message) post(message);
      if (opts.closeOnAction && onClose) onClose();
    }

    function paint() {
      const focus = describeFocus(container, container.ownerDocument && container.ownerDocument.activeElement);
      ensureCategory();
      maybeCheckAbout();
      const searching = !!query.trim();
      const shownCats = cats();
      const page = CATEGORIES.find((c) => c.id === categoryId) || shownCats[0];
      const rows = searching
        ? filterRows(query, snapshot, env)
        : visibleRows(snapshot, env).filter((row) => row.category === categoryId);
      const matchedCats = new Set(rows.map((row) => row.category));

      container.innerHTML = "";
      const shell = document.createElement("div");
      shell.className = "settings-shell";

      const nav = document.createElement("nav");
      nav.className = "settings-nav";
      nav.setAttribute("aria-label", "Settings categories");
      if (modal && onClose) {
        const back = document.createElement("button");
        back.type = "button";
        back.className = "settings-back";
        back.setAttribute("aria-label", "Back to app");
        const arrow = document.createElement("span");
        arrow.className = "settings-back-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "←";
        const backLabel = document.createElement("span");
        backLabel.className = "settings-back-label";
        backLabel.textContent = "Back to app";
        back.append(arrow, backLabel);
        back.onclick = (e) => { e.stopPropagation(); onClose(); };
        nav.appendChild(back);
      }
      const searchWrap = document.createElement("div");
      searchWrap.className = "settings-search-wrap";
      const search = document.createElement("input");
      search.type = "search";
      search.id = "settings-search";
      search.className = "settings-search";
      search.placeholder = "Search settings";
      search.setAttribute("aria-label", "Search settings");
      search.value = query;
      searchWrap.appendChild(search);
      nav.appendChild(searchWrap);
      const navList = document.createElement("div");
      navList.className = "settings-nav-list";
      if (phoneNav) navList.hidden = true;
      for (const cat of shownCats) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "settings-nav-item" + (cat.id === categoryId && !searching ? " active" : "");
        if (searching && !matchedCats.has(cat.id)) btn.classList.add("is-dim");
        btn.dataset.category = cat.id;
        const icon = document.createElement("span");
        icon.className = "settings-nav-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = NAV_ICONS[cat.id] || "";
        const label = document.createElement("span");
        label.className = "settings-nav-label";
        label.textContent = cat.title;
        btn.append(icon, label);
        navList.appendChild(btn);
      }
      nav.appendChild(navList);
      const navSelect = document.createElement("select");
      navSelect.className = "settings-nav-select settings-select";
      navSelect.id = "settings-category";
      navSelect.setAttribute("aria-label", "Settings category");
      if (!phoneNav) navSelect.hidden = true;
      for (const cat of shownCats) {
        const option = document.createElement("option");
        option.value = cat.id;
        option.textContent = cat.title;
        if (cat.id === categoryId) option.selected = true;
        navSelect.appendChild(option);
      }
      nav.appendChild(navSelect);

      const main = document.createElement("div");
      main.className = "settings-main";
      const head = document.createElement("div");
      head.className = "settings-head";
      const crumb = document.createElement("div");
      crumb.className = "settings-crumb";
      crumb.innerHTML = searching
        ? `<span>Settings</span><span class="settings-crumb-sep">/</span><span>Search</span>`
        : `<span>Settings</span><span class="settings-crumb-sep">/</span><span>${escapeHtml(page ? page.title : "General")}</span>`;
      head.appendChild(crumb);
      const headActions = document.createElement("div");
      headActions.className = "settings-head-actions";
      const changes = !searching && page && page.restore
        ? restoreChanges(page.id, snapshot, env)
        : [];
      if (changes.length && !pendingRestore) {
        const restore = document.createElement("button");
        restore.type = "button";
        restore.className = "settings-restore";
        restore.textContent = "Restore defaults";
        restore.onclick = (e) => { e.stopPropagation(); beginRestoreConfirm(); };
        headActions.appendChild(restore);
      }
      head.appendChild(headActions);
      main.appendChild(head);

      if (pendingRestore && pendingRestore.length && !searching) {
        const confirm = document.createElement("div");
        confirm.className = "settings-restore-confirm";
        confirm.setAttribute("role", "region");
        confirm.setAttribute("aria-label", "Confirm restore defaults");
        const lead = document.createElement("div");
        lead.className = "settings-restore-confirm-lead";
        lead.textContent = "These settings on this page will change:";
        const list = document.createElement("ul");
        list.className = "settings-restore-confirm-list";
        for (const row of pendingRestore) {
          const item = document.createElement("li");
          item.textContent = `${row.title} → ${restoreValueLabel(row, row.defaultValue)}`;
          list.appendChild(item);
        }
        const actions = document.createElement("div");
        actions.className = "settings-restore-confirm-actions";
        const go = document.createElement("button");
        go.type = "button";
        go.className = "settings-restore-confirm-go";
        go.textContent = "Restore";
        go.onclick = (e) => { e.stopPropagation(); commitRestoreConfirm(); };
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-restore-confirm-cancel";
        cancel.textContent = "Cancel";
        cancel.onclick = (e) => { e.stopPropagation(); cancelRestoreConfirm(); };
        actions.append(go, cancel);
        confirm.append(lead, list, actions);
        main.appendChild(confirm);
      }

      const body = document.createElement("div");
      body.className = "settings-body";
      if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "settings-empty";
        empty.textContent = searching ? "No settings match that search." : "No settings on this page.";
        body.appendChild(empty);
      } else if (searching) {
        let lastCat = "";
        for (const row of rows) {
          if (row.category !== lastCat) {
            lastCat = row.category;
            const heading = document.createElement("h2");
            heading.className = "settings-group";
            const cat = CATEGORIES.find((c) => c.id === row.category);
            heading.textContent = cat ? cat.title : row.category;
            body.appendChild(heading);
          }
          body.appendChild(renderRow(row, snapshot, env));
        }
      } else {
        for (const row of rows) body.appendChild(renderRow(row, snapshot, env));
        if (categoryId === "about") {
          const disclaimer = document.createElement("p");
          disclaimer.className = "settings-about-disclaimer";
          disclaimer.textContent = ABOUT_DISCLAIMER;
          body.appendChild(disclaimer);
        }
      }
      main.appendChild(body);
      shell.appendChild(nav);
      shell.appendChild(main);
      container.appendChild(shell);

      search.oninput = () => {
        query = search.value;
        dismissRestoreConfirm();
        paint();
        const next = container.querySelector("#settings-search");
        if (next) {
          next.focus();
          try { next.setSelectionRange(query.length, query.length); } catch { /* */ }
        }
      };
      function selectCategory(next) {
        if (!next) return;
        if (next !== "about") aboutChecked = false;
        categoryId = next;
        query = "";
        dismissRestoreConfirm();
        paint();
      }
      nav.querySelectorAll(".settings-nav-item").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          selectCategory(btn.dataset.category);
        });
      });
      navSelect.onchange = () => selectCategory(navSelect.value);
      body.querySelectorAll(".settings-row").forEach((el) => {
        const row = ROWS.find((r) => r.id === el.dataset.id);
        if (!row) return;
        if (row.kind === "toggle") {
          const sw = el.querySelector(".settings-switch");
          if (!sw || sw.disabled) return;
          sw.onclick = (e) => {
            e.stopPropagation();
            commit(row, !rowValue(row, snapshot));
          };
        } else if (row.kind === "select") {
          const select = el.querySelector("select");
          if (!select) return;
          select.onchange = () => commit(row, select.value);
        } else if (row.kind === "range") {
          const input = el.querySelector("input[type=range]");
          const out = el.querySelector("output");
          if (!input) return;
          input.oninput = () => { if (out) out.textContent = `${input.value}%`; };
          input.onchange = () => commit(row, Number(input.value));
        } else if (row.kind === "text") {
          const input = el.querySelector(".settings-text");
          if (!input) return;
          const flush = () => {
            if (input.value !== String(rowValue(row, snapshot) ?? "")) commit(row, input.value);
          };
          input.onchange = flush;
          input.onkeydown = (e) => {
            if (e.key === "Enter") { e.preventDefault(); flush(); }
          };
        } else if (row.kind === "tags") {
          const input = el.querySelector(".settings-tags-input");
          const current = () => {
            const got = rowValue(row, snapshot);
            return Array.isArray(got) ? got.slice() : [];
          };
          const addTerm = (raw) => {
            const term = String(raw || "").trim().slice(0, 50);
            if (!term) return;
            const next = current();
            if (next.some((t) => t.toLowerCase() === term.toLowerCase())) return;
            next.push(term);
            commit(row, next);
          };
          el.querySelectorAll(".settings-tag-remove").forEach((btn) => {
            btn.onclick = (e) => {
              e.stopPropagation();
              const chip = btn.closest(".settings-tag");
              const term = chip && chip.dataset.term;
              commit(row, current().filter((t) => t !== term));
            };
          });
          if (input) {
            input.onkeydown = (e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTerm(input.value);
              }
            };
            input.onchange = () => addTerm(input.value);
          }
        } else if (row.kind === "action") {
          const btn = el.querySelector(".settings-action");
          if (!btn) return;
          btn.onclick = (e) => { e.stopPropagation(); runAction(row); };
        }
      });
      applyFocus(container, focus);
    }

    function trapTab(e) {
      if (!modal || e.key !== "Tab") return false;
      const items = focusableControls(container);
      if (!items.length) {
        e.preventDefault();
        e.stopPropagation();
        return true;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = container.ownerDocument && container.ownerDocument.activeElement;
      if (e.shiftKey) {
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          e.stopPropagation();
          last.focus();
          return true;
        }
      } else if (active === last || !container.contains(active)) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
        return true;
      }
      return false;
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (onClose) onClose();
        return;
      }
      if (trapTab(e)) return;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      const search = container.querySelector("#settings-search");
      if (search) search.focus();
    }

    container._onKey = onKey;
    document.addEventListener("keydown", onKey, true);
    const view = container.ownerDocument && container.ownerDocument.defaultView;
    const phoneMq = view && view.matchMedia ? view.matchMedia(PHONE_NAV_MQ) : null;
    function onPhoneNavChange() {
      const next = matchPhoneNav(container.ownerDocument);
      if (next === phoneNav) return;
      phoneNav = next;
      paint();
    }
    if (phoneMq) {
      if (typeof phoneMq.addEventListener === "function") phoneMq.addEventListener("change", onPhoneNavChange);
      else if (typeof phoneMq.addListener === "function") phoneMq.addListener(onPhoneNavChange);
    }
    paint();

    return {
      update(nextSnapshot, nextEnv) {
        if (nextSnapshot) snapshot = defaultSnapshot({ ...snapshot, ...nextSnapshot });
        if (nextEnv) Object.assign(env, nextEnv);
        paint();
      },
      focusSearch() {
        const search = container.querySelector("#settings-search");
        if (search) search.focus();
      },
      setCategory(id) {
        if (id !== "about") aboutChecked = false;
        categoryId = id || "general";
        query = "";
        dismissRestoreConfirm();
        paint();
      },
      dispose() {
        document.removeEventListener("keydown", onKey, true);
        if (phoneMq) {
          if (typeof phoneMq.removeEventListener === "function") phoneMq.removeEventListener("change", onPhoneNavChange);
          else if (typeof phoneMq.removeListener === "function") phoneMq.removeListener(onPhoneNavChange);
        }
        if (modal) coverSiblings(container, false);
      },
      get snapshot() { return snapshot; },
      get category() { return categoryId; },
      get query() { return query; },
    };
  }

  const api = {
    CATEGORIES,
    NAV_ICONS,
    TELEMETRY_COPY,
    ABOUT_DISCLAIMER,
    GITHUB_REPO_URL,
    GITHUB_ISSUE_BUG_URL,
    GITHUB_ISSUE_FEATURE_URL,
    SUPPORT_MAILTO,
    ROWS,
    visibleRows,
    visibleCategories,
    filterRows,
    restoreTargets,
    restoreChanges,
    restoreValueLabel,
    isRestorableKind,
    rowEnabled,
    applyValue,
    defaultEnv,
    defaultSnapshot,
    mount,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GrokSettings = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
