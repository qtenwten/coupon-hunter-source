const { test } = require('./harness');
const { FakeElement, FakeMutationObserver, sandbox, load } = require('./helpers');

const chrome = { runtime: { onMessage: { addListener() {} } }, storage: { local: { async set() {} } } };
const document = { documentElement: {}, querySelectorAll() { return []; } };
const box = load(sandbox({ chrome, document, Element: FakeElement, MutationObserver: FakeMutationObserver, location: { href: 'https://aliexpress.ru/', pathname: '/', search: '' } }), 'src/parser-core.js', 'src/search-content.js');
const S = box.CouponHunterSearch;

test('search parser reuses shared money parser and relevance', (t) => {
  t.deep(S.rubles('от 8 990–12 990 ₽').map((row) => row.value).sort((a, b) => a - b), [8990, 12990]);
  t.equal(S.itemIdFromUrl('https://aliexpress.ru/item/1005001234567890.html'), '1005001234567890');
  t.ok(S.relevance('Flydigi APEX 5 игровой контроллер', 'Flydigi APEX 5') >= 0.95);
  t.ok(S.relevance('Чехол для смартфона', 'Flydigi APEX 5') < 0.45);
  t.deep(S.tokens('Flydigi APEX-5'), ['flydigi', 'apex', '5']);
});
