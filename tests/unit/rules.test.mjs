import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../../js/game/rules.js';

const room = (over = {}) => ({
  code: 'TEST', phase: 'picking', currentRound: 2, rounds: 5, readerIdx: 0, hostIdx: 0,
  players: {
    0: { idx: 0, name: 'p0', score: 1, playing: true },
    1: { idx: 1, name: 'p1', score: 2, playing: true },
    2: { idx: 2, name: 'p2', score: 2, playing: true },
    3: { idx: 3, name: 'late', score: 0 },
    4: { idx: 4, name: 'gone', score: 5, playing: true, left: true },
  },
  submitted: { 1: true },
  ...over,
});

test('активные: получили карты при старте и не ушли', () => {
  assert.deepEqual(R.activePlayers(room()).map(p => p.idx), [0, 1, 2]);
  assert.deepEqual(R.activePlayers(room({ phase: 'lobby' })).map(p => p.idx), [0, 1, 2, 3]);
});

test('устаревшее состояние распознаётся', () => {
  const a = room({ phase: 'reader', submitted: {} });
  const b = room();
  const c = room({ submitted: { 1: true, 2: true } });
  assert.ok(R.isOlder(a, b));
  assert.ok(R.isOlder(b, c));
  assert.ok(!R.isOlder(c, b));
  assert.ok(R.isOlder(c, room({ phase: 'end' })));
  assert.ok(R.isOlder(room({ phase: 'lobby' }), a));
});

test('итог: ничья среди активных, ушедший не побеждает', () => {
  const v = R.verdict(room());
  assert.equal(v.tie, true);
  assert.deepEqual(v.winners.map(p => p.idx), [1, 2]);
  assert.deepEqual(R.standings(room()).map(p => p.idx), [4, 1, 2, 0]);
});

test('подпись раунда и доп. раунды', () => {
  assert.equal(R.roundText(room()), 'РАУНД 2/5');
  assert.equal(R.roundText(room({ currentRound: 7 })), 'ДОП. РАУНД 2');
  assert.equal(R.roundText(room({ rounds: R.INFINITE })), 'РАУНД 2/∞');
});

test('слова «очко/очка/очков»', () => {
  assert.deepEqual([0, 1, 2, 5, 11, 21, 22, 25].map(R.pointsWord),
    ['очков', 'очко', 'очка', 'очков', 'очков', 'очко', 'очка', 'очков']);
});
