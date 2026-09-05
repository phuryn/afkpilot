/**
 * Which cloud machine belongs to whom.
 *
 * `refresh-sprite-hosts.mjs` and `verify-sprite-hosts.mjs` can only say
 * "in use" or "unclaimed" — the provider knows a machine is claimed, not who
 * claimed it. The owner lives in Supabase: `environments.external_id` is the
 * sprite name and `environments.user_id` is the Clerk id that took it.
 *
 * This exists because guessing is worse than useless. Patching the wrong
 * machine hands somebody an unchanged host and invites a bug report about its
 * age, and an unclaimed machine cannot be tested on by the person who needs it.
 * A CLAIM IS NOT STABLE, so look it up every time rather than remembering an
 * answer from a previous session.
 *
 *     node scripts/whose-sprite.mjs                     # everyone, dev estate
 *     node scripts/whose-sprite.mjs someone@example.com # just theirs
 *     node scripts/whose-sprite.mjs --production
 *
 * Reads SUPABASE_URL / SUPABASE_SECRET_KEY / CLERK_SECRET_KEY from the
 * environment or this repo's gitignored .env. Read-only: it issues GETs and
 * has no write path.
 */
import { readFileSync } from "node:fs";

const PRODUCTION = process.argv.includes("--production");
const WANTED = process.argv.slice(2).find((a) => !a.startsWith("--"))?.toLowerCase();

function env(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const line = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
  } catch { /* environment is the supported path */ }
  return "";
}

const suffix = PRODUCTION ? "_PRODUCTION" : "";
const SUPABASE_URL = env(`SUPABASE_URL${suffix}`) || env("SUPABASE_URL");
const SUPABASE_KEY = env(`SUPABASE_SECRET_KEY${suffix}`) || env("SUPABASE_SECRET_KEY");
const CLERK_KEY = env(`CLERK_SECRET_KEY${suffix}`) || env("CLERK_SECRET_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("No SUPABASE_URL / SUPABASE_SECRET_KEY. Set them in the environment or this repo's .env.");
  process.exit(2);
}

const rows = await (await fetch(
  `${SUPABASE_URL}/rest/v1/environments?select=external_id,user_id,provider,wake_at,created_at&order=created_at.desc`,
  { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } },
)).json();

if (!Array.isArray(rows)) {
  console.error("Unexpected response from Supabase:", JSON.stringify(rows).slice(0, 300));
  process.exit(1);
}

// One Clerk lookup per distinct owner, not per row.
const emails = new Map();
if (CLERK_KEY) {
  for (const id of new Set(rows.map((r) => r.user_id))) {
    try {
      const user = await (await fetch(`https://api.clerk.com/v1/users/${id}`, {
        headers: { authorization: `Bearer ${CLERK_KEY}` },
      })).json();
      const primary = (user.email_addresses || [])
        .find((e) => e.id === user.primary_email_address_id) || (user.email_addresses || [])[0];
      if (primary?.email_address) emails.set(id, primary.email_address);
    } catch { /* an id with no readable user still prints, as the id */ }
  }
}

console.log(`estate: ${PRODUCTION ? "production" : "dev"} · environments: ${rows.length}`);
if (!CLERK_KEY) console.log("(no CLERK_SECRET_KEY — showing user ids, not emails)");

let shown = 0;
for (const row of rows) {
  const who = emails.get(row.user_id) || row.user_id;
  if (WANTED && who.toLowerCase() !== WANTED && row.user_id.toLowerCase() !== WANTED) continue;
  shown++;
  console.log(`\n  ${row.external_id}`);
  console.log(`    owner    ${who}`);
  console.log(`    provider ${row.provider}`);
  console.log(`    claimed  ${row.created_at}`);
  if (row.wake_at) console.log(`    wake_at  ${row.wake_at}`);
}

if (WANTED && shown === 0) {
  console.log(`\nNothing claimed by ${WANTED} on the ${PRODUCTION ? "production" : "dev"} estate.`);
  process.exit(1);
}
