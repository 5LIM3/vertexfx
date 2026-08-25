# VertexFX (Simulated Trading Platform — Demo/Portfolio Project)

Full-stack broker-style demo: real accounts, real backend, **simulated market and funds**.
Nothing here touches a real market or moves real money.

## Explaining this to judges (plain language)
Two things run side by side:
1. **A live price fetcher** — every 45s, the server asks real public APIs (CoinGecko, Frankfurter,
   Stooq) what BTC, EUR/USD, gold, etc. are actually worth right now, and stores that number.
   This part is 100% real data, no key required.
2. **A simulation engine** — the number your users actually trade against. It copies the real
   price once when it first sees it (so the demo starts realistic), then moves on its own from
   there — either a random walk, or however the admin dashboard steers it (Pump/Dump/Sideways/
   Volatile/Pause). This is intentional: VertexFX isn't a licensed broker, so it can't let people
   place real trades against a real market — it shows the real price for credibility/comparison,
   then lets them practice against a realistic but fully synthetic one.

One-liner: *"VertexFX pulls real live prices from public market-data APIs, then runs its own
trading simulation seeded from those real prices — so it behaves like a real broker end-to-end,
but no real money or real trades are ever involved."*

Where to see it working live: `/instruments.html` shows the real price next to the simulation
price for every instrument; `/admin.html` → Market Status shows the same, plus the controls that
steer the simulation.

## Stack
- **Backend:** Node.js (v22.5+) + Express, built-in `node:sqlite` (no native compilation, no Visual Studio Build Tools needed), JWT auth (httpOnly cookie + Bearer fallback), `ws` for the live price feed
- **Frontend:** Static multi-page site (marketing pages + trading terminal), vanilla JS, canvas candlestick chart
- **Market data:** 100% server-generated random walk (`server/engine.js`) — 15 instruments across forex/metals/crypto/indices

## Run locally
```bash
npm install
cp .env.example .env   # edit JWT_SECRET
npm start
```
Visit `http://localhost:3000`.

**Node version:** this needs Node **22.5 or newer** (you have v24.12, so you're fine) — it uses
the built-in `node:sqlite` module instead of `better-sqlite3`, specifically so nobody has to
fight Visual Studio Build Tools / node-gyp on Windows just to run a demo project. If `npm start`
ever prints an experimental-feature warning about SQLite, that's expected and harmless.

## Project layout
```
server/
  index.js        Express app + WebSocket server + engine tick loop + live-data poller
  db.js           SQLite schema (users, wallets, ledger, positions, verification, symbol controls, announcements)
  engine.js       Server-authoritative price simulation engine + live-data anchoring
  marketData.js   Real market data fetchers (CoinGecko, Frankfurter, optional Twelve Data)
  auth.js         JWT sign/verify + requireAuth/requireAdmin middleware
  mailer.js       Email sending (SMTP if configured, console log fallback for dev)
  twofa.js        TOTP + backup code helpers (otplib/qrcode)
  routes/
    auth.js       signup / login / logout / me / verify-email / resend-verification / 2fa challenge
    twofa.js      2FA setup / enable / disable
    kyc.js        Mock KYC submit / status
    wallet.js     balance / deposit / withdraw / ledger
    trading.js    symbols / candles / positions / open / close / history
    admin.js      users, ledger review, positions, market controls, announcements, KYC queue, health
    public.js     public read-only endpoints (active announcements)
public/
  index.html, about.html, instruments.html   Marketing pages
  login.html, signup.html, verify-email.html Auth + verification pages
  security.html, kyc.html                    2FA setup + mock KYC upload
  wallet.html                                Deposit/withdraw + ledger
  dashboard.html                             Trading terminal (WebSocket-driven)
  admin.html                                 Admin dashboard
scripts/
  make-admin.js   CLI: promote a user to admin role
```

## Real reference price vs. simulation price
Where a live feed exists (crypto via CoinGecko, forex via Frankfurter), the engine keeps two
numbers per symbol:
- **`livePrice`** — the actual real-world price, refreshed every 45s, purely for display/comparison.
  Never touched by the simulation, never used to fill trades.
- **`price`** — the simulation price that candles, the order book, and every trade actually use.
  It bootstraps once from `livePrice` (so the demo starts at a realistic level) and then runs
  fully independently — subsequent real-market moves do **not** drag it back.

Both are shown side by side in the UI (instruments page, dashboard chart header) so it's always
obvious which number a trade would fill at.

## Admin market controls (regimes)
From the admin dashboard's Market Status tab, each symbol's simulation can be biased:
- **Pump** (`bullish`) — steady upward drift
- **Dump** (`bearish`) — steady downward drift
- **Sideways** — tight chop around the price at the moment the regime was set
- **Volatile** — wider random swings, no directional bias
- **Pause** — freezes the price exactly
- **Resume** (`normal`) — back to the default mean-reverting random walk

This only steers the already-simulated number (`server/engine.js` → `setRegime()`/`tick()`) —
it has no effect on the real reference price and no connection to real funds.

## Real market data
Every instrument gets a real starting price by default, no signup required for any of it:
- **Crypto** (SOL) — CoinGecko, no key
- **Metals & indices** (US30/US100/SPX500) — tries Yahoo Finance's public chart endpoint first,
  then Stooq if Yahoo misses. Both free, no key.
- **KWD/SAR/IQD vs USDT** — open.er-api.com (free, no key, no request quota; USDT treated as
  ≈USD like most demo platforms do). Optionally, set `CURRENCYFREAKS_API_KEY` in `.env` to add
  CurrencyFreaks as a fallback for when open.er-api.com is unreachable — it's quota-gated to
  one real call per hour internally so it can't exhaust a free-tier quota the way polling it
  directly every 45s used to.
- **IRR/USDT** — bonbast.amirhn.com free-market rate proxy, no key.

Refreshed every 45s. **If a symbol never connects to any of these, this is not silent** — the
server console prints a `[market-data]` warning naming the exact symbol and source that failed
(e.g. `Stooq failed for XAUUSD: HTTP 403 — trying Yahoo Finance`), and the admin dashboard's
Market Status tab shows a **"✕ NEVER CONNECTED"** badge on any symbol that's never received a
real price, plus an amber badge on anything that hasn't updated in 3+ minutes. Check there
first if a price looks wrong — don't just compare against an outside chart and guess, the app
will tell you directly which symbols are actually live.

If everything shows never-connected, your network/firewall is likely blocking outbound calls to
`api.coingecko.com`, `api.frankfurter.app`, `stooq.com`, `query1.finance.yahoo.com`, and
`api.currencyfreaks.com` — or you're running this in a sandboxed environment with an egress
allowlist. Set `TWELVE_DATA_API_KEY` in `.env` for a more reliable (but rate-limited,
signup-required) alternative for metals/indices specifically.

## UI niceties
- **Scrolling ticker** — the top price strip auto-scrolls continuously, pauses on hover
- **Back button** — every app page (dashboard/wallet/instruments/security/KYC/admin) has a "←"
  icon that goes to browser history if available, otherwise a sensible fallback
- **Transactions shortcut** — nav link on every page jumps straight to the wallet's transaction
  history and highlights it
- **Live-refreshing wallet** — balance and transaction history poll every 1s on the dashboard and
  wallet page, so an admin-approved deposit/withdrawal shows up without the user refreshing.
  Admin's Deposits & Withdrawals tab does the same so new pending items appear automatically.

**Fallback base prices** (`server/engine.js` → `SYMBOL_META`) are last-resort numbers only used
if a symbol has *never once* connected — they're hardcoded and will drift stale over time by
definition. If you're reading this months later and a "never connected" fallback price looks
wrong, that's expected — fix the actual data source (see above), don't just re-guess the number.

## Email verification
Signup sends a verification link before the account can log in. Without SMTP configured, the
email is logged to the server console instead (`[DEV MAIL]` block) so the flow is fully
testable locally. Set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env` to send real emails.

## Two-factor authentication
Real TOTP (Google Authenticator / Authy compatible) via `/security.html`: scan a QR code,
confirm with a 6-digit code, and get 8 one-time backup codes. Once enabled, login requires
the code (`/api/auth/2fa/verify`) after the password step.

## KYC (mocked)
`/kyc.html` collects a document type + file names for ID/selfie/proof-of-address and moves
the account into a `pending` queue — **no files are actually stored or sent anywhere**, and no
real identity-verification vendor is integrated. This exists purely to demonstrate the
status-flow UI a real Sumsub/Persona/Onfido integration would sit behind. Admins approve or
reject submissions from the admin dashboard.

## Admin dashboard
`/admin.html` — promote a user with `npm run make-admin -- you@example.com`, then log back in.
Covers: user list (suspend/promote), deposit & withdrawal review (approve/reject pending
withdrawals — rejecting refunds the reserved amount), all open positions across users, market
status (pause trading per symbol, override leverage), KYC review queue, announcements (shown
as a banner on the homepage), and system health (uptime, connected WS clients, live-vs-simulated
symbol count).

**Important:** deposits/withdrawals remain a mock ledger — the admin dashboard reviews and
approves entries in that ledger, it does not connect to any real payment processor.

## Deposit flow (all still mock — no real payment processor)
- **Card** — real-shaped validation (Luhn check, expiry, CVV format) so bad input actually gets
  rejected like a real card form would, then credits instantly — this mirrors how a real card
  network authorizes in real time. Test card: `4242 4242 4242 4242`, any future expiry, any
  3-digit CVV.
- **Crypto** — shows a clearly-fake demo address (never a real one), requires a screenshot
  "proof of deposit" upload (filename only — nothing is stored or processed), and goes into
  **pending**. Balance is not credited until an admin approves it from
  `/admin.html` → Deposits & Withdrawals. Rejecting leaves the balance untouched.
- **Bank transfer** — shows fake mock account details, credits instantly (unchanged).

## How the simulated market works
`PriceEngine` (server/engine.js) ticks every 1 second: each symbol does a mean-reverting
random walk around its base price. The tick loop updates rolling 1m/5m/15m/1h/4h/1d candles,
regenerates synthetic order-book depth, and occasionally appends a trade-tape entry. This is
the **single source of truth** — the WebSocket feed just broadcasts it, and order execution
(`POST /api/trading/positions`) fills at `engine.getPrice(symbol)` at the moment the request
lands, so the client can never set its own fill price.

## Starting completely fresh
To wipe every user, trade, and wallet and get the site back to a blank first-run state:
```bash
npm run reset-db   # deletes the entire database
npm start           # recreates it empty
```

## Resetting a symbol's simulation
Testing Pump/Dump leaves permanent marks — the simulation never self-corrects against the real
price (that's intentional, see below). To undo it: admin dashboard → Market Status →
**"↺ Reset to Live"** per symbol, or **"↺ Reset All Symbols to Live"** at the top of the tab.
This snaps that symbol's simulation price back to its real reference price (or its original
base price if no live feed exists for it) and **regenerates clean candle history**, so charts
aren't left permanently stretched out from earlier testing.

## Real chart (TradingView)
Click **"📈 Real Chart ↗"** next to the timeframe buttons on any instrument to open a genuine
TradingView Advanced Chart for that symbol — real market data straight from TradingView's own
widget, independent of our Stooq/CoinGecko/Frankfurter fetchers, so it works even for
instruments where our own live-data feed comes up empty. It's reference-only: trades still
always execute against the simulation price, never this chart. Symbol mappings live in
`TV_SYMBOL_MAP` near the top of the chart script in `dashboard.html` — if a provider doesn't
resolve for an instrument, try an alternate one (e.g. swap `CAPITALCOM:US100` for
`PEPPERSTONE:US100`).

## Stop Loss / Take Profit
Set optional SL/TP when opening a trade (toggle "+ Add Stop Loss / Take Profit" in the order
panel), or edit them on an already-open position via the Edit button in the positions table.
- Validated server-side — e.g. a Buy's Stop Loss must be below entry, Take Profit above it
- Checked every engine tick (`server/positionMonitor.js`) against the live simulation price —
  if crossed, the position auto-closes **at the SL/TP price itself**, not whatever the price
  happened to be that tick, same as a real broker fills a stop order
- Shows up in trade history and the ledger tagged `closed by Stop Loss` / `closed by Take Profit`
  so it's distinguishable from a manual close

## Demo vs Real accounts
Every user gets **two separate accounts**, exactly like a real broker (MT4/MT5-style):
- **Demo** — starts with the $10,000 welcome bonus, for practice
- **Real** — starts at **$0**, no bonus, must be funded via deposit before trading

Switch between them with the toggle in the top bar (dashboard) or wallet page — it's stored
per-browser and applied to every wallet/trading API call (`?account=demo|real`). Positions,
balances, and transaction history are completely separate between the two; a real-account
deposit never touches the demo balance and vice versa. The admin dashboard's Users tab shows
both balances side by side, and Positions/Ledger show which account each entry belongs to.

**Both are still 100% simulated** — "Real" only means "no free bonus money, same as a live
account before you've funded it." No real payment processor is connected to either one; this
is labeled throughout the UI so it's never confused with an account holding actual funds.

## Money flow (all mock)
- New accounts start with a `$10,000` simulated balance (`STARTING_BALANCE` in `.env`)
- Deposits/withdrawals write to the `ledger` table — no payment processor is ever contacted
- Opening a position checks free margin (1% of notional); closing one credits/debits P&L
  straight into `wallets.balance` and logs a `trade_pnl` ledger row

## Deploying to Fly.io with your own domain (vertexfx.xyz)

A `Dockerfile`, `.dockerignore`, and `fly.toml` are already included — `fly launch` will use
them automatically. This uses the same `node:sqlite` database as local dev, given a persistent
volume so data survives deploys and restarts.

### 1. Install the Fly CLI and log in
```bash
# macOS
brew install flyctl
# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
# then:
fly auth login   # opens a browser to sign up/log in — free tier is enough for this
```

### 2. Launch the app
From the project folder:
```bash
fly launch --no-deploy
```
It'll detect `fly.toml` and offer to reuse it — say yes. If it asks to overwrite, keep the
`app = "vertexfx"` name or pick your own (must be globally unique on Fly — try
`vertexfx-yourname` if `vertexfx` is taken).

### 3. Create the persistent volume (for your SQLite database)
```bash
fly volumes create vfx_data --region iad --size 1
```
Use the same region you set in `fly.toml` (`primary_region`). 1GB is more than enough for a
demo's worth of users/trades.

### 4. Set secrets (never commit these — they don't go in `.env` in production)
```bash
fly secrets set `
  JWT_SECRET=$(openssl rand -hex 32) `
  STARTING_BALANCE=10000 `
  APP_BASE_URL=https://vertexfx.xyz
```
(On Windows PowerShell, replace the trailing backtick line-continuations above with normal
line breaks, or just put it all on one line.) Add `SMTP_*` secrets too if you want real
verification emails instead of console-logged ones, and `TWELVE_DATA_API_KEY` /
`CURRENCYFREAKS_API_KEY` if you have them.

### 5. Deploy
```bash
fly deploy
```
Fly builds the Docker image, runs it, and gives you a `https://vertexfx.fly.dev` URL —
confirm the app works there first before pointing your domain at it.

### 6. Point your Namecheap domain at Fly
```bash
fly certs add vertexfx.xyz
fly certs add www.vertexfx.xyz
```
Each command prints the DNS records Fly needs. In Namecheap → Domain List → Manage →
Advanced DNS, add:
- An **A record**: host `@`, value = the IPv4 address `fly certs add` gave you
- An **AAAA record**: host `@`, value = the IPv6 address it gave you
- A **CNAME record**: host `www`, value = `vertexfx.fly.dev`

DNS propagation can take a few minutes to a few hours. Check status with:
```bash
fly certs show vertexfx.xyz
```
Once it shows "Certificate issued", `https://vertexfx.xyz` is live with automatic HTTPS —
Fly handles the TLS certificate for you, nothing to configure manually.

### Important: keep the machine always running
The price engine's tick loop lives in memory — if Fly auto-stops the machine during quiet
periods (its default cost-saving behavior), the simulation loses its in-memory state on the
next request and effectively "restarts" the market. `fly.toml` already sets
`auto_stop_machines = false` and `min_machines_running = 1` to prevent this — don't remove
those unless you're okay with the market silently resetting after idle periods.

### Updating after code changes
```bash
fly deploy
```
That's it — your SQLite data survives because it lives on the persistent volume, not in the
container image.

### If you outgrow SQLite
`node:sqlite` is genuinely fine for a demo/portfolio project's traffic level. If you later want
Postgres (e.g. to match TideVault's Supabase setup), swap `server/db.js` for a Postgres client
— the SQL in this project is plain enough to port directly, and Fly has managed Postgres
(`fly postgres create`) if you go that route.

## Security notes for a public demo
- Rate limiting is on: 10 login attempts / 15 min, 8 signups / hour, 15 2FA code attempts /
  15 min, all per IP (`server/routes/auth.js`). Adjust the numbers there if they're too strict/loose.
- Rotate `JWT_SECRET` and never commit `.env`
- Email verification, 2FA, and a mock KYC flow all exist (see sections above) — but there's
  still no real payment processor, real KYC vendor, or real market connection by design
