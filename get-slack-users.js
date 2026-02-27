require('dotenv').config();
const https = require('https');

const token = process.env.SLACK_BOT_TOKEN;
const url = `https://slack.com/api/users.list`;

const req = https.request(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } }, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const r = JSON.parse(data);
    if (!r.ok) { console.error(r.error); return; }
    r.members.forEach(u => {
      if (u.is_bot || u.deleted || u.name === 'slackbot') return;
      console.log(`${u.id} | ${u.real_name || u.name} | ${u.profile.email || ''}`);
    });
  });
});
req.end();
