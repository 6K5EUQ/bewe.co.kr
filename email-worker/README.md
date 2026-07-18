# bewe-email — inbound Email Worker

Receives all mail for `*@bewe.co.kr` (Cloudflare Email Routing catch-all → this
Worker), parses it, and POSTs a compact JSON to the bewe.co.kr origin webhook
(`/api/mail/inbound`). Unknown recipients are bounced; a user's verified backup
address (P5) gets a forwarded copy.

## One-time deploy (needs Cloudflare account with Workers + Email Routing)

Prereq: on the domain `bewe.co.kr`, Email Routing is already enabled (MX →
`route*.mx.cloudflare.net`).

```bash
cd email-worker
npm install

# authenticate (opens browser); needs Workers + Email Routing scopes
npx wrangler login

# secret must equal the origin's INBOUND_SECRET (.env on lab)
npx wrangler secret put INBOUND_SECRET      # paste: openssl rand -hex 32

npx wrangler deploy
```

## Wire Email Routing to the Worker

Cloudflare dashboard → **bewe.co.kr → Email → Email Routing → Routing rules**:

- Set the **catch-all** action to **Send to a Worker → `bewe-email`**.
  (Or per-address rules for specific mailboxes → same Worker.)

Once set, external mail to any `id@bewe.co.kr` flows:
`sender → Cloudflare MX → bewe-email Worker → POST /api/mail/inbound → user's inbox`.

## Backup forwarding (P5)

`message.forward(backup)` only works to addresses **verified** in Email Routing
(Cloudflare → Email → Destination addresses → add + confirm the email link).
Until verified, the forward is skipped silently and normal delivery still works.

## Config

- `wrangler.toml` → `INBOUND_URL` = `https://bewe.co.kr/api/mail/inbound`
- Secret `INBOUND_SECRET` (via `wrangler secret put`) = origin `.env` `INBOUND_SECRET`
