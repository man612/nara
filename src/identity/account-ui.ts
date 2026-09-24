import type { GatewayHttpHandler } from "../gateway.js";

const ACCOUNT_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Nara account</title>
  <style>
    :root {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color-scheme: light dark;
      --bg: Canvas;
      --panel: color-mix(in srgb, Canvas 94%, CanvasText 6%);
      --muted: color-mix(in srgb, CanvasText 62%, transparent);
      --line: color-mix(in srgb, CanvasText 16%, transparent);
      --accent: #3b82f6;
      --danger: #dc2626;
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: CanvasText;
      line-height: 1.5;
    }
    main {
      width: min(760px, calc(100% - 32px));
      margin: 48px auto;
      display: grid;
      gap: 18px;
    }
    header { margin-bottom: 4px; }
    h1, h2 { margin: 0; letter-spacing: -0.02em; }
    h1 { font-size: clamp(30px, 6vw, 44px); }
    h2 { font-size: 18px; }
    p { margin: 6px 0 0; color: var(--muted); }
    section {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 20px;
      background: var(--panel);
    }
    .row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 14px;
    }
    button, input {
      min-height: 44px;
      border-radius: 11px;
      border: 1px solid var(--line);
      font: inherit;
    }
    button {
      padding: 0 15px;
      cursor: pointer;
      background: Canvas;
      color: CanvasText;
      font-weight: 650;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.danger { color: var(--danger); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    input {
      flex: 1 1 280px;
      min-width: 0;
      padding: 0 12px;
      background: Canvas;
      color: CanvasText;
    }
    .hidden { display: none !important; }
    .list {
      display: grid;
      gap: 10px;
      margin-top: 14px;
    }
    .item {
      background: Canvas;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 13px;
      display: grid;
      gap: 8px;
    }
    .item-main {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      align-items: center;
      flex-wrap: wrap;
    }
    .item strong { overflow-wrap: anywhere; }
    .meta { color: var(--muted); font-size: 13px; }
    #status {
      min-height: 24px;
      color: var(--muted);
    }
    #status.error { color: var(--danger); }
    .identity {
      font-weight: 650;
      color: CanvasText;
    }
    code {
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    @media (max-width: 520px) {
      main { margin: 24px auto; width: min(100% - 20px, 760px); }
      section { padding: 16px; }
      button { width: 100%; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Nara account</h1>
    <p>Passkeys, backup authenticators, and temporary private-device access.</p>
  </header>

  <section id="signin">
    <h2>Sign in</h2>
    <p>Use a passkey already registered to your Nara identity.</p>
    <div class="row">
      <button class="primary" id="login">Sign in with passkey</button>
    </div>
  </section>

  <section id="first-passkey">
    <h2>Register a passkey</h2>
    <p>Use a one-time enrollment token issued by your Nara onboarding/admin flow.</p>
    <div class="row">
      <input id="enrollment" autocomplete="off" spellcheck="false" placeholder="One-time enrollment token">
      <button id="register-token">Register passkey</button>
    </div>
  </section>

  <section id="account" class="hidden">
    <h2>Signed in</h2>
    <p class="identity" id="viewer"></p>
    <div class="row">
      <button id="add-passkey">Add backup passkey</button>
      <button id="logout">Sign out</button>
    </div>
  </section>

  <section id="passkeys" class="hidden">
    <h2>Your passkeys</h2>
    <p>Keep at least two independent passkeys before removing one.</p>
    <div id="passkey-list" class="list"></div>
  </section>

  <section id="devices" class="hidden">
    <h2>Your devices</h2>
    <p>Unlock gives this physical Nara temporary access to your private viewer scope. Lock removes it immediately.</p>
    <div id="device-list" class="list"></div>
  </section>

  <div id="status" role="status" aria-live="polite"></div>
</main>

<script>
(() => {
  let sessionToken = "";
  let viewer = null;

  const $ = (id) => document.getElementById(id);
  const status = $("status");

  function say(message, error = false) {
    status.textContent = message || "";
    status.classList.toggle("error", error);
  }

  function b64urlToBytes(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  }

  function bytesToB64url(value) {
    if (value == null) return null;
    const bytes = new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (sessionToken) {
      headers.set("authorization", "Bearer " + sessionToken);
    }
    if (options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Request failed (" + response.status + ")");
    }
    return data;
  }

  function creationOptions(publicKey) {
    return {
      ...publicKey,
      challenge: b64urlToBytes(publicKey.challenge),
      user: {
        ...publicKey.user,
        id: b64urlToBytes(publicKey.user.id)
      },
      excludeCredentials: (publicKey.excludeCredentials || []).map((item) => ({
        ...item,
        id: b64urlToBytes(item.id)
      }))
    };
  }

  function requestOptions(publicKey) {
    return {
      ...publicKey,
      challenge: b64urlToBytes(publicKey.challenge)
    };
  }

  function serializeRegistration(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        attestationObject: bytesToB64url(response.attestationObject),
        transports: response.getTransports ? response.getTransports() : []
      }
    };
  }

  function serializeAuthentication(credential) {
    const response = credential.response;
    return {
      id: credential.id,
      rawId: bytesToB64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToB64url(response.clientDataJSON),
        authenticatorData: bytesToB64url(response.authenticatorData),
        signature: bytesToB64url(response.signature),
        userHandle: response.userHandle
          ? bytesToB64url(response.userHandle)
          : null
      }
    };
  }

  async function registerWithEnrollment(enrollmentToken) {
    const options = await api("/api/identity/passkeys/register/options", {
      method: "POST",
      body: JSON.stringify({ enrollmentToken })
    });
    const credential = await navigator.credentials.create({
      publicKey: creationOptions(options.publicKey)
    });
    if (!credential) throw new Error("Passkey creation was cancelled");
    await api("/api/identity/passkeys/register/verify", {
      method: "POST",
      body: JSON.stringify({
        ceremonyId: options.ceremonyId,
        enrollmentToken,
        credential: serializeRegistration(credential)
      })
    });
  }

  async function login() {
    if (!window.PublicKeyCredential || !window.isSecureContext) {
      throw new Error("Passkeys require a secure HTTPS context (localhost is allowed for development)");
    }
    const options = await api("/api/identity/passkeys/authenticate/options", {
      method: "POST"
    });
    const credential = await navigator.credentials.get({
      publicKey: requestOptions(options.publicKey)
    });
    if (!credential) throw new Error("Passkey sign-in was cancelled");
    const result = await api("/api/identity/passkeys/authenticate/verify", {
      method: "POST",
      body: JSON.stringify({
        ceremonyId: options.ceremonyId,
        credential: serializeAuthentication(credential)
      })
    });
    sessionToken = result.sessionToken;
    viewer = result.viewer;
    showAccount();
    await refresh();
  }

  function showAccount() {
    $("signin").classList.add("hidden");
    $("first-passkey").classList.add("hidden");
    $("account").classList.remove("hidden");
    $("passkeys").classList.remove("hidden");
    $("devices").classList.remove("hidden");
    $("viewer").textContent =
      (viewer?.displayName || viewer?.personId || "Authenticated viewer") +
      (viewer?.role ? " · " + viewer.role : "");
  }

  function logout() {
    sessionToken = "";
    viewer = null;
    $("account").classList.add("hidden");
    $("passkeys").classList.add("hidden");
    $("devices").classList.add("hidden");
    $("signin").classList.remove("hidden");
    $("first-passkey").classList.remove("hidden");
    $("passkey-list").replaceChildren();
    $("device-list").replaceChildren();
    say("Signed out. The viewer session remains only in this tab's memory and will expire server-side.");
  }

  async function refreshPasskeys() {
    const result = await api("/api/identity/passkeys");
    const root = $("passkey-list");
    root.replaceChildren();

    for (const passkey of result.passkeys) {
      const item = document.createElement("div");
      item.className = "item";
      const main = document.createElement("div");
      main.className = "item-main";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = passkey.algorithm + " · " + passkey.credentialId.slice(0, 14) + "…";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        "Created " + new Date(passkey.createdAt).toLocaleString() +
        (passkey.lastUsedAt
          ? " · Last used " + new Date(passkey.lastUsedAt).toLocaleString()
          : "");
      info.append(title, meta);
      const revoke = document.createElement("button");
      revoke.className = "danger";
      revoke.textContent = "Remove";
      revoke.addEventListener("click", async () => {
        try {
          revoke.disabled = true;
          await api(
            "/api/identity/passkeys?credentialId=" +
              encodeURIComponent(passkey.credentialId),
            { method: "DELETE" }
          );
          say("Passkey removed.");
          await refreshPasskeys();
        } catch (error) {
          say(error.message, true);
        } finally {
          revoke.disabled = false;
        }
      });
      main.append(info, revoke);
      item.append(main);
      root.append(item);
    }
  }

  async function grantState(deviceId) {
    return api(
      "/api/identity/device-viewer-grants?deviceId=" +
        encodeURIComponent(deviceId)
    );
  }

  async function refreshDevices() {
    const result = await api("/api/identity/devices");
    const root = $("device-list");
    root.replaceChildren();

    for (const device of result.devices) {
      const item = document.createElement("div");
      item.className = "item";
      const state = await grantState(device.deviceId);
      const main = document.createElement("div");
      main.className = "item-main";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = device.deviceId;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent =
        device.state +
        (state.active && state.grant
          ? " · private access until " +
            new Date(state.grant.expiresAt).toLocaleTimeString()
          : " · private access locked");
      info.append(title, meta);

      const action = document.createElement("button");
      action.className = state.active ? "danger" : "primary";
      action.textContent = state.active ? "Lock" : "Unlock 10 min";
      action.addEventListener("click", async () => {
        try {
          action.disabled = true;
          if (state.active) {
            await api(
              "/api/identity/device-viewer-grants?deviceId=" +
                encodeURIComponent(device.deviceId),
              { method: "DELETE" }
            );
            say("Private device access locked.");
          } else {
            await api("/api/identity/device-viewer-grants", {
              method: "POST",
              body: JSON.stringify({
                deviceId: device.deviceId,
                ttlMinutes: 10
              })
            });
            say("Private device access unlocked for 10 minutes.");
          }
          await refreshDevices();
        } catch (error) {
          say(error.message, true);
        } finally {
          action.disabled = false;
        }
      });

      main.append(info, action);
      item.append(main);
      root.append(item);
    }
  }

  async function refresh() {
    await Promise.all([refreshPasskeys(), refreshDevices()]);
  }

  $("login").addEventListener("click", async () => {
    try {
      $("login").disabled = true;
      say("Waiting for your passkey…");
      await login();
      say("Signed in.");
    } catch (error) {
      say(error.message, true);
    } finally {
      $("login").disabled = false;
    }
  });

  $("register-token").addEventListener("click", async () => {
    const token = $("enrollment").value.trim();
    if (!token) {
      say("Enter a one-time enrollment token.", true);
      return;
    }
    try {
      $("register-token").disabled = true;
      say("Creating passkey…");
      await registerWithEnrollment(token);
      $("enrollment").value = "";
      say("Passkey registered. You can sign in now.");
    } catch (error) {
      say(error.message, true);
    } finally {
      $("register-token").disabled = false;
    }
  });

  $("add-passkey").addEventListener("click", async () => {
    try {
      $("add-passkey").disabled = true;
      const enrollment = await api(
        "/api/identity/passkeys/enrollments",
        {
          method: "POST",
          body: "{}"
        }
      );
      await registerWithEnrollment(enrollment.enrollmentToken);
      say("Backup passkey added.");
      await refreshPasskeys();
    } catch (error) {
      say(error.message, true);
    } finally {
      $("add-passkey").disabled = false;
    }
  });

  $("logout").addEventListener("click", logout);

  if (!window.isSecureContext) {
    say("This page is not in a secure context. Passkeys require HTTPS outside localhost.", true);
  }
})();
</script>
</body>
</html>`;

export function createAccountUiHttpHandler(): GatewayHttpHandler {
  return async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      "http://nara.local"
    );
    if (
      url.pathname !== "/account" &&
      url.pathname !== "/account/"
    ) {
      return false;
    }
    if (request.method !== "GET") {
      response.writeHead(405, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end("method not allowed");
      return true;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff"
    });
    response.end(ACCOUNT_HTML);
    return true;
  };
}
