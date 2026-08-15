// Optional client metadata on POST /api/link/start and the uplink hello.
//
// New hosts send { clientLabel, platform, osLabel } next to name/installId so
// the picker can render "VS Code extension, Windows 11" without stuffing that
// into the device name. Older hosts omit the fields; they stay null — never
// invented. Invalid values are refused (not coerced) so a typo cannot become
// a stored label.

export const DEVICE_PLATFORMS = ["win", "mac", "linux", "unknown"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const DEVICE_CLIENT_LABEL_MAX = 64;

export interface DeviceClientInfo {
  clientLabel?: string;
  platform?: DevicePlatform;
  osLabel?: string;
}

export type ParseDeviceClientResult =
  | { ok: true; client: DeviceClientInfo }
  | { ok: false };

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === "string" && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

function isPrintableLabel(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return false;
  }
  return true;
}

/** Absent / empty → undefined. Present but illegal → "invalid". */
function readOptionalLabel(raw: unknown): string | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return "invalid";
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > DEVICE_CLIENT_LABEL_MAX || !isPrintableLabel(value)) return "invalid";
  return value;
}

function readOptionalPlatform(raw: unknown): DevicePlatform | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return "invalid";
  if (!raw) return undefined;
  // EXACT match, no trim: the platform is an enum our own clients emit, so
  // " win " is a malformed sender, not a formatting nicety to absorb.
  if (!isDevicePlatform(raw)) return "invalid";
  return raw;
}

/** Pull optional client fields off a link-start body. Missing is fine; junk is not. */
export function parseDeviceClientFields(body: Record<string, unknown> | null): ParseDeviceClientResult {
  if (!body) return { ok: true, client: {} };
  const client: DeviceClientInfo = {};

  const clientLabel = readOptionalLabel(body.clientLabel);
  if (clientLabel === "invalid") return { ok: false };
  if (clientLabel) client.clientLabel = clientLabel;

  const osLabel = readOptionalLabel(body.osLabel);
  if (osLabel === "invalid") return { ok: false };
  if (osLabel) client.osLabel = osLabel;

  const platform = readOptionalPlatform(body.platform);
  if (platform === "invalid") return { ok: false };
  if (platform) client.platform = platform;

  return { ok: true, client };
}

export function hasDeviceClientInfo(client: DeviceClientInfo | null | undefined): boolean {
  return !!(client && (client.clientLabel || client.platform || client.osLabel));
}
