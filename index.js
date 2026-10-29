import express from "express";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---- Configuration (set these as environment variables on your host) ----
const EMAIL_USER = process.env.EMAIL_USER;          // your full PrivateEmail address
const EMAIL_PASS = process.env.EMAIL_PASS;           // your mailbox password
const MCP_SECRET = process.env.MCP_SECRET;           // random string you make up (acts like a password for the connector URL)
const PORT = process.env.PORT || 3000;

const IMAP_HOST = "mail.privateemail.com";
const IMAP_PORT = 993;
const SMTP_HOST = "mail.privateemail.com";
const SMTP_PORT = 465;

if (!EMAIL_USER || !EMAIL_PASS || !MCP_SECRET) {
  console.error("Missing required environment variables: EMAIL_USER, EMAIL_PASS, MCP_SECRET");
  process.exit(1);
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
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---- SMTP transport (shared) ----
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: true,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

// Build a raw MIME message from the same options we send, so we can also
// archive an identical copy into the Sent folder.
function buildRawMessage(mailOptions) {
  return new Promise((resolve, reject) => {
    const composer = new MailComposer(mailOptions);
    composer.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
}

// Find the mailbox's Sent folder — prefer the IMAP "special-use" flag,
// fall back to common folder names if the server doesn't advertise it.
async function findSentFolder(client) {
  const list = await client.list();
  const special = list.find((mb) => mb.specialUse === "\\Sent");
  if (special) return special.path;
  const candidates = ["Sent", "Sent Items", "INBOX.Sent", "INBOX/Sent"];
  const paths = list.map((mb) => mb.path);
  return candidates.find((c) => paths.includes(c)) || null;
}

// Send a message via SMTP, then best-effort save a copy into Sent so it
// shows up correctly in webmail / other email clients.
async function sendAndArchive(mailOptions) {
  const info = await transporter.sendMail(mailOptions);
  try {
    const raw = await buildRawMessage(mailOptions);
    await withImap(async (client) => {
      const sentFolder = await findSentFolder(client);
      if (sentFolder) {
        await client.append(sentFolder, raw, ["\\Seen"]);
      }
    });
  } catch (archiveErr) {
    console.error("Sent, but could not save a copy to the Sent folder:", archiveErr.message);
  }
  return info;
}

// ---- MCP server + tools ----
const server = new McpServer({ name: "privateemail-mcp", version: "1.0.0" });

server.tool(
  "search_emails",
  "Search emails in a PrivateEmail mailbox by sender, subject text, or recency. Returns a list of matching messages with their UID, subject, sender, date — use read_email with the UID to get the full body, or reply_email to respond to one.",
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
  "Fetch the full content of a single email by its UID (from search_emails results).",
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
          { envelope: true, source: true, uid: true },
          { uid: true }
        );
        if (!msg) return null;
        return {
          uid: msg.uid,
          subject: msg.envelope?.subject || "(no subject)",
          from: msg.envelope?.from?.map((a) => a.address).join(", ") || "(unknown)",
          to: msg.envelope?.to?.map((a) => a.address).join(", ") || "",
          date: msg.envelope?.date || null,
          body: msg.source ? msg.source.toString("utf-8") : "(no content)",
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

server.tool(
  "reply_email",
  "Reply to a specific email by its UID. Automatically sends to the original sender, prefixes the subject with 'Re:' if needed, and threads the reply to the original message so it appears in the same conversation in Gmail/Outlook/webmail. Also saves a copy to the Sent folder.",
  {
    uid: z.number().int().describe("UID of the email being replied to (from search_emails)"),
    body: z.string().describe("Plain-text reply body"),
    folder: z.string().optional().describe("Folder the original email is in, defaults to INBOX"),
    cc: z.string().optional().describe("Additional CC recipients, comma-separated"),
  },
  async ({ uid, body, folder, cc }) => {
    const mailbox = folder || "INBOX";

    const original = await withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox);
      try {
        return await client.fetchOne(uid, { envelope: true, uid: true }, { uid: true });
      } finally {
        lock.release();
      }
    });

    if (!original) {
      return { content: [{ type: "text", text: `No email found with UID ${uid} in ${mailbox}` }] };
    }

    const replyTo = original.envelope?.from?.map((a) => a.address).join(", ");
    if (!replyTo) {
      return { content: [{ type: "text", text: "Couldn't determine the original sender's address, so I didn't send anything." }] };
    }
    const originalSubject = original.envelope?.subject || "";
    const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
    const messageId = original.envelope?.messageId || undefined;

    const info = await sendAndArchive({
      from: EMAIL_USER,
      to: replyTo,
      cc: cc || undefined,
      subject,
      text: body,
      inReplyTo: messageId,
      references: messageId,
    });

    return {
      content: [{ type: "text", text: `Reply sent to ${replyTo}. Message ID: ${info.messageId}` }],
    };
  }
);

server.tool(
  "send_email",
  "Send a new (non-reply) email from the connected PrivateEmail mailbox. Also saves a copy to the Sent folder.",
  {
    to: z.string().describe("Recipient email address (comma-separate for multiple)"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Plain-text email body"),
    cc: z.string().optional().describe("CC recipients, comma-separated"),
  },
  async ({ to, subject, body, cc }) => {
    const info = await sendAndArchive({
      from: EMAIL_USER,
      to,
      cc: cc || undefined,
      subject,
      text: body,
    });

    return { content: [{ type: "text", text: `Email sent to ${to}. Message ID: ${info.messageId}` }] };
  }
);

// ---- HTTP wiring (stateless Streamable HTTP, one transport per request) ----
const app = express();
app.use(express.json());

// The secret in the URL path acts as a simple password for this endpoint,
// since anyone who reaches this URL can call the tools above.
app.post(`/mcp/${MCP_SECRET}`, async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/", (req, res) => res.send("privateemail-mcp is running"));

app.listen(PORT, () => {
  console.log(`privateemail-mcp listening on port ${PORT}`);
});
