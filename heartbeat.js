/**
 * Jin Heartbeat — Memory Sync + Proactive Check
 *
 * Two loops:
 *   1. Memory sync (every 3 min) — reads new conversation activity, writes to Drive Live Log
 *   2. Proactive check (every 30 min) — reads Gmail + Calendar, asks Claude if anything needs Joe's attention.
 *      If yes → DM Joe in Slack. If no → silent (HEARTBEAT_OK).
 *
 * Managed by PM2 as a separate process alongside agent.js.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { WebClient } = require('@slack/web-api');
const { google } = require('googleapis');
const fs = require('fs');

const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000;       // 3 minutes — memory sync
const PROACTIVE_INTERVAL_MS = 30 * 60 * 1000;       // 30 minutes — proactive check
const JOE_DM_CHANNEL = 'D0AG94XK2NS';               // Joe's Slack DM channel
const HISTORY_PATH = './conversation-history.json';
const SESSION_LOG_PATH = './session-log.txt';
const STATE_PATH = './heartbeat-state.json';

const MEMORY_IDS = {
  liveLog:          '1-USb_amWwvosnaY6WYc5EbVLluuxtVsP0520qaJrBfs',
  weeklyDigest:     '1Bsh1QYXnPxOiFeoHV2TiAebqakZ7pdLsX0ABLGwXkhw',
  quarterlyArchive: '1R5NZpRarA5zo02zIQfYGYbviTsxDtKQnp0NgogzSuJY',
};

const AI_HUB_FOLDER_ID = '125EAuI55RG3Os59rUeuIAkbv47To4s70';
const HEARTBEAT_DRIVE_FILENAME = 'jin-heartbeat.json';
let heartbeatDriveFileId = null;

const GMAIL_TOKENS_PATH = './gmail-tokens.json';

const anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '') });
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost'
  );
  let tokens;
  if (fs.existsSync(GMAIL_TOKENS_PATH)) {
    tokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS_PATH, 'utf8'));
  } else if (process.env.GMAIL_REFRESH_TOKEN) {
    tokens = { refresh_token: process.env.GMAIL_REFRESH_TOKEN };
  } else {
    throw new Error('No Gmail tokens available');
  }
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

function getGoogleAuthClient() {
  const SERVICE_ACCOUNT_PATH = './service-account.json';
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON.replace(/^[a-zA-Z]+\s*\n/, '').trim());
    return new google.auth.GoogleAuth({ credentials: key, scopes: GOOGLE_SCOPES });
  } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    const key = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    return new google.auth.GoogleAuth({ credentials: key, scopes: GOOGLE_SCOPES });
  } else {
    return getOAuthClient();
  }
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuthClient() });
}

// ─── State — tracks what we've already processed ──────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return { lastProcessedAt: {}, lastHeartbeatAt: null };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ─── Drive helpers ────────────────────────────────────────────────────────────

async function appendToLiveLog(text) {
  try {
    const auth = getGoogleAuthClient();
    const docs = google.docs({ version: 'v1', auth });
    await docs.documents.batchUpdate({
      documentId: MEMORY_IDS.liveLog,
      requestBody: {
        requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
      },
    });
  } catch (err) {
    console.warn(`  ✗ Failed to append to Live Log: ${err.message}`);
  }
}

async function readLiveLog() {
  try {
    const drive = getDriveClient();
    const res = await drive.files.export(
      { fileId: MEMORY_IDS.liveLog, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    return (res.data || '').trim();
  } catch (err) {
    console.warn(`  ✗ Failed to read Live Log: ${err.message}`);
    return '';
  }
}

// ─── Drive heartbeat ping ─────────────────────────────────────────────────────

async function resolveHeartbeatDriveFile() {
  try {
    const drive = google.drive({ version: 'v3', auth: getOAuthClient() });
    const res = await drive.files.list({
      q: `name='${HEARTBEAT_DRIVE_FILENAME}' and '${AI_HUB_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id)',
    });
    if (res.data.files.length > 0) {
      heartbeatDriveFileId = res.data.files[0].id;
    } else {
      const created = await drive.files.create({
        requestBody: { name: HEARTBEAT_DRIVE_FILENAME, parents: [AI_HUB_FOLDER_ID], mimeType: 'text/plain' },
        media: { mimeType: 'text/plain', body: JSON.stringify({ lastHeartbeatAt: new Date().toISOString() }) },
        fields: 'id',
      });
      heartbeatDriveFileId = created.data.id;
    }
    console.log(`  ✓ Heartbeat Drive file: ${heartbeatDriveFileId}`);
  } catch (err) {
    console.warn('  ✗ Could not resolve heartbeat Drive file:', err.message);
  }
}

async function writeHeartbeatToDrive(timestamp) {
  if (!heartbeatDriveFileId) return;
  try {
    const drive = google.drive({ version: 'v3', auth: getOAuthClient() });
    await drive.files.update({
      fileId: heartbeatDriveFileId,
      media: { mimeType: 'text/plain', body: JSON.stringify({ lastHeartbeatAt: timestamp }) },
    });
  } catch (err) {
    console.warn('  ✗ Could not write heartbeat to Drive:', err.message);
  }
}

// ─── Core heartbeat logic ─────────────────────────────────────────────────────

async function runHeartbeat() {
  const now = new Date();
  const state = loadState();

  console.log(`[${now.toISOString()}] Heartbeat running...`);

  // Load conversation history
  let history = {};
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('  ✗ Could not read conversation history:', err.message);
    return;
  }

  // Find threads with new activity since we last processed them
  const newActivityThreads = [];
  for (const [threadKey, messages] of Object.entries(history)) {
    if (!Array.isArray(messages) || messages.length === 0) continue;

    const lastMsg = messages[messages.length - 1];
    const lastMsgContent = typeof lastMsg.content === 'string' ? lastMsg.content : '';

    // Use message count as a proxy for "new since last check"
    const lastProcessedCount = state.lastProcessedAt[threadKey] || 0;
    if (messages.length > lastProcessedCount) {
      // New messages in this thread
      const newMessages = messages.slice(lastProcessedCount);
      newActivityThreads.push({ threadKey, messages, newMessages });
      state.lastProcessedAt[threadKey] = messages.length;
    }
  }

  if (newActivityThreads.length === 0) {
    console.log('  No new activity. Nothing to consolidate.');
    state.lastHeartbeatAt = now.toISOString();
    saveState(state);
    return;
  }

  console.log(`  Found ${newActivityThreads.length} thread(s) with new activity.`);

  // For each thread with new activity, extract memory-worthy content
  for (const { threadKey, messages, newMessages } of newActivityThreads) {
    try {
      const recentConvo = newMessages.map(m => `${m.role}: ${m.content}`).join('\n');

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are Jin, Chief of Staff to Joe Ko at 88 Venture Studio. Review this recent conversation excerpt and extract ONLY what's worth saving to long-term memory — decisions made, strategic shifts, new business context, tasks completed, relationship changes. Prioritize items with revenue or margin implications. Be very concise (2-5 sentences max). If nothing is worth saving, reply with exactly: NOTHING

Conversation:
${recentConvo.slice(-3000)}`,
        }],
      });

      const summary = response.content[0].text.trim();

      if (summary === 'NOTHING' || summary.length < 20) {
        console.log(`  Thread ${threadKey}: nothing worth saving.`);
        continue;
      }

      const timestamp = now.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      });

      const entry = `\n--- ${timestamp} ---\n${summary}\n`;

      // Write to Live Log
      await appendToLiveLog(entry);

      // Also append to local session-log.txt
      try {
        fs.appendFileSync(SESSION_LOG_PATH, entry, 'utf8');
      } catch {}

      console.log(`  ✓ Thread ${threadKey}: memory updated.`);

    } catch (err) {
      console.warn(`  ✗ Failed to process thread ${threadKey}: ${err.message}`);
    }
  }

  state.lastHeartbeatAt = now.toISOString();
  saveState(state);
  await writeHeartbeatToDrive(now.toISOString());
  console.log(`  Heartbeat complete.`);
}

// ─── Proactive Check ─────────────────────────────────────────────────────────

async function fetchRecentEmails() {
  try {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: 'v1', auth });
    // Unread emails from the last 24 hours
    const after = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${after}`,
      maxResults: 8,
    });
    const messages = listRes.data.messages || [];
    if (messages.length === 0) return 'No unread emails in the last 24 hours.';
    const results = [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const headers = full.data.payload.headers;
      const get = (name) => headers.find(h => h.name === name)?.value || '';
      results.push(`From: ${get('From')}\nDate: ${get('Date')}\nSubject: ${get('Subject')}\nSnippet: ${full.data.snippet || ''}`);
    }
    return results.join('\n\n---\n\n');
  } catch (err) {
    console.warn('  ✗ proactive: could not fetch Gmail:', err.message);
    return '(Gmail unavailable)';
  }
}

async function fetchUpcomingCalendar() {
  try {
    const auth = getOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const end = new Date();
    end.setDate(end.getDate() + 2); // today + tomorrow
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = res.data.items || [];
    if (events.length === 0) return 'No upcoming events in the next 2 days.';
    return events.map(e => {
      const start = e.start.dateTime || e.start.date;
      return `${start} — ${e.summary || '(no title)'}${e.location ? `\n  Location: ${e.location}` : ''}`;
    }).join('\n');
  } catch (err) {
    console.warn('  ✗ proactive: could not fetch Calendar:', err.message);
    return '(Calendar unavailable)';
  }
}

async function proactiveCheck() {
  // Only run during reasonable hours (6am–10pm PST)
  const hour = new Date().getHours(); // Mac Mini is PST
  if (hour < 6 || hour >= 22) {
    console.log(`[Proactive] Outside active hours (${hour}:xx PST) — skipping.`);
    return;
  }

  console.log('[Proactive] Running check...');

  const [emails, calendar] = await Promise.all([fetchRecentEmails(), fetchUpcomingCalendar()]);

  // Load memory files for context
  let soul = '', joe = '', memory = '';
  try {
    if (fs.existsSync('./memory/JOE.md')) joe = fs.readFileSync('./memory/JOE.md', 'utf8');
    if (fs.existsSync('./memory/MEMORY.md')) memory = fs.readFileSync('./memory/MEMORY.md', 'utf8').slice(0, 1500);
  } catch {}

  const prompt = `You are Jin, AI Chief of Staff to Joe Ko, founder of 88 Venture Studio.

Your job right now: scan Joe's calendar and recent unread emails. Decide whether anything requires his attention. Think like a Chief of Staff, not an alarm system — only interrupt if something is genuinely time-sensitive, decision-requiring, relationship-at-risk, or event he might be unprepared for.

Joe's current priorities:
- J.Adams: inventory triage + brand repositioning (survival mode)
- CCS service partner relationship (protect and expand)
- Boley + Pediped are cash flow lifelines — flag anything touching these
- 2026 = pivot + execution year; AI infrastructure is the primary lever

${joe ? `Who Joe is:\n${joe.slice(0, 800)}\n\n` : ''}${memory ? `Recent decisions/context:\n${memory}\n\n` : ''}Unread emails (last 24h):
${emails}

Upcoming calendar (next 2 days):
${calendar}

Decision: Is there anything here that requires Joe's attention RIGHT NOW — something time-sensitive, a decision to make, a relationship at risk, or an event he's not prepared for?

If YES: write a 2–3 sentence brief. Be specific. Start with the most important item. Do not pad with filler.
If NO: reply with exactly the word: HEARTBEAT_OK`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = response.content[0].text.trim();
    console.log(`[Proactive] Result: ${result.slice(0, 100)}`);

    if (result === 'HEARTBEAT_OK' || result.startsWith('HEARTBEAT_OK')) {
      console.log('[Proactive] All clear — staying silent.');
      return;
    }

    // Something needs Joe's attention — send DM
    await slack.chat.postMessage({
      channel: JOE_DM_CHANNEL,
      text: result,
    });
    console.log('[Proactive] Notified Joe.');
  } catch (err) {
    console.warn('[Proactive] Check failed:', err.message);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log('Jin Heartbeat starting...');
console.log(`Memory sync: every ${HEARTBEAT_INTERVAL_MS / 1000 / 60} min`);
console.log(`Proactive check: every ${PROACTIVE_INTERVAL_MS / 1000 / 60} min (6am–10pm PST only)`);
console.log();

// Memory sync loop — runs immediately and every 3 minutes
resolveHeartbeatDriveFile().then(() => {
  runHeartbeat().catch(err => console.error('Heartbeat error:', err.message));
}).catch(err => console.error('Heartbeat startup error:', err.message));
setInterval(() => {
  runHeartbeat().catch(err => console.error('Heartbeat error:', err.message));
}, HEARTBEAT_INTERVAL_MS);

// Proactive check loop — first run after 5 minutes (let agent settle), then every 30 min
setTimeout(() => {
  proactiveCheck().catch(err => console.error('Proactive check error:', err.message));
  setInterval(() => {
    proactiveCheck().catch(err => console.error('Proactive check error:', err.message));
  }, PROACTIVE_INTERVAL_MS);
}, 5 * 60 * 1000);
