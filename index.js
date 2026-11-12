import express from "express";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { rateLimit } from "express-rate-limit";
import { createStore, createVault, createProvider, checkAllowed, escapeHtml } from "./auth-core.js";

// ---- Configuration (set these as environment variables on Render) ----
// Each person signs in with their OWN mailbox when they click "Connect" in
// Claude. No mailbox password is stored in these settings.
const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");   // e.g. https://privateemail-mcp.onrender.com
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;                   // long random string; encrypts stored mailbox passwords
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || ""; // e.g. thomasfamilylawcounsel.com
const PORT = process.env.PORT || 3000;

// Read-only connector: it only reads mail over IMAP and never sends.
// (Render's free plan blocks outgoing SMTP, so send/reply tools were removed.)
const IMAP_HOST = process.env.IMAP_HOST || "mail.privateemail.com";
const IMAP_PORT = Number(process.env.IMAP_PORT) || 993;

const missing = ["BASE_URL", "ENCRYPTION_KEY"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const store = createStore({
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
  prefix: "privateemail",
});
if (store.kind === "memory") {
  console.warn("WARNING: no Upstash settings; sign-ins are kept in memory and lost on every restart.");
}
const vault = createVault(ENCRYPTION_KEY);

// Per-person mailbox credentials, encrypted at rest.
async function saveMailbox(email, pass) {
  await store.set(`mailbox:${email}`, vault.seal({ user: email, pass }));
}
async function loadMailbox(email) {
  const sealed = await store.get(`mailbox:${email}`);
  return sealed ? vault.open(sealed) : null;
}

// ---- Helper: turn imapflow's bare "Command failed" into a useful message ----
// The server's actual reason lives in err.responseText / err.serverResponseCode,
// which the MCP SDK would otherwise drop, leaving Claude with only "Command failed".
function explain(err, stage) {
  if (err.authenticationFailed) {
    return new Error(
      `${stage}: your mailbox rejected the saved password (it may have changed). In Claude, open Settings → Connectors, disconnect PrivateEmail, then connect again with your current password. Server said: ${err.responseText || err.message}`
    );
  }
  const detail = [err.serverResponseCode, err.responseText].filter(Boolean).join(" ");
  return new Error(`${stage} error: ${err.message}${detail ? ` (server said: ${detail})` : ""}`);
}

// ---- Helpers for read_email: readable text + attachment list ----
const MAX_BODY_CHARS = 20000;

// Walk the IMAP body structure: pick the first plain-text and HTML parts,
// and list everything that looks like an attachment.
function walkParts(node, out) {
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) walkParts(child, out);
    return out;
  }
  const part = node.part || "1"; // single-part messages have no part number
  const type = (node.type || "").toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const isAttachment =
    (node.disposition || "").toLowerCase() === "attachment" || (filename && !type.startsWith("text/"));
  if (isAttachment) {
    out.attachments.push({ filename: filename || "(unnamed)", type, size: node.size || null });
  } else if (type === "text/plain" && !out.plain) {
    out.plain = part;
  } else if (type === "text/html" && !out.html) {
    out.html = part;
  }
  return out;
}

async function downloadText(client, uid, part) {
  const { content } = await client.download(uid, part, { uid: true }); // decoded + converted to UTF-8
  const chunks = [];
  for await (const chunk of content) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function htmlToText(html) {
  const text = html
    .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const label = text.replace(/<[^>]+>/g, "").trim();
      return href.startsWith("mailto:") || !label || label === href ? label || href : `${label} (${href})`;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/\r/g, "");
  return tidy(text);
}

// Trim every line and collapse runs of blank lines (HTML emails are full of
// indentation and empty layout rows).
function tidy(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Helper: run a function with a connected IMAP client, then clean up ----
function newImapClient(creds) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });
}

async function withImap(creds, fn) {
  const client = newImapClient(creds);
  try {
    await client.connect();
  } catch (err) {
    console.error("IMAP connect failed:", err.responseText || err.message, err.authenticationFailed ? "(authentication failed)" : "");
    throw explain(err, "IMAP connect");
  }
  try {
    return await fn(client);
  } catch (err) {
    console.error("IMAP command failed:", err.responseText || err.message);
    throw explain(err, "IMAP");
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---- MCP server + tools ----
// A fresh server per request (the SDK's recommended stateless pattern), so one
// request finishing can't close the transport out from under another.
// `creds` is the signed-in person's own mailbox login; every tool uses only it.
function buildServer(creds) {
const server = new McpServer({ name: "privateemail-mcp", version: "1.0.0" });

server.tool(
  "search_emails",
  "Search emails in a PrivateEmail mailbox by sender, subject text, or recency. Returns a list of matching messages with their UID, subject, sender, date — use read_email with the UID to get the full body.",
  {
    query: z.string().optional().describe("Text to search for in subject or sender. Leave blank to just list recent emails."),
    folder: z.string().optional().describe("Mailbox folder, defaults to INBOX"),
    limit: z.number().int().min(1).max(50).optional().describe("Max number of results, default 10"),
  },
  async ({ query, folder, limit }) => {
    const mailbox = folder || "INBOX";
    const max = limit || 10;

    const messages = await withImap(creds, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        let uids;
        if (query && query.trim().length > 0) {
          uids = await client.search(
            { or: [{ subject: query }, { from: query }] },
            { uid: true }
          );
        } else {
          uids = await client.search({ all: true }, { uid: true });
        }
        uids = uids.sort((a, b) => b - a).slice(0, max);

        const results = [];
        for (const uid of uids) {
          const msg = await client.fetchOne(uid, { envelope: true, uid: true }, { uid: true });
          if (!msg) continue;
          results.push({
            uid: msg.uid,
            subject: msg.envelope?.subject || "(no subject)",
            from: msg.envelope?.from?.map((a) => a.address).join(", ") || "(unknown)",
            date: msg.envelope?.date || null,
          });
        }
        return results;
      } finally {
        lock.release();
      }
    });

    return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
  }
);

server.tool(
  "read_email",
  "Fetch a single email by its UID (from search_emails results): sender, recipients, date, subject, the readable body text (HTML emails are converted to plain text), and a list of attachments (name, type, size).",
  {
    uid: z.number().int().describe("The email UID from search_emails"),
    folder: z.string().optional().describe("Mailbox folder, defaults to INBOX"),
  },
  async ({ uid, folder }) => {
    const mailbox = folder || "INBOX";

    const email = await withImap(creds, async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msg = await client.fetchOne(
          uid,
          { envelope: true, bodyStructure: true, uid: true },
          { uid: true }
        );
        if (!msg) return null;

        const parts = walkParts(msg.bodyStructure || {}, { plain: null, html: null, attachments: [] });
        let body = "(no readable text in this email)";
        if (parts.plain) body = tidy(await downloadText(client, uid, parts.plain));
        else if (parts.html) body = htmlToText(await downloadText(client, uid, parts.html));
        if (body.length > MAX_BODY_CHARS) {
          body = body.slice(0, MAX_BODY_CHARS) + `\n\n[…truncated — email is ${body.length} characters long]`;
        }

        const fmt = (list) =>
          (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
        return {
          uid: msg.uid,
          subject: msg.envelope?.subject || "(no subject)",
          from: fmt(msg.envelope?.from) || "(unknown)",
          to: fmt(msg.envelope?.to),
          cc: fmt(msg.envelope?.cc) || undefined,
          date: msg.envelope?.date || null,
          attachments: parts.attachments,
          body,
        };
      } finally {
        lock.release();
      }
    });

    if (!email) {
      return { content: [{ type: "text", text: `No email found with UID ${uid} in ${mailbox}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(email, null, 2) }] };
  }
);

return server;
}

// ---- HTTP wiring (stateless Streamable HTTP, one transport per request) ----
const app = express();
app.set("trust proxy", 1); // Render sits in front of us; needed for correct client IPs and rate limits
app.use(express.json());

// ---- Sign-in: Claude's "Connect" button runs OAuth against this server ----
// The login step is a page where each person enters their OWN mailbox
// address and password. We check the login against the mail server, then
// store it encrypted under that person's address only.
function loginPage({ pending, email = "", error = "" }) {
  const domainNote = ALLOWED_EMAIL_DOMAIN
    ? `Use your <b>@${escapeHtml(ALLOWED_EMAIL_DOMAIN.split(",")[0].trim())}</b> address.`
    : "Use your full email address.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your mailbox</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--card:#fff;--ink:#1f1e1c;--muted:#6b6862;--line:#d9d6cf;--accent:#1f5f8b;--err:#a3322a}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a19;--card:#262523;--ink:#ecebe8;--muted:#a19e97;--line:#3d3b38;--accent:#6aa9d6;--err:#e58a82}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;width:100%;max-width:400px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted);font-size:14px}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:var(--err);font-size:14px;margin:12px 0 0}.fine{font-size:12.5px;margin:16px 0 0}
</style></head><body><main>
<h1>Connect your mailbox to Claude</h1>
<p>Sign in with <b>your own</b> work mailbox. Claude will be able to search and read only this mailbox. It cannot send, delete or change anything. ${domainNote}</p>
<form method="post" action="/login">
<input type="hidden" name="pending" value="${escapeHtml(pending)}">
<label for="email">Email address</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email)}">
<label for="password">Mailbox password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ""}
<button type="submit">Connect</button>
</form>
<p class="fine">Your password is checked with the mail server, then stored encrypted and used only to read your mail for you. To remove it, disconnect PrivateEmail in Claude's Settings → Connectors.</p>
</main></body></html>`;
}

const provider = createProvider({
  store,
  startLogin: async (res, pendingId) => {
    res.redirect(302, `/login?pending=${encodeURIComponent(pendingId)}`);
  },
});

const MCP_URL = new URL(`${BASE_URL}/mcp`);
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL(BASE_URL),
    resourceServerUrl: MCP_URL,
    resourceName: "Private Email (read-only)",
  })
);

app.get("/login", async (req, res) => {
  const pending = String(req.query.pending || "");
  if (!(await provider.peekPending(pending))) {
    return res.status(400).type("text/plain").send("This sign-in link has expired. Go back to Claude and click Connect again.");
  }
  res.type("html").send(loginPage({ pending }));
});

// Slow down password guessing: 10 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });

app.post("/login", loginLimiter, express.urlencoded({ extended: false }), async (req, res) => {
  const pending = String(req.body.pending || "");
  const password = String(req.body.password || "");
  if (!(await provider.peekPending(pending))) {
    return res.status(400).type("text/plain").send("This sign-in link has expired. Go back to Claude and click Connect again.");
  }
  const allowed = checkAllowed(req.body.email, ALLOWED_EMAIL_DOMAIN);
  const again = (error) => res.status(400).type("html").send(loginPage({ pending, email: allowed.email, error }));
  if (!allowed.ok) return again(allowed.reason);
  if (!password) return again("Enter your mailbox password.");

  // Prove the login works before saving anything.
  const client = newImapClient({ user: allowed.email, pass: password });
  try {
    await client.connect();
  } catch (err) {
    console.error("Sign-in check failed for", allowed.email, "-", err.responseText || err.message);
    return again(
      err.authenticationFailed
        ? "That email address and password didn't work. Check them by signing in to webmail at privateemail.com."
        : "Couldn't reach the mail server just now. Please try again in a minute."
    );
  } finally {
    await client.logout().catch(() => {});
  }

  await saveMailbox(allowed.email, password);
  console.log("Connected mailbox:", allowed.email);
  await provider.completeLogin(pending, allowed.email, res);
});

// ---- The MCP endpoint: only reachable with a signed-in person's token ----
const requireSignedIn = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(MCP_URL),
});

app.post("/mcp", requireSignedIn, async (req, res) => {
  try {
    const creds = await loadMailbox(req.auth.extra.user);
    if (!creds) {
      return res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "No mailbox saved for this sign-in. Disconnect and reconnect PrivateEmail in Claude." },
        id: null,
      });
    }
    const server = buildServer(creds);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// Stateless server: no standalone SSE stream or sessions to delete. Per the MCP
// spec, answer 405 so clients fall back cleanly instead of treating it as an error.
const methodNotAllowed = (req, res) =>
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

// The old "/mcp/<secret>" address is retired: it let anyone with the link use
// one shared mailbox. Answer clearly instead of a bare 404.
app.all("/mcp/:old", (req, res) =>
  res.status(410).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: `This connector address has been retired. Use ${BASE_URL}/mcp and sign in with your own mailbox.` },
    id: null,
  })
);

app.get("/", (req, res) => res.send("privateemail-mcp is running"));

app.listen(PORT, () => {
  console.log(`privateemail-mcp listening on port ${PORT}`);
});
