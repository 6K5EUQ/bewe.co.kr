# BEWE Mail — setup & deploy

In-app mail for registered users. Each approved account owns `id@bewe.co.kr` and
can send/receive from the web UI at `/mail.html`.

- **Auth (P1)** — signup → admin approval → login. SQLite (`data/app.db`).
- **Mailbox (P2)** — inbox/sent, compose, read, delete. Local↔local delivery is in-app.
- **Receive (P3)** — Cloudflare Email Worker (`email-worker/`) → `POST /api/mail/inbound`.
- **Send (P4)** — external recipients go out via Resend (requires DKIM on the domain).
- **Backup forward (P5)** — per-user backup address; Worker `message.forward()` to it.

## 1. Origin (lab) — env + install + restart

Add to `/home/lab/bewe.co.kr/.env` (see `.env.example`):

```
MAIL_DOMAIN=bewe.co.kr
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_USER=<your admin id>
ADMIN_PASS=<strong password>
INBOUND_SECRET=<openssl rand -hex 32>     # must equal the Worker secret
RESEND_API_KEY=<from resend.com>          # optional until external send is wanted
```

Deploy (note the extra `npm install` — a native dep `better-sqlite3` was added and
the usual deploy script does not run install):

```bash
ssh lab@100.87.14.125 "cd ~/bewe.co.kr && git pull --ff-only origin main && npm install && sudo systemctl restart bewe-web && sleep 2 && systemctl is-active bewe-web"
```

Then: open `https://bewe.co.kr/mail.html`, log in as ADMIN_USER, approve signups.

## 2. Inbound Worker (P3) — needs Cloudflare Workers + Email Routing

Email Routing is already on (`MX → route*.mx.cloudflare.net`). Deploy the Worker
and point the catch-all at it — see `email-worker/README.md`:

```bash
cd email-worker && npm install
npx wrangler login
npx wrangler secret put INBOUND_SECRET     # same value as origin .env
npx wrangler deploy
```

Dashboard → bewe.co.kr → Email → Email Routing → Routing rules → **catch-all →
Send to Worker → `bewe-email`**.

## 3. External send (P4) — Resend + DKIM

1. resend.com → add domain `bewe.co.kr` → it lists DKIM/SPF/return-path DNS records.
2. Add those records in Cloudflare DNS; wait for Resend to verify.
3. Create an API key → put in origin `.env` as `RESEND_API_KEY` → restart.

Until configured, external sends are saved to Sent with a notice but not delivered.

## 4. Backup forward (P5)

A user sets a backup address in the mail UI. Cloudflare only forwards to
**verified** destinations:

- Dashboard → Email → **Destination addresses** → add the backup address → the
  owner clicks the confirmation link Cloudflare emails.

Until verified, `message.forward()` is skipped silently; normal delivery is unaffected.

## Notes

- `CLAUDE.md`, `.env`, `data/app.db*` are git-ignored. Secrets never go in the repo.
- `emails`/`users` live in `data/app.db` (per-host runtime data, not deployed).
