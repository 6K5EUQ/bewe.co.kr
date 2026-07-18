// BEWE inbound Email Worker.
//
// Cloudflare Email Routing delivers every message for *@bewe.co.kr here (catch-all
// rule → this Worker). We parse the MIME, POST a compact JSON to the bewe.co.kr
// origin webhook, and let the origin decide delivery. Unknown recipients are
// rejected (bounced); a configured & verified backup address gets a forwarded copy.
//
// Bindings / vars (see wrangler.toml):
//   INBOUND_URL     – origin webhook, e.g. https://bewe.co.kr/api/mail/inbound
//   INBOUND_SECRET  – shared secret (wrangler secret put INBOUND_SECRET)
import PostalMime from 'postal-mime';

export default {
    async email(message, env, ctx) {
        let parsed;
        try {
            // message.raw is a single-use stream — buffer before parsing.
            const raw = await new Response(message.raw).arrayBuffer();
            parsed = await PostalMime.parse(raw);
        } catch (e) {
            // Can't parse → don't lose it; ask sender to retry.
            message.setReject('Temporary processing error, please retry');
            return;
        }

        const payload = {
            from: message.from,                 // envelope MAIL FROM
            to: message.to,                     // envelope RCPT TO (catch-all target)
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || '',
            messageId: parsed.messageId || '',
            date: parsed.date || '',
        };

        let delivered = false;
        let backup = null;
        try {
            const resp = await fetch(env.INBOUND_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Inbound-Secret': env.INBOUND_SECRET,
                },
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                delivered = !!data.delivered;
                backup = data.backup_email || null;
            } else if (resp.status >= 500) {
                message.setReject('Temporary failure, please retry');
                return;
            }
        } catch (e) {
            // Origin unreachable — soft-reject so the sending server retries later.
            message.setReject('Temporary failure, please retry');
            return;
        }

        if (!delivered) {
            message.setReject('No such recipient');
            return;
        }

        // P5: forward a copy to the user's verified backup address, if set.
        // message.forward() only succeeds for addresses verified in Email Routing.
        if (backup) {
            try { await message.forward(backup); } catch (e) { /* not verified yet — ignore */ }
        }
    },
};
