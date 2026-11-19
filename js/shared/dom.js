// Мелкие помощники для работы с DOM — общие для игры и админки.

export const $ = id => document.getElementById(id);

// Всё, что пришло от игроков или из базы, вставляется в HTML только через esc()
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
export function toast(msg, dur = 2600, type = '') {
  const el = $('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = msg;
  el.className = `toast show ${type}`.trim();
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// Делегирование кликов: <button data-action="name" data-...>.
// Обработчик получает элемент с data-action и само событие.
export function bindActions(actions, root = document) {
  root.addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = actions[el.dataset.action];
    if (!fn) { console.warn('Нет действия', el.dataset.action); return; }
    fn(el, e);
  });
}

// Картинка не загрузилась — серый прямоугольник вместо битой иконки
export function softenBrokenImages(selector) {
  document.addEventListener('error', e => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.matches(selector)) img.style.background = '#EEF0F7';
  }, true);
}
