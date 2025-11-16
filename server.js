// Simple IPTV Proxy Server - No Auth, Just Proxy
import http from 'http';
import https from 'https';
import express from 'express';
import { pipeline } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

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
        timeout: 20000,
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
            const chunks = [];
            upstream.on('data', d => chunks.push(d));
            upstream.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`IPTV Proxy running on http://0.0.0.0:${PORT}`));
