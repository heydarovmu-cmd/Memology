// Вход админа через Supabase Auth (почта + пароль).
// Права проверяет сервер: писать в мемы, ситуации и хранилище может только
// пользователь из таблицы admins (см. SQL в админке и README).

import { SUPABASE, ADMIN_FLAG } from '../config.js';

const KEY = 'mg_admin_auth';

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const save = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* приватный режим */ } };
const drop = () => { try { localStorage.removeItem(KEY); localStorage.removeItem(ADMIN_FLAG); } catch { /* ничего */ } };

let session = load();

async function authRequest(path, body) {
  const r = await fetch(`${SUPABASE.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error_description || data.msg || data.message || data.error || r.statusText;
    throw new Error(/invalid login credentials|invalid_grant/i.test(msg) ? 'Неверная почта или пароль' : msg);
  }
  return data;
}

function remember(data) {
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: { id: data.user?.id, email: data.user?.email },
  };
  save(session);
  return session;
}

export const currentUser = () => session?.user || null;

export async function signIn(email, password) {
  return remember(await authRequest('token?grant_type=password', { email, password }));
}

export async function signOut() {
  const token = session?.access_token;
  drop();
  session = null;
  if (token) {
    await fetch(`${SUPABASE.url}/auth/v1/logout`, {
      method: 'POST', headers: { apikey: SUPABASE.anonKey, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

// Действующий токен; за минуту до истечения обновляется сам
export async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  try {
    return remember(await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token })).access_token;
  } catch {
    drop();
    session = null;
    return null;
  }
}

// Метка для игры: показывать шестерёнку на этом устройстве
export function markAdminDevice(isAdmin) {
  try {
    if (isAdmin) localStorage.setItem(ADMIN_FLAG, '1'); else localStorage.removeItem(ADMIN_FLAG);
  } catch { /* приватный режим */ }
}
