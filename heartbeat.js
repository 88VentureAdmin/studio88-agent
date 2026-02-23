/**
 * Jin Heartbeat — Memory Sync Loop
 * Runs every 3 minutes. Checks for new conversation activity,
 * consolidates into Drive Live Log so ALL instances stay current.
 *
 * Managed by PM2 as a separate process alongside agent.js.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');

const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes
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

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log('Jin Heartbeat starting...');
console.log(`Interval: every ${HEARTBEAT_INTERVAL_MS / 1000 / 60} minutes`);
console.log('Writing new conversation activity to Drive Live Log continuously.\n');

// Resolve heartbeat Drive file, then run immediately and on interval
resolveHeartbeatDriveFile().then(() => {
  runHeartbeat().catch(err => console.error('Heartbeat error:', err.message));
}).catch(err => console.error('Heartbeat startup error:', err.message));
setInterval(() => {
  runHeartbeat().catch(err => console.error('Heartbeat error:', err.message));
}, HEARTBEAT_INTERVAL_MS);
