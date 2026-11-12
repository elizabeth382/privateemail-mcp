// auth-core.js — per-person sign-in for a Claude custom connector.
//
// Claude connects to this server with OAuth (dynamic client registration +
// PKCE). Each person who clicks "Connect" in Claude goes through a login step
// that the host app supplies (a mailbox login form, or a Microsoft sign-in),
// and receives tokens that are tied to THEIR identity only. Tool calls then
// carry that person's token, so each person can only reach their own account.
//
// Storage: Upstash Redis over its REST API (survives Render restarts). With no
// Upstash settings it falls back to memory, which is only suitable for testing.
// Tokens and codes are stored as SHA-256 hashes; per-person secrets (passwords,
// Microsoft refresh tokens) are encrypted with AES-256-GCM.

import crypto from "node:crypto";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 60 * 60 * 24 * 90; // 90 days; renewed each time it is used
const CODE_TTL = 5 * 60;
const PENDING_TTL = 10 * 60;
const CLIENT_TTL = 60 * 60 * 24 * 365;

// ---------- Key-value store ----------
export function createStore({ upstashUrl, upstashToken, prefix }) {
  const p = (k) => `${prefix}:${k}`;
  if (upstashUrl && upstashToken) {
    const base = upstashUrl.replace(/^"|"$/g, "").replace(/\/$/, "");
    const token = upstashToken.replace(/^"|"$/g, "");
    const cmd = async (args) => {
      const r = await fetch(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.error) throw new Error(`Upstash error: ${body.error || r.status}`);
      return body.result;
    };
    return {
      kind: "upstash",
      async get(k) { const v = await cmd(["GET", p(k)]); return v == null ? null : JSON.parse(v); },
      async take(k) { const v = await cmd(["GETDEL", p(k)]); return v == null ? null : JSON.parse(v); },
      async set(k, v, ttl) { await cmd(ttl ? ["SET", p(k), JSON.stringify(v), "EX", String(ttl)] : ["SET", p(k), JSON.stringify(v)]); },
      async del(k) { await cmd(["DEL", p(k)]); },
    };
  }
  const mem = new Map();
  const live = (k) => { const e = mem.get(p(k)); if (!e) return null; if (e.exp && e.exp < Date.now()) { mem.delete(p(k)); return null; } return e.v; };
  return {
    kind: "memory",
    async get(k) { return live(k); },
    async take(k) { const v = live(k); mem.delete(p(k)); return v; },
    async set(k, v, ttl) { mem.set(p(k), { v, exp: ttl ? Date.now() + ttl * 1000 : 0 }); },
    async del(k) { mem.delete(p(k)); },
  };
}

// ---------- Encryption for per-person secrets ----------
export function createVault(secret) {
  if (!secret || secret.length < 32) throw new Error("ENCRYPTION_KEY must be at least 32 characters");
  const key = crypto.createHash("sha256").update(secret).digest();
  return {
    seal(obj) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
      return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
    },
    open(str) {
      const [iv, tag, data] = str.split(".").map((s) => Buffer.from(s, "base64"));
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8"));
    },
  };
}

// ---------- Allowed sign-ins ----------
// ALLOWED_EMAIL_DOMAIN (e.g. thomasfamilylawcounsel.com) limits who can connect.
export function checkAllowed(email, allowedDomain) {
  const e = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(e)) return { ok: false, email: e, reason: "That doesn't look like an email address." };
  if (allowedDomain) {
    const domains = allowedDomain.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
    if (!domains.some((d) => e.endsWith("@" + d))) {
      return { ok: false, email: e, reason: `Only ${domains.map((d) => "@" + d).join(" or ")} accounts can connect.` };
    }
  }
  return { ok: true, email: e };
}

// ---------- OAuth provider for the MCP SDK ----------
// startLogin(res, pendingId, client): send the person to the app's login step.
// The app later calls provider.completeLogin(pendingId, userEmail, res).
export function createProvider({ store, startLogin }) {
  const clientsStore = {
    async getClient(clientId) { return (await store.get(`client:${clientId}`)) || undefined; },
    async registerClient(info) {
      const client = { ...info, client_id: crypto.randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
      await store.set(`client:${client.client_id}`, client, CLIENT_TTL);
      return client;
    },
  };

  async function issueTokens(user, clientId) {
    const access = randomToken();
    const refresh = randomToken();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL;
    await store.set(`at:${sha256(access)}`, { user, clientId, expiresAt }, ACCESS_TTL);
    await store.set(`rt:${sha256(refresh)}`, { user, clientId }, REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh };
  }

  return {
    clientsStore,

    async authorize(client, params, res) {
      const pendingId = randomToken();
      await store.set(`pending:${pendingId}`, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
      }, PENDING_TTL);
      await startLogin(res, pendingId, client);
    },

    // Look at a pending sign-in without consuming it (for re-showing a form).
    async peekPending(pendingId) {
      return pendingId ? store.get(`pending:${pendingId}`) : null;
    },

    // Called by the app once it has verified who the person is.
    async completeLogin(pendingId, user, res) {
      const pending = await store.take(`pending:${pendingId}`);
      if (!pending) {
        res.status(400).type("text/plain").send("This sign-in link has expired. Go back to Claude and click Connect again.");
        return;
      }
      const code = randomToken();
      await store.set(`code:${sha256(code)}`, { ...pending, user }, CODE_TTL);
      const url = new URL(pending.redirectUri);
      url.searchParams.set("code", code);
      if (pending.state != null) url.searchParams.set("state", pending.state);
      res.redirect(302, url.toString());
    },

    async challengeForAuthorizationCode(client, code) {
      const rec = await store.get(`code:${sha256(code)}`);
      if (!rec || rec.clientId !== client.client_id) throw new Error("Invalid authorization code");
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const rec = await store.take(`code:${sha256(code)}`); // single use
      if (!rec || rec.clientId !== client.client_id) throw new Error("Invalid authorization code");
      if (redirectUri && redirectUri !== rec.redirectUri) throw new Error("redirect_uri mismatch");
      return issueTokens(rec.user, client.client_id);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const rec = await store.take(`rt:${sha256(refreshToken)}`); // rotate on every use
      if (!rec || rec.clientId !== client.client_id) throw new Error("Invalid refresh token");
      return issueTokens(rec.user, client.client_id);
    },

    async verifyAccessToken(token) {
      const rec = await store.get(`at:${sha256(token)}`);
      if (!rec) {
        const { InvalidTokenError } = await import("@modelcontextprotocol/sdk/server/auth/errors.js");
        throw new InvalidTokenError("Invalid or expired token");
      }
      return { token, clientId: rec.clientId, scopes: [], expiresAt: rec.expiresAt, extra: { user: rec.user } };
    },

    async revokeToken(_client, { token }) {
      await store.del(`at:${sha256(token)}`);
      await store.del(`rt:${sha256(token)}`);
    },
  };
}

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
