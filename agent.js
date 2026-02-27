/**
 * Jin — Chief of Staff Agent
 * Slack (Socket Mode) + Claude claude-sonnet-4-6 + Google Drive context
 * Supports: text, images, URLs, Drive links, web search, browser, screenshots, YouTube, PDFs
 *
 * Usage: node agent.js
 */

require('dotenv').config();
const { App, SocketModeReceiver, ExpressReceiver } = require('@slack/bolt');
const { SocketModeClient } = require('@slack/socket-mode');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const mammoth = require('mammoth');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');
// playwright import removed — browser automation now handled by Playwright MCP server
const { YoutubeTranscript } = require('youtube-transcript');
const pdfParse = require('pdf-parse');
const { Client: MCPClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

// ─── MCP Server Configuration ────────────────────────────────────────────────

const MCP_SERVERS = [
  {
    name: 'brave-search',
    command: 'npx',
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: process.env.BRAVE_SEARCH_API_KEY },
  },
  {
    name: 'playwright',
    command: 'npx',
    args: ['-y', '@playwright/mcp', '--headless'],
  },
];

// MCP client instances and tool registry (populated at startup)
const mcpClients = new Map();    // serverName → MCPClient
const mcpToolMap = new Map();    // toolName → serverName
let mcpTools = [];               // Anthropic-format tool definitions from MCP servers

async function connectMCPServers() {
  for (const server of MCP_SERVERS) {
    try {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...(server.env || {}) },
      });
      const client = new MCPClient(
        { name: 'jin', version: '1.0.0' },
        { capabilities: {} }
      );
      await client.connect(transport);

      // Fetch tools from this server
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const anthropicTool = {
          name: tool.name,
          description: tool.description || '',
          input_schema: tool.inputSchema,
        };
        mcpTools.push(anthropicTool);
        mcpToolMap.set(tool.name, server.name);
      }
      mcpClients.set(server.name, client);
      console.log(`  ✓ MCP: ${server.name} connected (${tools.length} tools)`);
    } catch (err) {
      console.error(`  ✗ MCP: ${server.name} failed: ${err.message}`);
    }
  }
}

async function callMCPTool(toolName, input) {
  const serverName = mcpToolMap.get(toolName);
  if (!serverName) return `Unknown MCP tool: ${toolName}`;
  const client = mcpClients.get(serverName);
  if (!client) return `MCP server ${serverName} not connected`;
  const result = await client.callTool({ name: toolName, arguments: input });
  // MCP returns { content: [{ type: 'text', text: '...' }, ...] }
  if (result.content && Array.isArray(result.content)) {
    return result.content.map(c => c.text || JSON.stringify(c)).join('\n');
  }
  return JSON.stringify(result);
}

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
const MAX_URL_CHARS = 8000; // max chars to include per fetched URL
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

const MEMORY_BACKUP_FILES = {
  'MEMORY.md': null,  // Drive file IDs, resolved at startup
  'JOE.md': null,
  'CULTURE.md': null,
};

const HEARTBEAT_DRIVE_FILENAME = 'jin-heartbeat.json';
const HEARTBEAT_STALENESS_MS = 30 * 60 * 1000; // 30 minutes — Hetzner standby only activates after Mac Mini has been silent this long
let heartbeatFileId = null; // cached at first check

const GMAIL_TOKENS_PATH = './gmail-tokens.json';
const JIN_TOKENS_PATH = process.env.JIN_GMAIL_TOKENS || './jin-gmail-tokens.json';

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

function getJinOAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost'
  );
  let tokens;
  try {
    if (fs.existsSync(JIN_TOKENS_PATH)) {
      tokens = JSON.parse(fs.readFileSync(JIN_TOKENS_PATH, 'utf8'));
    } else {
      throw new Error('Jin tokens file not found');
    }
  } catch (err) {
    console.warn('  ✗ getJinOAuthClient failed:', err.message, '— falling back to Joe OAuth');
    return getOAuthClient();
  }
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    fs.writeFileSync(JIN_TOKENS_PATH, JSON.stringify(updated, null, 2), 'utf8');
    tokens = updated;
  });
  return oauth2Client;
}

function getDriveClientOAuth() {
  return google.drive({ version: 'v3', auth: getOAuthClient() });
}

// Strip leading language hints (e.g. "json\n") that some hosting envs prepend to env var values
function parseEnvJson(val) {
  return JSON.parse(val.replace(/^[a-zA-Z]+\s*\n/, '').trim());
}

// ─── Google Auth ──────────────────────────────────────────────────────────────

const JIN_EMAIL = 'jin@studio-88.com';

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
];

function getServiceAccountKey() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return parseEnvJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  }
  return null;
}

// Service account impersonating Jin — for Jin's own Drive, Gmail, Calendar
// Falls back to Joe's OAuth if delegation isn't active yet
let jinDelegationActive = null; // null = untested, true/false = cached result

function getJinAuth() {
  const key = getServiceAccountKey();
  if (!key || jinDelegationActive === false) {
    // Delegation not available — use Jin's own OAuth tokens
    return getJinOAuthClient();
  }
  return new google.auth.GoogleAuth({
    credentials: key,
    scopes: GOOGLE_SCOPES,
    clientOptions: { subject: JIN_EMAIL },
  });
}

// Test delegation on startup and cache result
async function testJinDelegation() {
  // First try service account delegation
  try {
    const key = getServiceAccountKey();
    if (!key) throw new Error('no service account key');
    const auth = new google.auth.GoogleAuth({
      credentials: key,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      clientOptions: { subject: JIN_EMAIL },
    });
    const drive = google.drive({ version: 'v3', auth });
    await drive.about.get({ fields: 'user' });
    jinDelegationActive = true;
    console.log(`  ✓ Jin delegation active (${JIN_EMAIL})`);
    return;
  } catch {
    jinDelegationActive = false;
  }

  // Delegation failed — test Jin's own OAuth tokens
  try {
    const jinAuth = getJinOAuthClient();
    const drive = google.drive({ version: 'v3', auth: jinAuth });
    const about = await drive.about.get({ fields: 'user' });
    const email = about.data.user?.emailAddress || 'unknown';
    console.log(`  ✓ Jin OAuth active (${email})`);
  } catch (err) {
    console.log(`  ⚠ Jin auth failed: ${err.message} — falling back to Joe's OAuth`);
  }
}

// Service account impersonating Joe — for reading Joe's inbox, calendar
function getJoeAuth() {
  // Fall back to OAuth tokens for Joe's personal account
  return getOAuthClient();
}

// Service account without impersonation — for shared Drive docs
function getGoogleAuthClient() {
  const key = getServiceAccountKey();
  if (key) return new google.auth.GoogleAuth({ credentials: key, scopes: GOOGLE_SCOPES });
  return getOAuthClient();
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getGoogleAuthClient() });
}

function getJinDriveClient() {
  return google.drive({ version: 'v3', auth: getJinOAuthClient() });
}

// ─── QuickBooks Online API ───────────────────────────────────────────────────

const QBO_TOKENS_PATH = './qbo-tokens.json';

function loadQBOTokens() {
  try { return JSON.parse(fs.readFileSync(QBO_TOKENS_PATH, 'utf8')); } catch { return {}; }
}

function saveQBOTokens(allTokens) {
  fs.writeFileSync(QBO_TOKENS_PATH, JSON.stringify(allTokens, null, 2), 'utf8');
}

// Resolve a company name to a realmId (fuzzy match)
function resolveRealm(companyHint) {
  const allTokens = loadQBOTokens();
  const realms = Object.keys(allTokens);
  if (realms.length === 0) return null;
  if (!companyHint) return realms[0]; // default to first
  // Check if it's already a realmId
  if (allTokens[companyHint]) return companyHint;
  // Try cached company names
  const hint = companyHint.toLowerCase();
  for (const r of realms) {
    const name = (allTokens[r].companyName || '').toLowerCase();
    if (name.includes(hint) || hint.includes(name)) return r;
  }
  return realms[0]; // fallback to first
}

// Refresh QBO access token if needed
async function refreshQBOToken(realmId) {
  const allTokens = loadQBOTokens();
  const t = allTokens[realmId];
  if (!t || !t.refresh_token) throw new Error(`No QBO tokens for realm ${realmId}`);

  const basicAuth = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const postData = `grant_type=refresh_token&refresh_token=${encodeURIComponent(t.refresh_token)}`;

  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const newTokens = JSON.parse(body);
          if (newTokens.error) return reject(new Error(newTokens.error));
          allTokens[realmId] = { ...allTokens[realmId], ...newTokens, refreshed_at: new Date().toISOString() };
          saveQBOTokens(allTokens);
          resolve(allTokens[realmId]);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Make a QBO API call with automatic token refresh
async function qboRequest(realmId, path, method = 'GET') {
  const allTokens = loadQBOTokens();
  let t = allTokens[realmId];
  if (!t) throw new Error(`No QBO tokens for realm ${realmId}`);

  const doRequest = (accessToken) => new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'quickbooks.api.intuit.com',
      path: `/v3/company/${realmId}${path}`,
      method,
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

  let result = await doRequest(t.access_token);
  // If 401, refresh and retry once
  if (result.statusCode === 401) {
    t = await refreshQBOToken(realmId);
    result = await doRequest(t.access_token);
  }
  const data = JSON.parse(result.body);
  if (data.Fault) throw new Error(data.Fault.Error?.map(e => e.Detail || e.Message).join('; ') || 'QBO API error');
  return data;
}

// QBO query helper (SELECT ... FROM ...)
async function qboQuery(realmId, query) {
  return qboRequest(realmId, `/query?query=${encodeURIComponent(query)}`);
}

// QBO report helper
async function qboReport(realmId, reportName, params = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return qboRequest(realmId, `/reports/${reportName}${qs ? '?' + qs : ''}`);
}

// Format a QBO report into readable text
function formatQBOReport(report) {
  const header = report.Header;
  const lines = [`${header.ReportName} — ${header.ReportBasis || ''}`];
  if (header.StartPeriod) lines.push(`Period: ${header.StartPeriod} to ${header.EndPeriod}`);
  if (header.DateMacro) lines.push(`Date: ${header.DateMacro}`);
  lines.push('');

  const cols = (report.Columns?.Column || []).map(c => c.ColTitle || '');

  function walkRows(rows, indent = 0) {
    for (const row of rows) {
      if (row.Header?.ColData) {
        const vals = row.Header.ColData.map(c => c.value || '');
        lines.push('  '.repeat(indent) + vals.filter(Boolean).join('  '));
      }
      if (row.ColData) {
        const vals = row.ColData.map(c => c.value || '');
        lines.push('  '.repeat(indent) + vals.filter(Boolean).join('  '));
      }
      if (row.Rows?.Row) walkRows(row.Rows.Row, indent + 1);
      if (row.Summary?.ColData) {
        const vals = row.Summary.ColData.map(c => c.value || '');
        lines.push('  '.repeat(indent) + vals.filter(Boolean).join('  '));
        lines.push('');
      }
    }
  }

  if (report.Rows?.Row) walkRows(report.Rows.Row);
  return lines.join('\n');
}

// Cache company names on first lookup
async function cacheCompanyNames() {
  const allTokens = loadQBOTokens();
  for (const realm of Object.keys(allTokens)) {
    if (allTokens[realm].companyName) continue;
    try {
      const data = await qboRequest(realm, `/companyinfo/${realm}`);
      if (data.CompanyInfo) {
        allTokens[realm].companyName = data.CompanyInfo.CompanyName;
        saveQBOTokens(allTokens);
      }
    } catch {}
  }
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

async function clearGoogleDoc(docId) {
  try {
    const auth = getGoogleAuthClient();
    const docs = google.docs({ version: 'v1', auth });
    const doc = await docs.documents.get({ documentId: docId });
    const endIndex = doc.data.body.content.slice(-1)[0]?.endIndex;
    if (!endIndex || endIndex <= 2) return; // already empty
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          deleteContentRange: {
            range: { startIndex: 1, endIndex: endIndex - 1, segmentId: '' },
          },
        }],
      },
    });
  } catch (err) {
    console.warn(`  ✗ Failed to clear doc ${docId}: ${err.message}`);
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

// ─── Drive Memory File Backups ────────────────────────────────────────────────

async function resolveMemoryBackupFiles() {
  const drive = getDriveClientOAuth();
  for (const name of Object.keys(MEMORY_BACKUP_FILES)) {
    const driveName = `jin-memory-${name}`;
    try {
      const res = await drive.files.list({
        q: `name='${driveName}' and '${AI_HUB_FOLDER_ID}' in parents and trashed=false`,
        fields: 'files(id)',
      });
      if (res.data.files.length > 0) {
        MEMORY_BACKUP_FILES[name] = res.data.files[0].id;
        console.log(`  ✓ Found Drive backup: ${driveName}`);
      } else {
        const content = fs.existsSync(`./memory/${name}`) ? fs.readFileSync(`./memory/${name}`, 'utf8') : '';
        const created = await drive.files.create({
          requestBody: { name: driveName, parents: [AI_HUB_FOLDER_ID], mimeType: 'text/plain' },
          media: { mimeType: 'text/plain', body: content },
          fields: 'id',
        });
        MEMORY_BACKUP_FILES[name] = created.data.id;
        console.log(`  ✓ Created Drive backup: ${driveName}`);
      }
    } catch (err) {
      console.warn(`  ✗ Could not resolve ${driveName}:`, err.message);
    }
  }
}

async function syncMemoryFilesToDrive() {
  const drive = getDriveClientOAuth();
  for (const [name, fileId] of Object.entries(MEMORY_BACKUP_FILES)) {
    if (!fileId) continue;
    try {
      const content = fs.existsSync(`./memory/${name}`) ? fs.readFileSync(`./memory/${name}`, 'utf8') : '';
      await drive.files.update({
        fileId,
        media: { mimeType: 'text/plain', body: content },
      });
    } catch (err) {
      console.warn(`  ✗ Failed to sync ${name} to Drive:`, err.message);
    }
  }
  console.log('  ✓ Memory files synced to Drive');
}

function loadSessionLog() {
  const logPath = './session-log.txt';
  if (fs.existsSync(logPath)) {
    const content = fs.readFileSync(logPath, 'utf8');
    // Only load the last 3000 chars — it's an ops log, not full history
    const tail = content.slice(-3000);
    console.log('  ✓ Loaded: session log (tail)');
    return tail;
  }
  return null;
}

function getVaultStats() {
  const categories = ['people', 'brands', 'strategy', 'operations', 'finance'];
  const counts = [];
  let total = 0;
  for (const cat of categories) {
    const dir = path.join('/Users/agentserver/jin-vault', cat);
    if (fs.existsSync(dir)) {
      const count = fs.readdirSync(dir).filter(f => f.endsWith('.md')).length;
      if (count > 0) counts.push(`${cat}: ${count}`);
      total += count;
    }
  }
  return total > 0 ? `${total} notes (${counts.join(', ')})` : 'empty';
}

function loadMemoryFiles() {
  const files = ['SOUL.md', 'JOE.md', 'MEMORY.md', 'CULTURE.md'];
  const result = {};
  for (const name of files) {
    const p = `./memory/${name}`;
    if (fs.existsSync(p)) {
      result[name] = fs.readFileSync(p, 'utf8');
      console.log(`  ✓ Loaded: memory/${name}`);
    } else {
      console.warn(`  ✗ Not found: memory/${name}`);
      result[name] = '';
    }
  }
  return result;
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
async function downloadSlackFile(url, botToken, useAuth = true) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = useAuth ? { Authorization: `Bearer ${botToken}` } : {};
    const req = lib.get(url, { headers }, (res) => {
      // Follow redirects — drop auth header since redirect URLs are pre-signed
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadSlackFile(res.headers.location, botToken, false).then(resolve).catch(reject);
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

async function fetchViaJina(url) {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const text = await fetchUrl(jinaUrl);
    if (text && text.length > 100) return text;
  } catch {}
  return null;
}

async function fetchUrlContent(url) {
  try {
    // Route Drive/Docs URLs through the authenticated Drive API
    if (extractDriveFileId(url)) {
      const text = await fetchDriveUrl(url);
      if (text) console.log(`  ✓ Drive URL fetched: ${url}`);
      return text ? text.slice(0, MAX_URL_CHARS) : null;
    }

    // Try Jina Reader first for cleaner content extraction
    const jinaText = await fetchViaJina(url);
    if (jinaText) {
      console.log(`  ✓ Jina Reader fetched: ${url}`);
      return jinaText.slice(0, MAX_URL_CHARS);
    }

    // Fall back to direct fetch + HTML stripping
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

  // Process file attachments from Slack
  const allFiles = (files || []).filter((f) => f.url_private_download);

  for (const file of allFiles) {
    const isImage = file.mimetype?.startsWith('image/');
    if (isImage) {
      try {
        const { base64, mimeType } = await downloadSlackFile(file.url_private_download, botToken);
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64 },
        });
        console.log(`  ✓ Image loaded: ${file.name || file.id}`);
      } catch (err) {
        console.warn(`  ✗ Failed to load image: ${err.message}`);
      }
    }
    // Always include file metadata so Jin can reference the file in tool calls
    // (e.g. upload_slack_file_to_drive). Include file ID so the tool can look up the real URL.
    const fileMeta = `[Slack file: id="${file.id}", name="${file.name || 'file'}", type="${file.mimetype || 'unknown'}"]`;
    historyText += historyText ? ` ${fileMeta}` : fileMeta;
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
    description: 'Create a new file, Google Doc, Google Sheet, or folder in Google Drive. Created as Jin.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name (e.g. "Q1 Plan" for a Doc, "Budget" for a Sheet, "Projects" for a folder)' },
        content: { type: 'string', description: 'Initial content (optional — for text files and Google Docs)' },
        type: { type: 'string', enum: ['text', 'document', 'spreadsheet', 'folder'], description: 'File type: text (plain text), document (Google Doc), spreadsheet (Google Sheet), folder. Default: text.' },
        folder_id: { type: 'string', description: 'Parent folder ID (default: AI Hub folder)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'upload_slack_file_to_drive',
    description: 'Download a file from Slack (image, PDF, etc.) and upload it to Google Drive. Use when a user shares a file in Slack and you need to save or share it via Drive link. Use the exact slack_file_id from the [Slack file: ...] metadata in the message — never guess or construct a file ID.',
    input_schema: {
      type: 'object',
      properties: {
        slack_file_id: { type: 'string', description: 'The Slack file ID (e.g. "F0AH22XL5GD") from the [Slack file: ...] metadata' },
        filename: { type: 'string', description: 'Name for the file in Drive (e.g. "screenshot.png")' },
        folder_id: { type: 'string', description: 'Parent folder ID (default: AI Hub folder)' },
      },
      required: ['slack_file_id', 'filename'],
    },
  },
  {
    name: 'list_drive_files',
    description: 'List files in any Google Drive folder. Defaults to the AI Hub folder.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'Folder ID to list (default: AI Hub folder)' },
        query: { type: 'string', description: 'Optional search filter (e.g. "name contains \'report\'" or "mimeType=\'application/vnd.google-apps.folder\'")' },
      },
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
    description: 'Send an email via Jin\'s Gmail (jin@studio-88.com).',
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
    description: 'Get upcoming events from Jin\'s Google Calendar.',
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
    description: 'Create a new event on Jin\'s Google Calendar. Sends invites to attendees automatically.',
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
  // web_search, browse_web, screenshot_webpage removed — now provided by MCP servers
  // (Brave Search MCP for web search, Playwright MCP for browsing/screenshots)
  {
    name: 'get_youtube_transcript',
    description: 'Extract the transcript/captions from a YouTube video. Use for analyzing competitor ads, product reviews, training videos, or any YouTube content.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'YouTube video URL or video ID' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fetch_pdf',
    description: 'Download and extract text from a PDF file at a URL. Use for reading contracts, supplier docs, brand guides, reports, etc.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL of the PDF file' },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_slack',
    description: 'Search Slack messages across all channels and DMs. Find past conversations, decisions, links, or anything discussed in Slack.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (supports Slack search syntax: from:@user, in:#channel, before:2026-01-01, has:link, etc.)' },
        count: { type: 'number', description: 'Number of results (default 10, max 50)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_slack_message',
    description: 'Send a Slack message to any channel or DM. Use for proactive updates, cross-team communication, or reaching specific people.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name (e.g. #general), channel ID, or user ID for DM' },
        text: { type: 'string', description: 'Message text (supports Slack mrkdwn formatting)' },
      },
      required: ['channel', 'text'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder that Jin will send to Joe at a specific time. Use for follow-ups, deadlines, or scheduled check-ins.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Reminder message' },
        time: { type: 'string', description: 'When to remind — ISO datetime (2026-02-24T09:00:00-08:00), relative ("in 2 hours", "tomorrow at 9am"), or Unix timestamp' },
      },
      required: ['text', 'time'],
    },
  },
  {
    name: 'write_sheet',
    description: 'Write or update data in a Google Sheet. Can append rows, update specific cells, or clear and rewrite a range.',
    input_schema: {
      type: 'object',
      properties: {
        url_or_id: { type: 'string', description: 'Google Sheets URL or file ID' },
        range: { type: 'string', description: 'Cell range in A1 notation (e.g. "Sheet1!A1:C10", "A1", "Sheet1!A:A"). For appending, use just the sheet name.' },
        values: { type: 'string', description: 'JSON array of rows, e.g. [["Name","Email"],["Joe","joe@test.com"]]' },
        mode: { type: 'string', description: '"update" to overwrite the range, "append" to add rows after existing data (default: "update")' },
      },
      required: ['url_or_id', 'range', 'values'],
    },
  },
  {
    name: 'read_drive_file',
    description: 'Read any file from Google Drive by file ID or URL. Works with Docs, Sheets, PDFs, text files, and more.',
    input_schema: {
      type: 'object',
      properties: {
        file_id_or_url: { type: 'string', description: 'Google Drive file ID or full URL (docs.google.com/..., drive.google.com/...)' },
      },
      required: ['file_id_or_url'],
    },
  },
  {
    name: 'update_drive_file',
    description: 'Update the content of an existing file in Google Drive. Works with text files and Google Docs.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'Google Drive file ID' },
        content: { type: 'string', description: 'New content to write (replaces existing content for text files, appends for Google Docs)' },
        mode: { type: 'string', description: '"replace" to overwrite, "append" to add to the end (default: "replace")' },
      },
      required: ['file_id', 'content'],
    },
  },
  {
    name: 'move_drive_file',
    description: 'Move a file or folder to a different location in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to move' },
        destination_folder_id: { type: 'string', description: 'Destination folder ID' },
      },
      required: ['file_id', 'destination_folder_id'],
    },
  },
  {
    name: 'rename_drive_file',
    description: 'Rename a file or folder in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to rename' },
        new_name: { type: 'string', description: 'New name for the file or folder' },
      },
      required: ['file_id', 'new_name'],
    },
  },
  {
    name: 'share_drive_file',
    description: 'Share a Google Drive file or folder with specific people or via link. Returns the sharing link.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to share' },
        email: { type: 'string', description: 'Email address to share with (omit for link sharing only)' },
        role: { type: 'string', enum: ['reader', 'writer', 'commenter'], description: 'Permission role (default: reader)' },
        anyone_with_link: { type: 'boolean', description: 'If true, anyone with the link can access (default false)' },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'delete_drive_file',
    description: 'Delete (trash) a file or folder in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'File or folder ID to delete' },
      },
      required: ['file_id'],
    },
  },
  // ─── QuickBooks Online Tools ──────────────────────────────────────────────
  {
    name: 'qbo_companies',
    description: 'List all connected QuickBooks Online companies with their names and realm IDs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'qbo_profit_loss',
    description: 'Get a Profit & Loss (income statement) report from QuickBooks. Shows revenue, expenses, and net income.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId (e.g. "88 Venture", "Sun Bay", "Bonsai"). Defaults to first connected company.' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: start of current month)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        summarize_by: { type: 'string', description: 'Summarize by: Total, Month, Week, Days, Quarter, Year (default: Total)' },
      },
    },
  },
  {
    name: 'qbo_balance_sheet',
    description: 'Get a Balance Sheet report from QuickBooks. Shows assets, liabilities, and equity.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        date: { type: 'string', description: 'As-of date YYYY-MM-DD (default: today)' },
      },
    },
  },
  {
    name: 'qbo_cashflow',
    description: 'Get a Cash Flow statement from QuickBooks.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: start of current month)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
      },
    },
  },
  {
    name: 'qbo_invoices',
    description: 'List invoices from QuickBooks. Filter by status (open, overdue, paid) or customer.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        status: { type: 'string', enum: ['open', 'overdue', 'paid', 'all'], description: 'Filter by status (default: open)' },
        customer: { type: 'string', description: 'Filter by customer name (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'qbo_bills',
    description: 'List bills (accounts payable) from QuickBooks. See what the company owes.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        status: { type: 'string', enum: ['unpaid', 'paid', 'overdue', 'all'], description: 'Filter by status (default: unpaid)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'qbo_accounts',
    description: 'List chart of accounts from QuickBooks with current balances.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        type: { type: 'string', description: 'Filter by account type: Bank, CreditCard, Income, Expense, etc. (optional)' },
      },
    },
  },
  {
    name: 'qbo_transactions',
    description: 'Search recent transactions across all types (invoices, bills, payments, deposits, etc.).',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD (default: 30 days ago)' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD (default: today)' },
        entity: { type: 'string', description: 'Entity type to query: Invoice, Bill, Payment, Deposit, Purchase, JournalEntry, SalesReceipt, Transfer (default: all recent)' },
        limit: { type: 'number', description: 'Max results (default 25)' },
      },
    },
  },
  {
    name: 'qbo_customers',
    description: 'List customers from QuickBooks with contact info and balances.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
      },
    },
  },
  {
    name: 'qbo_vendors',
    description: 'List vendors from QuickBooks with contact info and balances.',
    input_schema: {
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name or realmId' },
      },
    },
  },
  // ─── End QBO Tools ──────────────────────────────────────────────────────────
  {
    name: 'reply_email',
    description: 'Reply to an existing email thread in Gmail. Keeps the conversation threaded properly.',
    input_schema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'The Gmail message ID to reply to (from read_gmail results)' },
        body: { type: 'string', description: 'Reply body text' },
        cc: { type: 'string', description: 'CC email address (optional)' },
      },
      required: ['message_id', 'body'],
    },
  },
  {
    name: 'list_slack_channels',
    description: 'List all Slack channels the bot has access to. Useful for finding the right channel to post to.',
    input_schema: {
      type: 'object',
      properties: {
        include_private: { type: 'boolean', description: 'Include private channels (default false)' },
      },
    },
  },
  {
    name: 'get_slack_thread',
    description: 'Read all messages in a specific Slack thread. Use to get full context of a discussion.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel ID where the thread is' },
        thread_ts: { type: 'string', description: 'Thread timestamp (the ts of the parent message)' },
      },
      required: ['channel', 'thread_ts'],
    },
  },
  // browser_session removed — now provided by Playwright MCP server
  {
    name: 'run_shell',
    description: 'Execute a shell command on the Mac Mini server. Use for system tasks like checking disk space, managing files, running scripts, installing packages, checking processes, or any terminal operation. Commands run as the agentserver user.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait for command to finish (default 30, max 120)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'create_file',
    description: 'Create or overwrite a file on the server. Use for writing scripts, configs, reports, exports, or any file that needs to be saved.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path to create (e.g. /Users/agentserver/exports/report.csv)' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the server filesystem. Use for reading configs, logs, scripts, exports, or any local file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path to read' },
        max_lines: { type: 'number', description: 'Max lines to read (default 200, for large files)' },
      },
      required: ['path'],
    },
  },
  // ─── Knowledge Base (Obsidian Vault) ─────────────────────────────────────────
  {
    name: 'save_note',
    description: 'Save a note to Jin\'s knowledge base (Obsidian vault). Use to capture thoughts, decisions, brand info, people notes, meeting takeaways, strategy ideas, or any important information Joe shares. Always use [[links]] to connect related notes. Folders: brands/, people/, strategy/, meetings/, projects/, daily/, inbox/',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path relative to vault (e.g. "brands/Boken.md", "meetings/2026-02-23 Investor Call.md", "inbox/pricing-thoughts.md")' },
        content: { type: 'string', description: 'Markdown content. Use [[note name]] for cross-links, #tags for tagging.' },
        append: { type: 'boolean', description: 'If true, append to existing note instead of overwriting (default false)' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'search_knowledge',
    description: 'Search Jin\'s knowledge base for notes matching a query. Searches file names and content. Use when Joe asks about something that may have been captured before — brand info, past decisions, people, strategies.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or phrase' },
        folder: { type: 'string', description: 'Limit search to a specific folder (e.g. "brands", "people"). Omit to search all.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_notes',
    description: 'List all notes in a folder of Jin\'s knowledge base. Use to see what\'s been captured in a category.',
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder to list (e.g. "brands", "people", "strategy"). Omit to list top-level.' },
      },
    },
  },
  // ─── Image Generation ────────────────────────────────────────────────────────
  {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using AI. Returns a file path to the generated image that can be shared in Slack. Use for mockups, social media graphics, concept art, brand visuals, or any visual content.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        style: { type: 'string', description: 'Style hint (e.g. "photorealistic", "illustration", "minimalist", "brand-style"). Default: natural.' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Aspect ratio (default 1:1)' },
      },
      required: ['prompt'],
    },
  },
  // ─── Webhooks / Automation ───────────────────────────────────────────────────
  {
    name: 'trigger_webhook',
    description: 'Send a POST request to a webhook URL (Zapier, Make, n8n, custom). Use to trigger automations, sync data to external systems, or kick off workflows.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Webhook URL to POST to' },
        payload: { type: 'object', description: 'JSON payload to send' },
      },
      required: ['url', 'payload'],
    },
  },
  // ─── HTTP API ────────────────────────────────────────────────────────────────
  {
    name: 'http_request',
    description: 'Make an HTTP request to any API. Use for integrations that don\'t have dedicated tools — CRMs, project management, analytics, etc. Supports GET, POST, PUT, PATCH, DELETE.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method' },
        url: { type: 'string', description: 'Full URL' },
        headers: { type: 'object', description: 'Request headers as key-value pairs' },
        body: { type: 'object', description: 'Request body (for POST/PUT/PATCH)' },
      },
      required: ['method', 'url'],
    },
  },
  // ─── Audio Transcription ─────────────────────────────────────────────────────
  {
    name: 'transcribe_audio',
    description: 'Transcribe an audio or video file to text using Whisper. Use for meeting recordings, voice memos, podcasts, interviews, or any audio content. Supports mp3, mp4, wav, m4a, webm.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to audio/video file on server, or a URL to download from' },
        language: { type: 'string', description: 'Language code (e.g. "en", "ko", "es"). Auto-detected if omitted.' },
      },
      required: ['file_path'],
    },
  },
  // ─── Slack Operations ───────────────────────────────────────────────────────
  {
    name: 'delete_slack_message',
    description: 'Delete one of Jin\'s own Slack messages. Use to clean up conversation logs — delete messy, duplicate, or looping responses. Cannot delete other users\' messages.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel or DM ID where the message is' },
        timestamp: { type: 'string', description: 'Message timestamp (ts) to delete' },
      },
      required: ['channel', 'timestamp'],
    },
  },
  {
    name: 'list_slack_messages',
    description: 'List recent messages in a Slack channel or DM. Returns message text, timestamps, and user IDs. Use to review conversation history for cleanup, reference, or context.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel or DM ID' },
        limit: { type: 'number', description: 'Number of messages to fetch (default 50, max 200)' },
        oldest: { type: 'string', description: 'Only messages after this Unix timestamp' },
        latest: { type: 'string', description: 'Only messages before this Unix timestamp' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'react_to_message',
    description: 'Add an emoji reaction to a Slack message. Use for quick acknowledgment, flagging, or feedback without sending a full reply.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel or DM ID' },
        timestamp: { type: 'string', description: 'Message timestamp (ts) to react to' },
        emoji: { type: 'string', description: 'Emoji name without colons (e.g. "thumbsup", "eyes", "white_check_mark")' },
      },
      required: ['channel', 'timestamp', 'emoji'],
    },
  },
  {
    name: 'pin_message',
    description: 'Pin or unpin a message in a Slack channel. Pinned messages are easy to find in the channel details.',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel or DM ID' },
        timestamp: { type: 'string', description: 'Message timestamp (ts) to pin/unpin' },
        action: { type: 'string', enum: ['pin', 'unpin'], description: 'Whether to pin or unpin (default: pin)' },
      },
      required: ['channel', 'timestamp'],
    },
  },
];

// Browser session manager removed — now handled by Playwright MCP server

async function executeTool(name, input, { slackClient, channel } = {}) {
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
        const drive = getJinDriveClient();
        const parentId = input.folder_id || AI_HUB_FOLDER_ID;
        const fileType = input.type || 'text';
        const mimeTypes = {
          text: 'text/plain',
          document: 'application/vnd.google-apps.document',
          spreadsheet: 'application/vnd.google-apps.spreadsheet',
          folder: 'application/vnd.google-apps.folder',
        };
        const params = {
          requestBody: {
            name: input.name,
            parents: [parentId],
            mimeType: mimeTypes[fileType] || 'text/plain',
          },
          fields: 'id,name,webViewLink,mimeType',
        };
        if (input.content && (fileType === 'text' || fileType === 'document')) {
          params.media = { mimeType: 'text/plain', body: input.content };
        }
        const file = await drive.files.create(params);
        let response = `Created: ${file.data.name}\nType: ${fileType}\nID: ${file.data.id}`;
        if (file.data.webViewLink) response += `\nLink: ${file.data.webViewLink}`;
        return response;
      }
      case 'upload_slack_file_to_drive': {
        const drive = getJinDriveClient();
        const parentId = input.folder_id || AI_HUB_FOLDER_ID;
        // Look up real file info from Slack API (prevents hallucinated URLs)
        const slackWeb = new (require('@slack/web-api').WebClient)(process.env.SLACK_BOT_TOKEN);
        const fileInfo = await slackWeb.files.info({ file: input.slack_file_id });
        if (!fileInfo.file?.url_private_download) {
          return `Error: Could not find Slack file ${input.slack_file_id} or no download URL available.`;
        }
        const slackFile = fileInfo.file;
        // Download from Slack using verified URL
        const { base64, mimeType: detectedMime } = await downloadSlackFile(slackFile.url_private_download, process.env.SLACK_BOT_TOKEN);
        const buffer = Buffer.from(base64, 'base64');
        if (buffer.length < 500) {
          return `Error: Download failed — got ${buffer.length} bytes (expected an image/file). Slack may have returned an error page.`;
        }
        const mime = slackFile.mimetype || detectedMime || 'application/octet-stream';
        const { Readable } = require('stream');
        const fileName = input.filename || slackFile.name || 'file';
        const file = await drive.files.create({
          requestBody: {
            name: fileName,
            parents: [parentId],
          },
          media: { mimeType: mime, body: Readable.from(buffer) },
          fields: 'id,name,webViewLink',
        });
        // Make viewable via link
        await drive.permissions.create({
          fileId: file.data.id,
          requestBody: { role: 'reader', type: 'anyone' },
        });
        const link = `https://drive.google.com/file/d/${file.data.id}/view`;
        return `Uploaded: ${file.data.name} (${(buffer.length / 1024).toFixed(0)}KB)\nID: ${file.data.id}\nLink: ${link}`;
      }
      case 'list_drive_files': {
        const drive = getJinDriveClient();
        const folderId = input.folder_id || AI_HUB_FOLDER_ID;
        let q = `'${folderId}' in parents and trashed=false`;
        if (input.query) q += ` and ${input.query}`;
        const res = await drive.files.list({
          q,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
          orderBy: 'modifiedTime desc',
          pageSize: 50,
        });
        const files = res.data.files || [];
        if (files.length === 0) return '(folder is empty)';
        return files.map(f => {
          const icon = f.mimeType.includes('folder') ? '📁' : f.mimeType.includes('spreadsheet') ? '📊' : f.mimeType.includes('document') ? '📝' : '📄';
          return `${icon} ${f.name} (${f.id})`;
        }).join('\n');
      }
      case 'read_gmail': {
        const auth = getJinAuth();
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
          results.push(`ID: ${msg.id}\nFrom: ${get('From')}\nTo: ${get('To')}\nDate: ${get('Date')}\nSubject: ${get('Subject')}\nSnippet: ${full.data.snippet || ''}`);
        }
        return results.join('\n\n---\n\n');
      }
      case 'send_email': {
        const auth = getJinAuth();
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
        const auth = getJinAuth();
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
        const auth = getJinAuth();
        const calendar = google.calendar({ version: 'v3', auth });
        const event = {
          summary: input.title,
          start: { dateTime: input.startDateTime },
          end: { dateTime: input.endDateTime },
        };
        if (input.description) event.description = input.description;
        if (input.attendees) event.attendees = input.attendees.split(',').map(e => ({ email: e.trim() }));
        const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event, sendUpdates: 'all' });
        let result = `Event created: ${res.data.summary}\nLink: ${res.data.htmlLink}`;
        if (input.attendees) result += `\nInvites sent to: ${input.attendees}`;
        return result;
      }
      case 'read_sheet': {
        const auth = getJinOAuthClient();
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
      // web_search, browse_web, screenshot_webpage removed — now handled by MCP servers
      case 'get_youtube_transcript': {
        // Extract video ID from URL or use as-is
        const videoIdMatch = input.url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([a-zA-Z0-9_-]{11})/) ||
                             input.url.match(/^([a-zA-Z0-9_-]{11})$/);
        if (!videoIdMatch) return 'Error: Could not extract YouTube video ID from URL.';
        const videoId = videoIdMatch[1];
        const transcript = await YoutubeTranscript.fetchTranscript(videoId);
        if (!transcript || transcript.length === 0) return 'No transcript available for this video.';
        const text = transcript.map(entry => entry.text).join(' ');
        return `YouTube Transcript (${transcript.length} segments):\n\n${text}`.slice(0, MAX_URL_CHARS);
      }
      case 'fetch_pdf': {
        // Download the PDF
        const pdfBuffer = await new Promise((resolve, reject) => {
          const lib = input.url.startsWith('https') ? https : http;
          const req = lib.get(input.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Jin/1.0)' }, timeout: 15000 }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
              const redirectUrl = res.headers.location;
              const rLib = redirectUrl.startsWith('https') ? https : http;
              rLib.get(redirectUrl, { timeout: 15000 }, (rRes) => {
                const chunks = [];
                rRes.on('data', (c) => chunks.push(c));
                rRes.on('end', () => resolve(Buffer.concat(chunks)));
              }).on('error', reject);
              return;
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
        });
        const pdfData = await pdfParse(pdfBuffer);
        const text = pdfData.text?.trim();
        if (!text) return 'PDF parsed but no text content found.';
        return `PDF (${pdfData.numpages} pages):\n\n${text}`.slice(0, MAX_URL_CHARS);
      }
      case 'search_slack': {
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(process.env.SLACK_BOT_TOKEN);
        const count = Math.min(input.count || 10, 50);
        const res = await web.search.messages({
          query: input.query,
          count,
          sort: 'timestamp',
          sort_dir: 'desc',
        });
        const matches = res.messages?.matches || [];
        if (matches.length === 0) return 'No results found.';
        return matches.map((m, i) => {
          const date = new Date(parseFloat(m.ts) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const who = m.username || m.user || 'unknown';
          const ch = m.channel?.name ? `#${m.channel.name}` : 'DM';
          return `${i + 1}. [${date} in ${ch}] ${who}: ${(m.text || '').slice(0, 200)}`;
        }).join('\n\n');
      }
      case 'send_slack_message': {
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(process.env.SLACK_BOT_TOKEN);
        // Resolve channel name to ID if needed
        let channelId = input.channel;
        if (channelId.startsWith('#')) {
          const listRes = await web.conversations.list({ types: 'public_channel,private_channel', limit: 200 });
          const ch = (listRes.channels || []).find(c => c.name === channelId.slice(1));
          if (!ch) return `Error: Channel ${channelId} not found.`;
          channelId = ch.id;
        }
        await web.chat.postMessage({ channel: channelId, text: input.text });
        return `Message sent to ${input.channel}.`;
      }
      case 'set_reminder': {
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(process.env.SLACK_BOT_TOKEN);
        // Slack reminders API accepts Unix timestamp or natural language
        let time = input.time;
        // If ISO datetime, convert to Unix timestamp
        if (/^\d{4}-\d{2}-\d{2}T/.test(time)) {
          time = String(Math.floor(new Date(time).getTime() / 1000));
        }
        const res = await web.reminders.add({
          text: input.text,
          time,
          user: 'U0AGBJJV5GT', // Joe's user ID — reminders require a user
        });
        return `Reminder set: "${input.text}" at ${input.time}`;
      }
      case 'write_sheet': {
        const auth = getJinAuth();
        const idMatch = input.url_or_id.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) ||
                        input.url_or_id.match(/^([a-zA-Z0-9_-]{25,})$/);
        const fileId = idMatch ? idMatch[1] : input.url_or_id;
        const sheets = google.sheets({ version: 'v4', auth });
        const values = JSON.parse(input.values);
        const mode = input.mode || 'update';
        if (mode === 'append') {
          const res = await sheets.spreadsheets.values.append({
            spreadsheetId: fileId,
            range: input.range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
          });
          return `Appended ${values.length} row(s) to ${input.range}. Updated range: ${res.data.updates?.updatedRange || 'done'}`;
        } else {
          const res = await sheets.spreadsheets.values.update({
            spreadsheetId: fileId,
            range: input.range,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values },
          });
          return `Updated ${res.data.updatedCells || 0} cells in ${input.range}.`;
        }
      }
      case 'read_drive_file': {
        // Extract file ID from URL if needed
        let fileId = input.file_id_or_url;
        const urlId = extractDriveFileId(input.file_id_or_url);
        if (urlId) fileId = urlId;
        const text = await fetchDriveUrl(`https://docs.google.com/document/d/${fileId}/`);
        if (text) return text.slice(0, MAX_URL_CHARS);
        // Fallback: try downloading as raw text
        const drive = getDriveClientOAuth();
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
        return (res.data || '(empty)').slice(0, MAX_URL_CHARS);
      }
      case 'update_drive_file': {
        const mode = input.mode || 'replace';
        if (mode === 'append') {
          await appendToGoogleDoc(input.file_id, input.content);
          return `Appended ${input.content.length} chars to document.`;
        } else {
          const drive = getDriveClientOAuth();
          await drive.files.update({
            fileId: input.file_id,
            media: { mimeType: 'text/plain', body: input.content },
          });
          return `File updated (${input.content.length} chars).`;
        }
      }
      case 'move_drive_file': {
        const drive = getJinDriveClient();
        const file = await drive.files.get({ fileId: input.file_id, fields: 'parents,name' });
        const previousParents = (file.data.parents || []).join(',');
        const res = await drive.files.update({
          fileId: input.file_id,
          addParents: input.destination_folder_id,
          removeParents: previousParents,
          fields: 'id,name,parents',
        });
        return `Moved "${res.data.name}" to folder ${input.destination_folder_id}`;
      }
      case 'rename_drive_file': {
        const drive = getJinDriveClient();
        const res = await drive.files.update({
          fileId: input.file_id,
          requestBody: { name: input.new_name },
          fields: 'id,name',
        });
        return `Renamed to "${res.data.name}"`;
      }
      case 'share_drive_file': {
        const drive = getJinDriveClient();
        const role = input.role || 'reader';
        const results = [];
        if (input.email) {
          await drive.permissions.create({
            fileId: input.file_id,
            requestBody: { type: 'user', role, emailAddress: input.email },
            sendNotificationEmail: true,
          });
          results.push(`Shared with ${input.email} as ${role}`);
        }
        if (input.anyone_with_link) {
          await drive.permissions.create({
            fileId: input.file_id,
            requestBody: { type: 'anyone', role },
          });
          results.push(`Link sharing enabled (${role})`);
        }
        const fileInfo = await drive.files.get({ fileId: input.file_id, fields: 'webViewLink,name' });
        results.push(`Link: ${fileInfo.data.webViewLink}`);
        return results.join('\n');
      }
      case 'delete_drive_file': {
        const drive = getJinDriveClient();
        const fileInfo = await drive.files.get({ fileId: input.file_id, fields: 'name' });
        await drive.files.delete({ fileId: input.file_id });
        return `Deleted: ${fileInfo.data.name} (${input.file_id})`;
      }
      // ─── QBO Tool Implementations ─────────────────────────────────────────────
      case 'qbo_companies': {
        const allTokens = loadQBOTokens();
        const realms = Object.keys(allTokens);
        if (realms.length === 0) return 'No QBO companies connected. Use /qbo/connect to add one.';
        const lines = [];
        for (const realm of realms) {
          const t = allTokens[realm];
          let name = t.companyName;
          if (!name) {
            try {
              const data = await qboRequest(realm, `/companyinfo/${realm}`);
              name = data.CompanyInfo?.CompanyName || 'Unknown';
              allTokens[realm].companyName = name;
              saveQBOTokens(allTokens);
            } catch { name = '(could not fetch)'; }
          }
          lines.push(`${name} — realmId: ${realm}`);
        }
        return lines.join('\n');
      }
      case 'qbo_profit_loss': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = today.slice(0, 8) + '01';
        const params = {
          start_date: input.start_date || monthStart,
          end_date: input.end_date || today,
        };
        if (input.summarize_by) params.summarize_by = input.summarize_by;
        const report = await qboReport(realm, 'ProfitAndLoss', params);
        return formatQBOReport(report);
      }
      case 'qbo_balance_sheet': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const params = {};
        if (input.date) params.date = input.date;
        const report = await qboReport(realm, 'BalanceSheet', params);
        return formatQBOReport(report);
      }
      case 'qbo_cashflow': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const today = new Date().toISOString().slice(0, 10);
        const monthStart = today.slice(0, 8) + '01';
        const params = {
          start_date: input.start_date || monthStart,
          end_date: input.end_date || today,
        };
        const report = await qboReport(realm, 'CashFlow', params);
        return formatQBOReport(report);
      }
      case 'qbo_invoices': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const limit = input.limit || 20;
        let where = '';
        const status = input.status || 'open';
        const today = new Date().toISOString().slice(0, 10);
        if (status === 'open') where = "Balance > '0'";
        else if (status === 'overdue') where = `Balance > '0' AND DueDate < '${today}'`;
        else if (status === 'paid') where = "Balance = '0'";
        if (input.customer) {
          const custFilter = `CustomerRef.name LIKE '%${input.customer.replace(/'/g, "\\'")}%'`;
          where = where ? `${where} AND ${custFilter}` : custFilter;
        }
        const query = `SELECT * FROM Invoice${where ? ' WHERE ' + where : ''} ORDERBY MetaData.CreateTime DESC MAXRESULTS ${limit}`;
        const data = await qboQuery(realm, query);
        const invoices = data.QueryResponse?.Invoice || [];
        if (invoices.length === 0) return `No ${status} invoices found.`;
        return invoices.map(inv => {
          const due = inv.DueDate || '—';
          const bal = inv.Balance ?? 0;
          const total = inv.TotalAmt ?? 0;
          const cust = inv.CustomerRef?.name || 'Unknown';
          const overdue = bal > 0 && new Date(due) < new Date() ? ' ⚠ OVERDUE' : '';
          return `#${inv.DocNumber || inv.Id} — ${cust}\n  Total: $${total.toFixed(2)} | Balance: $${bal.toFixed(2)} | Due: ${due}${overdue}`;
        }).join('\n\n');
      }
      case 'qbo_bills': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const limit = input.limit || 20;
        let where = '';
        const status = input.status || 'unpaid';
        const today = new Date().toISOString().slice(0, 10);
        if (status === 'unpaid') where = "Balance > '0'";
        else if (status === 'overdue') where = `Balance > '0' AND DueDate < '${today}'`;
        else if (status === 'paid') where = "Balance = '0'";
        const query = `SELECT * FROM Bill${where ? ' WHERE ' + where : ''} ORDERBY MetaData.CreateTime DESC MAXRESULTS ${limit}`;
        const data = await qboQuery(realm, query);
        const bills = data.QueryResponse?.Bill || [];
        if (bills.length === 0) return `No ${status} bills found.`;
        return bills.map(bill => {
          const due = bill.DueDate || '—';
          const bal = bill.Balance ?? 0;
          const total = bill.TotalAmt ?? 0;
          const vendor = bill.VendorRef?.name || 'Unknown';
          const overdue = bal > 0 && new Date(due) < new Date() ? ' ⚠ OVERDUE' : '';
          return `${vendor}\n  Total: $${total.toFixed(2)} | Balance: $${bal.toFixed(2)} | Due: ${due}${overdue}`;
        }).join('\n\n');
      }
      case 'qbo_accounts': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        let where = "Active = true";
        if (input.type) where += ` AND AccountType = '${input.type}'`;
        const query = `SELECT * FROM Account WHERE ${where} ORDERBY AccountType, Name MAXRESULTS 100`;
        const data = await qboQuery(realm, query);
        const accounts = data.QueryResponse?.Account || [];
        if (accounts.length === 0) return 'No accounts found.';
        let currentType = '';
        const lines = [];
        for (const acct of accounts) {
          if (acct.AccountType !== currentType) {
            currentType = acct.AccountType;
            lines.push(`\n── ${currentType} ──`);
          }
          const bal = acct.CurrentBalance != null ? `$${acct.CurrentBalance.toFixed(2)}` : '—';
          lines.push(`  ${acct.Name}: ${bal}`);
        }
        return lines.join('\n');
      }
      case 'qbo_transactions': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const limit = input.limit || 25;
        const today = new Date().toISOString().slice(0, 10);
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const startDate = input.start_date || thirtyDaysAgo;
        const endDate = input.end_date || today;

        if (input.entity) {
          const query = `SELECT * FROM ${input.entity} WHERE MetaData.CreateTime >= '${startDate}' AND MetaData.CreateTime <= '${endDate}T23:59:59' ORDERBY MetaData.CreateTime DESC MAXRESULTS ${limit}`;
          const data = await qboQuery(realm, query);
          const items = data.QueryResponse?.[input.entity] || [];
          if (items.length === 0) return `No ${input.entity} transactions found in range.`;
          return items.map(item => {
            const date = item.TxnDate || item.MetaData?.CreateTime?.slice(0, 10) || '—';
            const total = item.TotalAmt ?? item.Amount ?? 0;
            const ref = item.DocNumber || item.Id;
            const name = item.CustomerRef?.name || item.VendorRef?.name || item.EntityRef?.name || '';
            return `${date} | ${input.entity} #${ref} | ${name} | $${Number(total).toFixed(2)}`;
          }).join('\n');
        }

        // Default: query multiple types for a summary
        const types = ['Invoice', 'Bill', 'Payment', 'Deposit', 'Purchase', 'SalesReceipt'];
        const allResults = [];
        for (const type of types) {
          try {
            const query = `SELECT * FROM ${type} WHERE MetaData.CreateTime >= '${startDate}' AND MetaData.CreateTime <= '${endDate}T23:59:59' ORDERBY MetaData.CreateTime DESC MAXRESULTS 10`;
            const data = await qboQuery(realm, query);
            const items = data.QueryResponse?.[type] || [];
            for (const item of items) {
              const date = item.TxnDate || item.MetaData?.CreateTime?.slice(0, 10) || '—';
              const total = item.TotalAmt ?? item.Amount ?? 0;
              const name = item.CustomerRef?.name || item.VendorRef?.name || item.EntityRef?.name || '';
              allResults.push({ date, type, total: Number(total), name, ref: item.DocNumber || item.Id });
            }
          } catch {}
        }
        allResults.sort((a, b) => b.date.localeCompare(a.date));
        if (allResults.length === 0) return 'No transactions found in the last 30 days.';
        return allResults.slice(0, limit).map(t =>
          `${t.date} | ${t.type} | ${t.name || '—'} | $${t.total.toFixed(2)}`
        ).join('\n');
      }
      case 'qbo_customers': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const data = await qboQuery(realm, "SELECT * FROM Customer WHERE Active = true ORDERBY DisplayName MAXRESULTS 100");
        const customers = data.QueryResponse?.Customer || [];
        if (customers.length === 0) return 'No customers found.';
        return customers.map(c => {
          const bal = c.Balance != null ? `$${c.Balance.toFixed(2)}` : '—';
          const email = c.PrimaryEmailAddr?.Address || '';
          return `${c.DisplayName} — Balance: ${bal}${email ? ` | ${email}` : ''}`;
        }).join('\n');
      }
      case 'qbo_vendors': {
        const realm = resolveRealm(input.company);
        if (!realm) return 'No QBO companies connected.';
        const data = await qboQuery(realm, "SELECT * FROM Vendor WHERE Active = true ORDERBY DisplayName MAXRESULTS 100");
        const vendors = data.QueryResponse?.Vendor || [];
        if (vendors.length === 0) return 'No vendors found.';
        return vendors.map(v => {
          const bal = v.Balance != null ? `$${v.Balance.toFixed(2)}` : '—';
          const email = v.PrimaryEmailAddr?.Address || '';
          return `${v.DisplayName} — Balance: ${bal}${email ? ` | ${email}` : ''}`;
        }).join('\n');
      }
      // ─── End QBO Implementations ──────────────────────────────────────────────
      case 'reply_email': {
        const auth = getJinAuth();
        const gmail = google.gmail({ version: 'v1', auth });
        // Get the original message to extract headers for threading
        const original = await gmail.users.messages.get({
          userId: 'me', id: input.message_id, format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Message-ID', 'References', 'In-Reply-To'],
        });
        const headers = original.data.payload.headers;
        const getH = (name) => headers.find(h => h.name === name)?.value || '';
        const replyTo = getH('From');
        const subject = getH('Subject').startsWith('Re:') ? getH('Subject') : `Re: ${getH('Subject')}`;
        const messageId = getH('Message-ID');
        const references = getH('References') ? `${getH('References')} ${messageId}` : messageId;
        const lines = [
          `To: ${replyTo}`,
          `Subject: ${subject}`,
          ...(input.cc ? [`Cc: ${input.cc}`] : []),
          `In-Reply-To: ${messageId}`,
          `References: ${references}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          input.body,
        ];
        const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
        await gmail.users.messages.send({
          userId: 'me',
          requestBody: { raw, threadId: original.data.threadId },
        });
        return `Reply sent to ${replyTo}.`;
      }
      case 'list_slack_channels': {
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(process.env.SLACK_BOT_TOKEN);
        const types = input.include_private ? 'public_channel,private_channel' : 'public_channel';
        const res = await web.conversations.list({ types, limit: 200, exclude_archived: true });
        const channels = (res.channels || []).map(c =>
          `#${c.name} (${c.id}) — ${c.num_members || 0} members${c.purpose?.value ? `: ${c.purpose.value.slice(0, 60)}` : ''}`
        );
        return channels.join('\n') || '(no channels found)';
      }
      case 'get_slack_thread': {
        const { WebClient } = require('@slack/web-api');
        const web = new WebClient(process.env.SLACK_BOT_TOKEN);
        const res = await web.conversations.replies({
          channel: input.channel,
          ts: input.thread_ts,
          limit: 50,
        });
        const messages = res.messages || [];
        if (messages.length === 0) return 'No messages in thread.';
        return messages.map(m => {
          const date = new Date(parseFloat(m.ts) * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
          const who = m.bot_id ? 'Jin' : (m.user || 'unknown');
          return `[${date}] ${who}: ${(m.text || '').slice(0, 300)}`;
        }).join('\n\n');
      }
      // browser_session removed — now handled by Playwright MCP server
      case 'run_shell': {
        const { execSync } = require('child_process');
        const timeoutMs = Math.min((input.timeout_seconds || 30), 120) * 1000;
        // Block dangerous commands
        const blocked = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
        if (blocked.some(b => input.command.includes(b))) {
          return 'Error: Command blocked for safety.';
        }
        const output = execSync(input.command, {
          timeout: timeoutMs,
          encoding: 'utf-8',
          cwd: '/Users/agentserver',
          maxBuffer: 1024 * 1024,
        });
        return (output || '(no output)').slice(0, 8000);
      }
      case 'create_file': {
        const fs = require('fs');
        const path = require('path');
        // Safety: only allow writing under /Users/agentserver
        if (!input.path.startsWith('/Users/agentserver/')) {
          return 'Error: Can only write files under /Users/agentserver/';
        }
        const dir = path.dirname(input.path);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(input.path, input.content, 'utf-8');
        return `File created: ${input.path} (${input.content.length} chars)`;
      }
      case 'read_file': {
        const fs = require('fs');
        if (!fs.existsSync(input.path)) return `Error: File not found: ${input.path}`;
        const content = fs.readFileSync(input.path, 'utf-8');
        const lines = content.split('\n');
        const maxLines = input.max_lines || 200;
        if (lines.length > maxLines) {
          return lines.slice(0, maxLines).join('\n') + `\n\n... (${lines.length - maxLines} more lines truncated)`;
        }
        return content || '(empty file)';
      }
      // ─── Knowledge Base (Obsidian Vault) ───────────────────────────────────
      case 'save_note': {
        const fs = require('fs');
        const path = require('path');
        const VAULT = '/Users/agentserver/jin-vault';
        const fullPath = path.join(VAULT, input.path);
        // Safety: must stay within vault
        if (!fullPath.startsWith(VAULT)) return 'Error: Path must be within the knowledge vault.';
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });
        if (input.append && fs.existsSync(fullPath)) {
          fs.appendFileSync(fullPath, '\n' + input.content, 'utf-8');
          return `Appended to: ${input.path}`;
        }
        fs.writeFileSync(fullPath, input.content, 'utf-8');
        return `Note saved: ${input.path}`;
      }
      case 'search_knowledge': {
        const fs = require('fs');
        const path = require('path');
        const VAULT = '/Users/agentserver/jin-vault';
        const searchDir = input.folder ? path.join(VAULT, input.folder) : VAULT;
        const query = input.query.toLowerCase();
        const results = [];

        function walkDir(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walkDir(full);
            } else if (entry.name.endsWith('.md')) {
              const relative = path.relative(VAULT, full);
              const nameMatch = entry.name.toLowerCase().includes(query);
              let contentMatch = false;
              let snippet = '';
              try {
                const content = fs.readFileSync(full, 'utf-8');
                const idx = content.toLowerCase().indexOf(query);
                if (idx !== -1) {
                  contentMatch = true;
                  const start = Math.max(0, idx - 50);
                  const end = Math.min(content.length, idx + query.length + 100);
                  snippet = '...' + content.slice(start, end).replace(/\n/g, ' ') + '...';
                }
              } catch {}
              if (nameMatch || contentMatch) {
                results.push({ path: relative, nameMatch, snippet });
              }
            }
          }
        }
        walkDir(searchDir);
        if (results.length === 0) return `No notes found matching "${input.query}".`;
        return results.map(r => {
          let line = `- **${r.path}**`;
          if (r.snippet) line += `\n  ${r.snippet}`;
          return line;
        }).join('\n').slice(0, 4000);
      }
      case 'list_notes': {
        const fs = require('fs');
        const path = require('path');
        const VAULT = '/Users/agentserver/jin-vault';
        const dir = input.folder ? path.join(VAULT, input.folder) : VAULT;
        if (!fs.existsSync(dir)) return `Folder not found: ${input.folder || '/'}`;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const items = entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)
          .sort();
        return items.length > 0 ? items.join('\n') : '(empty folder)';
      }
      // ─── Image Generation ──────────────────────────────────────────────────
      case 'generate_image': {
        const https = require('https');
        const fs = require('fs');
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return 'Error: OPENAI_API_KEY not set in .env.';

        // Map aspect ratios to DALL-E 3 sizes
        const sizeMap = {
          '1:1': '1024x1024',
          '16:9': '1792x1024',
          '9:16': '1024x1792',
          '4:3': '1024x1024',
          '3:4': '1024x1792',
        };
        const size = sizeMap[input.aspect_ratio] || '1024x1024';
        const fullPrompt = input.prompt + (input.style ? `. Style: ${input.style}` : '');

        const payload = JSON.stringify({
          model: 'dall-e-3',
          prompt: fullPrompt,
          n: 1,
          size,
          quality: 'standard',
        });

        const createRes = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/images/generations',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 120000,
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
          });
          req.on('error', reject);
          req.write(payload);
          req.end();
        });

        if (createRes.error) return `Error: ${createRes.error.message || JSON.stringify(createRes.error)}`;
        const imageUrl = createRes.data?.[0]?.url;
        if (!imageUrl) return 'Error: No image URL returned.';

        // Download the image
        const imagePath = `/tmp/generated-${Date.now()}.png`;
        await new Promise((resolve, reject) => {
          const file = fs.createWriteStream(imagePath);
          https.get(imageUrl, (res) => {
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
        });

        // Upload to Slack if we have the client
        if (slackClient && channel) {
          try {
            await slackClient.files.uploadV2({
              channel_id: channel,
              file: fs.createReadStream(imagePath),
              filename: `generated-${Date.now()}.png`,
              initial_comment: `Generated: ${input.prompt}`,
            });
          } catch (uploadErr) {
            console.warn('  ⚠ Slack image upload failed:', uploadErr.message);
          }
        }

        return `Image generated and saved to: ${imagePath}\nPrompt: ${input.prompt}\nRevised prompt: ${createRes.data?.[0]?.revised_prompt || 'N/A'}`;
      }
      // ─── Webhooks / Automation ─────────────────────────────────────────────
      case 'trigger_webhook': {
        const https = require('https');
        const http = require('http');
        const url = new URL(input.url);
        const payload = JSON.stringify(input.payload);
        const lib = url.protocol === 'https:' ? https : http;

        const res = await new Promise((resolve, reject) => {
          const req = lib.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 30000,
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          });
          req.on('error', reject);
          req.write(payload);
          req.end();
        });

        return `Webhook triggered: ${res.status}\nResponse: ${(res.body || '').slice(0, 1000)}`;
      }
      // ─── HTTP Request ──────────────────────────────────────────────────────
      case 'http_request': {
        const https = require('https');
        const http = require('http');
        const url = new URL(input.url);
        const lib = url.protocol === 'https:' ? https : http;
        const payload = input.body ? JSON.stringify(input.body) : null;
        const headers = { ...input.headers };
        if (payload) {
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const res = await new Promise((resolve, reject) => {
          const req = lib.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: input.method,
            headers,
            timeout: 30000,
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
          });
          req.on('error', reject);
          if (payload) req.write(payload);
          req.end();
        });

        return `HTTP ${input.method} ${input.url}\nStatus: ${res.status}\nResponse: ${(res.body || '').slice(0, 4000)}`;
      }
      // ─── Audio Transcription ───────────────────────────────────────────────
      case 'transcribe_audio': {
        const fs = require('fs');
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return 'Error: OPENAI_API_KEY not set in .env. Needed for Whisper transcription.';

        let filePath = input.file_path;
        // If URL, download first
        if (filePath.startsWith('http')) {
          const https = require('https');
          const http = require('http');
          const ext = filePath.split('.').pop().split('?')[0] || 'mp3';
          const tmpPath = `/tmp/audio-${Date.now()}.${ext}`;
          const lib = filePath.startsWith('https') ? https : http;
          await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(tmpPath);
            lib.get(filePath, (res) => {
              res.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
          });
          filePath = tmpPath;
        }

        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

        // Use OpenAI Whisper API
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('model', 'whisper-1');
        if (input.language) form.append('language', input.language);

        const res = await new Promise((resolve, reject) => {
          const https = require('https');
          const req = https.request({
            hostname: 'api.openai.com',
            path: '/v1/audio/transcriptions',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              ...form.getHeaders(),
            },
            timeout: 120000,
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
          });
          req.on('error', reject);
          form.pipe(req);
        });

        if (res.error) return `Error: ${res.error.message || JSON.stringify(res.error)}`;
        return res.text || '(no transcription returned)';
      }
      case 'delete_slack_message': {
        if (!slackClient) return 'Error: No Slack client available';
        try {
          await slackClient.chat.delete({ channel: input.channel, ts: input.timestamp });
          return `Deleted message ${input.timestamp} from ${input.channel}`;
        } catch (err) {
          return `Error deleting message: ${err.data?.error || err.message}`;
        }
      }

      case 'list_slack_messages': {
        if (!slackClient) return 'Error: No Slack client available';
        const limit = Math.min(input.limit || 50, 200);
        const opts = { channel: input.channel, limit };
        if (input.oldest) opts.oldest = input.oldest;
        if (input.latest) opts.latest = input.latest;
        const result = await slackClient.conversations.history(opts);
        const msgs = (result.messages || []).map(m => ({
          ts: m.ts,
          user: m.user || m.bot_id || 'unknown',
          bot: !!m.bot_id,
          text: (m.text || '').slice(0, 300),
          date: new Date(parseFloat(m.ts) * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
        }));
        return JSON.stringify(msgs, null, 2);
      }

      case 'react_to_message': {
        if (!slackClient) return 'Error: No Slack client available';
        await slackClient.reactions.add({
          channel: input.channel,
          timestamp: input.timestamp,
          name: input.emoji,
        });
        return `Added :${input.emoji}: to message ${input.timestamp}`;
      }

      case 'pin_message': {
        if (!slackClient) return 'Error: No Slack client available';
        const action = input.action || 'pin';
        if (action === 'unpin') {
          await slackClient.pins.remove({ channel: input.channel, timestamp: input.timestamp });
          return `Unpinned message ${input.timestamp}`;
        }
        await slackClient.pins.add({ channel: input.channel, timestamp: input.timestamp });
        return `Pinned message ${input.timestamp}`;
      }

      default:
        // Check if this is an MCP tool
        if (mcpToolMap.has(name)) {
          return await callMCPTool(name, input);
        }
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

// ─── Mac Mini heartbeat check (Hetzner standby only) ─────────────────────────

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
    return false; // can't check = assume down, let standby respond
  }
}

// ─── Claude ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: (process.env.ANTHROPIC_API_KEY || '').replace(/\s+/g, '') });

// ─── Usage Tracking ───────────────────────────────────────────────────────────

const USAGE_LOG_PATH = './usage-log.json';

// Pricing per million tokens (as of Feb 2026)
const MODEL_PRICING = {
  'claude-sonnet-4-6':       { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00, cacheWrite: 1.00, cacheRead: 0.08 },
};

function loadUsageLog() {
  try {
    if (fs.existsSync(USAGE_LOG_PATH)) return JSON.parse(fs.readFileSync(USAGE_LOG_PATH, 'utf8'));
  } catch {}
  return [];
}

function saveUsageLog(log) {
  fs.writeFileSync(USAGE_LOG_PATH, JSON.stringify(log), 'utf8');
}

function logUsage({ model, usage, context: ctx, slackUser }) {
  if (!usage) return;
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;

  const cost = (inputTokens * pricing.input / 1e6)
    + (outputTokens * pricing.output / 1e6)
    + (cacheCreation * pricing.cacheWrite / 1e6)
    + (cacheRead * pricing.cacheRead / 1e6);

  const entry = {
    ts: Date.now(),
    date: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreation,
    cache_read_tokens: cacheRead,
    cost: Math.round(cost * 1e6) / 1e6, // 6 decimal places
    context: ctx || 'unknown',
    user: slackUser || 'system',
  };

  const log = loadUsageLog();
  log.push(entry);
  saveUsageLog(log);
  return entry;
}

function getUsageReport(days = 7) {
  const log = loadUsageLog();
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  const recent = log.filter(e => e.ts >= cutoff);

  if (recent.length === 0) return { totalCost: 0, totalInput: 0, totalOutput: 0, byModel: {}, byContext: {}, byUser: {}, callCount: 0, days };

  let totalCost = 0, totalInput = 0, totalOutput = 0;
  const byModel = {}, byContext = {}, byUser = {};

  for (const e of recent) {
    totalCost += e.cost;
    totalInput += e.input_tokens;
    totalOutput += e.output_tokens;

    if (!byModel[e.model]) byModel[e.model] = { cost: 0, calls: 0, input: 0, output: 0 };
    byModel[e.model].cost += e.cost;
    byModel[e.model].calls++;
    byModel[e.model].input += e.input_tokens;
    byModel[e.model].output += e.output_tokens;

    if (!byContext[e.context]) byContext[e.context] = { cost: 0, calls: 0 };
    byContext[e.context].cost += e.cost;
    byContext[e.context].calls++;

    if (!byUser[e.user]) byUser[e.user] = { cost: 0, calls: 0, input: 0, output: 0 };
    byUser[e.user].cost += e.cost;
    byUser[e.user].calls++;
    byUser[e.user].input += e.input_tokens;
    byUser[e.user].output += e.output_tokens;
  }

  return { totalCost, totalInput, totalOutput, byModel, byContext, byUser, callCount: recent.length, days };
}

function formatUsageReport(days = 7) {
  const r = getUsageReport(days);
  if (r.callCount === 0) return `No API usage recorded in the last ${days} day(s).`;

  let report = `*AI Infrastructure Spend — Last ${days} Day(s)*\n\n`;
  report += `Total: *$${r.totalCost.toFixed(2)}* across ${r.callCount} API calls\n`;
  report += `Tokens: ${(r.totalInput / 1000).toFixed(1)}K in / ${(r.totalOutput / 1000).toFixed(1)}K out\n`;

  // Projected monthly
  const dailyAvg = r.totalCost / days;
  report += `Projected monthly: ~$${(dailyAvg * 30).toFixed(2)}\n\n`;

  // By model
  report += `*By Model:*\n`;
  for (const [model, data] of Object.entries(r.byModel)) {
    const shortName = model.replace('claude-', '').replace('-20251001', '');
    report += `  ${shortName}: $${data.cost.toFixed(2)} (${data.calls} calls)\n`;
  }

  // By context (conversation vs background tasks)
  report += `\n*By Category:*\n`;
  const sortedCtx = Object.entries(r.byContext).sort((a, b) => b[1].cost - a[1].cost);
  for (const [ctx, data] of sortedCtx) {
    report += `  ${ctx}: $${data.cost.toFixed(2)} (${data.calls} calls)\n`;
  }

  // By user
  const nonSystemUsers = Object.entries(r.byUser).filter(([u]) => u !== 'system');
  if (nonSystemUsers.length > 0) {
    report += `\n*By User:*\n`;
    for (const [user, data] of nonSystemUsers.sort((a, b) => b[1].cost - a[1].cost)) {
      report += `  ${user}: $${data.cost.toFixed(2)} (${data.calls} calls, ${(data.input / 1000).toFixed(1)}K in / ${(data.output / 1000).toFixed(1)}K out)\n`;
    }
  }

  // System overhead
  const systemData = r.byUser['system'];
  if (systemData) {
    report += `\n*System Overhead* (memory, consolidation, proactive msgs):\n`;
    report += `  $${systemData.cost.toFixed(2)} (${systemData.calls} calls)\n`;
  }

  return report;
}

function buildSystemPrompt(driveContext, sessionLog, memoryContext, memoryFiles = {}) {
  const isStandby = process.env.INSTANCE_ROLE === 'standby';
  const instanceInfo = isStandby
    ? `INSTANCE: Hetzner standby. No filesystem or shell access. Gmail, Calendar, and Drive still work. If Joe needs shell access, tell him to use !build in Slack or SSH via Termius.`
    : `INSTANCE: Mac Mini (Agents-Mac-mini.local). Full tool access: shell, filesystem, Gmail, Calendar, Drive, Sheets, QBO.`;

  const soul = memoryFiles['SOUL.md'] || '';
  const joe = memoryFiles['JOE.md'] || '';
  const memory = memoryFiles['MEMORY.md'] || '';
  const culture = memoryFiles['CULTURE.md'] || '';

  return `${soul}

Today's date: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
${instanceInfo}

─────────────────────────────────────────
WHO JOE IS
─────────────────────────────────────────

${joe}

${memory ? `─────────────────────────────────────────
DECISIONS & LESSONS (memory/MEMORY.md)
─────────────────────────────────────────

${memory}

` : ''}${memoryContext ? `─────────────────────────────────────────
RECENT ACTIVITY (Drive Live Log)
─────────────────────────────────────────

${memoryContext}

` : ''}${sessionLog ? `─────────────────────────────────────────
SESSION LOG (recent ops tail)
─────────────────────────────────────────

${sessionLog}

` : ''}─────────────────────────────────────────
KNOWLEDGE VAULT (jin-vault)
─────────────────────────────────────────

You have a structured knowledge base with ${getVaultStats()}  across categories: people, brands, strategy, operations, finance. These are facts extracted from past conversations. Use the search_knowledge tool when Joe asks about a person, brand, decision, or topic that might have been discussed before. Use list_notes to browse categories. This vault is your long-term factual memory — check it before saying "I don't have context on that."

─────────────────────────────────────────
BUSINESS CONTEXT (Google Drive)
─────────────────────────────────────────

${driveContext}`;
}

// Track active requests per thread for interruption support
const activeRequests = new Map(); // threadKey -> { controller, ackTs, channel }

// Stream a single Claude call; fires onText with each text delta.
// Returns the final Message object (for tool_use detection).
// Retries on transient Anthropic errors (overloaded, rate_limit, 5xx) with exponential backoff.
// Falls back to Haiku after all Sonnet retries are exhausted.
const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

async function streamClaudeCall(params, signal, onText) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stream = anthropic.messages.stream(params, { signal });
      stream.on('text', (text) => onText(text));
      return await stream.finalMessage();
    } catch (err) {
      const msgStr = String(err.message || err || '');
      const isOverloaded = err.status === 529 || err.error?.type === 'overloaded_error'
        || msgStr.includes('overloaded') || msgStr.includes('Overloaded') || msgStr.includes('529');
      const isRetryable = isOverloaded || err.status === 503 || err.status === 500
        || err.status === 429 || msgStr.includes('rate_limit');

      if (signal?.aborted) throw err;

      // After all retries exhausted on Sonnet, fall back to Haiku
      if (attempt === MAX_RETRIES && isOverloaded && params.model !== FALLBACK_MODEL) {
        console.warn(`  ↻ Sonnet exhausted ${MAX_RETRIES + 1} attempts — falling back to Haiku`);
        onText('\n_(Sonnet is overloaded — switching to Haiku for this response)_\n');
        const fallbackParams = { ...params, model: FALLBACK_MODEL };
        try {
          const stream = anthropic.messages.stream(fallbackParams, { signal });
          stream.on('text', (text) => onText(text));
          const msg = await stream.finalMessage();
          msg._fallbackModel = FALLBACK_MODEL; // tag so usage tracking logs the right model
          return msg;
        } catch (fallbackErr) {
          console.error('  ✗ Haiku fallback also failed:', fallbackErr.message);
          throw err; // throw original Sonnet error
        }
      }

      if (!isRetryable || attempt === MAX_RETRIES) throw err;
      const delay = Math.min(2000 * Math.pow(2, attempt) + Math.random() * 1000, 15000);
      console.warn(`  ↻ Anthropic ${err.status || 'overloaded'} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callClaude(systemPrompt, history, userContent, signal, onUpdate, { slackClient, channel, slackUser } = {}) {
  const messageContent = typeof userContent === 'string' ? userContent : userContent.content;
  const messages = [...history, { role: 'user', content: messageContent }];

  // Throttled Slack update — batch deltas, push every ~800ms
  let accumulatedText = '';
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 800;
  const CURSOR = '▍';

  function handleDelta(text) {
    accumulatedText += text;
    const now = Date.now();
    if (onUpdate && now - lastUpdateTime >= UPDATE_INTERVAL) {
      lastUpdateTime = now;
      onUpdate(accumulatedText + CURSOR);
    }
  }

  const allTools = [...TOOLS, ...mcpTools];
  const params = { model: 'claude-sonnet-4-6', max_tokens: 4096, system: systemPrompt, messages, tools: allTools };
  let response = await streamClaudeCall(params, signal, handleDelta);
  // Final update without cursor
  if (onUpdate && accumulatedText) onUpdate(accumulatedText);

  // Track usage for this call (use fallback model if Haiku was used)
  logUsage({ model: response._fallbackModel || params.model, usage: response.usage, context: 'conversation', slackUser });

  // Agentic loop — keep going while Claude wants to use tools
  while (response.stop_reason === 'tool_use') {
    if (signal?.aborted) throw new Error('interrupted');

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResults = [];

    for (const block of toolUseBlocks) {
      if (signal?.aborted) throw new Error('interrupted');
      console.log(`  → Tool: ${block.name}`, JSON.stringify(block.input).slice(0, 120));
      const result = await executeTool(block.name, block.input, { slackClient, channel });
      console.log(`  ← ${String(result).slice(0, 120)}`);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: String(result),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });

    // Reset for next streaming round
    accumulatedText = '';
    params.messages = messages;

    response = await streamClaudeCall(params, signal, handleDelta);
    if (onUpdate && accumulatedText) onUpdate(accumulatedText);

    // Track each tool-loop iteration
    logUsage({ model: response._fallbackModel || params.model, usage: response.usage, context: 'conversation-tool-loop', slackUser });
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

// ─── Observational Memory — real-time fact extraction after every exchange ─────

const VAULT_PATH = '/Users/agentserver/jin-vault';

async function extractAndSaveFacts(userMessage, assistantResponse) {
  try {
    const userSnippet = (typeof userMessage === 'string' ? userMessage : JSON.stringify(userMessage)).slice(0, 3000);
    const assistantSnippet = (assistantResponse || '').slice(0, 1500);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are a fact extraction system for 88 Venture Studio. Extract CONCRETE, DURABLE facts from this exchange — people info, roles, business decisions, financial data, strategic shifts, brand updates, operational changes. Skip greetings, opinions, transient chat, and anything already obvious.

Output a JSON array. Each item:
{"subject":"Name or Topic","category":"people|brands|strategy|operations|finance","fact":"One clear sentence."}

Output [] if nothing worth saving. Output ONLY valid JSON, no markdown fences.

USER: ${userSnippet}
ASSISTANT: ${assistantSnippet}`,
      }],
    });
    logUsage({ model: 'claude-haiku-4-5-20251001', usage: response.usage, context: 'fact-extraction' });

    let facts;
    try {
      const raw = response.content[0].text.trim().replace(/^```json?\n?|\n?```$/g, '');
      facts = JSON.parse(raw);
    } catch {
      return; // bad JSON, skip silently
    }

    if (!Array.isArray(facts) || facts.length === 0) return;

    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    for (const { subject, category, fact } of facts) {
      if (!subject || !fact || fact.length < 10) continue;

      const dir = ['people', 'brands', 'strategy', 'operations', 'finance'].includes(category) ? category : 'inbox';
      const safeName = subject.replace(/[^a-zA-Z0-9 .-]/g, '').trim();
      if (!safeName) continue;

      const dirPath = path.join(VAULT_PATH, dir);
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

      const filePath = path.join(dirPath, `${safeName}.md`);

      if (fs.existsSync(filePath)) {
        // Append observation to existing note
        const existing = fs.readFileSync(filePath, 'utf8');
        // Don't duplicate — skip if the fact is already in the file (fuzzy match)
        if (existing.includes(fact.slice(0, 60))) continue;
        // Add Observations section if not present
        if (!existing.includes('## Observations')) {
          fs.appendFileSync(filePath, '\n\n## Observations\n');
        }
        fs.appendFileSync(filePath, `- ${fact} _(${timestamp})_\n`);
      } else {
        // Create new note
        const content = `# ${subject}\n**Category:** ${dir}\n\n## Observations\n- ${fact} _(${timestamp})_\n`;
        fs.writeFileSync(filePath, content, 'utf8');
      }

      console.log(`  [OBS] ${dir}/${safeName}: ${fact.slice(0, 60)}...`);
    }
  } catch (err) {
    // Silent failure — never break the conversation for memory
    console.warn('  ⚠ Observation extraction failed:', err.message);
  }
}

// ─── Memory Consolidation ─────────────────────────────────────────────────────

const inactivityTimers = new Map();
const deepConsolidationTimers = new Map();
const lastConsolidatedAt = new Map();
const lastDeepConsolidatedAt = new Map();
const INACTIVITY_MS = 2 * 60 * 1000;          // 2 min → quick save to Live Log
const DEEP_CONSOLIDATION_MS = 25 * 60 * 1000;  // 25 min → deep reflection + update memory files

async function consolidateMemory(threadKey) {
  const history = getHistory(threadKey);
  if (history.length === 0) return;

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
    logUsage({ model: 'claude-sonnet-4-6', usage: response.usage, context: 'memory-consolidation' });

    const summary = response.content[0].text.trim();
    if (!summary || summary.length < 20) return;
    if (/nothing worth saving|nothing here|nothing to save|no decisions|not worth|nothing new/i.test(summary)) return;

    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });

    const entry = `\n--- ${timestamp} ---\n${summary}`;

    fs.appendFileSync('./session-log.txt', `\n${entry}\n`, 'utf8');
    await appendToGoogleDoc(MEMORY_IDS.liveLog, `\n${entry}\n`);

    lastConsolidatedAt.set(threadKey, Date.now());
    console.log(`  ✓ Memory consolidated for thread ${threadKey}`);
  } catch (err) {
    console.warn('Memory consolidation failed:', err.message);
  }
}

// Deep consolidation — reads recent conversation + existing memory files,
// then updates MEMORY.md, JOE.md, CULTURE.md with refined long-term knowledge.
async function deepConsolidateMemory(threadKey) {
  const history = getHistory(threadKey);
  if (history.length < 4) return; // need meaningful conversation

  const lastDone = lastDeepConsolidatedAt.get(threadKey) || 0;
  if (Date.now() - lastDone < DEEP_CONSOLIDATION_MS) return;

  console.log(`  [DEEP] Starting deep consolidation for thread ${threadKey}...`);

  try {
    // Gather all context
    const recentConvo = history.slice(-20).map(m => `${m.role}: ${m.content}`).join('\n');
    const currentMemory = fs.existsSync('./memory/MEMORY.md') ? fs.readFileSync('./memory/MEMORY.md', 'utf8') : '';
    const currentJoe = fs.existsSync('./memory/JOE.md') ? fs.readFileSync('./memory/JOE.md', 'utf8') : '';
    const currentCulture = fs.existsSync('./memory/CULTURE.md') ? fs.readFileSync('./memory/CULTURE.md', 'utf8') : '';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are Jin, Chief of Staff to Joe Ko at 88 Venture Studio. It's been 25+ minutes since Joe last messaged. Time to reflect and update your long-term memory.

Review the recent conversation below and compare it against your current memory files. Determine what NEW information should be ADDED or UPDATED in each file. Do NOT rewrite the entire files — only output the changes.

## Recent Conversation
${recentConvo}

## Current memory/MEMORY.md
${currentMemory.slice(-3000)}

## Current memory/JOE.md
${currentJoe}

## Current memory/CULTURE.md
${currentCulture}

---

For each file that needs updating, output a section like:

### UPDATE: MEMORY.md
[New lines or sections to APPEND — decisions, lessons, infrastructure changes]

### UPDATE: JOE.md
[New info about Joe's preferences, working style, priorities — only if something changed]

### UPDATE: CULTURE.md
[New cultural context, team changes, principle refinements — only if something changed]

If a file doesn't need updating, skip it entirely. Be concise and factual. Only capture durable knowledge — not transient conversation details.`,
      }],
    });
    logUsage({ model: 'claude-sonnet-4-6', usage: response.usage, context: 'deep-consolidation' });

    const output = response.content[0].text.trim();
    if (!output || output.length < 30) {
      console.log(`  [DEEP] Nothing worth updating`);
      lastDeepConsolidatedAt.set(threadKey, Date.now());
      return;
    }

    // Parse and apply updates to each file
    const memoryUpdate = output.match(/### UPDATE: MEMORY\.md\n([\s\S]*?)(?=### UPDATE:|$)/)?.[1]?.trim();
    const joeUpdate = output.match(/### UPDATE: JOE\.md\n([\s\S]*?)(?=### UPDATE:|$)/)?.[1]?.trim();
    const cultureUpdate = output.match(/### UPDATE: CULTURE\.md\n([\s\S]*?)(?=### UPDATE:|$)/)?.[1]?.trim();

    const timestamp = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    if (memoryUpdate && memoryUpdate.length > 20) {
      fs.appendFileSync('./memory/MEMORY.md', `\n\n## Updated ${timestamp}\n\n${memoryUpdate}\n`, 'utf8');
      console.log(`  [DEEP] ✓ Updated MEMORY.md (+${memoryUpdate.length} chars)`);
    }
    if (joeUpdate && joeUpdate.length > 20) {
      fs.appendFileSync('./memory/JOE.md', `\n\n## Updated ${timestamp}\n\n${joeUpdate}\n`, 'utf8');
      console.log(`  [DEEP] ✓ Updated JOE.md (+${joeUpdate.length} chars)`);
    }
    if (cultureUpdate && cultureUpdate.length > 20) {
      fs.appendFileSync('./memory/CULTURE.md', `\n\n## Updated ${timestamp}\n\n${cultureUpdate}\n`, 'utf8');
      console.log(`  [DEEP] ✓ Updated CULTURE.md (+${cultureUpdate.length} chars)`);
    }

    // Log to session-log and Drive Live Log
    const deepEntry = `\n--- ${timestamp} (deep consolidation) ---\nUpdated memory files: ${[memoryUpdate && 'MEMORY.md', joeUpdate && 'JOE.md', cultureUpdate && 'CULTURE.md'].filter(Boolean).join(', ') || 'none'}\n`;
    fs.appendFileSync('./session-log.txt', deepEntry, 'utf8');
    await appendToGoogleDoc(MEMORY_IDS.liveLog, deepEntry);

    // Sync updated memory files to Drive backup
    await syncMemoryFilesToDrive();

    lastDeepConsolidatedAt.set(threadKey, Date.now());
    console.log(`  [DEEP] ✓ Deep consolidation complete`);
  } catch (err) {
    console.warn('Deep consolidation failed:', err.message);
  }
}

async function runDigest() {
  const drive = getDriveClient();
  const res = await drive.files.export(
    { fileId: MEMORY_IDS.liveLog, mimeType: 'text/plain' },
    { responseType: 'text' }
  );
  const liveLogContent = (res.data || '').trim();
  if (!liveLogContent || liveLogContent.length < 100) return null;

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
  logUsage({ model: 'claude-sonnet-4-6', usage: digestResponse.usage, context: 'weekly-digest' });

  const digest = digestResponse.content[0].text.trim();
  const week = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const digestEntry = `\n\n=== Week of ${week} ===\n${digest}`;

  await appendToGoogleDoc(MEMORY_IDS.weeklyDigest, digestEntry);
  await clearGoogleDoc(MEMORY_IDS.liveLog);
  await appendToGoogleDoc(MEMORY_IDS.liveLog, `--- Live Log reset after digest (${week}) ---\n`);

  return week;
}

async function runQuarterlyArchive() {
  console.log('  [ARCHIVE] Starting monthly archive...');
  const drive = getDriveClient();
  const res = await drive.files.export(
    { fileId: MEMORY_IDS.weeklyDigest, mimeType: 'text/plain' },
    { responseType: 'text' }
  );
  const digestContent = (res.data || '').trim();
  if (!digestContent || digestContent.length < 500) {
    console.log('  [ARCHIVE] Weekly digest too short to archive — skipping');
    return null;
  }

  const archiveResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are Jin, Chief of Staff at 88 Venture Studio. Compress these weekly digest entries into a quarterly archive summary. Keep only the most strategically important decisions, financial moves, relationship changes, and infrastructure milestones. Be ruthless — this is long-term memory. Format as flowing prose with a date range header.

Weekly Digests:
${digestContent.slice(-8000)}`,
    }],
  });
  logUsage({ model: 'claude-sonnet-4-6', usage: archiveResponse.usage, context: 'monthly-archive' });

  const archive = archiveResponse.content[0].text.trim();
  const month = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const archiveEntry = `\n\n=== Archive: ${month} ===\n${archive}`;

  await appendToGoogleDoc(MEMORY_IDS.quarterlyArchive, archiveEntry);
  await clearGoogleDoc(MEMORY_IDS.weeklyDigest);
  await appendToGoogleDoc(MEMORY_IDS.weeklyDigest, `--- Weekly Digest reset after archive (${month}) ---\n`);

  console.log(`  [ARCHIVE] ✓ Archived to quarterly doc, digest reset`);
  return month;
}

function scheduleConsolidation(threadKey) {
  // Quick consolidation — 2 min inactivity → Live Log
  if (inactivityTimers.has(threadKey)) clearTimeout(inactivityTimers.get(threadKey));
  const timer = setTimeout(() => {
    consolidateMemory(threadKey);
    inactivityTimers.delete(threadKey);
  }, INACTIVITY_MS);
  inactivityTimers.set(threadKey, timer);

  // Deep consolidation — 25 min no human response → update memory files
  if (deepConsolidationTimers.has(threadKey)) clearTimeout(deepConsolidationTimers.get(threadKey));
  const deepTimer = setTimeout(() => {
    deepConsolidateMemory(threadKey);
    deepConsolidationTimers.delete(threadKey);
  }, DEEP_CONSOLIDATION_MS);
  deepConsolidationTimers.set(threadKey, deepTimer);
}

// ─── Slack Block Text Extraction ──────────────────────────────────────────────

// Extract plain text from Slack's rich_text blocks.
// Long messages often arrive with text="" but full content in blocks[].
function extractTextFromBlocks(blocks) {
  if (!blocks || !Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'rich_text' && Array.isArray(block.elements)) {
      for (const section of block.elements) {
        if (!Array.isArray(section.elements)) continue;
        const sectionText = section.elements.map(el => {
          if (el.type === 'text') return el.text || '';
          if (el.type === 'link') return el.text || el.url || '';
          if (el.type === 'emoji') return `:${el.name}:`;
          if (el.type === 'user') return `<@${el.user_id}>`;
          if (el.type === 'channel') return `<#${el.channel_id}>`;
          return '';
        }).join('');
        parts.push(sectionText);
        // Add newlines between list items and sections
        if (section.type === 'rich_text_list' || section.type === 'rich_text_preformatted') {
          parts.push('\n');
        }
      }
    } else if (block.type === 'section' && block.text) {
      parts.push(block.text.text || '');
    }
  }
  return parts.join('\n').trim();
}

// Resolve the best available text from a Slack message.
// Prefers message.text but falls back to blocks if text is missing/short.
function resolveMessageText(message) {
  const text = (message.text || '').trim();
  const blocksText = extractTextFromBlocks(message.blocks);
  // Use blocks text if it's substantially longer than text field
  if (blocksText.length > text.length + 20) {
    console.log(`  ⚠ Using blocks text (${blocksText.length} chars) over message.text (${text.length} chars)`);
    return blocksText;
  }
  return text;
}

// ─── Thinking Indicator ───────────────────────────────────────────────────────

const WAIT_PHRASES = [
  'one sec...',
  'still on it...',
  'pulling that together...',
  'working on it...',
];

function randomWaitPhrase() {
  return WAIT_PHRASES[Math.floor(Math.random() * WAIT_PHRASES.length)];
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage({ text, files, channel, thread_ts, ts, client, systemPrompt, botToken, slackUser }) {
  console.log(`[MSG] channel=${channel} text="${(text || '').slice(0, 80)}"`);
  const isDM = channel.startsWith('D');
  // In DMs, never thread — always flat conversation. In channels, thread if replying.
  const effectiveThreadTs = isDM ? null : thread_ts;
  const threadKey = effectiveThreadTs || channel;
  const replyInThread = !isDM && (effectiveThreadTs || ts);

  // ── Interrupt: register immediately to prevent race conditions ──
  const controller = new AbortController();
  const existing = activeRequests.get(threadKey);
  if (existing) {
    console.log(`  [INTERRUPT] New message arrived — cancelling previous request`);
    existing.controller.abort();
    if (existing.ackTs) {
      client.chat.delete({ channel, ts: existing.ackTs }).catch(() => {});
    }
  }
  activeRequests.set(threadKey, { controller, ackTs: null, channel });

  // Standby mode: only respond if Mac Mini heartbeat is stale (Mac Mini is down).
  if (process.env.INSTANCE_ROLE === 'standby') {
    const macMiniAlive = await checkMacMiniAlive();
    if (macMiniAlive) { activeRequests.delete(threadKey); return; }
    systemPrompt = systemPrompt + '\n\n⚠️ FALLBACK MODE: Mac Mini is offline. You are responding from Hetzner standby. Gmail, Calendar, and Drive work. No shell or filesystem access. Let Joe know briefly.';
  }

  // Post immediate ack — just "ok"
  const ackPayload = { channel, text: 'ok' };
  if (replyInThread) ackPayload.thread_ts = replyInThread;
  let ackMsg;
  try {
    ackMsg = await client.chat.postMessage(ackPayload);
  } catch (ackErr) {
    console.error(`  ✗ ack failed: ${ackErr.message}`);
    activeRequests.delete(threadKey);
    return;
  }

  // Check if we were interrupted while posting the ack
  if (controller.signal.aborted) {
    client.chat.delete({ channel, ts: ackMsg.ts }).catch(() => {});
    return;
  }

  // Update entry with ack timestamp
  const entry = activeRequests.get(threadKey);
  if (entry?.controller === controller) entry.ackTs = ackMsg.ts;

  // Progress timer — if no streaming text after 30s, show "one sec..."
  let streamingStarted = false;
  const waitTimer = setTimeout(() => {
    if (!streamingStarted && !controller.signal.aborted) {
      client.chat.update({ channel, ts: ackMsg.ts, text: randomWaitPhrase() }).catch(() => {});
    }
  }, 30000);

  try {
    const userContent = await buildUserContent(text, files, botToken);

    // Snapshot history BEFORE appending, so callClaude doesn't double the user message
    const history = [...getHistory(threadKey)];

    // Save user message to history now — if interrupted, the next request has context
    appendHistory(threadKey, 'user', userContent);

    // In DMs: skip streaming updates entirely — chat.update modifies in-place which
    // makes the response appear stuck "in history". Instead, let the ack sit while
    // Claude generates, then post the response as a fresh new message at the bottom.
    const streamCallback = isDM ? null : (partialText) => {
      streamingStarted = true;
      clearTimeout(waitTimer);
      client.chat.update({ channel, ts: ackMsg.ts, text: partialText }).catch(() => {});
    };

    const reply = await callClaude(systemPrompt, history, userContent, controller.signal, streamCallback, { slackClient: client, channel, slackUser });

    appendHistory(threadKey, 'assistant', reply);

    if (isDM) {
      // Post the new message first (lands at bottom), then clean up the ack
      await client.chat.postMessage({ channel, text: reply });
      client.chat.delete({ channel, ts: ackMsg.ts }).catch(() => {});
    } else {
      await client.chat.update({ channel, ts: ackMsg.ts, text: reply });
    }

    // Observational memory — extract facts in background (fire-and-forget)
    extractAndSaveFacts(userContent, reply).catch(() => {});

    scheduleConsolidation(threadKey);
  } catch (err) {
    if (controller.signal.aborted) {
      console.log(`  [INTERRUPT] Aborted cleanly`);
      return;
    }
    console.error('Error:', err.message || err);
    // Show user-friendly message instead of raw API errors
    const errStr = String(err.message || err || '');
    let userMsg;
    if (err.status === 529 || err.error?.type === 'overloaded_error'
        || errStr.includes('overloaded') || errStr.includes('Overloaded')) {
      userMsg = 'Claude\'s servers are overloaded right now. Try again in a minute.';
    } else if (err.status === 429 || errStr.includes('rate_limit')) {
      userMsg = 'Hit a rate limit — give me a moment and try again.';
    } else if (err.status >= 500) {
      userMsg = 'Claude\'s API is having issues. Try again shortly.';
    } else {
      userMsg = `Sorry, I hit an error. Try again in a moment.`;
    }
    try {
      await client.chat.update({ channel, ts: ackMsg.ts, text: userMsg });
    } catch (updateErr) {
      console.error('  ✗ error update also failed:', updateErr.message);
    }
  } finally {
    clearTimeout(waitTimer);
    if (activeRequests.get(threadKey)?.controller === controller) {
      activeRequests.delete(threadKey);
    }
  }
}

// ─── Slack History Backfill ────────────────────────────────────────────────────

// Pull recent DM history from Slack to fill gaps from restarts/socket drops.
// Merges into conversation history without duplicating existing messages.
async function backfillSlackHistory(botToken, channelId, hoursBack = 72) {
  try {
    const { WebClient } = require('@slack/web-api');
    const web = new WebClient(botToken);

    const oldest = String((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
    const result = await web.conversations.history({
      channel: channelId,
      oldest,
      limit: 200,
      inclusive: true,
    });

    if (!result.messages || result.messages.length === 0) {
      console.log(`  ✓ Slack backfill: no messages in last ${hoursBack}h`);
      return 0;
    }

    // Messages come newest-first; reverse to chronological order
    const messages = result.messages.reverse();
    const history = getHistory(channelId);
    const existingTexts = new Set(history.map(m => m.content.slice(0, 100)));
    let added = 0;

    for (const msg of messages) {
      if (!msg.text || msg.subtype) continue; // skip system messages, edits, etc.
      const textPreview = msg.text.slice(0, 100);
      if (existingTexts.has(textPreview)) continue; // already in history

      const role = msg.bot_id ? 'assistant' : 'user';
      history.push({ role, content: msg.text });
      existingTexts.add(textPreview);
      added++;
    }

    // Trim to max history size
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    if (added > 0) saveHistoryToDisk(threadHistories);

    console.log(`  ✓ Slack backfill: ${added} new messages from last ${hoursBack}h (${messages.length} total scanned)`);
    return added;
  } catch (err) {
    console.warn(`  ✗ Slack backfill failed: ${err.message}`);
    return 0;
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

  // Backfill from Slack DM history — fills gaps from restarts/socket drops
  const JOE_DM_CHANNEL = 'D0AG94XK2NS';
  await backfillSlackHistory(process.env.SLACK_BOT_TOKEN, JOE_DM_CHANNEL, 72);

  // Resolve memory file backups on Drive
  await resolveMemoryBackupFiles();

  // Test if Jin's Google delegation is active
  await testJinDelegation();

  // Cache QBO company names
  try {
    await cacheCompanyNames();
    const qboTokens = loadQBOTokens();
    const qboCompanies = Object.values(qboTokens).map(t => t.companyName).filter(Boolean);
    if (qboCompanies.length > 0) console.log(`  ✓ QBO connected: ${qboCompanies.join(', ')}`);
  } catch {}

  // Connect MCP servers (Brave Search, Playwright, etc.)
  await connectMCPServers();

  let driveContext = '';
  try {
    driveContext = await loadDriveContext();
  } catch (err) {
    console.warn('Could not load Drive context:', err.message);
    driveContext = '(Drive context unavailable)';
  }

  const sessionLog = loadSessionLog();
  const memoryFiles = loadMemoryFiles();
  let memoryContext = '';
  try {
    memoryContext = await loadMemoryContext();
  } catch (err) {
    console.warn('Could not load memory context:', err.message);
  }
  const context = {
    systemPrompt: buildSystemPrompt(driveContext, sessionLog, memoryContext, memoryFiles),
    driveContext,
    memoryContext,
    memoryFiles,
  };
  const botToken = process.env.SLACK_BOT_TOKEN;

  // ─── Connection mode: HTTP (preferred, reliable) or Socket Mode (fallback) ───
  const useHttpMode = !!process.env.SLACK_SIGNING_SECRET;
  let app;

  if (useHttpMode) {
    // HTTP mode — Slack sends events via HTTP POST, no WebSocket, built-in retries
    const receiver = new ExpressReceiver({
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      processBeforeResponse: true,
    });
    // Log Slack requests only (skip internet scanner noise)
    receiver.router.use((req, res, next) => {
      if (req.headers['x-slack-signature'] || req.headers['x-slack-request-timestamp']) {
        console.log(`  [HTTP] ${req.method} ${req.url} sig=present ts=${req.headers['x-slack-request-timestamp']} ip=${req.headers['x-forwarded-for'] || 'local'}`);
      }
      next();
    });
    // Legal pages (for Intuit/QBO app compliance)
    receiver.router.get('/privacy', (req, res) => {
      res.sendFile(require('path').join(__dirname, 'public', 'privacy.html'));
    });
    receiver.router.get('/terms', (req, res) => {
      res.sendFile(require('path').join(__dirname, 'public', 'terms.html'));
    });
    // QBO connect page — one-click auth for any company
    receiver.router.get('/qbo/connect', (req, res) => {
      const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${process.env.QBO_CLIENT_ID}&redirect_uri=${encodeURIComponent('https://agents-mac-mini.tail8173ed.ts.net/qbo/callback')}&response_type=code&scope=${encodeURIComponent('com.intuit.quickbooks.accounting')}&state=studio88`;
      // Show connected companies before redirecting
      let connected = [];
      try {
        const allTokens = JSON.parse(fs.readFileSync('./qbo-tokens.json', 'utf8'));
        connected = Object.keys(allTokens);
      } catch {}
      if (req.query.go === '1') {
        return res.redirect(authUrl);
      }
      res.send(`<!DOCTYPE html><html><head><title>QBO Connect — Jin</title>
<style>body{font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#333}
a.btn{display:inline-block;background:#2CA01C;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:1.1em;margin:20px 0}
a.btn:hover{background:#248a17}.connected{background:#f5f5f5;padding:12px 16px;border-radius:6px;margin:10px 0}</style></head>
<body><h1>Connect a QuickBooks Company</h1>
${connected.length ? `<p><b>${connected.length} company(s) already connected:</b></p>${connected.map(r => `<div class="connected">RealmId: ${r}</div>`).join('')}` : ''}
<p>Click below to authorize another QuickBooks company. You'll be redirected to Intuit to sign in and pick a company.</p>
<a class="btn" href="/qbo/connect?go=1">Connect QuickBooks Company</a>
<p style="color:#888;font-size:0.85em">Each company needs a one-time authorization. Tokens are saved automatically.</p></body></html>`);
    });
    // QBO OAuth callback
    receiver.router.get('/qbo/callback', (req, res) => {
      const { code, realmId, state } = req.query;
      if (code && realmId) {
        res.send(`<!DOCTYPE html><html><head><title>QBO Connected</title>
<style>body{font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#333}
a.btn{display:inline-block;background:#2CA01C;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:1.1em;margin:20px 0}
.success{background:#e8f5e9;border:1px solid #2CA01C;padding:16px;border-radius:6px;margin:20px 0}</style></head>
<body><h1>Connected!</h1>
<div class="success"><b>Company (realmId):</b> ${realmId}<br>Tokens saved automatically.</div>
<a class="btn" href="/qbo/connect">Connect Another Company</a>
<p style="color:#888">Or close this tab if you're done.</p></body></html>`);
        // Auto-exchange the code for tokens
        const basicAuth = Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
        const postData = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent('https://agents-mac-mini.tail8173ed.ts.net/qbo/callback')}`;
        const https = require('https');
        const reqToken = https.request({
          hostname: 'oauth.platform.intuit.com',
          path: '/oauth2/v1/tokens/bearer',
          method: 'POST',
          headers: {
            'Authorization': `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        }, (tokenRes) => {
          let body = '';
          tokenRes.on('data', (chunk) => body += chunk);
          tokenRes.on('end', () => {
            try {
              const tokens = JSON.parse(body);
              if (tokens.error) {
                console.error(`  ✗ QBO token exchange failed: ${tokens.error}`);
                return;
              }
              const tokenData = { ...tokens, realmId, created_at: new Date().toISOString() };
              let allTokens = {};
              const TOKEN_PATH = './qbo-tokens.json';
              if (fs.existsSync(TOKEN_PATH)) {
                try { allTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch {}
              }
              allTokens[realmId] = tokenData;
              fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2), 'utf8');
              console.log(`  ✓ QBO tokens saved for realmId ${realmId}`);
            } catch (err) {
              console.error(`  ✗ QBO token parse error: ${err.message}`);
            }
          });
        });
        reqToken.write(postData);
        reqToken.end();
      } else {
        res.send(`<h2>QBO Authorization Failed</h2><p>Missing code or realmId.</p><pre>${JSON.stringify(req.query, null, 2)}</pre>`);
      }
    });
    app = new App({
      token: botToken,
      receiver,
    });
    console.log('  ✓ Mode: HTTP (reliable — no WebSocket, Slack retries failed deliveries)');
  } else {
    // Socket Mode fallback — WebSocket, no public endpoint needed, but stale connection risk
    app = new App({
      token: botToken,
      appToken: process.env.SLACK_APP_TOKEN,
      socketMode: true,
    });
    console.log('  ⚠ Mode: Socket Mode (fallback — set SLACK_SIGNING_SECRET to switch to HTTP)');

    // Tune Socket Mode timeouts BEFORE start() — defaults are too aggressive
    app.receiver.client.clientPingTimeoutMS = 15000;  // 15s (was 5s)
    app.receiver.client.serverPingTimeoutMS = 60000;  // 60s (was 30s)

    // Socket Mode connection lifecycle logging
    const sc = app.receiver.client;
    sc.on('connected', () => console.log('  ✓ Socket Mode: connected'));
    sc.on('connecting', () => console.log('  … Socket Mode: connecting...'));
    sc.on('disconnected', () => console.log('  ✗ Socket Mode: disconnected'));
    sc.on('reconnecting', () => console.log('  ↻ Socket Mode: reconnecting...'));
    sc.on('error', (err) => console.error('  ✗ Socket Mode error:', err.message || err));
    sc.on('unable_to_socket_mode_start', (err) => console.error('  ✗ Socket Mode unable to start:', err));
    // Capture raw WebSocket messages to read num_connections from hello (SDK discards it)
    sc.on('ws_message', (data) => {
      try {
        const evt = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
        if (evt.type === 'hello') {
          const numConns = evt.num_connections || 'unknown';
          console.log(`  [WS] hello — active connections: ${numConns}`);
          if (numConns > 1) {
            console.warn(`  ⚠ WARNING: ${numConns} connections detected — stale connections may be absorbing events!`);
            console.warn(`  ⚠ If Jin stops receiving messages, regenerate SLACK_APP_TOKEN in Slack dashboard.`);
          }
        }
      } catch {}
    });
  }

  // Event delivery tracking (watchdog uses this in Socket Mode; harmless no-op in HTTP mode)
  let lastEventReceived = Date.now();

  // Socket Mode only: watchdog to detect when events stop flowing
  if (!useHttpMode) {
    const EVENT_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;  // check every 5 min
    const EVENT_SILENCE_THRESHOLD_MS = 30 * 60 * 1000;  // alert after 30 min silence
    const sc = app.receiver.client;
    setInterval(() => {
      const silenceMs = Date.now() - lastEventReceived;
      if (silenceMs > EVENT_SILENCE_THRESHOLD_MS) {
        console.error(`  ✗ WATCHDOG: No events for ${Math.round(silenceMs / 60000)} min — possible stale connection. Reconnecting...`);
        sc.disconnect().then(() => sc.start()).catch(err => {
          console.error('  ✗ Reconnect failed:', err.message);
        });
        lastEventReceived = Date.now();
      }
    }, EVENT_WATCHDOG_INTERVAL_MS);
  }

  // HTTP mode retry deduplication — Slack retries with same event ts, skip duplicates
  const processedEvents = new Set();
  const DEDUP_TTL_MS = 5 * 60 * 1000; // keep event IDs for 5 min

  function isDuplicate(eventId) {
    if (!eventId || !useHttpMode) return false;
    if (processedEvents.has(eventId)) {
      console.log(`  [DEDUP] Skipping duplicate event: ${eventId}`);
      return true;
    }
    processedEvents.add(eventId);
    setTimeout(() => processedEvents.delete(eventId), DEDUP_TTL_MS);
    return false;
  }

  // DMs and channel messages
  app.message(async ({ message, client }) => {
    // Resolve text from blocks for long messages where text field may be empty
    const resolvedText = resolveMessageText(message);
    lastEventReceived = Date.now(); // reset watchdog timer
    console.log(`[EVENT] message received: subtype=${message.subtype} channel=${message.channel} text="${resolvedText.slice(0, 80)}" (${resolvedText.length} chars) bot_id=${message.bot_id || 'none'}`);
    // Skip bot messages (don't respond to ourselves or heartbeat)
    if (message.bot_id) return;
    // Skip duplicate events (HTTP mode retries)
    if (isDuplicate(message.client_msg_id || message.ts)) return;
    // Allow file_share (image/file only, no text) but skip edits, deletions, etc.
    const allowedSubtypes = [undefined, null, 'file_share'];
    if (!allowedSubtypes.includes(message.subtype)) return;
    if (!resolvedText && !message.files) return;

    // !reload — re-read session log, memory files, and rebuild system prompt without restarting
    if (resolvedText === '!reload') {
      const freshLog = loadSessionLog();
      const freshMemoryFiles = loadMemoryFiles();
      context.memoryFiles = freshMemoryFiles;
      context.systemPrompt = buildSystemPrompt(context.driveContext, freshLog, context.memoryContext, freshMemoryFiles);
      await client.chat.postMessage({ channel: message.channel, text: 'Reloaded. I\'m current.' });
      return;
    }

    // !digest — compress Live Log into Weekly Digest, mark log as digested
    if (resolvedText === '!digest') {
      await client.chat.postMessage({ channel: message.channel, text: 'On it — reading the live log...' });
      try {
        const week = await runDigest();
        if (!week) {
          await client.chat.postMessage({ channel: message.channel, text: 'Live log is empty — nothing to digest.' });
          return;
        }
        // Reload memory context so next messages use the new digest
        context.memoryContext = await loadMemoryContext();
        context.systemPrompt = buildSystemPrompt(context.driveContext, loadSessionLog(), context.memoryContext, context.memoryFiles);
        await client.chat.postMessage({ channel: message.channel, text: `Done. Weekly digest written and Live Log cleared for ${week}.` });
      } catch (err) {
        console.error('Digest failed:', err.message);
        await client.chat.postMessage({ channel: message.channel, text: `Digest failed: ${err.message}` });
      }
      return;
    }

    if (resolvedText === '!archive') {
      await client.chat.postMessage({ channel: message.channel, text: 'Running monthly archive...' });
      try {
        const month = await runQuarterlyArchive();
        if (!month) {
          await client.chat.postMessage({ channel: message.channel, text: 'Weekly digest is too short to archive — skipping.' });
          return;
        }
        context.memoryContext = await loadMemoryContext();
        context.systemPrompt = buildSystemPrompt(context.driveContext, loadSessionLog(), context.memoryContext, context.memoryFiles);
        await client.chat.postMessage({ channel: message.channel, text: `Archive complete for ${month}. Weekly digest compressed and moved to quarterly archive.` });
      } catch (err) {
        console.error('Archive failed:', err.message);
        await client.chat.postMessage({ channel: message.channel, text: `Archive failed: ${err.message}` });
      }
      return;
    }

    // !usage [days] — show AI infrastructure spend report
    if (resolvedText.startsWith('!usage')) {
      const daysMatch = resolvedText.match(/!usage\s+(\d+)/);
      const days = daysMatch ? parseInt(daysMatch[1], 10) : 7;
      const report = formatUsageReport(days);
      await client.chat.postMessage({ channel: message.channel, text: report });
      return;
    }

    // !build <task> — spawn Claude Code to execute a build task on the Mac Mini
    if (resolvedText.startsWith('!build ')) {
      const task = resolvedText.slice(7).trim();
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
      text: resolvedText,
      files: message.files,
      channel: message.channel,
      thread_ts: message.thread_ts,
      ts: message.ts,
      client,
      systemPrompt: context.systemPrompt,
      botToken,
      slackUser: message.user,
    });
  });

  // @mentions in channels
  app.event('app_mention', async ({ event, client }) => {
    lastEventReceived = Date.now(); // reset watchdog timer
    if (isDuplicate(event.client_msg_id || event.ts)) return;
    let text = resolveMessageText(event).replace(/<@[^>]+>/g, '').trim();

    await handleMessage({
      text,
      files: event.files,
      channel: event.channel,
      thread_ts: event.thread_ts,
      ts: event.ts,
      client,
      systemPrompt: context.systemPrompt,
      botToken,
      slackUser: event.user,
    });
  });

  const port = process.env.PORT || 3000;

  if (useHttpMode) {
    // HTTP mode — Bolt runs its own Express server on the port
    await app.start(port);
    console.log(`\nJin is running. (HTTP mode on port ${port})`);
  } else {
    // Socket Mode — WebSocket, no port needed for Slack, but start health check separately
    await app.start();
    console.log('\nJin is running. (Socket Mode)');

    // Health check server (for monitoring / Hetzner standby)
    const healthServer = http.createServer((req, res) => res.end('Jin is alive.'));
    healthServer.listen(port).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`  ⚠ Port ${port} in use — health check server skipped (non-fatal)`);
      } else {
        console.error('Health check server error:', err.message);
      }
    });
  }

  console.log('Supports: text, images, URLs, Drive links, web search, browser, screenshots, YouTube, PDFs');
  console.log('Memory: Live Log + Weekly Digest loaded at startup, auto-written after conversations\n');

  // ─── Scheduled Tasks (cron) ─────────────────────────────────────────────────
  const JOE_DM = 'D0AG94XK2NS';

  // Helper: send a proactive message to Joe as Jin (runs through Claude for natural tone)
  async function sendProactiveMessage(prompt) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        system: context.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      });
      logUsage({ model: 'claude-sonnet-4-6', usage: response.usage, context: 'proactive-message' });
      const text = response.content[0].text.trim();
      if (text) {
        await app.client.chat.postMessage({ channel: JOE_DM, text });
        console.log(`  [CRON] Sent proactive message (${text.length} chars)`);
      }
    } catch (err) {
      console.warn(`  ⚠ Cron message failed: ${err.message}`);
    }
  }

  // Morning briefing — Mon-Fri at 8:30 AM PST
  cron.schedule('30 8 * * 1-5', () => {
    console.log('  [CRON] Morning briefing triggered');
    sendProactiveMessage(
      `It's morning. Give Joe a brief daily briefing as Jin. Include:
1. What day/date it is
2. Any calendar events today (use get_calendar_events tool if available)
3. A quick check-in on top priorities from memory
4. One thing to focus on today based on what you know about the business

Keep it warm, concise, and actionable. 3-5 sentences max. Don't be generic — reference real context from your memory.`
    );
  }, { timezone: 'America/Los_Angeles' });

  // End of day wrap-up — Mon-Fri at 6:00 PM PST
  cron.schedule('0 18 * * 1-5', () => {
    console.log('  [CRON] EOD wrap-up triggered');
    sendProactiveMessage(
      `It's end of day. Give Joe a brief wrap-up as Jin. Include:
1. A short summary of what was discussed or accomplished today (check recent conversation history)
2. Any open items that need attention tomorrow
3. A brief encouraging note

Keep it to 2-4 sentences. Only mention things you actually know about — don't make up tasks.`
    );
  }, { timezone: 'America/Los_Angeles' });

  // Weekly digest — Sunday at 9:00 PM PST
  cron.schedule('0 21 * * 0', async () => {
    console.log('  [CRON] Weekly digest triggered');
    try {
      const week = await runDigest();
      if (week) {
        context.memoryContext = await loadMemoryContext();
        context.systemPrompt = buildSystemPrompt(context.driveContext, loadSessionLog(), context.memoryContext, context.memoryFiles);
        console.log(`  [CRON] ✓ Digest complete for ${week}`);
      }
    } catch (err) {
      console.warn('  [CRON] Digest failed:', err.message);
    }
    sendProactiveMessage(
      `It's Sunday evening. Give Joe a brief week-ahead preview as Jin. Include:
1. Key things that happened this past week (from your memory/Live Log)
2. What's coming up next week (check calendar if possible)
3. One strategic question or observation worth thinking about

Keep it concise — a short paragraph. Think like a real Chief of Staff prepping the CEO for Monday.`
    );
  }, { timezone: 'America/Los_Angeles' });

  // Weekly AI spend report — Monday at 9:00 AM PST
  cron.schedule('0 9 * * 1', async () => {
    console.log('  [CRON] Weekly usage report triggered');
    try {
      const report = formatUsageReport(7);
      await app.client.chat.postMessage({ channel: JOE_DM, text: report });
      console.log('  [CRON] ✓ Usage report sent');
    } catch (err) {
      console.warn('  [CRON] Usage report failed:', err.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  // Monthly archive — 1st of each month at 10:00 PM PST
  cron.schedule('0 22 1 * *', async () => {
    console.log('  [CRON] Monthly archive triggered');
    try {
      const month = await runQuarterlyArchive();
      if (month) {
        context.memoryContext = await loadMemoryContext();
        context.systemPrompt = buildSystemPrompt(context.driveContext, loadSessionLog(), context.memoryContext, context.memoryFiles);
        console.log(`  [CRON] ✓ Archive complete for ${month}`);
      }
    } catch (err) {
      console.warn('  [CRON] Archive failed:', err.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ─── Cross-Agent Digest — Friday 8:00 PM PST ─────────────────────────────
  // Jin reads all agent memory files, synthesizes executive brief, DMs Joe
  cron.schedule('0 20 * * 5', async () => {
    console.log('  [CRON] Cross-agent digest triggered');
    try {
      const agentDirs = [
        { name: 'Chip', owner: 'Jessica Vuong', dir: '/Users/agentserver/chip' },
        { name: 'Lucky', owner: 'Tracy Wang', dir: '/Users/agentserver/lucky' },
        { name: 'Jack', owner: 'Kathrine Gilmer', dir: '/Users/agentserver/jack' },
      ];
      const memFiles = ['SOUL.md', 'JOE.md', 'MEMORY.md', 'CULTURE.md'];
      let agentContext = '';

      for (const agent of agentDirs) {
        agentContext += `\n\n=== ${agent.name} (${agent.owner}) ===\n`;
        for (const f of memFiles) {
          const p = `${agent.dir}/memory/${f}`;
          if (fs.existsSync(p)) {
            const content = fs.readFileSync(p, 'utf8').slice(0, 3000);
            agentContext += `\n--- ${f} ---\n${content}\n`;
          }
        }
        // Also read conversation history summary if it exists
        const histPath = `${agent.dir}/conversation-history.json`;
        if (fs.existsSync(histPath)) {
          try {
            const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
            const threadCount = Object.keys(hist).length;
            agentContext += `\n--- Activity: ${threadCount} conversation thread(s) on file ---\n`;
          } catch (_) {}
        }
      }

      // Also read agent-inbox.json for any reports
      const inboxPath = path.join(__dirname, 'agent-inbox.json');
      let inboxContent = '';
      if (fs.existsSync(inboxPath)) {
        try {
          const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
          if (inbox.length > 0) {
            const recent = inbox.slice(-20);
            inboxContent = `\n\n=== Agent Reports to Jin (${inbox.length} total, showing last ${recent.length}) ===\n${JSON.stringify(recent, null, 2)}`;
          }
        } catch (_) {}
      }

      const digestPrompt = `You are Jin, doing your Friday evening cross-agent review. You have READ ACCESS to all team agent memory files. Here's what each agent has in their memory:\n${agentContext}${inboxContent}\n\nWrite a concise executive brief for Joe with these sections:\n\n**Key Findings** — What did each agent's owner accomplish or work on this week? What patterns do you see?\n\n**Cross-Functional Insights** — Any dependencies, overlaps, or synergies between what different team members are doing?\n\n**Implications for Joe** — What should Joe know, act on, or think about based on this data?\n\nKeep it tight — this is a Friday evening summary, not a report. Natural prose, Jin's voice. If an agent has no meaningful activity yet, say so briefly and move on.`;

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: context.systemPrompt,
        messages: [{ role: 'user', content: digestPrompt }],
      });
      logUsage({ model: 'claude-sonnet-4-6', usage: response.usage, context: 'cross-agent-digest' });

      const brief = response.content[0].text.trim();
      if (brief) {
        await app.client.chat.postMessage({ channel: JOE_DM, text: brief });
        console.log(`  [CRON] ✓ Cross-agent digest sent (${brief.length} chars)`);

        // Write digest to Jin's memory via write_to_memory tool pattern
        const digestNote = `\n\n--- Cross-Agent Digest (${new Date().toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles' })}) ---\n${brief.slice(0, 2000)}`;
        const liveLogPath = './memory/MEMORY.md';
        if (fs.existsSync(liveLogPath)) {
          fs.appendFileSync(liveLogPath, digestNote);
          console.log('  [CRON] ✓ Digest appended to Jin memory');
        }
      }

      // Clear processed inbox items
      if (fs.existsSync(inboxPath)) {
        try {
          const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
          if (inbox.length > 0) {
            // Archive to processed file, clear inbox
            const archivePath = path.join(__dirname, 'agent-inbox-archive.json');
            let archive = [];
            if (fs.existsSync(archivePath)) {
              try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf8')); } catch (_) {}
            }
            archive.push(...inbox);
            fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2));
            fs.writeFileSync(inboxPath, '[]');
            console.log(`  [CRON] ✓ Archived ${inbox.length} inbox items`);
          }
        } catch (_) {}
      }
    } catch (err) {
      console.warn('  [CRON] Cross-agent digest failed:', err.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  // ─── Agent Inbox Check — every 30 minutes during work hours ─────────────
  // Reads agent-inbox.json for urgent reports from Chip/Lucky/Jack, alerts Joe if needed
  cron.schedule('*/30 6-22 * * *', async () => {
    const inboxPath = path.join(__dirname, 'agent-inbox.json');
    if (!fs.existsSync(inboxPath)) return;
    try {
      const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      // Only alert on items marked urgent or flagged for immediate attention
      const urgent = inbox.filter(item => item.urgent || item.priority === 'high');
      if (urgent.length === 0) return;

      console.log(`  [CRON] Agent inbox: ${urgent.length} urgent item(s) found`);
      const urgentSummary = urgent.map(item =>
        `[${item.agent}] ${item.summary || item.observation || JSON.stringify(item).slice(0, 200)}`
      ).join('\n');

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: context.systemPrompt,
        messages: [{ role: 'user', content: `An agent on your team flagged something urgent. Here's what came in:\n\n${urgentSummary}\n\nBriefly relay this to Joe as Jin — what it is, which agent reported it, and whether Joe needs to act now or if it can wait. Be direct.` }],
      });
      logUsage({ model: 'claude-sonnet-4-6', usage: response.usage, context: 'agent-inbox-urgent' });

      const text = response.content[0].text.trim();
      if (text) {
        await app.client.chat.postMessage({ channel: JOE_DM, text });
        console.log(`  [CRON] ✓ Urgent agent report relayed to Joe`);
      }
    } catch (err) {
      console.warn('  [CRON] Agent inbox check failed:', err.message);
    }
  }, { timezone: 'America/Los_Angeles' });

  console.log('  ✓ Scheduled: morning briefing (8:30am), EOD wrap-up (6pm), weekly preview (Sun 9pm), usage report (Mon 9am), monthly archive (1st 10pm), cross-agent digest (Fri 8pm), inbox check (every 30min) — PST');

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // Graceful shutdown — properly disconnect so Slack doesn't keep stale connections (Socket Mode)
  // PM2 kill_timeout = 10s (ecosystem.config.js), so we force-exit at 8s to avoid SIGKILL
  const shutdown = async (signal) => {
    console.log(`\n  ↓ ${signal} received — shutting down gracefully...`);
    const forceTimer = setTimeout(() => {
      console.error('  ✗ Graceful shutdown timed out (8s) — forcing exit');
      process.exit(1);
    }, 8000);
    forceTimer.unref();
    try {
      await syncMemoryFilesToDrive();
      await app.stop();
      console.log('  ✓ Disconnected from Slack.');
    } catch (e) {
      console.error('  ✗ Error during shutdown:', e.message);
    }
    clearTimeout(forceTimer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
