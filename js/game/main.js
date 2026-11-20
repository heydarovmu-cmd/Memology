// Точка входа игры: связывает кнопки разметки (data-action) с действиями.
import { $, bindActions, softenBrokenImages } from '../shared/dom.js';
import { ADMIN_FLAG } from '../config.js';
import * as C from './controller.js';
import { showScreen, scaleTagline, openModal, closeModal, toggleMenu, closeMenu, closeLb, lbGo } from './ui.js';
import { startPreview, pvBar, pvShow } from './preview.js';

const outside = fn => (el, e) => { if (e.target === el) fn(el); };

bindActions({
  // навигация и окна
  show: el => { showScreen(el.dataset.screen); if (el.dataset.screen === 'screen-welcome') scaleTagline(); },
  openModal: el => openModal(el.dataset.modal),
  closeModal: el => closeModal(el.dataset.modal),
  closeModalOutside: outside(el => closeModal(el.id)),
  toggleMenu, closeMenu,
  closeLb, lbGo,
  closeLbOutside: outside(closeLb),

  // создание и вход
  selectPlayers: C.selectPlayers,
  selectRounds: C.selectRounds,
  createRoom: C.createRoom,
  joinRoom: C.joinRoom,

  // лобби
  copyCode: C.copyCode,
  shareRoom: C.shareRoom,
  startGame: C.startGame,

  // раунд
  readerTap: C.readerTap,
  openHandCard: C.openHandCard,
  submitMeme: C.submitMeme,
  revealCards: C.revealCards,
  openTableCard: C.openTableCard,
  judgeConfirm: C.judgeConfirm,
  openWinnerCard: C.openWinnerCard,
  openResultCard: C.openResultCard,
  nextRound: C.nextRound,
  showScores: C.showScores,
  exitToHome: C.exitToHome,

  // меню
  openSuggest: C.openSuggest,
  suggestForm: C.suggestForm,
  suggestBack: C.suggestBack,
  submitSuggest: C.submitSuggest,
  leaveGame: C.leaveGame,

  // предпросмотр
  pvBar: el => pvBar(el.dataset.open === '1'),
  pvShow: el => pvShow(Number(el.dataset.index)),
});

softenBrokenImages('img.meme-img');
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLb(); });
window.addEventListener('resize', scaleTagline);

// Enter в полях формы — как нажатие главной кнопки
document.getElementById('host-name').addEventListener('keydown', e => { if (e.key === 'Enter') C.createRoom(); });
document.getElementById('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') C.joinRoom(); });

// Шестерёнка видна только на устройстве, где вошёл админ
try { $('admin-gear').hidden = localStorage.getItem(ADMIN_FLAG) !== '1'; } catch { /* приватный режим */ }

scaleTagline();
document.fonts?.ready.then(scaleTagline);
window.addEventListener('load', scaleTagline);
if (new URLSearchParams(location.search).has('preview')) startPreview();
else C.restoreSession();
