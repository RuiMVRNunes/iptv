// Simple IPTV Proxy Server - No Auth, Just Proxy
import http from 'http';
import https from 'https';
import express from 'express';
import { pipeline } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

// Xtream upstream (used by the ffmpeg /stream endpoint)
const XTREAM = process.env.XTREAM_URL || 'http://zxc.rekpv.com:8080';
const XUSER = process.env.XTREAM_USER || 'uvxctmoh';
const XPASS = process.env.XTREAM_PASS || 'pLv486e0Qh';

// CORS
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Health check
app.get('/health', (_, res) => res.send('ok'));

// Simple proxy endpoint
app.get('/proxy', (req, res) => {
    const targetUrl = String(req.query.url || '');
    if (!targetUrl) return res.status(400).send('missing url parameter');

    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return res.status(400).send('invalid url');
    }

    console.log(`[PROXY] ${target.pathname}`);

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'close',
    };

    if (req.query.referer) headers['Referer'] = String(req.query.referer);
    if (req.headers['range']) headers['Range'] = req.headers['range'];

    const options = {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        headers,
        timeout: 30000, // Increased for Full HD streams
    };

    const proxyReq = lib.request(options, (upstream) => {
        const status = upstream.statusCode || 200;

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(status)) {
            const loc = upstream.headers.location;
            upstream.resume();
            if (!loc) return res.status(502).send('redirect without location');
            const redirectUrl = new URL(loc, target).toString();
            return res.redirect(302, `/proxy?url=${encodeURIComponent(redirectUrl)}${req.query.referer ? '&referer=' + encodeURIComponent(req.query.referer) : ''}`);
        }

        // Check if M3U8
        const ct = String(upstream.headers['content-type'] || '').toLowerCase();
        const isM3U8 = target.pathname.toLowerCase().endsWith('.m3u8') ||
            ct.includes('mpegurl') ||
            ct.includes('m3u8');

        if (isM3U8) {
            // Rewrite M3U8 content
            console.log(`[M3U8] Rewriting ${target.pathname}`);
            const chunks = [];
            upstream.on('data', d => chunks.push(d));
            upstream.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    console.log(`[M3U8] Received ${text.length} bytes`);

                    // Detect if master or media playlist
                    const isMaster = text.includes('#EXT-X-STREAM-INF');
                    const isMedia = text.includes('#EXTINF');
                    console.log(`[M3U8] Type: ${isMaster ? 'MASTER' : isMedia ? 'MEDIA' : 'UNKNOWN'}`);

                    if (isMaster) {
                        // Count variants
                        const variants = (text.match(/#EXT-X-STREAM-INF/g) || []).length;
                        console.log(`[M3U8] Master playlist with ${variants} variants`);
                    }

                    const lines = text.split(/\r?\n/);
                    const rewritten = lines.map(line => {
                        const trimmed = line.trim();
                        // Skip empty lines and comments
                        if (!trimmed || trimmed.startsWith('#')) return line;
                        // Rewrite relative URLs through proxy
                        try {
                            const absoluteUrl = new URL(trimmed, target).toString();
                            const proxyParams = new URLSearchParams();
                            proxyParams.set('url', absoluteUrl);
                            if (req.query.referer) proxyParams.set('referer', String(req.query.referer));
                            return `/proxy?${proxyParams.toString()}`;
                        } catch {
                            return line;
                        }
                    }).join('\n');

                    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.status(status).send(rewritten);
                } catch (err) {
                    console.error('M3U8 rewrite error:', err);
                    res.status(502).send('m3u8 rewrite failed');
                }
            });
            upstream.on('error', (err) => {
                console.error('Upstream error:', err);
                if (!res.headersSent) res.status(502).send('upstream error');
            });
        } else {
            // Direct pipe for video segments
            const outHeaders = { ...upstream.headers };
            delete outHeaders['content-encoding'];
            res.writeHead(status, outHeaders);
            pipeline(upstream, res, (err) => {
                if (err) console.error('Pipe error:', err);
            });
        }
    });

    proxyReq.on('error', (err) => {
        console.error('Proxy request error:', err);
        if (!res.headersSent) res.status(502).send('proxy error: ' + err.message);
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).send('timeout');
    });

    req.on('aborted', () => proxyReq.destroy());
    proxyReq.end();
});

// ---------------------------------------------------------------------------
// ffmpeg streaming endpoint
//
// The "Full HD" feeds are H.264 1080p but with non-conformant reference-frame
// marking (5 ref frames over the level's DPB limit), which strict browser
// decoders (desktop Chrome / Tesla) reject mid-stream. We run ffmpeg
// server-side and deliver a browser-friendly HLS (fMP4/CMAF) stream:
//   - remux     : `-c copy`  -> just rewraps TS into fMP4, ~0 CPU. Plays only
//                 if the client's decoder tolerates the source bitstream.
//   - transcode : `-c:v libx264` -> clean re-encode, plays on ANY browser, but
//                 needs real CPU (not viable on a 0.1-CPU free instance).
//
// The account allows max_connections=1, so we keep at most one ffmpeg session
// alive at a time (a new channel kills the previous one), and reap idle ones.
// ---------------------------------------------------------------------------
const FF_ROOT = path.join(os.tmpdir(), 'iptv-ff');
fs.mkdirSync(FF_ROOT, { recursive: true });
const FF_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
const SESSION_IDLE_MS = 30000;
const sessions = new Map(); // id -> { dir, proc, mode, lastAccess, err, exited }

function ffmpegArgs(mode, input, dir) {
    // remux: stream-copy (≈0 CPU) — rewrap TS into fMP4, no re-encode. Plays in
    // full quality on clients whose decoder accepts the source bitstream.
    // transcode: re-encode to clean H.264 Main 8-bit — plays anywhere, but needs
    // real CPU. Many of these "Full HD" feeds are H.264 with non-conformant
    // reference-frame marking that strict browser decoders reject, so transcode
    // is the reliable path for them.
    const codec = mode === 'transcode'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
           '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-g', '50', '-sc_threshold', '0',
           '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
        : ['-c', 'copy'];
    return [
        '-hide_banner', '-loglevel', 'warning',
        '-user_agent', 'Mozilla/5.0',
        '-headers', `Referer: ${XTREAM}\r\n`,
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2',
        '-fflags', '+genpts',
        '-i', input,
        ...codec,
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '6',
        '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
        '-hls_segment_type', 'fmp4',
        // Relative names: ffmpeg runs with cwd=dir, so init/segments/playlist all
        // land in the session dir and the playlist references plain basenames.
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', 'seg%d.m4s',
        'index.m3u8',
    ];
}

function stopSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.proc.kill('SIGKILL'); } catch { /* already dead */ }
    fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function getSession(id, mode) {
    let s = sessions.get(id);
    if (s && s.mode === mode) { s.lastAccess = Date.now(); return s; }
    if (s) stopSession(id);                    // same channel, different mode -> restart
    for (const other of sessions.keys()) stopSession(other); // enforce single upstream

    const dir = fs.mkdtempSync(path.join(FF_ROOT, `${id}-`));
    const input = `${XTREAM}/live/${XUSER}/${XPASS}/${id}.m3u8`;
    const proc = spawn(FF_BIN, ffmpegArgs(mode, input, dir), { cwd: dir });
    s = { id, dir, proc, mode, lastAccess: Date.now(), err: '', exited: null };
    proc.stderr.on('data', d => { s.err = (s.err + d.toString()).slice(-2000); });
    proc.on('exit', code => { s.exited = code; });
    proc.on('error', err => { s.exited = -1; s.err += `spawn error: ${err.message}`; });
    sessions.set(id, s);
    console.log(`[STREAM] start ${id} mode=${mode}`);
    return s;
}

function waitForPlaylist(s, timeoutMs = 20000) {
    const playlist = path.join(s.dir, 'index.m3u8');
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (s.exited !== null) return reject(new Error(`ffmpeg exited (${s.exited}): ${s.err.slice(-400)}`));
            try {
                if (fs.existsSync(playlist) && fs.readFileSync(playlist, 'utf8').includes('.m4s')) return resolve();
            } catch { /* not ready */ }
            if (Date.now() - start > timeoutMs) return reject(new Error(`playlist timeout: ${s.err.slice(-400)}`));
            setTimeout(tick, 250);
        };
        tick();
    });
}

app.get('/stream/:id/index.m3u8', async (req, res) => {
    const id = String(req.params.id).replace(/[^0-9]/g, '');
    const mode = req.query.mode === 'transcode' ? 'transcode' : 'remux';
    if (!id) return res.status(400).send('bad id');
    try {
        const s = getSession(id, mode);
        await waitForPlaylist(s);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(s.dir, 'index.m3u8'));
    } catch (e) {
        console.error(`[STREAM] ${id} ${mode} error: ${e.message}`);
        res.status(502).send('stream error: ' + e.message);
    }
});

app.get('/stream/:id/:file', (req, res) => {
    const id = String(req.params.id).replace(/[^0-9]/g, '');
    const file = path.basename(String(req.params.file)); // init.mp4 / seg*.m4s
    const s = sessions.get(id);
    if (!s) return res.status(404).send('no active session');
    s.lastAccess = Date.now();
    const fp = path.join(s.dir, file);
    if (!fp.startsWith(s.dir)) return res.status(400).send('bad path');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(fp, err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Reap idle ffmpeg sessions to free CPU and the single upstream connection.
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.lastAccess > SESSION_IDLE_MS) {
            console.log(`[STREAM] reap ${id} (idle)`);
            stopSession(id);
        }
    }
}, 10000).unref();

process.on('SIGTERM', () => { for (const id of sessions.keys()) stopSession(id); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`IPTV Proxy running on http://0.0.0.0:${PORT}`));
