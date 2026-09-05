/**
 * Giving a pooled machine its identity.
 *
 * A pool sprite is built with no idea whose it is — that is what makes it
 * poolable. Claiming one means handing it a device token, and the awkward part
 * is that there is no private channel to hand it over.
 *
 * Exec takes no usable stdin — the command and its arguments travel in a URL
 * (see `sprite-exec.ts`). So the only way to get a value INTO a sprite is to put
 * it in that command line, and a device token in a command line is a durable
 * credential sitting in the provider's control-plane record.
 *
 * So the sprite fetches it instead. The relay mints a SHORT-LIVED, SINGLE-USE
 * code and execs a command that redeems it over TLS. The code is in argv, and
 * that is fine: it is worthless the moment it is used, worthless two minutes
 * later, and grants exactly one thing — the credentials for the machine that
 * was just handed to the person who asked for it.
 */
import { createHash } from "node:crypto";

/** Two minutes. Long enough for a sprite to wake and curl, short enough that a
 *  code sitting in a log is already dead by the time anyone reads it. */
export const HANDOVER_TTL_MS = 120_000;

export interface HandoverPayload {
  deviceId: string;
  /** The device token. Never logged, never returned to a browser. */
  token: string;
  relayUrl: string;
}

interface Held extends HandoverPayload {
  expiresAt: number;
}

/**
 * Single-use handover codes, in memory.
 *
 * In memory on purpose. These live for two minutes and mean nothing after; a
 * relay restart before redemption loses the code. Open returns the existing
 * environment without retrying handover, so it can remain "creating" until
 * the user resets it. Persisting codes would also persist their device tokens.
 */
export class HandoverCodes {
  private held = new Map<string, Held>();

  constructor(
    private readonly now: () => number,
    private readonly randomCode: () => string,
    private readonly ttlMs: number = HANDOVER_TTL_MS,
  ) {}

  mint(payload: HandoverPayload): string {
    this.sweep();
    const code = this.randomCode();
    this.held.set(code, { ...payload, expiresAt: this.now() + this.ttlMs });
    return code;
  }

  /**
   * Redeem, once.
   *
   * Deleted before the value is returned, so two racing redemptions cannot both
   * succeed even if the second arrives while the first is still being written.
   */
  redeem(code: string): HandoverPayload | null {
    this.sweep();
    const held = this.held.get(code);
    if (!held) return null;
    this.held.delete(code);
    if (held.expiresAt <= this.now()) return null;
    return { deviceId: held.deviceId, token: held.token, relayUrl: held.relayUrl };
  }

  /** For tests and for a health line — never the codes themselves. */
  size(): number {
    this.sweep();
    return this.held.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, held] of this.held) {
      if (held.expiresAt <= now) this.held.delete(code);
    }
  }
}

/**
 * The env file a claimed sprite writes.
 *
 * Built here rather than inline so the exact bytes are testable: this is the
 * file the host reads to find its relay and prove who it is, and a stray quote
 * or a missing newline is a machine that boots and silently never links.
 */
export function handoverEnvFile(payload: HandoverPayload): string {
  return [
    `GROK_RELAY_URL=${payload.relayUrl}`,
    `GROK_RELAY_DEVICE_TOKEN=${payload.token}`,
    "GROK_CLOUD_ENVIRONMENT=1",
    "",
  ].join("\n");
}

/**
 * The command a claimed sprite runs.
 *
 * One line, because argv is what fits down this channel. It fetches the env
 * file, locks it down, and restarts the service that reads it.
 *
 * `-f` matters: without it curl writes an error page into the env file and the
 * host reads HTML as its configuration. `&&` matters for the same reason —
 * restarting a service whose config failed to arrive just loops.
 */
export function handoverCommand(input: {
  relayHttpUrl: string;
  code: string;
}): string[] {
  const url = `${input.relayHttpUrl.replace(/\/+$/, "")}/api/environment/handover`;
  const script = [
    `curl -fsS -X POST -H 'x-handover-code: ${input.code}' ${url} -o "$HOME/.afkpilot.env.new"`,
    `mv "$HOME/.afkpilot.env.new" "$HOME/.afkpilot.env"`,
    `chmod 600 "$HOME/.afkpilot.env"`,
    `/.sprite/bin/sprite-env services restart afkpilot --no-stream`,
  ].join(" && ");
  return ["sh", "-c", script];
}

/**
 * A code that is safe to put in a log line.
 *
 * The code itself is short-lived, but "short-lived" is not "printable": a log
 * shipped somewhere is read later, and two minutes is long enough for a tail.
 */
export function redactCode(code: string): string {
  return `code:${createHash("sha256").update(code).digest("hex").slice(0, 8)}`;
}
