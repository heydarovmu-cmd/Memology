// Всё общение с Supabase. Остальной код игры не знает, как устроен сервер.
//
// Серверная часть (таблица rooms и функции patch_room, play_card) живёт
// в Supabase; её контракт описан в README.md.

import { SUPABASE } from '../config.js';

let client = null;
const sb = () => (client ||= window.supabase.createClient(SUPABASE.url, SUPABASE.anonKey, {
  realtime: { params: { eventsPerSecond: 10 } },
}));

async function rest(path, opts = {}) {
  const r = await fetch(`${SUPABASE.url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE.anonKey,
      Authorization: `Bearer ${SUPABASE.anonKey}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

const fail = error => { throw new Error(error.message || String(error)); };

export function imageUrl(m) {
  const u = m?.image_url || '';
  if (!u || /^(https?:|data:)/.test(u)) return u;
  return `${SUPABASE.url}/storage/v1/object/public/${SUPABASE.memesBucket}/${u}`;
}

// Реальная реализация. Режим предпросмотра подменяет её заглушкой.
const live = {
  async loadContent() {
    const [memes, situations] = await Promise.all([
      rest('memes?select=id,title,image_url&active=eq.true&order=id'),
      rest('situations?select=id,text&active=eq.true&order=id'),
    ]);
    return {
      memes: memes.filter(m => m.image_url).map(m => ({ ...m, image_url: imageUrl(m) })),
      situations: situations.map(s => s.text).filter(Boolean),
    };
  },

  async sendSuggestion(row) {
    await rest('suggestions', { method: 'POST', body: JSON.stringify(row) });
  },

  async fetchRoom(code) {
    const { data, error } = await sb().from('rooms').select('data').eq('code', code).maybeSingle();
    if (error) fail(error);
    return data ? data.data : null;
  },

  async createRoom(code, data) {
    const { error } = await sb().from('rooms').upsert({ code, data });
    if (error) fail(error);
    return data;
  },

  // Точечное изменение: merge делается на сервере под блокировкой строки,
  // поэтому одновременные ходы игроков не затирают друг друга
  async patchRoom(code, patch) {
    const { data, error } = await sb().rpc('patch_room', { p_code: code, p_paths: patch });
    if (error) fail(error);
    return data;
  },

  // Карта уходит из руки на стол, из колоды приходит замена — атомарно на сервере
  async playCard(code, playerIdx, index) {
    const { data, error } = await sb().rpc('play_card', { p_code: code, p_player: String(playerIdx), p_index: index });
    if (error) fail(error);
    return data;
  },

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
