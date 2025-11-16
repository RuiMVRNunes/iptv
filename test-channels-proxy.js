// Channel Validator with Proxy - Tests all IPTV channels through local proxy
import http from 'http';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

// Xtream credentials
const XTREAM_URL = 'http://zxc.rekpv.com:8080';
const XTREAM_USER = 'uvxctmoh';
const XTREAM_PASS = 'pLv486e0Qh';

// Test configuration
const PROXY_PORT = 8080;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;
const TIMEOUT = 15000; // 15 seconds per channel
const CONCURRENT_TESTS = 3; // Test 3 channels at a time (reduced to avoid overload)
const MIN_PLAYLIST_SIZE = 50; // Minimum bytes for valid M3U8

// Results
const results = {
    total: 0,
    working: 0,
    failed: 0,
    filtered: 0,
    channels: []
};

let proxyServer = null;

// Fetch through proxy with timeout
function fetchWithTimeout(url, timeout = TIMEOUT) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            req.destroy();
            reject(new Error('TIMEOUT'));
        }, timeout);

        const proxyUrl = `${PROXY_URL}/proxy?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(new URL(XTREAM_URL).origin)}`;

        const req = http.get(proxyUrl, (res) => {
            clearTimeout(timeoutId);

            // Follow redirects from our own proxy
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                const location = res.headers.location;
                if (location && location.startsWith('/proxy')) {
                    // Internal proxy redirect
                    return fetchWithTimeout(url, timeout).then(resolve).catch(reject);
                }
            }

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const data = Buffer.concat(chunks);
                resolve({
                    data: data.toString('utf8'),
                    size: data.length,
                    statusCode: res.statusCode,
                    contentType: res.headers['content-type'] || ''
                });
            });
            res.on('error', reject);
        });

        req.on('error', (err) => {
            clearTimeout(timeoutId);
            reject(err);
        });
    });
}

// Test single channel
async function testChannel(channel) {
    const startTime = Date.now();
    const result = {
        name: channel.name,
        streamId: channel.stream_id,
        url: channel.url,
        status: 'unknown',
        error: null,
        responseTime: 0,
        playlistSize: 0,
        codec: null,
        variants: 0
    };

    try {
        console.log(`Testing: ${channel.name}`);
        const response = await fetchWithTimeout(channel.url, TIMEOUT);
        result.responseTime = Date.now() - startTime;
        result.playlistSize = response.size;

        // Validate M3U8 content
        if (response.size < MIN_PLAYLIST_SIZE) {
            throw new Error(`Playlist too small (${response.size} bytes)`);
        }

        const content = response.data;

        // Check if valid M3U8
        if (!content.includes('#EXTM3U') && !content.includes('#EXT')) {
            throw new Error('Invalid M3U8 format');
        }

        // Check if it's a master playlist with variants
        const isMaster = content.includes('#EXT-X-STREAM-INF');
        if (isMaster) {
            const variants = (content.match(/#EXT-X-STREAM-INF/g) || []).length;
            result.variants = variants;

            // Try to extract codec info
            const codecMatch = content.match(/CODECS="([^"]+)"/);
            if (codecMatch) {
                result.codec = codecMatch[1];
            }
        }

        // Check if it's a media playlist with segments
        const isMedia = content.includes('#EXTINF');
        if (isMedia) {
            const segments = (content.match(/#EXTINF/g) || []).length;
            if (segments === 0) {
                throw new Error('No segments found in media playlist');
            }
        }

        result.status = 'working';
        results.working++;
        console.log(`✓ ${channel.name} - ${result.responseTime}ms - ${result.variants} variants`);

    } catch (err) {
        result.status = 'failed';
        result.error = err.message;
        results.failed++;
        console.log(`✗ ${channel.name} - ${err.message}`);
    }

    return result;
}

// Test channels in batches
async function testChannelsBatch(channels, batchSize = CONCURRENT_TESTS) {
    const allResults = [];

    for (let i = 0; i < channels.length; i += batchSize) {
        const batch = channels.slice(i, i + batchSize);
        console.log(`\nTesting batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(channels.length / batchSize)}`);

        const batchResults = await Promise.all(
            batch.map(channel => testChannel(channel))
        );

        allResults.push(...batchResults);

        // Small delay between batches to avoid overwhelming the server
        if (i + batchSize < channels.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    return allResults;
}

// Check if channel should be filtered (Full HD)
function shouldFilterChannel(name) {
    const lowerName = name.toLowerCase();
    return lowerName.includes('full hd') ||
           lowerName.includes('fullhd') ||
           lowerName.includes('fhd') ||
           lowerName.includes('1080p') ||
           lowerName.includes('uhd') ||
           lowerName.includes('4k');
}

// Generate HTML report
function generateReport(results) {
    const timestamp = new Date().toISOString();
    const workingChannels = results.channels.filter(c => c.status === 'working');
    const failedChannels = results.channels.filter(c => c.status === 'failed');
    const filteredChannels = results.channels.filter(c => c.filtered);

    const html = `<!DOCTYPE html>
<html>
<head>
    <title>IPTV Channel Test Report</title>
    <meta charset="utf-8">
    <style>
        body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #fff; }
        h1 { color: #51cf66; }
        h2 { color: #aaa; margin-top: 30px; }
        .summary { background: #223354; padding: 15px; border-radius: 8px; margin: 20px 0; }
        .summary div { margin: 5px 0; }
        .working { color: #51cf66; }
        .failed { color: #ff6b6b; }
        .filtered { color: #ffd43b; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #333; }
        th { background: #223354; position: sticky; top: 0; }
        tr:hover { background: #2a2a2a; }
        .status-working { color: #51cf66; }
        .status-failed { color: #ff6b6b; }
        .codec-hevc { color: #ff6b6b; font-weight: bold; }
        .codec-avc { color: #51cf66; }
    </style>
</head>
<body>
    <h1>IPTV Channel Test Report (via Proxy)</h1>
    <p>Generated: ${timestamp}</p>

    <div class="summary">
        <div><strong>Total Channels:</strong> ${results.total}</div>
        <div class="working"><strong>Working:</strong> ${results.working} (${Math.round(results.working/results.total*100)}%)</div>
        <div class="failed"><strong>Failed:</strong> ${results.failed} (${Math.round(results.failed/results.total*100)}%)</div>
        <div class="filtered"><strong>Filtered (Full HD):</strong> ${results.filtered} (${Math.round(results.filtered/results.total*100)}%)</div>
    </div>

    <h2 class="working">✓ Working Channels (${workingChannels.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Name</th>
                <th>Response Time</th>
                <th>Variants</th>
                <th>Codec</th>
                <th>Playlist Size</th>
                <th>Filtered?</th>
            </tr>
        </thead>
        <tbody>
            ${workingChannels.map(ch => `
                <tr>
                    <td>${ch.name}</td>
                    <td>${ch.responseTime}ms</td>
                    <td>${ch.variants || '-'}</td>
                    <td class="${ch.codec && ch.codec.includes('hev') ? 'codec-hevc' : 'codec-avc'}">
                        ${ch.codec || 'unknown'}
                    </td>
                    <td>${ch.playlistSize} bytes</td>
                    <td class="${ch.filtered ? 'filtered' : ''}">${ch.filtered ? 'YES' : 'no'}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>

    <h2 class="failed">✗ Failed Channels (${failedChannels.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Name</th>
                <th>Error</th>
                <th>Stream ID</th>
            </tr>
        </thead>
        <tbody>
            ${failedChannels.map(ch => `
                <tr>
                    <td>${ch.name}</td>
                    <td>${ch.error}</td>
                    <td>${ch.streamId}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>

    <h2 class="filtered">⚠ Filtered Channels (Full HD) (${filteredChannels.length})</h2>
    <table>
        <thead>
            <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Codec</th>
            </tr>
        </thead>
        <tbody>
            ${filteredChannels.map(ch => `
                <tr>
                    <td>${ch.name}</td>
                    <td class="status-${ch.status}">${ch.status}</td>
                    <td class="${ch.codec && ch.codec.includes('hev') ? 'codec-hevc' : 'codec-avc'}">
                        ${ch.codec || 'unknown'}
                    </td>
                </tr>
            `).join('')}
        </tbody>
    </table>
</body>
</html>`;

    return html;
}

// Start proxy server
async function startProxy() {
    return new Promise((resolve, reject) => {
        console.log(`Starting proxy server on port ${PROXY_PORT}...`);
        proxyServer = spawn('node', ['server.js'], {
            env: { ...process.env, PORT: PROXY_PORT },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let started = false;

        proxyServer.stdout.on('data', (data) => {
            const output = data.toString();
            if (output.includes('running on') && !started) {
                started = true;
                console.log('✓ Proxy server started\n');
                // Give it a moment to fully initialize
                setTimeout(resolve, 1000);
            }
        });

        proxyServer.stderr.on('data', (data) => {
            console.error('Proxy error:', data.toString());
        });

        proxyServer.on('error', reject);

        // Timeout if proxy doesn't start
        setTimeout(() => {
            if (!started) {
                reject(new Error('Proxy server failed to start'));
            }
        }, 10000);
    });
}

// Stop proxy server
function stopProxy() {
    if (proxyServer) {
        console.log('\nStopping proxy server...');
        proxyServer.kill();
    }
}

// Main function
async function main() {
    console.log('IPTV Channel Validator (with Proxy)');
    console.log('====================================\n');

    try {
        // Start proxy server
        await startProxy();

        // Fetch channel list
        console.log('Fetching channel list from Xtream API...');
        const apiUrl = `${XTREAM_URL}/player_api.php?username=${XTREAM_USER}&password=${XTREAM_PASS}&action=get_live_streams`;
        const response = await fetchWithTimeout(apiUrl, 30000);
        const streams = JSON.parse(response.data);

        if (!Array.isArray(streams)) {
            throw new Error('Invalid response from Xtream API');
        }

        console.log(`Found ${streams.length} channels\n`);
        results.total = streams.length;

        // Prepare channels with URLs
        const channels = streams.map(s => ({
            name: s.name || `Canal ${s.stream_id}`,
            stream_id: s.stream_id,
            url: `${XTREAM_URL}/live/${XTREAM_USER}/${XTREAM_PASS}/${s.stream_id}.m3u8`,
            category: s.category_name || 'Unknown'
        }));

        // Test all channels
        console.log(`Starting tests (${CONCURRENT_TESTS} concurrent)...\n`);
        const channelResults = await testChannelsBatch(channels, CONCURRENT_TESTS);

        // Mark filtered channels
        channelResults.forEach(result => {
            result.filtered = shouldFilterChannel(result.name);
            if (result.filtered) results.filtered++;
        });

        results.channels = channelResults;

        // Generate reports
        console.log('\n\nGenerating reports...');

        // HTML report
        const htmlReport = generateReport(results);
        writeFileSync('channel-test-report.html', htmlReport);
        console.log('✓ HTML report saved to: channel-test-report.html');

        // JSON report
        writeFileSync('channel-test-report.json', JSON.stringify(results, null, 2));
        console.log('✓ JSON report saved to: channel-test-report.json');

        // Summary
        console.log('\n====================================');
        console.log('SUMMARY');
        console.log('====================================');
        console.log(`Total channels: ${results.total}`);
        console.log(`Working: ${results.working} (${Math.round(results.working/results.total*100)}%)`);
        console.log(`Failed: ${results.failed} (${Math.round(results.failed/results.total*100)}%)`);
        console.log(`Filtered (Full HD): ${results.filtered} (${Math.round(results.filtered/results.total*100)}%)`);
        console.log('\nOpen channel-test-report.html in your browser to see detailed results.');

    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    } finally {
        stopProxy();
        process.exit(0);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    stopProxy();
    process.exit(0);
});

main();
