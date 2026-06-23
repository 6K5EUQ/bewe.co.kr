require('dotenv').config();
const express = require('express');
const net = require('net');
const path = require('path');
const https = require('https');
const http = require('http');

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
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
const DGS2_BAT_URL = process.env.DGS2_BAT_URL || 'http://100.126.69.82:9731/battery';
const BAT_POLL_MS  = 30000;
let   cachedBatDGS2 = null;
let   cachedBatDGS2At = 0;

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

async function batPollLoop() {
    while (true) {
        const b = await fetchDGS2Battery();
        if (b) { cachedBatDGS2 = b; cachedBatDGS2At = Date.now(); }
        await new Promise(r => setTimeout(r, BAT_POLL_MS));
    }
}
batPollLoop();

app.get('/api/battery/DGS-2', (req, res) => {
    if (!cachedBatDGS2) return res.status(503).json({ error: 'battery data unavailable' });
    res.json({ ...cachedBatDGS2, fetched_at: cachedBatDGS2At });
});

app.listen(PORT, () => {
    console.log(`BEWE Web running on http://localhost:${PORT}`);
});
