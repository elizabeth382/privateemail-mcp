import express from "express";
import { ImapFlow } from "imapflow";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---- Configuration (set these as environment variables on your host) ----
const EMAIL_USER = process.env.EMAIL_USER;          // your full PrivateEmail address
const EMAIL_PASS = process.env.EMAIL_PASS;           // your mailbox password
const MCP_SECRET = process.env.MCP_SECRET;           // random string you make up (acts like a password for the connector URL)
const PORT = process.env.PORT || 3000;

// Read-only connector: it only reads mail over IMAP and never sends.
// (Render's free plan blocks outgoing SMTP, so send/reply tools were removed.)
const IMAP_HOST = process.env.IMAP_HOST || "mail.privateemail.com";
const IMAP_PORT = 993;

if (!EMAIL_USER || !EMAIL_PASS || !MCP_SECRET) {
  console.error("Missing required environment variables: EMAIL_USER, EMAIL_PASS, MCP_SECRET");
  process.exit(1);
}

// ---- Helper: turn imapflow's bare "Command failed" into a useful message ----
// The server's actual reason lives in err.responseText / err.serverResponseCode,
// which the MCP SDK would otherwise drop, leaving Claude with only "Command failed".
function explain(err, stage) {
  if (err.authenticationFailed) {
    return new Error(
      `${stage}: login rejected by ${IMAP_HOST} — check EMAIL_USER (full address) and EMAIL_PASS on Render. Server said: ${err.responseText || err.message}`
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
async function withImap(fn) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
    logger: false,
  });
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
function buildServer() {
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

    const messages = await withImap(async (client) => {
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

    const email = await withImap(async (client) => {
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
app.use(express.json());

// The secret in the URL path acts as a simple password for this endpoint,
// since anyone who reaches this URL can call the tools above.
app.post(`/mcp/${MCP_SECRET}`, async (req, res) => {
  try {
    const server = buildServer();
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
app.get(`/mcp/${MCP_SECRET}`, methodNotAllowed);
app.delete(`/mcp/${MCP_SECRET}`, methodNotAllowed);

app.get("/", (req, res) => res.send("privateemail-mcp is running"));

app.listen(PORT, () => {
  console.log(`privateemail-mcp listening on port ${PORT}`);
});
