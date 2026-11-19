// Ход игры: действия игрока, реакция на обновления комнаты и обязанности хоста.
import { $, toast } from '../shared/dom.js';
import { ADMIN_PIN, GAME } from '../config.js';
import { api } from './api.js';
import { roomCode, randomId } from './random.js';
import * as R from './rules.js';
import { S, amHost, amReader, once, resetRoomState } from './state.js';
import { clientId, saveSession, loadSession, clearSession, cacheContent, cachedContent } from './storage.js';
import { connect, disconnect, receive, onRoom } from './sync.js';
import {
  showScreen, ensureScreen, activeScreen, openModal, closeModal, showHamburger, hideHamburger,
  closeMenu, openMeme, spawnConfetti, scaleTagline,
} from './ui.js';
import * as V from './screens.js';

const netError = e => toast('Ошибка сети: ' + e.message, 3500);

// Записать изменение и сразу применить ответ сервера
async function patch(p) {
  const room = await api.patchRoom(S.roomCode, p);
  receive(room);
  return room;
}

// ── Контент ────────────────────────────────────────────
async function loadContent() {
  if (S.memes.length && S.situations.length) return true;   // уже загружено в этой вкладке
  showScreen('screen-loading');
  try {
    const c = await api.loadContent();
    if (!c.memes.length) throw new Error('Нет мемов в базе данных');
    if (c.situations.length < 2) throw new Error('Нужно минимум 2 ситуации');
    S.memes = c.memes;
    S.situations = c.situations;
    cacheContent(c);
    return true;
  } catch (e) {
    const c = cachedContent();
    if (c) {
      S.memes = c.memes;
      S.situations = c.situations;
      toast('Нет связи с базой — играем на сохранённом контенте', 3500);
      return true;
    }
    toast(`Ошибка загрузки: ${e.message}`, 4000);
    return false;
  }
}

// ── Вход в комнату ─────────────────────────────────────
function enterRoom(code, idx, name, room) {
  S.roomCode = code;
  S.myIdx = idx;
  S.myName = name;
  S.room = null;
  S.screenKey = '';
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
    if (!await loadContent()) { showScreen('screen-create'); return; }
    try {
      // Код не должен совпасть с чужой живой комнатой (старые сервер удаляет сам)
      let code = roomCode();
      for (let i = 0; i < 10 && await api.fetchRoom(code); i++) code = roomCode();
      const room = R.newRoom({
        code, seed: randomId(), hostName: name, cid: clientId(),
        rounds: S.selectedRounds, maxPlayers: S.selectedPlayers,
      });
      await api.createRoom(code, room);
      enterRoom(code, 0, name, room);
    } catch (e) {
      netError(e);
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
      const room = await api.fetchRoom(code);
      if (!room) return toast('Комната не найдена 😕', 3000);
      if (room.phase !== 'lobby') return toast('Игра уже идёт!', 3000);
      const max = room.maxPlayers || GAME.maxSeats;
      if (R.seats(room).filter(p => !p.left).length >= max) return toast(`Комната заполнена (${max}/${max})`, 3000);

      if (!await loadContent()) { showScreen('screen-join'); return; }
      // Пока грузился контент, в комнату могли войти другие или игра началась
      const fresh = await api.fetchRoom(code);
      if (!fresh || fresh.phase !== 'lobby') { showScreen('screen-join'); return toast('Игра уже идёт!', 3000); }
      const result = await claimSeat(code, fresh, name);
      if (!result) { showScreen('screen-join'); return; }
      enterRoom(code, result.idx, name, result.room);
    } catch (e) {
      netError(e);
      showScreen('screen-join');
    }
  });
}

// Занять свободное место. Игра могла начаться, пока грузился контент, —
// тогда место сразу освобождается.
async function claimSeat(code, room, name) {
  const idx = R.freeSeat(room);
  if (idx < 0) { toast('Комната заполнена', 3000); return null; }
  const after = await api.patchRoom(code, R.joinPatch(room, idx, { name, cid: clientId() }));
  if (after.phase !== 'lobby') {
    await api.patchRoom(code, { [`players/${idx}`]: { idx, name, left: true } }).catch(() => {});
    toast('Игра уже идёт!', 3000);
    return null;
  }
  return { idx, room: after };
}

// Двое заняли одно место одновременно: проигравший переезжает на свободное.
// В лобби места дешёвые — проверяем свежую комнату, а не возможно старое событие.
async function fixSeat() {
  await once('seat', async () => {
    const room = await api.fetchRoom(S.roomCode).catch(() => null);
    if (!room || room.phase !== 'lobby') return;
    const mine = room.players?.[S.myIdx];
    if (mine && !mine.left && mine.cid === clientId()) return;
    const max = room.maxPlayers || GAME.maxSeats;
    if (R.seats(room).filter(p => !p.left).length >= max) {
      return goHome('Комната заполнена — место заняли раньше');
    }
    const r = await claimSeat(S.roomCode, room, S.myName);
    if (!r) return goHome();
    S.myIdx = r.idx;
    saveSession({ code: S.roomCode, idx: r.idx, name: S.myName });
    receive(r.room);
  });
}

export async function restoreSession() {
  const s = loadSession();
  if (!s) return false;
  showScreen('screen-loading');
  const room = await api.fetchRoom(s.code).catch(() => null);
  const seat = room?.players?.[s.idx];
  const mine = seat && !seat.left && (!seat.cid || seat.cid === clientId()) && R.inGame(room, s.idx);
  if (!mine || room.phase === 'end') { clearSession(); showScreen('screen-welcome'); scaleTagline(); return false; }
  if (!await loadContent()) { showScreen('screen-welcome'); return false; }
  enterRoom(s.code, s.idx, s.name, room);
  toast(`С возвращением, ${s.name}!`, 2400);
  return true;
}

// ── Реакция на любое обновление комнаты ────────────────
onRoom(room => {
  const me = room.players?.[S.myIdx];
  const myCid = clientId();

  if (room.phase === 'lobby') {
    if (me && !me.left && me.cid && me.cid !== myCid) fixSeat();
    const present = R.seats(room).filter(p => !p.left);
    const max = room.maxPlayers || GAME.maxSeats;
    if (present.length > max && present.findIndex(p => p.idx === S.myIdx) >= max) {
      api.patchRoom(S.roomCode, R.leavePatch(room, S.myIdx)).catch(() => {});
      return goHome('Комната заполнена — место заняли раньше');
    }
  } else if (me && !me.left && !R.inGame(room, S.myIdx)) {
    // Вошёл в последний момент — игра стартовала без него
    api.patchRoom(S.roomCode, { [`players/${S.myIdx}`]: { ...me, left: true } }).catch(() => {});
    return goHome('Игра уже началась без тебя 😕');
  } else if (me && me.cid && me.cid !== myCid) {
    return goHome('Это место занял другой игрок');
  }

  render(room);
  hostDuties(room);
});

function render(room) {
  const round = room.currentRound || 1;
  const k = id => `${id}:${round}`;
  const isReader = amReader();

  switch (room.phase) {
    case 'lobby':
      V.renderLobby(room);
      if (activeScreen() !== 'screen-lobby') showScreen('screen-lobby');
      S.screenKey = 'lobby';
      break;
    case 'reader':
      if (isReader) {
        const sitsChanged = JSON.stringify(S.shownSits) !== JSON.stringify(room.readerSits);
        if (sitsChanged) S.screenKey = '';
        ensureScreen('screen-reader', k('reader'), () => V.renderReader(room));
      } else {
        ensureScreen('screen-waiting-sit', k('waiting-sit'), () => V.renderWaitingSit(room));
      }
      break;
    case 'picking':
      if (isReader) {
        ensureScreen('screen-reader-wait', k('reader-wait'), () => V.renderReaderWait(room), () => V.renderReaderWait(room));
      } else if (room.submissions?.[S.myIdx]) {
        ensureScreen('screen-waiting-others', k('waiting-others'), () => V.renderWaitingOthers(room), () => V.renderWaitingOthers(room));
      } else {
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

// ── Обязанности хоста ──────────────────────────────────
// Хост переводит игру дальше, когда все сдали мемы, пропускает раунд,
// если ушёл читающий, и заканчивает игру, если игроков стало мало.
// Читающий страхует переход к голосованию: он результат ждёт активнее всех.
function hostDuties(room) {
  if (S.preview) return;
  let duty = null;
  if (amHost()) duty = R.hostDuty(room, S.situations);
  else if (amReader() && R.readyForJudging(room)) duty = { why: 'judging', patch: R.judgingPatch(room) };
  if (!duty) return;
  const key = `duty:${duty.why}:${room.currentRound}:${room.phase}`;
  once(key, async () => {
    try {
      await patch(duty.patch);
      if (duty.why === 'reader-left') toast('Читающий вышел — раунд пропущен', 3000);
      if (duty.why === 'few') toast('Игроков меньше трёх — игра окончена', 3500);
    } catch (e) { netError(e); }
  });
}

// ── Действия по ходу игры ──────────────────────────────
export async function startGame() {
  if (!amHost() || S.room?.phase !== 'lobby') return;
  const btn = $('lobby-start-btn');
  btn.disabled = true;
  await once('start', async () => {
    try {
      // Раздаём карты по свежему списку: экран хоста мог не успеть показать
      // только что вошедших — они остались бы без руки
      const fresh = await api.fetchRoom(S.roomCode);
      if (!fresh || fresh.phase !== 'lobby') return;
      await patch(R.startPatch(fresh, S.memes, S.situations));
    } catch (e) {
      if (e instanceof R.GameError) toast(e.message, 5000); else netError(e);
      btn.disabled = false;
    }
  });
}

export function readerTap(el) {
  const half = Number(el.dataset.half);
  const upsideDown = (half === 1 && !S.flipped) || (half === 0 && S.flipped);
  if (upsideDown) return V.flipReaderCard();   // сначала развернуть, потом выбирать
  readerChoose(half);
}

async function readerChoose(half) {
  const room = S.room;
  if (room?.phase !== 'reader' || !amReader() || !S.shownSits) return;
  const sit = S.shownSits[half];
  V.markReaderChoice(half);
  await once('choose', async () => {
    try { await patch(R.choosePatch(sit)); } catch (e) { netError(e); S.screenKey = ''; render(S.room); }
  });
}

// Мем сначала открывается целиком — выбрать вслепую по мелкой превьюшке нельзя
export function openHandCard(el) {
  const i = Number(el.dataset.index);
  const m = S.room?.hands?.[S.myIdx]?.[i];
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
  if (i == null || room?.phase !== 'picking' || room.submissions?.[S.myIdx]) return;
  const btn = $('submit-btn');
  btn.disabled = true;
  await once('submit', async () => {
    try {
      receive(await api.playCard(S.roomCode, S.myIdx, i));
    } catch (e) {
      netError(e);
      btn.disabled = false;
    }
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
  const card = S.judgeCards[S.judgeSelected];
  if (!card || S.room?.phase !== 'judging' || !amReader()) return;
  const btn = $('judge-confirm-btn');
  btn.disabled = true;
  await once('judge', async () => {
    try { await patch(R.judgePatch(S.room, card.playerIdx)); }
    catch (e) { netError(e); btn.disabled = false; }
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
      const p = R.nextRoundPatch(S.room, S.situations);
      if (p.endReason === 'cards') toast('Мемы закончились — игра окончена!', 4000);
      await patch(p);
    } catch (e) { netError(e); }
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
  if (room && room.phase !== 'end' && !S.preview) {
    try { await api.patchRoom(S.roomCode, R.leavePatch(room, S.myIdx)); } catch { /* уйдём в любом случае */ }
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

// ── PIN администратора ─────────────────────────────────
let pin = '';
const pinDots = () => { for (let i = 0; i < 4; i++) $('pin-d' + i).classList.toggle('on', i < pin.length); };
export function adminEntry() { pin = ''; pinDots(); $('pin-error').textContent = ''; showScreen('screen-admin-pin'); }
export function pinPress(el) {
  if (pin.length >= 4) return;
  pin += el.dataset.digit;
  pinDots();
  if (pin.length === 4) setTimeout(checkPin, 200);
}
export function pinBack() { pin = pin.slice(0, -1); pinDots(); }
export function pinClear() { pin = ''; pinDots(); }
function checkPin() {
  if (pin === ADMIN_PIN) showScreen('screen-create');
  else { $('pin-error').textContent = 'Неверный PIN'; pin = ''; pinDots(); }
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
