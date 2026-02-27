/**
 * Create the 88VS Team Capabilities & AI Readiness Survey as a Google Form
 * Uses Jin's OAuth tokens
 */
require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');

const JIN_TOKENS_PATH = process.env.JIN_GMAIL_TOKENS || './jin-gmail-tokens.json';

function getJinAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'http://localhost'
  );
  const tokens = JSON.parse(fs.readFileSync(JIN_TOKENS_PATH, 'utf8'));
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    fs.writeFileSync(JIN_TOKENS_PATH, JSON.stringify(updated, null, 2), 'utf8');
  });
  return oauth2Client;
}

async function createSurvey() {
  const auth = getJinAuth();
  const forms = google.forms({ version: 'v1', auth });

  // Use existing form if already created, otherwise create new
  let formId = '1g9MkpCMfCo6hHdM86cX6COOLBXA8YywTDIENRRKWHwU';
  let respondUrl, editUrl;

  try {
    const existing = await forms.forms.get({ formId });
    console.log(`Using existing form: ${formId}`);
    respondUrl = existing.data.responderUri;
    editUrl = `https://docs.google.com/forms/d/${formId}/edit`;
  } catch (e) {
    console.log('Creating new form...');
    const createRes = await forms.forms.create({
      requestBody: {
        info: {
          title: '88 Venture Studio — Team Capabilities & AI Readiness Survey',
          documentTitle: '88VS Team Capabilities & AI Readiness Survey',
        },
      },
    });
    formId = createRes.data.formId;
    respondUrl = createRes.data.responderUri;
    editUrl = `https://docs.google.com/forms/d/${formId}/edit`;
  }

  console.log(`Edit URL: ${editUrl}`);
  console.log(`Respond URL: ${respondUrl}`);

  // Step 2: Add description and all questions
  console.log('Adding questions...');

  const requests = [];
  let index = 0;

  // Form description
  requests.push({
    updateFormInfo: {
      info: {
        title: '88 Venture Studio — Team Capabilities & AI Readiness Survey',
        description: 'As we integrate AI tools across the company, we want to understand how each team member works today so we can provide the right training and tools. This is not a performance review — it\'s a planning exercise to invest in the team.\n\nPlease answer honestly and completely. Your responses will help us build better support systems for everyone.',
      },
      updateMask: 'description',
    },
  });

  // Helper to add a text question (with optional description)
  function addTextQ(title, required = true, paragraph = true, description = undefined) {
    const item = {
      title,
      questionItem: {
        question: {
          required,
          textQuestion: {
            paragraph,
          },
        },
      },
    };
    if (description) item.description = description;
    requests.push({
      createItem: {
        item,
        location: { index: index++ },
      },
    });
  }

  // Helper to add a scale question
  function addScaleQ(title, low, high, required = true) {
    requests.push({
      createItem: {
        item: {
          title,
          questionItem: {
            question: {
              required,
              scaleQuestion: {
                low: 1,
                high: 10,
                lowLabel: low,
                highLabel: high,
              },
            },
          },
        },
        location: { index: index++ },
      },
    });
  }

  // Helper to add a section header
  function addSection(title, description) {
    requests.push({
      createItem: {
        item: {
          title,
          description,
          textItem: {},
        },
        location: { index: index++ },
      },
    });
  }

  // Helper for checkbox question
  function addCheckboxQ(title, options, required = true) {
    requests.push({
      createItem: {
        item: {
          title,
          questionItem: {
            question: {
              required,
              choiceQuestion: {
                type: 'CHECKBOX',
                options: options.map(o => ({ value: o })),
              },
            },
          },
        },
        location: { index: index++ },
      },
    });
  }

  // --- Name ---
  addTextQ('Your full name', true, false);

  // --- Section 1: Role Clarity ---
  addSection('Section 1: Role Clarity', 'Help us understand what you actually do day-to-day.');

  addTextQ('List your top 5 tasks by time spent per week. For each task, estimate the hours per week you spend on it.', true, true, 'Example: Listing optimization (8 hrs), PPC campaign management (6 hrs), Inventory monitoring (4 hrs), Team coordination calls (3 hrs), Reporting (2 hrs)');

  addTextQ('Which of your tasks are repetitive/routine (same steps every time) vs. tasks that require your judgment, creativity, or decision-making? List a few examples of each.');

  addTextQ('What tools and software do you use daily? (e.g., Seller Central, Canva, Google Sheets, Slack, QuickBooks, Shopify, etc.)');

  addTextQ('Who do you collaborate with most frequently, and on what?', true, true, 'Example: "Joy — weekly PPC review; Tracy — inventory restocking coordination"');

  // --- Section 2: AI Familiarity ---
  addSection('Section 2: AI Familiarity', 'We want to understand your current experience with AI tools so we can plan training and support.');

  addCheckboxQ('Which AI tools have you used? (Select all that apply)', [
    'ChatGPT',
    'Claude',
    'Midjourney / DALL-E / AI image generators',
    'GitHub Copilot or other coding AI',
    'Amazon AI tools (listing optimizer, etc.)',
    'Canva AI features',
    'Google Gemini',
    'None of the above',
  ]);

  addScaleQ('How comfortable are you with learning and adopting new AI tools?', 'Not comfortable at all', 'Very comfortable — I enjoy learning new tools');

  addTextQ('Which of your current tasks do you think AI could help you do faster or better? Be specific.');

  addTextQ('Which of your tasks do you think AI could NOT do well? What makes those tasks uniquely human?');

  // --- Section 3: Growth & Capacity ---
  addSection('Section 3: Growth & Capacity', 'Help us understand your potential and what you\'d like to develop.');

  addTextQ('If your routine/repetitive tasks were automated by AI, what would you want to spend that freed-up time on?');

  addTextQ('What skills or knowledge would you like to develop in the next 6 months?');

  addTextQ('Do you feel you have capacity to take on additional responsibilities right now? If yes, what kind of work interests you?');

  // --- Section 4: Communication & Workflow ---
  addSection('Section 4: Communication & Workflow', 'Help us improve how the team works together.');

  addTextQ('How do you typically report progress or flag issues to leadership?', true, true, 'Examples: "I send a weekly summary on Slack", "I wait until asked", "I message Joe directly when something is urgent"');

  addTextQ('What is your preferred way to receive instructions and feedback?', true, true, 'Examples: "Written instructions in Slack", "Video call walkthrough", "Short voice memo"');

  addTextQ('What is the biggest bottleneck or frustration in your current workflow? What slows you down the most?');

  // --- Apple Deng extra question ---
  addSection('Section 5: Role-Specific (Optional)', 'If applicable to your role, please answer the following.');

  addTextQ('If you manage a specific account or client (e.g., Boley, J.Adams), please list every deliverable and task you handle for that account on a weekly basis. Include: client touchpoints, reports, content creation, meetings, etc.', false);

  // Execute batch update
  await forms.forms.batchUpdate({
    formId,
    requestBody: { requests },
  });

  console.log('\n✓ Survey created successfully!');
  console.log(`\nShare this link with the team: ${respondUrl}`);
  console.log(`Edit form here: ${editUrl}`);

  return { formId, respondUrl, editUrl };
}

createSurvey().catch(err => {
  console.error('Failed:', err.message);
  if (err.message.includes('insufficient') || err.message.includes('scope') || err.message.includes('403')) {
    console.log('\n→ Need to add Google Forms scope to Jin\'s OAuth tokens.');
    console.log('  Required scope: https://www.googleapis.com/auth/forms.body');
  }
  process.exit(1);
});
