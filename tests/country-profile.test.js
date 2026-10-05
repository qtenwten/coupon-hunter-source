const { test } = require('./harness');
const fs = require('node:fs');
const { ROOT } = require('./helpers');
const { sandbox, load } = require('./helpers');

const box = load(sandbox(), 'src/country-profile.js');
const Country = box.CouponHunterCountryProfile;

test('country settings default to AUTO with unknown codes included', (t) => {
  t.deep(Country.sanitizeSettings({}), { promoCountryMode: 'AUTO', promoCountry: null, includeUnknownCountryCodes: true });
});

test('country AUTO detector does not use IP browser geolocation timezone or document language', (t) => {
  const source = fs.readFileSync(`${ROOT}/src/country-profile.js`, 'utf8');
  t.ok(!/navigator\.geolocation|timezone|timeZone|documentElement\.lang|ipapi|geoip/i.test(source));
});

test('AUTO uses a strong structured AliExpress country signal', (t) => {
  const signal = Country.detectStructuredCountry({ checkout: { destinationCountry: 'RU' } });
  t.deep(signal, { code: 'RU', strong: true, source: 'ALIEXPRESS_STRUCTURED' });
  t.deep(Country.resolveTarget({}, signal), { code: 'RU', mode: 'AUTO', source: 'AUTO', evidenceType: 'ALIEXPRESS_STRUCTURED' });
});

test('AUTO without reliable site country uses saved fallback', (t) => {
  const target = Country.resolveTarget({ promoCountryMode: 'AUTO', promoCountry: 'DE' }, { code: null, strong: false, source: 'NONE' });
  t.deep(target, { code: 'DE', mode: 'AUTO', source: 'USER_FALLBACK' });
});

test('AUTO does not infer country from currency language or address-like text', (t) => {
  const signal = Country.detectStructuredCountry({ checkout: { currency: 'RUB', locale: 'ru-RU', city: 'Москва', street: 'Тверская' } });
  t.equal(signal.code, null); t.equal(signal.strong, false);
});

test('generic countryCode outside checkout structure is not a shipping-country signal', (t) => {
  const signal = Country.detectStructuredCountry({ product: { seller: { countryCode: 'DE' } }, recommendations: [{ countryCode: 'US' }] });
  t.equal(signal.code, null); t.equal(signal.strong, false);
  t.equal(Country.detectStructuredCountry({ checkout: { countryCode: 'RU' } }).code, 'RU');
});

test('conflicting structured country fields fail closed', (t) => {
  const signal = Country.detectStructuredCountry({ checkout: { shippingCountry: 'RU', destinationCountry: 'DE' } });
  t.equal(signal.code, null); t.equal(signal.source, 'STRUCTURED_CONFLICT'); t.deep(signal.candidates, ['DE', 'RU']);
});

test('target RU and explicit RU candidate is MATCH', (t) => {
  t.equal(Country.classifyCandidate({ code: 'RUSAVE', regions: ['RU'] }, 'RU').countryMatch, 'MATCH');
  t.equal(Country.classifyCandidate({ code: 'RUSAVE', title: 'Промокод для России' }, 'RU').countryMatch, 'MATCH');
});

test('target RU and explicit DE candidate is MISMATCH', (t) => {
  t.equal(Country.classifyCandidate({ code: 'GERMAN10', regions: ['DE'] }, 'RU').countryMatch, 'MISMATCH');
});

test('empty regions are UNKNOWN rather than GLOBAL', (t) => {
  t.equal(Country.classifyCandidate({ code: 'SAVE10', regions: [] }, 'RU').countryMatch, 'UNKNOWN');
});

test('explicit WORLDWIDE marker is GLOBAL', (t) => {
  t.equal(Country.classifyCandidate({ code: 'WORLD10', regions: ['WORLDWIDE'] }, 'RU').countryMatch, 'GLOBAL');
});

test('UK metadata and AEUK family are conservatively classified as GB', (t) => {
  const metadata = Country.classifyCandidate({ code: 'SAVEUK', title: 'Offer for United Kingdom customers' }, 'RU');
  const marker = Country.classifyCandidate({ code: 'SAVEGB', title: 'Party Ready Sale UK codes' }, 'RU');
  const family = Country.classifyCandidate({ code: 'AEUK20', title: 'AliExpress sale' }, 'RU');
  t.equal(metadata.countryMatch, 'MISMATCH'); t.deep(metadata.countries, ['GB']);
  t.equal(marker.countryMatch, 'MISMATCH'); t.deep(marker.countries, ['GB']);
  t.equal(family.countryMatch, 'MISMATCH'); t.deep(family.countries, ['GB']);
});

test('ambiguous DE substring and EUR alone remain UNKNOWN', (t) => {
  t.equal(Country.classifyCandidate({ code: 'DEAL20', title: 'DE special', currency: 'EUR' }, 'RU').countryMatch, 'UNKNOWN');
  t.equal(Country.classifyCandidate({ code: 'EURO20', currency: 'EUR' }, 'RU').countryMatch, 'UNKNOWN');
});

test('uppercase US title marker is country evidence but lowercase pronoun is not', (t) => {
  t.equal(Country.classifyCandidate({ code: 'USSALE', title: 'US codes' }, 'RU').countryMatch, 'MISMATCH');
  t.equal(Country.classifyCandidate({ code: 'GENERIC', title: 'Save with us today' }, 'RU').countryMatch, 'UNKNOWN');
});

test('GBP plus explicit UK context resolves GB without treating GBP alone as proof', (t) => {
  t.equal(Country.classifyCandidate({ code: 'GBP10', currency: 'GBP' }, 'RU').countryMatch, 'UNKNOWN');
  const result = Country.classifyCandidate({ code: 'GBP20', currency: 'GBP', title: 'UK-only coupon' }, 'GB');
  t.equal(result.countryMatch, 'MATCH'); t.deep(result.countries, ['GB']);
});

test('AUAU and DELD prefixes need corroborating metadata', (t) => {
  t.equal(Country.classifyCandidate({ code: 'AUAU20', title: 'Flash sale' }, 'RU').countryMatch, 'UNKNOWN');
  t.equal(Country.classifyCandidate({ code: 'DELD20', title: 'Flash sale' }, 'RU').countryMatch, 'UNKNOWN');
  t.equal(Country.classifyCandidate({ code: 'AUAU20', title: 'Australian offer' }, 'RU').countryMatch, 'MISMATCH');
  t.equal(Country.classifyCandidate({ code: 'DELD20', title: 'Germany offer' }, 'RU').countryMatch, 'MISMATCH');
});
