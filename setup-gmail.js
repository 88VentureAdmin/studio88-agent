/**
 * One-time Gmail + Calendar OAuth setup script.
 * Run: node setup-gmail.js
 *
 * This will:
 *   1. Print an auth URL — open it in your browser
 *   2. Authorize as joe@studio-88.com (or your Google account)
 *   3. Browser redirects to localhost (will fail to load — that's normal)
 *   4. Copy the `code=` value from the URL bar and paste it here
 *   5. Tokens saved to gmail-tokens.json
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];

const TOKEN_PATH = './gmail-tokens.json';

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'http://localhost'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force refresh token even if already authorized
});

console.log('\n─────────────────────────────────────────');
console.log('Jin — Gmail + Calendar OAuth Setup');
console.log('─────────────────────────────────────────');
console.log('\nStep 1: Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nStep 2: Authorize the account.');
console.log('Step 3: You\'ll be redirected to localhost (will fail — that\'s fine).');
console.log('Step 4: Copy the full URL from your browser\'s address bar.');
console.log('        It looks like: http://localhost/?code=4/0AX...&scope=...');
console.log('\n─────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the full redirect URL (or just the code= value): ', async (input) => {
  rl.close();

  let code = input.trim();

  // If they pasted the full URL, extract the code
  const match = code.match(/[?&]code=([^&]+)/);
  if (match) code = decodeURIComponent(match[1]);

  try {
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('\n✓ Tokens saved to gmail-tokens.json');
    console.log('  Access token:', tokens.access_token?.slice(0, 30) + '...');
    console.log('  Refresh token:', tokens.refresh_token ? 'present ✓' : 'MISSING — re-run with fresh auth');
    console.log('\nDone. Restart Jin to activate Gmail + Calendar tools.\n');
  } catch (err) {
    console.error('\n✗ Token exchange failed:', err.message);
    console.error('Make sure you copied the full URL or just the code value.\n');
    process.exit(1);
  }
});
