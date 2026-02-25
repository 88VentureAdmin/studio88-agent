/**
 * One-time QuickBooks Online OAuth setup script.
 * Run: node setup-qbo.js
 *
 * This will:
 *   1. Print an auth URL — open it in your browser
 *   2. Authorize as your QuickBooks admin account
 *   3. Browser redirects to localhost (will fail to load — that's normal)
 *   4. Copy the full URL from the address bar and paste it here
 *   5. Tokens + realmId saved to qbo-tokens.json
 *
 * You'll need to run this once per QBO company (brand) if they're on separate QBO accounts.
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const readline = require('readline');

const CLIENT_ID = process.env.QBO_CLIENT_ID;
const CLIENT_SECRET = process.env.QBO_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost';
const SCOPES = 'com.intuit.quickbooks.accounting';
const TOKEN_PATH = './qbo-tokens.json';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing QBO_CLIENT_ID or QBO_CLIENT_SECRET in .env');
  process.exit(1);
}

const authUrl = `https://appcenter.intuit.com/connect/oauth2?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&state=studio88`;

console.log('\n─────────────────────────────────────────');
console.log('Jin — QuickBooks Online OAuth Setup');
console.log('─────────────────────────────────────────');
console.log('\nStep 1: Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nStep 2: Sign in to QuickBooks and authorize.');
console.log('Step 3: You\'ll be redirected to localhost (will fail — that\'s fine).');
console.log('Step 4: Copy the full URL from your browser\'s address bar.');
console.log('        It looks like: http://localhost/?code=...&realmId=...');
console.log('\n─────────────────────────────────────────\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Paste the full redirect URL: ', async (input) => {
  rl.close();

  const url = new URL(input.trim());
  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');

  if (!code) {
    console.error('\n✗ Could not find "code" in the URL. Make sure you copied the full redirect URL.');
    process.exit(1);
  }

  if (!realmId) {
    console.error('\n✗ Could not find "realmId" in the URL. Make sure you copied the full redirect URL.');
    process.exit(1);
  }

  console.log(`\nCompany (realmId): ${realmId}`);
  console.log('Exchanging code for tokens...');

  // Exchange auth code for tokens
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const postData = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  const options = {
    hostname: 'oauth.platform.intuit.com',
    path: '/oauth2/v1/tokens/bearer',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      try {
        const tokens = JSON.parse(body);

        if (tokens.error) {
          console.error(`\n✗ Token exchange failed: ${tokens.error} — ${tokens.error_description || ''}`);
          process.exit(1);
        }

        // Save tokens with realmId
        const tokenData = {
          ...tokens,
          realmId,
          created_at: new Date().toISOString(),
        };

        // If file exists, merge (support multiple companies)
        let allTokens = {};
        if (fs.existsSync(TOKEN_PATH)) {
          try { allTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch {}
        }
        allTokens[realmId] = tokenData;

        fs.writeFileSync(TOKEN_PATH, JSON.stringify(allTokens, null, 2), 'utf8');

        console.log(`\n✓ Tokens saved to ${TOKEN_PATH}`);
        console.log(`  RealmId: ${realmId}`);
        console.log(`  Access token: ${tokens.access_token?.slice(0, 30)}...`);
        console.log(`  Refresh token: ${tokens.refresh_token ? 'present ✓' : 'MISSING'}`);
        console.log(`  Expires in: ${tokens.expires_in}s (access), ${tokens.x_refresh_token_expires_in}s (refresh)`);
        console.log('\nTo add another QBO company, run this script again and authorize a different company.');
        console.log('Done. Restart Jin to activate QBO tools.\n');
      } catch (err) {
        console.error('\n✗ Failed to parse token response:', err.message);
        console.error('Raw response:', body);
        process.exit(1);
      }
    });
  });

  req.on('error', (err) => {
    console.error('\n✗ Request failed:', err.message);
    process.exit(1);
  });

  req.write(postData);
  req.end();
});
