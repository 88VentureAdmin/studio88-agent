require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

const JIN_TOKENS_PATH = process.env.JIN_GMAIL_TOKENS || './jin-gmail-tokens.json';
const CODE = '4/0AfrIepBUmBZ0DrFv8_XAGSHUOtanBMStk_rhjJCBGxmhdjdIDHMoBAi0bGH09I-MEkdFJQ';

async function exchangeToken() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost'
  );

  const { tokens } = await oauth2Client.getToken(CODE);

  let existing = {};
  if (fs.existsSync(JIN_TOKENS_PATH)) {
    existing = JSON.parse(fs.readFileSync(JIN_TOKENS_PATH, 'utf8'));
  }
  const merged = { ...existing, ...tokens };
  fs.writeFileSync(JIN_TOKENS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log('Jin tokens updated with Forms scope!');
  console.log('Scopes:', tokens.scope);
}

exchangeToken().catch(err => console.error('Failed:', err.message));
