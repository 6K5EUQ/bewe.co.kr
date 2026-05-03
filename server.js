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
const PKT_LIST_REQ            = 0x20;
const PKT_LIST_RESP           = 0x21;
const PKT_LIST_REQ_V2         = 0x22;
const PKT_LIST_RESP_V2        = 0x23;
const PKT_STATION_DETAIL_REQ  = 0x24;
const PKT_STATION_DETAIL_RESP = 0x25;
const HDR_SIZE = 9; // 4(magic) + 1(type) + 4(len)

// RelayStation v1: 32(id) + 64(name) + 4(lat) + 4(lon) + 1(tier) + 1(users) + 2(pad) = 108
// v2 extension: + 32(operator) + 8(cf_hz) + 4(sr) + 1(hist_rec) + 1(ch_count) + 2(pad) = +48 → 156
// RelayListResp header: 2(count) + 1(lan_ip_count) + 8*16(lan_ips) = 131
const STATION_SIZE      = 108;
const STATION_SIZE_V2   = 156;
const LIST_RESP_HDR     = 131;
const HSTATE_CH_SIZE    = 48;
const HSTATE_SIZE       = 32 + 8 + 4 + 1 + 1 + 2 + HSTATE_CH_SIZE * 10; // 528

let cachedStations = [];
let cachedStationsV2 = [];   // status-page v2 — extended LIST including operator/freq/sr

const POLL_INTERVAL_MS = 2000;
const OFFLINE_THRESHOLD_MS = 15000;

const centralStatus = {
    reachable: false,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastError: null,
    responseMs: null,
};

const stationLastSeen = new Map(); // station_id → { lastSeenAt, name, lat, lon, tier, users }

function fetchStations() {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        const chunks = [];
        const startedAt = Date.now();
        centralStatus.lastAttemptAt = startedAt;
        let settled = false;

        const fail = (reason) => {
            if (settled) return;
            settled = true;
            centralStatus.reachable = false;
            centralStatus.lastError = reason;
            centralStatus.responseMs = Date.now() - startedAt;
            resolve([]);
        };

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
            if (settled) return;
            try {
                const buf = Buffer.concat(chunks);
                if (buf.length < HDR_SIZE) return fail('short response');
                // Verify magic
                if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return fail('bad magic');
                if (buf[4] !== PKT_LIST_RESP) return fail('unexpected packet type');
                const payloadLen = buf.readUInt32LE(5);
                const payload = buf.subarray(HDR_SIZE, HDR_SIZE + payloadLen);
                if (payload.length < LIST_RESP_HDR) return fail('short payload');

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
                settled = true;
                centralStatus.reachable = true;
                centralStatus.lastSuccessAt = Date.now();
                centralStatus.lastError = null;
                centralStatus.responseMs = centralStatus.lastSuccessAt - startedAt;
                resolve(stations);
            } catch (e) {
                console.error('Parse error:', e.message);
                fail('parse error: ' + e.message);
            }
        });

        sock.on('error', (e) => fail(e.code || e.message || 'socket error'));
        sock.on('timeout', () => { sock.destroy(); fail('timeout'); });
    });
}

async function pollLoop() {
    while (true) {
        try {
            cachedStations = await fetchStations();
            const now = Date.now();
            for (const s of cachedStations) {
                if (!s.station_id) continue;
                stationLastSeen.set(s.station_id, {
                    lastSeenAt: now,
                    name: s.name,
                    lat: s.lat,
                    lon: s.lon,
                    tier: s.tier,
                    users: s.users,
                });
            }
        } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}
pollLoop();

// ── Status v2 polling: extended station record (operator/freq/sr) ───────────
function fetchStationsV2() {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        const chunks = [];
        let settled = false;
        const fail = () => { if(!settled){ settled = true; resolve([]); } };

        sock.connect(RELAY_PORT, RELAY_HOST, () => {
            const pkt = Buffer.alloc(HDR_SIZE);
            RELAY_MAGIC.copy(pkt, 0);
            pkt[4] = PKT_LIST_REQ_V2;
            pkt.writeUInt32LE(0, 5);
            sock.write(pkt);
        });
        sock.on('data', (d) => chunks.push(d));
        sock.on('end', () => {
            if (settled) return;
            try {
                const buf = Buffer.concat(chunks);
                if (buf.length < HDR_SIZE) return fail();
                if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return fail();
                if (buf[4] !== PKT_LIST_RESP_V2) return fail();
                const payloadLen = buf.readUInt32LE(5);
                const payload = buf.subarray(HDR_SIZE, HDR_SIZE + payloadLen);
                if (payload.length < LIST_RESP_HDR) return fail();

                const count = payload.readUInt16LE(0);
                const stations = [];
                for (let i = 0; i < count; i++) {
                    const off = LIST_RESP_HDR + i * STATION_SIZE_V2;
                    if (off + STATION_SIZE_V2 > payload.length) break;
                    const idBuf   = payload.subarray(off, off + 32);
                    const nameBuf = payload.subarray(off + 32, off + 96);
                    const lat = payload.readFloatLE(off + 96);
                    // Wire convention is W-positive; flip to standard E-positive for display.
                    const lon = -payload.readFloatLE(off + 100);
                    const tier  = payload[off + 104];
                    const users = payload[off + 105];
                    // v2 fields
                    const opBuf = payload.subarray(off + 108, off + 140);
                    const center_freq_hz = Number(payload.readBigUInt64LE(off + 140));
                    const sample_rate_hz = payload.readUInt32LE(off + 148);
                    const hist_recording = payload[off + 152];
                    const channel_count  = payload[off + 153];
                    stations.push({
                        station_id:    idBuf.toString('utf8').replace(/\0/g, ''),
                        name:          nameBuf.toString('utf8').replace(/\0/g, ''),
                        lat, lon, tier, users,
                        operator_login: opBuf.toString('utf8').replace(/\0/g, ''),
                        center_freq_hz, sample_rate_hz,
                        hist_recording: !!hist_recording,
                        channel_count,
                    });
                }
                settled = true;
                resolve(stations);
            } catch (e) {
                console.error('LIST_V2 parse:', e.message);
                fail();
            }
        });
        sock.on('error', () => fail());
        sock.on('timeout', () => { sock.destroy(); fail(); });
    });
}

async function pollLoopV2() {
    while (true) {
        try { cachedStationsV2 = await fetchStationsV2(); } catch (e) { /* ignore */ }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
}
pollLoopV2();

// ── On-demand: fetch full host state for one station ───────────────────────
function fetchStationDetail(station_id) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        const chunks = [];
        let settled = false;
        const done = (val) => { if(!settled){ settled = true; resolve(val); } };

        sock.connect(RELAY_PORT, RELAY_HOST, () => {
            // Build STATION_DETAIL_REQ packet: header + 32-byte station_id payload
            const pkt = Buffer.alloc(HDR_SIZE + 32);
            RELAY_MAGIC.copy(pkt, 0);
            pkt[4] = PKT_STATION_DETAIL_REQ;
            pkt.writeUInt32LE(32, 5);
            const idBuf = Buffer.alloc(32);
            Buffer.from(station_id, 'utf8').copy(idBuf, 0, 0, Math.min(31, station_id.length));
            idBuf.copy(pkt, HDR_SIZE);
            sock.write(pkt);
        });
        sock.on('data', (d) => chunks.push(d));
        sock.on('end', () => {
            try {
                const buf = Buffer.concat(chunks);
                if (buf.length < HDR_SIZE) return done(null);
                if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return done(null);
                if (buf[4] !== PKT_STATION_DETAIL_RESP) return done(null);
                const payloadLen = buf.readUInt32LE(5);
                if (payloadLen === 0) return done(null);  // station unknown / no state
                const p = buf.subarray(HDR_SIZE, HDR_SIZE + payloadLen);
                if (p.length < HSTATE_SIZE) return done(null);

                const opBuf = p.subarray(0, 32);
                const out = {
                    operator_login: opBuf.toString('utf8').replace(/\0/g, ''),
                    center_freq_hz: Number(p.readBigUInt64LE(32)),
                    sample_rate_hz: p.readUInt32LE(40),
                    hist_recording: !!p[44],
                    channel_count:  p[45],
                    channels: [],
                };
                const chBase = 48; // 32 + 8 + 4 + 1 + 1 + 2
                for (let i = 0; i < 10; i++) {
                    const o = chBase + i * HSTATE_CH_SIZE;
                    if (!p[o]) continue; // active=0 → skip
                    out.channels.push({
                        index: i,
                        mode:         p[o + 1],
                        digital_mode: p[o + 2],
                        iq_rec_on:    !!p[o + 3],
                        audio_rec_on: !!p[o + 4],
                        dem_run:      !!p[o + 5],
                        s_mhz: p.readFloatLE(o + 8),
                        e_mhz: p.readFloatLE(o + 12),
                        owner: p.subarray(o + 16, o + 48).toString('utf8').replace(/\0/g, ''),
                    });
                }
                done(out);
            } catch (e) { console.error('DETAIL parse:', e.message); done(null); }
        });
        sock.on('error', () => done(null));
        sock.on('timeout', () => { sock.destroy(); done(null); });
    });
}

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
setInterval(fetchAircraft, 60000); // 60초 간격 (크레딧 절약)

// ── Express ─────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stations', (req, res) => {
    res.json(cachedStations);
});

app.get('/api/aircraft', (req, res) => {
    res.json(cachedAircraft);
});

app.get('/api/status', (req, res) => {
    const now = Date.now();
    // Index latest v2 snapshot by station_id for quick merge
    const v2Index = new Map();
    for (const s of cachedStationsV2) {
        if (s.station_id) v2Index.set(s.station_id, s);
    }
    const stations = [];
    for (const [station_id, info] of stationLastSeen) {
        const ageMs = now - info.lastSeenAt;
        const v2 = v2Index.get(station_id) || {};
        stations.push({
            station_id,
            name: info.name,
            lat: info.lat,
            lon: info.lon,
            tier: info.tier,
            users: info.users,
            online: ageMs < OFFLINE_THRESHOLD_MS,
            lastSeenAt: info.lastSeenAt,
            ageMs,
            // v2 extension (may be undefined for hosts that don't emit HOST_STATE)
            operator_login:  v2.operator_login || '',
            center_freq_hz:  v2.center_freq_hz || 0,
            sample_rate_hz:  v2.sample_rate_hz || 0,
            hist_recording:  !!v2.hist_recording,
            channel_count:   v2.channel_count || 0,
        });
    }
    stations.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({
        central: {
            host: RELAY_HOST,
            port: RELAY_PORT,
            reachable: centralStatus.reachable,
            lastSuccessAt: centralStatus.lastSuccessAt,
            lastAttemptAt: centralStatus.lastAttemptAt,
            ageMs: centralStatus.lastSuccessAt ? now - centralStatus.lastSuccessAt : null,
            responseMs: centralStatus.responseMs,
            lastError: centralStatus.lastError,
        },
        stations,
        serverTime: now,
        offlineThresholdMs: OFFLINE_THRESHOLD_MS,
    });
});

// On-demand: detailed channel state for one station (status page click).
app.get('/api/station/:id/detail', async (req, res) => {
    const id = String(req.params.id || '').slice(0, 31);
    if (!id) return res.status(400).json({ error: 'missing station id' });
    const detail = await fetchStationDetail(id);
    if (!detail) return res.status(404).json({ error: 'station unavailable' });
    res.json(detail);
});

app.listen(PORT, () => {
    console.log(`BEWE Web running on http://localhost:${PORT}`);
});
