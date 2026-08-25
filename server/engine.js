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
  { sym: 'SOLUSD', cat: 'crypto',  digits: 2, base: 148.5, vol: 0.9,      contract: 1 },
  { sym: 'US30',   cat: 'indices', digits: 1, base: 44500.0, vol: 9.5,    contract: 1 },
  { sym: 'US100',  cat: 'indices', digits: 1, base: 21500.0, vol: 7.0,    contract: 1 },
  { sym: 'SPX500', cat: 'indices', digits: 1, base: 6300.0, vol: 2.8,     contract: 1 },
  // KWD (Kuwaiti Dinar) quoted against USDT — real fiat rate sourced from
  // open.er-api.com (USD/KWD), treating USDT ≈ USD 1:1 as most demo platforms do.
  { sym: 'KWDUSDT', cat: 'forex', digits: 5, base: 3.2500, vol: 0.00035, contract: 100000 },
  // SAR (Saudi Riyal) — hard-pegged by the Saudi central bank at 3.75 per USD;
  // real rate sourced from open.er-api.com. Extremely low volatility by design (peg).
  { sym: 'SARUSDT', cat: 'forex', digits: 5, base: 0.26667, vol: 0.00003, contract: 100000 },
  // IQD (Iraqi Dinar) — managed/quasi-pegged near 1,310 per USD; real rate sourced
  // from open.er-api.com. Quoted the same way as KWD/SAR (USDT value of 1 IQD).
  { sym: 'IQDUSDT', cat: 'forex', digits: 6, base: 0.000763, vol: 0.0000003, contract: 100000 },
  // IRR (Iranian Rial) — quoted here as "Rials per 1 USDT" (not the usual
  // "USDT per unit" convention) because 1 IRR is worth ~$0.0000005: showing that
  // directly would be unreadable. This inverted convention matches how every real
  // source (and every Iranian exchange) actually quotes it. Uses the free-market/
  // street rate (~1.86M), not Iran's official sanctions-era peg (~42,000), since
  // the free-market rate is the one anyone can actually transact at.
  { sym: 'IRRUSDT', cat: 'forex', digits: 0, base: 1865000, vol: 1500, contract: 100000 / 1865000 },
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

  /**
   * Generates every timeframe's candle backfill around a given anchor price
   * (bar count per timeframe now varies — see SEED_BAR_COUNT below).
   *
   * The old version only generated 300 *1-minute* bars and derived every coarser
   * timeframe by aggregating that same short window — which meant 1h only had ~5
   * candles and 1d had ZERO, so the chart auto-stretched the handful of bars it did
   * have to fill the pane (the giant-rectangle look). It also had no mean reversion,
   * so a plain 300-step random walk could drift double digits % from the real price.
   *
   * Fix: seed each timeframe independently with its own ~300-bar, mean-reverting
   * walk anchored at the real price, so 1h/4h/1d each actually have a realistic
   * amount of history and none of them can run away from the real reference price.
   */
  /** How many bars of history to seed per timeframe. NOT a flat 300 for every
   * timeframe on purpose — a flat count means the chart's default view spans a
   * wildly different amount of REAL time per timeframe (300 bars is 5h on the
   * 1m chart, but 300 DAYS on the 1d chart). Since the browser's chart.timeScale()
   * .fitContent() zooms out to fit whatever we hand it, a huge span meant a
   * single tick's few-cent wiggle in the live bar was a sub-pixel change on
   * that axis — genuinely invisible, not a data bug, but it read as "the chart
   * isn't moving" on anything above 5m. These counts keep every timeframe's
   * default view within a few days to a few weeks (a normal "recent history"
   * window for any real trading UI), so live ticks stay visible everywhere.
   */
  static SEED_BAR_COUNT = { '1m': 300, '5m': 300, '15m': 150, '1h': 72, '4h': 42, '1d': 30 };

  _seedSymbolHistory(sym, anchorPrice) {
    const s = this.symbols[sym];
    if (!s) return;
    const now = Date.now();
    for (const tf of Object.keys(TF_SECONDS)) {
      s.candles[tf] = this._genSeedSeries(anchorPrice, s.meta.cat, TF_SECONDS[tf] * 1000, now, PriceEngine.SEED_BAR_COUNT[tf]);
    }
    const m1 = s.candles['1m'];
    s.price = m1[m1.length - 1].c; // live price picks up right where the most granular seed left off
    const dayBars = s.candles['1d'];
    s.prevDayPrice = dayBars.length > 1 ? dayBars[dayBars.length - 2].c : anchorPrice;
  }

  /** Typical total spread (≈3 standard deviations) the seeded history wanders from
   * the real anchor price, by asset class — this is what keeps a 300-bar daily view
   * from drifting to an absurd "24h change" purely from compounding random walk. */
  static SEED_SWING = { forex: 0.015, metals: 0.035, crypto: 0.12, indices: 0.03 };

  /**
   * ~300 bars of `bucketMs`-long candles, generated as an exact discretization of an
   * Ornstein-Uhlenbeck (mean-reverting) process around `anchorPrice`. Unlike a fixed
   * per-step reversion factor, this stays numerically stable and well-behaved no
   * matter how big the bucket is (1 minute or 1 day) — no hard clamping/pinning
   * needed, so bars never get stuck flat against a ceiling.
   */
  _genSeedSeries(anchorPrice, cat, bucketMs, now, count = 300) {
    const bars = [];
    const stdTarget = anchorPrice * (PriceEngine.SEED_SWING[cat] ?? 0.03) / 3; // ~3-sigma ≈ the category's typical swing
    const halfLifeSec = 12 * 3600; // reversion half-life: history "forgets" a deviation over ~12h, any timeframe
    const theta = Math.LN2 / halfLifeSec;
    const dtSec = bucketMs / 1000;
    const decay = Math.exp(-theta * dtSec);
    const stepStd = stdTarget * Math.sqrt(1 - decay * decay); // exact OU step variance, no manual time-scaling needed
    let p = anchorPrice;
    for (let i = count; i >= 0; i--) {
      const t = now - i * bucketMs;
      const o = p;
      const c = anchorPrice + (o - anchorPrice) * decay + gauss() * stepStd;
      const drift = c - o;
      const h = o + Math.abs(drift) * (0.6 + Math.random() * 0.8);
      const l = o - Math.abs(drift) * (0.6 + Math.random() * 0.8);
      p = c;
      // Tick-volume proxy: same per-second synthetic-trade draw the live tick() loop
      // uses, summed across the bar. For long buckets (4h/1d) we sample a capped
      // number of "seconds" and scale up, instead of literally looping 86,400+ times.
      const steps = Math.max(1, Math.round(dtSec));
      const sampleSteps = Math.min(steps, 300);
      let v = 0;
      for (let k = 0; k < sampleSteps; k++) { if (Math.random() < 0.35) v += Math.random() * 2 + 0.01; }
      v *= steps / sampleSteps;
      bars.push({ t, o, h: Math.max(o, h, c), l: Math.min(o, l, c), c, v: +v.toFixed(2) });
    }
    return bars;
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
        case 'bullish': // "Pump" — steady upward drift plus a little noise
          next = s.price + m.vol * (0.16 + Math.random() * 0.14) + gauss() * m.vol * 0.05;
          break;
        case 'bearish': // "Dump" — steady downward drift plus a little noise
          next = s.price - m.vol * (0.16 + Math.random() * 0.14) + gauss() * m.vol * 0.05;
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

      // Occasionally draw a synthetic trade-tape print for this tick. The same
      // draw doubles as this tick's tick-volume contribution to whichever candle
      // (every timeframe) is currently forming — single source, no separate/fake
      // "exchange volume" invented for the chart.
      let tickVol = 0;
      if (Math.random() < 0.35) {
        tickVol = +(Math.random() * 2 + 0.01).toFixed(2);
        this.tradeTape.unshift({
          t: now, sym, side: Math.random() < 0.5 ? 'buy' : 'sell',
          vol: tickVol, price: next,
        });
        if (this.tradeTape.length > 200) this.tradeTape.pop();
      }

      // update rolling 1m candle
      const bucketStart = Math.floor(now / 60000) * 60000;
      const bars = s.candles['1m'];
      const last = bars[bars.length - 1];
      if (last && last.t === bucketStart) {
        last.h = Math.max(last.h, next);
        last.l = Math.min(last.l, next);
        last.c = next;
        last.v = +((last.v || 0) + tickVol).toFixed(2);
      } else {
        bars.push({ t: bucketStart, o: next, h: next, l: next, c: next, v: tickVol });
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
          lastC.v = +((lastC.v || 0) + tickVol).toFixed(2);
        } else {
          arr.push({ t: bStart, o: next, h: next, l: next, c: next, v: tickVol });
          if (arr.length > 1000) arr.shift();
        }
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
