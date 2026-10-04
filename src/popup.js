'use strict';
const $ = (id) => document.getElementById(id);
const Safety = globalThis.CouponHunterSafety;
const symbol = (currency) => ({ RUB: '₽', USD: '$', EUR: '€' }[currency] || currency || '');
const money = (value, currency = 'RUB') => Number.isFinite(value) ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${symbol(currency)}`.trim() : '—';
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeAliUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)aliexpress\.(ru|com)$/i.test(url.hostname) ? url.href : null; } catch (_) { return null; } };
let current = null; let history = []; let searchRows = []; let watchRows = [];

async function activeTab() { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); return tab; }

async function getProductFromPage() {
  const tab = await activeTab();
  if (!tab?.id || !/^https:\/\/(?:[^/]+\.)?aliexpress\.(?:ru|com)\/item\//i.test(tab.url || '')) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'CH_GET_PRODUCT' }); } catch (_) { return null; }
}

async function loadHistory(product) {
  if (!product?.key) return [];
  const key = `history:${product.key}`; const data = await chrome.storage.local.get(key); return Array.isArray(data[key]) ? data[key] : [];
}

function renderChart(rows) {
  const svg = $('chart'); svg.replaceChildren(); const clean = rows.filter((row) => Number.isFinite(row.price)).slice(-100); if (clean.length < 2) return;
  const values = clean.map((row) => row.price); let min = Math.min(...values); let max = Math.max(...values); if (min === max) { min *= .98; max *= 1.02; }
  const points = clean.map((row, index) => [8 + index / (clean.length - 1) * 304, 10 + (1 - (row.price - min) / (max - min)) * 66]);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline'); line.setAttribute('points', points.map((point) => point.join(',')).join(' ')); svg.append(line);
  for (const point of [points[0], points.at(-1)]) { const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', point[0]); circle.setAttribute('cy', point[1]); circle.setAttribute('r', '2.7'); svg.append(circle); }
}

function renderProduct(product, rows) {
  current = product; history = rows; const price = product?.detectedPrice;
  $('dot').classList.toggle('ok', Number.isFinite(price?.value)); $('title').textContent = product?.title || 'Открой карточку товара AliExpress';
  $('price').textContent = Number.isFinite(price?.value) ? money(price.value, price.currency) : price?.isRange ? `${money(price.min, price.currency)}–${money(price.max, price.currency)}` : '—';
  $('old').textContent = product?.oldPrice ? money(product.oldPrice, product.currency) : '';
  const promotion = $('promotion');
  if (product?.promotions?.length) { promotion.textContent = `Найдено акций: ${product.promotions.length}. Их наличие не означает, что код проверен для текущего заказа.`; promotion.hidden = false; } else { promotion.textContent = ''; promotion.hidden = true; }
  $('sku').textContent = product?.skuId || product?.itemId || '—'; $('variant').textContent = product?.selectedVariant || '—'; $('seller').textContent = product?.seller || '—'; $('count').textContent = rows.length;
  const prices = rows.map((row) => row.price).filter(Number.isFinite); $('min').textContent = prices.length ? money(Math.min(...prices), product?.currency) : '—'; $('max').textContent = prices.length ? money(Math.max(...prices), product?.currency) : '—';
  $('chartCaption').textContent = rows.length >= 2 ? `Последние ${Math.min(rows.length, 100)} измерений выбранного SKU.` : 'История появится после изменения цены или повторных замеров.';
  $('status').textContent = Number.isFinite(price?.value) ? `Цена SKU распознана с уверенностью ${price.confidence}%.` : price?.isRange ? 'Найден только диапазон: цена выбранного SKU не подтверждена.' : 'На странице не найдена подтверждённая цена SKU.';
  $('watchCurrent').disabled = !product?.itemId; $('export').disabled = !product; $('scanPromos').disabled = !product?.itemId; renderChart(rows);
  globalThis.CouponHunterPopupPromos.refreshCandidates(product);
}

function renderResults(rows, query = '') {
  searchRows = rows || []; const root = $('results'); if (!searchRows.length) { root.innerHTML = ''; return; }
  root.innerHTML = searchRows.slice(0, 8).map((row, index) => `<article class="result">
    <div class="resultTop"><strong>${money(row.listingPrice, row.currency)} ${row.oldPrice ? `<s>${money(row.oldPrice, row.currency)}</s>` : ''}</strong><span>${row.discountPercent ? `−${row.discountPercent}% · ` : ''}${row.relevance ?? 0}% совп.</span></div>
    <div class="resultTitle">${escapeHtml(row.title)}</div><div class="resultMeta">${row.rating ? `★ ${row.rating}` : ''}${row.orders ? ` · ${escapeHtml(row.orders)} заказов` : ''}${row.freeShipping ? ' · бесплатная доставка' : ''}</div>
    ${row.promotions?.length ? `<div class="resultPromo">${escapeHtml(row.promotions[0])}</div>` : ''}<div class="resultActions"><button data-action="open" data-i="${index}">Открыть</button><button class="ghost" data-action="watch" data-i="${index}">Следить</button></div></article>`).join('');
  $('searchStatus').textContent = `Найдено ${searchRows.length} предложений по «${query}». Витринная цена может относиться к другому SKU.`;
}

function renderWatchlist(rows) {
  watchRows = Array.isArray(rows) ? rows : []; $('watchCount').textContent = watchRows.length ? `· ${watchRows.length}` : ''; const root = $('watchlist');
  if (!watchRows.length) { root.innerHTML = '<div class="caption">Добавьте товары кнопкой «Следить».</div>'; return; }
  root.innerHTML = watchRows.map((row, index) => {
    const price = Number.isFinite(row.lastKnownPrice) ? row.lastKnownPrice : row.listingPrice; const baseline = Number.isFinite(row.listingPrice) ? row.listingPrice : null; const drop = baseline && price < baseline ? Math.round((1 - price / baseline) * 100) : null;
    const checked = row.lastCheckedAt ? new Date(row.lastCheckedAt).toLocaleDateString('ru-RU') : 'ещё не проверено';
    return `<article class="watchItem"><div class="resultTop"><strong>${money(price, row.currency)}</strong><span>${drop ? `цена ниже на ${drop}%` : escapeHtml(checked)}</span></div><div class="resultTitle">${escapeHtml(row.title || 'AliExpress товар')}</div><div class="resultActions"><button data-watch-action="open" data-i="${index}">Открыть</button><button class="danger" data-watch-action="remove" data-i="${index}">Удалить</button></div></article>`;
  }).join('');
}

function searchUrl(query) { const slug = query.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'search'; return `https://aliexpress.ru/w/wholesale-${encodeURIComponent(slug)}.html?SearchText=${encodeURIComponent(query)}`; }

async function askSearchTab(tabId, query) {
  for (let attempt = 0; attempt < 9; attempt++) { await new Promise((resolve) => setTimeout(resolve, attempt ? 1200 : 1800)); try { const payload = await chrome.tabs.sendMessage(tabId, { type: 'CH_SEARCH_RESULTS', query }); if (payload?.results?.length) return payload; } catch (_) {} }
  return null;
}

async function runSearch(query) {
  $('searchBtn').disabled = true; $('searchStatus').textContent = 'Открываю поиск AliExpress…'; $('results').innerHTML = '';
  try {
    const tab = await chrome.tabs.create({ url: searchUrl(query), active: false }); const payload = await askSearchTab(tab.id, query);
    if (payload?.results?.length) { renderResults(payload.results, query); await chrome.tabs.remove(tab.id).catch(() => {}); }
    else { $('searchStatus').textContent = 'Фоновая выдача не загрузилась. Открою её для ручной проверки.'; await chrome.tabs.update(tab.id, { active: true }); }
  } catch (error) { $('searchStatus').textContent = `Ошибка поиска: ${error?.message || error}`; } finally { $('searchBtn').disabled = false; }
}

$('searchForm').addEventListener('submit', async (event) => { event.preventDefault(); const query = $('query').value.trim(); if (query.length >= 2) await runSearch(query); });
$('results').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]'); if (!button) return; const row = searchRows[Number(button.dataset.i)]; if (!row) return;
  if (button.dataset.action === 'open') { const url = safeAliUrl(row.url); if (url) await chrome.tabs.create({ url, active: true }); return; }
  const { watchlist = [] } = await chrome.storage.local.get('watchlist'); const next = watchlist.filter((item) => item.itemId !== row.itemId); next.unshift({ ...row, addedAt: new Date().toISOString() }); await chrome.storage.local.set({ watchlist: next.slice(0, 100) }); renderWatchlist(next.slice(0, 100));
});
$('watchlist').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-watch-action]'); if (!button) return; const row = watchRows[Number(button.dataset.i)]; if (!row) return;
  if (button.dataset.watchAction === 'open') { const url = safeAliUrl(row.url); if (url) await chrome.tabs.create({ url, active: true }); return; }
  const next = watchRows.filter((_, index) => index !== Number(button.dataset.i)); await chrome.storage.local.set({ watchlist: next }); renderWatchlist(next);
});
$('rescan').addEventListener('click', async () => { const tab = await activeTab(); if (!tab?.id) return; try { const product = await chrome.tabs.sendMessage(tab.id, { type: 'CH_RESCAN' }); renderProduct(product, await loadHistory(product)); } catch (_) { $('status').textContent = 'Обновите вкладку AliExpress после обновления расширения.'; } });
$('scanPromos').addEventListener('click', async () => { const tab = await activeTab(); if (!tab?.id) return; try { await chrome.tabs.sendMessage(tab.id, { type: 'CH_OPEN_PROMOTIONS' }); setTimeout(async () => { const product = await getProductFromPage(); if (product) renderProduct(product, await loadHistory(product)); }, 900); } catch (_) {} });
$('watchCurrent').addEventListener('click', async () => {
  if (!current?.itemId) return; const { watchlist = [] } = await chrome.storage.local.get('watchlist'); const next = watchlist.filter((row) => !(row.itemId === current.itemId && (row.skuId || null) === (current.skuId || null)));
  next.unshift({ itemId: current.itemId, skuId: current.skuId, title: current.title, url: current.url, listingPrice: current.detectedPrice?.value, lastKnownPrice: current.detectedPrice?.value, currency: current.currency, lastCheckedAt: current.parsedAt, selectedVariant: current.selectedVariant, seller: current.seller, promotions: current.promotions, addedAt: new Date().toISOString() }); await chrome.storage.local.set({ watchlist: next.slice(0, 100) }); renderWatchlist(next.slice(0, 100));
});
$('export').addEventListener('click', () => { if (!current) return; const blob = new Blob([JSON.stringify({ product: current, history }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `coupon-hunter-${current.itemId || 'product'}-${Date.now()}.json`; Safety.safeClick(link, { purpose: 'Скачивание экспорта товара', intent: 'DOWNLOAD' }); setTimeout(() => URL.revokeObjectURL(url), 1000); });

async function refresh() {
  const product = await getProductFromPage(); renderProduct(product, product ? await loadHistory(product) : []);
  const { lastSearch = null, watchlist = [] } = await chrome.storage.local.get(['lastSearch', 'watchlist']); if (lastSearch?.query) { $('query').value = lastSearch.query; renderResults(lastSearch.results || [], lastSearch.query); } renderWatchlist(watchlist);
  if (!product) await globalThis.CouponHunterPopupPromos.refreshCandidates(null);
}

refresh();
