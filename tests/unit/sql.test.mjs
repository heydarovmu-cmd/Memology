import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securitySQL, fullSQL } from '../../js/admin/sql.js';

const ID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

test('SQL доступа содержит id админа и закрывает запись', () => {
  const sql = securitySQL(ID);
  assert.match(sql, new RegExp(`values \\('${ID}'\\)`));
  for (const t of ['memes', 'situations', 'suggestions']) assert.match(sql, new RegExp(`admin manages ${t}`));
  assert.match(sql, /for select using \(active\)/);
  assert.doesNotMatch(sql, /for (insert|update|delete|all) (using|with check) \(true\)[^;]*on public\.(memes|situations)/);
});

test('в SQL нельзя подставить что-то кроме id', () => {
  assert.throws(() => securitySQL("x'); drop table memes; --"));
  assert.throws(() => securitySQL(undefined));
  assert.match(fullSQL(ID), /create table if not exists public\.memes/);
});
