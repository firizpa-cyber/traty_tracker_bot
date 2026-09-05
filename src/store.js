'use strict';
// Storage selector: Postgres when a connection string is set (persistent -
// the only correct option on Vercel/serverless), otherwise the local SQLite
// file (local dev, single-server deploys with a disk).
//
// Vercel Postgres exposes POSTGRES_PRISMA_URL (pooled, preferred),
// POSTGRES_URL, or a custom DATABASE_URL.
const url = process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL;
if (url && !process.env.DATABASE_URL) process.env.DATABASE_URL = url;
module.exports = process.env.DATABASE_URL ? require('./pgstore') : require('./db');
