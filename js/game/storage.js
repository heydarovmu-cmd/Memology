// localStorage: сессия (вернуться в игру после обновления страницы),
// кэш контента (играть, если база недоступна) и id устройства.
// Любой доступ обёрнут в try: в приватном режиме хранилище может бросать.

import { GAME } from '../config.js';
import { randomId } from './random.js';

const KEYS = { session: 'mg_session', content: 'mg_content', cid: 'mg_cid' };

const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const write = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* нет места или запрещено */ } };
const remove = key => { try { localStorage.removeItem(key); } catch { /* ничего */ } };

// Id устройства: по нему игрок узнаёт «своё» место за столом
let cidCache = null;
export function clientId() {
  if (cidCache) return cidCache;
  let cid = read(KEYS.cid);
  if (typeof cid !== 'string' || !cid) { cid = randomId(); write(KEYS.cid, cid); }
  return (cidCache = cid);
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

export function cacheContent(content) { write(KEYS.content, content); }

export function cachedContent() {
  const c = read(KEYS.content);
  return c?.memes?.length && c?.situations?.length >= 2 ? c : null;
}
