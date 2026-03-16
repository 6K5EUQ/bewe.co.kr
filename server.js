require('dotenv').config();
const express = require('express');
const net = require('net');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const RELAY_HOST = process.env.RELAY_HOST || '127.0.0.1';
const RELAY_PORT = parseInt(process.env.RELAY_PORT) || 7700;

// ── Relay Protocol ──────────────────────────────────────────────────────────
const RELAY_MAGIC = Buffer.from([0x42, 0x52, 0x4C, 0x59]); // 'BRLY'
const PKT_LIST_REQ  = 0x20;
const PKT_LIST_RESP = 0x21;
const HDR_SIZE = 9; // 4(magic) + 1(type) + 4(len)

// RelayStation: 32(id) + 64(name) + 4(lat) + 4(lon) + 1(tier) + 1(users) + 2(pad) = 108
// RelayListResp header: 2(count) + 1(lan_ip_count) + 8*16(lan_ips) = 131
const STATION_SIZE = 108;
const LIST_RESP_HDR = 131;

let cachedStations = [];

function fetchStations() {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        const chunks = [];

        sock.connect(RELAY_PORT, RELAY_HOST, () => {
            // Send LIST_REQ
            const pkt = Buffer.alloc(HDR_SIZE);
            RELAY_MAGIC.copy(pkt, 0);
            pkt[4] = PKT_LIST_REQ;
            pkt.writeUInt32LE(0, 5); // payload len = 0
            sock.write(pkt);
        });

        sock.on('data', (data) => chunks.push(data));

        sock.on('end', () => {
            try {
                const buf = Buffer.concat(chunks);
                if (buf.length < HDR_SIZE) return resolve([]);
                // Verify magic
                if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return resolve([]);
                if (buf[4] !== PKT_LIST_RESP) return resolve([]);
                const payloadLen = buf.readUInt32LE(5);
                const payload = buf.subarray(HDR_SIZE, HDR_SIZE + payloadLen);
                if (payload.length < LIST_RESP_HDR) return resolve([]);

                const count = payload.readUInt16LE(0);
                const stations = [];

                for (let i = 0; i < count; i++) {
                    const off = LIST_RESP_HDR + i * STATION_SIZE;
                    if (off + STATION_SIZE > payload.length) break;

                    const idBuf = payload.subarray(off, off + 32);
                    const nameBuf = payload.subarray(off + 32, off + 96);
                    const lat = payload.readFloatLE(off + 96);
                    const lon = -payload.readFloatLE(off + 100);
                    const tier = payload[off + 104];
                    const users = payload[off + 105];

                    stations.push({
                        station_id: idBuf.toString('utf8').replace(/\0/g, ''),
                        name: nameBuf.toString('utf8').replace(/\0/g, ''),
                        lat, lon, tier, users
                    });
                }
                resolve(stations);
            } catch (e) {
                console.error('Parse error:', e.message);
                resolve([]);
            }
        });

        sock.on('error', () => resolve([]));
        sock.on('timeout', () => { sock.destroy(); resolve([]); });
    });
}

// Poll relay every 5 seconds
async function pollLoop() {
    while (true) {
        try {
            cachedStations = await fetchStations();
        } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, 5000));
    }
}
pollLoop();

// ── OpenSky ADS-B ──────────────────────────────────────────────────────────
let cachedAircraft = [];

const OPENSKY_CLIENT_ID = process.env.OPENSKY_CLIENT_ID || '';
const OPENSKY_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET || '';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

let openskyToken = '';
let tokenExpiresAt = 0;

async function getOpenSkyToken() {
    if (openskyToken && Date.now() < tokenExpiresAt - 60000) return openskyToken;
    try {
        const resp = await fetch(OPENSKY_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=client_credentials&client_id=${OPENSKY_CLIENT_ID}&client_secret=${OPENSKY_CLIENT_SECRET}`
        });
        if (!resp.ok) {
            console.error(`OpenSky token: ${resp.status} ${resp.statusText}`);
            return null;
        }
        const data = await resp.json();
        openskyToken = data.access_token;
        tokenExpiresAt = Date.now() + data.expires_in * 1000;
        console.log('OpenSky: token acquired');
        return openskyToken;
    } catch (e) {
        console.error('OpenSky token error:', e.message);
        return null;
    }
}

async function fetchAircraft() {
    try {
        const token = await getOpenSkyToken();
        if (!token) return;
        const resp = await fetch('https://opensky-network.org/api/states/all', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) {
            console.error(`OpenSky API: ${resp.status} ${resp.statusText}`);
            if (resp.status === 401) { openskyToken = ''; tokenExpiresAt = 0; }
            return;
        }
        const data = await resp.json();
        if (!data.states) return;
        cachedAircraft = data.states
            .filter(s => s[6] != null && s[5] != null)
            .map(s => [s[6], s[5], s[10] != null ? s[10] : 0]); // [lat, lon, heading]
        console.log(`OpenSky: ${cachedAircraft.length} aircraft loaded`);
    } catch (e) { console.error('OpenSky error:', e.message); }
}

fetchAircraft();
setInterval(fetchAircraft, 30000); // 30초 간격 (크레딧 절약)

// ── Express ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stations', (req, res) => {
    res.json(cachedStations);
});

app.get('/api/aircraft', (req, res) => {
    res.json(cachedAircraft);
});

app.listen(PORT, () => {
    console.log(`BEWE Web running on http://localhost:${PORT}`);
});
