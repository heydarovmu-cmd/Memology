// Локальное состояние этого устройства. Общая правда — S.room с сервера,
// своя рука — S.view (только этот игрок её и получает).
import { hostIdx } from './rules.js';

export const S = {
  myName: '',
  myIdx: -1,
  roomCode: '',
  room: null,
  view: null,          // { idx, round, hand, played, sits } из mg_view

  // форма создания
  selectedPlayers: 0,
  selectedRounds: 5,

  // что показано на экране сейчас (действия берут данные отсюда,
  // чтобы игрок выбрал ровно то, что видел)
  screenKey: '',
  shownSits: null,
  flipped: false,
  selectedHand: null,
  judgeCards: [],
  judgeSelected: null,
  judgeRevealed: false,

  preview: false,
};

export const amHost = () => !!S.room && hostIdx(S.room) === S.myIdx;
export const amReader = () => !!S.room && S.room.readerIdx === S.myIdx;

export function resetRoomState() {
  Object.assign(S, {
    roomCode: '', room: null, view: null, myIdx: -1, screenKey: '',
    shownSits: null, flipped: false, selectedHand: null,
    judgeCards: [], judgeSelected: null, judgeRevealed: false,
  });
}

// Защита от двойных нажатий и повторных запусков одного и того же шага
const running = new Set();
export async function once(key, fn) {
  if (running.has(key)) return undefined;
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
}
