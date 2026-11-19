import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, detectDelimiter, extractSituations, ocrLines, normalize, titleFromFile } from '../../js/admin/import.js';

test('разделитель: точка с запятой, запятая, табуляция', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a,b,c'), ',');
  assert.equal(detectDelimiter('a\tb'), '\t');
  assert.equal(detectDelimiter('"a;b",c'), ',');
});

test('CSV: кавычки, экранирование, перенос внутри ячейки, CRLF, BOM', () => {
  const rows = parseCSV('﻿"x; y";"он сказал ""да"""\r\n"две\nстроки";z\r\n\r\nпоследняя');
  assert.deepEqual(rows, [['x; y', 'он сказал "да"'], ['две\nстроки', 'z'], [], ['последняя']]);
});

test('ситуации из первого столбца, короткие и заголовки пропускаются', () => {
  assert.deepEqual(extractSituations([['Ситуация'], ['Когда опоздал на поезд'], ['коротко'], ['Карта игрока (заголовок)']]),
    ['Когда опоздал на поезд']);
});

test('ситуации в формате «Карта N»', () => {
  const rows = [
    ['Карта 1', '', 'Карта 2'],
    ['Когда кот сел на ноутбук', '', 'Когда начальник пишет в пятницу'],
    ['Когда забыл зарядку дома', '', ''],
    ['Карта 3'],
    ['Когда тесты прошли с первого раза'],
  ];
  assert.deepEqual(extractSituations(rows), [
    'Когда кот сел на ноутбук', 'Когда начальник пишет в пятницу', 'Когда забыл зарядку дома',
    'Когда тесты прошли с первого раза',
  ]);
});

test('OCR: пустые строки и номера отбрасываются', () => {
  assert.deepEqual(ocrLines('12\n\n  Когда вышел из дома  \nкот'), ['Когда вышел из дома']);
});

test('сравнение текстов без учёта регистра, ё и знаков', () => {
  assert.equal(normalize('Ёлка, «ЕЛКА»!'), normalize('елка елка'));
  assert.equal(titleFromFile('кот_в-шоке.final.png'), 'кот в шоке.final');
});
