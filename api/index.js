'use strict';
// Vercel serverless entry point.
//
// Vercel can't hold a polling connection, so the bot runs in webhook mode:
// Telegram POSTs updates to WEBHOOK_PATH, this function answers them.
// The public webhook URL is taken from WEBHOOK_URL, or auto-derived from
// VERCEL_URL on the first cold start (setWebhook is idempotent).
//
// NOTE: serverless has no persistent disk. SQLite lives in /tmp and resets
// on redeploy/cold start. Fine for a demo; for real data use a host with a
// persistent disk (see README: Render/Docker) or an external database.

if (process.env.VERCEL && !process.env.DATA_DIR) process.env.DATA_DIR = '/tmp';

try {
  require('dotenv').config();
} catch (_) {}

const { openDb } = require('../src/db');
const { createServer } = require('../src/server');
const { createBot, setupBotMenu } = require('../src/bot');

const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/tg-webhook/vercel';

let app = null;

function webhookBaseUrl() {
  if (process.env.WEBHOOK_URL) return process.env.WEBHOOK_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}

function getApp() {
  if (app) return app;
  const db = openDb();
  const server = createServer(db);
  const bot = createBot(db);
  server.use(bot.webhookCallback(WEBHOOK_PATH));
  const base = webhookBaseUrl();
  if (base) {
    bot.telegram
      .setWebhook(base + WEBHOOK_PATH)
      .then(() => setupBotMenu(bot))
      .then(() => console.log('Webhook set:', base + WEBHOOK_PATH))
      .catch((e) => console.error('setWebhook failed:', e.message));
  } else {
    console.error('WEBHOOK_URL/VERCEL_URL is not set — bot will not receive updates');
  }
  app = server;
  return app;
}

module.exports = (req, res) => getApp()(req, res);
