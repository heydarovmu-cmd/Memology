// Связь с комнатой: realtime-подписка + страховочный опрос.
// Все версии комнаты — и из realtime, и из ответов на свои ходы —
// проходят через receive(): устаревшие и повторные отбрасываются.

import { GAME } from '../config.js';
import { api } from './api.js';
import { isOlder } from './rules.js';
import { S } from './state.js';

let stop = null;
let lastJson = '';
let listener = () => {};

export function onRoom(fn) { listener = fn; }

export function connect(code) {
  disconnect();
  const unsubscribe = api.subscribe(code, receive);
  const timer = setInterval(refresh, GAME.pollMs);
  stop = () => { unsubscribe(); clearInterval(timer); };
}

export function disconnect() {
  if (stop) stop();
  stop = null;
  lastJson = '';
}

export async function refresh() {
  const code = S.roomCode;
  if (!code || S.preview) return;
  try { receive(await api.fetchRoom(code)); } catch { /* сеть моргнула — следующий опрос повторит */ }
}

export function receive(room) {
  if (!room || typeof room !== 'object') return;
  if (room.code && room.code !== S.roomCode) return;          // ответ из прошлой комнаты
  if (S.room && S.room.code === room.code && isOlder(room, S.room)) return;  // устаревший ответ
  const json = JSON.stringify(room);
  if (json === lastJson) return;
  lastJson = json;
  S.room = room;
  listener(room);
}

// Проснувшийся планшет сразу подтягивает состояние, не дожидаясь опроса
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
