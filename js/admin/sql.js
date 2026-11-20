// SQL для Supabase лежит в supabase/setup.sql — один файл и для новой базы,
// и для обновления. Админка подставляет в него id вошедшего админа.

// Версия серверной части, которую ждёт эта версия игры (mg_version() в SQL)
export const SQL_VERSION = 2;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function personalize(template, userId) {
  if (!UUID.test(userId || '')) throw new Error('некорректный id пользователя');
  return template.replaceAll('__ADMIN_USER_ID__', userId);
}

let template = null;
export async function setupSQL(userId) {
  template ||= await fetch(new URL('../../supabase/setup.sql', import.meta.url)).then(r => {
    if (!r.ok) throw new Error('не удалось загрузить supabase/setup.sql');
    return r.text();
  });
  return personalize(template, userId);
}
