// Админка: мемы, ситуации и предложения игроков.
import { $, esc, toast as baseToast, bindActions, softenBrokenImages } from '../shared/dom.js';
import { SUPABASE } from '../config.js';
import { parseCSV, extractSituations, ocrLines, normalize, titleFromFile, storageName } from './import.js';

const toast = (msg, type = '') => baseToast(msg, 3000, type);
const fail = e => toast(`Ошибка: ${e.message}`, 'error');

// ── Подключение ────────────────────────────────────────
// По умолчанию — база игры; можно указать другую, она запоминается в браузере
const CFG_KEY = 'mg_admin_cfg';
let CFG = { url: SUPABASE.url, key: SUPABASE.anonKey };
try {
  const saved = JSON.parse(localStorage.getItem(CFG_KEY));
  if (saved?.url && saved?.key) CFG = saved;
} catch { /* нет сохранённых настроек */ }

function saveConfig() {
  CFG.url = $('cfg-url').value.trim().replace(/\/$/, '');
  CFG.key = $('cfg-key').value.trim();
  try { localStorage.setItem(CFG_KEY, JSON.stringify(CFG)); } catch { /* приватный режим */ }
}

const configured = () => {
  if (CFG.url && CFG.key) return true;
  toast('Сначала настрой подключение!', 'error');
  return false;
};

async function api(path, opts = {}) {
  const r = await fetch(`${CFG.url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: CFG.key, Authorization: `Bearer ${CFG.key}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...opts.headers,
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text || r.statusText);
  return text ? JSON.parse(text) : null;
}

const storagePath = name => `${CFG.url}/storage/v1/object/${SUPABASE.memesBucket}/${name}`;

async function storageUpload(name, file) {
  const r = await fetch(storagePath(name), {
    method: 'POST',
    headers: { apikey: CFG.key, Authorization: `Bearer ${CFG.key}`, 'Content-Type': file.type },
    body: file,
  });
  if (!r.ok) throw new Error(await r.text());
  return `${CFG.url}/storage/v1/object/public/${SUPABASE.memesBucket}/${name}`;
}

async function storageDelete(name) {
  await fetch(storagePath(name), { method: 'DELETE', headers: { apikey: CFG.key, Authorization: `Bearer ${CFG.key}` } });
}

function setStatus(text, type) {
  const el = $('db-status');
  el.textContent = text;
  el.className = `status-chip ${type}`;
}

async function testConnection() {
  setStatus('Проверка...', 'loading');
  try {
    await api('situations?limit=1');
    setStatus('Подключено ✓', 'ok');
    toast('Подключение успешно! ✓', 'success');
    loadAll();
  } catch (e) {
    setStatus('Ошибка', 'error');
    fail(e);
  }
}

async function loadAll() {
  if (!CFG.url || !CFG.key) { setStatus('Не настроено', 'error'); return; }
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
  if (!configured()) return;
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
  if (!configured()) return;
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
  if (!configured()) return;
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

// ── SQL для новой базы ─────────────────────────────────
const SQL_SETUP = `-- Таблица ситуаций
create table if not exists situations (
  id bigserial primary key,
  text text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- Таблица предложений от игроков
create table if not exists suggestions (
  id bigserial primary key,
  type text not null,
  text text not null,
  player text,
  room text,
  handled boolean default false,
  created_at timestamptz default now()
);

alter table suggestions enable row level security;
create policy "public insert suggestions" on suggestions for insert with check (true);
create policy "public read suggestions"   on suggestions for select using (true);
create policy "public update suggestions" on suggestions for update using (true);
create policy "public delete suggestions" on suggestions for delete using (true);

-- Таблица мемов
create table if not exists memes (
  id bigserial primary key,
  title text not null,
  image_url text not null,
  active boolean default true,
  created_at timestamptz default now()
);

-- Включить Row Level Security и разрешить чтение всем
alter table situations enable row level security;
alter table memes enable row level security;

create policy "public read situations" on situations for select using (true);
create policy "public read memes" on memes for select using (true);
create policy "public insert situations" on situations for insert with check (true);
create policy "public update situations" on situations for update using (true);
create policy "public delete situations" on situations for delete using (true);
create policy "public insert memes" on memes for insert with check (true);
create policy "public update memes" on memes for update using (true);
create policy "public delete memes" on memes for delete using (true);

-- Создать Storage bucket для мемов
insert into storage.buckets (id, name, public)
values ('memes', 'memes', true)
on conflict do nothing;

create policy "public read memes storage" on storage.objects for select using (bucket_id = 'memes');
create policy "public upload memes storage" on storage.objects for insert with check (bucket_id = 'memes');
create policy "public delete memes storage" on storage.objects for delete using (bucket_id = 'memes');

-- Для самой игры нужны ещё таблица rooms и функции patch_room / play_card:
-- их описание — в README.md репозитория.`;

const showSQL = () => { $('sql-modal').hidden = false; };
const closeSQL = () => { $('sql-modal').hidden = true; };

// ── Запуск ─────────────────────────────────────────────
bindActions({
  testConnection, loadAll, showSQL, closeSQL,
  closeSQLOutside: (el, e) => { if (e.target === el) closeSQL(); },
  copySQL: () => navigator.clipboard.writeText(SQL_SETUP).then(() => toast('SQL скопирован!', 'success')),
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
$('cfg-url').addEventListener('input', saveConfig);
$('cfg-key').addEventListener('input', saveConfig);
document.addEventListener('change', e => {
  if (e.target.matches('[data-change="togglePreviewItem"]')) {
    e.target.closest('.preview-sit-item').classList.toggle('excluded', !e.target.checked);
  }
});
$('sit-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addSituation(); }
});
softenBrokenImages('img.admin-meme');

$('cfg-url').value = CFG.url || '';
$('cfg-key').value = CFG.key || '';
$('sql-code').textContent = SQL_SETUP;
loadAll();
