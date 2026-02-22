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

// ─── Google Drive ─────────────────────────────────────────────────────────────

function getDriveClient() {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

async function appendToGoogleDoc(docId, text) {
  try {
    const drive = getDriveClient();
    const res = await drive.files.export({ fileId: docId, mimeType: 'text/plain' });
    const current = res.data || '';
    const updated = current + text;
    await drive.files.update({
      fileId: docId,
      media: { mimeType: 'text/plain', body: updated },
    });
  } catch (err) {
    console.warn(`  ✗ Failed to append to doc ${docId}: ${err.message}`);
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

// ─── Claude ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic();

function buildSystemPrompt(driveContext, sessionLog, memoryContext) {
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
  // userContent is either a string or { content: [...blocks], historyText }
  const messageContent = typeof userContent === 'string' ? userContent : userContent.content;

  const messages = [...history, { role: 'user', content: messageContent }];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

// ─── Conversation History ─────────────────────────────────────────────────────

const HISTORY_PATH = './conversation-history.json';

function loadHistoryFromDisk() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      console.log(`  ✓ Loaded conversation history (${Object.keys(data).length} thread(s))`);
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
  // Store plain text in history (avoid storing large base64 blobs)
  const stored = typeof content === 'string' ? content : content.historyText || '[message]';
  history.push({ role, content: stored });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  saveHistoryToDisk(threadHistories);
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
