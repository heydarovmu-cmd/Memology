// Отрисовка игровых экранов. Только DOM: никаких запросов к серверу.
import { $, esc } from '../shared/dom.js';
import { AVATARS, COLORS, GAME } from '../config.js';
import {
  seats, hostIdx, roundText, roundsLabel, standings, verdict, pointsWord, inGame,
} from './rules.js';
import { S, amHost } from './state.js';
import { memeImg, showHamburger } from './ui.js';

const avatar = idx => AVATARS[idx % AVATARS.length];
const color = idx => COLORS[idx % COLORS.length];
const nameOf = (room, idx, fallback = 'Читающий') => room.players?.[idx]?.name || fallback;

// ── Лобби ──────────────────────────────────────────────
export function renderLobby(room) {
  const host = amHost();
  $('lobby-code').textContent = room.code;
  $('lobby-rounds-label').textContent = `Игроков: ${room.maxPlayers || '?'} · Раундов: ${roundsLabel(room.rounds)}`;
  $('lobby-role-label').textContent = host ? 'ВЫ — ХОСТ' : 'ВЫ — УЧАСТНИК';
  $('lobby-title').textContent = host ? 'Комната создана!' : 'Ты в комнате!';
  $('lobby-host-controls').hidden = !host;
  $('lobby-guest-wait').hidden = host;

  const max = room.maxPlayers || GAME.maxSeats;
  const present = seats(room).filter(p => !p.left);
  const filled = present.map(p => `
    <div class="player-slot ${p.idx === S.myIdx ? 'me' : ''}">
      <div class="slot-avatar" style="background:${color(p.idx)}18;color:${color(p.idx)}">${avatar(p.idx)}</div>
      <div class="slot-name">${esc(p.name)} <span class="slot-score">(${p.score || 0} очк.)</span></div>
      ${p.idx === hostIdx(room) ? '<span class="slot-badge badge-host">Хост</span>' : ''}
      ${p.idx === S.myIdx ? '<span class="slot-badge badge-you">Ты</span>' : ''}
    </div>`).join('');
  const empty = Array.from({ length: Math.max(0, max - present.length) }, (_, i) => `
    <div class="player-slot empty">
      <div class="slot-avatar">${present.length + i + 1}</div>
      <div class="slot-name">Ожидание...</div>
    </div>`).join('');
  $('lobby-slots').innerHTML = filled + empty;

  if (host) {
    const n = present.length;
    $('lobby-start-btn').disabled = n < GAME.minPlayers;
    $('lobby-player-hint').textContent =
      n >= max ? `Все ${max} игроков в комнате — начинаем!` :
      n < GAME.minPlayers ? `Ждём игроков... (${n}/${max})` :
      `${n} из ${max} игроков — можно начинать!`;
  }
  showHamburger();
}

// ── Покерный стол ──────────────────────────────────────
export function renderPokerTable(containerId, room) {
  const el = $(containerId);
  if (!el || !room) return;
  const players = seats(room).filter(p => inGame(room, p.idx));
  const n = players.length;
  if (!n) return;
  const subs = room.submitted || {};
  const cx = 50, cy = 50, rx = 44, ry = 40;

  el.innerHTML = '<div class="poker-logo">MEMOLOGY</div>' + players.map((p, i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    // Проекция на границу прямоугольника: у эллипса углы стола пустовали
    const m = Math.max(Math.abs(ca), Math.abs(sa)) || 1;
    const x = cx + rx * ca / m, y = cy + ry * sa / m;

    let cls = 'seat-avatar', status, statusCls;
    if (p.left) { cls += ' left'; status = '🚪 Вышел'; statusCls = 'left'; }
    else if (p.idx === room.readerIdx) { cls += ' reader-seat'; status = '🎤 Читает'; statusCls = 'reader-lbl'; }
    else if (subs[p.idx] !== undefined) { cls += ' done'; status = '✅ Выбрал'; statusCls = 'done'; }
    else { cls += ' thinking'; status = '⏳ Думает'; statusCls = 'thinking'; }
    if (p.idx === S.myIdx) cls += ' me';

    return `<div class="poker-seat" style="left:${x}%;top:${y}%">
      <div class="${cls}">${avatar(p.idx)}</div>
      <div class="seat-name">${esc(p.name)} <span class="seat-pts">(${p.score || 0})</span></div>
      <div class="seat-status ${statusCls}">${status}</div>
    </div>`;
  }).join('');
}

// ── Читающий выбирает ситуацию ─────────────────────────
// Две ситуации на выбор знает только читающий: они приходят в его S.view
export function renderReader(room) {
  const sits = S.view?.sits?.length ? S.view.sits : ['', ''];
  S.shownSits = [...sits];
  S.flipped = false;
  $('reader-round-badge').textContent = roundText(room);
  $('reader-hint').textContent = '💡 Нажми на перевёрнутую — карточка развернётся';
  const card = $('dual-card');
  card.classList.remove('flipped');
  card.innerHTML = `
    <div class="sit-half top" id="sh-top" data-action="readerTap" data-half="0">
      <div class="sit-label">Ситуация А</div>
      <div class="sit-text">${esc(sits[0])}</div>
      <div class="sit-tap" id="tap-a">нажми чтобы выбрать</div>
    </div>
    <div class="sit-divider"></div>
    <div class="sit-half bottom" id="sh-bot" data-action="readerTap" data-half="1">
      <div class="sit-tap" id="tap-b">нажми чтобы развернуть</div>
      <div class="sit-text">${esc(sits[1] ?? sits[0])}</div>
      <div class="sit-label">Ситуация Б</div>
    </div>`;
}

export function flipReaderCard() {
  S.flipped = !S.flipped;
  $('dual-card').classList.toggle('flipped', S.flipped);
  $('tap-a').textContent = S.flipped ? 'нажми чтобы развернуть' : 'нажми чтобы выбрать';
  $('tap-b').textContent = S.flipped ? 'нажми чтобы выбрать' : 'нажми чтобы развернуть';
  $('reader-hint').textContent = '💡 Нажми ещё раз, чтобы выбрать эту ситуацию';
}

export function markReaderChoice(half) {
  $(half === 0 ? 'sh-bot' : 'sh-top')?.classList.add('not-chosen');
  const chosen = $(half === 0 ? 'sh-top' : 'sh-bot');
  if (chosen) chosen.style.pointerEvents = 'none';
}

export function renderWaitingSit(room) {
  $('waiting-sit-text').textContent = `${nameOf(room, room.readerIdx)} выбирает ситуацию...`;
}

// ── Выбор мема ─────────────────────────────────────────
// Рука — только своя, из S.view
export function renderPick(room) {
  const hand = S.view?.hand || [];
  S.selectedHand = null;
  $('pick-round-badge').textContent = roundText(room);
  $('pick-sit-text').textContent = room.situation || '—';
  $('submit-btn').disabled = true;
  $('pick-hand').innerHTML = hand.map((m, i) => `
    <div class="hand-card" id="hc-${i}" data-action="openHandCard" data-index="${i}">
      ${memeImg(m, 78)}
      <div class="hand-card-title">${esc(m.title)}</div>
    </div>`).join('');
  updatePick(room);
}

export function updatePick(room) {
  const left = room.deckCount ?? 0;
  const badge = $('deck-badge');
  badge.textContent = '🂠 ' + left;
  badge.classList.toggle('deck-low', left <= GAME.handSize);
  renderPokerTable('poker-table', room);
}

export function markHandSelection(i) {
  document.querySelectorAll('#pick-hand .hand-card').forEach((c, idx) => c.classList.toggle('selected-hand', idx === i));
}

export function renderWaitingOthers(room) {
  $('waiting-round-badge').textContent = roundText(room);
  $('waiting-sit-text2').textContent = room.situation || '—';
  renderPokerTable('poker-table-waiting', room);
}

export function renderReaderWait(room) {
  $('reader-wait-round-badge').textContent = roundText(room);
  $('reader-wait-sit').textContent = room.situation || '—';
  renderPokerTable('poker-table-reader', room);
}

// ── Голосование ────────────────────────────────────────
export function renderJudge(room, revealed) {
  // Судья выбирает из того, что видит: снимок карт фиксируется при отрисовке
  const cards = room.tableCards || [];
  S.judgeCards = cards;
  S.judgeSelected = null;
  S.judgeRevealed = revealed;
  $('judge-round-badge').textContent = roundText(room);
  $('judge-sit-text').textContent = room.situation || '—';
  const btn = $('judge-confirm-btn');
  if (!revealed) {
    $('judge-instruction').textContent = '🔀 Мемы перемешаны анонимно — нажми чтобы раскрыть!';
    $('judge-table').innerHTML = cards.map(() =>
      '<div class="table-card face-down" data-action="revealCards"><div class="tc-inner"></div></div>').join('');
    btn.hidden = true;
  } else {
    $('judge-instruction').textContent = '👇 Нажми на мем, чтобы рассмотреть его целиком';
    $('judge-table').innerHTML = cards.map((tc, i) => `
      <div class="table-card face-up flip-in" id="jc-${i}" data-action="openTableCard" data-index="${i}" style="animation-delay:${i * 0.07}s">
        <div class="tc-inner">${memeImg(tc, 90)}<div class="tc-title">${esc(tc.title)}</div></div>
      </div>`).join('');
    btn.hidden = false;
    btn.disabled = true;
  }
}

export function markJudgeSelection(i) {
  document.querySelectorAll('#judge-table .table-card.face-up').forEach((el, idx) => el.classList.toggle('winning', idx === i));
}

export function renderWaitingJudge(room) {
  $('waiting-judge-text').textContent = `${nameOf(room, room.readerIdx)} выбирает лучший мем...`;
}

// ── Итог раунда ────────────────────────────────────────
export function renderResult(room) {
  const cards = room.tableCards || [];
  const winner = room.players?.[room.winnerIdx];
  const winCard = cards.find(c => c.playerIdx === room.winnerIdx);
  $('result-winner-area').innerHTML = winner && winCard ? `
    <div class="winner-card">
      <div class="winner-kicker">🏆 Победитель раунда</div>
      <div class="winner-name">${esc(winner.name)}</div>
      <div class="winner-img" data-action="openWinnerCard">${memeImg(winCard, 100)}</div>
      <div class="winner-title">«${esc(winCard.title)}»</div>
    </div>` : '<div class="no-winner">Раунд без победителя 😅</div>';

  $('result-all-cards').innerHTML = cards.map((tc, i) => {
    const isWin = tc.playerIdx === room.winnerIdx;
    return `<div class="table-card face-up ${isWin ? 'winning' : ''}" data-action="openResultCard" data-index="${i}">
      <div class="tc-inner">${memeImg(tc, 90)}
      <div class="tc-title">${esc(tc.title)}</div>
      <div class="tc-owner">${esc(nameOf(room, tc.playerIdx, '?'))}${isWin ? ' 🏆' : ''}</div></div></div>`;
  }).join('');

  // Партия должна была закончиться, но на вершине несколько игроков
  const note = $('tiebreak-note');
  note.hidden = !room.tiebreak;
  if (room.tiebreak) {
    const { winners, score } = verdict(room);
    note.innerHTML = `⚔️ <strong>Ничья!</strong> ${winners.map(p => esc(p.name)).join(' и ')} — по ${score}.<br>Играем дополнительный раунд до первого перевеса.`;
  }
  updateResult();
}

export function updateResult() {
  const host = amHost();
  $('next-round-btn').hidden = !host;
  $('host-only-hint').hidden = host;
}

// ── Счёт и финал ───────────────────────────────────────
function scoreRows(room, withWord) {
  const { winners } = verdict(room);
  const top = new Set(winners.map(p => p.idx));
  return standings(room).map((p, i) => `
    <div class="score-row ${top.has(p.idx) ? 'winner' : ''}">
      <div class="score-rank">${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'}</div>
      <div class="score-name">${esc(p.name)}${p.left ? ' <span class="score-left">(вышел)</span>' : ''}</div>
      <div class="score-pts">${p.score || 0}${withWord ? ' ' + pointsWord(p.score || 0) : ''}</div>
    </div>`).join('');
}

export function renderScores(room) {
  $('live-scoreboard').innerHTML = scoreRows(room, false);
}

const END_REASONS = {
  cards: 'Мемы в колоде закончились',
  players: 'Осталось слишком мало игроков',
};

export function renderEnd(room) {
  const { winners, score, extra, tie } = verdict(room);
  const names = winners.map(p => p.name);
  $('winner-text').textContent = !winners.length ? 'Игра окончена'
    : tie ? `🤝 Ничья! ${names.join(' и ')} — по ${score}`
    : `🎉 ${names[0]} победил с ${score} ${score % 10 === 1 && score % 100 !== 11 ? 'очком' : 'очками'}!` +
      (extra ? ' (в дополнительном раунде)' : '');
  const reason = END_REASONS[room.endReason];
  $('end-reason').hidden = !reason;
  $('end-reason').textContent = reason || '';
  $('final-scoreboard').innerHTML = scoreRows(room, true);
}

