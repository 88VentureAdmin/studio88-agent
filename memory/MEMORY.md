# Memory — Decisions & Lessons Learned

Last consolidated: February 25, 2026

---

## Infrastructure

- **Mac Mini M4 16GB** (Agents-Mac-mini.local, 100.83.77.44, user: agentserver) — primary Jin instance
- **Hetzner CPX31** (~$11/mo, 4 vCPU, 8GB) — cloud standby, INSTANCE_ROLE=standby
  - Deploy: provision → apt install nodejs/npm/git → npm install -g pm2 → clone repo → copy .env → pm2 start
  - Gmail tokens: copy gmail-tokens.json OR set GMAIL_REFRESH_TOKEN env var
- **Railway** — abandoned (builder broken). Subscription still active, needs cancellation.
- **Render** — confirmed live as cloud deployment, but secondary to Mac Mini. Crash-prone when Gmail tokens missing.
- **PM2** manages Jin — always use `pm2 restart jin` (never manual kill/nohup)
  - PM2 caches env vars — `pm2 restart --update-env` does NOT reload .env (dotenv won't override existing PM2 env)
  - To force fresh env: `pm2 delete jin && pm2 start agent.js --name jin --cwd /path && pm2 save`

## Billing — API vs Max Subscription

- Jin Slack bot (agent.js) ALWAYS uses API credits — API key must stay active in .env
- Claude Code sessions route through Joe's $200/mo Max plan — free, no API credits
- ANTHROPIC_API_KEY must NOT be in shell environment (~/.zshrc) — only in .env — to keep Claude Code on Max plan
- 401 from Anthropic = check billing FIRST. Same error for invalid key AND exhausted credits.

## Memory Architecture

- `memory/SOUL.md` — Jin's static identity (never changes)
- `memory/JOE.md` — Joe's profile and preferences (update when patterns shift)
- `memory/MEMORY.md` — this file. Decisions, lessons, strategic context.
- `memory/CULTURE.md` — 88 Venture operating principles
- `session-log.txt` — ops/build log, loaded as 3000-char tail at startup
- All files load at startup. `!reload` refreshes live without restart.
- **Drive backups**: All four memory files synced to Drive (AI Hub folder `125EAuI55RG3Os59rUeuIAkbv47To4s70`)
- **Drive memory tiers**: Live Log → Weekly Digest (`!digest`) → Quarterly Archive (`!archive`)
- Proactive heartbeat (30 min, 6am-10pm PST): Gmail + Calendar → DM Joe only if action needed

## Google Integrations — All Confirmed Working

- **Jin OAuth** (jin@studio-88.com): Gmail read/send/modify, Calendar, Drive, Sheets, Forms (body + responses)
  - Tokens at `jin-gmail-tokens.json`; Joe's backed up at `joe-gmail-tokens.json`
  - joe@studio-88.com NOT connected — would need separate OAuth setup (~10 min on Mac Mini); Joe declined
- **Drive**: Service account (service-account.json) for read-only + OAuth for read-write
  - Service accounts cannot own files (no storage quota) — use OAuth for file creation
- **Drive file IDs**: Live Log (1-USb_amWwvosnaY6WYc5EbVLluuxtVsP0520qaJrBfs), Weekly Digest (1Bsh1QYXnPxOiFeoHV2TiAebqakZ7pdLsX0ABLGwXkhw), Master Context (12p6EOCuj43J1O1hTGIPZZt7lwsabRIb8XXO1z5X2jpE)

## Slack Behavior

- Never thread in 1:1 DMs — always reply inline
- Thread in channels only for branching/narrow-interest topics
- Thinking indicator: post "on it..." immediately, edit to real response when ready
- Joe's DM channel: D0AG94XK2NS
- **Delete protocol**: Execute deletions immediately, no clarifying question, one-word ack at most
- Joe's "delayed" messages are a real mobile send-queue issue — don't treat re-sends as new instructions

## Capabilities — Canonical List (Joe Verified)

- **Communication**: Read/send Gmail (jin@studio-88.com), Slack messages, reply to threads, set reminders
- **Research**: Web search (Brave MCP), browse live sites (Playwright MCP), screenshots, YouTube transcripts (yt-dlp), PDF reading
- **Data & Docs**: Read/write Google Sheets, Docs, Drive; create files/folders; read/create calendar events
- **Automation**: Trigger webhooks (Zapier, Make, n8n), HTTP requests to any API, Mac Mini shell commands, multi-step browser sessions
- **AI Tasks**: Generate images, transcribe audio/video, summarize/draft/analyze content
- **Memory**: Knowledge vault (Obsidian), Drive logging, long-term memory updates
- **Financial**: 10 QBO tools (P&L, balance sheet, cash flow, invoices, bills, accounts, transactions, customers, vendors)

## Hard Limits

- **Instagram browser automation** on client accounts (J.Adams) — blocked due to headless detection, CAPTCHA, account suspension risk. Influencer *research* (no login) is safe. Actual engagement = human (Jess V.). Joe tested this boundary 5+ times and never pushed back on Jin's refusal — holding firm is correct.
- **Calendar citations**: Only cite conflicts from live calendar pull with Joe's email on the invite. Never surface memory-sourced calendar data as verified.
- **Capability disclaimers**: Before disclaiming any capability, cross-reference memory and history. Joe's patience for false disclaimers is low — it reads as incompetence. If it's been done before, don't claim it can't be done.

## QBO — Live on Production

- 3 companies connected: 88 Venture Studio (193514573802524), SB Foods LLC (9130350222295706), Bonsai Heirloom LLC (9130355256624706)
- Auto token refresh built in
- Connect page: https://agents-mac-mini.tail8173ed.ts.net/qbo/connect
- Still to add: J.Adams (pending), SFD (eventually)
- Compliance pages live: /privacy, /terms

## MCP — Live

- Brave Search (6 tools) + Playwright (22 tools) connected via @modelcontextprotocol/sdk
- Servers run as stdio subprocesses via StdioClientTransport (npx)
- Google Workspace, Slack, QBO, OpenAI kept as custom tools (auth/integration reasons)
- **Decision locked**: Don't migrate existing 45 custom tools to MCP. Build new tools as MCP from start when 3+ agents exist.

## Usage Tracking — Live

- Every API call logs to usage-log.json (model, tokens, cost, user, context category)
- Pricing: Sonnet 4.6 ($3/M in, $15/M out), Haiku 4.5 ($0.80/M in, $4/M out), cache pricing included
- `!usage [days]` command — default 7 days, supports custom range
- Weekly spend report cron: Monday 9AM PST, auto-posts to Joe's DM
- **Haiku fallback**: When Sonnet exhausts 3 retries on overload → auto-falls to Haiku with user notification

## Bonsai Heirloom — Financial Model

- Sheet: `18cMgv-LuQMCq1NUztMQiq56HYErziDDK90e5v3ebKNI`
- Fixed costs ~$31K/mo regardless of drops (Contract labor $19.5K + Social/content $10.5K + General ~$1.2K)
- Drop month (200 trees @ $295): ~$59K gross, ~$13K net after COGS + expenses
- Off-drop month: ~$1.5K revenue = ~$29K burn
- Two dead months wipe one good drop month — model only works with drops every other month minimum
- Video editing $4,500/mo ($54K/yr) flagged as disproportionate — core question: is YouTube spend justified pre-profitability?
- COGS ~50/50 product cost and freight; shipping alone 13.5% of revenue at 200 trees

## Cash Flow Sheet — Deferred

- Sheet: `1vlrckofllK3hZ6friAk9jW7tpaTqwgLR8syYXOdhjCQ`
- Summary: Revenue $135K actual vs $212.5K goal (~63%); Expenses $144.9K; net ~-$10K
- Largest gaps: JA Amazon (-$26K), Pediped (-$20K), SHEIN (-$9K)
- Debt service: ~$21.7K/mo (Lendistry + Intuit + Amex + Chase LOC + CC interest)
- Joe explicitly tabled analysis — revisit when he's ready

## Amazon FBA Fee Changes (2026)

- Average increase: +$0.08/unit
- Returns Processing Fee now applies to clothing/footwear/fashion — direct hit to J.Adams (35%+ return rate)
- FBA Prep & Labeling services ending in US in 2026
- Action item: model per-unit return fee impact on J.Adams P&L — not yet done

## Workforce Evaluation — Complete

- Full doc: `/Users/agentserver/studio88-agent/workforce-evaluation.md`
- 19 scorecards, dept rollups, phased implementation
- Classifications: 2 Protect (Tracy, Kathrine), 7 Retain & Evolve, 6 Restructure, 4 Exit (Emma, Kitty, Sultan, Abdullah)
- Projected savings: $86K-$129K/yr across 4 phases
- Comp corrections: Jessica Ko $48K/yr (QBO inflated by MIL debt), Joy Zhou $50.4K/yr, Celeste $24K/yr, Steven Gee $50K/yr
- Unknown W2s flagged: Darrell Francisco, Liwen D. Yang, Rosie Vega, Abraham J. Kwan (likely PEO)

## AI Readiness Survey — Sent, Awaiting Responses

- Survey sent to all 11 staff from jin@studio-88.com (Feb 25) — deadline Thu Feb 27
- View: https://docs.google.com/forms/d/e/1FAIpQLSeQQxmXOOv5j5OFMNNEMfQwLSA23a1zAeLGr-x3UVjqDhP-Lw/viewform
- Edit: https://docs.google.com/forms/d/1g9MkpCMfCo6hHdM86cX6COOLBXA8YywTDIENRRKWHwU/edit
- 5 sections: Role Clarity, AI Familiarity, Growth & Capacity, Communication & Workflow, Role-Specific
- Responses will inform dashboard data design and agent deployment sequencing
- Next: as responses come in, silently re-assess workforce evaluation scores against self-reported data

## Agent Architecture — Design Principles

- Each team-facing agent reports observations back to Jin (command patterns, adoption speed, question complexity, override rate, task completion trends)
- Jin synthesizes into performance signal — cross-referenced against workforce evaluation scores
- Divergence detection: scored low but performing high = promotion candidate; scored high but coasting = conversation needed
- Survey responses inform where agents deploy first and how handoff points are designed

## Dashboard — Unified Multi-Brand Ecommerce Ops (On Deck)

- Full brief: https://docs.google.com/document/d/1okU_szL-Bb9qtgrf53JF0-JN0J3ru2b6Gq_2rtmZwwc/edit
- 10 modules: Command Center, Revenue, Paid Media, Email/Retention, DC/Fulfillment, Returns, Marketplace, CX, Finance, AI Agent Feed
- Activity Pulse: 72-hour rolling feed, not a PM tool
- Inventory management deferred per Joe
- Integration stack: Shopify x3, Amazon x3, Walmart x3, Meta/Google/TikTok Ads x3, helpdesk, email/SMS, WMS
- Game layer Phase 2: AI agent avatars, XP/leveling tied to KPIs (Pixel Agents reference: React 19 + Canvas 2D + sprites + BFS)
- Phasing: survey data → useful dashboard → game layer

## Triple Whale — Parked

- API key obtained (both scopes selected)
- Blocked: need Shopify store domain(s) — TW requires shop context per request
- Parked until Joe provides myshopify.com domains

## Self-Improvement Protocol

- Quarterly web search to evaluate memory architecture, tools, and AI agent best practices
- Review what others are doing differently, bring recommendations or apply directly if clearly in scope
- Joe-directed, standing — no need to re-confirm each quarter

## Lessons Learned

- Render needs Gmail OAuth as env vars (not tokens file)
- Service accounts can't own Drive files (no storage quota) — use OAuth
- ANTHROPIC_API_KEY must be trimmed of whitespace (Render adds trailing newlines)
- Render "suspend" does NOT immediately kill WebSocket — must delete service
- Render logs require JS rendering — Jin can't pull directly; Joe must relay error lines
- Gmail delegation fix: use GMAIL_CLIENT_ID not GOOGLE_CLIENT_ID for Jin OAuth refresh
- Slack file downloads: drop Authorization header on redirects (pre-signed URLs)
- DM replies: no streaming chat.update in DMs — post fresh message, delete ack
- Memory protocol: automatic after Slack convos (→ Live Log); manual after Claude Code sessions (→ session-log.txt → !reload)

## Multi-Agent Deployment — In Progress (Feb 25, 2026)

- **Chip** (Jessica V, Marketing PM) — `/Users/agentserver/chip/`, port 3001, Funnel :8443
- **Lucky** (Tracy Wang, Logistics/SC) — `/Users/agentserver/lucky/`, port 3002, Funnel :10000
- Code cleaned, directories created, Tailscale Funnels live (443/8443/10000)
- Each agent: own Slack app, own Google account (chip@/lucky@studio-88.com), own git repo, own memory
- Jess V and Tracy build via Claude Code Pro + VS Code Remote SSH
- Jin-only tools: QBO, workforce eval, comp data, morning/EOD crons
- Jin has READ ACCESS to all agent directories (chip/, lucky/, future agents) — agents cannot see each other or Jin
- **Weekly Cross-Agent Digest (Friday evening PST):** Jin auto-reads all agent memory files, extracts sensitive/high-impact business intel, writes executive summary (Key Findings + Implications + Analysis), DMs Joe in Slack, and writes distilled insights into Jin's own memory
- **Real-time escalation:** DEFERRED — triggers TBD after team discussion. Plumbing built but no active escalation rules until Joe + team define what constitutes critical signals
- **Proactive agent→Jin reporting:** Each agent has `report_to_jin` tool. After meaningful work sessions, agents self-reflect and report: human team observations (patterns, blockers, morale signals), business implications, cross-functional dependencies, wins/learnings. Written to shared inbox file. Jin triages on 30-min heartbeat cycle.
- **Cross-agent pattern detection:** Jin's weekly digest explicitly looks for patterns that only emerge across silos (e.g., freight cost spike + conversion drop on same SKUs = margin squeeze)
- Shared: Anthropic API key, Brave Search, Playwright MCP, service account
- **Waiting on Joe**: Google accounts, Slack apps, SSH keys, GitHub repos, Claude Pro subs, #agents channel
- **Future Tier 2**: Other staff access via Slack dispatch (ai-ops@studio-88.com) or Claude Agent Teams — no dedicated agent, just task routing

## Mobile Stack — Confirmed

- Claude.ai = thinking/planning with Jin (full context, Drive memory)
- Claude Code iOS = building/deploying (repo-aware, boot with session-log.txt)
- Termius = SSH admin, PM2 checks, emergency access
- All three are permanent stack components


## Updated Feb 26, 2026

## Mac Mini — Physical Access

- SSH (Remote Login) was found disabled/not running — caused VS Code Remote timeout
- Fix: must be re-enabled via System Settings → General → Sharing → Remote Login (requires physical access or sudo)
- **KVM over IP recommended for permanent emergency access**: TinyPilot Voyager 3 (~$300, tinypilotkvm.com) — browser-based, plug-and-play, no monitor/keyboard needed after setup
- Joe does not want to lug monitor/keyboard home repeatedly — KVM over IP is the long-term solution

---


## Updated Feb 26, 2026

## Social Media Outreach — Deleted (Feb 26, 2026)

- All SOP files, influencer tracker sheets, outreach docs, and Weekly Digest references related to social media outreach have been scrubbed
- Confirmed by Joe: the entire workstream was a test — no real outreach was ever intended
- No Drive files found under those names — content was either session-only or already gone
- Weekly Digest section referencing Apify → influencer pipeline has been removed
- Do not recreate any social media outreach SOPs, trackers, or pipeline docs unless Joe explicitly re-initiates


## Updated Feb 26, 2026

## Agent Credentials — Stored (Feb 26, 2026)

- **Chip email password**: 5ruEY8P2B3G43jB&
- **Lucky email password**: jb8Wm=ThRFhW6qN&
- Accounts not yet spun up — credentials stored and ready for deployment
