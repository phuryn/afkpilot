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

> **Availability is deployment-configured.** `SPRITES_TOKEN` enables cloud
> services in the relay. The pool requires a positive `CLOUD_POOL_SIZE` and
> `RELAY_PUBLIC_URL`; provisioning and handover also need a reachable public
> relay URL. Cloud access is open to every account until `RELAY_CLOUD_FEATURE`
> names the required feature. This document does not attest to a deployment's
> current configuration.

## What it is, from the relay's side

`POST /api/cloud/open` claims a spare machine or provisions one, issues its
device identity, and hands that identity to the host through a single-use code.
The resulting uplink uses the ordinary device registry and hub and obeys the
extension's capability policy. Chat, sessions, projects, file browsing and
routines use that shared host protocol.

The relay also owns the cloud control plane: provisioning, pool inventory,
identity handover, waking, and the exec holds that keep a machine running.

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

An environment sleeps when **its machine has been quiet for ninety seconds**,
and stays awake for as long as it is working. Somebody who closes their laptop
while an agent works for twenty minutes is not idle — they are the reason this
exists.

### Suspended means frozen, which is why this needed solving at all

Measured 2026-08-27, because the answer decides the design. A sprite suspends
about a minute after the last **external** interaction, and a suspended machine
is not merely idle:

    a service writing a timestamp every 5s
    samples: 12   first 23:04:18Z   last 23:05:13Z   then silence

It stopped dead the moment the machine went `warm`. Its own output bought it
nothing, so a long turn did not survive the phone being put down.

A poke does not fix it either: an instantaneous command every thirty seconds
held the machine at `warm` — awake enough to answer, still frozen between calls.
What holds it in `running` is an exec **session that stays open**. So that is
what the relay does, and letting go of it is what lets the machine sleep.

### What counts as working

Traffic on the uplink, and nothing more. The relay does not read frames to
decide this — it counts their arrival, which is what keeps the feature
consistent with the relay being policy-free: it can tell that work is happening
without knowing what the work is.

Ordinary streamed output is enough on its own, and that is what protects an
extension too old to know about any of this. But a turn spends most of its life
waiting on a tool with nothing to say — four minutes of a test run streams
nothing — so a current extension also sends a `working` frame every thirty
seconds while a turn is in flight. It carries no payload and produces no side
effect; its whole job is to arrive.

Billing follows the same line: a machine is kept running exactly while it is
earning its keep, and is allowed to fall asleep the moment it is not. You are
never shown any of this, and none of it can interrupt work already running.

### Waking is not the same as staying awake

Resuming takes about a second. A host noticing its socket died and dialling back
takes longer than the minute the hypervisor waits before suspending it again —
so a wake on its own would be undone before anybody could use it. A woken
machine is therefore HELD running while its uplink finds its way back, and the
hold lapses by itself if it never does.

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

The preferred installation path downloads and extracts the Linux AppImage from
GitHub. The lookup walks the published releases newest-first for one that
actually carries an AppImage, rather than trusting `releases/latest`: a release
exists for the minutes between its creation and its installers attaching, and a
machine built in that window used to fall through to a source build and stay
recorded as one. A lookup that fails outright now stops the install rather than
authorising a build. Cloning and building from source survives only for the case
where no published build exists at all. That fallback took
**25 minutes**, measured end to end on 2026-08-27: `apt` 58s (a stock sprite has
no display server and none of Chromium's libraries), clone 77s, `npm ci` 20
minutes — I/O-bound on the VM's writable overlay — and compile 4.6 minutes.
This historical measurement describes the source-build path, not a current
AppImage startup benchmark.

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

### Running a command on a machine

**`POST /v1/sprites/{name}/exec` does not do it.** It answers `200` and two
bytes and runs nothing — a command told to create a file returned success and
the file did not exist. An earlier version of this relay was built on the
opposite belief and produced a pool of machines that were created, recorded as
building, and never touched again. The `sprite-capabilities: control-ws` header
on that response is the tell.

The real channel is a WebSocket, and argv is a **repeated `cmd` parameter**:

```
wss://api.sprites.dev/v1/sprites/{name}/exec?cmd=<argv0>&cmd=<argv1>&…
Authorization: Bearer <token>
```

`args`, `arg`, `argv` and a JSON body were each tried and each ran the command
with no arguments at all. It reports exit codes, which is what makes any of this
verifiable — see [`src/sprite-exec.ts`](../src/sprite-exec.ts).

What still cannot be watched is a 25-minute install: holding a socket open for
that is a bet against the network, not a design. So:

- A build is *started* by a command whose exit code the relay does see — it
  registers a service — and the machine reports its own readiness later, with a
  per-row secret. Without that secret, guessing a name would put a half-built box
  in front of the next person who opens a cloud environment.
- "Still building" and "died twenty minutes ago" look identical from outside,
  which is the only reason `failStale` exists. A dead build that keeps its slot
  is how a pool empties while the numbers say it is full.
- Nothing can be piped in, so any value has to travel in that command line — and
  a device token there is a durable credential in the provider's control-plane
  record. Instead the relay mints a **single-use, two-minute code** and the
  machine redeems it over TLS for its env file. The code is in argv and that is
  fine: it is worthless the moment it is used.

### Every machine gets set up, however it was obtained

A pooled machine needs only its identity. One built to order — somebody opened
their cloud environment while the shelf was empty — needs the installer too.
That second case was missing once, and the symptom was a row that said
*creating* for an hour and a half because nothing was ever going to link.

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
- [`src/environment-keepalive.ts`](../src/environment-keepalive.ts) — holding a
  machine running while it works, and letting go when it stops
- [`src/wake-scheduler.ts`](../src/wake-scheduler.ts) — the scheduled-wake sweep
- [`src/environment-pool.ts`](../src/environment-pool.ts) — shelf arithmetic, pure
- [`src/environment-pool-store.ts`](../src/environment-pool-store.ts) — the shelf
- [`src/pool-filler.ts`](../src/pool-filler.ts) — the sweep that keeps it stocked
- [`src/pool-bootstrap.ts`](../src/pool-bootstrap.ts) — the script a machine runs
  to install itself; served by the relay, secret-free
- [`src/sprite-exec.ts`](../src/sprite-exec.ts) — the WebSocket that actually
  runs commands, and the repeated-`cmd` shape nothing documents
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
