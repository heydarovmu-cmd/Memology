// In-memory модель бэкенда Memology (Supabase): таблица rooms с RPC
// patch_room / play_card, realtime-рассылка и REST для контента.
//
// Серверные функции в репозитории не лежат, поэтому их поведение
// воспроизведено по контракту, на который опирается клиент:
//   patch_room(p_code, p_paths) — каждый ключ вида "a/b/c" пишется через
//     jsonb_set(create_missing => true): создаётся только последний ключ,
//     если промежуточного нет — запись молча не происходит.
//   play_card(p_code, p_player, p_index) — карта из руки уходит в
//     submissions[p_player], на её место встаёт верхняя карта колоды
//     (если колода пуста — рука укорачивается).
//
// Задержки и порядок доставки настраиваются, чтобы ловить гонки.

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = ([a, b]) => a + Math.random() * (b - a);

export function jsonbSet(target, path, value) {
  if (!path.length) return clone(value);
  const root = clone(target);
  let cur = root;
  for (const k of path.slice(0, -1)) {
    if (Array.isArray(cur)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return target;
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      if (!(k in cur)) return target;
      cur = cur[k];
    } else {
      return target;
    }
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) {
    const i = Number(last);
    if (!Number.isInteger(i)) return target;
    if (i >= 0 && i < cur.length) cur[i] = clone(value);
    else cur.push(clone(value));
  } else if (cur && typeof cur === 'object') {
    cur[last] = clone(value);
  } else {
    return target;
  }
  return root;
}

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
      rpcDelay: [5, 30],      // задержка до применения изменения на «сервере»
      replyDelay: [5, 30],    // задержка ответа клиенту после применения
      pollDelay: [5, 30],     // задержка ответа на select (снимок берётся в момент запроса)
      rtDelay: [10, 60],      // задержка realtime-события
      rtDropRate: 0,          // доля потерянных realtime-событий
      ...opts,
    };
    const content = opts.content || makeContent(opts.contentSize);
    this.memes = content.memes;
    this.situations = content.situations;
    this.suggestions = [];
    this.rooms = new Map();
    this.subs = new Map();      // page -> Set(channel names)
    this.chains = new Map();    // page -> promise (порядок доставки)
    this.failNext = new Map();  // rpc name -> error message (один раз)
    this.contentDown = false;
    // Supabase Auth и права. secured=false — старые открытые правила,
    // secured=true — после SQL из админки: писать может только админ.
    this.users = [{ id: '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', email: 'admin@memology.test', password: 'secret123' }];
    this.secured = opts.secured ?? false;
    this.admins = new Set(opts.admins || []);
    this.tokens = new Map();     // access token -> user id
    this.refresh = new Map();    // refresh token -> user id
    this.history = new Map();   // code -> прошлые версии (для «устаревших» ответов)
    this.staleFor = new Map();  // page -> на сколько версий назад ответить на ближайший select
    this.log = [];
    this.writes = 0;
  }

  room(code) { return this.rooms.get(code); }

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
      let snap = clone(this.rooms.get(code));
      const back = this.staleFor.get(page);
      if (back) {
        this.staleFor.delete(page);
        const h = this.history.get(code) || [];
        snap = clone(h[Math.max(0, h.length - 1 - back)]);
        this.log.push({ t: Date.now(), why: 'stale-select', code, phase: snap?.phase });
      }
      await sleep(rnd(this.opts.pollDelay));
      return { data: snap ? { data: snap } : null, error: null };
    }
    if (op === 'upsert') {
      await sleep(rnd(this.opts.rpcDelay));
      this.commit(args.row.code, clone(args.row.data), 'upsert');
      await sleep(rnd(this.opts.replyDelay));
      return { data: null, error: null };
    }
    if (op === 'rpc') {
      await sleep(rnd(this.opts.rpcDelay));
      const fail = this.failNext.get(args.name);
      if (fail) {
        this.failNext.delete(args.name);
        return { data: null, error: { message: fail } };
      }
      let result;
      try {
        result = this.rpc(args.name, args.args);
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
      await sleep(rnd(this.opts.replyDelay));
      return { data: result, error: null };
    }
    throw new Error('unknown op ' + op);
  }

  rpc(name, a) {
    const cur = this.rooms.get(a.p_code);
    if (!cur) throw new Error('room not found');
    let next = cur;
    if (name === 'patch_room') {
      for (const [k, v] of Object.entries(a.p_paths)) next = jsonbSet(next, k.split('/'), v);
    } else if (name === 'play_card') {
      next = clone(cur);
      const hand = next.hands?.[a.p_player];
      if (!hand || a.p_index < 0 || a.p_index >= hand.length) throw new Error('bad card index');
      const [card] = hand.splice(a.p_index, 1);
      next.submissions = next.submissions || {};
      next.submissions[a.p_player] = card;
      const deck = next.deck || [];
      if (deck.length) hand.splice(a.p_index, 0, deck.shift());
      next.deck = deck;
    } else {
      throw new Error('unknown rpc ' + name);
    }
    this.commit(a.p_code, next, name);
    return clone(next);
  }

  commit(code, data, why) {
    this.rooms.set(code, data);
    if (!this.history.has(code)) this.history.set(code, []);
    this.history.get(code).push(clone(data));
    this.writes++;
    this.log.push({ t: Date.now(), why, code, phase: data.phase, round: data.currentRound });
    this.broadcast(code, clone(data));
  }

  broadcast(code, data) {
    for (const [page, names] of this.subs) {
      if (!names.has('room:' + code) || page.isClosed()) continue;
      const prev = this.chains.get(page) || Promise.resolve();
      const next = prev.then(async () => {
        await sleep(rnd(this.opts.rtDelay));
        if (Math.random() < this.opts.rtDropRate || page.isClosed()) return;
        await page.evaluate(([c, d]) => window.__rtPush && window.__rtPush(c, d), [code, data]).catch(() => {});
      });
      this.chains.set(page, next);
    }
  }

  // ── REST: контент и предложения (игра и админка) ─────────────────
  tableRows(table) {
    return { memes: this.memes, situations: this.situations, suggestions: this.suggestions }[table];
  }

  // Кто делает запрос: anon (ключ игры), admin, user (вошёл, но не админ), bad (чужой/истёкший токен)
  whoIs(req) {
    const auth = req.headers().authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
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
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = this.users.find(x => x.email === body.email && x.password === body.password);
      return u ? json(200, this.issue(u.id)) : json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const uid = this.refresh.get(body.refresh_token);
      return uid ? json(200, this.issue(uid)) : json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
    }
    if (url.pathname === '/auth/v1/logout') {
      const token = (req.headers().authorization || '').replace(/^Bearer\s+/i, '');
      this.tokens.delete(token);
      return route.fulfill({ status: 204, body: '' });
    }
    return json(404, { error: 'not found' });
  }

  async handleStorage(route) {
    const req = route.request();
    if (this.secured && req.method() !== 'GET' && this.whoIs(req) !== 'admin') {
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"new row violates row-level security policy"}' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  }

  async handleRest(route) {
    const req = route.request();
    const url = new URL(req.url());
    const m = url.pathname.match(/^\/rest\/v1\/(\w+)/);
    if (!m) return route.fulfill({ status: 404, body: 'not found' });
    const who = this.whoIs(req);
    if (who === 'bad') return route.fulfill({ status: 401, contentType: 'application/json', body: '{"message":"JWT expired"}' });
    if (m[1] === 'rpc') {
      if (url.pathname !== '/rest/v1/rpc/is_admin' || !this.secured) {
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Could not find the function"}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(who === 'admin') });
    }
    const open = !this.secured || who === 'admin';
    const table = m[1];
    const rows = this.tableRows(table);
    if (!rows) return route.fulfill({ status: 404, body: 'no table' });
    if (this.contentDown) return route.fulfill({ status: 503, body: 'down' });
    if (this.opts.contentDelay && table !== 'suggestions') await sleep(this.opts.contentDelay);

    const p = url.searchParams;
    const match = r => {
      for (const [k, v] of p) {
        if (['select', 'order', 'limit'].includes(k)) continue;
        const [opr, val] = v.split(/\.(.*)/s);
        const cell = String(r[k]);
        if (opr === 'eq' && cell !== val) return false;
        if (opr === 'gt' && !(Number(r[k]) > Number(val))) return false;
      }
      return true;
    };
    const method = req.method();
    const json = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

    if (method === 'GET') {
      let out = rows.filter(match);
      if (!open) out = table === 'suggestions' ? [] : out.filter(r => r.active);
      const ord = p.get('order');
      if (ord) {
        const [col, dir] = ord.split('.');
        out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      }
      if (p.get('limit')) out = out.slice(0, Number(p.get('limit')));
      return json(out);
    }
    if (method === 'POST') {
      if (!open && table !== 'suggestions') {
        return route.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"new row violates row-level security policy"}' });
      }
      const body = JSON.parse(req.postData() || '[]');
      const list = Array.isArray(body) ? body : [body];
      const made = list.map(r => {
        const id = (rows.reduce((mx, x) => Math.max(mx, x.id), 0)) + 1;
        const row = { id, created_at: new Date().toISOString(), handled: false, active: true, ...r };
        rows.push(row);
        return row;
      });
      return json(made);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      const hit = open ? rows.filter(match) : [];
      hit.forEach(r => Object.assign(r, body));
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
