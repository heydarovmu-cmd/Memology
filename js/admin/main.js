// Админка: мемы, ситуации и предложения игроков.
import { $, esc, toast as baseToast, bindActions, softenBrokenImages } from '../shared/dom.js';
import { SUPABASE } from '../config.js';
import { parseCSV, extractSituations, ocrLines, normalize, titleFromFile, storageName } from './import.js';
import { signIn, signOut, accessToken, currentUser, markAdminDevice } from './auth.js';
import { securitySQL, fullSQL } from './sql.js';

const toast = (msg, type = '') => baseToast(msg, 3000, type);
const fail = e => (e instanceof AuthError ? showLogin(e.message) : toast(`Ошибка: ${e.message}`, 'error'));

class AuthError extends Error {}

// Запросы идут от имени вошедшего админа: сервер пускает на запись только его
async function headers(extra = {}) {
  const token = await accessToken();
  if (!token) throw new AuthError('Нужно войти заново');
  return { apikey: SUPABASE.anonKey, Authorization: `Bearer ${token}`, ...extra };
}

async function api(path, opts = {}) {
  const r = await fetch(`${SUPABASE.url}/rest/v1/${path}`, {
    ...opts,
    headers: await headers({ 'Content-Type': 'application/json', Prefer: 'return=representation', ...opts.headers }),
  });
  const text = await r.text();
  if (r.status === 401) throw new AuthError('Сессия истекла — войди заново');
  if (!r.ok) throw new Error(text || r.statusText);
  return text ? JSON.parse(text) : null;
}

const storagePath = name => `${SUPABASE.url}/storage/v1/object/${SUPABASE.memesBucket}/${name}`;

async function storageUpload(name, file) {
  const r = await fetch(storagePath(name), { method: 'POST', headers: await headers({ 'Content-Type': file.type }), body: file });
  if (!r.ok) throw new Error(await r.text());
  return `${SUPABASE.url}/storage/v1/object/public/${SUPABASE.memesBucket}/${name}`;
}

async function storageDelete(name) {
  await fetch(storagePath(name), { method: 'DELETE', headers: await headers() });
}

function setStatus(text, type) {
  const el = $('db-status');
  el.textContent = text;
  el.className = `status-chip ${type}`;
}

// ── Вход ───────────────────────────────────────────────
function showView(view) {
  $('auth-login').hidden = view !== 'login';
  $('auth-setup').hidden = view !== 'setup';
  $('admin-content').hidden = view !== 'admin';
  $('account').hidden = view !== 'admin';
}

function showLogin(message = '') {
  showView('login');
  setStatus('Нужен вход', 'error');
  $('login-error').textContent = message;
}

async function login(e) {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    await signIn($('login-email').value.trim(), $('login-password').value);
    $('login-password').value = '';
    await checkAdmin();
  } catch (err) {
    $('login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await signOut();
  markAdminDevice(false);
  showLogin();
}

// Админ ли вошедший? Если сервер ещё не настроен — показать SQL с его id
async function checkAdmin() {
  setStatus('Проверка...', 'loading');
  let isAdmin = false;
  try {
    isAdmin = await api('rpc/is_admin', { method: 'POST', body: '{}' }) === true;
  } catch (e) {
    if (e instanceof AuthError) return showLogin(e.message);
    isAdmin = false;   // функции is_admin ещё нет — база не настроена
  }
  markAdminDevice(isAdmin);
  const user = currentUser();
  if (!isAdmin) {
    showView('setup');
    setStatus('Не админ', 'error');
    $('setup-email').textContent = user?.email || '';
    $('setup-sql').textContent = securitySQL(user.id);
    return;
  }
  showView('admin');
  $('account-email').textContent = user?.email || '';
  loadAll();
}

async function loadAll() {
  setStatus('Загрузка...', 'loading');
  try {
    const [memes, sits] = await Promise.all([
      api('memes?select=*&order=id.desc'),
      api('situations?select=*&order=id.desc'),
    ]);
    renderMemes(memes || []);
    renderSituations(sits || []);
    loadSuggestions();
    setStatus('Подключено ✓', 'ok');
  } catch (e) {
    if (e instanceof AuthError) return showLogin(e.message);
    setStatus('Ошибка', 'error');
    toast(`Ошибка загрузки: ${e.message}`, 'error');
  }
}

// ── Мемы ───────────────────────────────────────────────
let memes = [];
function renderMemes(list) {
  memes = list;
  $('meme-count').textContent = list.filter(m => m.active).length + ' / ' + list.length;
  const grid = $('meme-grid');
  if (!list.length) { grid.innerHTML = '<div class="empty-note wide">Нет мемов. Загрузи первый!</div>'; return; }
  grid.innerHTML = list.map(m => `
    <div class="meme-item ${m.active ? '' : 'inactive'}" id="meme-${m.id}">
      <img class="admin-meme" src="${esc(m.image_url)}" alt="${esc(m.title)}" loading="lazy">
      <div class="meme-item-footer">
        <div class="meme-item-title" title="${esc(m.title)}">${esc(m.title)}</div>
        <button class="meme-del-btn" data-action="toggleMeme" data-id="${m.id}" title="${m.active ? 'Скрыть' : 'Показать'}">${m.active ? '👁' : '🚫'}</button>
        <button class="meme-del-btn" data-action="deleteMeme" data-id="${m.id}" title="Удалить">🗑</button>
      </div>
    </div>`).join('');
}

async function uploadMemes(input) {
  const files = Array.from(input.files);
  if (!files.length) return;
  const typed = $('meme-title-input').value.trim();
  const prog = $('upload-progress'), bar = $('upload-progress-bar');
  prog.style.display = 'block';
  bar.style.width = '0';

  let done = 0;
  for (const file of files) {
    try {
      const url = await storageUpload(storageName(file.name), file);
      // Введённое название относится к единственному файлу
      const title = (files.length === 1 && typed) || titleFromFile(file.name);
      await api('memes', { method: 'POST', body: JSON.stringify({ title, image_url: url, active: true }) });
      done++;
      bar.style.width = `${(done / files.length) * 100}%`;
    } catch (e) {
      toast(`Ошибка загрузки ${file.name}: ${e.message}`, 'error');
    }
  }
  setTimeout(() => { prog.style.display = 'none'; bar.style.width = '0'; }, 800);
  input.value = '';
  if (done && files.length === 1) $('meme-title-input').value = '';
  toast(`Загружено ${done}/${files.length} мемов${done === files.length ? ' ✓' : ''}`, done === files.length ? 'success' : 'error');
  await loadAll();
}

async function toggleMeme(el) {
  const m = memes.find(x => x.id === Number(el.dataset.id));
  if (!m) return;
  try {
    await api(`memes?id=eq.${m.id}`, { method: 'PATCH', body: JSON.stringify({ active: !m.active }) });
    toast(m.active ? 'Мем скрыт' : 'Мем активирован', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

async function deleteMeme(el) {
  const m = memes.find(x => x.id === Number(el.dataset.id));
  if (!m || !confirm('Удалить мем?')) return;
  try {
    await api(`memes?id=eq.${m.id}`, { method: 'DELETE' });
    const path = String(m.image_url).split(`/${SUPABASE.memesBucket}/`)[1];
    if (path) await storageDelete(path).catch(() => {});
    toast('Мем удалён', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

// ── Ситуации ───────────────────────────────────────────
let sits = [];
function renderSituations(list) {
  sits = list;
  $('sit-count').textContent = list.filter(s => s.active).length + ' / ' + list.length;
  const el = $('sit-list');
  if (!list.length) { el.innerHTML = '<div class="empty-note">Нет ситуаций. Добавь первую!</div>'; return; }
  el.innerHTML = list.map(s => `
    <div class="sit-item ${s.active ? '' : 'inactive'}">
      <div class="sit-text">${esc(s.text)}</div>
      <div class="sit-actions">
        <span class="${s.active ? 'badge-active' : 'badge-inactive'}">${s.active ? 'ON' : 'OFF'}</span>
        <button class="sit-toggle-btn" data-action="toggleSit" data-id="${s.id}" title="${s.active ? 'Скрыть' : 'Показать'}">${s.active ? '👁' : '🚫'}</button>
        <button class="sit-del-btn" data-action="deleteSit" data-id="${s.id}" title="Удалить">🗑</button>
      </div>
    </div>`).join('');
}

async function addSituation() {
  const inp = $('sit-input');
  const text = inp.value.trim();
  if (!text) return toast('Введи текст ситуации!', 'error');
  try {
    await api('situations', { method: 'POST', body: JSON.stringify({ text, active: true }) });
    inp.value = '';
    toast('Ситуация добавлена ✓', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

async function toggleSit(el) {
  const s = sits.find(x => x.id === Number(el.dataset.id));
  if (!s) return;
  try {
    await api(`situations?id=eq.${s.id}`, { method: 'PATCH', body: JSON.stringify({ active: !s.active }) });
    toast(s.active ? 'Ситуация скрыта' : 'Ситуация активирована', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

async function deleteSit(el) {
  const id = Number(el.dataset.id);
  if (!confirm('Удалить ситуацию?')) return;
  try {
    await api(`situations?id=eq.${id}`, { method: 'DELETE' });
    toast('Ситуация удалена', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

async function deleteAllSituations() {
  if (!confirm(`Удалить ВСЕ ${sits.length} ситуаций? Это нельзя отменить!`)) return;
  if (!confirm('Ты уверен? Все ситуации будут удалены безвозвратно.')) return;
  try {
    await api('situations?id=gt.0', { method: 'DELETE' });
    toast('Все ситуации удалены', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

// ── Импорт: Excel / CSV и фото ─────────────────────────
const imports = { excel: [], ocr: [] };

function switchTab(el) {
  const tab = el.dataset.tab;
  $('import-excel').hidden = tab !== 'excel';
  $('import-photo').hidden = tab !== 'photo';
  $('tab-excel').classList.toggle('active', tab === 'excel');
  $('tab-photo').classList.toggle('active', tab === 'photo');
}

async function handleExcel(input) {
  const file = input.files[0];
  if (!file) return;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    let rows;
    if (/\.csv$/i.test(file.name)) {
      rows = parseCSV(new TextDecoder('utf-8').decode(buf));
    } else {
      if (!window.XLSX) throw new Error('библиотека Excel не загрузилась, обнови страницу');
      const wb = window.XLSX.read(buf, { type: 'array' });
      rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    }
    showPreview('excel', extractSituations(rows), 'Не удалось найти ситуации в файле');
  } catch (e) {
    toast(`Ошибка чтения файла: ${e.message}`, 'error');
  } finally {
    input.value = '';
  }
}

async function handlePhotos(input) {
  const files = Array.from(input.files);
  if (!files.length) return;
  const status = $('ocr-status'), text = $('ocr-status-text'), bar = $('ocr-bar');
  $('ocr-preview').hidden = true;
  status.hidden = false;
  const lines = [];
  let worker = null;
  try {
    if (!window.Tesseract) throw new Error('распознавание не загрузилось, обнови страницу');
    worker = await window.Tesseract.createWorker('rus+eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          bar.style.width = Math.round(m.progress * 100) + '%';
          text.textContent = `Распознаю... ${Math.round(m.progress * 100)}%`;
        }
      },
    });
    for (let i = 0; i < files.length; i++) {
      text.textContent = `Файл ${i + 1}/${files.length} — распознаю...`;
      bar.style.width = '0';
      const { data } = await worker.recognize(files[i]);
      lines.push(...ocrLines(data.text));
    }
    showPreview('ocr', lines, 'Текст не распознан. Попробуй фото с более чётким текстом.');
  } catch (e) {
    toast(`Ошибка распознавания: ${e.message}`, 'error');
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    status.hidden = true;
    input.value = '';
  }
}

// Предпросмотр импорта. То, что уже есть в базе, по умолчанию не отмечено.
function showPreview(source, lines, emptyMsg) {
  if (!lines.length) return toast(emptyMsg, 'error');
  const have = new Set(sits.map(s => normalize(s.text)));
  const seen = new Set();
  imports[source] = lines;
  const dupes = lines.filter(l => { const k = normalize(l); const d = have.has(k) || seen.has(k); seen.add(k); return d; });
  const dupSet = new Set(dupes);
  $(`${source}-preview-label`).textContent =
    `Найдено ${lines.length}` + (dupes.length ? ` (повторов: ${dupes.length})` : '') + ' — сними галочку, чтобы исключить';
  $(`${source}-preview-list`).innerHTML = lines.map((l, i) => {
    const dup = dupSet.has(l) && (have.has(normalize(l)) || lines.findIndex(x => normalize(x) === normalize(l)) !== i);
    return `<label class="preview-sit-item ${dup ? 'excluded' : ''}" id="${source}-${i}">
      <input type="checkbox" class="preview-sit-check" data-change="togglePreviewItem" ${dup ? '' : 'checked'}>
      <span>${esc(l)}</span>${dup ? '<span class="dup-note">уже есть</span>' : ''}
    </label>`;
  }).join('');
  $(`${source}-preview`).hidden = false;
}

async function importLines(el) {
  const source = el.dataset.source;
  const chosen = imports[source].filter((_, i) => $(`${source}-${i}`)?.querySelector('input').checked);
  if (!chosen.length) return toast('Нет выбранных ситуаций', 'error');
  try {
    await api('situations', { method: 'POST', body: JSON.stringify(chosen.map(text => ({ text, active: true }))) });
    $(`${source}-preview`).hidden = true;
    imports[source] = [];
    toast(`Импортировано ${chosen.length} ситуаций ✓`, 'success');
    loadAll();
  } catch (e) { fail(e); }
}

// ── Предложения игроков ────────────────────────────────
let sugs = [], showHandled = false;

async function loadSuggestions() {
  try {
    sugs = await api('suggestions?select=*&order=created_at.desc') || [];
    renderSuggestions();
  } catch {
    $('sug-list').innerHTML = '<div class="empty-note">Таблица предложений ещё не создана.<br>' +
      '<span class="c-blue">Нажми «Показать SQL» и выполни его заново</span> — добавится блок suggestions.</div>';
    $('sug-count').textContent = '—';
  }
}

function whenStr(iso) {
  if (!iso) return '';
  const d = new Date(iso), diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return Math.floor(diff / 60) + ' мин назад';
  if (diff < 86400) return Math.floor(diff / 3600) + ' ч назад';
  if (diff < 604800) return Math.floor(diff / 86400) + ' дн назад';
  return d.toLocaleDateString('ru-RU');
}

const SUG_LABELS = { situation: 'Ситуация', meme: 'Мем', other: 'Другое' };

function renderSuggestions() {
  const list = showHandled ? sugs : sugs.filter(s => !s.handled);
  const pending = sugs.filter(s => !s.handled).length;
  $('sug-count').textContent = pending + (sugs.length !== pending ? ' / ' + sugs.length : '');
  $('sug-filter-btn').textContent = showHandled ? 'Скрыть обработанные' : 'Показать обработанные';
  const el = $('sug-list');
  if (!list.length) {
    el.innerHTML = `<div class="empty-note">${sugs.length ? 'Все предложения обработаны' : 'Пока ничего не прислали'}</div>`;
    return;
  }
  el.innerHTML = list.map(s => {
    const t = SUG_LABELS[s.type] ? s.type : 'other';
    const who = [s.player, s.room ? 'комната ' + s.room : ''].filter(Boolean).join(' · ');
    return `<div class="sug-item ${s.handled ? 'handled' : ''}">
      <div class="sug-head">
        <span class="sug-type sug-t-${t}">${SUG_LABELS[t]}</span>
        ${who ? `<span class="sug-who">${esc(who)}</span>` : ''}
        <span class="sug-meta">${whenStr(s.created_at)}</span>
      </div>
      <div class="sug-text">${esc(s.text)}</div>
      <div class="sug-acts">
        ${t === 'situation' && !s.handled ? `<button class="sug-btn use" data-action="sugToSituation" data-id="${s.id}">В ситуации</button>` : ''}
        <button class="sug-btn" data-action="sugHandled" data-id="${s.id}">${s.handled ? 'Вернуть' : 'Обработано'}</button>
        <button class="sug-btn del" data-action="sugDelete" data-id="${s.id}">Удалить</button>
      </div>
    </div>`;
  }).join('');
}

async function setHandled(id, val) {
  await api('suggestions?id=eq.' + id, { method: 'PATCH', body: JSON.stringify({ handled: val }) });
  const s = sugs.find(x => x.id === id);
  if (s) s.handled = val;
  renderSuggestions();
}

async function sugHandled(el) {
  const s = sugs.find(x => x.id === Number(el.dataset.id));
  if (s) setHandled(s.id, !s.handled).catch(fail);
}

async function sugDelete(el) {
  const id = Number(el.dataset.id);
  if (!confirm('Удалить предложение?')) return;
  try {
    await api('suggestions?id=eq.' + id, { method: 'DELETE' });
    sugs = sugs.filter(x => x.id !== id);
    renderSuggestions();
    toast('Удалено', 'success');
  } catch (e) { fail(e); }
}

async function sugToSituation(el) {
  const s = sugs.find(x => x.id === Number(el.dataset.id));
  if (!s) return;
  try {
    await api('situations', { method: 'POST', body: JSON.stringify({ text: s.text, active: true }) });
    await setHandled(s.id, true);
    toast('Добавлено в ситуации', 'success');
    loadAll();
  } catch (e) { fail(e); }
}

async function clearHandled() {
  const n = sugs.filter(s => s.handled).length;
  if (!n) return toast('Нечего очищать');
  if (!confirm(`Удалить обработанные предложения (${n} шт.)?`)) return;
  try {
    await api('suggestions?handled=eq.true', { method: 'DELETE' });
    sugs = sugs.filter(s => !s.handled);
    renderSuggestions();
    toast('Удалено: ' + n, 'success');
  } catch (e) { fail(e); }
}

// ── SQL ────────────────────────────────────────────────
const copy = text => navigator.clipboard.writeText(text).then(() => toast('SQL скопирован!', 'success'));
const showSQL = () => { $('sql-code').textContent = fullSQL(currentUser().id); $('sql-modal').hidden = false; };
const closeSQL = () => { $('sql-modal').hidden = true; };

// ── Запуск ─────────────────────────────────────────────
bindActions({
  loadAll, showSQL, closeSQL, checkAdmin,
  signOut: logout,
  closeSQLOutside: (el, e) => { if (e.target === el) closeSQL(); },
  copySQL: () => copy($('sql-code').textContent),
  copySetupSQL: () => copy($('setup-sql').textContent),
  pickMemeFiles: () => $('meme-file-input').click(),
  pickExcel: () => $('excel-input').click(),
  pickPhoto: () => $('photo-sit-input').click(),
  toggleMeme, deleteMeme,
  addSituation, toggleSit, deleteSit, deleteAllSituations,
  switchTab, importLines,
  toggleHandled: () => { showHandled = !showHandled; renderSuggestions(); },
  clearHandled, sugHandled, sugDelete, sugToSituation,
});

$('meme-file-input').addEventListener('change', e => uploadMemes(e.target));
$('excel-input').addEventListener('change', e => handleExcel(e.target));
$('photo-sit-input').addEventListener('change', e => handlePhotos(e.target));
document.addEventListener('change', e => {
  if (e.target.matches('[data-change="togglePreviewItem"]')) {
    e.target.closest('.preview-sit-item').classList.toggle('excluded', !e.target.checked);
  }
});
$('sit-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addSituation(); }
});
softenBrokenImages('img.admin-meme');

$('login-form').addEventListener('submit', login);

if (currentUser()) checkAdmin(); else showLogin();
