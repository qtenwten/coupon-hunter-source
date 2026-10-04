const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class FakeElement {
  constructor({ tag = 'div', text = '', attrs = {}, rect = {}, style = {}, className = '', id = '', children = [] } = {}) {
    this.tagName = tag.toUpperCase(); this.textContent = text; this.innerText = text;
    this.attrs = { ...attrs }; this.className = className; this.id = id; this.children = children;
    this.parentElement = null; this.href = attrs.href || ''; this.type = attrs.type || '';
    this.disabled = false; this.readOnly = false;
    this.rect = { top: 100, left: 500, width: 200, height: 30, bottom: 130, ...rect };
    this.style = { display: 'block', visibility: 'visible', opacity: '1', fontSize: '14px', fontWeight: '400', textDecorationLine: 'none', ...style };
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getBoundingClientRect() { return this.rect; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  matches(selector) {
    if (selector.includes('data-pl') && this.attrs['data-pl']) return true;
    if (selector.includes('data-testid') && this.attrs['data-testid']) return true;
    if (selector.includes('aria-label') && this.attrs['aria-label']) return true;
    return false;
  }
  closest(selector) {
    let node = this;
    const id = selector.startsWith('#') ? selector.slice(1) : null;
    while (node) { if (id && node.id === id) return node; node = node.parentElement; }
    return null;
  }
  click() { this.clicked = (this.clicked || 0) + 1; }
}

class FakeMutationObserver {
  static instances = [];
  constructor(callback) { this.callback = callback; this.disconnected = false; FakeMutationObserver.instances.push(this); }
  observe() {}
  disconnect() { this.disconnected = true; }
  trigger(mutations) { if (!this.disconnected) this.callback(mutations); }
}

class FakeDocument {
  constructor(map = {}, { title = 'AliExpress test', bodyText = '', lang = 'ru-RU' } = {}) {
    this.map = new Map(Object.entries(map)); this.title = title;
    this.body = { innerText: bodyText, textContent: bodyText };
    this.documentElement = { lang };
  }
  querySelectorAll(selector) { return this.map.get(selector) || []; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function sandbox(extra = {}) {
  const value = {
    console, URL, URLSearchParams, Intl, Date, Math, JSON, Promise,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Element: FakeElement, MutationObserver: FakeMutationObserver,
    getComputedStyle: (el) => el?.style || { display: 'block', visibility: 'visible', opacity: '1' },
    navigator: { language: 'ru-RU' }, innerHeight: 900,
    ...extra
  };
  value.globalThis = value;
  value.window ||= value;
  vm.createContext(value);
  return value;
}

function load(value, ...files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), value, { filename: file });
  return value;
}

function fixture(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')); }

module.exports = { ROOT, FakeElement, FakeMutationObserver, FakeDocument, sandbox, load, fixture };
