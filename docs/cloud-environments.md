# Cloud environments

A cloud environment is a machine AFK Pilot runs for you. It appears in your
device list beside your laptop, holds its own projects and sessions, and you
drive it from a phone or a browser exactly as you drive a desk machine.

It exists because of the one dependency the rest of the product cannot remove:
today, AFK still means *your computer is on and awake*. The extension ships an
OS wake lock for precisely that reason, and
[`keep-awake.ts`](https://github.com/phuryn/grok-build-vscode/blob/main/src/keep-awake.ts)
says in its own comments that a standing wake lock drains laptops. A hosted
environment is the version where closing the lid is fine.

> **Status: built and tested; not switched on.** Provisioning, the pool, the
> claim and the token handover all exist and are covered by the suite. The pool
> stays off until `CLOUD_POOL_SIZE` and `RELAY_PUBLIC_URL` are set, and cloud
> access is open to every account until `RELAY_CLOUD_FEATURE` names the plan it
> belongs to.

## What it is, from the relay's side

Almost nothing new. A cloud environment links through `/api/link/start` like any
host, lands in the device registry, routes through the hub, and obeys the
extension's capability policy. Chat, sessions, projects, file browsing and
routines all work because none of them ever cared what was on the other end of
the socket.

The relay learns exactly **one** thing it does not know about a laptop: how to
wake it.

That is necessary because the uplink is outbound-only. When an environment
sleeps, its socket dies — and a sleeping environment is then indistinguishable
from a laptop that is switched off. Nothing can be sent to it, because the thing
you would send it over is gone. Only the relay knows a client is asking, so only
the relay can make the inbound call that starts it.

## Asleep is not offline

The device list shows **availability**, not socket state:

| Shown | Means |
|---|---|
| *(a viewer count)* | Connected right now |
| **ready** | Usable. It may be running or asleep — you are not told which, because there is nothing to do about it |
| **starting** | A wake is in flight. Only visible if one is unusually slow |
| **offline** | Genuinely cannot be reached or woken |

A sleeping environment gets a **live** button. Opening it is what wakes it.

This is why `offline` means *un-wakeable* rather than *asleep*: a laptop that is
off is off and nothing you do changes that, while a hosted machine is either
usable or broken. The two kinds of device legitimately speak different
vocabularies, and collapsing them would make one of them lie.

## Sleeping, and the rule that matters

An environment is allowed to sleep when **no client is watching it AND no agent
turn is in flight**.

The second half is the product. Someone who closes their laptop while an agent
works for twenty minutes is not idle — they are the reason this exists. A rule
that counted only attached clients would stop the work the moment the person
walked away.

The first half is client-side, because the relay cannot see a person — an open
socket is exactly what a forgotten tab looks like. Your browser reports that
somebody is present (pointer, keyboard, tab visibility) every thirty seconds. Go
quiet for five minutes, or send the tab to the background, and it stops
reporting; the hold lapses and the machine sleeps. You are never shown any of
this, and none of it can interrupt work already running.

## Routines still run

A routine on a laptop fires because you opened the laptop. A hosted machine has
nobody to open it, so it tells the relay a single timestamp — *wake me at T* —
and the relay wakes it when the time comes.

The relay is told **when**, never **what**. It does not learn the cadence, the
routine's name, or its prompt; it stores one number and knows nothing about why.
That is a deliberate constraint, not an implementation detail — see
[Security](security.md) on why this relay holds no payloads.

If a wake fails, nothing is lost. Catch-up in the extension is arithmetic:
however many windows were missed, they resolve to one run the next time the
machine is up, exactly as they do for a laptop closed for a week. A failed
scheduled wake is deliberately **not** retried on a timer — a permanently broken
environment retried every minute is a billing problem, not a fix.

## What does not work there yet

**Connectors.** Connecting an MCP connector is a browser OAuth flow at the
vendor's site, and a hosted machine has no browser — nor, unlike a desk, any
computer to walk over to. The Connectors page is therefore hidden in a cloud
environment rather than shown and disabled. It becomes possible when a connector
offers a device-code flow.

Everything else that used to require "your computer" has moved rather than
disappeared. Opening a file, viewing a diff, opening a link and reaching
settings are all handled by the client you are already looking at, because in a
cloud environment there is no other one. **Signing an agent in works** — it uses
the same device-code flow as any remote client. Signing *out* is the mirror
case: on a desk it is withheld from remotes because it revokes a credential
every other surface is using, and in a cloud environment that environment is the
only surface.

## Your credentials, and ours

The environment holds **your** agent logins — `~/.grok`, and the equivalents for
other agents. That is deliberate and it is the same rule that applies on your
desk: sign-in completes inside the environment, against the vendor, and nothing
transits the relay. Anthropic's terms require this for Claude specifically, and
it is good practice for all of them: a token that never moves cannot leak in
transit.

It follows that a cloud environment is a credential store, and its access
control is yours. It also follows, in the other direction, that an environment
holds **nothing of ours** beyond a device token scoped to that single machine.
No relay key, no database credential, nothing that could reach another user.

## What we do not stop you doing

You can destroy your own environment — tell an agent to delete your files and it
will, exactly as it would on your laptop. Guarding against that would be
paternalism with an obvious bypass. What matters instead is that it is
recoverable and that the damage is confined to your own machine.

## Where the machines come from

Creating one takes a second. Making one *useful* took **25 minutes**, measured
end to end on 2026-08-27: `apt` 58s (a stock sprite has no display server and
none of Chromium's libraries), clone 77s, `npm ci` 20 minutes — I/O-bound on the
VM's writable overlay, which is pathological for `node_modules` — and compile 4.6
minutes.

That is not a wait to shrink. It is a wait to **move**. The relay keeps a shelf
of `CLOUD_POOL_SIZE` machines built ahead of demand; the first open takes one off
the shelf and only has to hand it a device token. Somebody waits for a real build
only when the shelf is empty — which is the on-demand path every open used before
a pool existed, and therefore the one that stays tested.

Parked machines are close to free. Cold storage is $0.02/GB-month against ~2.3 GB
of writable overlay per built machine, so 50 spares is roughly $2.30/month. The
builds would have happened anyway; the pool only changes who is watching.

**Two people must never be handed the same machine.** Claiming is a SQL function
using `FOR UPDATE SKIP LOCKED`, so selecting a row and marking it taken happen in
one statement. Reading `ready` in one call and writing `claimed` in another is a
race with a comfortable window, and losing it gives somebody an environment with
another person's work on it.

### Everything else follows from one measured fact

`POST /v1/sprites/{name}/exec` over HTTP is **fire and forget**. A command that
wrote to stdout and exited 7 came back as two bytes; real stdio needs the
`control-ws` channel. So:

- The relay cannot watch a build. A machine reports its own readiness, with a
  per-row secret — without one, guessing a name would put a half-built box in
  front of the next person who opens a cloud environment.
- "Still building" and "died twenty minutes ago" look identical from outside,
  which is the only reason `failStale` exists. A dead build that keeps its slot
  is how a pool empties while the numbers say it is full.
- Nothing can be piped in, so any value has to travel in a command line — and a
  device token in a command line is a durable credential in the provider's
  control-plane record. Instead the relay mints a **single-use, two-minute code**
  and the machine redeems it over TLS for its env file. The code is in argv and
  that is fine: it is worthless the moment it is used.

### Being built is not being offline

Between provisioning and the first uplink there is nothing on the other end, and
for a cold build that is up to 25 minutes. `environments.ready_at` records when a
machine first linked; NULL means it never has. The picker turns that into a
running clock — *creating 4:14* — with no button, because a disabled one invites
somebody to keep pressing it and conclude the product is broken.

Elapsed, never remaining: a pool claim is seconds and a cold build is minutes, so
any estimate spanning both is wrong in one direction. A number that counts up is
true either way.

A machine that has linked once keeps its timestamp and is *offline* in the
ordinary way when it sleeps. That distinction is the whole column.

## For maintainers

- [`src/environments.ts`](../src/environments.ts) — the decisions, pure
- [`src/environment-store.ts`](../src/environment-store.ts) — persistence seam
- [`src/environment-waker.ts`](../src/environment-waker.ts) — waking, de-duplicated
- [`src/wake-scheduler.ts`](../src/wake-scheduler.ts) — the scheduled-wake sweep
- [`src/environment-pool.ts`](../src/environment-pool.ts) — shelf arithmetic, pure
- [`src/environment-pool-store.ts`](../src/environment-pool-store.ts) — the shelf
- [`src/pool-filler.ts`](../src/pool-filler.ts) — the sweep that keeps it stocked
- [`src/pool-bootstrap.ts`](../src/pool-bootstrap.ts) — the script a machine runs
  to install itself; served by the relay, secret-free
- [`src/environment-handover.ts`](../src/environment-handover.ts) — single-use
  codes, because nothing can be piped into a sprite
- `supabase/migrations/20260827000000_environments.sql` — one table, one nullable
  timestamp
- `supabase/migrations/20260827130000_environment_ready_at.sql` — being built vs
  being asleep
- `supabase/migrations/20260827140000_environment_pool.sql` — the shelf, and the
  atomic claim
- `npm run e2e:cloud` — the picker, rendered, at two widths, including a machine
  mid-build
