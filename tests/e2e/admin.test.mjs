// Админка: отображение, экранирование, импорт, загрузка мемов, предложения.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Game, closeBrowser } from './harness.mjs';

after(closeBrowser);

const ADMIN = { id: '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', email: 'admin@memology.test', password: 'secret123' };

async function login(p, email = ADMIN.email, password = ADMIN.password) {
  await p.page.waitForSelector('#auth-login:not([hidden])');
  await p.page.fill('#login-email', email);
  await p.page.fill('#login-password', password);
  await p.page.click('#login-btn');
}

// Админка с настроенной базой: вошёл админ
async function withAdmin(prepare, fn) {
  const g = new Game({ backend: { secured: true, admins: [ADMIN.id] } });
  prepare?.(g.backend);
  try {
    const p = await g.newPlayer('admin', { url: 'memology-admin.html' });
    await login(p);
    await p.page.waitForFunction(() => /Подключено/.test(document.getElementById('db-status').textContent));
    await fn(p, g.backend, g);
    assert.deepEqual(g.errors().filter(e => !/40[13]/.test(e)), [], 'ошибки в консоли браузера');
  } finally {
    await g.close();
  }
}

test('админ входит и видит весь контент', () => withAdmin(null, async (p, b) => {
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

test('без входа админка ничего не показывает; неверный пароль', async () => {
  const g = new Game({ backend: { secured: true, admins: [ADMIN.id] } });
  try {
    const p = await g.newPlayer('guest', { url: 'memology-admin.html' });
    await p.page.waitForSelector('#auth-login:not([hidden])');
    assert.equal(await p.page.isVisible('#admin-content'), false);
    assert.equal(await p.page.locator('#meme-grid .meme-item').count(), 0);
    await login(p, ADMIN.email, 'wrong');
    await p.page.waitForFunction(() => /Неверная почта или пароль/.test(document.getElementById('login-error').textContent));
    assert.equal(await p.page.isVisible('#admin-content'), false);
  } finally { await g.close(); }
});

test('первый вход: SQL с моим id, после его выполнения — доступ', async () => {
  const g = new Game({ backend: { secured: false } });
  try {
    const p = await g.newPlayer('admin', { url: 'memology-admin.html' });
    await login(p);
    await p.page.waitForSelector('#auth-setup:not([hidden])');
    const sql = await p.page.textContent('#setup-sql');
    assert.match(sql, new RegExp(`where id::text = '${ADMIN.id}'`));
    assert.match(sql, /create policy "admin manages memes"/);
    assert.match(sql, /function public\.mg_play/, 'в SQL есть серверная логика игры');
    assert.equal(await p.page.isVisible('#admin-content'), false);
    // «Выполнили SQL» в Supabase
    g.backend.secured = true;
    g.backend.admins.add(ADMIN.id);
    await p.page.click('[data-action="checkAdmin"]');
    await p.page.waitForSelector('#admin-content:not([hidden])');
    await p.page.waitForFunction(() => /Подключено/.test(document.getElementById('db-status').textContent));
    assert.match(await p.page.textContent('#account-email'), /admin@memology\.test/);
  } finally { await g.close(); }
});

test('админ видит просьбу обновить SQL, если сервер старой версии', async () => {
  const g = new Game({ backend: { secured: true, admins: [ADMIN.id], sqlVersion: 1 } });
  try {
    const p = await g.newPlayer('admin', { url: 'memology-admin.html' });
    await login(p);
    await p.page.waitForSelector('#auth-setup:not([hidden])');
    assert.match(await p.page.textContent('#setup-lead'), /обнов/i);
    assert.match(await p.page.textContent('#setup-sql'), new RegExp(ADMIN.id));
    g.backend.sqlVersion = 2;
    await p.page.click('[data-action="checkAdmin"]');
    await p.page.waitForSelector('#admin-content:not([hidden])');
  } finally { await g.close(); }
});

test('шестерёнка в игре — только на устройстве админа', async () => {
  const g = new Game({ backend: { secured: true, admins: [ADMIN.id] } });
  try {
    const player = await g.newPlayer('player');
    assert.equal(await player.page.isVisible('#admin-gear'), false, 'у игрока шестерёнки нет');
    assert.equal(await player.page.locator('#screen-admin-pin').count(), 0, 'экрана PIN больше нет');

    const admin = await g.newPlayer('admin', { url: 'memology-admin.html' });
    await login(admin);
    await admin.page.waitForSelector('#admin-content:not([hidden])');
    await admin.page.goto('https://memology.test/memology.html');
    await admin.page.waitForSelector('#admin-gear', { state: 'visible' });
    await admin.page.click('#admin-gear');
    await admin.page.waitForURL(/memology-admin\.html$/);
    await admin.page.waitForSelector('#admin-content:not([hidden])');
    await admin.page.click('#account [data-action="signOut"]');
    await admin.page.waitForSelector('#auth-login:not([hidden])');
    await admin.page.goto('https://memology.test/memology.html');
    assert.equal(await admin.page.isVisible('#admin-gear'), false, 'после выхода шестерёнка пропадает');
  } finally { await g.close(); }
});

test('закрытая база: игроку не виден каталог, писать в контент нельзя', async () => {
  const g = new Game({ backend: { secured: true, admins: [ADMIN.id] } });
  try {
    const host = await g.setup(3, { rounds: 5 });
    const memeIds = await host.page.evaluate(async () => {
      const r = await fetch('https://dcxamyfvfoeoefcrdcqq.supabase.co/rest/v1/memes?select=id', { headers: { apikey: 'sb_publishable_x' } });
      return (await r.json()).map(m => m.id);
    });
    assert.deepEqual(memeIds, [], 'каталог мемов игрокам не виден');
    const del = await host.page.evaluate(async () => {
      const r = await fetch('https://dcxamyfvfoeoefcrdcqq.supabase.co/rest/v1/memes?id=eq.2', { method: 'DELETE', headers: { apikey: 'sb_publishable_x', Prefer: 'return=representation' } });
      return (await r.json()).length;
    });
    assert.equal(del, 0, 'игрок не может удалить мем');
    assert.ok(g.backend.memes.some(m => m.id === 2));
    await g.start(host);
    await g.playRound();
    const p = g.byIdx(1);
    await p.menu('Предложить');
    await p.page.locator('#modal-suggest .suggest-opt', { hasText: 'ситуацию' }).click();
    await p.page.fill('#suggest-text', 'Предложение из закрытой базы');
    await p.page.locator('#modal-suggest button', { hasText: 'Отправить' }).click();
    await g.waitFor(() => g.backend.suggestions.length === 1, 'предложение дошло');
    assert.deepEqual(g.errors(), []);
  } finally { await g.close(); }
});
