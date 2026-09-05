'use strict';

require('dotenv').config();

const { openDb } = require('./store');
const { createServer } = require('./server');
const { createBot, setupBotMenu } = require('./bot');

async function main() {
  const db = await openDb();
  console.log(`Store: ${process.env.DATABASE_URL ? 'postgres' : 'sqlite'}`);
  const app = createServer(db);
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => {
    console.log(`Panel: http://localhost:${port}  (PUBLIC_URL=${process.env.PUBLIC_URL || 'not set'})`);
  });

  const bot = createBot(db);
  const mode = (process.env.BOT_MODE || 'polling').toLowerCase();

  const stop = async (sig) => {
    console.log(`\n${sig} received, stopping...`);
    try { bot.stop(sig); } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if (mode === 'webhook') {
    const url = process.env.WEBHOOK_URL;
    const path = process.env.WEBHOOK_PATH || '/tg-webhook/secret';
    if (!url) throw new Error('WEBHOOK_URL is required in webhook mode');
    app.use(bot.webhookCallback(path));
    await bot.telegram.setWebhook(url.replace(/\/$/, '') + path);
    console.log(`Bot webhook: ${url}${path}`);
  } else {
    await bot.launch(() => console.log('Bot polling started'));
  }
  await setupBotMenu(bot); // command hints in the Telegram input field
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
