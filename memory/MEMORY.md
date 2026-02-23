# Memory — Decisions & Lessons Learned

## Infrastructure Decisions

- Mac Mini (hostname: Agents-Mac-mini.local, IP: 100.83.77.44, user: agentserver) is the primary Jin instance. PM2-managed: jin (agent.js), heartbeat (heartbeat.js), tailscale.
- Render is standby ($7/mo). Same code, INSTANCE_ROLE=standby. Waits 30min heartbeat staleness before responding to prevent duplicates.
- Railway was abandoned — builder broken, us-west1 loop. Still has $5/mo subscription that needs to be cancelled.
- Render "suspend" does NOT immediately kill WebSocket — must delete service or rotate App Token to fully disconnect.

## API Key Protocol

- 401 errors from Anthropic = check billing FIRST. Same error for invalid key AND exhausted credits.
- PM2 caches env vars — `pm2 restart --update-env` does NOT reload .env (dotenv won't override existing PM2 env).
- To force fresh key: `pm2 delete jin && pm2 start agent.js --name jin --cwd /path && pm2 save`

## Memory Architecture

- memory/SOUL.md — Jin's static identity (never changes)
- memory/JOE.md — Joe's profile and preferences (update when Joe's context changes significantly)
- memory/MEMORY.md — this file. Decisions, lessons, strategic shifts. Updated by heartbeat.
- session-log.txt — build history and ops log. Loaded as tail at startup.

## Google Integrations

- Drive: service account (service-account.json) for read-only + OAuth (gmail-tokens.json) for read-write
- Gmail + Calendar: OAuth, scopes include read/send/modify + Calendar + Drive
- Sheets: reads any sheet Joe can access via OAuth
- Drive memory files: Live Log (1-USb_amWwvosnaY6WYc5EbVLluuxtVsP0520qaJrBfs), Weekly Digest (1Bsh1QYXnPxOiFeoHV2TiAebqakZ7pdLsX0ABLGwXkhw), Master Context (12p6EOCuj43J1O1hTGIPZZt7lwsabRIb8XXO1z5X2jpE)

## Slack Behavior

- Never thread in 1:1 DMs — always reply inline in the main conversation
- Thread in channels only for branching discussions, narrow-interest topics, or high-volume channels
- Thinking indicator: post "on it..." immediately, edit to real response when ready
- Joe's DM channel: D0AG94XK2NS

## Bonsai Heirloom Financial Model (from live sheet, Feb 23 2026)

- Fixed costs ~$31.2K/month regardless of drops
- Off-drop months: ~$1.5K revenue = ~$29K monthly burn hole
- Good drop month (200 trees × $295): ~$59K gross, ~$13K net after COGS + expenses
- COGS split roughly 50/50 product cost and freight — shipping alone is 13.5% of revenue at 200 trees
- Video editing alone is $4,500/month — single biggest content line item ($54K/year)
- Two dead months wipe one good drop month — model fragile without drop frequency increase
- Core question: is YouTube content spend justified pre-profitability?

## Build History Highlights

- Phase 1–6 complete as of Feb 22 2026 — see session-log.txt for full detail
- Gmail + Calendar OAuth confirmed working on both Mac Mini and Render (Feb 22)
- Dual-instance coordination confirmed working — no duplicate responses (Feb 23)
- Per-instance system prompt tells Jin which instance it's on and what tools it has

## Lessons Learned

- Render needs Gmail OAuth as env vars (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN), not a tokens file
- Service accounts cannot own files in Google Drive (no storage quota) — use OAuth client for file creation
- ANTHROPIC_API_KEY must be trimmed of whitespace — Render sometimes adds trailing newlines to env vars
