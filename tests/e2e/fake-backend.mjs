// Бэкенд для сквозных тестов.
//
// Игра: ходы (mg_*) и состояние комнаты идут в настоящий Postgres с
// supabase/setup.sql (tests/db/pg.mjs). Сверху — модель сети Supabase:
// задержки, realtime-рассылка всем подписанным вкладкам, «устаревшие»
// ответы на опрос и сбои.
//
// Админка: REST для мемов, ситуаций и предложений, Supabase Auth и права
// (row level security) смоделированы в памяти — это проверяет страницу,
// а сами правила доступа проверяются на Postgres в tests/db.

import { lit } from '../db/pg.mjs';

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = ([a, b]) => a + Math.random() * (b - a);

export function makeContent({ memes = 40, situations = 30 } = {}) {
  return {
    memes: Array.from({ length: memes }, (_, i) => ({
      id: i + 1, title: `Мем ${i + 1}`, image_url: `https://img.test/m${i + 1}.svg`, active: true,
    })),
    situations: Array.from({ length: situations }, (_, i) => ({
      id: i + 1, text: `Ситуация номер ${i + 1}`, active: true,
    })),
  };
}

export class FakeBackend {
  constructor(opts = {}) {
    this.opts = {
      rpcDelay: [5, 30],      // задержка до выполнения хода на «сервере»
      replyDelay: [5, 30],    // задержка ответа после выполнения
      pollDelay: [5, 30],     // задержка ответа на опрос (снимок берётся в момент запроса)
      rtDelay: [10, 60],      // задержка realtime-события
      ...opts,
    };
    this.db = opts.db;        // Postgres из tests/db/pg.mjs (нужен для игры)
    const content = makeContent(opts.contentSize);
    this.memes = content.memes;
    this.situations = content.situations;
    this.suggestions = [];
    this.rooms = new Map();     // последнее известное состояние комнат (для проверок в тестах)
    this.history = new Map();   // code -> прошлые версии (для «устаревших» ответов)
    this.staleFor = new Map();  // page -> на сколько версий назад ответить на ближайший опрос
    this.subs = new Map();      // page -> Set(каналы)
    this.chains = new Map();    // page -> promise (порядок доставки)
    this.failNext = new Map();  // имя функции -> текст ошибки (один раз)
    this.missingFunctions = false;
    this.writes = 0;

    // Supabase Auth и права для админки
    this.users = [{ id: '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', email: 'admin@memology.test', password: 'secret123' }];
    this.secured = opts.secured ?? true;
    this.sqlVersion = opts.sqlVersion ?? 2;
    this.admins = new Set(opts.admins || []);
    this.tokens = new Map();
    this.refresh = new Map();
  }

  room(code) { return this.rooms.get(code); }

  // Скрытая часть комнаты — только для проверок в тестах
  secrets(code) {
    return this.db.json(`select row_to_json(s)::text from room_secrets s where code = ${lit(code)};`);
  }

  load(code) {
    return this.db.json(`select data::text from rooms where code = ${lit(code)};`);
  }

  async handle(source, op, args) {
    const page = source.page;
    args = clone(args);   // как настоящий supabase-js: undefined-поля не доходят до сервера
    if (op === 'subscribe') {
      if (!this.subs.has(page)) this.subs.set(page, new Set());
      this.subs.get(page).add(args.name);
      return null;
    }
    if (op === 'select') {
      const code = args.filters.code;
      let snap = await this.load(code);
      const back = this.staleFor.get(page);
      if (back) {
        this.staleFor.delete(page);
        const h = this.history.get(code) || [];
        snap = clone(h[Math.max(0, h.length - 1 - back)]);
      }
      await sleep(rnd(this.opts.pollDelay));
      return { data: snap ? { data: snap } : null, error: null };
    }
    if (op === 'rpc') {
      await sleep(rnd(this.opts.rpcDelay));
      if (this.missingFunctions) {
        return { data: null, error: { message: `Could not find the function public.${args.name} in the schema cache` } };
      }
      const fail = this.failNext.get(args.name);
      if (fail) {
        this.failNext.delete(args.name);
        return { data: null, error: { message: fail } };
      }
      let result;
      try {
        result = await this.db.rpc(args.name, args.args);
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
      if (args.name !== 'mg_view') {
        const code = result?.code || result?.room?.code || String(args.args.p_code || '').toUpperCase();
        const data = await this.load(code);
        if (data) this.commit(code, data);
      }
      await sleep(rnd(this.opts.replyDelay));
      return { data: result, error: null };
    }
    throw new Error('unknown op ' + op);
  }

  commit(code, data) {
    this.rooms.set(code, data);
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push(clone(data));
    this.writes++;
    for (const [page, names] of this.subs) {
      if (!names.has('room:' + code) || page.isClosed()) continue;
      const prev = this.chains.get(page) || Promise.resolve();
      this.chains.set(page, prev.then(async () => {
        await sleep(rnd(this.opts.rtDelay));
        if (page.isClosed()) return;
        await page.evaluate(([c, d]) => window.__rtPush && window.__rtPush(c, d), [code, clone(data)]).catch(() => {});
      }));
    }
  }

  // ── Supabase Auth (админка) ──────────────────────────────
  // anon (ключ игры), admin, user (вошёл, но не админ), bad (чужой/истёкший токен)
  whoIs(req) {
    const token = (req.headers().authorization || '').replace(/^Bearer\s+/i, '');
    if (!token || token.startsWith('sb_publishable')) return 'anon';
    const uid = this.tokens.get(token);
    if (!uid) return 'bad';
    return this.secured && this.admins.has(uid) ? 'admin' : 'user';
  }

  issue(uid) {
    const access = 'at-' + Math.random().toString(36).slice(2);
    const refresh = 'rt-' + Math.random().toString(36).slice(2);
    this.tokens.set(access, uid);
    this.refresh.set(refresh, uid);
    const u = this.users.find(x => x.id === uid);
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, user: { id: u.id, email: u.email } };
  }

  async handleAuth(route) {
    const req = route.request();
    const url = new URL(req.url());
    const json = (status, b) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    const body = JSON.parse(req.postData() || '{}');
    const grant = url.searchParams.get('grant_type');
    if (url.pathname === '/auth/v1/token' && grant === 'password') {
      const u = this.users.find(x => x.email === body.email && x.password === body.password);
      return u ? json(200, this.issue(u.id)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/token' && grant === 'refresh_token') {
      const uid = this.refresh.get(body.refresh_token);
      return uid ? json(200, this.issue(uid)) : json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
    }
    if (url.pathname === '/auth/v1/logout') {
      this.tokens.delete((req.headers().authorization || '').replace(/^Bearer\s+/i, ''));
      return route.fulfill({ status: 204, body: '' });
    }
    return json(404, { error: 'not found' });
  }

  async handleStorage(route) {
    const req = route.request();
    if (this.secured && this.whoIs(req) !== 'admin') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"new row violates row-level security policy"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }

  // ── REST: контент и предложения ──────────────────────────
  async handleRest(route) {
    const req = route.request();
    const url = new URL(req.url());
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)/);
    if (!m) return route.fulfill({ status: 404, body: 'not found' });
    const who = this.whoIs(req);
    const json = (b, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(b) });
    if (who === 'bad') return json({ message: 'JWT expired' }, 401);

    if (m[1] === 'rpc') {
      const fn = url.pathname.split('/').pop();
      if (!this.secured || !['is_admin', 'mg_version'].includes(fn)) {
        return json({ message: `Could not find the function public.${fn}` }, 404);
      }
      return json(fn === 'is_admin' ? who === 'admin' : this.sqlVersion);
    }

    const table = m[1];
    const rows = { memes: this.memes, situations: this.situations, suggestions: this.suggestions }[table];
    if (!rows) return route.fulfill({ status: 404, body: 'no table' });
    // До настройки всё открыто; после — игроку можно только отправить предложение
    const open = !this.secured || who === 'admin';

    const p = url.searchParams;
    const match = r => {
      for (const [k, v] of p) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        const [opr, val] = v.split(/\.(.*)/s);
        if (opr === 'eq' && String(r[k]) !== val) return false;
        if (opr === 'gt' && !(Number(r[k]) > Number(val))) return false;
      }
      return true;
    };
    const method = req.method();

    if (method === 'GET') {
      if (!open) return json([]);
      let out = rows.filter(match);
      const ord = p.get('order');
      if (ord) {
        const [col, dir] = ord.split('.');
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      }
      if (p.get('limit')) out = out.slice(0, Number(p.get('limit')));
      return json(out);
    }
    if (method === 'POST') {
      if (!open && table !== 'suggestions') return json({ message: 'new row violates row-level security policy' }, 403);
      const body = JSON.parse(req.postData() || '[]');
      const made = (Array.isArray(body) ? body : [body]).map(r => {
        const row = { id: rows.reduce((mx, x) => Math.max(mx, x.id), 0) + 1, created_at: new Date().toISOString(), handled: false, active: true, ...r };
        rows.push(row);
        return row;
      });
      return json(open ? made : []);
    }
    if (method === 'PATCH') {
      const hit = open ? rows.filter(match) : [];
      hit.forEach(r => Object.assign(r, JSON.parse(req.postData() || '{}')));
      return json(hit);
    }
    if (method === 'DELETE') {
      const keep = rows.filter(r => !open || !match(r));
      const gone = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return json(Array(gone).fill({}));
    }
    return route.fulfill({ status: 405, body: '' });
  }
}
