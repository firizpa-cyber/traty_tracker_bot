'use strict';
// Google Sheets выписка. Optional: works only when configured, otherwise the
// panel hides the button (see /api/config -> sheetsEnabled).
//
// Setup (one time):
// 1. console.cloud.google.com -> create project -> enable Google Sheets API.
// 2. Credentials -> Create -> Service account -> create key (JSON), download.
// 3. Create a spreadsheet, share it with the service account email (Editor).
// 4. Env: GOOGLE_SERVICE_ACCOUNT_JSON='<whole json, one line>',
//    GOOGLE_SHEET_ID='<id from the sheet URL>'.
//    Optional: GOOGLE_SHEET_RANGE='A1' (tab name, e.g. 'Траты!A1').

const HEADER = ['date', 'description', 'category', 'amount', 'currency', 'amount_base', 'base_currency'];

function isConfigured() {
  return !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_SHEET_ID);
}

function range() {
  return process.env.GOOGLE_SHEET_RANGE || 'A1';
}

// rows: db expense rows (snake_case). Appends oldest-first, adds header once.
async function appendExpenses(rows) {
  if (!isConfigured()) throw new Error('Google Sheets not configured');
  let googleapis;
  try {
    googleapis = require('googleapis');
  } catch (_) {
    throw new Error('npm package "googleapis" is not installed');
  }
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new googleapis.google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = googleapis.google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const values = [...rows]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.id - b.id))
    .map((r) => [r.day, r.description, r.category, r.amount, r.currency, r.amount_base, r.base_currency]);

  // Add header if the sheet/tab is empty.
  try {
    const head = await sheets.spreadsheets.values.get({ spreadsheetId, range: range() });
    if (!head.data.values || head.data.values.length === 0) {
      values.unshift(HEADER);
    }
  } catch (_) {
    values.unshift(HEADER); // fresh tab: start with header
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: range(),
    valueInputOption: 'RAW',
    requestBody: { values },
  });
  return { count: values.length, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

module.exports = { isConfigured, appendExpenses };
