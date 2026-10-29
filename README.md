# PrivateEmail connector for Claude

This is a small server that lets Claude read, search, and send email through
your Namecheap PrivateEmail mailbox. Once it's deployed, you add it to Claude
as a "custom connector" and Claude can use it in conversations.

It exposes 4 tools to Claude:
- **search_emails** — find emails by sender/subject, or just list recent ones
- **read_email** — get the full content of one email
- **reply_email** — reply to a specific email; automatically sends to the right
  person, keeps the subject threaded ("Re: ..."), and links it to the original
  message so it shows up in the same conversation in Gmail/Outlook/webmail
- **send_email** — send a brand-new (non-reply) email

**Typical flow:** you ask Claude about an email → Claude reads it and drafts a
reply right there in the chat for you to review → once you approve, Claude
calls `reply_email` to actually send it. The drafting itself doesn't need a
tool — that's just Claude writing text in the conversation, same as always.

Every send/reply also saves a copy into your mailbox's Sent folder, since
sending over raw SMTP doesn't do that automatically the way a normal email
app does.

## Part 1 — Put the code on GitHub

1. Go to github.com and sign in (create a free account if you don't have one).
2. Click the "+" in the top right → "New repository". Name it `privateemail-mcp`,
   keep it **Private**, and click "Create repository".
3. On the new repo page, click "uploading an existing file" and drag in every
   file from this folder *except* `.env.example` isn't required but is fine to
   include — just don't upload a real `.env` file with your actual password in it.
4. Commit the files.

## Part 2 — Deploy it on Render (free)

1. Go to render.com and sign up (you can sign up with your GitHub account —
   this also makes Part 3 automatic).
2. Click "New +" → "Web Service".
3. Connect your `privateemail-mcp` GitHub repo.
4. Fill in:
   - **Name:** privateemail-mcp (or anything you like)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Under "Environment Variables", add three:
   - `EMAIL_USER` = your full PrivateEmail address (e.g. `you@yourdomain.com`)
   - `EMAIL_PASS` = your mailbox password
   - `MCP_SECRET` = a long random string you make up yourself (e.g. mash your
     keyboard for 30 characters). This acts like a password for the connector's
     web address, so keep it private — don't share it outside this setup.
6. Click "Create Web Service". Render will build and start it — this takes a
   few minutes the first time.
7. Once it's live, Render shows you a URL like
   `https://privateemail-mcp-xxxx.onrender.com`. Visiting that URL in a browser
   should show "privateemail-mcp is running".

**Note on the free tier:** Render's free web services go to sleep after 15
minutes of no traffic, and take 30–60 seconds to wake up on the next request.
That means the first email search/send after a quiet period might feel slow —
that's normal, not an error.

## Part 3 — Add it to Claude

1. Your connector's full address is your Render URL plus `/mcp/` plus the
   `MCP_SECRET` you set. For example:
   `https://privateemail-mcp-xxxx.onrender.com/mcp/your-long-random-string`
2. In Claude, go to **Settings → Connectors → Add custom connector**.
3. Paste that full URL (including the secret) into the server URL field.
4. Leave OAuth Client ID/Secret blank — this connector doesn't use OAuth, the
   secret is already baked into the URL.
5. Save. Then enable it for a conversation via the "+" button in the chat box.

## Security notes

- Your mailbox password is stored only as an environment variable on Render —
  it's never in the code itself, and I (Claude) never see it.
- Anyone who has your full connector URL (with the secret) could read and
  send email as you, so treat that URL like a password.
- If you ever want to revoke access, just change `MCP_SECRET` on Render and
  update the connector URL in Claude — the old URL stops working immediately.

## If something breaks

The IMAP/SMTP logic is written against Namecheap's documented settings
(`mail.privateemail.com`, IMAP port 993, SMTP port 465), but I couldn't test
it live from here since I don't have network access to your mailbox. If you
hit errors after deploying, paste Render's log output back to me (in your
Render dashboard, click the service → "Logs") and I'll help debug it.
