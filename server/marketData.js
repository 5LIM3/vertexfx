/**
 * Real market data feed.
 * ------------------------------------------------------------------
 * - Crypto (BTC/ETH/SOL): CoinGecko public API — no key required.
 * - Forex majors: Frankfurter.app (ECB rates) — no key required.
 * - Metals (XAU/XAG) and indices (US30/US100/SPX500): tries Stooq first
 *   (free, no key), then Yahoo Finance's public chart endpoint (free, no
 *   key) for anything Stooq missed. If TWELVE_DATA_API_KEY is set, Twelve
 *   Data is used instead of both (more reliable, requires free signup).
 *
 * IMPORTANT: every failure is logged to the console with which symbol and
 * which source failed. A symbol that never appears in the "live" log lines
 * is NOT connected to a real price and will stay on the hardcoded fallback
 * base in engine.js until one of these sources works — check the server
 * console output, don't just compare against an outside chart and guess.
 *
 * Nothing here executes trades — this module only supplies the one-time
 * real starting price the simulation engine bootstraps from.
 */

const COINGECKO_IDS = { BTCUSD: 'bitcoin', ETHUSD: 'ethereum', SOLUSD: 'solana' };
const TWELVE_DATA_SYMBOLS = { XAUUSD: 'XAU/USD', XAGUSD: 'XAG/USD', US30: 'DJI', US100: 'NDX', SPX500: 'GSPC' };
const STOOQ_SYMBOLS = { XAUUSD: 'xauusd', XAGUSD: 'xagusd', US30: '^dji', US100: '^ndq', SPX500: '^spx' };
const YAHOO_SYMBOLS = { XAUUSD: 'GC=F', XAGUSD: 'SI=F', US30: '^DJI', US100: '^NDX', SPX500: '^GSPC' };

const TD_KEY = process.env.TWELVE_DATA_API_KEY || '';
const CURRENCYFREAKS_KEY = process.env.CURRENCYFREAKS_API_KEY || '';

async function safeFetchJson(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function safeFetchText(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.text() };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

async function fetchCrypto() {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const { data, error } = await safeFetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
  const out = {};
  if (error) { console.warn(`[market-data] CoinGecko (crypto) failed: ${error}`); return out; }
  for (const [sym, id] of Object.entries(COINGECKO_IDS)) {
    if (data[id]?.usd) out[sym] = { price: data[id].usd, source: 'live-coingecko' };
    else console.warn(`[market-data] CoinGecko: no price returned for ${sym} (${id})`);
  }
  return out;
}

async function fetchForex() {
  const targets = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF'];
  const { data, error } = await safeFetchJson(`https://api.frankfurter.app/latest?from=USD&to=${targets.join(',')}`);
  const out = {};
  if (error || !data?.rates) { console.warn(`[market-data] Frankfurter (forex) failed: ${error || 'no rates in response'}`); return out; }
  const r = data.rates;
  if (r.EUR) out.EURUSD = { price: 1 / r.EUR, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing EUR rate');
  if (r.GBP) out.GBPUSD = { price: 1 / r.GBP, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing GBP rate');
  if (r.JPY) out.USDJPY = { price: r.JPY, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing JPY rate');
  if (r.AUD) out.AUDUSD = { price: 1 / r.AUD, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing AUD rate');
  if (r.CAD) out.USDCAD = { price: r.CAD, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing CAD rate');
  if (r.CHF) out.USDCHF = { price: r.CHF, source: 'live-frankfurter' }; else console.warn('[market-data] Frankfurter: missing CHF rate');
  return out;
}

async function fetchTwelveData() {
  const out = {};
  for (const [vfxSym, tdSym] of Object.entries(TWELVE_DATA_SYMBOLS)) {
    const { data, error } = await safeFetchJson(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSym)}&apikey=${TD_KEY}`);
    if (error) { console.warn(`[market-data] Twelve Data failed for ${vfxSym}: ${error}`); continue; }
    if (data?.price && !isNaN(parseFloat(data.price))) {
      out[vfxSym] = { price: parseFloat(data.price), source: 'live-twelvedata' };
    } else {
      console.warn(`[market-data] Twelve Data: no usable price for ${vfxSym} — response: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  return out;
}

async function fetchStooqSymbol(stooqSym) {
  const { data: csv, error } = await safeFetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`);
  if (error) return { error };
  const lines = (csv || '').trim().split('\n');
  if (lines.length < 2) return { error: 'empty/malformed CSV response' };
  const cols = lines[1].split(',');
  const close = parseFloat(cols[6]);
  if (isNaN(close) || close <= 0) return { error: `unparseable close value: "${cols[6]}"` };
  return { price: close };
}

async function fetchYahooSymbol(yahooSym) {
  const { data, error } = await safeFetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VertexFXDemo/1.0)' } }
  );
  if (error) return { error };
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== 'number' || price <= 0) return { error: 'no regularMarketPrice in response' };
  return { price };
}

/** Metals + indices: Yahoo Finance first (more consistently reliable), Stooq as fallback. Both free/no-key. */
async function fetchMetalsIndices() {
  const out = {};
  for (const vfxSym of Object.keys(YAHOO_SYMBOLS)) {
    const yahoo = await fetchYahooSymbol(YAHOO_SYMBOLS[vfxSym]);
    if (yahoo.price) {
      out[vfxSym] = { price: yahoo.price, source: 'live-yahoo' };
      continue;
    }
    console.warn(`[market-data] Yahoo failed for ${vfxSym} (${YAHOO_SYMBOLS[vfxSym]}): ${yahoo.error} — trying Stooq`);

    const stooq = await fetchStooqSymbol(STOOQ_SYMBOLS[vfxSym]);
    if (stooq.price) {
      out[vfxSym] = { price: stooq.price, source: 'live-stooq' };
      continue;
    }
    console.warn(`[market-data] Stooq also failed for ${vfxSym} (${STOOQ_SYMBOLS[vfxSym]}): ${stooq.error} — ${vfxSym} stays on the simulated fallback base until a source works`);
  }
  return out;
}

/** KWD/USDT — real fiat rate from CurrencyFreaks (free tier, signup required for a key). */
async function fetchKwdUsdt() {
  if (!CURRENCYFREAKS_KEY) return {};
  const { data, error } = await safeFetchJson(`https://api.currencyfreaks.com/latest?apikey=${CURRENCYFREAKS_KEY}&symbols=KWD`);
  if (error) { console.warn(`[market-data] CurrencyFreaks (KWD/USDT) failed: ${error}`); return {}; }
  const kwdPerUsd = parseFloat(data?.rates?.KWD);
  if (!kwdPerUsd || isNaN(kwdPerUsd) || kwdPerUsd <= 0) {
    console.warn(`[market-data] CurrencyFreaks: no usable KWD rate in response — ${JSON.stringify(data).slice(0, 200)}`);
    return {};
  }
  // data.rates.KWD is "KWD per 1 USD" — invert to get "USD(≈USDT) per 1 KWD",
  // matching our other pairs' convention of base-currency-first quoting.
  return { KWDUSDT: { price: 1 / kwdPerUsd, source: 'live-currencyfreaks' } };
}

/** Fetch everything available right now. Returns { SYM: {price, source} }. */
async function fetchAllLivePrices() {
  const [crypto, forex, metalsIdx, kwd] = await Promise.all([
    fetchCrypto().catch((e) => { console.warn('[market-data] crypto fetch threw:', e.message); return {}; }),
    fetchForex().catch((e) => { console.warn('[market-data] forex fetch threw:', e.message); return {}; }),
    (TD_KEY ? fetchTwelveData() : fetchMetalsIndices()).catch((e) => { console.warn('[market-data] metals/indices fetch threw:', e.message); return {}; }),
    fetchKwdUsdt().catch((e) => { console.warn('[market-data] KWD/USDT fetch threw:', e.message); return {}; }),
  ]);
  return { ...crypto, ...forex, ...metalsIdx, ...kwd };
}

module.exports = { fetchAllLivePrices, TD_KEY_CONFIGURED: !!TD_KEY, CURRENCYFREAKS_CONFIGURED: !!CURRENCYFREAKS_KEY };
