// Серверная логика игры (supabase/setup.sql) на настоящем Postgres.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startPg, ADMIN_ID } from './pg.mjs';

let db;
before(async () => { db = await startPg(); });
after(() => db?.stop());

const tok = name => `token-${name}-${Math.random().toString(36).slice(2, 8)}`;
const room = code => db.json(`select data::text from rooms where code = '${code}';`);
const secrets = code => db.json(`select row_to_json(s)::text from room_secrets s where code = '${code}';`);
const rejects = (p, re) => assert.rejects(p, e => re.test(e.message));

// Комната с n игроками; возвращает код и секреты игроков по местам
async function lobby(n, { rounds = 5, max = n } = {}) {
  const t = [tok('host')];
  const r = await db.rpc('mg_create', { p_name: 'Игрок 0', p_token: t[0], p_rounds: rounds, p_max: max });
  for (let i = 1; i < n; i++) {
    t.push(tok('p' + i));
    await db.rpc('mg_join', { p_code: r.code, p_name: 'Игрок ' + i, p_token: t[i] });
  }
  return { code: r.code, t };
}

async function started(n, opts) {
  const g = await lobby(n, opts);
  await db.rpc('mg_start', { p_code: g.code, p_token: g.t[0] });
  return g;
}

// Сыграть раунд: читающий выбирает ситуацию, все ходят, судья выбирает позицию pos
async function round(g, { pos = 0, winner } = {}) {
  let d = await room(g.code);
  await db.rpc('mg_choose', { p_code: g.code, p_token: g.t[d.readerIdx], p_half: 0 });
  d = await room(g.code);
  const act = Object.values(d.players).filter(p => !p.left && p.playing).map(p => p.idx);
  for (const i of act) if (i !== d.readerIdx) await db.rpc('mg_play', { p_code: g.code, p_token: g.t[i], p_index: 0 });
  d = await room(g.code);
  assert.equal(d.phase, 'judging');
  if (winner != null) pos = (await secrets(g.code)).owners.indexOf(winner);
  return db.rpc('mg_judge', { p_code: g.code, p_token: g.t[d.readerIdx], p_pos: pos });
}

test('игрок не видит каталог, колоду и чужие руки', async () => {
  const g = await started(3);
  for (const t of ['memes', 'situations', 'room_secrets']) {
    const n = await db.query(`select count(*) from public.${t};`, { role: 'anon' }).catch(e => e.message);
    assert.ok(n === '0' || /permission denied/.test(n), `${t}: ${n}`);
  }
  assert.equal(await db.query("select count(*) from storage.objects where bucket_id = 'memes';", { role: 'anon' }), '0');
  const d = await room(g.code);
  const text = JSON.stringify(d);
  for (const k of ['hands', 'deck', 'readerSits', 'owners', 'submissions']) assert.ok(!(k in d), `в комнате нет ${k}`);
  assert.ok(!/image_url/.test(text), 'в открытых данных нет карт');
  const v = await db.rpc('mg_view', { p_code: g.code, p_token: g.t[1] });
  assert.equal(v.idx, 1);
  assert.equal(v.hand.length, 5);
  assert.deepEqual(v.sits, [], 'ситуации на выбор видит только читающий');
  const reader = await db.rpc('mg_view', { p_code: g.code, p_token: g.t[0] });
  assert.equal(reader.sits.length, 2);
  await rejects(db.rpc('mg_view', { p_code: g.code, p_token: 'чужой-токен' }), /not_in_room/);
});

test('авторы мемов скрыты до голосования, после — раскрываются', async () => {
  const g = await started(3);
  let d = await room(g.code);
  await db.rpc('mg_choose', { p_code: g.code, p_token: g.t[0], p_half: 1 });
  await db.rpc('mg_play', { p_code: g.code, p_token: g.t[1], p_index: 2 });
  d = await room(g.code);
  assert.deepEqual(d.submitted, { 1: true });
  await db.rpc('mg_play', { p_code: g.code, p_token: g.t[2], p_index: 0 });
  d = await room(g.code);
  assert.equal(d.phase, 'judging');
  assert.equal(d.tableCards.length, 2);
  assert.ok(d.tableCards.every(c => !('playerIdx' in c)), 'на столе нет авторов');
  const owners = (await secrets(g.code)).owners;
  d = await db.rpc('mg_judge', { p_code: g.code, p_token: g.t[0], p_pos: 1 });
  assert.equal(d.phase, 'result');
  assert.equal(d.winnerIdx, owners[1]);
  assert.deepEqual(d.tableCards.map(c => c.playerIdx), owners);
  assert.equal(d.players[owners[1]].score, 1);
});

test('полная партия: карты не теряются и не повторяются', async () => {
  const g = await started(4);
  const seen = new Set();
  for (let r = 0; r < 5; r++) {
    const d = await round(g);
    d.tableCards.forEach(c => { assert.ok(!seen.has(c.id), 'мем сыгран дважды'); seen.add(c.id); });
    const s = await secrets(g.code);
    const ids = [...s.deck, ...Object.values(s.hands).flat()].map(c => c.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length + seen.size, 40);
    if (d.phase === 'end') break;
    await db.rpc('mg_next', { p_code: g.code, p_token: g.t[0] });
  }
  const d = await room(g.code);
  assert.ok(['end', 'reader'].includes(d.phase));
});

test('читающий по кругу; ничья в последнем раунде даёт доп. раунд', async () => {
  const g = await started(3, { rounds: 3 });
  const readers = [];
  for (const w of [1, 2]) {
    readers.push((await room(g.code)).readerIdx);
    await round(g, { winner: w });
    await db.rpc('mg_next', { p_code: g.code, p_token: g.t[0] });
  }
  readers.push((await room(g.code)).readerIdx);
  assert.deepEqual(readers, [0, 1, 2]);
  let d = await round(g, { winner: 0 });            // 1 / 1 / 1 → ничья
  assert.equal(d.phase, 'result');
  assert.equal(d.tiebreak, true);
  await db.rpc('mg_next', { p_code: g.code, p_token: g.t[0] });
  d = await round(g, { winner: (await room(g.code)).readerIdx === 1 ? 2 : 1 });
  assert.equal(d.phase, 'end');
});

test('одновременный вход: каждому своё место, лишние получают отказ', async () => {
  const g = await lobby(1, { max: 4 });
  const ts = Array.from({ length: 6 }, (_, i) => tok('rush' + i));
  const res = await Promise.allSettled(ts.map((t, i) => db.rpc('mg_join', { p_code: g.code, p_name: 'Гость ' + i, p_token: t })));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value.idx);
  assert.equal(ok.length, 3);
  assert.deepEqual([...ok].sort(), [1, 2, 3]);
  res.filter(r => r.status === 'rejected').forEach(r => assert.match(r.reason.message, /room_full/));
  // Повторный вход с того же устройства возвращает то же место
  const first = ts[res.findIndex(r => r.status === 'fulfilled')];
  const again = await db.rpc('mg_join', { p_code: g.code, p_name: 'Гость', p_token: first });
  assert.ok(ok.includes(again.idx));
});

test('после старта войти нельзя; хост и читающий проверяются', async () => {
  const g = await lobby(3);
  await rejects(db.rpc('mg_start', { p_code: g.code, p_token: g.t[1] }), /not_host/);
  await db.rpc('mg_start', { p_code: g.code, p_token: g.t[0] });
  await rejects(db.rpc('mg_start', { p_code: g.code, p_token: g.t[0] }), /game_started/);
  await rejects(db.rpc('mg_join', { p_code: g.code, p_name: 'Опоздал', p_token: tok('late') }), /game_started/);
  await rejects(db.rpc('mg_choose', { p_code: g.code, p_token: g.t[1], p_half: 0 }), /not_reader/);
  await db.rpc('mg_choose', { p_code: g.code, p_token: g.t[0], p_half: 0 });
  await rejects(db.rpc('mg_play', { p_code: g.code, p_token: g.t[0], p_index: 0 }), /is_reader/);
  await db.rpc('mg_play', { p_code: g.code, p_token: g.t[1], p_index: 0 });
  await rejects(db.rpc('mg_play', { p_code: g.code, p_token: g.t[1], p_index: 0 }), /already_played/);
  await rejects(db.rpc('mg_play', { p_code: g.code, p_token: g.t[2], p_index: 9 }), /bad_card/);
  await rejects(db.rpc('mg_next', { p_code: g.code, p_token: g.t[0] }), /wrong_phase/);
  await rejects(db.rpc('mg_join', { p_code: 'ZZZZ', p_name: 'X', p_token: tok('x') }), /room_not_found/);
});

test('мало мемов или игроков — понятная ошибка', async () => {
  const g = await lobby(2, { max: 3 });
  await rejects(db.rpc('mg_start', { p_code: g.code, p_token: g.t[0] }), /few_players/);
  await db.query('update memes set active = false where id > 12;');
  try {
    const h = await lobby(3);
    await rejects(db.rpc('mg_start', { p_code: h.code, p_token: h.t[0] }), /few_memes:15:12/);
  } finally {
    await db.query('update memes set active = true;');
  }
});

test('выход: место в лобби освобождается, в игре раунд продолжается без ушедшего', async () => {
  const g = await lobby(3, { max: 4 });
  let d = await db.rpc('mg_leave', { p_code: g.code, p_token: g.t[2] });
  assert.equal(d.players[2].left, true);
  assert.equal(d.playerCount, 2);
  const j = await db.rpc('mg_join', { p_code: g.code, p_name: 'Новый', p_token: tok('new') });
  assert.equal(j.idx, 2);

  const h = await started(4);
  await db.rpc('mg_choose', { p_code: h.code, p_token: h.t[0], p_half: 0 });
  await db.rpc('mg_play', { p_code: h.code, p_token: h.t[1], p_index: 0 });
  await db.rpc('mg_play', { p_code: h.code, p_token: h.t[2], p_index: 0 });
  d = await db.rpc('mg_leave', { p_code: h.code, p_token: h.t[3] });
  assert.equal(d.phase, 'judging', 'последний недостающий ушёл — сразу голосование');
  assert.equal(d.tableCards.length, 2);
});

test('уходит читающий — раунд пропускается; уходит хост — хостом становится следующий', async () => {
  const g = await started(4);
  let d = await db.rpc('mg_leave', { p_code: g.code, p_token: g.t[0] });
  assert.equal(d.hostIdx, 1);
  assert.equal(d.phase, 'reader');
  assert.equal(d.currentRound, 2);
  assert.equal(d.readerIdx, 1);
  d = await db.rpc('mg_leave', { p_code: g.code, p_token: g.t[2] });   // осталось двое
  assert.equal(d.phase, 'end');
  assert.equal(d.endReason, 'players');
});

test('колода кончилась — игра заканчивается', async () => {
  await db.query('update memes set active = false where id > 17;');
  try {
    const g = await started(3, { rounds: 9999 });
    let d;
    for (let i = 0; i < 30; i++) {
      d = await round(g);
      if (d.phase === 'end') break;
      d = await db.rpc('mg_next', { p_code: g.code, p_token: g.t[0] });
      if (d.phase === 'end') break;
    }
    assert.equal(d.phase, 'end');
    assert.equal(d.endReason, 'cards');
  } finally {
    await db.query('update memes set active = true;');
  }
});

test('админ видит и меняет всё, аноним — только отправляет предложение', async () => {
  const admin = { role: 'authenticated', uid: ADMIN_ID };
  const stranger = { role: 'authenticated', uid: '11111111-2222-3333-4444-555555555555' };
  assert.equal(await db.query('select count(*) from memes;', admin), '40');
  assert.equal(await db.query('select count(*) from memes;', stranger), '0');
  assert.equal(await db.query('select public.is_admin();', admin), 't');
  assert.equal(await db.query('select public.is_admin();', { role: 'anon' }), 'f');
  await db.query("insert into suggestions (type, text) values ('other', 'привет');", { role: 'anon' });
  assert.equal(await db.query('select count(*) from suggestions;', { role: 'anon' }), '0');
  assert.equal(await db.query('select count(*) from suggestions;', admin), '1');
  await db.query('delete from memes where id = 40;', { role: 'anon' });
  assert.equal(await db.query('select count(*) from memes;'), '40', 'аноним не может удалить мем');
  await rejects(db.query("insert into situations (text) values ('взлом');", { role: 'anon' }), /row-level security/);
  await rejects(db.query('select public.mg_settle(\'X\');', { role: 'anon' }), /permission denied/);
});

test('комнату нельзя менять в обход игры; старых функций нет', async () => {
  const room = await db.rpc('mg_create', { p_name: 'Хост', p_token: 'host-token-1', p_rounds: 5, p_max: 3 });
  await rejects(db.query(`update rooms set data = '{}' where code = '${room.code}';`, { role: 'anon' }), /permission denied/);
  await rejects(db.query("insert into rooms (code, data) values ('HACK', '{}');", { role: 'anon' }), /permission denied/);
  assert.equal((await db.json(`select data::text from rooms where code = '${room.code}';`)).phase, 'lobby');
  assert.equal(await db.query("select count(*) from pg_proc where proname in ('patch_room', 'play_card');"), '0');
  await rejects(db.query('select public.cleanup_old_rooms();', { role: 'anon' }), /permission denied/);
  assert.equal(await db.query("select count(*) from pg_policies where tablename = 'rooms';"), '1');
});

test('SQL без существующего админа выполняется и никого не назначает', async () => {
  const other = await startPg({ admin: false });
  try {
    const sql = readFileSync(path.resolve('supabase/setup.sql'), 'utf8')
      .replace(/__ADMIN_USER_ID__/g, '99999999-9999-4999-8999-999999999999');
    const f = path.join(other.dir, 'noadmin.sql');
    writeFileSync(f, sql);
    await other.query(`\\i ${f}`);
    assert.equal(await other.query('select count(*) from admins;'), '0');
    assert.equal(await other.query('select public.mg_version();'), '2');
  } finally { await other.stop(); }
});

test('повторный запуск SQL ничего не ломает', async () => {
  const sql = readFileSync(path.resolve('supabase/setup.sql'), 'utf8').replace(/__ADMIN_USER_ID__/g, ADMIN_ID);
  const f = path.join(db.dir, 'again.sql');
  writeFileSync(f, sql);
  await db.query(`\\i ${f}`);
  assert.equal(await db.query('select public.mg_version();'), '2');
  assert.equal(await db.query("select count(*) from pg_policies where tablename = 'memes';"), '1');
});

test('новая комната не занимает код существующей', async () => {
  const taken = await db.query('select setseed(0.42); select public.mg_codegen();');
  const code = taken.split('\n').pop();
  await db.query(`insert into rooms (code, data) values ('${code}', '{"phase":"lobby"}');`);
  const out = await db.query(
    "select setseed(0.42); select public.mg_create(p_name => 'Хост', p_token => 'token-collide-1', p_rounds => 5, p_max => 3)::text;",
    { role: 'anon' });
  const made = JSON.parse(out.split('\n').pop());
  assert.notEqual(made.code, code);
  assert.equal((await room(code)).phase, 'lobby');
});
