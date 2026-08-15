// Unauthenticated deploy smoke — the checks that need NO session, so they run
// against PRODUCTION (where Clerk test mode doesn't exist; the full browser
// e2e stays dev-only). Verifies the relay is up, serving the rebranded pages,
// wired to Clerk, issuing link codes, and refusing both WS edges correctly.
//
//   node scripts/prod-smoke.mjs https://afkpilot.com
//   npm run smoke                       (defaults to http://127.0.0.1:8787)
//
// Exit 0 = every check passed. The authenticated mile (sign-in, approve,
// chat) is covered in dev by `npm run e2e:browser` + one manual prod run.

import WebSocket from "ws";

const base = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/+$/, "");
const wsBase = base.replace(/^http/, "ws");
let failures = 0;

function ok(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[smoke] ${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path) {
  const res = await fetch(`${base}${path}`, { redirect: "manual" });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

/** Open a WS and resolve with its close code (or "open" if it connected). */
function wsCloseCode(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* already dead */
      }
      resolve("timeout");
    }, 10_000);
    ws.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on("open", () => {
      // /client with no session must be REFUSED; give the async admission a
      // moment to close us. If nothing does, report "open" (a failure).
      setTimeout(() => {
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* noop */
        }
        resolve("open");
      }, 4000);
    });
    ws.on("error", () => {
      /* close event follows with the code */
    });
  });
}

console.log(`[smoke] target: ${base}`);

// --- liveness + config -------------------------------------------------------
const health = await get("/api/health");
ok("GET /api/health", health.status === 200 && JSON.parse(health.text).ok === true);

const config = await get("/api/config");
const cfg = config.status === 200 ? JSON.parse(config.text) : {};
ok("GET /api/config", config.status === 200 && "publishableKey" in cfg && "requiredFeature" in cfg);
const mockMode = !cfg.publishableKey;
if (mockMode) {
  console.log("[smoke] NOTE: publishableKey is null — MOCK auth mode (dev). Fine locally, wrong in prod.");
} else {
  ok("Clerk key is live in prod", !base.includes("127.0.0.1") ? cfg.publishableKey.startsWith("pk_live_") : true, cfg.publishableKey.slice(0, 8));
}

// --- pages (rebranded, reachable) -------------------------------------------
for (const [path, marker] of [
  ["/", "AFK Pilot"],
  ["/link", "AFK Pilot"],
  ["/chat", "AFK Pilot"],
  ["/desktop-update", "Grok Build Desktop"],
  ["/privacy", "AFK Pilot"],
  ["/terms", "AFK Pilot"],
]) {
  const page = await get(path);
  ok(`GET ${path}`, page.status === 200 && page.text.includes(marker));
}
const vendor = await get("/vendor/media/chat.js");
ok("GET /vendor/media/chat.js (sync-ui shipped)", vendor.status === 200 && vendor.text.length > 10_000);

// --- /download/<platform> resolves to a real installer -----------------------
// The one check that exercises the whole path: this deployment's cache, the
// GitHub lookup, and the asset match. A unit test can only prove the resolver
// picks the right name from a fixture — it cannot tell us the deployment can
// reach GitHub, which is the half that fails in the wild.
for (const platform of ["win-x64", "mac-arm64", "mac-x64"]) {
  const r = await fetch(`${base}/download/${platform}`, { redirect: "manual" })
    .catch((e) => ({ status: 0, headers: new Map(), error: String(e) }));
  const location = r.headers?.get?.("location") || "";
  const ext = platform.startsWith("mac") ? ".dmg" : ".exe";
  ok(
    `GET /download/${platform} → installer`,
    r.status === 302 && location.includes("github.com") && location.endsWith(ext),
    location || `status ${r.status}`,
  );
}

// --- ClerkJS reachable from the served origin --------------------------------
if (!mockMode) {
  // auth.js hot-loads ClerkJS from the instance FAPI encoded in the pk body.
  const fapi = atob(cfg.publishableKey.replace(/^pk_(test|live)_/, "")).replace(/\$$/, "");
  try {
    const env = await fetch(`https://${fapi}/v1/environment`, { method: "GET" });
    ok("Clerk FAPI reachable", env.status < 500, `https://${fapi}`);
  } catch (e) {
    ok("Clerk FAPI reachable", false, String(e));
  }
}

// --- link flow issues codes ---------------------------------------------------
const start = await fetch(`${base}/api/link/start`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "smoke probe (expires unused)" }),
});
const code = start.status === 200 ? (await start.json()).code : "";
ok("POST /api/link/start", /^[A-Z2-9]{8}$/.test(code), code ? "code issued" : `status ${start.status}`);

// --- WS edges refuse correctly ----------------------------------------------
const uplinkCode = await wsCloseCode(`${wsBase}/uplink?token=sk-device-bogus.bogus`);
ok("WS /uplink bad token → 4001", uplinkCode === 4001, `got ${uplinkCode}`);

const clientCode = await wsCloseCode(`${wsBase}/client?device=00000000-0000-0000-0000-000000000000`);
// Clerk mode: no session → 4004. Mock mode: session passes, unknown device → 4003.
const expected = mockMode ? 4003 : 4004;
ok(`WS /client no session → ${expected}`, clientCode === expected, `got ${clientCode}`);

console.log(failures === 0 ? "[smoke] ALL CHECKS PASSED" : `[smoke] ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
