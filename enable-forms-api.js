/**
 * Enable Google Forms API on project 519471037032 using service account
 */
require('dotenv').config();
const { google } = require('googleapis');

async function enableFormsAPI() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });

  const serviceUsage = google.serviceusage({ version: 'v1', auth });

  const projectId = 'projects/519471037032';

  console.log('Enabling Google Forms API...');

  try {
    const res = await serviceUsage.services.enable({
      name: `${projectId}/services/forms.googleapis.com`,
    });
    console.log('✓ Forms API enabled:', res.data.name || 'success');
    console.log('  Note: May take 1-2 minutes to propagate.');
  } catch (err) {
    console.error('Failed:', err.message);
    if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  }
}

enableFormsAPI();
