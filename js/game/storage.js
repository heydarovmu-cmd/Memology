// localStorage: сессия (вернуться в игру после обновления страницы)
// и секрет устройства, по которому сервер узнаёт игрока.
// Любой доступ обёрнут в try: в приватном режиме хранилище может бросать.

import { GAME } from '../config.js';
import { randomId } from './random.js';

const KEYS = { session: 'mg_session', token: 'mg_cid' };

const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* нет места или запрещено */ } };
const remove = key => { try { localStorage.removeItem(key); } catch { /* ничего */ } };

// Секрет устройства. Сервер выдаёт по нему только карты этого игрока,
// поэтому он никуда не публикуется.
let tokenCache = null;
export function deviceToken() {
  if (tokenCache) return tokenCache;
  let t = read(KEYS.token);
  if (typeof t !== 'string' || t.length < 16) { t = randomId(24); write(KEYS.token, t); }
  return (tokenCache = t);
}

export function saveSession({ code, idx, name }) {
  if (!code || idx < 0) return;
  write(KEYS.session, { code, idx, name, at: Date.now() });
}

export function loadSession() {
  const s = read(KEYS.session);
  if (!s || !s.code) return null;
  if (Date.now() - (s.at || 0) > GAME.sessionTtlMs) { remove(KEYS.session); return null; }
  return s;
}

export const clearSession = () => remove(KEYS.session);

// Кэш каталога от прошлой версии игры больше не нужен
remove('mg_content');
