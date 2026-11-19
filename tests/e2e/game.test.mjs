// Сквозные сценарии игры: несколько игроков в отдельных браузерах
// против модели бэкенда. Запуск: npm test (или node --test tests/e2e).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Game, closeBrowser } from './harness.mjs';

after(closeBrowser);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withGame(opts, fn) {
  const g = new Game(opts);
  try {
    await fn(g);
    assert.deepEqual(g.errors(), [], 'ошибки в консоли браузера');
  } finally {
    await g.close();
  }
}

// Сыграть до конца, собирая сыгранные карты и проверяя колоду
async function playToEnd(g, { winner, maxRounds = 40, between } = {}) {
  const played = new Set();
  for (let i = 0; i < maxRounds; i++) {
    const res = await g.playRound({ winner });
    Object.values(g.room().submissions).forEach(c => played.add(c.id));
    g.checkCards(played);
    if (res.phase === 'end') return;
    if (between) await between(g);
    await g.nextRound();
    if (g.room().phase === 'end') return;
  }
  throw new Error('игра не закончилась');
}

const scores = g => Object.fromEntries(Object.values(g.room().players).filter(Boolean).map(p => [p.idx, p.score || 0]));
const lowestScorer = room => {
  const ps = Object.values(room.players).filter(p => p && !p.left && p.idx !== room.readerIdx);
  return ps.sort((a, b) => (a.score || 0) - (b.score || 0) || a.idx - b.idx)[0].idx;
};

test('полная партия на 3 игрока: 5 раундов, финал у всех', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await g.start(host);
  await playToEnd(g);
  for (const p of g.players) await p.waitScreen('screen-end');
  const rounds = g.room().currentRound;
  assert.ok(rounds >= 5, 'сыграно не меньше 5 раундов (больше — только при ничьей)');
  const s = scores(g);
  assert.equal(Object.values(s).reduce((a, b) => a + b, 0), rounds, 'одно очко за раунд');
  const top = Math.max(...Object.values(s));
  const leaders = Object.values(g.room().players).filter(p => p.score === top);
  const text = await host.page.textContent('#winner-text');
  if (leaders.length === 1) assert.match(text, new RegExp(leaders[0].name));
}));

test('читающий меняется по кругу и может выбрать ситуацию Б (4 игрока)', () => withGame({}, async g => {
  const host = await g.setup(4, { rounds: 5 });
  await g.start(host);
  const readers = [];
  for (let i = 0; i < 4; i++) {
    readers.push(g.room().readerIdx);
    await g.playRound({ choose: i % 2 });
    await g.nextRound();
  }
  readers.push(g.room().readerIdx);
  assert.deepEqual(readers, [0, 1, 2, 3, 0]);
}));

test('ничья после последнего раунда — дополнительный раунд до перевеса', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await g.start(host);
  const plan = [1, 2, 1, 2, 0, 1];   // после 5 раундов: 1 / 2 / 2 → ничья
  let r = 0;
  for (;;) {
    const res = await g.playRound({ winner: () => plan[r] });
    r++;
    if (res.phase === 'end') break;
    if (r === 5) {
      assert.equal(g.room().tiebreak, true);
      await host.waitScreen('screen-result');
      const note = await host.page.textContent('#tiebreak-note');
      assert.match(note, /Ничья/);
    }
    await g.nextRound();
  }
  assert.equal(r, 6);
  await host.waitScreen('screen-end');
  const text = await host.page.textContent('#winner-text');
  assert.match(text, /Диля/);
  assert.match(text, /дополнительном/);
}));

test('бесконечная игра заканчивается, когда кончаются мемы; ничья показана честно', () =>
  withGame({ backend: { contentSize: { memes: 17, situations: 30 } } }, async g => {
    const host = await g.setup(3, { rounds: Infinity });
    await g.start(host);
    await playToEnd(g, { winner: lowestScorer });
    for (const p of g.players) await p.waitScreen('screen-end');
    const s = Object.values(scores(g));
    const top = Math.max(...s);
    const text = await host.page.textContent('#winner-text');
    if (s.filter(v => v === top).length > 1) assert.match(text, /[Нн]ичья/, `при равенстве очков нельзя объявлять одного победителя: «${text}»`);
  }));

test('обновление страницы на любой фазе возвращает в игру', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await g.start(host);

  // Читающий обновляет страницу до выбора ситуации
  const reader = g.byIdx(g.room().readerIdx);
  await reader.reload();
  await reader.waitScreen('screen-reader');
  await reader.page.click('#sh-top');
  await g.waitFor(() => g.room().phase === 'picking', 'picking');

  // Игрок отправил мем и обновил страницу
  const [a, b] = g.active().filter(p => p !== reader);
  await a.waitScreen('screen-pick');
  await a.submitCard(0);
  await a.reload();
  await a.waitScreen('screen-waiting-others');
  await b.reload();
  await b.waitScreen('screen-pick');
  await b.submitCard(1);

  // Судья обновляет страницу во время голосования
  await g.waitFor(() => g.room().phase === 'judging', 'judging');
  await reader.reload();
  await reader.waitScreen('screen-judge');
  await reader.judge(0);
  await g.waitFor(() => g.room().phase === 'result', 'result');

  // Хост обновляет страницу на итогах и продолжает
  await host.reload();
  await host.waitScreen('screen-result');
  await g.nextRound();
  await playToEnd(g);
  for (const p of g.players) await p.waitScreen('screen-end');
}));

test('проверки при входе в комнату', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5, maxPlayers: 3 });
  const p = await g.newPlayer('Гость');

  await p.fillJoin('', g.code);
  await p.page.click('#screen-join .btn-cyan');
  assert.match(await p.toast(), /имя/);

  await p.page.fill('#join-name', 'Гость');
  await p.page.fill('#join-code', 'AB');
  await p.page.click('#screen-join .btn-cyan');
  assert.match(await p.toast(), /4/);

  await p.page.fill('#join-code', 'ZZZZ');
  await p.page.click('#screen-join .btn-cyan');
  await p.page.waitForFunction(() => /не найдена/.test(document.getElementById('toast').textContent));

  await p.page.fill('#join-code', g.code);
  await p.page.click('#screen-join .btn-cyan');
  await p.page.waitForFunction(() => /заполнена/.test(document.getElementById('toast').textContent));

  await g.start(host);
  g.room().maxPlayers = 10;
  await p.page.click('#screen-join .btn-cyan');
  await p.page.waitForFunction(() => /уже идёт/.test(document.getElementById('toast').textContent));
  assert.equal(await p.screen(), 'screen-join');
  assert.equal(Object.keys(g.room().players).length, 3);
}));

test('одновременный вход нескольких игроков: у каждого своё место', () =>
  withGame({ backend: { pollDelay: [30, 80], rpcDelay: [40, 120] } }, async g => {
    const host = await g.newPlayer('Агшин');
    g.code = await host.createRoom('Агшин', 5, 5);
    const names = ['Диля', 'Марат', 'Кянан', 'Лейла'];
    const ps = [];
    for (const n of names) { const p = await g.newPlayer(n); await p.fillJoin(n, g.code); ps.push(p); }
    await Promise.all(ps.map(p => p.page.click('#screen-join .btn-cyan')));
    await Promise.all(ps.map(p => p.waitScreen('screen-lobby')));
    await sleep(3500);  // дать клиентам заметить и исправить конфликт мест
    for (const p of ps) await p.syncIdx();
    const room = g.room();
    const seated = Object.values(room.players).filter(Boolean);
    assert.equal(seated.length, 5, 'в комнате должны оказаться все пятеро');
    for (const p of ps) assert.equal(room.players[p.idx]?.name, p.label, `${p.label} сидит на своём месте`);
    assert.equal(new Set(ps.map(p => p.idx)).size, 4);
  }));

test('вход в момент старта игры не ломает партию', () =>
  withGame({ backend: { contentDelay: 800 } }, async g => {
    const host = await g.setup(3, { rounds: 5, maxPlayers: 5 });
    const late = await g.newPlayer('Опоздавший');
    await late.fillJoin('Опоздавший', g.code);
    await late.page.click('#screen-join .btn-cyan');
    await sleep(200);                    // запрос комнаты прошёл, контент ещё грузится
    await g.start(host);
    await sleep(1500);
    assert.notEqual(await late.screen(), 'screen-pick', 'опоздавший не должен попасть в раунд без карт');
    await playToEnd(g);
    for (const p of g.players.filter(p => p !== late)) await p.waitScreen('screen-end');
  }));

test('выход из лобби освобождает место', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5, maxPlayers: 3 });
  const guest = g.byIdx(2);
  await guest.menu('Выйти');
  await guest.waitScreen('screen-welcome');
  await g.waitFor(() => Object.values(g.room().players).filter(p => p && !p.left).length === 2, 'место освободилось');
  await host.page.waitForFunction(() => document.querySelectorAll('#lobby-slots .player-slot:not(.empty):not([style*="dashed"])').length === 2);
  const p = await g.newPlayer('Новенький');
  await p.joinRoom('Новенький', g.code);
  await g.start(host);
}));

test('игрок выходит посреди раунда — игра продолжается без него', () => withGame({}, async g => {
  const host = await g.setup(4, { rounds: 5 });
  await g.start(host);
  await g.playRound();
  await g.nextRound();
  // Раунд 2: читает игрок 1. Игрок 3 отправляет мем и уходит, игрок 2 думает.
  const reader = g.byIdx(1);
  await reader.waitScreen('screen-reader');
  await reader.page.click('#sh-top');
  const leaver = g.byIdx(3);
  await leaver.waitScreen('screen-pick');
  await leaver.menu('Выйти');
  leaver.gone = true;
  await leaver.waitScreen('screen-welcome');
  for (const p of [host, g.byIdx(2)]) { await p.waitScreen('screen-pick'); await p.submitCard(0); }
  await g.waitFor(() => g.room().phase === 'judging', 'голосование без ушедшего', 8000);
  assert.ok(g.room().tableCards.every(c => c.playerIdx !== 3));
  await reader.judge(0);
  await g.waitFor(() => g.room().phase === 'result', 'result');
  await g.nextRound();
  // Раунд 3: читает игрок 2, затем 0 — ушедший пропускается
  const seen = [g.room().readerIdx];
  await g.playRound(); await g.nextRound();
  seen.push(g.room().readerIdx);
  assert.deepEqual(seen, [2, 0]);
}));

test('хост выходит — управление переходит другому игроку', () => withGame({}, async g => {
  const host = await g.setup(4, { rounds: 5 });
  await g.start(host);
  await g.playRound();
  await host.menu('Выйти');
  host.gone = true;
  const newHost = await g.waitFor(() => {
    const r = g.room();
    return r.hostIdx != null && r.hostIdx !== 0 && g.byIdx(r.hostIdx);
  }, 'новый хост', 5000);
  await newHost.waitScreen('screen-result');
  await newHost.page.waitForSelector('#next-round-btn', { state: 'visible' });
  await g.nextRound();
  await g.playRound();
}));

test('имя игрока выводится как текст, а не как HTML', () => withGame({}, async g => {
  const host = await g.newPlayer('Агшин');
  g.code = await host.createRoom('Агшин', 3, 5);
  const evil = await g.newPlayer('evil');
  await evil.fillJoin('x', g.code);
  await evil.page.evaluate(() => { document.getElementById('join-name').value = '<img src=x onerror="window.__xss=1"><i>Аня'; });
  await evil.page.click('#screen-join .btn-cyan');
  await evil.waitScreen('screen-lobby');
  await host.page.waitForFunction(() => document.querySelectorAll('#lobby-slots .slot-name').length >= 2);
  await sleep(300);
  assert.equal(await host.page.evaluate(() => window.__xss), undefined, 'скрипт из имени выполнился у хоста');
  assert.match(await host.page.textContent('#lobby-slots'), /<i>Аня/);
}));

test('устаревший ответ сервера не откатывает игру и не подменяет победителя', () => withGame({}, async g => {
  const host = await g.setup(4, { rounds: 5 });
  await g.start(host);
  const reader = g.byIdx(g.room().readerIdx);   // хост (idx 0) — читающий
  await reader.waitScreen('screen-reader');
  await reader.page.click('#sh-top');
  await g.waitFor(() => g.room().phase === 'picking', 'picking');
  await reader.waitScreen('screen-reader-wait');
  g.backend.staleFor.set(reader.page, 1);         // ближайший опрос вернёт фазу reader
  await sleep(3500);
  assert.equal(await reader.screen(), 'screen-reader-wait', 'старый ответ вернул читающего к выбору ситуации');

  const others = g.active().filter(p => p !== reader);
  for (const p of others) { await p.waitScreen('screen-pick'); await p.submitCard(0); }
  await g.waitFor(() => g.room().phase === 'judging', 'judging');
  const cards = JSON.stringify(g.room().tableCards);
  g.backend.staleFor.set(host.page, 1);           // хосту приходит «все сдали, но ещё picking»
  await sleep(3500);
  assert.equal(JSON.stringify(g.room().tableCards), cards, 'карты на столе перемешались повторно во время голосования');
  await reader.judge(1);
  await g.waitFor(() => g.room().phase === 'result', 'result');
}));

test('случайные задержки сети: партия на 5 игроков без сбоев', () =>
  withGame({ backend: { pollDelay: [50, 900], rtDelay: [20, 700], rpcDelay: [20, 200], replyDelay: [20, 300] } }, async g => {
    const host = await g.setup(5, { rounds: 5 });
    await g.start(host);
    await playToEnd(g);
    for (const p of g.players) await p.waitScreen('screen-end', 12000);
  }));

test('двойные нажатия не ломают ход игры', () => withGame({ backend: { rpcDelay: [150, 250] } }, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await host.page.dblclick('#lobby-start-btn');
  await g.waitFor(() => g.room().phase === 'reader', 'reader');
  await sleep(600);
  const reader = g.byIdx(g.room().readerIdx);
  await reader.waitScreen('screen-reader');
  const shown = await reader.page.textContent('#sh-top .sit-text');
  assert.equal(shown, g.room().readerSits[0], 'читающий видит не те ситуации, что в комнате');

  await g.playRound();
  const round = g.room().currentRound;
  for (const p of g.active()) await p.waitScreen('screen-result');
  await host.page.dblclick('#next-round-btn');
  await sleep(800);
  assert.equal(g.room().currentRound, round + 1, 'двойной клик перескочил раунд');

  // Двойное подтверждение судьи даёт ровно одно очко
  const r = g.room();
  const judge = g.byIdx(r.readerIdx);
  await judge.waitScreen('screen-reader');
  await judge.page.click('#sh-top');
  for (const p of g.active().filter(p => p !== judge)) { await p.waitScreen('screen-pick'); await p.submitCard(0); }
  await judge.waitScreen('screen-judge');
  await judge.page.locator('#judge-table .table-card.face-down').first().click();
  await judge.page.locator('#judge-table .table-card.face-up').first().click();
  await judge.page.click('#lb-go');
  const before = Object.values(scores(g)).reduce((a, b) => a + b, 0);
  await judge.page.dblclick('#judge-confirm-btn');
  await g.waitFor(() => ['result', 'end'].includes(g.room().phase), 'итог');
  await sleep(800);
  assert.equal(Object.values(scores(g)).reduce((a, b) => a + b, 0), before + 1);
}));

test('ошибка сети при отправке мема: подсказка и повторная попытка', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await g.start(host);
  const reader = g.byIdx(g.room().readerIdx);
  await reader.waitScreen('screen-reader');
  await reader.page.click('#sh-top');
  const p = g.active().find(x => x !== reader);
  await p.waitScreen('screen-pick');
  g.backend.failNext.set('play_card', 'boom');
  await p.page.locator('#pick-hand .hand-card').first().click();
  await p.page.click('#lb-go');
  await p.page.click('#submit-btn');
  await p.page.waitForFunction(() => /Ошибка сети/.test(document.getElementById('toast').textContent));
  await p.waitEnabled('#submit-btn');
  assert.equal(await p.screen(), 'screen-pick');
  await p.page.click('#submit-btn');
  await p.waitScreen(['screen-waiting-others', 'screen-waiting-judge']);
}));

test('предложение из меню доходит до базы', () => withGame({}, async g => {
  await g.setup(3, { rounds: 5 });
  const p = g.byIdx(1);
  await p.menu('Предложить');
  await p.page.locator('#modal-suggest .suggest-opt', { hasText: 'ситуацию' }).click();
  await p.page.fill('#suggest-text', 'Когда тесты прошли с первого раза');
  await p.page.locator('#modal-suggest button', { hasText: 'Отправить' }).click();
  await g.waitFor(() => g.backend.suggestions.length === 1, 'предложение сохранено');
  const s = g.backend.suggestions[0];
  assert.equal(s.type, 'situation');
  assert.equal(s.player, 'Диля');
  assert.equal(s.room, g.code);
}));

test('без связи с базой: игра берёт сохранённый контент или честно сообщает об ошибке', () => withGame({}, async g => {
  const fresh = await g.newPlayer('Новый');
  g.backend.contentDown = true;
  await fresh.btn('Создать комнату').click();
  await fresh.page.fill('#host-name', 'Новый');
  await fresh.page.locator('.players-grid .num-btn', { hasText: /^3$/ }).click();
  await fresh.btn('Создать комнату').click();
  await fresh.page.waitForFunction(() => /Ошибка загрузки/.test(document.getElementById('toast').textContent));
  assert.notEqual(await fresh.screen(), 'screen-lobby');

  g.backend.contentDown = false;
  const host = await g.newPlayer('Агшин');
  g.code = await host.createRoom('Агшин', 3, 5);
  await host.menu('Выйти');
  await host.reload();
  g.backend.contentDown = true;
  await host.createRoom('Агшин', 3, 5);
  assert.match(await host.toast(), /сохранённом/);
}));

test('новая комната не затирает существующую с тем же кодом', () => withGame({}, async g => {
  g.backend.rooms.set('AAAA', { code: 'AAAA', phase: 'lobby', hostName: 'Чужой', players: { 0: { name: 'Чужой', idx: 0, score: 0 } }, playerCount: 1, rounds: 5, maxPlayers: 3 });
  const host = await g.newPlayer('Агшин');
  await host.page.evaluate(() => { const r = Math.random; let n = 0; window.__armCode = () => { n = 0; Math.random = () => (n++ < 4 ? 0 : r()); }; });
  await host.btn('Создать комнату').click();
  await host.page.fill('#host-name', 'Агшин');
  await host.page.locator('.players-grid .num-btn', { hasText: /^3$/ }).click();
  await host.page.evaluate(() => window.__armCode());
  await host.btn('Создать комнату').click();
  await host.waitScreen('screen-lobby');
  assert.equal(g.backend.rooms.get('AAAA').players[0].name, 'Чужой', 'чужая комната перезаписана');
  assert.notEqual((await host.page.textContent('#lobby-code')).trim(), 'AAAA');
}));

test('модальные окна и просмотр мема', () => withGame({}, async g => {
  const host = await g.setup(3, { rounds: 5 });
  await host.page.click('#hamburger-btn');
  await host.page.click('#menu-overlay');
  await g.start(host);
  const p = g.active().find(x => x.idx !== g.room().readerIdx);
  const reader = g.byIdx(g.room().readerIdx);
  await reader.waitScreen('screen-reader');
  await reader.page.click('#sh-top');
  await p.waitScreen('screen-pick');
  await p.page.locator('#pick-hand .hand-card').first().click();
  assert.ok(await p.page.isVisible('#lb'));
  await p.page.keyboard.press('Escape');
  assert.ok(!(await p.page.isVisible('#lb')));
  assert.equal(await p.page.isDisabled('#submit-btn'), true, 'без выбора отправка недоступна');
}));

test('режим предпросмотра показывает все экраны без ошибок', () => withGame({}, async g => {
  const p = await g.newPlayer('Превью', { url: 'memology.html?preview' });
  const n = await p.page.locator('.pv-btn').count();
  assert.ok(n >= 15);
  for (let i = 0; i < n; i++) {
    await p.page.locator('.pv-btn').nth(i).click();
    await sleep(60);
    assert.ok(await p.screen(), `экран ${i}`);
  }
  assert.equal(g.backend.writes, 0, 'предпросмотр не должен писать в базу');
}));
