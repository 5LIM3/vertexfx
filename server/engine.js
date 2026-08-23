/**
 * VertexFX Simulated Market Engine
 * ---------------------------------
 * 100% synthetic. No connection to any real market data.
 * This is the SINGLE source of truth for prices — the server ticks it on
 * an interval, and every client (chart, order book, trade execution,
 * order fills) reads from this same engine so everything stays in sync.
 */

// `base` values below are LAST-RESORT fallbacks only — used if every live source
// (CoinGecko/Frankfurter/Stooq/Yahoo/Twelve Data) fails for that symbol. They will
// go stale over time by design; the real fix for a stale number is checking the
// server console for [market-data] warnings, not re-guessing these periodically.
// `contract` = units represented by "1 lot" — pnl = priceDelta * volumeLots * contract
const SYMBOL_META = [
  { sym: 'EURUSD', cat: 'forex',   digits: 5, base: 1.0850, vol: 0.00018, contract: 100000 },
  { sym: 'GBPUSD', cat: 'forex',   digits: 5, base: 1.2680, vol: 0.00022, contract: 100000 },
  { sym: 'USDJPY', cat: 'forex',   digits: 3, base: 149.20, vol: 0.020,   contract: 100000 / 149.20 },
  { sym: 'AUDUSD', cat: 'forex',   digits: 5, base: 0.6520, vol: 0.00016, contract: 100000 },
  { sym: 'USDCAD', cat: 'forex',   digits: 5, base: 1.3610, vol: 0.00015, contract: 100000 / 1.3610 },
  { sym: 'USDCHF', cat: 'forex',   digits: 5, base: 0.8820, vol: 0.00014, contract: 100000 / 0.8820 },
  { sym: 'XAUUSD', cat: 'metals',  digits: 2, base: 4305.00, vol: 1.00,   contract: 100 },
  { sym: 'XAGUSD', cat: 'metals',  digits: 3, base: 48.500, vol: 0.06,    contract: 5000 },
  { sym: 'BTCUSD', cat: 'crypto',  digits: 1, base: 63500.0, vol: 42,     contract: 1 },
  { sym: 'ETHUSD', cat: 'crypto',  digits: 2, base: 3420.0, vol: 5.5,     contract: 1 },
  { sym: 'SOLUSD', cat: 'crypto',  digits: 2, base: 148.5, vol: 0.9,      contract: 1 },
  { sym: 'US30',   cat: 'indices', digits: 1, base: 44500.0, vol: 9.5,    contract: 1 },
  { sym: 'US100',  cat: 'indices', digits: 1, base: 21500.0, vol: 7.0,    contract: 1 },
  { sym: 'SPX500', cat: 'indices', digits: 1, base: 6300.0, vol: 2.8,     contract: 1 },
  // KWD (Kuwaiti Dinar) quoted against USDT — real fiat rate sourced from
  // CurrencyFreaks (USD/KWD), treating USDT ≈ USD 1:1 as most demo platforms do.
  { sym: 'KWDUSDT', cat: 'forex', digits: 5, base: 3.2500, vol: 0.00035, contract: 100000 },
];

const TF_SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

function gauss() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

class PriceEngine {
  constructor() {
    this.symbols = {};
    this.tradeTape = [];
    this.startedAt = Date.now();

    for (const m of SYMBOL_META) {
      this.symbols[m.sym] = {
        meta: m,
        price: m.base,           // the SIMULATION price — this is what trades execute against
        livePrice: null,         // real reference price, read-only, display-only, never traded against
        prevDayPrice: m.base,
        ticks: [{ t: Date.now(), p: m.base }],
        candles: {},
        depth: this._genDepth(m.base, m.digits),
        source: 'simulated',     // where the livePrice reference (if any) came from
        lastLiveUpdate: null,
        hasBootstrapped: false,  // whether the sim has done its one-time sync to the real price
        regime: 'normal',        // normal | bullish | bearish | sideways | volatile | paused
        regimeAnchor: m.base,    // reference level the current regime measures drift/reversion from
        regimeSetAt: null,
      };
      for (const tf of Object.keys(TF_SECONDS)) this.symbols[m.sym].candles[tf] = [];
    }
    this._seedHistory();
  }

  /**
   * Called by the live-data poller (server/marketData.js) when a real price is fetched.
   * This ONLY updates the read-only reference price shown to users for comparison.
   * The simulation price is bootstrapped from it exactly once (so the demo starts at a
   * realistic level) and then runs fully independently — the whole point of the engine
   * is that admins can freely steer it (pump/dump/sideways/volatile) without the real
   * market dragging it back.
   */
  applyLiveAnchor(sym, price, source) {
    const s = this.symbols[sym];
    if (!s || !price || !isFinite(price)) return;
    s.livePrice = price;
    s.source = source;
    s.lastLiveUpdate = Date.now();
    if (!s.hasBootstrapped) {
      s.price = price;
      s.meta.base = price;
      s.regimeAnchor = price;
      s.hasBootstrapped = true;
    }
  }

  /** Admin control: bias how the simulation moves. Does not touch the real reference price. */
  setRegime(sym, regime) {
    const valid = ['normal', 'bullish', 'bearish', 'sideways', 'volatile', 'paused'];
    const s = this.symbols[sym];
    if (!s || !valid.includes(regime)) return false;
    s.regime = regime;
    s.regimeAnchor = s.price;
    s.regimeSetAt = Date.now();
    return true;
  }

  /**
   * Admin control: undo pump/dump/whatever testing did to a symbol's simulation.
   * Snaps the simulation price back to the real reference price (if one has been
   * fetched) — or its original base price otherwise — and regenerates clean candle
   * history around that level so the chart isn't permanently stretched by old
   * extreme moves. Also clears any active regime back to normal.
   */
  resetSimulation(sym) {
    const s = this.symbols[sym];
    if (!s) return false;
    const anchor = s.livePrice != null ? s.livePrice : s.meta.base;
    s.meta.base = anchor;
    this._seedSymbolHistory(sym, anchor);
    s.regime = 'normal';
    s.regimeAnchor = anchor;
    s.regimeSetAt = Date.now();
    s.depth = this._genDepth(anchor, s.meta.digits);
    return true;
  }

  _genDepth(mid, digits) {
    const bids = [], asks = [];
    const step = mid * 0.00015 || 0.01;
    for (let i = 1; i <= 12; i++) {
      bids.push({ price: +(mid - step * i).toFixed(digits), size: +(Math.random() * 8 + 0.5).toFixed(2) });
      asks.push({ price: +(mid + step * i).toFixed(digits), size: +(Math.random() * 8 + 0.5).toFixed(2) });
    }
    return { bids, asks };
  }

  _seedHistory() {
    // Backfill ~300 1-minute candles per symbol so charts aren't empty on first load
    for (const sym of Object.keys(this.symbols)) {
      this._seedSymbolHistory(sym, this.symbols[sym].meta.base);
    }
  }

  /** (Re)generates ~300 1-minute candles (and coarser timeframes) around a given anchor price. */
  _seedSymbolHistory(sym, anchorPrice) {
    const s = this.symbols[sym];
    if (!s) return;
    const now = Date.now();
    let p = anchorPrice;
    const bars = [];
    for (let i = 300; i >= 0; i--) {
      const t = now - i * 60000;
      const o = p;
      const drift = gauss() * s.meta.vol * 0.6;
      const h = o + Math.abs(drift) * (0.6 + Math.random() * 0.8);
      const l = o - Math.abs(drift) * (0.6 + Math.random() * 0.8);
      const c = o + drift;
      p = c;
      bars.push({ t, o, h: Math.max(o, h, c), l: Math.min(o, l, c), c });
    }
    s.candles['1m'] = bars;
    s.price = p;
    s.prevDayPrice = bars[Math.max(0, bars.length - 1440)]?.o ?? bars[0].o;
    for (const tf of Object.keys(TF_SECONDS)) {
      if (tf === '1m') continue;
      s.candles[tf] = this._aggregate(bars, TF_SECONDS[tf] / 60);
    }
  }

  _aggregate(oneMinBars, bucketMinutes) {
    const out = [];
    for (let i = 0; i < oneMinBars.length; i += bucketMinutes) {
      const chunk = oneMinBars.slice(i, i + bucketMinutes);
      if (!chunk.length) continue;
      out.push({
        t: chunk[0].t,
        o: chunk[0].o,
        h: Math.max(...chunk.map(b => b.h)),
        l: Math.min(...chunk.map(b => b.l)),
        c: chunk[chunk.length - 1].c,
      });
    }
    return out;
  }

  /** Advance every symbol's simulation price by one step, shaped by its current regime. */
  tick() {
    const now = Date.now();
    for (const sym of Object.keys(this.symbols)) {
      const s = this.symbols[sym];
      const m = s.meta;

      let next = s.price;
      switch (s.regime) {
        case 'paused':
          next = s.price; // frozen — admin explicitly halted movement
          break;
        case 'bullish': // "Pump" — trends up over time, but each tick has real back-and-forth (like a real chart)
          next = s.price + m.vol * 0.07 + gauss() * m.vol * 0.4;
          break;
        case 'bearish': // "Dump" — trends down over time, but each tick has real back-and-forth (like a real chart)
          next = s.price - m.vol * 0.07 + gauss() * m.vol * 0.4;
          break;
        case 'volatile': // wide random swings, no directional bias
          next = s.price + gauss() * m.vol * 0.4;
          break;
        case 'sideways': { // tight chop around wherever price was when this regime was set
          const revert = (s.regimeAnchor - s.price) * 0.05;
          next = s.price + revert + gauss() * m.vol * 0.03;
          break;
        }
        case 'normal':
        default: {
          const meanRevert = (m.base - s.price) * 0.0006;
          const shock = gauss() * m.vol * 0.12;
          next = s.price + meanRevert + shock;
        }
      }
      if (next <= 0) next = s.price;
      s.price = next;

      s.ticks.push({ t: now, p: next });
      if (s.ticks.length > 2000) s.ticks.shift();

      // update depth around new mid
      s.depth = this._genDepth(next, m.digits);

      // update rolling 1m candle
      const bucketStart = Math.floor(now / 60000) * 60000;
      const bars = s.candles['1m'];
      const last = bars[bars.length - 1];
      if (last && last.t === bucketStart) {
        last.h = Math.max(last.h, next);
        last.l = Math.min(last.l, next);
        last.c = next;
      } else {
        bars.push({ t: bucketStart, o: next, h: next, l: next, c: next });
        if (bars.length > 2000) bars.shift();
      }
      // roll up coarser timeframes off the same tick
      for (const tf of Object.keys(TF_SECONDS)) {
        if (tf === '1m') continue;
        const bucketMs = TF_SECONDS[tf] * 1000;
        const bStart = Math.floor(now / bucketMs) * bucketMs;
        const arr = s.candles[tf];
        const lastC = arr[arr.length - 1];
        if (lastC && lastC.t === bStart) {
          lastC.h = Math.max(lastC.h, next);
          lastC.l = Math.min(lastC.l, next);
          lastC.c = next;
        } else {
          arr.push({ t: bStart, o: next, h: next, l: next, c: next });
          if (arr.length > 1000) arr.shift();
        }
      }

      // occasionally emit a synthetic trade tape entry
      if (Math.random() < 0.35) {
        this.tradeTape.unshift({
          t: now, sym, side: Math.random() < 0.5 ? 'buy' : 'sell',
          vol: +(Math.random() * 2 + 0.01).toFixed(2), price: next,
        });
        if (this.tradeTape.length > 200) this.tradeTape.pop();
      }
    }
  }

  getPrice(sym) {
    const s = this.symbols[sym];
    return s ? s.price : null;
  }

  chgPct(sym) {
    const s = this.symbols[sym];
    if (!s) return 0;
    return ((s.price - s.prevDayPrice) / s.prevDayPrice) * 100;
  }

  sentiment(sym) {
    const recent = this.tradeTape.filter(t => t.sym === sym).slice(0, 40);
    if (!recent.length) return 50;
    const buys = recent.filter(t => t.side === 'buy').length;
    return (buys / recent.length) * 100;
  }

  snapshot() {
    const out = {};
    for (const sym of Object.keys(this.symbols)) {
      const s = this.symbols[sym];
      out[sym] = {
        price: s.price,
        livePrice: s.livePrice,
        digits: s.meta.digits,
        cat: s.meta.cat,
        chgPct: this.chgPct(sym),
        depth: s.depth,
        source: s.source,
        regime: s.regime,
      };
    }
    return out;
  }

  candles(sym, tf) {
    const s = this.symbols[sym];
    if (!s) return [];
    return s.candles[tf] || s.candles['1m'];
  }

  meta() {
    return SYMBOL_META;
  }
}

module.exports = { PriceEngine, SYMBOL_META, TF_SECONDS };
