// Режим предпросмотра (memology.html?preview): любой экран с готовыми
// данными. В базу ничего не пишется — сетевой слой заменён заглушкой.
import { $, toast } from '../shared/dom.js';
import { useBackend } from './api.js';
import { S } from './state.js';
import { showScreen, hideHamburger } from './ui.js';
import * as V from './screens.js';

function pvMeme(i) {
  const colors = ['1a1a20', '2a0e5a', '071c2a', '3a1a0a', '0d220d', '2a1a3a'];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
    <rect width="300" height="200" fill="#${colors[i % colors.length]}"/>
    <text x="150" y="105" font-family="sans-serif" font-size="56" fill="#ffffff55"
      text-anchor="middle">мем ${i + 1}</text></svg>`;
  return {
    id: 900 + i,
    title: ['Кот в шоке', 'Ну такое', 'Батя одобряет', 'Это фиаско', 'Сойдёт', 'Момент истины'][i % 6],
    image_url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
  };
}

function pvRoom() {
  const names = ['Агшин', 'Рустам', 'Лейла', 'Камиль', 'Нигяр'];
  const players = {}, hands = {};
  names.forEach((name, i) => {
    players[i] = { name, score: [3, 1, 2, 0, 1][i], idx: i };
    hands[i] = [0, 1, 2, 3, 4].map(pvMeme);
  });
  return {
    code: 'DEMO', hostName: names[0], hostIdx: 0, rounds: 15, maxPlayers: 5,
    phase: 'picking', playerCount: names.length,
    currentRound: 4, readerIdx: 2,
    situation: 'Когда наступил на лего',
    readerSits: ['Когда наступил на лего', 'Когда зашёл в туалет после бати'],
    submissions: { 0: pvMeme(0), 1: pvMeme(1), 4: pvMeme(4) },
    hands, deck: [5, 6, 7, 8, 9, 10, 11].map(pvMeme), discard: [pvMeme(0)],
    tableCards: [{ playerIdx: 0, ...pvMeme(0) }, { playerIdx: 1, ...pvMeme(1) }, { playerIdx: 4, ...pvMeme(4) }],
    winnerIdx: 1, players, usedSituations: [],
  };
}

// [подпись, экран, idx игрока, отрисовка]
const SCREENS = [
  ['Главная', 'screen-welcome'],
  ['Создание', 'screen-create'],
  ['Вход', 'screen-join'],
  ['Лобби (хост)', 'screen-lobby', 0, r => V.renderLobby({ ...r, phase: 'lobby' })],
  ['Лобби (гость)', 'screen-lobby', 3, r => V.renderLobby({ ...r, phase: 'lobby' })],
  ['Загрузка', 'screen-loading'],
  ['Читающий', 'screen-reader', 2, V.renderReader],
  ['Ждём ситуацию', 'screen-waiting-sit', 0, V.renderWaitingSit],
  ['Выбор мема', 'screen-pick', 0, V.renderPick],
  ['Мем отправлен', 'screen-waiting-others', 0, V.renderWaitingOthers],
  ['Читающий ждёт', 'screen-reader-wait', 2, V.renderReaderWait],
  ['Карты рубашкой', 'screen-judge', 2, r => V.renderJudge(r, false)],
  ['Карты открыты', 'screen-judge', 2, r => V.renderJudge(r, true)],
  ['Ждём судью', 'screen-waiting-judge', 0, V.renderWaitingJudge],
  ['Итог раунда', 'screen-result', 0, V.renderResult],
  ['Финал', 'screen-end', 0, r => V.renderEnd({ ...r, phase: 'end' })],
];

export function startPreview() {
  S.preview = true;
  const noop = async () => null;
  useBackend({
    loadContent: async () => ({ memes: [0, 1, 2, 3, 4, 5].map(pvMeme), situations: ['Ситуация раз', 'Ситуация два'] }),
    sendSuggestion: noop, fetchRoom: noop, createRoom: noop, patchRoom: noop, playCard: noop,
    subscribe: () => () => {},
  });
  S.myName = 'Агшин';
  S.roomCode = 'DEMO';
  $('pv-scroll').innerHTML = SCREENS
    .map(([label], i) => `<button class="pv-btn" data-action="pvShow" data-index="${i}">${label}</button>`).join('');
  pvBar(true);
  pvShow(0);
  toast('Режим предпросмотра', 2200);
}

export function pvBar(open) {
  $('pv-bar').classList.toggle('on', open);
  $('pv-open').classList.toggle('on', !open);
  document.body.style.paddingBottom = open ? '104px' : '';
}

export function pvShow(i) {
  if (!S.preview) return;
  const [, screen, idx = 0, render] = SCREENS[i];
  const room = pvRoom();
  S.room = room;
  S.myIdx = idx;
  document.querySelectorAll('.pv-btn').forEach((b, n) => b.classList.toggle('act', n === i));
  if (render) render(room);
  showScreen(screen);
  if (['screen-welcome', 'screen-create', 'screen-join'].includes(screen)) hideHamburger();
  window.scrollTo(0, 0);
}
