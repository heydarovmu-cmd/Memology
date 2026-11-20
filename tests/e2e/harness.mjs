// Тестовый стенд: несколько игроков (отдельные браузерные контексты)
// против одного FakeBackend поверх настоящего Postgres с supabase/setup.sql.
// Игра открывается с выдуманного домена https://memology.test/,
// все внешние запросы перехватываются.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeBackend } from './fake-backend.mjs';
import { startPg } from '../db/pg.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = process.env.SITE_DIR || path.resolve(HERE, '../..');
export const ORIGIN = 'https://memology.test';
const SUPA_HOST = 'dcxamyfvfoeoefcrdcqq.supabase.co';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
let browserPromise = null;
export function browser() {
  browserPromise ||= chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  return browserPromise;
}
export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
  browserPromise = null;
  if (dbPromise) await (await dbPromise).stop();
  dbPromise = null;
}

// Один Postgres на файл тестов: комнаты друг другу не мешают
let dbPromise = null;
export function database() {
  dbPromise ||= startPg();
  return dbPromise;
}

const memeSvg = id => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">
<rect width="300" height="200" fill="#e7f5ff"/><text x="150" y="115" font-size="48"
text-anchor="middle" fill="#1971c2">${id}</text></svg>`;

export class Game {
  constructor(opts = {}) {
    this.backend = new FakeBackend(opts.backend);
    this.players = [];
    this.page = opts.page || 'memology.html';
  }

  async newPlayer(label, { url, storage } = {}) {
    this.backend.db ||= await database();
    const b = await browser();
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
    await ctx.exposeBinding('__sb', (source, op, args) => this.backend.handle(source, op, args));
    await ctx.route('**/*', route => this.route(route));
    if (storage) await ctx.addInitScript(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
    const page = await ctx.newPage();
    const p = new Player(this, label, ctx, page);
    this.players.push(p);
    await p.open(url);
    return p;
  }

  async route(route) {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.join(SITE_DIR, rel);
      if (!file.startsWith(SITE_DIR)) return route.fulfill({ status: 403, body: '' });
      try {
        const body = await readFile(file);
        return route.fulfill({ status: 200, body, contentType: TYPES[path.extname(file)] || 'application/octet-stream' });
      } catch {
        return route.fulfill({ status: 404, body: 'not found' });
      }
    }
    if (url.host === 'cdn.jsdelivr.net' && url.pathname.includes('supabase-js')) {
      return route.fulfill({ path: path.join(HERE, 'fake-supabase-client.js'), contentType: 'text/javascript' });
    }
    if (url.host === SUPA_HOST && url.pathname.startsWith('/rest/')) return this.backend.handleRest(route);
    if (url.host === SUPA_HOST && url.pathname.startsWith('/storage/')) return this.backend.handleStorage(route);
    if (url.host === SUPA_HOST && url.pathname.startsWith('/auth/')) return this.backend.handleAuth(route);
    if (url.host === 'img.test') {
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: memeSvg(url.pathname.replace(/\D/g, '')) });
    }
    if (url.host === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (url.host === 'cdnjs.cloudflare.com') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.abort();
  }

  async close() {
    for (const p of this.players) await p.ctx.close().catch(() => {});
  }

  byIdx(idx) {
    return this.players.find(p => p.idx === idx);
  }

  room() { return this.backend.room(this.code); }

  errors() {
    return this.players.flatMap(p => p.errors.map(e => `[${p.label}] ${e}`));
  }

  async waitFor(fn, what, timeout = 8000) {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('Timeout: ' + what + '\n' + await this.describe());
      await sleep(40);
    }
  }

  async describe() {
    const r = this.room();
    const lines = [`backend: phase=${r?.phase} round=${r?.currentRound} reader=${r?.readerIdx} submitted=${Object.keys(r?.submitted || {})}`];
    for (const p of this.players) lines.push(`  ${p.label} idx=${p.idx} screen=${await p.screen().catch(() => '?')}`);
    return lines.join('\n');
  }

  // ── Сценарии ─────────────────────────────────────────────
  async setup(n, { rounds = 5, maxPlayers = n, names } = {}) {
    names ||= ['Агшин', 'Диля', 'Марат', 'Кянан', 'Лейла', 'Рустам', 'Нигяр', 'Камиль', 'Айгюн', 'Тогрул'];
    const host = await this.newPlayer(names[0]);
    this.code = await host.createRoom(names[0], maxPlayers, rounds);
    for (let i = 1; i < n; i++) {
      const p = await this.newPlayer(names[i]);
      await p.joinRoom(names[i], this.code);
    }
    await this.waitFor(() => Object.keys(this.room().players).length === n, 'все игроки в лобби');
    return host;
  }

  async start(host) {
    await host.waitEnabled('#lobby-start-btn');
    await host.page.click('#lobby-start-btn');
    await this.waitFor(() => this.room().phase === 'reader', 'фаза reader');
  }

  /**
   * Сыграть раунд через интерфейс.
   * winner(room) -> idx игрока, чей мем выберет судья (по умолчанию первый на столе).
   */
  async playRound({ winner, choose = 0, card = () => 0 } = {}) {
    const r0 = this.room();
    const round = r0.currentRound;
    const reader = this.byIdx(r0.readerIdx);
    await reader.waitScreen('screen-reader');
    for (const p of this.active()) if (p !== reader) await p.waitScreen('screen-waiting-sit');

    if (choose === 1) { await reader.page.click('#sh-bot'); await sleep(50); }
    const sits = (await this.backend.secrets(this.code)).sits;
    await reader.page.click(choose === 1 ? '#sh-bot' : '#sh-top');
    await this.waitFor(() => this.room().phase === 'picking' && this.room().currentRound === round, 'фаза picking');
    const situation = this.room().situation;
    if (situation !== sits[choose]) throw new Error(`Выбрана не та ситуация: ${situation}`);

    const others = this.active().filter(p => p !== reader);
    await Promise.all(others.map(async p => {
      await p.waitScreen('screen-pick');
      await p.submitCard(card(p));
    }));

    await this.waitFor(() => this.room().phase === 'judging', 'фаза judging');
    await reader.waitScreen('screen-judge');
    for (const p of others) await p.waitScreen('screen-waiting-judge');

    // Авторы на столе скрыты; тест подсматривает их в секретах сервера
    const table = this.room().tableCards;
    if (table.some(c => 'playerIdx' in c)) throw new Error('Авторы мемов видны до голосования');
    const owners = (await this.backend.secrets(this.code)).owners;
    const want = winner ? winner(this.room()) : null;
    const res = await reader.judge(want == null ? 0 : null, want == null ? null : table[owners.indexOf(want)].id);
    await this.waitFor(() => ['result', 'end'].includes(this.room().phase), 'итог раунда');
    const owner = this.room().tableCards.find(c => c.id === res.memeId)?.playerIdx;
    if (this.room().winnerIdx !== owner) {
      throw new Error(`Очко ушло не тому: судья выбрал мем ${res.memeId} (игрок ${owner}), а победителем записан ${this.room().winnerIdx}`);
    }
    return { winnerIdx: owner, phase: this.room().phase };
  }

  active() {
    const r = this.room();
    const inGame = i => r.phase === 'lobby' || r.players?.[i]?.playing;
    return this.players.filter(p => p.idx >= 0 && r.players?.[p.idx] && !r.players[p.idx].left && inGame(p.idx) && !p.gone);
  }

  async nextRound() {
    const r = this.room();
    const host = this.byIdx(r.hostIdx ?? 0);
    for (const p of this.active()) await p.waitScreen('screen-result');
    await host.page.click('#next-round-btn');
    await this.waitFor(() => this.room().phase === 'end' ||
      (this.room().phase === 'reader' && this.room().currentRound === r.currentRound + 1), 'следующий раунд');
  }

  // Карты не должны дублироваться и пропадать
  async checkCards(played) {
    const s = await this.backend.secrets(this.code);
    const ids = [...s.deck, ...Object.values(s.hands).flat()].map(c => c.id);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) throw new Error('Дубли карт: ' + dup);
    const back = ids.filter(id => played.has(id));
    if (back.length) throw new Error('Сыгранные карты вернулись в игру: ' + back);
  }
}

export class Player {
  constructor(game, label, ctx, page) {
    Object.assign(this, { game, label, ctx, page, errors: [], dialogs: [] });
    page.on('pageerror', e => this.errors.push('pageerror: ' + e.message));
    page.on('console', m => {
      if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) this.errors.push('console: ' + m.text());
    });
    page.on('dialog', d => { this.dialogs.push(d.message()); d.accept(); });
  }

  async open(url = this.game.page) {
    await this.page.goto(`${ORIGIN}/${url}`);
    await this.page.waitForLoadState('load');
  }

  async reload() {
    await this.page.reload();
    await this.page.waitForLoadState('load');
  }

  get idx() { return this._idx ?? -1; }

  async session() {
    return this.page.evaluate(() => JSON.parse(localStorage.getItem('mg_session') || 'null'));
  }

  async syncIdx() {
    const s = await this.session();
    this._idx = s ? s.idx : -1;
    return this._idx;
  }

  screen() { return this.page.evaluate(() => document.querySelector('.screen.active')?.id); }

  async waitScreen(id, timeout = 8000) {
    const ids = [].concat(id);
    try {
      await this.page.waitForFunction(ids => ids.includes(document.querySelector('.screen.active')?.id), ids, { timeout, polling: 50 });
    } catch {
      throw new Error(`${this.label}: ждали экран ${ids.join('|')}, а открыт ${await this.screen()}\n${await this.game.describe()}`);
    }
  }

  async waitEnabled(sel, timeout = 8000) {
    await this.page.waitForFunction(s => { const b = document.querySelector(s); return b && !b.disabled; }, sel, { timeout, polling: 50 });
  }

  btn(text) { return this.page.locator('.screen.active button', { hasText: text }).first(); }

  async toast() { return this.page.evaluate(() => document.getElementById('toast')?.textContent || ''); }

  async createRoom(name, players, rounds) {
    await this.btn('Создать комнату').click();
    await this.waitScreen('screen-create');
    await this.page.fill('#host-name', name);
    await this.page.locator('.players-grid .num-btn', { hasText: new RegExp(`^${players}$`) }).click();
    await this.page.locator(`.rounds-grid .num-btn[data-value="${rounds}"]`).click();
    await this.btn('Создать комнату').click();
    await this.waitScreen('screen-lobby');
    await this.syncIdx();
    return (await this.page.textContent('#lobby-code')).trim();
  }

  async fillJoin(name, code) {
    await this.btn('Войти в комнату').click();
    await this.waitScreen('screen-join');
    await this.page.fill('#join-name', name);
    await this.page.fill('#join-code', code);
  }

  async joinRoom(name, code) {
    await this.fillJoin(name, code);
    await this.page.click('#screen-join .btn-cyan');
    await this.waitScreen('screen-lobby');
    await this.syncIdx();
  }

  async submitCard(i = 0) {
    await this.page.locator('#pick-hand .hand-card').nth(i).click();
    await this.page.click('#lb-go');
    await this.waitEnabled('#submit-btn');
    await this.page.click('#submit-btn');
    await this.waitScreen(['screen-waiting-others', 'screen-waiting-judge', 'screen-result', 'screen-end']);
  }

  // Раскрыть карты и выбрать мем: по позиции на столе или по id мема
  async judge(pos, memeId) {
    await this.page.locator('#judge-table .table-card.face-down').first().click();
    await this.page.waitForSelector('#judge-table .table-card.face-up');
    if (memeId != null) {
      pos = await this.page.evaluate(id => [...document.querySelectorAll('#judge-table .table-card img')]
        .findIndex(img => img.getAttribute('src').endsWith(`/m${id}.svg`)), memeId);
      if (pos < 0) throw new Error(`Мем ${memeId} не найден на столе`);
    }
    await this.page.locator('#judge-table .table-card.face-up').nth(pos).click();
    const src = await this.page.getAttribute('#lb-img', 'src');
    await this.page.click('#lb-go');
    await this.waitEnabled('#judge-confirm-btn');
    await this.page.click('#judge-confirm-btn');
    return { memeId: Number(src.match(/m(\d+)\.svg/)[1]) };
  }

  async menu(itemText) {
    await this.page.click('#hamburger-btn');
    await this.page.locator('.side-menu button', { hasText: itemText }).click();
  }
}
