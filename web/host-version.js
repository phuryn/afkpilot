// Remote host minimum-version gate. The chat client already receives the
// extension's version as `initialState.extVersion` (the uplink hello does
// not carry one). Capability detection: an ABSENT or unparseable version
// does not gate — that is indistinguishable from "snapshot not yet in" and
// from a fixture that never learned the field name. A present version
// below 3.1.0 shows the update notice instead of the chat UI.
(function (root) {
  "use strict";

  var MIN_REMOTE_HOST = "3.1.0";

  function parseSemver(raw) {
    if (typeof raw !== "string") return null;
    var m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(raw.trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
  }

  function cmp(a, b) {
    if (a.major !== b.major) return a.major < b.major ? -1 : 1;
    if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
    if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
    return 0;
  }

  function hostTooOld(extVersion) {
    var parsed = parseSemver(extVersion);
    var min = parseSemver(MIN_REMOTE_HOST);
    if (!parsed || !min) return false;
    return cmp(parsed, min) < 0;
  }

  root.grokHostVersion = {
    MIN_REMOTE_HOST: MIN_REMOTE_HOST,
    parseSemver: parseSemver,
    hostTooOld: hostTooOld,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
