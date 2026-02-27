/**
 * Re-auth Jin with Google Forms scope added
 * Run this, open the URL in a browser, sign in as jin@studio-88.com,
 * paste the auth code back here.
 */
require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const JIN_TOKENS_PATH = process.env.JIN_GMAIL_TOKENS || './jin-gmail-tokens.json';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/forms.body',       // NEW
  'https://www.googleapis.com/auth/forms.responses.readonly', // NEW — to read responses
];

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'http://localhost'
);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',       // force new refresh token with all scopes
  login_hint: 'jin@studio-88.com',
});

console.log('\n1. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n2. Sign in as jin@studio-88.com');
console.log('3. You\'ll get redirected to localhost with a ?code= parameter');
console.log('4. Copy the code and paste it below:\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Auth code: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oauth2Client.getToken(code);
    // Preserve existing tokens, merge new ones
    let existing = {};
    if (fs.existsSync(JIN_TOKENS_PATH)) {
      existing = JSON.parse(fs.readFileSync(JIN_TOKENS_PATH, 'utf8'));
    }
    const merged = { ...existing, ...tokens };
    fs.writeFileSync(JIN_TOKENS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    console.log('\n✓ Jin tokens updated with Forms scope!');
    console.log('  Scopes:', tokens.scope);
    console.log(`  Saved to: ${JIN_TOKENS_PATH}`);
  } catch (err) {
    console.error('Failed:', err.message);
  }
});
