(() => {
  'use strict';
  if (window.__COUPON_HUNTER_SEARCH_LOADED__) return;
  window.__COUPON_HUNTER_SEARCH_LOADED__ = true;
  const Parser = globalThis.CouponHunterParser;

  const RUB_RE = /(\d{1,3}(?:[\s\u00A0\u202F]\d{3})+|\d{1,7})(?:[,.](\d{1,2}))?\s*(?:₽|RUB|руб\.?)/giu;
  const RUB_RANGE_RE = /(\d{1,3}(?:[\s\u00A0\u202F]\d{3})+|\d{1,7})(?:[,.](\d{1,2}))?\s*(?:[-–—]|до)\s*(\d{1,3}(?:[\s\u00A0\u202F]\d{3})+|\d{1,7})(?:[,.](\d{1,2}))?\s*(?:₽|RUB|руб\.?)/giu;
  const BLOCKLIST_PRICE_CONTEXT = /(купон|coupon|достав|shipping|эконом|cashback|кэшбэк|балл|points|скидк[аи]\s+\d|от\s+\d+\s*₽)/i;
  const normalize = (s = '') => String(s).replace(/[\s\u00A0\u202F]+/g, ' ').trim();
  const slug = (s = '') => normalize(s).toLowerCase().replace(/ё/g, 'е');

  function rubles(text) {
    return Parser.extractMoney(text).filter((row) => row.currency === 'RUB');
  }

  function itemIdFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname.match(/\/item\/(\d+)(?:\.html)?/i)?.[1] || u.searchParams.get('item_id') || null;
    } catch (_) { return null; }
  }

  function tokens(query) {
    return slug(query)
      .replace(/[^a-zа-я0-9]+/gi, ' ')
      .split(' ')
      .filter((x) => x.length >= 2 || /^\d+$/.test(x));
  }

  function relevance(title, query) {
    const ts = tokens(query);
    if (!ts.length) return 0;
    const hay = ` ${slug(title).replace(/[^a-zа-я0-9]+/gi, ' ')} `;
    let hit = 0;
    let weighted = 0;
    let total = 0;
    for (const t of ts) {
      const weight = /^\d+$/.test(t) ? 1.35 : (t.length >= 5 ? 1.2 : 1);
      total += weight;
      if (hay.includes(` ${t} `) || hay.includes(t)) { hit += 1; weighted += weight; }
    }
    const coverage = weighted / total;
    const exactBonus = hay.includes(` ${slug(query)} `) ? 0.12 : 0;
    return Math.max(0, Math.min(1, coverage + exactBonus));
  }

  function visible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 40 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function cardFor(anchor) {
    let node = anchor;
    let best = anchor.parentElement;
    let bestScore = -Infinity;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      if (!(node instanceof Element)) continue;
      const text = normalize(node.innerText || node.textContent || '');
      if (text.length >= 35 && text.length <= 1200 && Parser.extractPriceQuotes(text).length) {
        const ids = new Set(Array.from(node.querySelectorAll('a[href*="/item/"]')).map((a) => itemIdFromUrl(a.href || '')).filter(Boolean));
        const score = (ids.size === 1 ? 100 : ids.size <= 3 ? 35 : -50) - Math.abs(text.length - 280) / 20 - i;
        if (score > bestScore) { best = node; bestScore = score; }
      }
      if (text.length > 1200) break;
    }
    return best || anchor;
  }

  function titleFor(card, anchor) {
    const candidates = [
      anchor.getAttribute('title'), anchor.getAttribute('aria-label'),
      card.querySelector('h1,h2,h3,[class*="title" i]')?.textContent,
      card.querySelector('img[alt]')?.getAttribute('alt'), anchor.textContent
    ].map(normalize).filter(Boolean);
    return candidates.sort((a,b) => b.length - a.length).find((x) => x.length >= 8 && x.length <= 260) || candidates[0] || 'AliExpress товар';
  }

  function priceFor(card) {
    const priceSelectors = '[class*="price" i],[data-pl*="price" i],[data-widget-cid*="price" i]';
    const focused = [];
    for (const el of Array.from(card.querySelectorAll(priceSelectors)).slice(0, 80)) {
      if (!visible(el)) continue;
      const text = normalize(el.textContent || '');
      if (!text || text.length > 100 || BLOCKLIST_PRICE_CONTEXT.test(text)) continue;
      focused.push(...Parser.extractPriceQuotes(text, 'SEARCH_PRICE_ELEMENT'));
    }
    if (focused.length) {
      const exact = focused.filter((row) => !row.isRange);
      const winner = (exact.length ? exact : focused).sort((a, b) => (a.value ?? a.min) - (b.value ?? b.min))[0];
      return { value: winner.value ?? winner.min, currency: winner.currency, isRange: winner.isRange, min: winner.min, max: winner.max };
    }

    const lines = String(card.innerText || card.textContent || '').split(/\n+/).map(normalize).filter(Boolean);
    const generic = [];
    for (const line of lines) {
      if (line.length > 120 || BLOCKLIST_PRICE_CONTEXT.test(line)) continue;
      generic.push(...Parser.extractPriceQuotes(line, 'SEARCH_CARD_TEXT'));
    }
    if (!generic.length) return null;
    const exact = generic.filter((row) => !row.isRange);
    const winner = (exact.length ? exact : generic).sort((a, b) => (a.value ?? a.min) - (b.value ?? b.min))[0];
    return { value: winner.value ?? winner.min, currency: winner.currency, isRange: winner.isRange, min: winner.min, max: winner.max };
  }

  function ratingFor(text) {
    const src = normalize(text).replace(',', '.');
    const m = src.match(/(?:^|\s)([1-5](?:\.\d{1,2})?)\s*(?:★|звезд|рейтинг|rating)/i) ||
      src.match(/(?:^|\s)([1-4]\.\d{1,2}|5\.0{1,2})(?:\s|$)/);
    const n = m ? Number(m[1]) : NaN;
    return n >= 1 && n <= 5 ? n : null;
  }

  function ordersFor(text) {
    const src = normalize(text);
    const m = src.match(/(\d[\d\s.,]*\+?)\s*(?:заказ(?:а|ов)?|купили|продано|sold)/i);
    return m ? normalize(m[1]) : null;
  }

  function sellerFor(card) {
    const el = card.querySelector('[class*="store" i],[class*="shop" i],a[href*="/store/"],a[href*="storeId="]');
    const text = normalize(el?.textContent || el?.getAttribute?.('title') || '');
    return text && text.length <= 120 ? text : null;
  }

  function oldPriceFor(card, currentPrice) {
    if (!Number.isFinite(currentPrice?.value)) return null;
    const values = [];
    for (const el of Array.from(card.querySelectorAll('del,s,[class*="old-price" i],[class*="original-price" i]')).slice(0, 30)) {
      for (const hit of Parser.extractPriceQuotes(el.textContent || '')) {
        if (!hit.isRange && hit.currency === currentPrice.currency && hit.value > currentPrice.value) values.push(hit.value);
      }
    }
    return values.length ? Math.min(...values) : null;
  }

  function promotionsFor(card) {
    const lines = String(card.innerText || card.textContent || '').split(/\n+/).map(normalize).filter((line) =>
      line.length >= 4 && line.length <= 180 && /(промокод|promo\s*code|купон|coupon|скидк|discount)/i.test(line)
    );
    return [...new Set(lines)].slice(0, 3);
  }

  function collect(query = '') {
    const byId = new Map();
    const anchors = Array.from(document.querySelectorAll('a[href*="/item/"]')).slice(0, 1200);
    for (const a of anchors) {
      const href = a.href || a.getAttribute('href') || '';
      const itemId = itemIdFromUrl(href);
      if (!itemId || byId.has(itemId)) continue;
      const card = cardFor(a);
      if (!visible(card)) continue;
      const title = titleFor(card, a);
      const rel = query ? relevance(title, query) : 1;
      if (query && rel < 0.45) continue;
      const price = priceFor(card);
      if (!Number.isFinite(price?.value)) continue;
      const cardText = normalize(card.innerText || card.textContent || '');
      const oldPrice = oldPriceFor(card, price);
      byId.set(itemId, {
        itemId,
        title,
        url: new URL(href, location.href).href,
        listingPrice: price.value,
        listingPriceInfo: price,
        oldPrice,
        discountPercent: oldPrice ? Math.round((1 - price.value / oldPrice) * 100) : null,
        promotions: promotionsFor(card),
        currency: price.currency,
        rating: ratingFor(cardText),
        orders: ordersFor(cardText),
        seller: sellerFor(card),
        freeShipping: /бесплатн\w*\s+достав|free\s+shipping/i.test(cardText),
        relevance: Math.round(rel * 100),
        capturedAt: new Date().toISOString()
      });
    }
    const rows = [...byId.values()];
    rows.sort((a,b) => (b.relevance - a.relevance) || (a.listingPrice - b.listingPrice));
    const strong = rows.filter((x) => x.relevance >= 60);
    return (strong.length >= 3 ? strong : rows).sort((a,b) => a.listingPrice - b.listingPrice || b.relevance - a.relevance).slice(0, 30);
  }

  async function save(query, results) {
    const payload = { query, results, capturedAt: new Date().toISOString(), sourceUrl: location.href };
    await chrome.storage.local.set({ lastSearch: payload });
    return payload;
  }

  globalThis.CouponHunterSearch = { rubles, itemIdFromUrl, tokens, relevance };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CH_SEARCH_RESULTS') return false;
    const query = normalize(message.query || '');
    const results = collect(query);
    save(query, results).then((payload) => sendResponse(payload));
    return true;
  });

  // If the user opens/searches AliExpress manually, keep a lightweight snapshot for the popup.
  let timer = null;
  const maybeCapture = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.querySelectorAll('a[href*="/item/"]').length < 3) return;
      const params = new URLSearchParams(location.search);
      const q = normalize(params.get('SearchText') || params.get('SearchText2') || params.get('q') || '');
      if (!q) return;
      const results = collect(q);
      if (results.length) save(q, results);
    }, 1000);
  };
  const initialParams = new URLSearchParams(location.search);
  const isSearchPage = /(?:wholesale|search)/i.test(location.pathname) || !!normalize(initialParams.get('SearchText') || initialParams.get('SearchText2') || initialParams.get('q') || '');
  if (isSearchPage) {
    maybeCapture();
    new MutationObserver(maybeCapture).observe(document.documentElement, { childList:true, subtree:true });
  }
})();
