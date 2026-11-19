// Админка: отображение, экранирование, импорт, загрузка мемов, предложения.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Game, closeBrowser } from './harness.mjs';

after(closeBrowser);

async function withAdmin(prepare, fn) {
  const g = new Game();
  prepare?.(g.backend);
  try {
    const p = await g.newPlayer('admin', { url: 'memology-admin.html' });
    await p.page.waitForFunction(() => /Подключено/.test(document.getElementById('db-status').textContent));
    await fn(p, g.backend);
    assert.deepEqual(g.errors(), [], 'ошибки в консоли браузера');
  } finally {
    await g.close();
  }
}

test('админка сама подключается к базе игры и показывает контент', () => withAdmin(null, async (p, b) => {
  assert.equal(await p.page.locator('#meme-grid .meme-item').count(), b.memes.length);
  assert.equal(await p.page.locator('#sit-list .sit-item').count(), b.situations.length);
  const body = await p.page.textContent('body');
  assert.ok(!body.includes('```'), 'на странице не должно быть мусора из ```');
  // Мемы и ситуации — в одном ряду, предложения — под ними во всю ширину
  const [memes, sits, sugs] = await p.page.$$eval('.container > .panel', els => els.map(e => e.getBoundingClientRect().toJSON()));
  await p.page.setViewportSize({ width: 1100, height: 900 });
  const [m2, s2, g2] = await p.page.$$eval('.container > .panel', els => els.map(e => e.getBoundingClientRect().toJSON()));
  assert.equal(Math.round(m2.top), Math.round(s2.top));
  assert.ok(g2.top > m2.bottom && g2.width > m2.width * 1.8);
  void memes; void sits; void sugs;
}));

test('названия и тексты выводятся как текст', () => withAdmin(b => {
  b.memes[0].title = 'Кот "в шоке" <b>жирный</b>';
  b.situations[0].text = 'Когда <img src=x onerror="window.__xss=1"> пришёл';
}, async p => {
  assert.equal(await p.page.evaluate(() => window.__xss), undefined);
  assert.equal(await p.page.locator('#meme-grid b').count(), 0);
  const title = await p.page.getAttribute('#meme-1 .meme-item-title', 'title');
  assert.equal(title, 'Кот "в шоке" <b>жирный</b>');
  assert.match(await p.page.textContent('#sit-list'), /<img src=x/);
}));

test('скрыть и удалить мем, добавить и скрыть ситуацию', () => withAdmin(null, async (p, b) => {
  await p.page.click('#meme-1 [data-action="toggleMeme"]');
  await p.page.waitForFunction(() => document.querySelector('#meme-1')?.classList.contains('inactive'));
  assert.equal(b.memes.find(m => m.id === 1).active, false);
  await p.page.click('#meme-2 [data-action="deleteMeme"]');
  await p.page.waitForFunction(() => !document.querySelector('#meme-2'));
  assert.ok(!b.memes.some(m => m.id === 2));

  await p.page.fill('#sit-input', 'Когда добавил ситуацию с клавиатуры');
  await p.page.press('#sit-input', 'Enter');
  await p.page.waitForFunction(() => /с клавиатуры/.test(document.getElementById('sit-list').textContent));
  assert.ok(b.situations.some(s => s.text === 'Когда добавил ситуацию с клавиатуры'));
}));

test('импорт CSV: запятая, кавычки, повторы не отмечены', () => withAdmin(null, async (p, b) => {
  const csv = '﻿Ситуация,Комментарий\r\n"Когда, наконец, пятница",x\r\n"Когда кот сказал ""мяу"" в зум",y\r\nСитуация номер 1,дубль\r\n';
  await p.page.setInputFiles('#excel-input', { name: 'sits.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await p.page.waitForSelector('#excel-preview:not([hidden])');
  const items = await p.page.$$eval('#excel-preview-list .preview-sit-item', els =>
    els.map(e => ({ text: e.querySelector('span').textContent, on: e.querySelector('input').checked })));
  assert.deepEqual(items, [
    { text: 'Когда, наконец, пятница', on: true },
    { text: 'Когда кот сказал "мяу" в зум', on: true },
    { text: 'Ситуация номер 1', on: false },
  ]);
  const before = b.situations.length;
  await p.page.click('[data-action="importLines"][data-source="excel"]');
  await p.page.waitForSelector('#excel-preview[hidden]', { state: 'attached' });
  assert.equal(b.situations.length, before + 2);
}));

test('загрузка мема берёт введённое название', () => withAdmin(null, async (p, b) => {
  await p.page.fill('#meme-title-input', 'Мой лучший мем');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  await p.page.setInputFiles('#meme-file-input', { name: 'some_file-name.png', mimeType: 'image/png', buffer: png });
  await p.page.waitForFunction(() => /Мой лучший мем/.test(document.getElementById('meme-grid').textContent));
  const m = b.memes.at(-1);
  assert.equal(m.title, 'Мой лучший мем');
  assert.match(m.image_url, /\/storage\/v1\/object\/public\/memes\/\d+_some_file-name\.png$/);
  assert.equal(await p.page.inputValue('#meme-title-input'), '');
}));

test('предложение игрока превращается в ситуацию', () => withAdmin(b => {
  b.suggestions.push({ id: 1, type: 'situation', text: 'Когда предложил ситуацию', player: 'Диля', room: 'ABCD', handled: false, created_at: new Date().toISOString() });
}, async (p, b) => {
  await p.page.waitForSelector('#sug-list .sug-item');
  await p.page.click('[data-action="sugToSituation"]');
  await p.page.waitForFunction(() => /Все предложения обработаны/.test(document.getElementById('sug-list').textContent));
  assert.ok(b.situations.some(s => s.text === 'Когда предложил ситуацию'));
  assert.equal(b.suggestions[0].handled, true);
}));
