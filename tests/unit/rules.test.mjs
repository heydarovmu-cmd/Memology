import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../js/game/rules.js';
import { seededRandom, shuffle } from '../../js/game/random.js';
import { jsonbSet } from '../e2e/fake-backend.mjs';

const memes = n => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `m${i + 1}`, image_url: `u${i + 1}` }));
const sits = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);

// Применить патч так же, как patch_room на сервере
const apply = (room, patch) => Object.entries(patch).reduce((r, [k, v]) => jsonbSet(r, k.split('/'), v), room);

function lobby(n) {
  let room = R.newRoom({ code: 'TEST', seed: 'seed', hostName: 'p0', cid: 'c0', rounds: 5, maxPlayers: n });
  for (let i = 1; i < n; i++) room = apply(room, R.joinPatch(room, R.freeSeat(room), { name: 'p' + i, cid: 'c' + i }));
  return room;
}

const started = n => { const r = lobby(n); return apply(r, R.startPatch(r, memes(40), sits)); };

test('одинаковое зерно — одинаковый порядок', () => {
  const a = shuffle([1, 2, 3, 4, 5, 6], seededRandom('x'));
  const b = shuffle([1, 2, 3, 4, 5, 6], seededRandom('x'));
  const c = shuffle([1, 2, 3, 4, 5, 6], seededRandom('y'));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('места: вход, уход в лобби освобождает место', () => {
  let room = lobby(3);
  assert.deepEqual(R.seats(room).map(p => p.idx), [0, 1, 2]);
  room = apply(room, R.leavePatch(room, 1));
  assert.equal(R.freeSeat(room), 1);
  assert.equal(R.activePlayers(room).length, 2);
  assert.equal(room.playerCount, 2);
});

test('старт раздаёт по 5 карт без повторов', () => {
  const room = started(4);
  const ids = [...room.deck, ...Object.values(room.hands).flat()].map(c => c.id);
  assert.equal(new Set(ids).size, 40);
  Object.values(room.hands).forEach(h => assert.equal(h.length, 5));
  assert.equal(room.phase, 'reader');
  assert.equal(room.readerIdx, 0);
});

test('старт: мало игроков или мемов — понятная ошибка', () => {
  assert.throws(() => R.startPatch(lobby(2), memes(40), sits), R.GameError);
  assert.throws(() => R.startPatch(lobby(3), memes(10), sits), /15 мемов/);
});

test('опоздавший без руки не участвует в раунде', () => {
  let room = started(3);
  room = apply(room, { 'players/3': { idx: 3, name: 'late', score: 0 } });
  assert.deepEqual(R.activePlayers(room).map(p => p.idx), [0, 1, 2]);
});

test('голосование ждёт всех, кроме читающего и ушедших', () => {
  let room = apply(started(4), R.choosePatch('s1'));
  room = apply(room, { 'submissions/1': memes(1)[0], 'submissions/2': memes(2)[1] });
  assert.equal(R.readyForJudging(room), false);
  room = apply(room, { 'players/3/left': true });
  assert.equal(R.readyForJudging(room), true);
  const a = R.judgingPatch(room), b = R.judgingPatch(room);
  assert.deepEqual(a, b, 'порядок карт не зависит от того, кто его считает');
  assert.deepEqual(a.tableCards.map(c => c.playerIdx).sort(), [1, 2]);
});

test('ничья в последнем раунде даёт доп. раунд, перевес — финал', () => {
  let room = { ...started(3), currentRound: 5, phase: 'judging' };
  room = apply(room, { 'players/1/score': 2, 'players/2/score': 1 });
  const tie = R.judgePatch(room, 2);
  assert.equal(tie.phase, 'result');
  assert.equal(tie.tiebreak, true);
  const win = R.judgePatch(room, 1);
  assert.equal(win.phase, 'end');
});

test('следующий раунд: читающий по кругу, ушедшие пропускаются', () => {
  let room = { ...started(4), phase: 'result' };
  assert.equal(R.nextRoundPatch(room, sits).readerIdx, 1);
  room = apply(room, { 'players/1/left': true });
  assert.equal(R.nextRoundPatch(room, sits).readerIdx, 2);
  room = { ...room, readerIdx: 3 };
  assert.equal(R.nextRoundPatch(room, sits).readerIdx, 0);
});

test('игра заканчивается, когда мало игроков или кончились карты', () => {
  let room = { ...started(3), phase: 'result' };
  assert.equal(R.nextRoundPatch(apply(room, { 'players/2/left': true }), sits).endReason, 'players');
  room = apply(room, { 'hands/2': [] });
  assert.equal(R.nextRoundPatch(room, sits).endReason, 'cards');
});

test('хост уходит — управление переходит следующему', () => {
  const room = started(4);
  const p = R.leavePatch(room, 0);
  assert.equal(p.hostIdx, 1);
  assert.equal(p['players/0'].left, true);
});

test('обязанности хоста: ушёл читающий — раунд пропускается', () => {
  let room = apply(started(4), R.choosePatch('s1'));
  room = apply(room, { 'players/0/left': true });
  const duty = R.hostDuty(room, sits);
  assert.equal(duty.why, 'reader-left');
  assert.equal(duty.patch.readerIdx, 1);
  assert.equal(duty.patch.currentRound, 2);
});

test('устаревшее состояние распознаётся', () => {
  const room = started(3);
  const picking = apply(room, R.choosePatch('s1'));
  const sub = apply(picking, { 'submissions/1': memes(1)[0] });
  assert.ok(R.isOlder(room, picking));
  assert.ok(R.isOlder(picking, sub));
  assert.ok(!R.isOlder(sub, picking));
  assert.ok(R.isOlder(sub, { ...sub, phase: 'end' }));
});

test('итог: ничья не называет одного победителя', () => {
  const room = apply(started(3), { 'players/0/score': 2, 'players/1/score': 2 });
  const v = R.verdict(room);
  assert.equal(v.tie, true);
  assert.deepEqual(v.winners.map(p => p.idx), [0, 1]);
});

test('ситуации не повторяются, пока есть новые', () => {
  const room = { ...started(3), usedSituations: sits.slice(0, 8) };
  const [a, b] = R.pickSituations(room, sits, 2);
  assert.deepEqual([a, b].sort(), ['s10', 's9']);
});

test('слова «очко/очка/очков»', () => {
  assert.deepEqual([0, 1, 2, 5, 11, 21, 22, 25].map(R.pointsWord),
    ['очков', 'очко', 'очка', 'очков', 'очков', 'очко', 'очка', 'очков']);
});
