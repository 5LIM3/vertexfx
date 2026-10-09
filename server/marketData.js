/**
 * Real market data feed.
 * ------------------------------------------------------------------
 * - Exotic fiat vs USDT (KWD/SAR/IQD): open.er-api.com (free, no key), with
 *   CurrencyFreaks as an optional quota-gated fallback (CURRENCYFREAKS_API_KEY).
 * - IRR (free-market rate specifically, not Iran's official peg):
 *   bonbast.amirhn.com, a free no-key community proxy for Bonbast — see the
 *   fetchIrrFreeMarket() comment for important caveats about this source.
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


const CURRENCYFREAKS_KEY = process.env.CURRENCYFREAKS_API_KEY || '';

// Node's fetch() wraps every network-level failure (DNS, TLS, connection
// refused, etc.) in a generic top-level "fetch failed" Error and puts the
// ACTUAL reason in a separate, easy-to-miss `.cause` property — which was
// never being logged, so every failure just showed up as the useless string
// "fetch failed" with no way to tell DNS failure from a timeout from a block.
// This surfaces e.cause (code/message) alongside it so future failures are
// actually diagnosable from the logs instead of a dead end.
function describeError(e) {
  if (e.name === 'AbortError') return 'timeout';
  const cause = e.cause;
  const causeDesc = cause ? (cause.code || cause.message || String(cause)) : null;
  return causeDesc ? `${e.message} (cause: ${causeDesc})` : e.message;
}

async function safeFetchJson(url, opts = {}, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: describeError(e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * KWD, SAR, IQD vs USDT.
 * ------------------------------------------------------------------
 * ROOT CAUSE of "chart isn't moving" / "never connected": this used to call
 * CurrencyFreaks on every 45s poll (server/index.js). CurrencyFreaks' free
 * plan is 1000 requests/MONTH, but 45s polling burns ~1,920 requests/DAY —
 * the monthly quota was gone within hours of a fresh deploy, so these three
 * symbols silently sat on the simulated fallback base from then on (the
 * "100% of your requests quota" email).
 *
 * Fix, in order:
 *  1. Primary source is now open.er-api.com — free, no API key, no request
 *     quota (rates update ~once/day, which is fine for KWD/SAR/IQD: SAR is
 *     hard-pegged and KWD/IQD are managed, so they barely move intraday).
 *     This removes the quota problem entirely for the common case.
 *  2. CurrencyFreaks (if CURRENCYFREAKS_API_KEY is set) is kept ONLY as a
 *     fallback for when open.er-api.com is unreachable, AND is now
 *     cache-gated to one real network call per CURRENCYFREAKS_MIN_INTERVAL_MS
 *     (default 60 min) regardless of how often fetchExoticFiat() itself is
 *     called — so even on a 45s poll loop it can never re-exhaust a paid or
 *     free-tier quota again.
 */
const CURRENCYFREAKS_MIN_INTERVAL_MS = Number(process.env.CURRENCYFREAKS_MIN_INTERVAL_MS) || 60 * 60 * 1000;
let currencyFreaksCache = { at: 0, data: null };

async function fetchExoticFiatPrimary() {
  const { data, error } = await safeFetchJson('https://open.er-api.com/v6/latest/USD');
  if (error) { console.warn(`[market-data] open.er-api.com (exotic fiat) failed: ${error}`); return {}; }
  const rates = data?.rates || {};
  const out = {};

  const kwdPerUsd = parseFloat(rates.KWD);
  if (kwdPerUsd > 0) out.KWDUSDT = { price: 1 / kwdPerUsd, source: 'live-erapi' };
  else console.warn(`[market-data] open.er-api.com: no usable KWD rate`);

  const sarPerUsd = parseFloat(rates.SAR);
  if (sarPerUsd > 0) out.SARUSDT = { price: 1 / sarPerUsd, source: 'live-erapi' };
  else console.warn(`[market-data] open.er-api.com: no usable SAR rate`);

  const iqdPerUsd = parseFloat(rates.IQD);
  if (iqdPerUsd > 0) out.IQDUSDT = { price: 1 / iqdPerUsd, source: 'live-erapi' };
  else console.warn(`[market-data] open.er-api.com: no usable IQD rate`);

  return out;
}

/** Fallback only — quota-gated so this can only ever hit the network once
 * per CURRENCYFREAKS_MIN_INTERVAL_MS no matter how often it's called. */
async function fetchExoticFiatCurrencyFreaksFallback() {
  if (!CURRENCYFREAKS_KEY) return {};
  const age = Date.now() - currencyFreaksCache.at;
  if (currencyFreaksCache.data && age < CURRENCYFREAKS_MIN_INTERVAL_MS) {
    return currencyFreaksCache.data; // served from cache, no network call, no quota spent
  }
  const { data, error } = await safeFetchJson(`https://api.currencyfreaks.com/latest?apikey=${CURRENCYFREAKS_KEY}&symbols=KWD,SAR,IQD`);
  if (error) {
    console.warn(`[market-data] CurrencyFreaks (fallback) failed: ${error}`);
    return currencyFreaksCache.data || {}; // stale cache beats nothing
  }
  const rates = data?.rates || {};
  const out = {};
  const kwdPerUsd = parseFloat(rates.KWD);
  if (kwdPerUsd > 0) out.KWDUSDT = { price: 1 / kwdPerUsd, source: 'live-currencyfreaks' };
  const sarPerUsd = parseFloat(rates.SAR);
  if (sarPerUsd > 0) out.SARUSDT = { price: 1 / sarPerUsd, source: 'live-currencyfreaks' };
  const iqdPerUsd = parseFloat(rates.IQD);
  if (iqdPerUsd > 0) out.IQDUSDT = { price: 1 / iqdPerUsd, source: 'live-currencyfreaks' };
  currencyFreaksCache = { at: Date.now(), data: out };
  return out;
}

async function fetchExoticFiat() {
  const primary = await fetchExoticFiatPrimary();
  const stillMissing = ['KWDUSDT', 'SARUSDT', 'IQDUSDT'].some((s) => !primary[s]);
  if (!stillMissing) return primary;

  const fallback = await fetchExoticFiatCurrencyFreaksFallback();
  return { ...fallback, ...primary }; // primary wins when both have a symbol
}

/**
 * IRR free-market rate from bonbast.amirhn.com — a free, open-source, no-key
 * proxy for Bonbast's actual free-market rates (the ones people transact at,
 * not Iran's official/sanctions-era peg). MIT licensed, source at
 * github.com/itsamirhn/Bonbast-API. Caveat: it's one maintainer's personal
 * server, not an official/guaranteed-uptime API — if it's down or changes
 * shape, this safely falls through to IRRUSDT's simulated fallback, same as
 * every other source in this file.
 *
 * Unit safety: Bonbast's own site displays Toman (1 Toman = 10 Rial) but its
 * API has historically returned Rial. Since I can't directly verify the live
 * response shape from this environment, this checks the fetched value against
 * the known plausible free-market Rial-per-USD range and auto-corrects a
 * Toman-scale reading (÷10 too small) using the fixed, well-documented 10:1
 * ratio — rather than trusting either unit blindly. If the value is outside
 * even that corrected range, it's rejected and IRR falls back to simulated;
 * a live-but-wrong-by-10x number would be worse than an honest placeholder.
 */
async function fetchIrrFreeMarket() {
  // This source chains two requests server-side (scrape bon-bast.com's homepage
  // for a token, then call their internal API) before it can even answer us, so
  // it's slower and more failure-prone than a plain JSON API — give it a longer
  // timeout and a browser-like UA (bare/no-UA requests get blocked by a lot of
  // anti-bot setups), plus one
  // retry, before giving up for this poll cycle.
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VertexFXDemo/1.0)', 'Accept': 'application/json' } };
  let { data, error } = await safeFetchJson('https://bonbast.amirhn.com/latest', opts, 12000);
  if (error) {
    console.warn(`[market-data] Bonbast (IRR free-market) attempt 1 failed: ${error} — retrying once`);
    ({ data, error } = await safeFetchJson('https://bonbast.amirhn.com/latest', opts, 12000));
  }
  if (error) { console.warn(`[market-data] Bonbast (IRR free-market) failed: ${error}`); return {}; }
  const usd = data?.usd;
  const sell = parseFloat(usd?.sell);
  const buy = parseFloat(usd?.buy);
  if (!(sell > 0) || !(buy > 0)) {
    console.warn(`[market-data] Bonbast: no usable USD rate — ${JSON.stringify(data).slice(0, 200)}`);
    return {};
  }
  let rialPerUsd = (sell + buy) / 2;

  const PLAUSIBLE_MIN = 1_000_000, PLAUSIBLE_MAX = 4_000_000; // sanity band around the known ~1.86M free-market rate
  if (rialPerUsd < PLAUSIBLE_MIN && rialPerUsd * 10 >= PLAUSIBLE_MIN && rialPerUsd * 10 <= PLAUSIBLE_MAX) {
    rialPerUsd *= 10; // looked Toman-scale — apply the fixed 10:1 Toman→Rial ratio
  }
  if (rialPerUsd < PLAUSIBLE_MIN || rialPerUsd > PLAUSIBLE_MAX) {
    console.warn(`[market-data] Bonbast: USD rate ${rialPerUsd} outside plausible free-market range, rejecting`);
    return {};
  }
  return { IRRUSDT: { price: rialPerUsd, source: 'live-bonbast' } };
}

/** Fetch everything available right now. Returns { SYM: {price, source} }. */
async function fetchAllLivePrices() {
  const [exoticFiat, irr] = await Promise.all([
    fetchExoticFiat().catch((e) => { console.warn('[market-data] exotic fiat fetch threw:', e.message); return {}; }),
    fetchIrrFreeMarket().catch((e) => { console.warn('[market-data] IRR free-market fetch threw:', e.message); return {}; }),
  ]);
  return { ...exoticFiat, ...irr };
}

module.exports = { fetchAllLivePrices, CURRENCYFREAKS_CONFIGURED: !!CURRENCYFREAKS_KEY };
