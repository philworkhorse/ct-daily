const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3500;

// Try multiple data locations
const DATA_DIRS = [
  path.join(__dirname, 'data'),
  path.join(process.env.HOME || '', 'ct-scanner/data')
];

function getDataDir() {
  for (const dir of DATA_DIRS) {
    if (fs.existsSync(dir)) return dir;
  }
  return DATA_DIRS[0];
}

function loadScans(hoursBack = 24) {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) return [];
  
  const cutoff = Date.now() - (hoursBack * 60 * 60 * 1000);
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
  
  const scans = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      const ts = new Date(data.timestamp).getTime();
      if (ts >= cutoff) scans.push(data);
    } catch (e) {}
  }
  
  return scans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function loadAllScans() {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) return [];
  
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
  const scans = [];
  for (const file of files) {
    try {
      scans.push(JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8')));
    } catch (e) {}
  }
  return scans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function analyzeSentiment(scans) {
  if (!scans.length) return { bull: 0, bear: 0, ratio: 0, trend: 'UNKNOWN' };
  
  const bull = scans.reduce((s, d) => s + (d.sentiment?.bullish || 0), 0) / scans.length;
  const bear = scans.reduce((s, d) => s + (d.sentiment?.bearish || 0), 0) / scans.length;
  const ratio = bear > 0 ? (bull / bear).toFixed(2) : bull > 0 ? '∞' : '0';
  
  // Trend: compare first half vs second half
  const mid = Math.floor(scans.length / 2);
  const firstHalf = scans.slice(0, mid);
  const secondHalf = scans.slice(mid);
  const firstBull = firstHalf.reduce((s, d) => s + (d.sentiment?.bullish || 0), 0) / (firstHalf.length || 1);
  const secondBull = secondHalf.reduce((s, d) => s + (d.sentiment?.bullish || 0), 0) / (secondHalf.length || 1);
  const trend = secondBull > firstBull * 1.1 ? 'RISING' : secondBull < firstBull * 0.9 ? 'DECLINING' : 'STABLE';
  
  return { bull: bull.toFixed(1), bear: bear.toFixed(1), ratio, trend };
}

function getTopTickers(scans, limit = 15) {
  const counts = {};
  for (const scan of scans) {
    const tickers = scan.topTickers || [];
    for (const [ticker, count] of tickers) {
      const clean = ticker.replace('$', '');
      counts[clean] = (counts[clean] || 0) + count;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, mentions]) => ({ name, mentions }));
}

function getCommodities(scans) {
  const commodities = {};
  for (const scan of scans) {
    const keywords = scan.byCategory?.commodities || scan.byCategory?.metals || [];
    // Also check macroKeywords
    const macro = scan.macroKeywords || {};
    for (const [kw, count] of Object.entries(macro)) {
      if (['gold', 'silver', 'copper', 'oil', 'corn', 'coffee'].includes(kw)) {
        commodities[kw] = (commodities[kw] || 0) + count;
      }
    }
    // Check commodity keywords
    const ck = scan.commodityKeywords || {};
    for (const [kw, count] of Object.entries(ck)) {
      commodities[kw] = (commodities[kw] || 0) + count;
    }
  }
  return Object.entries(commodities)
    .sort((a, b) => b[1] - a[1])
    .map(([name, mentions]) => ({ name, mentions }));
}

function getHighEngagement(scans, limit = 5) {
  const posts = [];
  for (const scan of scans) {
    const hp = scan.highEngagement || [];
    for (const post of hp) {
      posts.push({
        author: post.author || post.username,
        likes: post.likes || post.engagement,
        text: (post.text || post.content || '').slice(0, 200),
        url: post.url
      });
    }
  }
  // Deduplicate by URL and sort
  const seen = new Set();
  return posts
    .filter(p => {
      if (!p.url || seen.has(p.url)) return false;
      seen.add(p.url);
      return true;
    })
    .sort((a, b) => (b.likes || 0) - (a.likes || 0))
    .slice(0, limit);
}

function getRegimeLabel(ratio) {
  const r = parseFloat(ratio);
  if (r >= 5) return { label: 'EUPHORIA', emoji: '🚀', color: '#00ff88' };
  if (r >= 3) return { label: 'BULLISH', emoji: '🟢', color: '#4ade80' };
  if (r >= 1.5) return { label: 'LEANING BULL', emoji: '🟡', color: '#facc15' };
  if (r >= 0.67) return { label: 'NEUTRAL', emoji: '⚪', color: '#94a3b8' };
  if (r >= 0.33) return { label: 'LEANING BEAR', emoji: '🟠', color: '#fb923c' };
  return { label: 'BEARISH', emoji: '🔴', color: '#ef4444' };
}

function getFearLevel(commodities, scanCount) {
  const goldMentions = commodities.find(c => c.name === 'gold')?.mentions || 0;
  const perScan = scanCount > 0 ? goldMentions / scanCount : 0;
  if (perScan >= 5) return { level: 'EXTREME', emoji: '🔴', color: '#ef4444' };
  if (perScan >= 3) return { level: 'HIGH', emoji: '🟠', color: '#f97316' };
  if (perScan >= 1.5) return { level: 'ELEVATED', emoji: '🟡', color: '#eab308' };
  return { level: 'NORMAL', emoji: '🟢', color: '#22c55e' };
}

function getMomentum(allScans, recentScans) {
  if (allScans.length < 40 || recentScans.length < 10) return [];
  
  const recentTickers = {};
  const priorTickers = {};
  
  const recentStart = new Date(recentScans[0].timestamp).getTime();
  
  for (const scan of allScans) {
    const ts = new Date(scan.timestamp).getTime();
    const target = ts >= recentStart ? recentTickers : priorTickers;
    for (const [ticker, count] of (scan.topTickers || [])) {
      const clean = ticker.replace('$', '');
      target[clean] = (target[clean] || 0) + count;
    }
  }
  
  const results = [];
  const allTickers = new Set([...Object.keys(recentTickers), ...Object.keys(priorTickers)]);
  
  for (const ticker of allTickers) {
    const recent = recentTickers[ticker] || 0;
    const prior = priorTickers[ticker] || 0;
    if (recent + prior < 5) continue;
    
    const recentRate = recent / recentScans.length;
    const priorRate = prior / (allScans.length - recentScans.length || 1);
    
    if (priorRate > 0) {
      const change = ((recentRate - priorRate) / priorRate * 100).toFixed(0);
      if (Math.abs(change) > 30) {
        results.push({ ticker, recentRate: recentRate.toFixed(2), priorRate: priorRate.toFixed(2), change: parseInt(change), direction: change > 0 ? 'up' : 'down' });
      }
    } else if (recent >= 3) {
      results.push({ ticker, recentRate: recentRate.toFixed(2), priorRate: '0.00', change: 999, direction: 'new' });
    }
  }
  
  return results.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 12);
}

function generateNarrative(sentiment, regime, fear, tickers, momentum) {
  const parts = [];
  
  // Opening
  if (regime.label === 'EUPHORIA') {
    parts.push('CT is running hot. Multiple signals pointing toward risk-on euphoria.');
  } else if (regime.label === 'BULLISH') {
    parts.push(`Structural optimism holds with a ${sentiment.ratio}:1 bull/bear ratio, though the mood is ${sentiment.trend.toLowerCase()}.`);
  } else if (regime.label === 'NEUTRAL') {
    parts.push('Markets are in wait-and-see mode. Neither conviction nor fear dominating.');
  } else {
    parts.push('Caution dominates. Bears have the floor.');
  }
  
  // Fear gauge
  if (fear.level === 'EXTREME') {
    parts.push('Gold mentions are at extreme levels — historically this precedes volatility, not necessarily direction.');
  } else if (fear.level === 'HIGH') {
    parts.push('The fear gauge is elevated. Commodity mentions suggest macro uncertainty is on traders\' minds.');
  }
  
  // Momentum
  const rising = momentum.filter(m => m.direction === 'up' || m.direction === 'new').slice(0, 3);
  const falling = momentum.filter(m => m.direction === 'down').slice(0, 3);
  
  if (rising.length) {
    parts.push(`Attention building on ${rising.map(m => '$' + m.ticker).join(', ')}.`);
  }
  if (falling.length) {
    parts.push(`Narrative fading for ${falling.map(m => '$' + m.ticker).join(', ')}.`);
  }
  
  return parts.join(' ');
}

// Generate the brief page
app.get('/', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  const allScans = loadAllScans();
  
  const sentiment = analyzeSentiment(scans);
  const regime = getRegimeLabel(sentiment.ratio);
  const tickers = getTopTickers(scans);
  const commodities = getCommodities(scans);
  const fear = getFearLevel(commodities, scans.length);
  const highEngagement = getHighEngagement(scans, 8);
  const momentum = getMomentum(allScans, scans);
  const narrative = generateNarrative(sentiment, regime, fear, tickers, momentum);
  
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  
  const rising = momentum.filter(m => m.direction === 'up' || m.direction === 'new');
  const falling = momentum.filter(m => m.direction === 'down');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CT Daily Brief — ${dateStr}</title>
<meta name="description" content="Daily Crypto Twitter intelligence brief. Regime: ${regime.label}. Fear: ${fear.level}. Powered by ${allScans.length}+ autonomous scans.">
<meta property="og:title" content="CT Daily Brief — ${regime.emoji} ${regime.label}">
<meta property="og:description" content="${narrative.slice(0, 200)}">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
  
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a25;
    --border: #2a2a3a;
    --text: #e4e4ed;
    --text2: #8888a0;
    --accent: ${regime.color};
    --fear: ${fear.color};
  }
  
  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }
  
  .container {
    max-width: 680px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }
  
  header {
    margin-bottom: 48px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 32px;
  }
  
  .masthead {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text2);
    margin-bottom: 8px;
  }
  
  .date {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  
  .time {
    font-size: 14px;
    color: var(--text2);
  }
  
  .scan-count {
    font-size: 12px;
    color: var(--text2);
    margin-top: 4px;
    font-family: 'JetBrains Mono', monospace;
  }
  
  /* Regime Banner */
  .regime-banner {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 24px;
    margin-bottom: 32px;
  }
  
  .regime-label {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 12px;
  }
  
  .regime-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
  }
  
  .stat {
    text-align: center;
  }
  
  .stat-value {
    font-size: 22px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
  }
  
  .stat-label {
    font-size: 11px;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-top: 4px;
  }
  
  /* Narrative */
  .narrative {
    font-size: 16px;
    line-height: 1.7;
    color: var(--text);
    margin-bottom: 40px;
    padding: 0 4px;
  }
  
  /* Sections */
  .section {
    margin-bottom: 40px;
  }
  
  .section-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--text2);
    margin-bottom: 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  
  /* Tickers */
  .ticker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
  }
  
  .ticker {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    text-align: center;
    transition: border-color 0.2s;
  }
  
  .ticker:hover {
    border-color: var(--accent);
  }
  
  .ticker-name {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 14px;
    color: var(--accent);
  }
  
  .ticker-count {
    font-size: 12px;
    color: var(--text2);
    margin-top: 4px;
  }
  
  /* Momentum */
  .momentum-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  
  .momentum-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 16px;
  }
  
  .momentum-ticker {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 14px;
  }
  
  .momentum-change {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 14px;
  }
  
  .momentum-change.up { color: #4ade80; }
  .momentum-change.down { color: #ef4444; }
  .momentum-change.new { color: #818cf8; }
  
  .momentum-bar {
    height: 3px;
    border-radius: 2px;
    margin-top: 4px;
  }
  
  /* Fear Gauge */
  .fear-gauge {
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--fear);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 12px;
  }
  
  .fear-level {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--fear);
    margin-bottom: 8px;
  }
  
  .commodity-row {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  
  .commodity {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: var(--text2);
  }
  
  .commodity strong {
    color: var(--text);
  }
  
  /* High Engagement */
  .post {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 20px;
    margin-bottom: 8px;
    transition: border-color 0.2s;
  }
  
  .post:hover {
    border-color: var(--text2);
  }
  
  .post-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  
  .post-author {
    font-weight: 600;
    font-size: 14px;
  }
  
  .post-likes {
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    color: #ef4444;
  }
  
  .post-text {
    font-size: 14px;
    color: var(--text2);
    line-height: 1.5;
  }
  
  .post a {
    color: var(--accent);
    text-decoration: none;
    font-size: 12px;
    opacity: 0.7;
  }
  
  .post a:hover { opacity: 1; }
  
  /* Time Controls */
  .time-controls {
    display: flex;
    gap: 8px;
    margin-bottom: 32px;
  }
  
  .time-btn {
    padding: 6px 14px;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text2);
    border-radius: 4px;
    cursor: pointer;
    text-decoration: none;
    transition: all 0.2s;
  }
  
  .time-btn:hover, .time-btn.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  
  /* Footer */
  footer {
    margin-top: 60px;
    padding-top: 24px;
    border-top: 1px solid var(--border);
    text-align: center;
  }
  
  .footer-text {
    font-size: 12px;
    color: var(--text2);
    line-height: 1.8;
  }
  
  .footer-text a {
    color: var(--text2);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
  }
  
  .footer-text a:hover {
    color: var(--text);
  }
  
  /* Responsive */
  @media (max-width: 600px) {
    .container { padding: 24px 16px 60px; }
    .date { font-size: 22px; }
    .regime-stats { grid-template-columns: repeat(2, 1fr); }
    .ticker-grid { grid-template-columns: repeat(3, 1fr); }
  }
</style>
</head>
<body>
<div class="container">
  
  <header>
    <div class="masthead">CT Daily Brief</div>
    <div class="date">${dateStr}</div>
    <div class="time">Generated at ${timeStr} EST</div>
    <div class="scan-count">${scans.length} scans analyzed · ${allScans.length} total in archive</div>
  </header>
  
  <div class="time-controls">
    <a href="/?hours=8" class="time-btn ${hours === 8 ? 'active' : ''}">8h</a>
    <a href="/?hours=24" class="time-btn ${hours === 24 ? 'active' : ''}">24h</a>
    <a href="/?hours=48" class="time-btn ${hours === 48 ? 'active' : ''}">48h</a>
    <a href="/?hours=168" class="time-btn ${hours === 168 ? 'active' : ''}">7d</a>
  </div>
  
  <!-- Regime -->
  <div class="regime-banner">
    <div class="regime-label">${regime.emoji} ${regime.label}</div>
    <div class="regime-stats">
      <div class="stat">
        <div class="stat-value" style="color: #4ade80">${sentiment.bull}%</div>
        <div class="stat-label">Bullish</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: #ef4444">${sentiment.bear}%</div>
        <div class="stat-label">Bearish</div>
      </div>
      <div class="stat">
        <div class="stat-value">${sentiment.ratio}</div>
        <div class="stat-label">Ratio</div>
      </div>
      <div class="stat">
        <div class="stat-value">${sentiment.trend === 'RISING' ? '↑' : sentiment.trend === 'DECLINING' ? '↓' : '→'}</div>
        <div class="stat-label">${sentiment.trend}</div>
      </div>
    </div>
  </div>
  
  <!-- Narrative -->
  <p class="narrative">${narrative}</p>
  
  <!-- Fear Gauge -->
  <div class="section">
    <div class="section-title">Fear Gauge</div>
    <div class="fear-gauge">
      <div class="fear-level">${fear.emoji} ${fear.level}</div>
      <div class="commodity-row">
        ${commodities.slice(0, 6).map(c => `<span class="commodity"><strong>${c.name}</strong> ${c.mentions}</span>`).join('\n        ')}
      </div>
    </div>
  </div>
  
  <!-- Top Tickers -->
  <div class="section">
    <div class="section-title">Top Tickers</div>
    <div class="ticker-grid">
      ${tickers.map(t => `
      <div class="ticker">
        <div class="ticker-name">$${t.name}</div>
        <div class="ticker-count">${t.mentions} mentions</div>
      </div>`).join('')}
    </div>
  </div>
  
  <!-- Momentum -->
  ${momentum.length > 0 ? `
  <div class="section">
    <div class="section-title">Momentum Shifts</div>
    <div class="momentum-list">
      ${rising.slice(0, 5).map(m => `
      <div class="momentum-item">
        <span class="momentum-ticker">$${m.ticker}</span>
        <span class="momentum-change ${m.direction}">${m.direction === 'new' ? '🆕 NEW' : `+${m.change}%`}</span>
      </div>`).join('')}
      ${falling.slice(0, 5).map(m => `
      <div class="momentum-item">
        <span class="momentum-ticker">$${m.ticker}</span>
        <span class="momentum-change down">${m.change}%</span>
      </div>`).join('')}
    </div>
  </div>` : ''}
  
  <!-- High Engagement -->
  ${highEngagement.length > 0 ? `
  <div class="section">
    <div class="section-title">Highest Engagement</div>
    ${highEngagement.map(p => `
    <div class="post">
      <div class="post-header">
        <span class="post-author">@${p.author || 'unknown'}</span>
        <span class="post-likes">❤️ ${(p.likes || 0).toLocaleString()}</span>
      </div>
      <div class="post-text">${escapeHtml(p.text || '')}</div>
      ${p.url ? `<a href="${p.url}" target="_blank" rel="noopener">View →</a>` : ''}
    </div>`).join('')}
  </div>` : ''}
  
  <!-- API -->
  <div class="section">
    <div class="section-title">API</div>
    <div style="background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px;">
      <div style="font-family: 'JetBrains Mono', monospace; font-size: 13px; color: var(--text2); line-height: 2;">
        <div><span style="color: var(--accent)">GET</span> /api/brief</div>
        <div><span style="color: var(--accent)">GET</span> /api/brief/compact</div>
        <div><span style="color: var(--accent)">GET</span> /api/tickers?hours=24</div>
        <div><span style="color: var(--accent)">GET</span> /api/fear</div>
        <div><span style="color: var(--accent)">GET</span> /api/momentum</div>
      </div>
    </div>
  </div>
  
  <footer>
    <div class="footer-text">
      Autonomous intelligence from ${allScans.length}+ CT scans across ${Math.ceil((Date.now() - new Date(allScans[0]?.timestamp || Date.now()).getTime()) / 86400000)} days<br>
      Built by <a href="https://phil-portfolio-production.up.railway.app">Phil</a> · Data collected by <a href="https://github.com/philworkhorse">ct-scanner</a><br>
      Not financial advice. An AI agent watching markets and sharing what it sees.
    </div>
  </footer>
  
</div>
</body>
</html>`);
});

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// API Endpoints
app.get('/api/brief', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  const allScans = loadAllScans();
  const sentiment = analyzeSentiment(scans);
  const regime = getRegimeLabel(sentiment.ratio);
  const tickers = getTopTickers(scans);
  const commodities = getCommodities(scans);
  const fear = getFearLevel(commodities, scans.length);
  const momentum = getMomentum(allScans, scans);
  
  res.json({
    generated: new Date().toISOString(),
    window: `${hours}h`,
    scanCount: scans.length,
    totalScans: allScans.length,
    regime: { label: regime.label, ...sentiment, fear: fear.level },
    tickers,
    commodities,
    momentum,
    narrative: generateNarrative(sentiment, regime, fear, tickers, momentum)
  });
});

app.get('/api/brief/compact', (req, res) => {
  const scans = loadScans(24);
  const sentiment = analyzeSentiment(scans);
  const regime = getRegimeLabel(sentiment.ratio);
  const tickers = getTopTickers(scans, 5);
  const commodities = getCommodities(scans);
  const fear = getFearLevel(commodities, scans.length);
  
  res.json({
    regime: regime.label,
    sentiment: `${sentiment.bull}%↑ ${sentiment.bear}%↓`,
    ratio: `${sentiment.ratio}:1`,
    trend: sentiment.trend,
    fear: fear.level,
    topTickers: tickers.map(t => `$${t.name}(${t.mentions})`).join(' '),
    scans: scans.length
  });
});

app.get('/api/tickers', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  res.json({ window: `${hours}h`, scanCount: scans.length, tickers: getTopTickers(scans, 30) });
});

app.get('/api/fear', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  const commodities = getCommodities(scans);
  const fear = getFearLevel(commodities, scans.length);
  res.json({ window: `${hours}h`, scanCount: scans.length, level: fear.level, commodities });
});

app.get('/api/momentum', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const scans = loadScans(hours);
  const allScans = loadAllScans();
  res.json({ window: `${hours}h`, momentum: getMomentum(allScans, scans) });
});

app.listen(PORT, () => {
  const dataDir = getDataDir();
  const scanCount = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).length : 0;
  console.log(`CT Daily Brief running on port ${PORT}`);
  console.log(`Data: ${dataDir} (${scanCount} scans)`);
});
