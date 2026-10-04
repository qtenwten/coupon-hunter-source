'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { productionQualityGate } = require('./production-feed');

async function verifyProductionFile(file = '.production-pages/promo-feed.json', options = {}) {
  let feed;
  try { feed = JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); } catch (_) { const error = new Error('PRODUCTION_FEED_FILE_INVALID'); error.code = error.message; throw error; }
  const gate = productionQualityGate(feed, options.publicKeyJwk);
  return { feed, ...gate };
}

async function main() {
  const result = await verifyProductionFile(process.argv[2]);
  console.log(`Production signature verified: signatureValid=${result.signatureValid} promos=${result.feed.promos.length} bytes=${result.bytes}`);
}

if (require.main === module) main().catch((error) => { console.error(`Production verification failed safely: ${error?.code || 'PRODUCTION_VERIFY_FAILED'}`); process.exitCode = 1; });

module.exports = { verifyProductionFile };
