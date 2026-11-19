// Правила игры — чистые функции без DOM и сети.
// Принимают состояние комнаты, возвращают патч для patch_room.
// Ключ патча вида "players/2/score" — путь внутри JSON комнаты.
//
// Состояние комнаты (rooms.data):
//   phase        lobby → reader → picking → judging → result → … → end
//   players      { [idx]: { idx, name, score, cid, left? } }  место за столом
//   hostIdx      кто управляет игрой (по умолчанию 0)
//   hands/deck   руки игроков и колода; рука есть только у тех, кто был при старте
//   readerIdx    читающий (он же судья) текущего раунда
//   readerSits   две ситуации на выбор читающему; situation — выбранная
//   submissions  { [idx]: мем }  кто что сыграл в этом раунде
//   tableCards   сыгранные мемы в порядке показа судье
//   seed         зерно для одинаковой у всех «случайности»

import { GAME } from '../config.js';
import { seededRandom, shuffle } from './random.js';

export const INFINITE = GAME.infiniteRounds;

export class GameError extends Error {}

// ── Игроки ───────────────────────────────────────────────

// Все занятые места (без пустых) по порядку
export const seats = room =>
  Object.values(room?.players || {}).filter(p => p && typeof p === 'object').sort((a, b) => a.idx - b.idx);

// Игрок участвует в партии, если получил руку при старте
export const inGame = (room, idx) => room.phase === 'lobby' || room.hands?.[idx] !== undefined;

// Кто сейчас в игре: не ушёл и участвует в партии
export const activePlayers = room => seats(room).filter(p => !p.left && inGame(room, p.idx));

export const hostIdx = room => room?.hostIdx ?? 0;

export const isActive = (room, idx) => activePlayers(room).some(p => p.idx === idx);

// Свободное место: никогда не занятое или освобождённое в лобби
export function freeSeat(room, taken = []) {
  for (let i = 0; i < GAME.maxSeats; i++) {
    const p = room.players?.[i];
    if (taken.includes(i)) continue;
    if (!p || (p.left && room.phase === 'lobby')) return i;
  }
  return -1;
}

// Следующий активный игрок после idx по кругу
export function nextActiveAfter(room, idx) {
  const ids = activePlayers(room).map(p => p.idx);
  if (!ids.length) return -1;
  return ids.find(i => i > idx) ?? ids[0];
}

// ── Порядок событий ──────────────────────────────────────
// Ответ сервера может прийти позже более нового состояния (опрос,
// задержавшийся realtime). Игра движется только вперёд, поэтому
// «прогресс» комнаты позволяет отбросить устаревшее.

const PHASE_RANK = { lobby: 0, reader: 1, picking: 2, judging: 3, result: 4 };

export function progress(room) {
  if (!room) return [-1, 0, 0];
  if (room.phase === 'end') return [Infinity, 0, 0];
  const round = room.phase === 'lobby' ? 0 : (room.currentRound || 1);
  return [round, PHASE_RANK[room.phase] ?? 0, Object.keys(room.submissions || {}).length];
}

export function isOlder(a, b) {
  const x = progress(a), y = progress(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// ── Случайность с зерном комнаты ─────────────────────────

const rng = (room, ...parts) => seededRandom([room.seed || room.code, ...parts].join('|'));

export function pickSituations(room, all, round) {
  const used = new Set(room.usedSituations || []);
  let pool = all.filter(s => !used.has(s));
  if (pool.length < 2) pool = [...all];      // всё сыграно — пускаем по второму кругу
  const [a, b] = shuffle(pool, rng(room, 'sits', round));
  return [a, b ?? a];
}

// ── Ходы ─────────────────────────────────────────────────

export function newRoom({ code, seed, hostName, cid, rounds, maxPlayers }) {
  return {
    code, seed, hostName, rounds, maxPlayers,
    phase: 'lobby', hostIdx: 0,
    players: { 0: { idx: 0, name: hostName, score: 0, cid } },
    playerCount: 1,
    currentRound: 1, readerIdx: 0,
    situation: '', submissions: {}, tableCards: [], winnerIdx: -1,
    readerSits: [], usedSituations: [],
  };
}

export function joinPatch(room, idx, { name, cid }) {
  const present = seats(room).filter(p => !p.left && p.idx !== idx).length + 1;
  return { [`players/${idx}`]: { idx, name, score: 0, cid }, playerCount: present };
}

export function startPatch(room, memes, situations) {
  const players = activePlayers(room);
  if (players.length < GAME.minPlayers) throw new GameError(`Нужно минимум ${GAME.minPlayers} игрока`);
  const need = players.length * GAME.handSize;
  if (memes.length < need) {
    throw new GameError(`Нужно минимум ${need} мемов на ${players.length} игроков, в базе ${memes.length}`);
  }
  const deck = shuffle(memes, rng(room, 'deck'));
  const hands = {};
  players.forEach(p => { hands[p.idx] = deck.splice(0, GAME.handSize); });
  const sits = pickSituations({ ...room, usedSituations: [] }, situations, 1);
  return {
    phase: 'reader', currentRound: 1, readerIdx: players[0].idx,
    hands, deck, discard: [], playerCount: players.length,
    situation: '', submissions: {}, tableCards: [], winnerIdx: -1, tiebreak: false,
    readerSits: sits, usedSituations: sits,
  };
}

export function choosePatch(sit) {
  return { phase: 'picking', situation: sit, submissions: {} };
}

// Кто должен сдать мем в этом раунде
export const pickers = room => activePlayers(room).filter(p => p.idx !== room.readerIdx);

export function readyForJudging(room) {
  if (room.phase !== 'picking') return false;
  const ps = pickers(room);
  return ps.length > 0 && ps.every(p => room.submissions?.[p.idx]);
}

// Порядок карт — от зерна раунда: кто бы ни посчитал, получится то же самое
export function judgingPatch(room) {
  const cards = pickers(room)
    .filter(p => room.submissions?.[p.idx])
    .map(p => ({ playerIdx: p.idx, ...room.submissions[p.idx] }));
  return { phase: 'judging', tableCards: shuffle(cards, rng(room, 'table', room.currentRound)) };
}

export const isLastRound = room => room.rounds !== INFINITE && (room.currentRound || 1) >= room.rounds;

export function leaders(players) {
  if (!players.length) return [];
  const top = Math.max(...players.map(p => p.score || 0));
  return players.filter(p => (p.score || 0) === top);
}

// Очко автору выбранного мема и решение: следующий раунд, доп. раунд или финал
export function judgePatch(room, winnerIdx) {
  const winner = room.players?.[winnerIdx];
  if (!winner) throw new GameError('Автор мема не найден');
  const score = (winner.score || 0) + 1;
  const after = activePlayers(room).map(p => (p.idx === winnerIdx ? { ...p, score } : p));
  const last = isLastRound(room);
  const tie = leaders(after).length > 1;
  return {
    [`players/${winnerIdx}/score`]: score,
    winnerIdx,
    tiebreak: last && tie,
    phase: last && !tie ? 'end' : 'result',
  };
}

export function nextRoundPatch(room, situations) {
  const act = activePlayers(room);
  if (act.length < GAME.minPlayers) return { phase: 'end', endReason: 'players' };
  const reader = nextActiveAfter(room, room.readerIdx);
  // Карты заменяются при розыгрыше; если колода кончилась и кому-то нечем ходить — финал
  const noCards = act.some(p => p.idx !== reader && !(room.hands?.[p.idx] || []).length);
  if (noCards) return { phase: 'end', endReason: 'cards' };
  const round = (room.currentRound || 1) + 1;
  const sits = pickSituations(room, situations, round);
  return {
    phase: 'reader', currentRound: round, readerIdx: reader,
    situation: '', submissions: {}, tableCards: [], winnerIdx: -1, tiebreak: false,
    readerSits: sits, usedSituations: [...(room.usedSituations || []), ...sits],
  };
}

// Читающий ушёл посреди раунда — раунд пропускается без очков
export function skipRoundPatch(room, situations) {
  if (isLastRound(room) && leaders(activePlayers(room)).length <= 1) return { phase: 'end' };
  const next = nextRoundPatch(room, situations);
  if (next.phase === 'reader' && isLastRound(room)) next.tiebreak = true;
  return next;
}

// Уход игрока. В лобби место освобождается, в игре — помечается.
// Если уходит хост, управление переходит следующему игроку.
export function leavePatch(room, idx) {
  const me = room.players?.[idx];
  const patch = { [`players/${idx}`]: { ...me, idx, left: true } };
  if (room.phase === 'lobby') patch.playerCount = seats(room).filter(p => !p.left && p.idx !== idx).length;
  if (hostIdx(room) === idx) {
    const rest = activePlayers(room).filter(p => p.idx !== idx);
    if (rest.length) patch.hostIdx = (rest.find(p => p.idx > idx) || rest[0]).idx;
  }
  return patch;
}

// Что должен сделать хост, глядя на комнату (или null, если ничего).
// Вызывается на каждое обновление; повторный вызов безопасен.
export function hostDuty(room, situations) {
  const { phase } = room;
  if (phase === 'lobby' || phase === 'end') return null;
  if (activePlayers(room).length < GAME.minPlayers) {
    return { why: 'few', patch: { phase: 'end', endReason: 'players' } };
  }
  if (['reader', 'picking', 'judging'].includes(phase) && !isActive(room, room.readerIdx)) {
    return { why: 'reader-left', patch: skipRoundPatch(room, situations) };
  }
  if (readyForJudging(room)) return { why: 'judging', patch: judgingPatch(room) };
  return null;
}

// ── Итоги ────────────────────────────────────────────────

export const standings = room =>
  seats(room).filter(p => inGame(room, p.idx)).sort((a, b) => (b.score || 0) - (a.score || 0) || a.idx - b.idx);

export function verdict(room) {
  const pool = activePlayers(room).length ? activePlayers(room) : standings(room);
  const top = leaders(pool);
  const score = top[0]?.score || 0;
  const extra = room.rounds !== INFINITE && (room.currentRound || 1) > room.rounds;
  return { winners: top, score, extra, tie: top.length > 1 };
}

export const roundsLabel = r => (r === INFINITE ? '∞' : r);

// После ничьей играются дополнительные раунды — «РАУНД 7/5» выглядел бы странно
export function roundText(room) {
  const r = room.currentRound || 1, total = room.rounds;
  if (total !== INFINITE && r > total) return `ДОП. РАУНД ${r - total}`;
  return `РАУНД ${r}/${roundsLabel(total)}`;
}

export function pointsWord(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'очко';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'очка';
  return 'очков';
}
