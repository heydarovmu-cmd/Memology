// Временный Postgres для тестов: настоящая серверная логика из
// supabase/setup.sql поверх заглушки Supabase (роли, auth, storage).
//
// Нужен установленный PostgreSQL (initdb, pg_ctl, psql). На GitHub Actions
// он есть в образе ubuntu-latest; локально: apt install postgresql.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const ADMIN_ID = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

function pgBin() {
  try {
    const dir = execFileSync('pg_config', ['--bindir'], { stdio: 'pipe' }).toString().trim();
    if (existsSync(path.join(dir, 'initdb'))) return dir;
  } catch { /* нет pg_config */ }
  const base = '/usr/lib/postgresql';
  if (existsSync(base)) {
    const ver = readdirSync(base).sort((a, b) => Number(b) - Number(a))[0];
    if (ver && existsSync(`${base}/${ver}/bin/initdb`)) return `${base}/${ver}/bin`;
  }
  throw new Error('PostgreSQL не найден: нужны initdb, pg_ctl и psql');
}

// Сервер Postgres нельзя запускать от root: тогда — от пользователя postgres
const asPg = (bin, args) => (process.getuid?.() === 0 ? ['runuser', ['-u', 'postgres', '--', bin, ...args]] : [bin, args]);

// Литерал SQL
export const lit = v => (v === null || v === undefined ? 'null'
  : typeof v === 'number' ? String(Math.trunc(v))
  : `'${String(v).replace(/'/g, "''")}'`);

// Постоянное соединение psql: запросы по очереди, ответ — до метки
class Conn {
  constructor(psql, args) {
    this.p = spawn(psql, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.out = ''; this.err = ''; this.queue = []; this.busy = null; this.n = 0;
    this.p.stdout.on('data', d => { this.out += d; this.pump(); });
    this.p.stderr.on('data', d => { this.err += d; this.pump(); });
  }
  run(sql) {
    return new Promise((resolve, reject) => { this.queue.push({ sql, resolve, reject }); this.next(); });
  }
  next() {
    if (this.busy || !this.queue.length) return;
    this.busy = this.queue.shift();
    this.busy.tag = `__END_${++this.n}__`;
    this.p.stdin.write(`${this.busy.sql}\n\\echo ${this.busy.tag}\n\\warn ${this.busy.tag}\n`);
  }
  pump() {
    const b = this.busy;
    if (!b) return;
    const io = this.out.indexOf(b.tag), ie = this.err.indexOf(b.tag);
    if (io < 0 || ie < 0) return;
    const out = this.out.slice(0, io).trim(), err = this.err.slice(0, ie).trim();
    this.out = this.out.slice(io + b.tag.length).replace(/^\n/, '');
    this.err = this.err.slice(ie + b.tag.length).replace(/^\n/, '');
    this.busy = null;
    const m = err.match(/ERROR:\s+(.*)/);
    if (m) b.reject(new Error(m[1].trim())); else b.resolve(out);
    this.next();
  }
  close() { this.p.stdin.end(); }
}

export async function startPg({ admin = true, poolSize = 4 } = {}) {
  const bin = pgBin();
  const dir = mkdtempSync(path.join(process.env.PG_TMP || tmpdir(), 'memology-pg-'));
  chmodSync(dir, 0o777);
  const data = path.join(dir, 'data');
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const run = (b, args) => { const [cmd, a] = asPg(path.join(bin, b), args); execFileSync(cmd, a, { stdio: 'pipe' }); };

  run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  run('pg_ctl', ['-D', data, '-o', `-p ${port} -k ${dir} -c listen_addresses=''`, '-l', path.join(dir, 'log'), '-w', 'start']);

  const psql = path.join(bin, 'psql');
  const base = ['-X', '-q', '-t', '-A', '-h', dir, '-p', port, '-U', 'postgres'];
  execFileSync(psql, [...base, '-d', 'postgres', '-c', 'create database memology']);
  const args = [...base, '-d', 'memology', '-v', 'ON_ERROR_STOP=0'];
  const file = f => execFileSync(psql, [...args.slice(0, -2), '-v', 'ON_ERROR_STOP=1', '-f', f], { stdio: 'pipe' });

  file(path.join(HERE, 'supabase-shim.sql'));
  const setup = readFileSync(path.join(ROOT, 'supabase/setup.sql'), 'utf8').replace(/__ADMIN_USER_ID__/g, ADMIN_ID);
  const setupFile = path.join(dir, 'setup.sql');
  (await import('node:fs')).writeFileSync(setupFile, setup);
  file(setupFile);
  if (!admin) execFileSync(psql, [...args, '-c', 'delete from public.admins']);

  const pool = Array.from({ length: poolSize }, () => new Conn(psql, args));
  let rr = 0;
  const db = {
    dir,
    // Запрос от имени роли: anon (игрок), authenticated (+uid), или postgres
    query(sql, { role = 'postgres', uid } = {}) {
      const pre = role === 'postgres' ? '' :
        `set role ${role}; set "request.jwt.claim.sub" = ${lit(uid || '')};`;
      const post = role === 'postgres' ? '' : 'reset role;';
      return pool[rr++ % pool.length].run(`${pre}\n${sql}\n${post}`)
        .then(out => out.split('\n').filter(l => l !== '' && l !== 'SET' && !/^\s*$/.test(l)).join('\n'));
    },
    async json(sql, opts) {
      const out = await db.query(sql, opts);
      const lines = out.split('\n').filter(Boolean);
      return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    },
    // Вызвать функцию игры как аноним, как это делает PostgREST
    rpc(name, args) {
      const list = Object.entries(args).map(([k, v]) => `${k} => ${lit(v)}`).join(', ');
      return db.json(`select public.${name}(${list})::text;`, { role: 'anon' });
    },
    async stop() {
      pool.forEach(c => c.close());
      try { run('pg_ctl', ['-D', data, '-m', 'immediate', 'stop']); } catch { /* уже остановлен */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return db;
}
