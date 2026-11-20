// Всё общение с Supabase. Остальной код игры не знает, как устроен сервер.
//
// Ходы делают функции mg_* в базе (supabase/setup.sql): раздача, колода,
// чужие руки и авторы мемов до голосования хранятся только на сервере.
// Игра видит открытое состояние комнаты (rooms.data) и свою руку (mg_view).

import { SUPABASE } from '../config.js';

let client = null;
const sb = () => (client ||= window.supabase.createClient(SUPABASE.url, SUPABASE.anonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
  // Игра работает анонимно. Вход админа живёт отдельно (js/admin/auth.js)
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
}));

// Ошибки сервера → понятный текст
const MESSAGES = {
  room_not_found: 'Комната не найдена 😕',
  room_outdated: 'Эта комната из старой версии игры — создайте новую',
  game_started: 'Игра уже идёт!',
  room_full: 'Комната заполнена',
  not_in_room: 'Тебя нет в этой комнате',
  not_host: 'Это может только хост',
  not_reader: 'Это может только читающий',
  few_players: 'Нужно минимум 3 игрока',
  few_situations: 'В базе меньше двух ситуаций',
  bad_name: 'Введи имя (до 20 символов)',
  bad_rounds: 'Выбери число раундов',
  already_played: 'Мем уже отправлен',
  wrong_phase: 'Игра уже ушла дальше',
};

export class ServerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(error) {
  const raw = String(error?.message || error || '');
  const [code, ...rest] = raw.split(':');
  if (code === 'few_memes') {
    throw new ServerError(code, `Нужно минимум ${rest[0]} мемов на всех игроков, в базе ${rest[1]}`);
  }
  if (MESSAGES[code]) throw new ServerError(code, MESSAGES[code]);
  if (/Could not find the function|does not exist/i.test(raw)) {
    throw new ServerError('outdated_db', 'Игра обновляется: админу нужно выполнить SQL в админке');
  }
  throw new ServerError('network', 'Ошибка сети: ' + raw);
}

async function rpc(name, args) {
  let res;
  try { res = await sb().rpc(name, args); } catch (e) { fail(e); }
  if (res.error) fail(res.error);
  return res.data;
}

export function imageUrl(m) {
  const u = m?.image_url || '';
  if (!u || /^(https?:|data:)/.test(u)) return u;
  return `${SUPABASE.url}/storage/v1/object/public/${SUPABASE.memesBucket}/${u}`;
}

// Реальная реализация. Режим предпросмотра подменяет её заглушкой.
const live = {
  async sendSuggestion(row) {
    const r = await fetch(`${SUPABASE.url}/rest/v1/suggestions`, {
      method: 'POST',
      headers: { apikey: SUPABASE.anonKey, Authorization: `Bearer ${SUPABASE.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
  },

  async fetchRoom(code) {
    const { data, error } = await sb().from('rooms').select('data').eq('code', code).maybeSingle();
    if (error) fail(error);
    return data ? data.data : null;
  },

  create: (name, token, rounds, maxPlayers) =>
    rpc('mg_create', { p_name: name, p_token: token, p_rounds: rounds, p_max: maxPlayers }),
  join: (code, name, token) => rpc('mg_join', { p_code: code, p_name: name, p_token: token }),
  view: (code, token) => rpc('mg_view', { p_code: code, p_token: token }),
  start: (code, token) => rpc('mg_start', { p_code: code, p_token: token }),
  choose: (code, token, half) => rpc('mg_choose', { p_code: code, p_token: token, p_half: half }),
  play: (code, token, index) => rpc('mg_play', { p_code: code, p_token: token, p_index: index }),
  judge: (code, token, pos) => rpc('mg_judge', { p_code: code, p_token: token, p_pos: pos }),
  next: (code, token) => rpc('mg_next', { p_code: code, p_token: token }),
  leave: (code, token) => rpc('mg_leave', { p_code: code, p_token: token }),

  subscribe(code, onRoom) {
    const ch = sb()
      .channel('room:' + code)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'code=eq.' + code },
        payload => onRoom(payload.new && payload.new.data))
      .subscribe();
    return () => sb().removeChannel(ch);
  },
};

export const api = { ...live };

export function useBackend(impl) { Object.assign(api, impl); }
