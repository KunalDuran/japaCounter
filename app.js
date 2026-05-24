/* =============================================================================
 * Japa Counter — app.js (v2: time-range leaderboards + streaks)
 *
 * Backend: the dynamic bbolt-crud REST service on http://localhost:8080.
 *
 * CORS: serve index.html / app.js / style.css from the Go backend itself via
 *   http.FileServer (same-origin), or add Access-Control-Allow-Origin: * to
 *   the writeJSON/writeError helpers in main.go.
 *
 * Schema (unchanged):
 *   users:  key = userId
 *           value = { name, createdAt }
 *   rounds: key = "<YYYY-MM-DD>:<userId>"
 *           value = { userId, name, date, count, updatedAt }
 *
 * What's new vs v1:
 *   - Leaderboard has four tabs: Today / 7 days / 30 days / All-time
 *   - A second board ranks users by current streak (with longest as tiebreak)
 *   - Both are computed in JS from a single fetch of /collections/rounds.
 *     Replace with a server-side prefix endpoint when data grows; the only
 *     function that needs to change is loadAndIndex().
 * ===========================================================================*/

'use strict';

// ----- Config ---------------------------------------------------------------

const API_BASE = 'https://dyn.duranz.in';
const REFRESH_MS = 15_000;
const LS_USER_ID = 'japa.userId';
const LS_USER_NAME = 'japa.userName';
const LS_RANGE = 'japa.range'; // remember the tab the user last picked

// ----- Date helpers ---------------------------------------------------------

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's date in the user's local timezone, formatted YYYY-MM-DD. */
function todayLocal() { return ymd(new Date()); }

/** Date N days before today (local), as YYYY-MM-DD. */
function daysAgoLocal(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d);
}

/** Days between two YYYY-MM-DD strings, treating each as a local midnight. */
function dayDiff(aYmd, bYmd) {
  const [ay, am, ad] = aYmd.split('-').map(Number);
  const [by, bm, bd] = bYmd.split('-').map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((a - b) / 86_400_000);
}

function roundsKey(date, userId) { return `${date}:${userId}`; }

function newUserId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ----- API client -----------------------------------------------------------

const api = {
  async createUser(userId, name) {
    const res = await fetch(`${API_BASE}/collections/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: userId,
        value: { name, createdAt: new Date().toISOString() },
      }),
    });
    if (!res.ok) throw new Error(`createUser failed: ${res.status}`);
    return res.json();
  },

  async getRounds(date, userId) {
    const res = await fetch(
      `${API_BASE}/collections/rounds/${encodeURIComponent(roundsKey(date, userId))}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRounds failed: ${res.status}`);
    return res.json();
  },

  async putRounds(date, userId, value) {
    const res = await fetch(
      `${API_BASE}/collections/rounds/${encodeURIComponent(roundsKey(date, userId))}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }
    );
    if (!res.ok) throw new Error(`putRounds failed: ${res.status}`);
    return res.json();
  },

  async allRounds() {
    const res = await fetch(`${API_BASE}/collections/rounds`);
    if (!res.ok) throw new Error(`allRounds failed: ${res.status}`);
    return res.json(); // { "<date>:<userId>": <record>, ... }
  },
};

// ----- Session --------------------------------------------------------------

let session = {
  userId: localStorage.getItem(LS_USER_ID),
  name: localStorage.getItem(LS_USER_NAME),
  myCount: 0,
  range: localStorage.getItem(LS_RANGE) || 'today', // today | 7d | 30d | all
  view: 'totals', // totals | streaks
};

// ----- DOM ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  setupScreen: $('setup-screen'),
  appScreen: $('app-screen'),
  usernameInput: $('username-input'),
  startBtn: $('start-btn'),
  displayUsername: $('display-username'),
  changeUserBtn: $('change-user-btn'),
  myRounds: $('my-rounds'),
  incBtn: $('increment-btn'),
  decBtn: $('decrement-btn'),
  counterMsg: $('counter-message'),
  totalRounds: $('total-rounds'),
  totalDevotees: $('total-devotees'),
  leaderboardList: $('leaderboard-list'),
  refreshStatus: $('refresh-status'),
};

// ----- Toast ----------------------------------------------------------------

function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      padding: '10px 18px', borderRadius: '999px', color: '#fff',
      fontSize: '14px', opacity: '0', transition: 'opacity 200ms ease',
      zIndex: '9999', pointerEvents: 'none',
    });
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.style.background = kind === 'error' ? '#7a1f1f' : '#2b2b2b';
  t.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.style.opacity = '0'), 2200);
}

// ----- Leaderboard chrome (tabs injected once) ------------------------------

function ensureLeaderboardChrome() {
  if (document.getElementById('lb-tabs')) return;

  const header = document.querySelector('.leaderboard-header');
  if (!header) return;

  const rangeTabs = document.createElement('div');
  rangeTabs.id = 'lb-tabs';
  rangeTabs.className = 'lb-tabs';
  rangeTabs.innerHTML = `
    <button data-range="today" class="lb-tab">Today</button>
    <button data-range="7d"    class="lb-tab">7 days</button>
    <button data-range="30d"   class="lb-tab">30 days</button>
    <button data-range="all"   class="lb-tab">All-time</button>
  `;

  const viewSwitch = document.createElement('div');
  viewSwitch.id = 'lb-view-switch';
  viewSwitch.className = 'lb-view-switch';
  viewSwitch.innerHTML = `
    <button data-view="totals"  class="lb-view active">Rounds</button>
    <span class="lb-view-sep">·</span>
    <button data-view="streaks" class="lb-view">Streaks 🔥</button>
  `;

  header.after(rangeTabs);
  rangeTabs.after(viewSwitch);

  // Inline styles so this works without touching style.css. Lift into the
  // stylesheet later if you want.
  const css = document.createElement('style');
  css.textContent = `
    .lb-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0 8px; }
    .lb-tab {
      border: 1px solid rgba(255,255,255,0.12); background: transparent;
      color: inherit; padding: 6px 12px; border-radius: 999px;
      font: inherit; font-size: 13px; cursor: pointer; opacity: 0.7;
    }
    .lb-tab.active { background: rgba(255,255,255,0.08); opacity: 1; }
    .lb-view-switch { display: flex; align-items: center; gap: 8px;
      margin-bottom: 10px; font-size: 13px; }
    .lb-view { background: none; border: 0; color: inherit; cursor: pointer;
               padding: 2px 0; font: inherit; opacity: 0.55; }
    .lb-view.active { opacity: 1; text-decoration: underline;
                      text-underline-offset: 4px; }
    .lb-view-sep { opacity: 0.4; }
    .leaderboard-row.me { font-weight: 600; }
    .lb-secondary { opacity: 0.55; font-size: 12px; margin-left: 6px; }
  `;
  document.head.appendChild(css);

  rangeTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    session.range = btn.dataset.range;
    localStorage.setItem(LS_RANGE, session.range);
    renderTabs();
    renderLeaderboard();
  });

  viewSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    session.view = btn.dataset.view;
    renderTabs();
    renderLeaderboard();
  });
}

function renderTabs() {
  document.querySelectorAll('.lb-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.range === session.range);
    // Streaks view ignores the range, so dim range tabs in that mode.
    b.style.visibility = session.view === 'streaks' ? 'hidden' : 'visible';
  });
  document.querySelectorAll('.lb-view').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === session.view);
  });
}

// ----- Data cache: fetched once per refresh, indexed for fast rendering -----

let cache = {
  // byUser[userId] = { userId, name, days: Map<dateYmd, count> }
  byUser: new Map(),
  fetchedAt: 0,
};

async function loadAndIndex() {
  const all = await api.allRounds();
  const byUser = new Map();

  for (const [, rec] of Object.entries(all)) {
    if (!rec || typeof rec.count !== 'number' || !rec.userId || !rec.date) continue;
    if (rec.count <= 0) continue; // zero days don't extend streaks or totals

    let u = byUser.get(rec.userId);
    if (!u) {
      u = { userId: rec.userId, name: rec.name || 'Unknown', days: new Map(), _lastNameAt: '' };
      byUser.set(rec.userId, u);
    }
    // If a user's name changes over time, prefer the most-recent label.
    if (rec.name && (rec.updatedAt || '') > u._lastNameAt) {
      u.name = rec.name;
      u._lastNameAt = rec.updatedAt || '';
    }
    u.days.set(rec.date, rec.count);
  }

  cache = { byUser, fetchedAt: Date.now() };
}

// ----- Aggregations ---------------------------------------------------------

/** Sum each user's rounds within [from, to] inclusive. from=null => all-time. */
function totalsForRange(from, to) {
  const rows = [];
  for (const u of cache.byUser.values()) {
    let sum = 0;
    let lastActive = '';
    for (const [date, count] of u.days) {
      if (date > to) continue;
      if (from && date < from) continue;
      sum += count;
      if (date > lastActive) lastActive = date;
    }
    if (sum > 0) rows.push({ userId: u.userId, name: u.name, count: sum, lastActive });
  }
  // Higher count first; ties broken by who reached it earlier.
  rows.sort((a, b) => (b.count - a.count) || a.lastActive.localeCompare(b.lastActive));
  return rows;
}

/**
 * Streaks for one user.
 *
 * Rules (Duolingo-style):
 *   - "Day on" = count > 0 on that local date.
 *   - Current streak counts consecutive days ending at today OR yesterday.
 *     Today not yet chanted does NOT break the streak; only finishing
 *     yesterday at zero does.
 *   - Longest = longest run anywhere in history.
 */
function streakFor(user) {
  if (!user.days.size) return { current: 0, longest: 0, lastActive: '' };

  const sorted = [...user.days.keys()].sort(); // YMD strings sort correctly
  const lastActive = sorted[sorted.length - 1];

  // Longest: walk and reset on any gap != 1.
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = dayDiff(sorted[i], sorted[i - 1]);
    if (gap === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Current: anchor at today if active today, else yesterday, else 0.
  const today = todayLocal();
  let anchor;
  if (user.days.has(today)) anchor = today;
  else {
    const y = daysAgoLocal(1);
    anchor = user.days.has(y) ? y : null;
  }

  let current = 0;
  if (anchor) {
    let cursor = anchor;
    while (user.days.has(cursor)) {
      current += 1;
      const [yy, mm, dd] = cursor.split('-').map(Number);
      const prev = new Date(yy, mm - 1, dd);
      prev.setDate(prev.getDate() - 1);
      cursor = ymd(prev);
    }
  }

  return { current, longest, lastActive };
}

function streakRows() {
  const rows = [];
  for (const u of cache.byUser.values()) {
    const s = streakFor(u);
    if (s.current === 0 && s.longest === 0) continue;
    rows.push({ userId: u.userId, name: u.name, ...s });
  }
  rows.sort((a, b) =>
    (b.current - a.current) ||
    (b.longest - a.longest) ||
    b.lastActive.localeCompare(a.lastActive)
  );
  return rows;
}

// ----- Render ---------------------------------------------------------------

function renderCommunity() {
  // "Community Today" card stays today-only — it's the live pulse.
  const today = todayLocal();
  let totalRounds = 0;
  let devotees = 0;
  for (const u of cache.byUser.values()) {
    const c = u.days.get(today);
    if (c > 0) { totalRounds += c; devotees += 1; }
  }
  els.totalRounds.textContent = totalRounds;
  els.totalDevotees.textContent = devotees;
}

function renderLeaderboard() {
  ensureLeaderboardChrome();
  renderTabs();

  if (session.view === 'streaks') {
    renderRows(
      streakRows(),
      (r) => `${r.current}🔥<span class="lb-secondary">best ${r.longest}</span>`,
      'streak'
    );
    return;
  }

  const to = todayLocal();
  let from;
  switch (session.range) {
    case 'today': from = to; break;
    case '7d':    from = daysAgoLocal(6); break;   // rolling 7 incl. today
    case '30d':   from = daysAgoLocal(29); break;
    case 'all':   from = null; break;
    default:      from = to;
  }
  renderRows(totalsForRange(from, to), (r) => `${r.count}`, 'rounds');
}

function renderRows(rows, rightHtml, emptyKind) {
  if (!rows.length) {
    const empty =
      emptyKind === 'streak'
        ? 'No streaks yet — chant today and tomorrow to start one 🌱'
        : session.range === 'today'
          ? 'Be the first to chant today 🌸'
          : 'No chanting in this range yet';
    els.leaderboardList.innerHTML = `<div class="loading-state">${empty}</div>`;
    return;
  }

  els.leaderboardList.innerHTML = '';
  rows.slice(0, 20).forEach((r, i) => {
    const isMe = r.userId === session.userId;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (isMe ? ' me' : '');
    row.innerHTML = `
      <span class="rank">${medal}</span>
      <span class="name"></span>
      <span class="count">${rightHtml(r)}</span>
    `;
    // Name is user input — always set via textContent.
    row.querySelector('.name').textContent = r.name + (isMe ? ' (you)' : '');
    els.leaderboardList.appendChild(row);
  });
}

// ----- Counter --------------------------------------------------------------

function renderMyCount() {
  els.myRounds.textContent = session.myCount;
  els.decBtn.disabled = session.myCount <= 0;
}

function showEncouragement(count) {
  const milestones = {
    1: '1 mala complete! 🙏',
    4: '4 rounds — quarter of 16!',
    8: 'Halfway to 16 rounds ✨',
    16: '16 rounds complete! 🌸',
    32: '32 rounds — strong sadhana 🔥',
    64: '64 rounds — Haribol! 🌼',
    108: '108 rounds — extraordinary 🕉',
  };
  els.counterMsg.textContent =
    milestones[count] ?? (count > 0 ? `${count} rounds today` : '');
}

async function changeRound(delta) {
  const date = todayLocal();
  const nextCount = Math.max(0, session.myCount + delta);
  if (nextCount === session.myCount) return;

  const previous = session.myCount;
  session.myCount = nextCount;
  renderMyCount();
  if (delta > 0) showEncouragement(nextCount);

  try {
    await api.putRounds(date, session.userId, {
      userId: session.userId,
      name: session.name,
      date,
      count: nextCount,
      updatedAt: new Date().toISOString(),
    });
    // Mirror the change into the in-memory index so boards update instantly.
    let u = cache.byUser.get(session.userId);
    if (!u) {
      u = { userId: session.userId, name: session.name, days: new Map(), _lastNameAt: '' };
      cache.byUser.set(session.userId, u);
    }
    if (nextCount > 0) u.days.set(date, nextCount);
    else u.days.delete(date);
    renderCommunity();
    renderLeaderboard();
  } catch (err) {
    console.error(err);
    session.myCount = previous;
    renderMyCount();
    toast('Could not save — try again', 'error');
  }
}

// ----- Loaders --------------------------------------------------------------

async function loadMyCount() {
  const rec = await api.getRounds(todayLocal(), session.userId);
  session.myCount = rec?.count ?? 0;
  renderMyCount();
}

async function refreshAll() {
  try {
    els.refreshStatus.textContent = 'refreshing…';
    await Promise.all([loadMyCount(), loadAndIndex()]);
    renderCommunity();
    renderLeaderboard();
    const now = new Date();
    els.refreshStatus.textContent =
      'updated ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
  } catch (err) {
    console.error(err);
    els.refreshStatus.textContent = 'offline';
  }
}

async function refreshBoardsOnly() {
  try {
    await loadAndIndex();
    renderCommunity();
    renderLeaderboard();
  } catch (err) {
    console.warn('board refresh:', err);
  }
}

// ----- Setup / change-user --------------------------------------------------

function showSetupScreen() {
  els.setupScreen.classList.remove('hidden');
  els.appScreen.classList.add('hidden');
  els.usernameInput.value = '';
  els.usernameInput.focus();
}

function showAppScreen() {
  els.setupScreen.classList.add('hidden');
  els.appScreen.classList.remove('hidden');
  els.displayUsername.textContent = session.name;
}

async function handleStart() {
  const name = els.usernameInput.value.trim();
  if (!name) { toast('Please enter your name', 'error'); els.usernameInput.focus(); return; }

  const userId = newUserId();
  els.startBtn.disabled = true;
  try {
    await api.createUser(userId, name);
    session.userId = userId;
    session.name = name;
    localStorage.setItem(LS_USER_ID, userId);
    localStorage.setItem(LS_USER_NAME, name);
    showAppScreen();
    await refreshAll();
    startAutoRefresh();
  } catch (err) {
    console.error(err);
    toast('Could not reach the server. Is the backend running?', 'error');
  } finally {
    els.startBtn.disabled = false;
  }
}

function handleChangeUser() {
  localStorage.removeItem(LS_USER_ID);
  localStorage.removeItem(LS_USER_NAME);
  session.userId = null;
  session.name = null;
  session.myCount = 0;
  stopAutoRefresh();
  showSetupScreen();
}

// ----- Auto-refresh ---------------------------------------------------------

let refreshTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(refreshBoardsOnly, REFRESH_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else if (session.userId) { refreshAll(); startAutoRefresh(); }
});

// ----- Wire-up --------------------------------------------------------------

function bindEvents() {
  els.startBtn.addEventListener('click', handleStart);
  els.usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleStart();
  });
  els.changeUserBtn.addEventListener('click', handleChangeUser);
  els.incBtn.addEventListener('click', () => changeRound(+1));
  els.decBtn.addEventListener('click', () => changeRound(-1));
}

async function init() {
  bindEvents();
  if (session.userId && session.name) {
    showAppScreen();
    await refreshAll();
    startAutoRefresh();
  } else {
    showSetupScreen();
  }
}

init();