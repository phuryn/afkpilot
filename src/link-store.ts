// Device-link state machine (pure — clock and code generator injected).
//
// The device-code flow: the extension POSTs /api/link/start and gets a short
// human-checkable code; the user approves it in the browser (mock auth today,
// Clerk session later); the extension polls /api/link/poll until the approval
// hands back the long-lived device token. Links expire; polling an expired or
// unknown code says so explicitly so the extension can stop.

import type { DeviceClientInfo, DevicePlatform } from "./device-client.js";

export interface LinkStoreDeps {
  now: () => number;
  randomCode: () => string;
  ttlMs?: number;
}

export const LINK_TTL_MS = 10 * 60_000;

interface LinkRecord {
  deviceName: string;
  /** The extension's anonymous per-install GUID, when it sent one. Lets approve
   *  recognise a machine that is already linked instead of minting a second
   *  device for it. Optional: older extensions omit it and keep today's
   *  behaviour. */
  installId?: string;
  clientLabel?: string;
  platform?: DevicePlatform;
  osLabel?: string;
  createdAt: number;
  status: "pending" | "approved";
  token?: string;
}

export type PollResult =
  | { status: "pending" }
  | { status: "approved"; token: string }
  | { status: "expired" }
  | { status: "unknown" };

export class LinkStore {
  private links = new Map<string, LinkRecord>();

  constructor(private readonly deps: LinkStoreDeps) {}

  private ttl(): number {
    return this.deps.ttlMs ?? LINK_TTL_MS;
  }

  private live(code: string): LinkRecord | "expired" | "unknown" {
    const rec = this.links.get(code);
    if (!rec) return "unknown";
    if (this.deps.now() - rec.createdAt > this.ttl()) {
      this.links.delete(code);
      return "expired";
    }
    return rec;
  }

  /** Start a link; returns the code the extension shows + the browser approves. */
  start(deviceName: string, installId?: string, client?: DeviceClientInfo): { code: string } {
    let code = this.deps.randomCode();
    while (this.links.has(code)) code = this.deps.randomCode(); // collision paranoia
    this.links.set(code, {
      deviceName,
      installId,
      clientLabel: client?.clientLabel,
      platform: client?.platform,
      osLabel: client?.osLabel,
      createdAt: this.deps.now(),
      status: "pending",
    });
    return { code };
  }

  /** What the approval page shows before the user clicks. `installId` is for the
   *  approve handler's dedupe, not for display — the page shows the name.
   *  Client fields ride along so approve can persist them; omitted when absent. */
  info(code: string): {
    status: "pending" | "approved" | "expired" | "unknown";
    deviceName?: string;
    installId?: string;
    clientLabel?: string;
    platform?: DevicePlatform;
    osLabel?: string;
  } {
    const rec = this.live(code);
    if (rec === "unknown" || rec === "expired") return { status: rec };
    return {
      status: rec.status,
      deviceName: rec.deviceName,
      ...(rec.installId ? { installId: rec.installId } : {}),
      ...(rec.clientLabel ? { clientLabel: rec.clientLabel } : {}),
      ...(rec.platform ? { platform: rec.platform } : {}),
      ...(rec.osLabel ? { osLabel: rec.osLabel } : {}),
    };
  }

  /** Browser-side approval: bind the freshly-issued device token to the link.
   *  false = code unknown/expired (page shows an error instead of success). */
  approve(code: string, token: string): boolean {
    const rec = this.live(code);
    if (rec === "unknown" || rec === "expired") return false;
    rec.status = "approved";
    rec.token = token;
    return true;
  }

  /** Extension-side poll. Approved links keep answering until TTL — a lost poll
   *  response must not strand a successfully-approved device. */
  poll(code: string): PollResult {
    const rec = this.live(code);
    if (rec === "unknown" || rec === "expired") return { status: rec };
    if (rec.status === "approved" && rec.token) return { status: "approved", token: rec.token };
    return { status: "pending" };
  }
}

/** 8 chars, unambiguous alphabet (no 0/O/1/I) — meant to be eyeballed. */
export function makeLinkCode(randomInt: (maxExclusive: number) => number): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
  return code;
}
