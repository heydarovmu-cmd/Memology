import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { personalize, SQL_VERSION } from '../../js/admin/sql.js';

const ID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const TPL = readFileSync(new URL('../../supabase/setup.sql', import.meta.url), 'utf8');

test('SQL получает id админа и версию, которую ждёт игра', () => {
  const sql = personalize(TPL, ID);
  assert.match(sql, new RegExp(`values \\('${ID}'\\)`));
  assert.ok(!sql.includes('__ADMIN_USER_ID__'));
  assert.match(sql, new RegExp(`mg_version\\(\\)\\s*returns int language sql immutable as \\$\\$ select ${SQL_VERSION} \\$\\$`));
});

test('игрокам не открыто чтение каталога', () => {
  assert.doesNotMatch(TPL, /on public\.(memes|situations) for select/);
  assert.match(TPL, /revoke all on public\.room_secrets from anon, authenticated/);
});

test('в SQL нельзя подставить что-то кроме id', () => {
  assert.throws(() => personalize(TPL, "x'); drop table memes; --"));
  assert.throws(() => personalize(TPL, undefined));
});
