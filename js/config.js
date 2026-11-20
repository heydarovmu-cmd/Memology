// Общие настройки игры и админки.
// Ключ — публичный (anon/publishable): он и так виден в браузере любого игрока.

export const SUPABASE = {
  url: 'https://dcxamyfvfoeoefcrdcqq.supabase.co',
  anonKey: 'sb_publishable_eZ-6aeez3s8OAvHYGt20Bw_XvvyMut_',
  memesBucket: 'memes',
};

export const GAME = {
  handSize: 5,            // карт в руке
  minPlayers: 3,          // меньше — играть нельзя
  maxSeats: 10,           // мест за столом (по числу аватаров)
  infiniteRounds: 9999,   // так в комнате хранится «∞»
  pollMs: 3000,           // страховочный опрос комнаты, если realtime отвалился
  sessionTtlMs: 24 * 3600 * 1000,  // комнаты старше суток сервер удаляет
};

// Метка «на этом устройстве вошёл админ»: показывает шестерёнку в игре.
// Это только удобство — права проверяет сервер.
export const ADMIN_FLAG = 'mg_admin';

export const AVATARS = ['🦊', '🐼', '🦁', '🐸', '🦋', '🐙', '🦄', '🐻', '🦅', '🐯'];
export const COLORS = ['#C2255C', '#E8590C', '#1971C2', '#2F7D3A', '#7048E8', '#D6336C', '#0C8599', '#F08C00', '#5C940D', '#9C36B5'];
