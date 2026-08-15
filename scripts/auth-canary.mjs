// Authenticated deploy canary — the approve→list→connect mile that
// `npm run smoke` cannot see (that script is session-free by design).
// Drives a real signed-in user through link → approve → list → uplink →
// client → revoke against a LIVE deployment (DEV or production).
//
//   node scripts/auth-canary.mjs [url]
//   npm run smoke:auth -- [url]
//
// Defaults to a local relay (http://127.0.0.1:8787). Exit 0 = every step passed;
// exit 1 on the first failure (step + HTTP status / WS close code + hint).
//
// Auth (first match):
//   CANARY_CLERK_SECRET_KEY + CANARY_USER_ID
//     mint via @clerk/backend sessions.createSession + getToken
//   CANARY_EMAIL + CANARY_PASSWORD
//     sign in via the instance Frontend API (native, ?_is_native=1)
//   CANARY_EMAIL alone (passwordless test-mode user)
//     sign in via FAPI with the email_code FIRST factor; the code comes from
//     CANARY_EMAIL_CODE or, for +clerk_test@ addresses, Clerk's fixed
//     test-mode code 424242 (instance Test mode must be ON — no email sent)
//   Both FAPI modes: Device Trust (`needs_client_trust`) is completed with
//     the same code source, and both
//     REQUIRE a pinned FAPI host: CANARY_FAPI_HOST (production:
//     clerk.afkpilot.com), or derived from CLERK_PUBLISHABLE_KEY in .env —
//     the target's /api/config never decides where credentials are sent
//   mock mode (GET /api/config → publishableKey:null)
//     any Bearer token; no Clerk
//
// Session JWTs live ~60s — reminted when older than 30s.
// Backend-minted tokens and native FAPI tokens both carry NO azp — which is
// fine since 2026-08-14: the relay's verifier passes an absent azp and rejects
// only a present-but-unlisted one (auth.ts azpAllowed). A 401 here against an
// OLDER deployment usually means its library-enforced azp check — the hint
// names it. Never prints tokens, passwords, or the device token.

import WebSocket from "ws";
import { createClerkClient } from "@clerk/backend";

try {
  process.loadEnvFile();
} catch {
  /* no .env */
}

const DEFAULT_TARGET = "http://127.0.0.1:8787";
const DEVICE_NAME = "smoke-canary";
const TOKEN_MAX_AGE_MS = 30_000;
const HTTP_TIMEOUT_MS = 20_000;
const WS_TIMEOUT_MS = 15_000;

const base = (process.argv[2] || DEFAULT_TARGET).replace(/\/+$/, "");
const wsBase = base.replace(/^http/, "ws");
const closeHints = {
  4001: "4001 token dead — re-link, don't retry",
  4002: "4002 device already has a live uplink",
  4003: "4003 unowned / missing / unknown device",
  4004: "4004 no session on the /client upgrade",
  4005: "4005 entitlement missing on the /client upgrade",
  4006: "4006 protocol refusal (hello missing or proto newer than the relay)",
  1011: "1011 registry/session error — retry, do not re-link",
};

const state = {
  mode: "unset",
  minter: null,
  sessionOk: false,
  deviceId: null,
  deviceToken: null,
  uplink: null,
  client: null,
  lastAzp: "n/a",
};

function pass(name, detail = "") {
  console.log(`[canary] PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "", hint = "") {
  const err = new Error(`${name}${detail ? ` — ${detail}` : ""}`);
  err.step = name;
  err.detail = detail;
  err.hint = hint;
  throw err;
}

function hintForClose(code) {
  return closeHints[code] || `close ${code}`;
}

function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function describeAzp(token) {
  if (!token || !token.includes(".")) return "n/a (not a JWT)";
  const azp = jwtPayload(token).azp;
  state.lastAzp = azp === undefined || azp === null || azp === "" ? "absent" : String(azp);
  return state.lastAzp;
}

function fapiHostFromPublishableKey(pk) {
  const body = pk.replace(/^pk_(test|live)_/, "");
  try {
    return Buffer.from(body, "base64").toString("utf8").replace(/\$$/, "");
  } catch {
    return "";
  }
}

function authHeader(value) {
  if (!value) return "";
  return value.startsWith("Bearer ") || value.startsWith("bearer ") ? value : `Bearer ${value}`;
}

async function fetchJson(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body,
      redirect: "manual",
      signal: ctrl.signal,
    });
  } catch (e) {
    fail(opts.step || path, `request failed: ${e.name === "AbortError" ? "timeout" : e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 200) };
    }
  }
  return { status: res.status, body, headers: res.headers };
}

function openWs(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
      reject(Object.assign(new Error("timeout opening websocket"), { code: "timeout" }));
    }, WS_TIMEOUT_MS);
    const finish = (fn) => (arg) => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("close", onClose);
      fn(arg);
    };
    const onOpen = finish(() => resolve(ws));
    const onClose = finish((code, reason) => {
      reject(
        Object.assign(new Error(`closed ${code}`), {
          code,
          reason: String(reason || ""),
        }),
      );
    });
    ws.once("open", onOpen);
    ws.once("close", onClose);
    ws.once("error", () => {
      /* close follows with the code */
    });
  });
}

function inbox(ws) {
  const q = [];
  let waiter = null;
  const onMessage = (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(m);
    } else q.push(m);
  };
  ws.on("message", onMessage);
  return {
    next(timeout = WS_TIMEOUT_MS) {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          waiter = null;
          reject(new Error("timed out waiting for websocket frame"));
        }, timeout);
        waiter = (m) => {
          clearTimeout(t);
          resolve(m);
        };
      });
    },
    async matching(pred, timeout = WS_TIMEOUT_MS) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const m = await this.next(Math.max(1, deadline - Date.now()));
        if (pred(m)) return m;
      }
      throw new Error("no matching websocket frame before timeout");
    },
  };
}

function waitClose(ws, timeout = WS_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve({ code: ws._closeCode ?? 0, reason: "" });
      return;
    }
    const timer = setTimeout(() => resolve({ code: "timeout", reason: "" }), timeout);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: String(reason || "") });
    });
  });
}

function closeQuiet(ws) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  } catch {
    /* already gone */
  }
}

function makeSecretKeyMinter(secretKey, userId) {
  const clerk = createClerkClient({ secretKey });
  let sessionId = null;
  return {
    label: "secret-key",
    async mint() {
      if (!sessionId) {
        const session = await clerk.sessions.createSession({ userId });
        sessionId = session.id;
      }
      const { jwt } = await clerk.sessions.getToken(sessionId);
      if (!jwt) fail("mint session", "Clerk getToken returned no jwt", "session vs entitlement");
      return jwt;
    },
    async revoke() {
      if (!sessionId) return;
      try {
        await clerk.sessions.revokeSession(sessionId);
      } catch {
        /* already expired */
      }
    },
  };
}

function expectedFapiHost() {
  // The target's /api/config is UNTRUSTED input for password mode: decoding
  // its publishable key into a hostname and posting credentials there would
  // let a mistargeted or compromised relay choose where the password goes.
  // So the FAPI host must be pinned from the local environment: explicitly
  // via CANARY_FAPI_HOST, or derived from the .env CLERK_PUBLISHABLE_KEY.
  const explicit = (process.env.CANARY_FAPI_HOST || "").trim().toLowerCase();
  if (explicit) {
    // Hostname ONLY — a value like "good.example@evil.example" would compare
    // against the decoded key but URL-parse to the attacker half.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(explicit)) {
      fail("password auth", "CANARY_FAPI_HOST must be a bare hostname (no scheme, port, path, or credentials)");
    }
    return explicit;
  }
  const pk = (process.env.CLERK_PUBLISHABLE_KEY || "").trim();
  if (pk) return fapiHostFromPublishableKey(pk).toLowerCase();
  return "";
}

function makeFapiMinter(publishableKey, email, password) {
  // password may be empty: then the sign-in uses the email_code FIRST factor
  // (test-mode users have no password; the fixed code stands in for email).
  const label = password ? "password" : "email-code";
  const credsHint = password
    ? "check CANARY_EMAIL / CANARY_PASSWORD"
    : "check CANARY_EMAIL / CANARY_EMAIL_CODE (test-mode code 424242 for +clerk_test@ addresses; instance Test mode must be ON)";
  const fapi = fapiHostFromPublishableKey(publishableKey);
  if (!fapi) fail(`${label} auth`, "could not derive FAPI host from publishable key");
  const pinned = expectedFapiHost();
  if (!pinned) {
    fail(
      `${label} auth`,
      "no trusted FAPI host pinned in the environment",
      "set CANARY_FAPI_HOST (e.g. clerk.afkpilot.com for production) or CLERK_PUBLISHABLE_KEY in .env — credentials are never sent to a host chosen by the target",
    );
  }
  if (fapi.toLowerCase() !== pinned) {
    fail(
      `${label} auth`,
      `target's publishable key decodes to "${fapi}" but the pinned FAPI host is "${pinned}"`,
      "refusing to send credentials to a host the target chose; update CANARY_FAPI_HOST if the instance really moved",
    );
  }
  let clientToken = null;
  let sessionId = null;

  async function fapiFetch(method, path, { body, token } = {}) {
    // Native FAPI: Authorization XOR Origin. Origin is a browser header;
    // this script is a native client, so we only send Authorization.
    // https is hardcoded and redirects are refused — a credential POST must
    // land on the pinned host or nowhere.
    const headers = {};
    if (token) headers.authorization = authHeader(token);
    if (body !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(`https://${fapi}${path}`, {
      method,
      headers,
      body,
      redirect: "error",
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 200) };
      }
    }
    return { status: res.status, json, authorization: res.headers.get("authorization") };
  }

  function clerkErrors(json) {
    const errs = json?.errors || json?.response?.errors;
    if (!Array.isArray(errs) || errs.length === 0) return "";
    return errs
      .map((e) => e.long_message || e.message || e.code || JSON.stringify(e))
      .join("; ");
  }

  function pickSessionId(json) {
    return (
      json?.response?.created_session_id ||
      json?.created_session_id ||
      json?.client?.signed_in_session_id ||
      json?.client?.last_active_session_id ||
      json?.client?.sessions?.[0]?.id ||
      json?.response?.sessions?.[0]?.id ||
      null
    );
  }

  function signInIdOf(json) {
    return json?.response?.id || json?.id || null;
  }

  function signInStatusOf(json) {
    return json?.response?.status || json?.status || null;
  }

  function trustCode() {
    if (process.env.CANARY_EMAIL_CODE) return process.env.CANARY_EMAIL_CODE;
    // Clerk test-mode addresses accept the fixed code and never send email.
    if (email.includes("+clerk_test@")) return "424242";
    return "";
  }

  async function advance(path, body) {
    const res = await fapiFetch("POST", path, {
      token: clientToken || publishableKey,
      body: new URLSearchParams(body).toString(),
    });
    if (res.authorization) clientToken = res.authorization;
    return res;
  }

  async function establishClientTrust(json) {
    const id = signInIdOf(json);
    if (!id) fail(`${label} sign-in`, "needs_client_trust but sign-in id missing");
    const code = trustCode();
    if (!code) {
      fail(
        `${label} sign-in`,
        "needs_client_trust (Device Trust) and no email code available",
        "set CANARY_EMAIL_CODE, or use a +clerk_test@ address (code 424242)",
      );
    }
    const factors =
      json?.response?.supported_second_factors ||
      json?.response?.supportedSecondFactors ||
      json?.supported_second_factors ||
      [];
    const emailFactor = Array.isArray(factors)
      ? factors.find((f) => f && f.strategy === "email_code")
      : null;
    const strategy = emailFactor?.strategy || "email_code";
    const prepared = await advance(`/v1/client/sign_ins/${id}/prepare_second_factor?_is_native=1`, {
      strategy,
      ...(emailFactor?.email_address_id ? { email_address_id: emailFactor.email_address_id } : {}),
    });
    if (prepared.status >= 400) {
      fail(
        `${label} sign-in`,
        `needs_client_trust prepare HTTP ${prepared.status} ${clerkErrors(prepared.json)}`.trim(),
      );
    }
    const verified = await advance(`/v1/client/sign_ins/${id}/attempt_second_factor?_is_native=1`, {
      strategy,
      code,
    });
    return verified;
  }

  return {
    label,
    fapi,
    async mint() {
      if (!clientToken || !sessionId) {
        const createBody = password
          ? { identifier: email, password, strategy: "password" }
          : { identifier: email };
        const created = await fapiFetch("POST", "/v1/client/sign_ins?_is_native=1", {
          token: publishableKey,
          body: new URLSearchParams(createBody).toString(),
        });
        if (created.authorization) clientToken = created.authorization;
        if (created.status >= 400) {
          fail(
            `${label} sign-in`,
            `HTTP ${created.status} ${clerkErrors(created.json)}`.trim(),
            credsHint,
          );
        }
        let json = created.json;
        let status = signInStatusOf(json);
        let sid = pickSessionId(json);
        const id = signInIdOf(json);

        if (status === "needs_first_factor" && id && password) {
          const attempt = await advance(`/v1/client/sign_ins/${id}/attempt_first_factor?_is_native=1`, {
            strategy: "password",
            password,
          });
          json = attempt.json;
          status = signInStatusOf(json);
          sid = pickSessionId(json) || sid;
          if (attempt.status >= 400) {
            fail(
              `${label} sign-in`,
              `first-factor HTTP ${attempt.status} status=${status || "?"} ${clerkErrors(json)}`.trim(),
              credsHint,
            );
          }
        } else if (status === "needs_first_factor" && id) {
          const factors =
            json?.response?.supported_first_factors ||
            json?.supported_first_factors ||
            [];
          const emailFactor = Array.isArray(factors)
            ? factors.find((f) => f && f.strategy === "email_code")
            : null;
          if (!emailFactor) {
            fail(
              `${label} sign-in`,
              "the instance offers no email_code first factor for this user",
              "set CANARY_PASSWORD to use password mode instead",
            );
          }
          const code = trustCode();
          if (!code) fail(`${label} sign-in`, "no email code available", credsHint);
          const prepared = await advance(`/v1/client/sign_ins/${id}/prepare_first_factor?_is_native=1`, {
            strategy: "email_code",
            ...(emailFactor.email_address_id ? { email_address_id: emailFactor.email_address_id } : {}),
          });
          if (prepared.status >= 400) {
            fail(
              `${label} sign-in`,
              `first-factor prepare HTTP ${prepared.status} ${clerkErrors(prepared.json)}`.trim(),
              credsHint,
            );
          }
          const attempt = await advance(`/v1/client/sign_ins/${id}/attempt_first_factor?_is_native=1`, {
            strategy: "email_code",
            code,
          });
          json = attempt.json;
          status = signInStatusOf(json);
          sid = pickSessionId(json) || sid;
          if (attempt.status >= 400) {
            fail(
              `${label} sign-in`,
              `first-factor HTTP ${attempt.status} status=${status || "?"} ${clerkErrors(json)}`.trim(),
              credsHint,
            );
          }
        }

        if (status === "needs_client_trust") {
          const trusted = await establishClientTrust(json);
          json = trusted.json;
          status = signInStatusOf(json);
          sid = pickSessionId(json) || sid;
          if (trusted.status >= 400 || status !== "complete") {
            fail(
              `${label} sign-in`,
              `client-trust HTTP ${trusted.status} status=${status || "?"} ${clerkErrors(json)}`.trim(),
              "Device Trust email code rejected — set CANARY_EMAIL_CODE or use a +clerk_test@ address",
            );
          }
        }

        if (status !== "complete" || !sid || !clientToken) {
          fail(
            `${label} sign-in`,
            `HTTP ${created.status} status=${status || "?"} ${clerkErrors(json)}`.trim(),
            `${credsHint}; FAPI native sign-in did not complete`,
          );
        }
        sessionId = sid;
      }
      // Spec: GET /v1/client/sessions/{id}/tokens. Clerk's FAPI documents POST
      // for the same path — try GET first, fall back to POST on 404/405.
      const tokenPath = `/v1/client/sessions/${sessionId}/tokens?_is_native=1`;
      let minted = await fapiFetch("GET", tokenPath, { token: clientToken });
      if (minted.status === 404 || minted.status === 405) {
        minted = await fapiFetch("POST", tokenPath, { token: clientToken });
      }
      const jwt = minted.json?.jwt || minted.json?.response?.jwt;
      if (minted.status >= 400 || !jwt) {
        fail(
          `${label} mint token`,
          `HTTP ${minted.status} ${clerkErrors(minted.json)}`.trim(),
          "FAPI /v1/client/sessions/{id}/tokens rejected the client token",
        );
      }
      return jwt;
    },
    async revoke() {
      // A password sign-in creates a real server-side Clerk session with a
      // multi-day lifetime — the 60s JWT expiry does not end it. Scheduled
      // runs would accumulate live sessions, so end it explicitly.
      if (!sessionId || !clientToken) return;
      try {
        const removed = await fapiFetch("POST", `/v1/client/sessions/${sessionId}/remove?_is_native=1`, {
          token: clientToken,
        });
        if (removed.status >= 400) {
          console.error(`[canary] cleanup warning: Clerk session removal HTTP ${removed.status} — the session ages out on its own`);
          return; // keep sessionId so a caller could retry
        }
      } catch {
        console.error("[canary] cleanup warning: Clerk session removal failed — the session ages out on its own");
        return;
      }
      sessionId = null;
    },
  };
}

function makeMockMinter() {
  return {
    label: "mock",
    async mint() {
      return "canary-mock-session";
    },
    async revoke() {},
  };
}

function sessionHolder(minter) {
  let token = null;
  let mintedAt = 0;
  return async function sessionToken() {
    if (!token || Date.now() - mintedAt > TOKEN_MAX_AGE_MS) {
      token = await minter.mint();
      mintedAt = Date.now();
      describeAzp(token);
    }
    return token;
  };
}

async function rest(step, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.session) {
    headers.authorization = `Bearer ${await opts.session()}`;
  }
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
  }
  return fetchJson(path, {
    step,
    method: opts.method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
}

async function sweepLeftovers(session, exceptId = null) {
  const listed = await rest("GET /api/devices (sweep)", "/api/devices", { session });
  if (listed.status !== 200 || !Array.isArray(listed.body?.devices)) {
    fail(
      "GET /api/devices (sweep)",
      `HTTP ${listed.status} ${listed.body?.error || ""} azp=${state.lastAzp}`.trim(),
      listed.status === 401
        ? "session — token rejected (expired, bad signature, or azp not in CLERK_AUTHORIZED_PARTIES)"
        : listed.status === 403
          ? "entitlement"
          : "",
    );
  }
  // EXACT name match only — the canary always links as exactly DEVICE_NAME,
  // so crashed runs are still swept, while a user's real device that merely
  // starts with the prefix ("smoke-canary-laptop") is never touched. A
  // display-name prefix is not deletion authority.
  const leftovers = listed.body.devices.filter(
    (d) => d.name === DEVICE_NAME && d.deviceId !== exceptId,
  );
  let removed = 0;
  for (const d of leftovers) {
    const del = await rest(`DELETE leftover ${d.deviceId}`, `/api/devices/${encodeURIComponent(d.deviceId)}`, {
      method: "DELETE",
      session,
    });
    if (del.status === 200 && del.body?.ok === true) removed += 1;
    else {
      fail(
        "DELETE leftover smoke-canary device",
        `HTTP ${del.status} deviceId=${d.deviceId} ${del.body?.error || ""}`.trim(),
      );
    }
  }
  return { remaining: listed.body.devices.length - removed, removed };
}

async function cleanup(session) {
  closeQuiet(state.client);
  closeQuiet(state.uplink);
  state.client = null;
  state.uplink = null;
  if (!session) return { revoked: false, swept: 0 };
  if (state.deviceId) {
    const del = await rest("DELETE /api/devices/{id}", `/api/devices/${encodeURIComponent(state.deviceId)}`, {
      method: "DELETE",
      session,
    });
    if (del.status !== 200 || del.body?.ok !== true) {
      fail(
        "DELETE /api/devices/{id}",
        `HTTP ${del.status} ${del.body?.error || ""}`.trim(),
        del.status === 404 ? "unknown / not-owned" : del.status === 401 ? "session" : "",
      );
    }
    pass("DELETE /api/devices/{id}", "ok");
    state.deviceId = null;
  }
  const swept = await sweepLeftovers(session);
  pass("sweep leftover smoke-canary devices", `${swept.removed} removed, ${swept.remaining} other devices remain`);
  return swept;
}

function pickMinter(cfg) {
  const secret = process.env.CANARY_CLERK_SECRET_KEY;
  const userId = process.env.CANARY_USER_ID;
  const email = process.env.CANARY_EMAIL;
  const password = process.env.CANARY_PASSWORD;
  const mockMode = !cfg.publishableKey;

  if (mockMode) {
    if (secret || email) {
      console.log("[canary] NOTE: target is mock mode (publishableKey:null) — skipping Clerk, using a dummy Bearer token");
    }
    return makeMockMinter();
  }
  if (secret && userId) return makeSecretKeyMinter(secret, userId);
  if (email && password) return makeFapiMinter(cfg.publishableKey, email, password);
  if (email && (process.env.CANARY_EMAIL_CODE || email.includes("+clerk_test@"))) {
    return makeFapiMinter(cfg.publishableKey, email, "");
  }
  if (secret && !userId) {
    fail(
      "auth mode",
      "CANARY_CLERK_SECRET_KEY is set but CANARY_USER_ID is missing",
      "secret-key mode needs both; password mode needs CANARY_EMAIL + CANARY_PASSWORD",
    );
  }
  if ((email && !password) || (!email && password)) {
    fail(
      "auth mode",
      "CANARY_EMAIL without CANARY_PASSWORD works only in email-code mode (CANARY_EMAIL_CODE set, or a +clerk_test@ address)",
      "or set CANARY_CLERK_SECRET_KEY + CANARY_USER_ID for secret-key mode",
    );
  }
  fail(
    "auth mode",
    "no credentials: set CANARY_CLERK_SECRET_KEY+CANARY_USER_ID or CANARY_EMAIL+CANARY_PASSWORD",
  );
}

async function run() {
  console.log(`[canary] target: ${base}`);

  const config = await fetchJson("/api/config", { step: "GET /api/config" });
  if (config.status !== 200 || !("publishableKey" in (config.body || {}))) {
    fail("GET /api/config", `HTTP ${config.status}`);
  }
  const cfg = config.body;
  pass(
    "GET /api/config",
    `publishableKey=${cfg.publishableKey ? cfg.publishableKey.slice(0, 8) + "…" : "null"} requiredFeature=${cfg.requiredFeature ?? "null"}`,
  );

  state.minter = pickMinter(cfg);
  state.mode = state.minter.label;
  console.log(`[canary] auth mode: ${state.mode}`);
  const session = sessionHolder(state.minter);

  // First mint — also surfaces azp so a later 401 can name it.
  await session();
  state.sessionOk = true;
  pass("obtain session", `mode=${state.mode} azp=${state.lastAzp}`);

  await sweepLeftovers(session);
  pass("pre-sweep leftover smoke-canary devices");

  const started = await rest("POST /api/link/start", "/api/link/start", {
    method: "POST",
    json: { name: DEVICE_NAME },
  });
  const code = started.body?.code;
  if (started.status !== 200 || typeof code !== "string" || !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
    fail("POST /api/link/start", `HTTP ${started.status} ${started.body?.error || "no code"}`.trim());
  }
  pass("POST /api/link/start", "code issued");

  const approved = await rest("POST /api/link/approve", "/api/link/approve", {
    method: "POST",
    session,
    json: { code },
  });
  if (approved.status !== 200 || approved.body?.ok !== true || typeof approved.body?.deviceId !== "string") {
    const which =
      approved.status === 401
        ? "session (401 auth)"
        : approved.status === 403
          ? `entitlement (403 ${approved.body?.reason || approved.body?.error || "entitlement"})`
          : `HTTP ${approved.status}`;
    fail(
      "POST /api/link/approve",
      `${which} azp=${state.lastAzp}`,
      approved.status === 401
        ? "session — token rejected (expired, bad signature, or azp not in CLERK_AUTHORIZED_PARTIES)"
        : approved.status === 403
          ? "entitlement — user lacks RELAY_REQUIRED_FEATURE and is over the free-tier device cap"
          : "",
    );
  }
  state.deviceId = approved.body.deviceId;
  pass("POST /api/link/approve", "ok, device issued");

  const polled = await rest("POST /api/link/poll", "/api/link/poll", {
    method: "POST",
    json: { code },
  });
  if (polled.status !== 200 || polled.body?.status !== "approved" || typeof polled.body?.token !== "string") {
    fail(
      "POST /api/link/poll",
      `HTTP ${polled.status} status=${polled.body?.status || "?"} (no token)`,
    );
  }
  state.deviceToken = polled.body.token;
  pass("POST /api/link/poll", "approved");

  const listed = await rest("GET /api/devices", "/api/devices", { session });
  if (listed.status !== 200 || !Array.isArray(listed.body?.devices)) {
    fail(
      "GET /api/devices",
      `HTTP ${listed.status} ${listed.body?.error || ""} azp=${state.lastAzp}`.trim(),
      listed.status === 401
        ? "session — token rejected (expired, bad signature, or azp not in CLERK_AUTHORIZED_PARTIES)"
        : listed.status === 403
          ? "entitlement"
          : "",
    );
  }
  const row = listed.body.devices.find((d) => d.deviceId === state.deviceId);
  if (!row) {
    fail(
      "GET /api/devices contains new deviceId",
      `issued device not in list (${listed.body.devices.length} rows) — this is the #111/#112 truncation class`,
    );
  }
  pass("GET /api/devices contains new deviceId", `online=${row.online === true}`);

  let uplink;
  try {
    uplink = await openWs(`${wsBase}/uplink?token=${encodeURIComponent(state.deviceToken)}`);
  } catch (e) {
    fail("WS /uplink", `${e.message}`, hintForClose(e.code));
  }
  state.uplink = uplink;
  const upbox = inbox(uplink);
  uplink.send(JSON.stringify({ t: "hello", proto: 1, device: { name: DEVICE_NAME } }));
  pass("WS /uplink + hello", "open");

  const listedOnline = await rest("GET /api/devices (online)", "/api/devices", { session });
  if (listedOnline.status !== 200 || !Array.isArray(listedOnline.body?.devices)) {
    fail("GET /api/devices (online)", `HTTP ${listedOnline.status}`);
  }
  const onlineRow = listedOnline.body.devices.find((d) => d.deviceId === state.deviceId);
  if (!onlineRow || onlineRow.online !== true) {
    fail(
      "GET /api/devices shows online:true",
      `online=${onlineRow ? onlineRow.online : "row missing"}`,
    );
  }
  pass("GET /api/devices shows online:true");

  const cookieToken = await session();
  let client;
  let clientClose = { code: null, reason: "" };
  try {
    client = await openWs(`${wsBase}/client?device=${encodeURIComponent(state.deviceId)}`, {
      headers: { cookie: `__session=${cookieToken}` },
    });
  } catch (e) {
    fail("WS /client upgrade", `${e.message}`, hintForClose(e.code));
  }
  state.client = client;
  const clibox = inbox(client);
  const clientCloseP = waitClose(client);
  clientCloseP.then((c) => {
    clientClose = c;
  });

  // ready is buffered until admission; client-ready on the uplink is the
  // proof the upgrade was accepted (admission is async — the socket opens
  // first and may still close 4003/4004/4005).
  client.send(JSON.stringify({ type: "ready" }));
  let ready;
  try {
    ready = await Promise.race([
      upbox.matching((m) => m.t === "client-ready"),
      clientCloseP.then((c) => {
        const err = new Error(`client closed ${c.code}`);
        err.code = c.code;
        err.reason = c.reason;
        throw err;
      }),
    ]);
  } catch (e) {
    fail(
      "WS /client admitted + ready→client-ready",
      e.code !== undefined ? `closed ${e.code}${e.reason ? ` ${e.reason}` : ""}` : e.message,
      hintForClose(e.code),
    );
  }
  if (!ready || typeof ready.clientId !== "string") {
    fail("WS /client admitted + ready→client-ready", "uplink got client-ready without clientId");
  }
  pass("WS /client upgrade", "admitted (session cookie)");
  pass("ready → client-ready", `clientId received`);

  // Host→client routing via the snapshot the uplink owes a ready client.
  // Host state only — never a user send/steer (those meter the weekly quota).
  const SNAP_TYPE = "sessions";
  uplink.send(
    JSON.stringify({
      t: "snapshot",
      clientId: ready.clientId,
      msgs: [{ type: SNAP_TYPE, sessions: [] }],
    }),
  );
  let delivered;
  try {
    delivered = await Promise.race([
      clibox.matching((m) => m.type === SNAP_TYPE),
      clientCloseP.then((c) => {
        const err = new Error(`client closed ${c.code} before snapshot`);
        err.code = c.code;
        throw err;
      }),
    ]);
  } catch (e) {
    fail("snapshot host→client", e.message, hintForClose(e.code));
  }
  if (!delivered || delivered.type !== SNAP_TYPE) {
    fail("snapshot host→client", "client did not receive the snapshot HostMsg");
  }
  pass("snapshot host→client", "sync/attach routed");

  if (clientClose.code !== null && clientClose.code !== "timeout") {
    fail("WS /client stayed open", `closed ${clientClose.code}`, hintForClose(clientClose.code));
  }

  try {
    await cleanup(session);
  } finally {
    // Clerk-session removal must not be skipped by a device-cleanup throw.
    if (state.minter?.revoke) await state.minter.revoke();
  }
  console.log(`[canary] ALL STEPS PASSED (${state.mode})`);
}

run().catch(async (e) => {
  const step = e.step || "canary";
  const detail = e.detail || e.message || String(e);
  console.error(`[canary] FAIL  ${step}${detail && detail !== step ? ` — ${detail}` : ""}`);
  if (e.hint) console.error(`[canary] hint: ${e.hint}`);
  closeQuiet(state.client);
  closeQuiet(state.uplink);
  try {
    // REST-cleanup whenever a session was successfully obtained — an approve
    // that timed out AFTER the server committed the device leaves a row with
    // state.deviceId still null, and the exact-name sweep is what reclaims
    // it. A failure BEFORE "obtain session" means no token could sweep
    // anything either, so skip the noise.
    if (state.minter && state.sessionOk) {
      const session = sessionHolder(state.minter);
      try {
        await cleanup(session);
      } finally {
        if (state.minter?.revoke) await state.minter.revoke();
      }
    } else if (state.minter?.revoke) {
      await state.minter.revoke();
    }
  } catch (cleanErr) {
    console.error(`[canary] cleanup also failed: ${cleanErr.step || "cleanup"} — ${cleanErr.detail || cleanErr.message}`);
  }
  process.exit(1);
});
