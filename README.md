# Private Email connector for Claude (read-only, one per firm)

A small server that lets Claude **search and read** Private Email (Namecheap) mailboxes. It cannot send, delete or change mail.

**One server serves the whole firm.** Each person clicks **Connect** in Claude and signs in with **their own** mailbox address and password. Their login is checked against the mail server, stored encrypted, and used only for their own requests. Nobody can reach anyone else's mailbox, and there is no shared secret address.

## How sign-in works

1. A person clicks **Connect** on the PrivateEmail connector in Claude.
2. Claude opens this server's sign-in page. They enter their own firm address and mailbox password.
3. The server checks the login with `mail.privateemail.com`. If it works, the password is encrypted (AES-256-GCM) and saved under that person's address.
4. Claude receives a token tied to that person only. Every search or read uses only their mailbox.

Only addresses at `ALLOWED_EMAIL_DOMAIN` can connect. Tokens last one hour and renew automatically for up to 90 days of inactivity.

## Deploy or update on Render (maintainer only)

1. Upload these files to the GitHub repository Render deploys from: `index.js`, `auth-core.js`, `package.json`, `package-lock.json`, `README.md`, `env.example`.
2. In Render, open the service → **Environment** and set:

   | Variable | Value |
   |---|---|
   | `BASE_URL` | The firm address the server runs on, e.g. `https://claude-mail.thomasfamilylawcounsel.com` (no slash at the end). Requests to any other address are redirected here. |
   | `FIRM_NAME` | `Thomas Law Group, P.C.` (shown on the sign-in page) |
   | `ENCRYPTION_KEY` | Click **Generate**. Never change it; changing it means everyone must reconnect. |
   | `ALLOWED_EMAIL_DOMAIN` | `thomasfamilylawcounsel.com` |
   | `UPSTASH_REDIS_REST_URL` | From Upstash (the same database as the OneDrive connector is fine) |
   | `UPSTASH_REDIS_REST_TOKEN` | From Upstash |

   **Delete** the old `EMAIL_USER`, `EMAIL_PASS` and `MCP_SECRET` variables. They are no longer used.
3. Save. Render redeploys. Opening `BASE_URL` should show "privateemail-mcp is running".
4. In Claude, **Organization settings → Connectors**: remove the old PrivateEmail connector, then **Add → Custom connector**:
   - **URL:** `BASE_URL/mcp` (e.g. `https://claude-mail.thomasfamilylawcounsel.com/mcp`)
   - **Authentication:** Sign in now
   - **OAuth client:** Register automatically
5. Each person (including you) then goes to **Settings → Connectors**, clicks **Connect** on PrivateEmail and signs in with their own mailbox.

The old `/mcp/<secret>` address now returns "retired" and no longer works.

## Why a firm address

The sign-in page asks for a mailbox password. On a generic hosting address (especially one containing "privateemail") Google Safe Browsing classifies that as phishing and Chrome blocks it. Run the server on a subdomain of the firm's own domain (Render → Settings → Custom Domains, plus a CNAME record at Namecheap) so staff sign in on an address they recognise.

## Troubleshooting

- **"Your mailbox rejected the saved password"**: the person changed their mailbox password. They disconnect PrivateEmail in Claude and connect again.
- **Sign-in page says the link expired**: it lasts 10 minutes. Go back to Claude and click Connect again.
- **First request fails or is slow**: Render's free plan was asleep. Try again after 30–60 seconds.
- **Everyone was signed out after a restart**: the Upstash variables are missing or wrong (check for stray quote marks).
