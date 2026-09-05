# VertexFX

A simulated multi-asset trading broker platform built to replicate real trading platform mechanics — order execution, live pricing, and portfolio tracking — without real financial risk.

🔗 Live: [vertexfx.xyz](https://vertexfx.xyz)

## What it does

VertexFX gives users a realistic multi-asset trading experience across a 15-symbol market engine, with live WebSocket price streaming and admin-controlled market conditions. Built to explore the backend architecture challenges of real trading systems: real-time data feeds, secure authentication, and transactional integrity.

## Features

- 15-symbol simulated market engine with admin controls
- Real-time price streaming via WebSockets
- JWT authentication with 2FA
- Order execution and portfolio tracking

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** SQLite
- **Real-time:** WebSockets
- **Auth:** JWT + 2FA
- **Deployment:** Fly.io, with CI/CD via GitHub Actions

## Setup

\`\`\`bash
git clone https://github.com/5LIM3/vertexfx.git
cd vertexfx
npm install
cp .env.example .env   # configure your environment variables
npm run dev
\`\`\`

## Author

Built by [Alozie Anyatonwu](https://slimestackdevs.com) — Full Stack Developer & Cybersecurity Analyst.
