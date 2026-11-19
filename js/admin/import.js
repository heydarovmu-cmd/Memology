// Разбор файлов с ситуациями: CSV, таблицы Excel (строки уже массивами), текст OCR.
// Чистые функции — проверяются юнит-тестами.

// Разделитель угадывается по первой содержательной строке:
// Excel в русской локали сохраняет «;», Google Таблицы — «,».
export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find(l => l.trim()) || '';
  let best = ';', bestCount = 0;
  for (const d of [';', ',', '\t']) {
    let n = 0, inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) n++;
    }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

// CSV по правилам RFC 4180: кавычки, "" внутри кавычек, переносы строк в ячейке
export function parseCSV(text, delim = detectDelimiter(text)) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.map(r => (r.length === 1 && r[0] === '' ? [] : r));
}

const CARD = /карта\s*\d+/i;

// Два формата: «карточки» (столбцы с заголовком «Карта N», ситуации под ними)
// или просто первый столбец, где каждая строка — ситуация.
export function extractSituations(rows) {
  const out = [];
  const isCardFormat = rows.some(row => row.some(cell => CARD.test(String(cell))));
  if (isCardFormat) {
    for (let r = 0; r < rows.length; r++) {
      const cols = [];
      rows[r].forEach((cell, c) => { if (CARD.test(String(cell))) cols.push(c); });
      if (!cols.length) continue;
      for (let d = r + 1; d < rows.length && !rows[d].some(c => CARD.test(String(c))); d++) {
        for (const col of cols) {
          const val = String(rows[d][col] || '').replace(/^["']|["']$/g, '').trim();
          if (val.length > 8 && !/^карта\s*\d+$/i.test(val)) out.push(val);
        }
      }
    }
  } else {
    for (const row of rows) {
      const val = String(row[0] || '').trim();
      if (val.length > 8 && !/карта/i.test(val)) out.push(val);
    }
  }
  return out;
}

export function ocrLines(text) {
  return text.split('\n').map(l => l.trim()).filter(l => l.length > 5 && !/^\d+$/.test(l));
}

// Для сравнения с уже существующими ситуациями
export const normalize = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Название мема из имени файла
export const titleFromFile = name => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();

// Имя файла в хранилище: только безопасные символы
export const storageName = name => `${Date.now()}_${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
