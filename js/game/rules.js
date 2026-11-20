// Чтение открытого состояния комнаты — чистые функции без DOM и сети.
// Сами правила (раздача, ходы, очки, переходы) выполняет сервер:
// функции mg_* в supabase/setup.sql.
//
// Открытое состояние комнаты (rooms.data):
//   phase        lobby → reader → picking → judging → result → … → end
//   players      { [idx]: { idx, name, score, playing?, left? } }
//   hostIdx      кто управляет игрой; readerIdx — читающий (он же судья)
//   situation    выбранная ситуация раунда
//   submitted    { [idx]: true } — кто уже сдал мем
//   tableCards   мемы на столе; авторы (playerIdx) появляются после голосования
//   deckCount    сколько карт осталось в колоде

import { GAME } from '../config.js';

export const INFINITE = GAME.infiniteRounds;

// Все занятые места (без пустых) по порядку
export const seats = room =>
  Object.values(room?.players || {}).filter(p => p && typeof p === 'object').sort((a, b) => a.idx - b.idx);

// Участвует в партии: в лобби — каждый, в игре — получившие карты при старте
export const inGame = (room, idx) => room.phase === 'lobby' || !!room.players?.[idx]?.playing;

export const activePlayers = room => seats(room).filter(p => !p.left && inGame(room, p.idx));

export const hostIdx = room => room?.hostIdx ?? 0;

// ── Порядок событий ──────────────────────────────────────
// Ответ сервера может прийти позже более нового состояния (опрос,
// задержавшийся realtime). Игра движется только вперёд, поэтому
// «прогресс» комнаты позволяет отбросить устаревшее.

const PHASE_RANK = { lobby: 0, reader: 1, picking: 2, judging: 3, result: 4 };

export function progress(room) {
  if (!room) return [-1, 0, 0];
  if (room.phase === 'end') return [Infinity, 0, 0];
  const round = room.phase === 'lobby' ? 0 : (room.currentRound || 1);
  return [round, PHASE_RANK[room.phase] ?? 0, Object.keys(room.submitted || {}).length];
}

export function isOlder(a, b) {
  const x = progress(a), y = progress(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// ── Итоги ────────────────────────────────────────────────

export function leaders(players) {
  if (!players.length) return [];
  const top = Math.max(...players.map(p => p.score || 0));
  return players.filter(p => (p.score || 0) === top);
}

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
