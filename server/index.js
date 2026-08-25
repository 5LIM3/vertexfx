require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

const { PriceEngine } = require('./engine');
const { checkStopLevels } = require('./positionMonitor');
const marketData = require('./marketData');

const authRoutes = require('./routes/auth');
const twofaRoutes = require('./routes/twofa');
const kycRoutes = require('./routes/kyc');
const walletRoutes = require('./routes/wallet');
const publicRoutes = require('./routes/public');
const tradingRoutesFactory = require('./routes/trading');
const adminRoutesFactory = require('./routes/admin');

const app = express();
// Fly.io (and most PaaS) sit behind a proxy — without this, express-rate-limit
// sees every request as coming from the same IP and either misbehaves or throws.
app.set('trust proxy', 1);
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
// Default 100kb is too small for KYC document uploads (base64-encoded photos) —
// raised specifically to accommodate those; unrelated routes are unaffected.
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());

// ---- Simulated market engine (single shared instance) ----
const engine = new PriceEngine();

// ---- WebSocket price feed (declared before admin routes need `wss`) ----
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', data: engine.snapshot() }));
  ws.send(JSON.stringify({ type: 'tape', data: engine.tradeTape.slice(0, 30) }));
});
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

// ---- API routes ----
app.use('/api/auth', authRoutes);
app.use('/api/2fa', twofaRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api', publicRoutes);
app.use('/api/trading', tradingRoutesFactory(engine));
app.use('/api/admin', adminRoutesFactory(engine, wss));

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---- Static frontend ----
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, {
  // Prevent the browser from silently serving a stale cached dashboard.html/JS after
  // a deploy — HTML/JS here can change frequently during development and a cached
  // copy showing old behavior (e.g. an old chart-loading bug) is a confusing dead end.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(PUBLIC_DIR, req.path.endsWith('.html') || req.path.includes('.') ? req.path : req.path + '.html'), (err) => {
    if (err) res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
});

// ---- Engine tick loop (server-authoritative, 1s) ----
setInterval(() => {
  engine.tick();
  checkStopLevels(engine); // auto-close any position whose SL/TP was just crossed
  broadcast({ type: 'tick', data: engine.snapshot(), tape: engine.tradeTape.slice(0, 10) });
}, 1000);

// ---- Live market data poller ----
// Crypto (CoinGecko) + forex (Frankfurter) need no API key and are safe to poll
// fairly often. Twelve Data (metals/indices) only runs if TWELVE_DATA_API_KEY is
// set, since its free tier is tightly rate-limited.
async function pollLiveData() {
  try {
    const prices = await marketData.fetchAllLivePrices();
    for (const [sym, { price, source }] of Object.entries(prices)) {
      engine.applyLiveAnchor(sym, price, source);
    }
    const gotCount = Object.keys(prices).length;
    const allSymbols = Object.keys(engine.symbols);
    const neverConnected = allSymbols.filter(sym => !engine.symbols[sym].lastLiveUpdate);
    console.log(`[market-data] refreshed ${gotCount}/${allSymbols.length} symbols from live feeds`);
    if (neverConnected.length) {
      console.warn(`[market-data] ⚠ still on fallback/simulated price, never connected: ${neverConnected.join(', ')}`);
    }
  } catch (e) {
    console.error('[market-data] poll failed:', e.message);
  }
}
pollLiveData();
setInterval(pollLiveData, 45000);

server.listen(PORT, () => {
  console.log(`VertexFX server (simulated engine + live data anchors) running on http://localhost:${PORT}`);
  console.log(marketData.TD_KEY_CONFIGURED
    ? '[market-data] Using Twelve Data for metals/indices (API key configured).'
    : '[market-data] Using free Stooq/Yahoo feeds for metals/indices (no key needed). Crypto (CoinGecko) + forex (Frankfurter) are always live.');
  console.log('[market-data] KWD/SAR/IQD via open.er-api.com (free, no key, no quota).'
    + (marketData.CURRENCYFREAKS_CONFIGURED
      ? ' CurrencyFreaks configured as quota-gated fallback.'
      : ' CURRENCYFREAKS_API_KEY not set — no fallback if open.er-api.com is down (optional, get a free key at https://currencyfreaks.com).'));
});
