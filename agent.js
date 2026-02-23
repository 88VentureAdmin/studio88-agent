/**
 * Jin — Chief of Staff Agent
 * Slack (Socket Mode) + Claude claude-sonnet-4-6 + Google Drive context
 * Supports: text, images/screenshots, website URLs
 *
 * Usage: node agent.js
 */

require('dotenv').config();
const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const mammoth = require('mammoth');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVICE_ACCOUNT_PATH = './service-account.json';

const DRIVE_FILES = [
  {
    id: '1toa7HE20qi1FnSt1uZG0UqQfARfadA4D',
    name: 'Studio88 Master Context',
    type: 'docx',
  },
  {
    id: '1PKPtHWXK32L-a5k5QNsqjJC9KkCQub3cd7uxQeiYcTY',
    name: 'Conversation Log Feb 20',
    type: 'gdoc',
  },
];

const MAX_HISTORY = 20;
const MAX_URL_CHARS = 3000; // max chars to include per fetched URL
const MAX_URLS = 2;         // max URLs to fetch per message
const MAX_LIVE_LOG_CHARS = 3000; // max chars to load from Live Log at startup

const MEMORY_IDS = {
  liveLog:          '1-USb_amWwvosnaY6WYc5EbVLluuxtVsP0520qaJrBfs',
  weeklyDigest:     '1Bsh1QYXnPxOiFeoHV2TiAebqakZ7pdLsX0ABLGwXkhw',
  quarterlyArchive: '1R5NZpRarA5zo02zIQfYGYbviTsxDtKQnp0NgogzSuJY',
};

const AI_HUB_FOLDER_ID = '125EAuI55RG3Os59rUeuIAkbv47To4s70';
const HISTORY_DRIVE_FILENAME = 'jin-conversation-history.json';
let historyDriveFileId = null; // resolved at startup

const HEARTBEAT_DRIVE_FILENAME = 'jin-heartbeat.json';
const HEARTBEAT_STALENESS_MS = 30 * 60 * 1000; // 30 minutes — Render only activates after Mac Mini has been silent this long
let heartbeatFileId = null; // cached at first check

const GMAIL_TOKENS_PATH = './gmail-tokens.json';

function getOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost'
  );
  let tokens;
  try {
    if (fs.existsSync(GMAIL_TOKENS_PATH)) {
      tokens = JSON.parse(fs.readFileSync(GMAIL_TOKENS_PATH, 'utf8'));
    } else if (process.env.GMAIL_REFRESH_TOKEN) {
      tokens = { refresh_token: process.env.GMAIL_REFRESH_TOKEN };
    } else {
      throw new Error('no tokens');
    }
  } catch (err) {
    console.warn('  ✗ getOAuthClient failed:', err.message);
    throw new Error('Gmail not authorized. Run setup-gmail.js first.');
  }
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    fs.writeFileSync(GMAIL_TOKENS_PATH, JSON.stringify(updated, null, 2), 'utf8');
    tokens = updated;
  });
  return oauth2Client;
}

function getDriveClientOAuth() {
  return google.drive({ version: 'v3', auth: getOAuthClient() });
}

// Strip leading language hints (e.g. "json\n") that Render sometimes prepends to env var values
function parseEnvJson(val) {
  return JSON.parse(val.replace(/^[a-zA-Z]+\s*\n/, '').trim());
}

// ─── Google Drive ─────────────────────────────────────────────────────────────

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
];

function getGoogleAuthClient() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const key = parseEnvJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
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

async function appendToGoogleDoc(docId, text) {
  try {
    const auth = getGoogleAuthClient();
    const docs = google.docs({ version: 'v1', auth });
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{ insertText: { endOfSegmentLocation: { segmentId: '' }, text } }],
      },
    });
  } catch (err) {
    console.warn(`  ✗ Failed to append to doc ${docId}: ${err.message}`);
  }
}

// ─── Drive Conversation History Sync ─────────────────────────────────────────

async function resolveHistoryDriveFile() {
  try {
    const drive = getDriveClientOAuth();
    const res = await drive.files.list({
      q: `name='${HISTORY_DRIVE_FILENAME}' and '${AI_HUB_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id)',
    });
    if (res.data.files.length > 0) {
      historyDriveFileId = res.data.files[0].id;
      console.log(`  ✓ Found Drive history file: ${historyDriveFileId}`);
    } else {
      // Create it
      const created = await drive.files.create({
        requestBody: { name: HISTORY_DRIVE_FILENAME, parents: [AI_HUB_FOLDER_ID], mimeType: 'text/plain' },
        media: { mimeType: 'text/plain', body: '{}' },
        fields: 'id',
      });
      historyDriveFileId = created.data.id;
      console.log(`  ✓ Created Drive history file: ${historyDriveFileId}`);
    }
  } catch (err) {
    console.warn('  ✗ Could not resolve Drive history file:', err.message);
  }
}

async function loadHistoryFromDrive() {
  if (!historyDriveFileId) return null;
  try {
    const drive = getDriveClientOAuth();
    const res = await drive.files.get(
      { fileId: historyDriveFileId, alt: 'media' },
      { responseType: 'text' }
    );
    const data = JSON.parse(res.data || '{}');
    console.log(`  ✓ Loaded conversation history from Drive (${Object.keys(data).length} thread(s))`);
    return new Map(Object.entries(data));
  } catch (err) {
    console.warn('  ✗ Could not load Drive history:', err.message);
    return null;
  }
}

async function saveHistoryToDrive(map) {
  if (!historyDriveFileId) return;
  try {
    const drive = getDriveClientOAuth();
    const body = JSON.stringify(Object.fromEntries(map), null, 2);
    await drive.files.update({
      fileId: historyDriveFileId,
      media: { mimeType: 'text/plain', body },
    });
  } catch (err) {
    console.warn('  ✗ Could not save history to Drive:', err.message);
  }
}

function loadSessionLog() {
  const logPath = './session-log.txt';
  if (fs.existsSync(logPath)) {
    console.log('  ✓ Loaded: session log');
    return fs.readFileSync(logPath, 'utf8');
  }
  return null;
}

async function loadDriveContext() {
  console.log('Loading context from Google Drive...');
  const drive = getDriveClient();
  const sections = [];

  for (const file of DRIVE_FILES) {
    try {
      let text = '';

      if (file.type === 'gdoc') {
        const res = await drive.files.export(
          { fileId: file.id, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        text = res.data;
      } else if (file.type === 'docx') {
        const res = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const result = await mammoth.extractRawText({ buffer: Buffer.from(res.data) });
        text = result.value;
      }

      sections.push(`## ${file.name}\n\n${text.trim()}`);
      console.log(`  ✓ Loaded: ${file.name}`);
    } catch (err) {
      console.warn(`  ✗ Failed to load ${file.name}: ${err.message}`);
    }
  }

  return sections.join('\n\n---\n\n');
}

async function loadMemoryContext() {
  const drive = getDriveClient();
  const sections = [];

  // Weekly Digest — full (stays compact after digesting)
  try {
    const res = await drive.files.export(
      { fileId: MEMORY_IDS.weeklyDigest, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const text = (res.data || '').trim();
    if (text) sections.push(`### Weekly Digest\n${text}`);
    console.log('  ✓ Loaded: Weekly Digest');
  } catch (err) {
    console.warn(`  ✗ Weekly Digest: ${err.message}`);
  }

  // Live Log — tail only (grows over time, only need recent entries)
  try {
    const res = await drive.files.export(
      { fileId: MEMORY_IDS.liveLog, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const text = (res.data || '').trim();
    const tail = text.slice(-MAX_LIVE_LOG_CHARS);
    if (tail) sections.push(`### Recent Live Log\n${tail}`);
    console.log('  ✓ Loaded: Live Log (recent)');
  } catch (err) {
    console.warn(`  ✗ Live Log: ${err.message}`);
  }

  return sections.join('\n\n');
}

// ─── Image Support ────────────────────────────────────────────────────────────

// Download a private Slack file and return { base64, mimeType }
async function downloadSlackFile(url, botToken) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { Authorization: `Bearer ${botToken}` } }, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadSlackFile(res.headers.location, botToken).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const mimeType = res.headers['content-type']?.split(';')[0] || 'image/png';
        resolve({ base64: buffer.toString('base64'), mimeType });
      });
    });
    req.on('error', reject);
  });
}

// ─── Google Drive URL Detection ───────────────────────────────────────────────

function extractDriveFileId(url) {
  // Handles:
  //   docs.google.com/document/d/<id>/...
  //   docs.google.com/spreadsheets/d/<id>/...
  //   docs.google.com/presentation/d/<id>/...
  //   drive.google.com/file/d/<id>/...
  //   drive.google.com/open?id=<id>
  const patterns = [
    /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchDriveUrl(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return null;

  try {
    const drive = getDriveClient();

    // Try exporting as plain text (works for Docs, Sheets, Slides)
    try {
      const res = await drive.files.export(
        { fileId, mimeType: 'text/plain' },
        { responseType: 'text' }
      );
      return res.data?.trim() || null;
    } catch {
      // Not a Google Workspace file — try downloading as binary (e.g. uploaded .docx)
      const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      const result = await mammoth.extractRawText({ buffer: Buffer.from(res.data) });
      return result.value?.trim() || null;
    }
  } catch (err) {
    console.warn(`  ✗ Drive fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

// ─── URL Fetching ─────────────────────────────────────────────────────────────

function extractUrls(text) {
  // Match http/https URLs, ignore Slack's angle-bracket formatting
  const raw = text.replace(/<(https?:\/\/[^|>]+)[^>]*>/g, '$1'); // unwrap Slack URLs
  const matches = raw.match(/https?:\/\/[^\s<>"]+/g) || [];
  return [...new Set(matches)].slice(0, MAX_URLS);
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jin/1.0)' }, timeout: 8000 }, (res) => {
      // Follow redirects
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(() => resolve(''));
      }
      if (res.statusCode !== 200) return resolve('');
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchUrlContent(url) {
  try {
    // Route Drive/Docs URLs through the authenticated Drive API
    if (extractDriveFileId(url)) {
      const text = await fetchDriveUrl(url);
      if (text) console.log(`  ✓ Drive URL fetched: ${url}`);
      return text ? text.slice(0, MAX_URL_CHARS) : null;
    }

    const html = await fetchUrl(url);
    if (!html) return null;
    const text = stripHtml(html);
    return text.slice(0, MAX_URL_CHARS);
  } catch {
    return null;
  }
}

// ─── Content Builder ──────────────────────────────────────────────────────────

// Builds the content for Claude — returns a string (text only) or array (text + images)
async function buildUserContent(text, files, botToken) {
  const contentBlocks = [];
  let historyText = text || '';

  // Process images from Slack file attachments
  const imageFiles = (files || []).filter(
    (f) => f.mimetype?.startsWith('image/') && f.url_private_download
  );

  for (const file of imageFiles) {
    try {
      const { base64, mimeType } = await downloadSlackFile(file.url_private_download, botToken);
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      });
      historyText += historyText ? ` [+ image: ${file.name || 'screenshot'}]` : `[image: ${file.name || 'screenshot'}]`;
      console.log(`  ✓ Image loaded: ${file.name || file.id}`);
    } catch (err) {
      console.warn(`  ✗ Failed to load image: ${err.message}`);
    }
  }

  // Process URLs in text
  const urls = extractUrls(text || '');
  let urlContext = '';
  for (const url of urls) {
    const content = await fetchUrlContent(url);
    if (content) {
      urlContext += `\n\n[Content from ${url}]:\n${content}`;
      console.log(`  ✓ URL fetched: ${url}`);
    }
  }

  // Build text block
  const fullText = (text || '') + urlContext;
  if (fullText) {
    contentBlocks.push({ type: 'text', text: fullText });
  }

  // Return string if text-only, array if mixed (images + text)
  if (contentBlocks.length === 0) return text || '';
  if (contentBlocks.length === 1 && contentBlocks[0].type === 'text') return fullText;
  return { content: contentBlocks, historyText };
}

// ─── Tools (Option A) ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'run_shell',
    description: 'Run a shell command on the Mac Mini. Use for checking PM2 status, reading logs, restarting processes, checking disk/memory, running scripts, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the Mac Mini filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file on the Mac Mini filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a given path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_to_memory',
    description: 'Save something important to Jin\'s long-term memory right now. Use this mid-conversation when a decision is made, a task is completed, or something strategic happens that should be remembered.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to save to memory' },
      },
      required: ['content'],
    },
  },
  {
    name: 'create_drive_file',
    description: 'Create a new file in the Studio 88 AI Hub folder on Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name (include extension, e.g. "Q1 Plan.txt")' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: 'list_drive_files',
    description: 'List files in the Studio 88 AI Hub folder on Google Drive.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_gmail',
    description: 'Read emails from Gmail. Search by sender, subject, label, etc. Leave query blank for recent unread.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search query, e.g. "from:amazon.com is:unread" or "subject:invoice". Blank = recent unread.' },
        maxResults: { type: 'number', description: 'Max emails to return (default 5, max 20)' },
      },
    },
  },
  {
    name: 'send_email',
    description: 'Send an email via Gmail on behalf of Joe.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC email address (optional)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'get_calendar_events',
    description: 'Get upcoming events from Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Days to look ahead (default 7)' },
        maxResults: { type: 'number', description: 'Max events to return (default 10)' },
      },
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Create a new event on Joe\'s Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        startDateTime: { type: 'string', description: 'Start in ISO 8601 format, e.g. 2026-02-23T10:00:00-08:00' },
        endDateTime: { type: 'string', description: 'End in ISO 8601 format' },
        description: { type: 'string', description: 'Event description (optional)' },
        attendees: { type: 'string', description: 'Comma-separated attendee emails (optional)' },
      },
      required: ['title', 'startDateTime', 'endDateTime'],
    },
  },
  {
    name: 'read_sheet',
    description: 'Read data from a Google Sheet. Pass a Sheets URL or file ID. Returns the sheet content as a table.',
    input_schema: {
      type: 'object',
      properties: {
        url_or_id: { type: 'string', description: 'Google Sheets URL or file ID' },
        sheet_name: { type: 'string', description: 'Specific sheet/tab name to read (optional, reads first sheet by default)' },
      },
      required: ['url_or_id'],
    },
  },
];

async function executeTool(name, input) {
  try {
    switch (name) {
      case 'run_shell': {
        try {
          const output = execSync(input.command, {
            cwd: '/Users/agentserver/studio88-agent',
            timeout: 30000,
            encoding: 'utf8',
          });
          return output || '(no output)';
        } catch (err) {
          return `Exit ${err.status || 1}:\n${err.stdout || ''}${err.stderr || err.message}`;
        }
      }
      case 'read_file':
        return fs.readFileSync(input.path, 'utf8');
      case 'write_file':
        fs.writeFileSync(input.path, input.content, 'utf8');
        return 'Written.';
      case 'list_directory':
        return fs.readdirSync(input.path).join('\n');
      case 'write_to_memory': {
        const timestamp = new Date().toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
        });
        const entry = `\n--- ${timestamp} (Jin saved) ---\n${input.content}\n`;
        await appendToGoogleDoc(MEMORY_IDS.liveLog, entry);
        try { fs.appendFileSync('./session-log.txt', entry, 'utf8'); } catch {}
        return 'Saved to memory.';
      }
      case 'create_drive_file': {
        const drive = getDriveClient();
        const file = await drive.files.create({
          requestBody: {
            name: input.name,
            parents: [AI_HUB_FOLDER_ID],
            mimeType: 'text/plain',
          },
          media: { mimeType: 'text/plain', body: input.content },
          fields: 'id,name,webViewLink',
        });
        return `Created: ${file.data.name}\nID: ${file.data.id}\nLink: ${file.data.webViewLink}`;
      }
      case 'list_drive_files': {
        const drive = getDriveClient();
        const res = await drive.files.list({
          q: `'${AI_HUB_FOLDER_ID}' in parents and trashed=false`,
          fields: 'files(id,name,mimeType,modifiedTime)',
          orderBy: 'modifiedTime desc',
        });
        const files = res.data.files || [];
        return files.map(f => `${f.name} (${f.id})`).join('\n') || '(empty)';
      }
      case 'read_gmail': {
        const auth = getOAuthClient();
        const gmail = google.gmail({ version: 'v1', auth });
        const q = input.query || 'is:unread';
        const maxResults = Math.min(input.maxResults || 5, 20);
        const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults });
        const messages = listRes.data.messages || [];
        if (messages.length === 0) return 'No messages found.';
        const results = [];
        for (const msg of messages) {
          const full = await gmail.users.messages.get({
            userId: 'me', id: msg.id, format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });
          const headers = full.data.payload.headers;
          const get = (name) => headers.find(h => h.name === name)?.value || '';
          results.push(`From: ${get('From')}\nDate: ${get('Date')}\nSubject: ${get('Subject')}\nSnippet: ${full.data.snippet || ''}`);
        }
        return results.join('\n\n---\n\n');
      }
      case 'send_email': {
        const auth = getOAuthClient();
        const gmail = google.gmail({ version: 'v1', auth });
        const lines = [
          `To: ${input.to}`,
          `Subject: ${input.subject}`,
          ...(input.cc ? [`Cc: ${input.cc}`] : []),
          'Content-Type: text/plain; charset=utf-8',
          '',
          input.body,
        ];
        const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
        await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
        return `Email sent to ${input.to}.`;
      }
      case 'get_calendar_events': {
        const auth = getOAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });
        const now = new Date();
        const end = new Date();
        end.setDate(end.getDate() + (input.days || 7));
        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: now.toISOString(),
          timeMax: end.toISOString(),
          maxResults: input.maxResults || 10,
          singleEvents: true,
          orderBy: 'startTime',
        });
        const events = res.data.items || [];
        if (events.length === 0) return 'No upcoming events.';
        return events.map(e => {
          const start = e.start.dateTime || e.start.date;
          return `${start} — ${e.summary || '(no title)'}${e.location ? `\n  Location: ${e.location}` : ''}${e.description ? `\n  ${e.description.slice(0, 100)}` : ''}`;
        }).join('\n');
      }
      case 'create_calendar_event': {
        const auth = getOAuthClient();
        const calendar = google.calendar({ version: 'v3', auth });
        const event = {
          summary: input.title,
          start: { dateTime: input.startDateTime },
          end: { dateTime: input.endDateTime },
        };
        if (input.description) event.description = input.description;
        if (input.attendees) event.attendees = input.attendees.split(',').map(e => ({ email: e.trim() }));
        const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
        return `Event created: ${res.data.summary}\nLink: ${res.data.htmlLink}`;
      }
      case 'read_sheet': {
        const auth = getOAuthClient();
        // Extract file ID from URL if needed
        const idMatch = input.url_or_id.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) ||
                        input.url_or_id.match(/^([a-zA-Z0-9_-]{25,})$/);
        const fileId = idMatch ? idMatch[1] : input.url_or_id;
        const sheets = google.sheets({ version: 'v4', auth });
        // Get sheet metadata to find the right tab
        const meta = await sheets.spreadsheets.get({ spreadsheetId: fileId });
        const sheetList = meta.data.sheets.map(s => s.properties.title);
        const targetSheet = input.sheet_name
          ? sheetList.find(s => s.toLowerCase() === input.sheet_name.toLowerCase()) || sheetList[0]
          : sheetList[0];
        const res = await sheets.spreadsheets.values.get({
          spreadsheetId: fileId,
          range: targetSheet,
        });
        const rows = res.data.values || [];
        if (rows.length === 0) return 'Sheet is empty.';
        const header = rows[0];
        const data = rows.slice(1).map(row =>
          header.map((h, i) => `${h}: ${row[i] || ''}`).join(' | ')
        );
        return `Sheet: ${targetSheet} (${rows.length - 1} rows)\n\n${data.slice(0, 50).join('\n')}${data.length > 50 ? `\n\n...${data.length - 50} more rows` : ''}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err.message}`;
  }
}

// ─── Claude Code Subprocess (Option B) ───────────────────────────────────────

function runClaudeCode(task, cwd) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE; // avoid nested session check

    const proc = spawn('claude', ['--print', task, '--output-format', 'text'], {
      cwd,
      env,
    });

    let output = '';
    let error = '';
    proc.stdout.on('data', (d) => { output += d; });
    proc.stderr.on('data', (d) => { error += d; });
    proc.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(error.trim() || `Exit code ${code}`));
    });
    proc.on('error', reject);

    // 5-minute timeout
    setTimeout(() => { proc.kill(); reject(new Error('Timed out after 5 minutes')); }, 300000);
  });
}

// ─── Mac Mini heartbeat check (Render only) ───────────────────────────────────

async function checkMacMiniAlive() {
  try {
    const drive = getDriveClientOAuth();
    if (!heartbeatFileId) {
      const res = await drive.files.list({
        q: `name='${HEARTBEAT_DRIVE_FILENAME}' and '${AI_HUB_FOLDER_ID}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (res.data.files.length === 0) return false; // no heartbeat file = assume down
      heartbeatFileId = res.data.files[0].id;
    }
    const res = await drive.files.get({ fileId: heartbeatFileId, alt: 'media' }, { responseType: 'text' });
    const data = JSON.parse(res.data || '{}');
    const lastBeat = new Date(data.lastHeartbeatAt).getTime();
    return (Date.now() - lastBeat) < HEARTBEAT_STALENESS_MS;
  } catch (err) {
    console.warn('  ✗ Heartbeat check failed:', err.message);
    return false; // can't check = assume down, let Render respond
  }
}

// ─── Claude ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '') });

function buildSystemPrompt(driveContext, sessionLog, memoryContext) {
  const isStandby = process.env.INSTANCE_ROLE === 'standby';
  const instanceInfo = isStandby
    ? `INSTANCE: You are running on Render (cloud). You do NOT have access to the Mac Mini filesystem or shell. run_shell, read_file, write_file, and list_directory will not work here. If Joe needs shell-level Mac Mini access, tell him to use !build in Slack or SSH via Termius.`
    : `INSTANCE: You are running on the Mac Mini (Agents-Mac-mini.local, user: agentserver). You have full shell access via run_shell, and can read/write files on the local filesystem.`;

  return `You are Jin, Chief of Staff to Joe Ko — founder and CEO of 88 Venture Studio.

Your personality: sharp, warm, and direct. You think fast, speak plainly, and care about getting things right. You have a dry sense of humor when the moment calls for it. You're not a tool — you're a trusted member of the team who happens to know everything.

How to communicate:
- Write like a smart person texting, not like a consultant writing a report. Natural prose, not bullet lists, unless a list genuinely serves the content.
- Don't use headers for simple responses. Save structure for when it actually helps (long breakdowns, comparisons, step-by-step instructions).
- Be concise. Joe is busy. Lead with the answer, then explain if he needs more.
- Warm but direct — no corporate fluff, no unnecessary hedging.
- When you need clarification, ask one question. Not three.
- When an image or screenshot is shared, describe what you see and respond to what's relevant — don't over-narrate it.
- When a URL is shared, use the page content to inform your response naturally.

How to think:
- Design thinker first: user-centered, assumption-testing, first-principles.
- Know the difference between triage mode (J.Adams inventory/legal), pivot mode (J.Adams brand), and build mode (CCS template, AI infrastructure).
- Protect fragile relationships — Boley and Pediped are cash flow lifelines. Flag risks before acting.
- When Joe brings a problem, help him find the real assumption being tested, not just the surface question.
- You can help with anything: strategy, writing, analysis, prioritization, drafting emails, thinking through hard decisions, research, and more.

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
${instanceInfo}

${sessionLog ? `─────────────────────────────────────────
PREVIOUS SESSION LOG (what we built, what's pending)
─────────────────────────────────────────

${sessionLog}

` : ''}${memoryContext ? `─────────────────────────────────────────
LONG-TERM MEMORY (Jin's memory system)
─────────────────────────────────────────

${memoryContext}

` : ''}─────────────────────────────────────────
BUSINESS CONTEXT (loaded from Google Drive)
─────────────────────────────────────────

${driveContext}`;
}

async function callClaude(systemPrompt, history, userContent) {
  const messageContent = typeof userContent === 'string' ? userContent : userContent.content;
  const messages = [...history, { role: 'user', content: messageContent }];

  let response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools: TOOLS,
  });

  // Agentic loop — keep going while Claude wants to use tools
  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      console.log(`  → Tool: ${block.name}`, JSON.stringify(block.input).slice(0, 120));
      const result = await executeTool(block.name, block.input);
      console.log(`  ← ${String(result).slice(0, 120)}`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(result),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    });
  }

  return response.content.find((b) => b.type === 'text')?.text || '(no response)';
}

// ─── Conversation History ─────────────────────────────────────────────────────

const HISTORY_PATH = './conversation-history.json';
let messagesSinceLastDriveSync = 0;
const DRIVE_SYNC_EVERY = 5; // sync to Drive every N messages

function loadHistoryFromDisk() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      console.log(`  ✓ Loaded conversation history from disk (${Object.keys(data).length} thread(s))`);
      return new Map(Object.entries(data));
    }
  } catch (err) {
    console.warn('  ✗ Could not load conversation history:', err.message);
  }
  return new Map();
}

function saveHistoryToDisk(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not save conversation history:', err.message);
  }
}

const threadHistories = loadHistoryFromDisk();

function getHistory(threadKey) {
  if (!threadHistories.has(threadKey)) threadHistories.set(threadKey, []);
  return threadHistories.get(threadKey);
}

function appendHistory(threadKey, role, content) {
  const history = getHistory(threadKey);
  const stored = typeof content === 'string' ? content : content.historyText || '[message]';
  history.push({ role, content: stored });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  saveHistoryToDisk(threadHistories);

  // Async Drive sync every N messages (non-blocking)
  messagesSinceLastDriveSync++;
  if (messagesSinceLastDriveSync >= DRIVE_SYNC_EVERY) {
    messagesSinceLastDriveSync = 0;
    saveHistoryToDrive(threadHistories).catch(() => {});
  }
}

// ─── Memory Consolidation ─────────────────────────────────────────────────────

const inactivityTimers = new Map();
const lastConsolidatedAt = new Map();
const INACTIVITY_MS = 2 * 60 * 1000;

async function consolidateMemory(threadKey) {
  const history = getHistory(threadKey);
  if (history.length === 0) return;

  // Don't re-consolidate if we just did it
  const lastDone = lastConsolidatedAt.get(threadKey) || 0;
  if (Date.now() - lastDone < 30000) return;

  try {
    const recent = history.slice(-12).map(m => `${m.role}: ${m.content}`).join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are Jin, Chief of Staff to Joe Ko at 88 Venture Studio. Review this conversation and extract ONLY what's worth saving to long-term memory — decisions made, strategic shifts, new business context, tasks started or completed, relationship changes. Prioritize items with a clear revenue or margin path. Be concise. If nothing is worth saving, output nothing.

Conversation:
${recent}`,
      }],
    });

    const summary = response.content[0].text.trim();
    if (!summary || summary.length < 20) return;

    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    const entry = `\n--- ${timestamp} ---\n${summary}`;

    // Write locally (Claude Code ↔ Slack sync)
    fs.appendFileSync('./session-log.txt', `\n${entry}\n`, 'utf8');

    // Write to Drive Live Log
    await appendToGoogleDoc(MEMORY_IDS.liveLog, `\n${entry}\n`);

    lastConsolidatedAt.set(threadKey, Date.now());
    console.log(`  ✓ Memory consolidated for thread ${threadKey}`);
  } catch (err) {
    console.warn('Memory consolidation failed:', err.message);
  }
}

function scheduleConsolidation(threadKey) {
  if (inactivityTimers.has(threadKey)) clearTimeout(inactivityTimers.get(threadKey));
  const timer = setTimeout(() => {
    consolidateMemory(threadKey);
    inactivityTimers.delete(threadKey);
  }, INACTIVITY_MS);
  inactivityTimers.set(threadKey, timer);
}

// ─── Thinking Indicator ───────────────────────────────────────────────────────

const ACK_PHRASES = [
  'on it...',
  'got it, one sec...',
  'thinking...',
  'on it, give me a moment...',
  'reading this...',
  'let me think on that...',
  'got it...',
  'on it...',
];

function randomAck() {
  return ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage({ text, files, channel, thread_ts, ts, client, systemPrompt, botToken }) {
  const isDM = channel.startsWith('D');
  const threadKey = thread_ts || channel;
  const replyInThread = !isDM && (thread_ts || ts);

  // Standby mode: only respond if Mac Mini heartbeat is stale (Mac Mini is down).
  if (process.env.INSTANCE_ROLE === 'standby') {
    const macMiniAlive = await checkMacMiniAlive();
    if (macMiniAlive) return; // Mac Mini is up — stay silent
    // Mac Mini is down — fall through and respond as fallback
    systemPrompt = systemPrompt + '\n\n⚠️ FALLBACK MODE: Mac Mini is currently offline. You are responding from Render (cloud). You have Gmail and Calendar access but no shell or filesystem access. Let Joe know you\'re in fallback mode and what you can and can\'t help with.';
  }

  // Post immediate ack
  const ackPayload = { channel, text: randomAck() };
  if (replyInThread) ackPayload.thread_ts = replyInThread;
  const ackMsg = await client.chat.postMessage(ackPayload);

  try {
    const userContent = await buildUserContent(text, files, botToken);
    const history = getHistory(threadKey);
    const reply = await callClaude(systemPrompt, history, userContent);

    appendHistory(threadKey, 'user', userContent);
    appendHistory(threadKey, 'assistant', reply);

    await client.chat.update({ channel, ts: ackMsg.ts, text: reply });
    scheduleConsolidation(threadKey);
  } catch (err) {
    console.error('Error:', err.message);
    await client.chat.update({ channel, ts: ackMsg.ts, text: `Sorry, I hit an error: ${err.message}` });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Resolve Drive history file and load shared history (overrides local if available)
  await resolveHistoryDriveFile();
  const driveHistory = await loadHistoryFromDrive();
  if (driveHistory) {
    // Merge Drive history into local (Drive is authoritative)
    for (const [key, val] of driveHistory.entries()) {
      threadHistories.set(key, val);
    }
    saveHistoryToDisk(threadHistories);
  }

  let driveContext = '';
  try {
    driveContext = await loadDriveContext();
  } catch (err) {
    console.warn('Could not load Drive context:', err.message);
    driveContext = '(Drive context unavailable)';
  }

  const sessionLog = loadSessionLog();
  let memoryContext = '';
  try {
    memoryContext = await loadMemoryContext();
  } catch (err) {
    console.warn('Could not load memory context:', err.message);
  }
  const context = {
    systemPrompt: buildSystemPrompt(driveContext, sessionLog, memoryContext),
    driveContext,
    memoryContext,
  };
  const botToken = process.env.SLACK_BOT_TOKEN;

  const app = new App({
    token: botToken,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // DMs and channel messages
  app.message(async ({ message, client }) => {
    // Allow file_share (image/file only, no text) but skip edits, deletions, etc.
    const allowedSubtypes = [undefined, null, 'file_share'];
    if (!allowedSubtypes.includes(message.subtype)) return;
    if (!message.text && !message.files) return;

    // !reload — re-read session log and rebuild system prompt without restarting
    if (message.text?.trim() === '!reload') {
      const freshLog = loadSessionLog();
      context.systemPrompt = buildSystemPrompt(context.driveContext, freshLog, context.memoryContext);
      await client.chat.postMessage({ channel: message.channel, text: 'Reloaded. I\'m current.' });
      return;
    }

    // !digest — compress Live Log into Weekly Digest, mark log as digested
    if (message.text?.trim() === '!digest') {
      await client.chat.postMessage({ channel: message.channel, text: 'On it — reading the live log...' });
      try {
        const drive = getDriveClient();
        const res = await drive.files.export(
          { fileId: MEMORY_IDS.liveLog, mimeType: 'text/plain' },
          { responseType: 'text' }
        );
        const liveLogContent = (res.data || '').trim();
        if (!liveLogContent) {
          await client.chat.postMessage({ channel: message.channel, text: 'Live log is empty — nothing to digest.' });
          return;
        }

        const digestResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `You are Jin, Chief of Staff to Joe Ko at 88 Venture Studio. Here are recent Live Log entries from conversations with Joe. Write a concise weekly digest entry: the most important decisions made, strategic context shifts, and business insights — especially anything with revenue or margin implications. Compress aggressively. Format as flowing prose with a date header, not bullets.

Live Log:
${liveLogContent.slice(-6000)}`,
          }],
        });

        const digest = digestResponse.content[0].text.trim();
        const week = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const digestEntry = `\n\n=== Week of ${week} ===\n${digest}`;
        const marker = `\n\n--- DIGESTED ${week} ---\n`;

        await appendToGoogleDoc(MEMORY_IDS.weeklyDigest, digestEntry);
        await appendToGoogleDoc(MEMORY_IDS.liveLog, marker);

        // Reload memory context so next messages use the new digest
        context.memoryContext = await loadMemoryContext();
        context.systemPrompt = buildSystemPrompt(context.driveContext, loadSessionLog(), context.memoryContext);

        await client.chat.postMessage({ channel: message.channel, text: `Done. Weekly digest written to Drive for ${week}.` });
      } catch (err) {
        console.error('Digest failed:', err.message);
        await client.chat.postMessage({ channel: message.channel, text: `Digest failed: ${err.message}` });
      }
      return;
    }

    // !build <task> — spawn Claude Code to execute a build task on the Mac Mini
    if (message.text?.trim().startsWith('!build ')) {
      const task = message.text.trim().slice(7).trim();
      const ackMsg = await client.chat.postMessage({
        channel: message.channel,
        text: `Starting Claude Code: "${task.slice(0, 80)}${task.length > 80 ? '...' : ''}"`,
      });
      try {
        const output = await runClaudeCode(task, '/Users/agentserver/studio88-agent');
        const reply = output || '(done — no output)';
        // Slack has a 3000 char limit on chat.update text
        await client.chat.update({ channel: message.channel, ts: ackMsg.ts, text: reply.slice(0, 2900) });
        if (reply.length > 2900) {
          await client.chat.postMessage({ channel: message.channel, text: reply.slice(2900) });
        }
      } catch (err) {
        await client.chat.update({ channel: message.channel, ts: ackMsg.ts, text: `Build failed: ${err.message}` });
      }
      return;
    }

    await handleMessage({
      text: message.text || '',
      files: message.files,
      channel: message.channel,
      thread_ts: message.thread_ts,
      ts: message.ts,
      client,
      systemPrompt: context.systemPrompt,
      botToken,
    });
  });

  // @mentions in channels
  app.event('app_mention', async ({ event, client }) => {
    const text = (event.text || '').replace(/<@[^>]+>/g, '').trim();

    await handleMessage({
      text,
      files: event.files,
      channel: event.channel,
      thread_ts: event.thread_ts,
      ts: event.ts,
      client,
      systemPrompt: context.systemPrompt,
      botToken,
    });
  });

  await app.start();
  console.log('\nJin is running.');
  console.log('Supports: text, images/screenshots, website URLs, Google Drive/Docs links');
  console.log('Memory: Live Log + Weekly Digest loaded at startup, auto-written after conversations\n');

  // Health check server for Railway (expects something on PORT)
  const port = process.env.PORT || 3000;
  http.createServer((req, res) => res.end('Jin is alive.')).listen(port);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
