// BEWE inbound Email Worker.
//
// Cloudflare Email Routing delivers every message for *@bewe.co.kr here (catch-all
// rule → this Worker). We parse the MIME (incl. attachments) and POST a compact
// JSON to the bewe.co.kr origin webhook (/api/mail/inbound). The origin decides
// delivery and handles any backup copy itself, so this Worker does no forwarding.
//
// Vars (wrangler.toml): INBOUND_URL. Secret: INBOUND_SECRET.
import PostalMime from 'postal-mime';

const MAX_ATTACH = 10 * 1024 * 1024; // cap total attachment bytes forwarded

export default {
    async email(message, env, ctx) {
        let parsed;
        try {
            const raw = await new Response(message.raw).arrayBuffer();
            parsed = await PostalMime.parse(raw);
        } catch (e) {
            message.setReject('Temporary processing error, please retry');
            return;
        }

        const attachments = [];
        let total = 0;
        for (const a of (parsed.attachments || [])) {
            const content = toBase64(a.content);
            if (!content) continue;
            total += Math.floor(content.length * 3 / 4);
            if (total > MAX_ATTACH) break;
            attachments.push({
                filename: a.filename || 'file',
                mime: a.mimeType || 'application/octet-stream',
                content,
            });
        }

        const payload = {
            from: message.from,
            to: message.to,
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || '',
            messageId: parsed.messageId || '',
            date: parsed.date || '',
            attachments,
        };

        let delivered = false;
        try {
            const resp = await fetch(env.INBOUND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': env.INBOUND_SECRET },
                body: JSON.stringify(payload),
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                delivered = !!data.delivered;
            } else if (resp.status >= 500) {
                message.setReject('Temporary failure, please retry');
                return;
            }
        } catch (e) {
            message.setReject('Temporary failure, please retry');
            return;
        }

        if (!delivered) { message.setReject('No such recipient'); return; }
    },
};

function abToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function toBase64(content) {
    if (!content) return '';
    if (content instanceof ArrayBuffer) return abToBase64(content);
    if (ArrayBuffer.isView(content)) return abToBase64(content.buffer);
    if (typeof content === 'string') return btoa(unescape(encodeURIComponent(content)));
    return '';
}
