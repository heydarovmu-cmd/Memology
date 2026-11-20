// Общие элементы интерфейса: экраны, окна, меню, просмотр мема.
import { $, esc } from '../shared/dom.js';
import { imageUrl } from './api.js';
import { S } from './state.js';

const NO_MENU = ['screen-welcome', 'screen-create', 'screen-join'];

export const activeScreen = () => document.querySelector('.screen.active')?.id;

export function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  if (NO_MENU.includes(id)) { hideHamburger(); S.screenKey = ''; }
}

// Показать экран, перерисовав его только если он ещё не показан для этого
// шага игры (key). Иначе — лёгкое обновление (update), не сбрасывающее выбор.
export function ensureScreen(id, key, render, update) {
  if (S.screenKey !== key || activeScreen() !== id) {
    render();
    showScreen(id);
    S.screenKey = key;
  } else if (update) {
    update();
  }
}

export const openModal = id => $(id).classList.add('open');
export const closeModal = id => $(id).classList.remove('open');

// ── Меню ──────────────────────────────────────────────
export function showHamburger() {
  $('hamburger-btn').classList.add('visible');
  if (S.roomCode) $('menu-room-info').textContent = `Комната: ${S.roomCode}`;
}
export function hideHamburger() {
  $('hamburger-btn').classList.remove('visible');
  closeMenu();
}
export function toggleMenu() {
  $('side-menu').classList.toggle('open');
  $('menu-overlay').classList.toggle('open');
}
export function closeMenu() {
  $('side-menu').classList.remove('open');
  $('menu-overlay').classList.remove('open');
}

// ── Мемы ──────────────────────────────────────────────
// Название мема — служебное (часто это имя файла), игрокам его не показываем
export function memeImg(m, h = 90) {
  if (!m) return '';
  return `<img class="meme-img" src="${esc(imageUrl(m))}" alt="Мем" style="height:${h}px;width:100%;object-fit:cover;display:block">`;
}

// Просмотр мема целиком. action — необязательная кнопка {label, fn}
let lbAction = null;
export function openMeme(m, action, sub) {
  if (!m) return;
  $('lb-img').src = imageUrl(m);
  $('lb-sub').textContent = sub || '';
  lbAction = action || null;
  $('lb-acts').innerHTML = action
    ? `<button class="btn btn-secondary" data-action="closeLb">Назад</button>
       <button class="btn btn-green" id="lb-go" data-action="lbGo">${esc(action.label)}</button>`
    : '<button class="btn btn-secondary" data-action="closeLb">Закрыть</button>';
  $('lb').classList.add('open');
}

export function closeLb() {
  $('lb').classList.remove('open');
  $('lb-img').removeAttribute('src');
}

export function lbGo() {
  const a = lbAction;
  closeLb();
  if (a) a.fn();
}

// ── Конфетти на финале ────────────────────────────────
export function spawnConfetti() {
  const c = $('confetti');
  c.innerHTML = '';
  const cols = ['#C2255C', '#FFE066', '#A5D8FF', '#B2F2BB', '#E5DBFF', '#FFC9DE'];
  for (let i = 0; i < 90; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.cssText = `left:${Math.random() * 100}%;background:${cols[~~(Math.random() * cols.length)]};` +
      `width:${6 + Math.random() * 10}px;height:${6 + Math.random() * 10}px;` +
      `border-radius:${Math.random() > 0.5 ? '50%' : '3px'};` +
      `animation-duration:${1.5 + Math.random() * 2.5}s;animation-delay:${Math.random() * 1.5}s`;
    c.appendChild(el);
  }
}

// Подпись над логотипом растягивается ровно на ширину логотипа
export function scaleTagline() {
  const logo = $('main-logo'), tag = $('tagline');
  if (!logo || !tag || activeScreen() !== 'screen-welcome') return;
  tag.style.fontSize = '1rem';
  const lw = logo.getBoundingClientRect().width, tw = tag.getBoundingClientRect().width;
  if (lw && tw) tag.style.fontSize = (lw / tw) + 'rem';
}
