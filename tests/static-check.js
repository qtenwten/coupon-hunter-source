const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers');

const jsFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.name.endsWith('.js')) jsFiles.push(file);
  }
}
walk(path.join(ROOT, 'src'));
walk(path.join(ROOT, 'tests'));
walk(path.join(ROOT, 'collector'));
for (const file of ['test-parser.js', 'test-search.js', 'test-promo.js']) jsFiles.push(path.join(ROOT, file));

for (const file of jsFiles) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax error: ${file}`);
}

for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((name) => name.endsWith('.js') && name !== 'safety.js')) {
  const source = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
  if (/\.click\s*\(/.test(source)) throw new Error(`${file}: programmatic click bypasses src/safety.js`);
}

for (const file of ['manifest.json', 'package.json', 'data/known-codes.json', 'data/promo-feed.dev.json', 'tests/fixtures/money-formats.json', 'tests/fixtures/promotions.json', 'tests/fixtures/checkout-summary.json', 'tests/fixtures/verification-messages.json', 'collector/fixtures/manual-curated.json', 'collector/fixtures/aliexpress-open-platform.json', 'collector/fixtures/verified-provider-a.json', 'collector/fixtures/verified-provider-b.json', 'collector/fixtures/reddit-api.json', 'collector/fixtures/feedico-catalog.json']) {
  JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

const html = fs.readFileSync(path.join(ROOT, 'src/popup.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
for (const file of ['src/popup.js', 'src/popup-promos.js']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const match of source.matchAll(/\$\('([^']+)'\)/g)) {
    if (!ids.has(match[1])) throw new Error(`${file}: missing popup element #${match[1]}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
if (manifest.version !== require(path.join(ROOT, 'package.json')).version) throw new Error('Manifest/package version mismatch');
const contentFiles = manifest.content_scripts.flatMap((row) => row.js || []);
for (const file of contentFiles) if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`Missing manifest script: ${file}`);

console.log(`Static checks: OK (${jsFiles.length} JavaScript files, popup/manifest/JSON validated)`);
