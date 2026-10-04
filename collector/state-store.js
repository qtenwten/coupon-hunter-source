'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
async function readJson(file, fallback) { if (!file) return fallback; try { const text = await fs.readFile(file, 'utf8'); return text.trim() ? JSON.parse(text) : fallback; } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function writeJsonAtomic(file, value) {
  if (!file) throw new Error('Atomic output path is required'); await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`; await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, file);
}
module.exports = { readJson, writeJsonAtomic };
