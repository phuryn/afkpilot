// Shared browser auth for all three pages — include BEFORE the page's own
// script. Plain script, no modules, no dependencies.
//
// Contract: window.grokAuth exists synchronously; await grokAuth.ready before
// reading anything else. Mock mode (no publishable key from /api/config):
// enabled=false, getToken resolves null, requireSignIn resolves immediately —
// pages behave exactly as before auth existed, so dev without Clerk keeps
// working. Clerk mode: ClerkJS v5 is loaded from the instance's frontend API
// (host derived by base64-decoding the publishable key body, which encodes
// "<fapi-host>$"). hasFeature() decodes the session JWT's `fea` claim with the
// same u:/uo: scoping as src/auth.ts — keep the two in sync.
(function () {
  "use strict";

  var state = {
    enabled: false,
    clerk: null,
    requiredFeature: null,
    getToken: function () { return Promise.resolve(null); },
    isSignedIn: function () { return false; },
    mountUserButton: function () {},
    openSignIn: function () {},
    hasFeature: function () { return Promise.resolve(false); },
    requireSignIn: function () { return Promise.resolve(); },
    signOut: function () { return Promise.resolve(); },
    onAuthChange: function () {},
    signedInIdentity: function () { return null; },
  };

  // Inside the native shell (Capacitor appends AFKPilotApp to the UA), Clerk's
  // UserProfile must not offer Billing: app stores forbid an app that routes
  // users to a purchase outside their billing, and Clerk Billing is enabled on
  // this instance, so "Manage account" would otherwise open straight onto a
  // plan picker. Everything else about the profile stays — account, security,
  // sign out — because only the purchase surface is the problem.
  //
  // navbarButton__billing is a supported appearance descriptor, not a scraped
  // class. clerk-js builds it as descriptors.navbarButton.setId(page.id) with
  // page ids { account, security, billing, apiKeys }, and Clerk documents these
  // classes as stable. The mobile layout collapses the same list behind a
  // hamburger rather than rendering its own items, so one rule covers both.
  //
  // This lives HERE rather than at each call site on purpose: index, chat and
  // link all mount a user button, and a per-page opt-in is one forgotten page
  // away from shipping a purchase surface. /link was exactly that page once.
  function inAppShell() {
    return /AFKPilotApp/.test(navigator.userAgent);
  }

  function userButtonProps() {
    if (!inAppShell()) return undefined;
    return {
      userProfileProps: {
        appearance: { elements: { navbarButton__billing: { display: "none" } } },
      },
    };
  }

  // Clerk user → a string the header can print. Email first; username/id only
  // when there is no primary email. Returns null when there is no user (and
  // therefore in mock mode) so pages never invent an identity.
  function identityFromClerkUser(user) {
    if (!user) return null;
    var email = user.primaryEmailAddress && user.primaryEmailAddress.emailAddress;
    if (typeof email === "string" && email) return email;
    if (typeof user.username === "string" && user.username) return user.username;
    if (typeof user.id === "string" && user.id) return user.id;
    return null;
  }

  function fapiHost(publishableKey) {
    // pk_test_<base64 of "host$"> / pk_live_<...>
    var body = publishableKey.split("_").slice(2).join("_");
    var host = atob(body);
    return host.charAt(host.length - 1) === "$" ? host.slice(0, -1) : host;
  }

  function loadClerkJs(publishableKey) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://" + fapiHost(publishableKey) + "/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
      s.setAttribute("data-clerk-publishable-key", publishableKey);
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("ClerkJS failed to load")); };
      document.head.appendChild(s);
    });
  }

  function jwtClaims(token) {
    try {
      var part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(part));
    } catch (e) {
      return null;
    }
  }

  // Mirror of userScoped() in src/auth.ts: only u:/uo:-scoped slugs count.
  function userScoped(claim) {
    if (typeof claim !== "string" || !claim) return [];
    var out = [];
    claim.split(",").forEach(function (entry) {
      var kv = entry.trim().split(":");
      if ((kv[0] === "u" || kv[0] === "uo") && kv[1]) out.push(kv[1]);
    });
    return out;
  }

  state.ready = (function init() {
    return fetch("/api/config")
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg.publishableKey) return state; // mock mode
        state.requiredFeature = cfg.requiredFeature;
        return loadClerkJs(cfg.publishableKey).then(function () {
          // Hot-loaded ClerkJS exposes window.Clerk as a pre-built instance
          // (keyed off the data attribute); older bundles export the class.
          var C = window.Clerk;
          var clerk = typeof C === "function" ? new C(cfg.publishableKey) : C;
          return clerk.load().then(function () {
            state.enabled = true;
            state.clerk = clerk;
            state.getToken = function () {
              return clerk.session ? clerk.session.getToken() : Promise.resolve(null);
            };
            state.isSignedIn = function () { return !!clerk.user; };
            state.mountUserButton = function (el) { clerk.mountUserButton(el, userButtonProps()); };
            // Always come back to the page that asked: Clerk's default
            // post-auth redirect lands on "/", which loses /link?code=
            // context whenever the flow does a full-page handshake.
            state.openSignIn = function (opts) {
              var here = window.location.href;
              clerk.openSignIn(Object.assign(
                { redirectUrl: here, forceRedirectUrl: here, signUpForceRedirectUrl: here },
                opts || {}
              ));
            };
            // Same story for sign-out (default redirect is "/").
            state.signOut = function () { return clerk.signOut({ redirectUrl: window.location.href }); };
            state.signedInIdentity = function () { return identityFromClerkUser(clerk.user); };
            // Fires on every Clerk auth-state change (sign-in AND sign-out) —
            // pages re-render their action area from isSignedIn().
            state.onAuthChange = function (cb) { clerk.addListener(function () { cb(); }); };
            state.hasFeature = function (slug) {
              return state.getToken().then(function (token) {
                if (!token) return false;
                var claims = jwtClaims(token);
                return !!claims && userScoped(claims.fea).indexOf(slug) !== -1;
              });
            };
            state.requireSignIn = function (containerEl) {
              if (state.isSignedIn()) return Promise.resolve();
              var panel = document.createElement("div");
              panel.className = "grok-auth-panel";
              panel.innerHTML =
                '<p>Sign in to AFK Pilot to continue.</p>' +
                '<button type="button" class="btn btn-primary">Sign in</button>';
              panel.querySelector("button").addEventListener("click", function () {
                state.openSignIn();
              });
              containerEl.appendChild(panel);
              return new Promise(function (resolve) {
                var unsub = clerk.addListener(function () {
                  if (!clerk.user) return;
                  try { panel.remove(); } catch (e) { /* already gone */ }
                  if (unsub) unsub();
                  resolve();
                });
              });
            };
            return state;
          });
        });
      })
      .catch(function (e) {
        // Config unreachable or ClerkJS load failed: stay in mock mode rather
        // than dead-ending the page (dev keeps working; prod surfaces 401s).
        console.warn("grokAuth: falling back to mock mode:", e);
        return state;
      });
  })();

  window.grokAuth = state;
})();
