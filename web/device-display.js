// Device-picker display helper — which name, parenthetical, and OS icon to
// show for a /api/devices row. Plain script, no modules.
//
// New rows carry clientLabel / platform / osLabel. Older rows have nulls and
// a legacy name like "DESKTOP-RHFLCK3 (Windows 11)"; we parse the trailing
// parenthetical so they still get an icon and a clean hostname.
(function (root) {
  "use strict";

  var PLATFORMS = { win: true, mac: true, linux: true, unknown: true };

  function platformFromText(text) {
    var s = String(text || "").toLowerCase();
    if (/\bwindows\b|\bwin32\b|\bwin64\b/.test(s)) return "win";
    if (/\bmac\s*os\b|\bmacos\b|\bos\s*x\b|\bdarwin\b|\bmac\b/.test(s)) return "mac";
    if (/\blinux\b/.test(s)) return "linux";
    return "unknown";
  }

  function parseLegacyDeviceName(name) {
    var raw = String(name || "");
    var m = /^(.*)\s+\(([^)]+)\)\s*$/.exec(raw);
    if (!m) return { displayName: raw, parenthetical: null, platform: "unknown" };
    var host = m[1].trim();
    var inside = m[2].trim();
    if (!host || !inside) return { displayName: raw, parenthetical: null, platform: "unknown" };
    return { displayName: host, parenthetical: inside, platform: platformFromText(inside) };
  }

  function resolveDeviceDisplay(device) {
    var name = device && device.name != null ? String(device.name) : "";
    var storedPlatform = device && PLATFORMS[device.platform] ? device.platform : null;
    var hasStored = !!(device && (device.clientLabel || device.osLabel || storedPlatform));
    if (!hasStored) return parseLegacyDeviceName(name);

    // Fields are independently optional: fill each MISSING one from the
    // legacy name's parenthetical instead of discarding it wholesale — a row
    // with only {platform:"win"} still shows its "(Windows 11)", and one with
    // only a client label keeps the OS half.
    var parsed = parseLegacyDeviceName(name);
    var bits = [];
    if (device.clientLabel) bits.push(String(device.clientLabel));
    if (device.osLabel) bits.push(String(device.osLabel));
    else if (parsed.parenthetical) bits.push(parsed.parenthetical);
    var platform = storedPlatform
      || (device.osLabel ? platformFromText(device.osLabel) : parsed.platform);
    return {
      displayName: parsed.parenthetical ? parsed.displayName : name,
      parenthetical: bits.length ? bits.join(", ") : null,
      platform: platform,
    };
  }

  // Filled silhouettes in the site's currentColor, sized to the row. The win
  // and mac shapes are the owner's chosen SVGs (svgrepo, 2026-08-14): the
  // classic four-pane Windows flag and the Apple mark. `linux` is a penguin;
  // `unknown` stays a generic monitor so old/unparseable rows still have one.
  function osIconSvg(platform) {
    if (platform === "win") {
      return '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="currentColor" d="M3,12V6.75L9,5.43v6.48L3,12M20,3v8.75L10,11.9V5.21L20,3M3,13l6,.09V19.9L3,18.75V13m17,.25V22L10,20.09v-7Z"/>' +
        "</svg>";
    }
    if (platform === "mac") {
      // The source SVG nests two translates; -46/-7279 is their sum.
      return '<svg viewBox="-1.5 0 20 20" aria-hidden="true">' +
        '<g transform="translate(-46 -7279)"><path fill="currentColor" d="M57.5708873,7282.19296 C58.2999598,7281.34797 58.7914012,7280.17098 58.6569121,7279 C57.6062792,7279.04 56.3352055,7279.67099 55.5818643,7280.51498 C54.905374,7281.26397 54.3148354,7282.46095 54.4735932,7283.60894 C55.6455696,7283.69593 56.8418148,7283.03894 57.5708873,7282.19296 M60.1989864,7289.62485 C60.2283111,7292.65181 62.9696641,7293.65879 63,7293.67179 C62.9777537,7293.74279 62.562152,7295.10677 61.5560117,7296.51675 C60.6853718,7297.73474 59.7823735,7298.94772 58.3596204,7298.97372 C56.9621472,7298.99872 56.5121648,7298.17973 54.9134635,7298.17973 C53.3157735,7298.17973 52.8162425,7298.94772 51.4935978,7298.99872 C50.1203933,7299.04772 49.0738052,7297.68074 48.197098,7296.46676 C46.4032359,7293.98379 45.0330649,7289.44985 46.8734421,7286.3899 C47.7875635,7284.87092 49.4206455,7283.90793 51.1942837,7283.88393 C52.5422083,7283.85893 53.8153044,7284.75292 54.6394294,7284.75292 C55.4635543,7284.75292 57.0106846,7283.67793 58.6366882,7283.83593 C59.3172232,7283.86293 61.2283842,7284.09893 62.4549652,7285.8199 C62.355868,7285.8789 60.1747177,7287.09489 60.1989864,7289.62485"/></g>' +
        "</svg>";
    }
    if (platform === "linux") {
      return '<svg viewBox="0 0 16 16" aria-hidden="true">' +
        '<path fill="currentColor" fill-rule="evenodd" d="M8 1.2c1.6 0 2.85 1.3 2.85 2.8 0 .22-.03.43-.08.64 1.2.5 2.03 1.68 2.03 3.1 0 1.3-.65 2.45-1.68 3.12l.55 1.72c.1.3-.12.62-.44.62H9.5v.85c0 .25-.2.45-.45.45h-2.1c-.25 0-.45-.2-.45-.45v-.85H4.77c-.32 0-.54-.32-.44-.62l.55-1.72C3.85 10.19 3.2 9.04 3.2 7.74c0-1.42.83-2.6 2.03-3.1A2.9 2.9 0 0 1 5.15 4C5.15 2.5 6.4 1.2 8 1.2zM6.45 3.7a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4zm3.1 0a.7.7 0 1 0 0 1.4.7.7 0 0 0 0-1.4z"/>' +
        '<path fill="currentColor" d="M8 5.45 10.2 6.1 8 6.9z"/>' +
        "</svg>";
    }
    return '<svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<rect x="2" y="2.8" width="12" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
      '<path d="M5.5 13.2h5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
      "</svg>";
  }

  root.deviceDisplay = {
    platformFromText: platformFromText,
    parseLegacyDeviceName: parseLegacyDeviceName,
    resolveDeviceDisplay: resolveDeviceDisplay,
    osIconSvg: osIconSvg,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
