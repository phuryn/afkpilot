/**
 * Is a human actually looking at this?
 *
 * The relay cannot know. It sees an open socket, and an open socket is exactly
 * what a forgotten tab looks like — the browser stays connected all night and
 * reports nothing about whether anybody is in the room. Only the page knows,
 * because only the page sees a pointer move, a key, or a tab go to the
 * background.
 *
 * So presence is CLIENT-ASSERTED and this module holds what the relay does with
 * that assertion. Two rules follow, and the second is the one that matters:
 *
 *  - a heartbeat is a claim that a person is present NOW, and it expires;
 *  - presence is not the only reason to stay awake. An agent turn in flight
 *    keeps an environment up with nobody watching at all, which is the entire
 *    product — see `maySleep` in environments.ts.
 *
 * Cheap to be generous with. Once Sprites' own pricing established that it bills
 * actual usage, an attached-but-idle environment costs a few cents an hour, so
 * the hold is measured in minutes and does not need tuning.
 */

/** How long one heartbeat vouches for. Comfortably longer than the client's
 *  send interval so a single dropped frame does not read as somebody leaving. */
export const PRESENCE_TTL_MS = 90_000;

/** How often a client should send one. */
export const PRESENCE_INTERVAL_MS = 30_000;

/** The frame a browser sends. Not a host protocol message — the relay answers
 *  it and never forwards it, the same as the transport probe. */
export const PRESENCE_TYPE = "presence";

export interface PresenceFrame {
  type: string;
  /** False when the page knows nobody is there: the tab went to the background,
   *  or its own idle timer elapsed. Lets a client withdraw presence
   *  deliberately rather than waiting for a TTL it could have short-circuited. */
  present?: boolean;
}

export function isPresenceFrame(msg: { type?: unknown }): boolean {
  return msg?.type === PRESENCE_TYPE;
}

interface PresenceEntry {
  /** Last time a client asserted a human was here. */
  at: number;
}

/**
 * Per-device presence, asserted by clients and expiring on its own.
 *
 * Keyed by device rather than by client: two tabs on the same environment are
 * one person's attention, and the environment stays awake while EITHER says so.
 */
export class PresenceTracker {
  private byDevice = new Map<string, PresenceEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = PRESENCE_TTL_MS,
  ) {}

  /** A client says a person is present. */
  touch(deviceId: string): void {
    this.byDevice.set(deviceId, { at: this.now() });
  }

  /**
   * A client says nobody is present after all.
   *
   * Deliberate withdrawal rather than waiting for the TTL: a backgrounded tab
   * can say so immediately, and holding a machine awake for another 90 seconds
   * because a phone went into someone's pocket is pure waste.
   */
  clear(deviceId: string): void {
    this.byDevice.delete(deviceId);
  }

  /** Last assertion for a device, or undefined if none stands. */
  lastHeartbeatAt(deviceId: string): number | undefined {
    const entry = this.byDevice.get(deviceId);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      // Expired. Dropped on read so a device nobody ever returns to does not
      // occupy a map entry for the life of the process.
      this.byDevice.delete(deviceId);
      return undefined;
    }
    return entry.at;
  }

  /** Whether anyone is currently claiming to watch this device. */
  present(deviceId: string): boolean {
    return this.lastHeartbeatAt(deviceId) !== undefined;
  }

  /** Called when a client disconnects; the socket going is not by itself proof
   *  nobody is there (another tab may remain), so this only forgets when the
   *  caller knows the last client has gone. */
  forgetIfLastClient(deviceId: string, remainingClients: number): void {
    if (remainingClients <= 0) this.byDevice.delete(deviceId);
  }

  /** Devices with a standing presence claim. Exposed for the sleep sweep. */
  size(): number {
    return this.byDevice.size;
  }
}
