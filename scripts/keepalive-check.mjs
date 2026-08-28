// Does traffic actually keep a real cloud machine running, and does silence let
// it go?
//
//   npm run smoke:keepalive -- <relay-url> [busySeconds] [quietSeconds]
//
// Needs CANARY_EMAIL / CANARY_FAPI_HOST / CANARY_PK and SPRITES_TOKEN, plus the
// Supabase pair to look up which machine is behind the environment. It OPENS a
// cloud environment on the target — a real machine, really woken — so it is an
// operator check rather than part of any gate.
//
// The unit tests prove the relay's bookkeeping and the earlier experiment proved
// a held session keeps a machine's own processes alive. This is the loop
// itself, against a real sprite through the deployed relay: a browser sends a
// message the host answers, the answer arrives as a frame, the frame refreshes
// the hold. Then it stops, and the machine has to fall asleep — a keep-alive
// that never lets go is a bill, not a feature.
import WebSocket from "ws";
process.loadEnvFile();

const RELAY = process.argv[2];
const BUSY_S = Number(process.argv[3] ?? 300);
const QUIET_S = Number(process.argv[4] ?? 300);
const EMAIL = process.env.CANARY_EMAIL;
const FAPI = process.env.CANARY_FAPI_HOST;
const PK = process.env.CANARY_PK;
const SPRITES = process.env.SPRITES_TOKEN;

const t0 = Date.now();
const el = () => `${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s`;
const say = (...a) => console.log(el(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mintSession() {
  let clientToken = null;
  const f = async (path, body, token) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(`https://${FAPI}${path}`, {
      method: "POST", headers, body: body && new URLSearchParams(body).toString(), redirect: "error",
    });
    const j = await res.json().catch(() => null);
    const auth = res.headers.get("authorization");
    if (auth) clientToken = auth;
    return j;
  };
  const created = await f("/v1/client/sign_ins?_is_native=1", { identifier: EMAIL }, PK);
  const id = created?.response?.id;
  if (created?.response?.status !== "complete") {
    const factor = created.response.supported_first_factors.find((x) => x.strategy === "email_code");
    await f(`/v1/client/sign_ins/${id}/prepare_first_factor?_is_native=1`,
      { strategy: "email_code", email_address_id: factor.email_address_id }, clientToken);
    await f(`/v1/client/sign_ins/${id}/attempt_first_factor?_is_native=1`,
      { strategy: "email_code", code: "424242" }, clientToken);
  }
  const client = await fetch(`https://${FAPI}/v1/client?_is_native=1`, {
    headers: { authorization: `Bearer ${clientToken}` },
  }).then((r) => r.json());
  const sid = client?.response?.last_active_session_id || client?.response?.sessions?.[0]?.id;
  return async () => (await f(`/v1/client/sessions/${sid}/tokens?_is_native=1`, {}, clientToken))?.jwt;
}

/**
 * The machine's status, or a THROW.
 *
 * Returning undefined here made the whole check pass without observing
 * anything: `undefined` is not `"running"`, so the quiet phase read it as
 * asleep, and the busy phase's falsy check read it as fine. A wrong Supabase
 * project, the wrong Sprites organisation, or a machine that is simply not
 * there would all have printed PASS.
 */
async function spriteStatus(name) {
  const j = await fetch("https://api.sprites.dev/v1/sprites", {
    headers: { authorization: `Bearer ${SPRITES}` },
  }).then((r) => r.json());
  const found = (Array.isArray(j) ? j : j.sprites || []).find((s) => s.name === name);
  if (!found?.status) throw new Error(`no sprite named ${name} — wrong token, org, or environment?`);
  return found.status;
}

const mint = await mintSession();
let jwt = await mint();
setInterval(async () => { try { jwt = (await mint()) ?? jwt; } catch { /* keep it */ } }, 40_000).unref();

const opened = await fetch(`${RELAY}/api/cloud/open`, {
  method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: "{}",
}).then((r) => r.json());
const deviceId = opened.deviceId;
if (!deviceId) {
  say("FAIL — /api/cloud/open gave no device:", JSON.stringify(opened));
  process.exit(1);
}
say("device", deviceId);

const env = await fetch(`${process.env.SUPABASE_URL}/rest/v1/environments?select=external_id&device_id=eq.${deviceId}`, {
  headers: { apikey: process.env.SUPABASE_SECRET_KEY, authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` },
}).then((r) => r.json());
const sprite = env?.[0]?.external_id;
if (!sprite) {
  say("FAIL — no environment row for", deviceId, "— nothing to watch");
  process.exit(1);
}
say("machine", sprite);
// Prove it is reachable BEFORE measuring anything, so a misconfiguration is an
// error at the top rather than a green run that watched nothing.
say("initial status", await spriteStatus(sprite));

// A browser tab. Every message it sends draws an answer from the host, and the
// answer is what the relay counts.
const ws = new WebSocket(`${RELAY.replace(/^http/, "ws")}/client?device=${encodeURIComponent(deviceId)}`, {
  headers: { authorization: `Bearer ${jwt}` },
});
let replies = 0;
ws.on("message", () => { replies += 1; });
ws.on("error", (e) => say("browser error:", e.message));
await new Promise((r) => { ws.once("open", r); ws.once("error", r); });
ws.send(JSON.stringify({ type: "ready" }));
say("browser attached");

say(`BUSY for ${BUSY_S}s — one host round trip a minute`);
let worst = null;
for (let i = 0; i < BUSY_S; i += 30) {
  // Every other tick, so the gaps are ~60s: comfortably inside the relay's
  // 90-second window but well past the hypervisor's own ~60-second one, which
  // is the whole point.
  if (i % 60 === 0) ws.send(JSON.stringify({ type: "listSessions", offset: 0, query: "" }));
  await sleep(30_000);
  const st = await spriteStatus(sprite);
  say(`  busy +${i + 30}s sprite=${st} replies=${replies}`);
  if (st !== "running") worst = st;
}
say(worst ? `BUSY FAIL — went ${worst} while being used` : "BUSY PASS — stayed running throughout");

ws.close();
say(`QUIET for ${QUIET_S}s — nothing attached, nothing sent`);
let slept = null;
for (let i = 0; i < QUIET_S; i += 30) {
  await sleep(30_000);
  const st = await spriteStatus(sprite);
  say(`  quiet +${i + 30}s sprite=${st}`);
  if (st !== "running" && slept === null) slept = i + 30;
}
say(slept !== null
  ? `QUIET PASS — asleep ${slept}s after the last traffic`
  : `QUIET FAIL — still running ${QUIET_S}s after the last traffic`);
process.exit(!worst && slept !== null ? 0 : 1);
