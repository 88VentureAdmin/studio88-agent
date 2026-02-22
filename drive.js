/**
 * drive.js — Read documents from a Google Drive folder using a service account
 *
 * Setup:
 *   1. Place your service account JSON key file at ./service-account.json
 *   2. Share your Drive folder with the service account email (Viewer access)
 *
 * Usage:
 *   node drive.js <folderId>
 *
 * Find your folder ID from the Drive URL:
 *   https://drive.google.com/drive/folders/THIS_IS_THE_FOLDER_ID
 */

const { google } = require('googleapis');
const fs = require('fs');
const mammoth = require('mammoth');

const SERVICE_ACCOUNT_PATH = './service-account.json';

/**
 * Build an authenticated Google Drive client using a service account key file.
 */
function getAuthClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(`Missing ${SERVICE_ACCOUNT_PATH} — download it from Google Cloud Console → IAM & Admin → Service Accounts → Keys.`);
  }

  const key = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return auth;
}

/**
 * List all files in a Drive folder (non-recursive).
 * Returns an array of { id, name, mimeType } objects.
 */
async function listFilesInFolder(drive, folderId) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType)',
      pageSize: 100,
      pageToken: pageToken || undefined,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Export a Google Doc as plain text.
 * Only works for mimeType = 'application/vnd.google-apps.document'
 */
async function exportDocAsText(drive, fileId) {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' }
  );
  return res.data;
}

/**
 * Download a regular file (PDF, txt, etc.) as a Buffer.
 */
async function downloadFile(drive, fileId) {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

/**
 * Download a .docx file and extract its plain text using mammoth.
 */
async function extractDocxText(drive, fileId) {
  const buffer = await downloadFile(drive, fileId);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function main() {
  const folderId = process.argv[2];
  if (!folderId) {
    console.error('Usage: node drive.js <folderId>');
    console.error('\nFind your folder ID in the Drive URL:');
    console.error('  https://drive.google.com/drive/folders/FOLDER_ID_HERE');
    process.exit(1);
  }

  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  console.log(`Listing files in folder: ${folderId}\n`);
  const files = await listFilesInFolder(drive, folderId);

  if (files.length === 0) {
    console.log('No files found. Check that the folder is shared with the service account email.');
    return;
  }

  console.log(`Found ${files.length} file(s):\n`);

  for (const file of files) {
    console.log(`  ${file.name}`);
    console.log(`   ID:   ${file.id}`);
    console.log(`   Type: ${file.mimeType}`);

    if (file.mimeType === 'application/vnd.google-apps.document') {
      const text = await exportDocAsText(drive, file.id);
      const preview = text.slice(0, 200).replace(/\n+/g, ' ').trim();
      console.log(`   Preview: ${preview}${text.length > 200 ? '...' : ''}`);
    } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const text = await extractDocxText(drive, file.id);
      const preview = text.slice(0, 200).replace(/\n+/g, ' ').trim();
      console.log(`   Preview: ${preview}${text.length > 200 ? '...' : ''}`);
    }

    console.log();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
