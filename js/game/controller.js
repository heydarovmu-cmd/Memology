// Ход игры: действия игрока и реакция на обновления комнаты.
// Правила выполняет сервер (функции mg_*), здесь — только интерфейс.
import { $, toast } from '../shared/dom.js';
import { api } from './api.js';
import { inGame } from './rules.js';
import { S, amHost, amReader, once, resetRoomState } from './state.js';
import { deviceToken, saveSession, loadSession, clearSession } from './storage.js';
import { connect, disconnect, receive, onRoom } from './sync.js';
import {
  showScreen, ensureScreen, activeScreen, openModal, closeModal, showHamburger, hideHamburger,
  closeMenu, openMeme, spawnConfetti, scaleTagline,
} from './ui.js';
import * as V from './screens.js';

const say = e => toast(e.message, 3500);
let leaving = false;

// Ход на сервере; ответ — новое состояние комнаты
async function act(fn) {
  const room = await fn(S.roomCode, deviceToken());
  receive(room);
  return room;
}

// ── Вход в комнату ─────────────────────────────────────
function enterRoom(code, idx, name, room) {
  S.roomCode = code;
  S.myIdx = idx;
  S.myName = name;
  S.room = null;
  S.view = null;
  S.screenKey = '';
  viewKey = '';
  leaving = false;
  saveSession({ code, idx, name });
  connect(code);
  showHamburger();
  receive(room);
}

function goHome(message) {
  disconnect();
  clearSession();
  resetRoomState();
  hideHamburger();
  showScreen('screen-welcome');
  scaleTagline();
  if (message) toast(message, 3500);
}

export async function createRoom() {
  const name = $('host-name').value.trim();
  if (!name) return toast('Введи своё имя!');
  if (!S.selectedPlayers) return toast('Выбери число игроков!');
  if (!S.selectedRounds) return toast('Выбери число раундов!');

  await once('create', async () => {
    showScreen('screen-loading');
    try {
      const room = await api.create(name, deviceToken(), S.selectedRounds, S.selectedPlayers);
      enterRoom(room.code, 0, name, room);
    } catch (e) {
      say(e);
      showScreen('screen-create');
    }
  });
}

export async function joinRoom() {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name) return toast('Введи своё имя!');
  if (code.length !== 4) return toast('Введи 4-буквенный код!');

  await once('join', async () => {
    try {
      // Место выдаёт сервер под блокировкой: одновременные входы не сталкиваются
      const { idx, room } = await api.join(code, name, deviceToken());
      enterRoom(code, idx, name, room);
    } catch (e) {
      say(e);
      showScreen('screen-join');
    }
  });
}

export async function restoreSession() {
  const s = loadSession();
  if (!s) return false;
  showScreen('screen-loading');
  try {
    const view = await api.view(s.code, deviceToken());
    const room = await api.fetchRoom(s.code);
    const me = room?.players?.[view.idx];
    if (!room || room.phase === 'end' || !me || me.left || !inGame(room, view.idx)) throw new Error('gone');
    S.view = view;
    enterRoom(s.code, view.idx, s.name, room);
    toast(`С возвращением, ${s.name}!`, 2400);
    return true;
  } catch {
    clearSession();
    showScreen('screen-welcome');
    scaleTagline();
    return false;
  }
}

// ── Реакция на любое обновление комнаты ────────────────
// Своя рука и ситуации читающего подгружаются отдельно (mg_view),
// когда меняется шаг игры или игрок сделал ход.
let viewKey = '';
const viewKeyOf = room => `${room.currentRound}:${room.phase}:${room.submitted?.[S.myIdx] ? 1 : 0}`;
const needsView = room =>
  (room.phase === 'reader' && amReader()) || (room.phase === 'picking' && !amReader() && !room.submitted?.[S.myIdx]);

onRoom(async room => {
  if (leaving) return;
  const me = room.players?.[S.myIdx];
  if (me?.left) return goHome('Вы вышли из игры');
  if (room.phase !== 'lobby' && me && !inGame(room, S.myIdx)) return goHome('Игра уже началась без тебя 😕');

  const key = viewKeyOf(room);
  if (key !== viewKey && needsView(room) && !S.preview) {
    viewKey = key;
    try {
      S.view = await api.view(S.roomCode, deviceToken());
    } catch (e) {
      if (e.code === 'not_in_room' || e.code === 'room_not_found') return goHome(e.message);
      viewKey = '';   // сеть моргнула — попробуем на следующем обновлении
      return;
    }
    if (room !== S.room) return;   // пока ждали, пришло более новое состояние — его и покажем
  }
  render(room);
});

function render(room) {
  const round = room.currentRound || 1;
  const k = id => `${id}:${round}`;
  const isReader = amReader();
  const viewReady = S.view && S.view.round === round;

  switch (room.phase) {
    case 'lobby':
      V.renderLobby(room);
      if (activeScreen() !== 'screen-lobby') showScreen('screen-lobby');
      S.screenKey = 'lobby';
      break;
    case 'reader':
      if (isReader) {
        if (!viewReady) return;
        ensureScreen('screen-reader', k('reader'), () => V.renderReader(room));
      } else {
        ensureScreen('screen-waiting-sit', k('waiting-sit'), () => V.renderWaitingSit(room));
      }
      break;
    case 'picking':
      if (isReader) {
        ensureScreen('screen-reader-wait', k('reader-wait'), () => V.renderReaderWait(room), () => V.renderReaderWait(room));
      } else if (room.submitted?.[S.myIdx]) {
        ensureScreen('screen-waiting-others', k('waiting-others'), () => V.renderWaitingOthers(room), () => V.renderWaitingOthers(room));
      } else {
        if (!viewReady) return;
        ensureScreen('screen-pick', k('pick'), () => V.renderPick(room), () => V.updatePick(room));
      }
      break;
    case 'judging':
      if (isReader) ensureScreen('screen-judge', k('judge'), () => V.renderJudge(room, false));
      else ensureScreen('screen-waiting-judge', k('waiting-judge'), () => V.renderWaitingJudge(room));
      break;
    case 'result':
      ensureScreen('screen-result', k('result'), () => V.renderResult(room), V.updateResult);
      break;
    case 'end':
      ensureScreen('screen-end', 'end', () => { V.renderEnd(room); spawnConfetti(); });
      break;
    default:
      break;
  }
}

// ── Действия по ходу игры ──────────────────────────────
export async function startGame() {
  if (!amHost() || S.room?.phase !== 'lobby') return;
  const btn = $('lobby-start-btn');
  btn.disabled = true;
  await once('start', async () => {
    try { await act(api.start); } catch (e) { say(e); btn.disabled = false; }
  });
}

export function readerTap(el) {
  const half = Number(el.dataset.half);
  const upsideDown = (half === 1 && !S.flipped) || (half === 0 && S.flipped);
  if (upsideDown) return V.flipReaderCard();   // сначала развернуть, потом выбирать
  readerChoose(half);
}

async function readerChoose(half) {
  if (S.room?.phase !== 'reader' || !amReader() || !S.shownSits) return;
  V.markReaderChoice(half);
  await once('choose', async () => {
    try { await act((code, token) => api.choose(code, token, half)); }
    catch (e) { say(e); S.screenKey = ''; render(S.room); }
  });
}

// Мем сначала открывается целиком — выбрать вслепую по мелкой превьюшке нельзя
export function openHandCard(el) {
  const i = Number(el.dataset.index);
  const m = S.view?.hand?.[i];
  if (!m) return;
  openMeme(m, { label: '✅ Выбрать этот мем', fn: () => selectCard(i) }, 'Выбери — потом нажми «Отправить мем»');
}

function selectCard(i) {
  S.selectedHand = i;
  V.markHandSelection(i);
  const btn = $('submit-btn');
  btn.disabled = false;
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function submitMeme() {
  const i = S.selectedHand;
  const room = S.room;
  if (i == null || room?.phase !== 'picking' || room.submitted?.[S.myIdx]) return;
  const btn = $('submit-btn');
  btn.disabled = true;
  await once('submit', async () => {
    try { await act((code, token) => api.play(code, token, i)); }
    catch (e) { say(e); btn.disabled = false; }
  });
}

export function revealCards() {
  if (S.room?.phase === 'judging') V.renderJudge(S.room, true);
}

export function openTableCard(el) {
  const i = Number(el.dataset.index);
  const tc = S.judgeCards[i];
  if (!tc) return;
  openMeme(tc, { label: '🏆 Выбрать этот мем', fn: () => judgeSelect(i) }, 'Автор пока скрыт');
}

function judgeSelect(i) {
  S.judgeSelected = i;
  V.markJudgeSelection(i);
  const btn = $('judge-confirm-btn');
  btn.disabled = false;
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export async function judgeConfirm() {
  const pos = S.judgeSelected;
  if (pos == null || S.room?.phase !== 'judging' || !amReader()) return;
  const btn = $('judge-confirm-btn');
  btn.disabled = true;
  await once('judge', async () => {
    try { await act((code, token) => api.judge(code, token, pos)); }
    catch (e) { say(e); btn.disabled = false; }
  });
}

export function openWinnerCard() {
  const room = S.room;
  const tc = (room?.tableCards || []).find(c => c.playerIdx === room.winnerIdx);
  openMeme(tc, null, 'Победитель раунда 🏆');
}

export function openResultCard(el) {
  const room = S.room;
  const tc = (room?.tableCards || [])[Number(el.dataset.index)];
  if (!tc) return;
  const who = room.players?.[tc.playerIdx]?.name || '?';
  openMeme(tc, null, tc.playerIdx === room.winnerIdx ? `${who} — победитель раунда 🏆` : who);
}

export async function nextRound() {
  if (!amHost() || S.room?.phase !== 'result') return;
  const btn = $('next-round-btn');
  btn.disabled = true;
  await once('next', async () => {
    try {
      const room = await act(api.next);
      if (room?.endReason === 'cards') toast('Мемы закончились — игра окончена!', 4000);
    } catch (e) { say(e); }
    finally { btn.disabled = false; }
  });
}

export function showScores() {
  if (!S.room) return;
  V.renderScores(S.room);
  openModal('modal-scores');
}

export async function leaveGame() {
  if (!confirm('Выйти из игры?')) return;
  closeMenu();
  const room = S.room;
  leaving = true;
  if (room && room.phase !== 'end' && !S.preview) {
    try { await api.leave(S.roomCode, deviceToken()); } catch { /* уйдём в любом случае */ }
  }
  goHome('Вы вышли из игры');
}

export function exitToHome() { goHome(); }

// ── Лобби: поделиться кодом ────────────────────────────
export function copyCode() {
  navigator.clipboard.writeText(S.roomCode).then(() => toast('Код скопирован! 📋')).catch(() => toast(S.roomCode));
}

export function shareRoom() {
  const url = location.href.split('?')[0];
  const text = `Присоединяйся к игре Memology!\nКод комнаты: ${S.roomCode}\nОткрой: ${url}`;
  const copy = () => navigator.clipboard.writeText(text)
    .then(() => toast('Приглашение скопировано! 📋')).catch(() => toast(text, 5000));
  if (navigator.share) navigator.share({ title: 'Memology', text, url }).catch(copy);
  else copy();
}

// ── Форма создания ─────────────────────────────────────
export function selectPlayers(el) { pickNum(el, '.players-grid'); S.selectedPlayers = Number(el.dataset.value); }
export function selectRounds(el) { pickNum(el, '.rounds-grid'); S.selectedRounds = Number(el.dataset.value); }
function pickNum(el, grid) {
  document.querySelectorAll(`${grid} .num-btn`).forEach(b => b.classList.toggle('selected', b === el));
}

// ── Предложения ────────────────────────────────────────
let suggestType = '';
const SUGGEST = {
  situation: ['📋 Предложить ситуацию', 'Опиши ситуацию для карточки...'],
  meme: ['🖼️ Предложить мем', 'Ссылка на мем или описание...'],
  other: ['✏️ Другое', 'Напиши своё предложение...'],
};
export function openSuggest() {
  closeMenu();
  $('suggest-step1').hidden = false;
  $('suggest-step2').hidden = true;
  $('suggest-text').value = '';
  openModal('modal-suggest');
}
export function suggestForm(el) {
  suggestType = el.dataset.type;
  const [label, ph] = SUGGEST[suggestType];
  $('suggest-form-label').textContent = label;
  $('suggest-text').placeholder = ph;
  $('suggest-step1').hidden = true;
  $('suggest-step2').hidden = false;
}
export function suggestBack() { $('suggest-step1').hidden = false; $('suggest-step2').hidden = true; }
export async function submitSuggest() {
  const text = $('suggest-text').value.trim();
  if (!text) return toast('Напиши что-нибудь!');
  try {
    await api.sendSuggestion({ type: suggestType, text, player: S.myName, room: S.roomCode });
    closeModal('modal-suggest');
    toast('Предложение отправлено! 💡');
  } catch (e) {
    toast('Не получилось отправить — попробуй ещё раз', 3500);
  }
}
