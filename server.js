require('dotenv').config();
const express = require('express');
const net = require('net');
const path = require('path');
const https = require('https');
const http = require('http');
const db = require('./db');
const auth = require('./auth');

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
const JOIN_SUMMARY_SIZE = 36;   // central_proto.hpp::CentralJoinSummary
const HIST_INFO_SIZE    = 96;   // central_proto.hpp::CentralHostHistInfo
const SCHED_ENTRY_SIZE  = 88;   // net_protocol.hpp::SchedSyncEntry

// Display name overrides — keyed by station_id
const STATION_NAME_OVERRIDE = {
    'DGS-4_DGS-4': 'DGS-4 (Suwon)',
};

let cachedStations = [];
let cachedStationsV2 = [];   // status-page v2 — extended LIST including operator/freq/sr

const POLL_INTERVAL_MS = 2000;
const OFFLINE_THRESHOLD_MS = 15000;
// After this much offline time, drop the station from the table entirely.
// Central drops dead host rooms within seconds, so anything older than this is
// truly gone — keeping a red dot forever just confused operators.
const REMOVE_AFTER_MS = 60000;

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

        // Central's list_poller_loop keeps the TCP fd open after sending the
        // LIST_RESP — we must parse on incoming data and close the socket
        // ourselves once the full packet is in. Relying on 'end' would hang
        // until the 3 s timeout.
        const tryParse = () => {
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (buf.length < HDR_SIZE) return;
            if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) {
                return fail('bad magic');
            }
            if (buf[4] !== PKT_LIST_RESP) return fail('unexpected packet type');
            const payloadLen = buf.readUInt32LE(5);
            if (buf.length < HDR_SIZE + payloadLen) return; // wait for more
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
                const sid = idBuf.toString('utf8').replace(/\0/g, '');
                stations.push({
                    station_id: sid,
                    name: STATION_NAME_OVERRIDE[sid] || nameBuf.toString('utf8').replace(/\0/g, ''),
                    lat, lon, tier, users
                });
            }
            settled = true;
            centralStatus.reachable = true;
            centralStatus.lastSuccessAt = Date.now();
            centralStatus.lastError = null;
            centralStatus.responseMs = centralStatus.lastSuccessAt - startedAt;
            sock.destroy();
            resolve(stations);
        };
        sock.on('data', (data) => { chunks.push(data); try { tryParse(); } catch (e) { fail('parse: ' + e.message); } });
        sock.on('end', () => { try { tryParse(); } catch (e) { fail('parse: ' + e.message); } });
        sock.on('error', (e) => fail(e.code || e.message || 'socket error'));
        sock.on('timeout', () => { sock.destroy(); fail('timeout'); });
    });
}

async function pollLoop() {
    while (true) {
        try {
            cachedStations = await fetchStations();
            const now = Date.now();
            const liveIds = new Set();
            for (const s of cachedStations) {
                if (!s.station_id) continue;
                liveIds.add(s.station_id);
                stationLastSeen.set(s.station_id, {
                    lastSeenAt: now,
                    name: s.name,
                    lat: s.lat,
                    lon: s.lon,
                    tier: s.tier,
                    users: s.users,
                });
            }
            // Drop entries no longer in the live list once they exceed the
            // remove threshold — otherwise dead servers stay as red dots forever.
            // Only cleanup when central is reachable: a central outage returns
            // an empty list, and we don't want to flush every station then.
            if (centralStatus.reachable) {
                for (const [id, info] of stationLastSeen) {
                    if (!liveIds.has(id) && (now - info.lastSeenAt) > REMOVE_AFTER_MS) {
                        stationLastSeen.delete(id);
                    }
                }
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
        const tryParse = () => {
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (buf.length < HDR_SIZE) return;
            if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return fail();
            if (buf[4] !== PKT_LIST_RESP_V2) return fail();
            const payloadLen = buf.readUInt32LE(5);
            if (buf.length < HDR_SIZE + payloadLen) return; // wait for more
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
                const lon = -payload.readFloatLE(off + 100);
                const tier  = payload[off + 104];
                const users = payload[off + 105];
                const opBuf = payload.subarray(off + 108, off + 140);
                const center_freq_hz = Number(payload.readBigUInt64LE(off + 140));
                const sample_rate_hz = payload.readUInt32LE(off + 148);
                const hist_recording = payload[off + 152];
                const channel_count  = payload[off + 153];
                const bat_pct        = payload[off + 154];
                const sid2 = idBuf.toString('utf8').replace(/\0/g, '');
                stations.push({
                    station_id:    sid2,
                    name:          STATION_NAME_OVERRIDE[sid2] || nameBuf.toString('utf8').replace(/\0/g, ''),
                    lat, lon, tier, users,
                    operator_login: opBuf.toString('utf8').replace(/\0/g, ''),
                    center_freq_hz, sample_rate_hz,
                    hist_recording: !!hist_recording,
                    channel_count,
                    bat_pct,
                });
            }
            settled = true;
            sock.destroy();
            resolve(stations);
        };
        sock.on('data', (d) => { chunks.push(d); try { tryParse(); } catch (e) { console.error('LIST_V2 parse:', e.message); fail(); } });
        sock.on('end', () => { try { tryParse(); } catch (e) { console.error('LIST_V2 parse:', e.message); fail(); } });
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
        const tryParse = () => {
            if (settled) return;
            const buf = Buffer.concat(chunks);
            if (buf.length < HDR_SIZE) return;
            if (buf[0]!==0x42||buf[1]!==0x52||buf[2]!==0x4C||buf[3]!==0x59) return done(null);
            if (buf[4] !== PKT_STATION_DETAIL_RESP) return done(null);
            const payloadLen = buf.readUInt32LE(5);
            if (buf.length < HDR_SIZE + payloadLen) return; // wait for more
            if (payloadLen === 0) { sock.destroy(); return done(null); }
            const p = buf.subarray(HDR_SIZE, HDR_SIZE + payloadLen);
            if (p.length < HSTATE_SIZE) { sock.destroy(); return done(null); }

            const opBuf = p.subarray(0, 32);
            const out = {
                operator_login: opBuf.toString('utf8').replace(/\0/g, ''),
                center_freq_hz: Number(p.readBigUInt64LE(32)),
                sample_rate_hz: p.readUInt32LE(40),
                hist_recording: !!p[44],
                channel_count:  p[45],
                bat_pct:        p[46],
                channels: [],
            };
            const chBase = 48; // 32 + 8 + 4 + 1 + 1 + 2
            for (let i = 0; i < 10; i++) {
                const o = chBase + i * HSTATE_CH_SIZE;
                if (!p[o]) continue; // active=0 → skip
                out.channels.push({
                    index:        i,
                    mode:         p[o + 1],   // 0=NONE,1=AM,2=FM
                    iq_rec_on:    !!p[o + 2],
                    audio_rec_on: !!p[o + 3],
                    dem_run:      !!p[o + 4],
                    s_mhz: p.readFloatLE(o + 8),
                    e_mhz: p.readFloatLE(o + 12),
                    owner: p.subarray(o + 16, o + 48).toString('utf8').replace(/\0/g, ''),
                });
            }
            // Optional trailer sections:
            //   njoins[1] + CentralJoinSummary[njoins]
            //   has_hist[1] + CentralHostHistInfo (if has_hist)
            //   nsched[1] + SchedSyncEntry[nsched]
            out.joins = [];
            out.hist  = null;
            out.scheds = [];
            let off = HSTATE_SIZE;
            // joins
            if (p.length > off) {
                const nj = p[off++];
                for (let i = 0; i < nj && off + JOIN_SUMMARY_SIZE <= p.length; i++) {
                    out.joins.push({
                        name:    p.subarray(off, off + 32).toString('utf8').replace(/\0/g, ''),
                        tier:    p[off + 32],
                        authed:  !!p[off + 33],
                        conn_id: p.readUInt16LE(off + 34),
                    });
                    off += JOIN_SUMMARY_SIZE;
                }
            }
            // hist
            if (p.length > off) {
                const has_hist = p[off++];
                if (has_hist && off + HIST_INFO_SIZE <= p.length) {
                    out.hist = {
                        filename:       p.subarray(off, off + 64).toString('utf8').replace(/\0/g, ''),
                        start_utc_unix: Number(p.readBigUInt64LE(off + 64)),
                        center_freq_hz: Number(p.readBigUInt64LE(off + 72)),
                        sample_rate_hz: p.readUInt32LE(off + 80),
                        fft_size:       p.readUInt32LE(off + 84),
                        row_rate_hz:    p.readFloatLE(off + 88),
                    };
                    off += HIST_INFO_SIZE;
                }
            }
            // scheds
            if (p.length > off) {
                const ns = p[off++];
                for (let i = 0; i < ns && off + SCHED_ENTRY_SIZE <= p.length; i++) {
                    out.scheds.push({
                        valid:         p[off],
                        status:        p[off + 1],
                        op_index:      p[off + 2],
                        start_time:    Number(p.readBigInt64LE(off + 4)),
                        duration_sec:  p.readFloatLE(off + 12),
                        freq_mhz:      p.readFloatLE(off + 16),
                        bw_khz:        p.readFloatLE(off + 20),
                        operator_name: p.subarray(off + 24, off + 56).toString('utf8').replace(/\0/g, ''),
                        target:        p.subarray(off + 56, off + 88).toString('utf8').replace(/\0/g, ''),
                    });
                    off += SCHED_ENTRY_SIZE;
                }
            }
            sock.destroy();
            done(out);
        };
        sock.on('data', (d) => { chunks.push(d); try { tryParse(); } catch (e) { console.error('DETAIL parse:', e.message); done(null); } });
        sock.on('end', () => { try { tryParse(); } catch (e) { console.error('DETAIL parse:', e.message); done(null); } });
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

// ── TLE (CelesTrak) ─────────────────────────────────────────────────────────
const TLE_GROUPS_ALLOWED = new Set(['visual', 'starlink', 'stations', 'gnss', 'geo', 'active']);
const tleCache = {};  // group → { sats: [...], expiresAt: ms }

function parseTleText(text) {
    const lines = text.split('\n').map(l => l.trimEnd());
    const sats = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].trim();
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (!l1 || l1[0] !== '1' || !l2 || l2[0] !== '2') continue;
        if (l1.length < 64 || l2.length < 64) continue;

        const yy  = parseInt(l1.substring(18, 20), 10);
        const doy = parseFloat(l1.substring(20, 32));
        const fullYear = yy < 57 ? 2000 + yy : 1900 + yy;
        const epoch_utc = Date.UTC(fullYear, 0, 1) + (doy - 1) * 86400000;

        const n = parseFloat(l2.substring(52, 63));
        if (!(n > 0)) continue;

        sats.push({
            name,
            incl: parseFloat(l2.substring(8,  16)),
            raan: parseFloat(l2.substring(17, 25)),
            argp: parseFloat(l2.substring(34, 42)),
            m0:   parseFloat(l2.substring(43, 51)),
            n,           // rev/day
            epoch_utc,   // ms since Unix epoch
        });
    }
    return sats;
}

async function fetchTle(group) {
    const cached = tleCache[group];
    if (cached && Date.now() < cached.expiresAt) return cached.sats;

    const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`CelesTrak ${resp.status}`);
    const text = await resp.text();
    const sats = parseTleText(text);
    tleCache[group] = { sats, expiresAt: Date.now() + 3600000 };
    console.log(`TLE: cached ${sats.length} sats for group=${group}`);
    return sats;
}

// ── Radiosonde (auto_rx on DGS-2) ───────────────────────────────────────────
// auto_rx runs on DGS-2's RTL-SDR and exposes a JSON API on :5000. We poll it
// over Tailscale and re-serve a compact status for the dashboard.
const SONDE_URL      = (process.env.SONDE_URL || 'http://100.126.69.82:5000').replace(/\/+$/, '');
const SONDE_POLL_MS  = 6000;
const SONDE_STALE_MS = 120000;   // drop sondes not updated within this window (landed/lost)

let cachedSonde = {
    reachable: false, version: null, sdr_type: null,
    scan_min_mhz: null, scan_max_mhz: null,
    scanning: false, decoding: false, sondes: [], lastUpdate: null,
};

function sondeFetch(pathname) {
    return fetch(SONDE_URL + pathname, { signal: AbortSignal.timeout(5000) })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}

async function fetchSonde() {
    const [task, telem, config, version] = await Promise.allSettled([
        sondeFetch('/get_task_list'),
        sondeFetch('/get_telemetry_archive'),
        sondeFetch('/get_config'),
        sondeFetch('/get_version'),
    ]);

    // task_list reachability is our liveness signal.
    if (task.status !== 'fulfilled') {
        cachedSonde = { ...cachedSonde, reachable: false };
        return;
    }

    const taskList = task.value || {};
    let scanning = false;
    for (const k of Object.keys(taskList)) {
        const t = String((taskList[k] && taskList[k].task) || '');
        if (/scan/i.test(t)) scanning = true;
    }

    const now = Date.now();
    const sondes = [];
    if (telem.status === 'fulfilled' && telem.value) {
        for (const serial of Object.keys(telem.value)) {
            const entry = telem.value[serial];
            const lt = entry && entry.latest_telem;
            if (!lt) continue;
            const ageMs = now - (entry.timestamp ? entry.timestamp * 1000 : now);
            if (ageMs > SONDE_STALE_MS) continue;
            const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
            sondes.push({
                serial,
                type:    lt.type || '',
                subtype: lt.subtype || '',
                freq:    lt.freq || '',
                alt:   num(lt.alt),
                vel_v: num(lt.vel_v),
                vel_h: num(lt.vel_h),
                lat:   num(lt.lat),
                lon:   num(lt.lon),
                sats:  num(lt.sats),
                temp:  num(lt.temp),
                frame: lt.frame ?? null,
                ageMs,
            });
        }
        sondes.sort((a, b) => a.ageMs - b.ageMs);
    }

    const cfg = config.status === 'fulfilled' ? config.value : null;
    cachedSonde = {
        reachable: true,
        version:      version.status === 'fulfilled' ? (version.value?.current || null) : cachedSonde.version,
        sdr_type:     cfg?.sdr_type ?? cachedSonde.sdr_type,
        scan_min_mhz: cfg?.min_freq ?? cachedSonde.scan_min_mhz,
        scan_max_mhz: cfg?.max_freq ?? cachedSonde.scan_max_mhz,
        scanning,
        decoding: sondes.length > 0,
        sondes,
        lastUpdate: now,
    };
}

async function sondePollLoop() {
    while (true) {
        try { await fetchSonde(); }
        catch (e) { cachedSonde = { ...cachedSonde, reachable: false }; }
        await new Promise(r => setTimeout(r, SONDE_POLL_MS));
    }
}
sondePollLoop();

// ── Flightradar24 feeder (fr24feed on DGS-2) ────────────────────────────────
// fr24feed exposes monitor.json on :8754. Requires bind-interface="0.0.0.0"
// in /etc/fr24feed.ini so it accepts requests from the Tailscale interface.
const FR24_URL     = (process.env.FR24_URL || 'http://100.126.69.82:8754').replace(/\/+$/, '');
const FR24_POLL_MS = 6000;

let cachedFr24 = {
    reachable: false, feed_status: null, alias: null, mode: null,
    ac_tracked: null, ac_adsb: null, rx_connected: false,
    messages: null, version: null, last_ac_sent: null, lastUpdate: null,
};

async function fetchFr24() {
    const r = await fetch(FR24_URL + '/monitor.json', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // fr24feed serves Content-Type text/plain; non-private sources get a plain
    // warning instead of JSON — JSON.parse failure means blocked → unreachable.
    const m = JSON.parse(await r.text());
    const int = (v) => { const n = parseInt(v, 10); return isFinite(n) ? n : null; };
    cachedFr24 = {
        reachable:    true,
        feed_status:  m.feed_status || null,            // "connected" when feeding
        alias:        m.feed_alias || null,             // e.g. "T-RKPE5"
        mode:         m.feed_current_mode || m.feed_configured_mode || null,
        ac_tracked:   int(m.feed_num_ac_tracked),
        ac_adsb:      int(m.feed_num_ac_adsb_tracked),
        rx_connected: m.rx_connected === '1',
        messages:     int(m.num_messages),
        version:      m.build_version || null,
        last_ac_sent: int(m.feed_last_ac_sent_time),    // unix seconds
        lastUpdate:   Date.now(),
    };
}

async function fr24PollLoop() {
    while (true) {
        try { await fetchFr24(); }
        catch (e) { cachedFr24 = { ...cachedFr24, reachable: false }; }
        await new Promise(r => setTimeout(r, FR24_POLL_MS));
    }
}
fr24PollLoop();

// ── Station notes (persisted across restarts) ──────────────────────────────
const fs = require('fs');
const NOTES_FILE = path.join(__dirname, 'data', 'station_notes.json');
let stationNotes = {};   // { station_id: { text, updatedAt } }
try {
    fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
    if (fs.existsSync(NOTES_FILE)) {
        stationNotes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    }
} catch (e) { console.error('notes load:', e.message); }

let notesSaveTimer = null;
function saveNotes() {
    if (notesSaveTimer) clearTimeout(notesSaveTimer);
    notesSaveTimer = setTimeout(() => {
        try { fs.writeFileSync(NOTES_FILE, JSON.stringify(stationNotes, null, 2)); }
        catch (e) { console.error('notes save:', e.message); }
    }, 250);
}

// ── Express ─────────────────────────────────────────────────────────────────
// www.bewe.co.kr → bewe.co.kr (canonical host, 301)
app.use((req, res, next) => {
    if (req.hostname === 'www.bewe.co.kr') {
        return res.redirect(301, 'https://bewe.co.kr' + req.originalUrl);
    }
    next();
});
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});
app.use('/api/mail/send', express.json({ limit: '1mb' }));      // mail bodies need headroom
app.use('/api/mail/inbound', express.json({ limit: '2mb' }));   // inbound (parsed MIME from Email Worker)
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth & mailbox (each user owns username@MAIL_DOMAIN) ────────────────────
const MAIL_DOMAIN = process.env.MAIL_DOMAIN || 'bewe.co.kr';

// Bootstrap an admin from .env (ADMIN_USER/ADMIN_PASS) so approvals are possible
// on a fresh DB. Existing user with that name is promoted; password untouched.
function bootstrapAdmin() {
    const user = process.env.ADMIN_USER;
    const pass = process.env.ADMIN_PASS;
    if (!user || !pass) return;
    const uname = String(user).trim().toLowerCase();
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (existing) {
        if (existing.status !== 'admin') {
            db.prepare("UPDATE users SET status='admin' WHERE id=?").run(existing.id);
            console.log(`auth: promoted '${uname}' to admin`);
        }
    } else {
        db.prepare('INSERT INTO users (username, pass_hash, status, created_at) VALUES (?,?,?,?)')
          .run(uname, auth.hashPassword(pass), 'admin', Date.now());
        console.log(`auth: bootstrapped admin '${uname}'`);
    }
}
bootstrapAdmin();

// Per-username login throttle: 5 fails → 60 s lock (brute-force dampener).
const loginFails = new Map();
function throttled(uname) { const e = loginFails.get(uname); return !!e && e.until > Date.now(); }
function recordFail(uname) {
    const e = loginFails.get(uname) || { n: 0, until: 0 };
    e.n += 1;
    if (e.n >= 5) { e.until = Date.now() + 60000; e.n = 0; }
    loginFails.set(uname, e);
}

app.post('/api/auth/signup', (req, res) => {
    const uname = auth.normalizeUsername(req.body && req.body.username);
    const pass = String((req.body && req.body.password) || '');
    if (!uname) return res.status(400).json({ error: 'invalid username (3–32 chars: a–z 0–9 . _ -, not reserved)' });
    if (pass.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) {
        return res.status(409).json({ error: 'username already taken' });
    }
    db.prepare('INSERT INTO users (username, pass_hash, status, created_at) VALUES (?,?,?,?)')
      .run(uname, auth.hashPassword(pass), 'pending', Date.now());
    res.json({ ok: true, status: 'pending', email: `${uname}@${MAIL_DOMAIN}` });
});

app.post('/api/auth/login', (req, res) => {
    const uname = String((req.body && req.body.username) || '').trim().toLowerCase();
    const pass = String((req.body && req.body.password) || '');
    if (!uname || !pass) return res.status(400).json({ error: 'missing credentials' });
    if (throttled(uname)) return res.status(429).json({ error: 'too many attempts, try again in a minute' });
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (!u || !auth.verifyPassword(pass, u.pass_hash)) {
        recordFail(uname);
        return res.status(401).json({ error: 'invalid username or password' });
    }
    if (u.status === 'pending') return res.status(403).json({ error: 'account pending admin approval' });
    loginFails.delete(uname);
    auth.setSessionCookie(req, res, u.username);
    res.json({ ok: true, user: { username: u.username, status: u.status, email: `${u.username}@${MAIL_DOMAIN}` } });
});

app.post('/api/auth/logout', (req, res) => {
    auth.clearSessionCookie(req, res);
    res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
    const u = auth.currentUser(req);
    if (!u) return res.json({ user: null });
    res.json({ user: { username: u.username, status: u.status, email: `${u.username}@${MAIL_DOMAIN}`, backup_email: u.backup_email || null } });
});

app.get('/api/admin/pending', auth.requireAdmin, (req, res) => {
    const rows = db.prepare("SELECT username, created_at FROM users WHERE status='pending' ORDER BY created_at").all();
    res.json(rows.map(r => ({ username: r.username, email: `${r.username}@${MAIL_DOMAIN}`, created_at: r.created_at })));
});

app.post('/api/admin/approve', auth.requireAdmin, (req, res) => {
    const uname = String((req.body && req.body.username) || '').trim().toLowerCase();
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(uname);
    if (!u) return res.status(404).json({ error: 'no such user' });
    db.prepare("UPDATE users SET status='active' WHERE id=?").run(u.id);
    res.json({ ok: true, username: uname, status: 'active' });
});

app.post('/api/admin/reject', auth.requireAdmin, (req, res) => {
    const uname = String((req.body && req.body.username) || '').trim().toLowerCase();
    const u = db.prepare("SELECT * FROM users WHERE username = ? AND status='pending'").get(uname);
    if (!u) return res.status(404).json({ error: 'no such pending user' });
    db.prepare('DELETE FROM users WHERE id=?').run(u.id);
    res.json({ ok: true, username: uname, status: 'rejected' });
});

// ── mailbox ──
function userEmail(u) { return `${u.username}@${MAIL_DOMAIN}`; }

// Extract the bare address from a possibly-decorated header ("Name <a@b>").
function bareAddr(s) {
    const m = String(s || '').match(/<([^>]+)>/);
    return (m ? m[1] : String(s || '')).trim().toLowerCase();
}

// Inbound webhook — called by the Cloudflare Email Worker for each message that
// arrives at *@MAIL_DOMAIN. Authenticated by a shared secret header. Stores the
// message in the recipient's mailbox, or reports no_mailbox so the Worker can
// reject (bounce) unknown recipients.
app.post('/api/mail/inbound', (req, res) => {
    const secret = process.env.INBOUND_SECRET;
    if (!secret || req.get('X-Inbound-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });

    const b = req.body || {};
    const to = bareAddr(b.to);
    const from = String(b.from || '').trim().slice(0, 320);
    const subject = String(b.subject || '').slice(0, 500);
    let text = String(b.text || '');
    const html = b.html ? String(b.html) : null;
    if (!text && html) text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const atDomain = '@' + MAIL_DOMAIN;
    if (!to.endsWith(atDomain)) return res.json({ delivered: false, reason: 'wrong_domain' });
    const localpart = to.slice(0, -atDomain.length);
    const u = db.prepare("SELECT * FROM users WHERE username=? AND status IN ('active','admin')").get(localpart);
    if (!u) return res.json({ delivered: false, reason: 'no_mailbox' });

    db.prepare('INSERT INTO emails (user_id, direction, from_addr, to_addr, subject, body_text, body_html, seen, created_at) VALUES (?,?,?,?,?,?,?,0,?)')
      .run(u.id, 'in', from, to, subject, text, html, Date.now());
    res.json({ delivered: true, backup_email: u.backup_email || null });
});

app.get('/api/mail/list', auth.requireAuth, (req, res) => {
    const box = req.query.box === 'sent' ? 'out' : 'in';
    const emails = db.prepare(
        'SELECT id, direction, from_addr, to_addr, subject, seen, created_at FROM emails WHERE user_id=? AND direction=? ORDER BY created_at DESC LIMIT 200'
    ).all(req.user.id, box);
    const unread = db.prepare("SELECT COUNT(*) n FROM emails WHERE user_id=? AND direction='in' AND seen=0").get(req.user.id).n;
    res.json({ box: box === 'out' ? 'sent' : 'inbox', unread, emails });
});

app.get('/api/mail/:id', auth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const m = db.prepare('SELECT * FROM emails WHERE id=? AND user_id=?').get(id, req.user.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    if (m.direction === 'in' && !m.seen) db.prepare('UPDATE emails SET seen=1 WHERE id=?').run(id);
    res.json(m);
});

app.delete('/api/mail/:id', auth.requireAuth, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const info = db.prepare('DELETE FROM emails WHERE id=? AND user_id=?').run(id, req.user.id);
    if (!info.changes) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
});

// External outbound via Resend (https://resend.com). The `from` domain must be
// verified in Resend (DKIM). Returns {sent} / {reason:'not_configured'} / error.
async function resendSend({ from, to, subject, text }) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { sent: false, reason: 'not_configured' };
    try {
        const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject: subject || '(no subject)', text: text || '' }),
            signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
            const detail = (await resp.text().catch(() => '')).slice(0, 300);
            return { sent: false, reason: 'resend_error', status: resp.status, detail };
        }
        const data = await resp.json().catch(() => ({}));
        return { sent: true, id: data.id || null };
    } catch (e) {
        return { sent: false, reason: 'resend_error', detail: e.message };
    }
}

function saveOut(user, from, to, subject, body, ts) {
    db.prepare('INSERT INTO emails (user_id, direction, from_addr, to_addr, subject, body_text, seen, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(user.id, 'out', from, to, subject, body, ts);
}

app.post('/api/mail/send', auth.requireAuth, async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim().toLowerCase();
    const subject = String((req.body && req.body.subject) || '').slice(0, 300);
    const body = String((req.body && req.body.body) || '');
    if (body.length > 512 * 1024) return res.status(413).json({ error: 'body too large' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'invalid recipient address' });

    const from = userEmail(req.user);
    const now = Date.now();
    const atDomain = '@' + MAIL_DOMAIN;

    // 1) local recipient → in-app delivery (no external hop)
    if (to.endsWith(atDomain)) {
        const localpart = to.slice(0, -atDomain.length);
        const rcpt = db.prepare("SELECT * FROM users WHERE username=? AND status IN ('active','admin')").get(localpart);
        if (rcpt) {
            saveOut(req.user, from, to, subject, body, now);
            db.prepare('INSERT INTO emails (user_id, direction, from_addr, to_addr, subject, body_text, seen, created_at) VALUES (?,?,?,?,?,?,0,?)')
              .run(rcpt.id, 'in', from, to, subject, body, now);
            return res.json({ ok: true, delivered_internally: true });
        }
    }

    // 2) external recipient → Resend
    const r = await resendSend({ from, to, subject, text: body });
    if (r.sent) {
        saveOut(req.user, from, to, subject, body, now);
        return res.json({ ok: true, delivered_internally: false, sent_external: true, id: r.id });
    }
    if (r.reason === 'not_configured') {
        saveOut(req.user, from, to, subject, body, now);
        return res.json({
            ok: true, delivered_internally: false, sent_external: false,
            note: '외부 발송(Resend)이 아직 설정되지 않았습니다. 보낸편지함에는 저장됨 — RESEND_API_KEY 설정 후 실제 전송됩니다.',
        });
    }
    return res.status(502).json({ ok: false, error: '외부 발송 실패', detail: r.detail || null, status: r.status || null });
});

// Backup forward address (P5). The Email Worker forwards a copy of inbound mail
// here via message.forward(), which requires the address to be verified in
// Cloudflare Email Routing (Destination addresses). Empty string clears it.
app.post('/api/mail/settings/backup', auth.requireAuth, (req, res) => {
    const raw = String((req.body && req.body.backup_email) || '').trim().toLowerCase();
    if (raw === '') {
        db.prepare('UPDATE users SET backup_email=NULL WHERE id=?').run(req.user.id);
        return res.json({ ok: true, backup_email: null });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return res.status(400).json({ error: 'invalid email' });
    db.prepare('UPDATE users SET backup_email=? WHERE id=?').run(raw, req.user.id);
    res.json({ ok: true, backup_email: raw });
});

app.get('/api/notes', (req, res) => { res.json(stationNotes); });

app.post('/api/notes/:id', (req, res) => {
    const id = String(req.params.id || '').slice(0, 64);
    if (!id) return res.status(400).json({ error: 'missing id' });
    const text = String((req.body && req.body.text) || '').slice(0, 500);
    if (text === '') {
        delete stationNotes[id];
    } else {
        stationNotes[id] = { text, updatedAt: Date.now() };
    }
    saveNotes();
    res.json({ ok: true, note: stationNotes[id] || null });
});

app.get('/api/tle', async (req, res) => {
    const group = req.query.group || 'visual';
    if (!TLE_GROUPS_ALLOWED.has(group)) return res.status(400).json({ error: 'invalid group' });
    try {
        const sats = await fetchTle(group);
        res.json(sats);
    } catch (e) {
        console.error('TLE fetch error:', e.message);
        res.status(502).json({ error: e.message });
    }
});

app.get('/api/stations', (req, res) => {
    const v2Index = new Map();
    for (const s of cachedStationsV2) {
        if (s.station_id) v2Index.set(s.station_id, s);
    }
    const result = cachedStations.map(s => {
        const v2 = v2Index.get(s.station_id) || {};
        return {
            ...s,
            operator_login:  v2.operator_login  || '',
            center_freq_hz:  v2.center_freq_hz  || 0,
            sample_rate_hz:  v2.sample_rate_hz  || 0,
            hist_recording:  !!v2.hist_recording,
            channel_count:   v2.channel_count   || 0,
            bat_pct:         v2.bat_pct,
        };
    });
    res.json(result);
});

app.get('/api/aircraft', (req, res) => {
    res.json(cachedAircraft);
});

app.get('/api/sonde', (req, res) => {
    res.json(cachedSonde);
});

app.get('/api/fr24', (req, res) => {
    res.json(cachedFr24);
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
            bat_pct:         v2.bat_pct,
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

// ── DGS-2 Battery API (polls bat_api.py on DGS-2:9731) ──────────────────────
const DGS2_BAT_URL    = process.env.DGS2_BAT_URL || 'http://100.126.69.82:9731/battery';
const BAT_POLL_MS     = 30 * 1000;
const BAT_LOG_MS      = 30 * 60 * 1000;  // log to file every 30 min
const BAT_RETAIN_MS   = 10 * 24 * 60 * 60 * 1000; // keep 10 days
const BAT_LOG_FILE    = path.join(__dirname, 'data', 'battery_DGS-2.json');
let   cachedBatDGS2   = null;
let   cachedBatDGS2At = 0;
const batHistory      = []; // { ts, bat_pct, status }
let   lastBatLogAt    = 0;

function fetchDGS2Battery() {
    return new Promise((resolve) => {
        const mod = DGS2_BAT_URL.startsWith('https') ? https : http;
        mod.get(DGS2_BAT_URL, { timeout: 4000 }, (r) => {
            let raw = '';
            r.on('data', d => raw += d);
            r.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { resolve(null); }
            });
        }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
    });
}

function saveBatLog(entry) {
    try {
        let log = [];
        if (fs.existsSync(BAT_LOG_FILE)) {
            try { log = JSON.parse(fs.readFileSync(BAT_LOG_FILE, 'utf8')); } catch { log = []; }
        }
        const cutoff = new Date(Date.now() - BAT_RETAIN_MS).toISOString();
        log = log.filter(e => e.t > cutoff);
        log.push(entry);
        fs.writeFileSync(BAT_LOG_FILE, JSON.stringify(log, null, 1));
    } catch (e) { console.error('bat log save:', e.message); }
}

async function batPollLoop() {
    while (true) {
        const now = Date.now();
        const b = await fetchDGS2Battery();
        if (b) {
            cachedBatDGS2   = b;
            cachedBatDGS2At = now;
            batHistory.push({ ts: now, bat_pct: b.bat_pct, status: b.status });
            const cutoff = now - BAT_RETAIN_MS;
            while (batHistory.length && batHistory[0].ts < cutoff) batHistory.shift();
        }
        if (now - lastBatLogAt >= BAT_LOG_MS) {
            lastBatLogAt = now;
            saveBatLog({
                t:       new Date(now).toISOString(),
                online:  !!b,
                bat_pct: b ? (b.bat_pct ?? null) : null,
                status:  b ? (b.status  ?? null) : null,
            });
        }
        await new Promise(r => setTimeout(r, BAT_POLL_MS));
    }
}
batPollLoop();

// station_id may be 'DGS-2' or 'DGS-2_DGS-2' depending on relay encoding
function isDGS2(id) { return id === 'DGS-2' || id === 'DGS-2_DGS-2'; }

app.get('/api/battery/:id', (req, res) => {
    if (!isDGS2(req.params.id)) return res.status(404).json({ error: 'no battery data for this station' });
    if (!cachedBatDGS2) return res.status(503).json({ error: 'battery data unavailable' });
    res.json({ bat_pct: cachedBatDGS2.bat_pct, status: cachedBatDGS2.status, fetched_at: cachedBatDGS2At });
});

app.get('/api/battery/:id/history', (req, res) => {
    if (!isDGS2(req.params.id)) return res.status(404).json({ error: 'no history for this station' });
    res.json(batHistory);
});

// ── Central UPS (X1200) — CSV logged by ups_logd.py on raspb2, 1 row/min ─────
const UPS_CSV        = process.env.UPS_CSV || '/home/raspb2/ups_history.csv';
const UPS_POLL_MS    = 15000;
const UPS_STALE_MS   = 5 * 60 * 1000;   // last sample older than this → logger considered down
const UPS_SERIES_MAX = 1440;            // 24h at 1 row/min

let cachedUps = { reachable: false, latest: null, series: [], lastUpdate: null };

function readUps() {
    let text;
    try { text = fs.readFileSync(UPS_CSV, 'utf8'); }
    catch (e) { cachedUps = { ...cachedUps, reachable: false }; return; }

    const lines = text.split('\n').filter(l => l && !l.startsWith('timestamp'));
    const rows = [];
    for (const line of lines.slice(-UPS_SERIES_MAX)) {
        const p = line.split(',');
        if (p.length < 5) continue;
        const t = Date.parse(p[0].replace(' ', 'T'));   // 'YYYY-MM-DD HH:MM:SS' (server-local KST)
        if (!isFinite(t)) continue;
        const ac = p[3] === '1' ? 1 : (p[3] === '0' ? 0 : null);
        rows.push({ t, volt: parseFloat(p[1]), soc: parseFloat(p[2]), ac, status: p[4] });
    }
    if (!rows.length) { cachedUps = { ...cachedUps, reachable: false }; return; }

    const last = rows[rows.length - 1];
    cachedUps = {
        reachable: (Date.now() - last.t) < UPS_STALE_MS,
        latest: last,
        series: rows,
        lastUpdate: Date.now(),
    };
}

function upsPollLoop() { readUps(); setInterval(readUps, UPS_POLL_MS); }
upsPollLoop();

app.get('/api/ups', (req, res) => { res.json(cachedUps); });

app.listen(PORT, () => {
    console.log(`BEWE Web running on http://localhost:${PORT}`);
});
