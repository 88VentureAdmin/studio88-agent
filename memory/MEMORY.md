# Memory — Decisions & Lessons Learned

## Infrastructure Decisions

- Mac Mini (hostname: Agents-Mac-mini.local, IP: 100.83.77.44, user: agentserver) is the primary Jin instance. PM2-managed: jin (agent.js), heartbeat (heartbeat.js), tailscale.
- Render is standby ($7/mo) — TO BE REPLACED by Hetzner. Same code, INSTANCE_ROLE=standby.
- Hetzner CPX31 (~$11/mo, 4 vCPU, 8GB RAM, Ubuntu) — Joe's explicit decision to move cloud to Hetzner.
  - Advantage over Render: full Linux, persistent filesystem, can run Playwright, no container limits, no sleep
  - Steps to deploy: provision → apt install nodejs/npm/git → npm install -g pm2 → clone repo → copy .env → pm2 start
  - Gmail tokens: copy gmail-tokens.json OR set GMAIL_REFRESH_TOKEN env var
  - Once confirmed: delete Render service, cancel Railway ($5/mo)
- Railway was abandoned — builder broken. Subscription still active, needs cancellation.
- Render "suspend" does NOT immediately kill WebSocket — must delete service or rotate App Token.

## Billing — Anthropic API vs Max Subscription (Feb 23)

- Jin's Slack bot (agent.js) ALWAYS uses API credits — unavoidable. API key stays in .env.
- Claude Code sessions (VS Code) route through Joe's $200/mo Max plan — free, no API credits.
- To keep Claude Code off API credits: ANTHROPIC_API_KEY must NOT be set in shell environment (not in ~/.zshrc).
- Joe paused/intends to pause the API key to test if Claude Code routes through Max subscription.
- If the key is paused: Jin Slack bot will stop working. The key in .env must stay active for agent.js.
- Two separate things: shell env (controls Claude Code billing) vs .env file (controls agent.js).

## Memory Architecture — Upgraded Feb 23 2026

- memory/SOUL.md — Jin's static identity and personality
- memory/JOE.md — Joe's profile, preferences, working style
- memory/MEMORY.md — this file. Decisions and lessons learned.
- session-log.txt — ops/build log, loaded as 3000-char tail only
- All 4 files load at startup. !reload refreshes all of them live.
- Proactive heartbeat (30 min, 6am-10pm PST): Gmail + Calendar → Claude → DM Joe only if action needed. HEARTBEAT_OK = silence.

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


## Updated Feb 24, 2026

## Self-Improvement Protocol (Added May 24 2025)

- Jin is to conduct a **quarterly web search** to self-evaluate current memory architecture, tools, and AI agent best practices
- Review what others are doing differently, identify better approaches, and either:
  - Bring recommendations to Joe for approval, OR
  - Apply edits directly if clearly within scope
- First review due: **~May 24 2025** (3 months from directive)
- Rationale: AI tech changes on a months-long cycle — static tooling becomes outdated fast
- This is Joe-directed and standing — no need to re-confirm each quarter

## Railway Deployment — Current Status (Feb 23 2026)

- Active blocker: Nixpacks fails instantly (0 seconds) with no useful error output
- Fix in progress: Replace Nixpacks with a Dockerfile — Railway always prefers Dockerfile if present
- Dockerfile has been pushed to repo but build outcome not yet confirmed
- Variable fix: `ANTRHOPIC_API_KEY` (typo) needs to be deleted and re-added as `ANTHROPIC_API_KEY` — Joe has been instructed but confirmation not received
- `package.json` location on Mac Mini not confirmed — `cat` command returned "No such file or directory" when run from Joe's MacBook (not Mac Mini — different machine)

## Amazon FBA Fee Changes (2026 — Searched Feb 23 2026)

- Average increase: +$0.08/unit
- **Returns Processing Fee** now applies to clothing, footwear, and fashion accessories — direct hit to J.Adams given 35%+ return rate
- FBA Prep & Labeling services ending in the US in 2026
- Low-Price FBA now $0.86 cheaper than standard FBA (up from $0.77)
- Peak season fees ran Oct 15 2025 – Jan 14 2026 (closed)
- Storage fee consolidation: bulky items swing $0.32–$5.72/unit
- Action item: model out per-unit return fee impact on J.Adams P&L — not yet done


## Updated Feb 24, 2026

## Team Assessment Project (initiated ~Feb 2026)

- Joe is evaluating full-time, computer-based team members for AI-era fit using Kolbe A + CliftonStrengths Top 5 + a custom AI literacy self-assessment Jin will build
- Criteria for inclusion: full-time, computer-based, AI-displaceable — excludes warehouse (physical labor), part-time contractors, and anyone whose fate is contingent on another person's outcome
- Total cost: ~$693 for 9 people ($495 Kolbe A + $198 CliftonStrengths Top 5)
- Jin will read all assessment results + cross-reference against minimum org structure + Joe's gut-read on each person to produce a diagnostic recommendation on role fit, mismatches, and sequencing

## Final Assessment Cohort (9 people)

1. Jessica Ko
2. Jessica Vuong
3. Jeffrey (Philippines — Walmart/Temu AM)
4. Anne / Princess (CS)
5. Kathrine Gilmer (Creative Director)
6. Steven Gee (Video/Photo)
7. Tracy Wang (Logistics/Supply Chain)
8. Emma Chang (Forecasting)
9. Joy Zhou (Marketplace — Amazon)

**Excluded and why:**
- Abdullah — not full-time
- Sultan — replaced by Jeffrey Philippines
- Celeste + Kitty — fate tied to Joy Zhou; if Joy goes, they go
- Cindy + Jose — warehouse/physical labor
- Richelle — part-time
- Jeffrey Gilmer — part-time contractor

**Note:** Celeste and Kitty are both linked to the marketplace/Joy Zhou cluster — if Joy doesn't work out, both would be laid off alongside her.

---
