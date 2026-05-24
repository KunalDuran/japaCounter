/* =============================================================================
 * Japa Counter — app.js (v3: username-as-identity)
 *
 * Backend: dynamic bbolt-crud REST on https://dyn.duranz.in (or localhost).
 *
 * Schema change vs v2:
 *   users:  key = <lookupName>  (= lowercased + trimmed display name)
 *           value = { displayName, createdAt }
 *   rounds: key = "<YYYY-MM-DD>:<lookupName>"
 *           value = { userId: <lookupName>, name: <displayName>, date, count, updatedAt }
 *
 * Why the username is the key:
 *   - Identity travels with the name, so the same person on any browser/device
 *     gets the same record by typing the same name.
 *   - Storing it lowercased+trimmed prevents "Kunal", "kunal", and " Kunal "
 *     from being three different users.
 *   - The original-case displayName is kept in the value for rendering.
 *
 * Trust model:
 *   This is a community chanting tracker. There is no password. If someone
 *   else types your name, the UI will offer them "continue as you" — the
 *   damage cap is "they inflate your round count". Bolt-on a PIN later if
 *   abuse ever becomes real.
 * ===========================================================================*/

'use strict';

// ----- Config ---------------------------------------------------------------

const API_BASE = 'https://dyn.duranz.in';
const REFRESH_MS = 15_000;
const LS_USER_KEY = 'japa.userKey';        // lookup key (lowercased name)
const LS_USER_NAME = 'japa.userName';      // original-case display name
const LS_RANGE = 'japa.range';

// Username rules — letters, digits, spaces, underscore, hyphen, dot.
// 2-30 chars. Adjust if you want to allow Devanagari, accents, etc.
const USERNAME_RE = /^[A-Za-z0-9 _.\-]{2,30}$/;

// ----- Date helpers ---------------------------------------------------------

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayLocal() { return ymd(new Date()); }
function daysAgoLocal(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d);
}
function dayDiff(aYmd, bYmd) {
  const [ay, am, ad] = aYmd.split('-').map(Number);
  const [by, bm, bd] = bYmd.split('-').map(Number);
  const a = new Date(ay, am - 1, ad).getTime();
  const b = new Date(by, bm - 1, bd).getTime();
  return Math.round((a - b) / 86_400_000);
}

// ----- Identity helpers -----------------------------------------------------

/** Normalize a display name into its lookup key. */
function toLookupKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function roundsKey(date, userKey) {
  return `${date}:${userKey}`;
}

/** Friendly "joined Apr 12" string from an ISO timestamp. */
function formatJoined(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ----- API client -----------------------------------------------------------

const api = {
  async getUser(userKey) {
    const res = await fetch(`${API_BASE}/collections/users/${encodeURIComponent(userKey)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getUser ${res.status}`);
    return res.json();
  },

  async createUser(userKey, displayName) {
    const res = await fetch(`${API_BASE}/collections/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: userKey,
        value: { displayName, createdAt: new Date().toISOString() },
      }),
    });
    // 409 means it appeared between our GET and POST (race). Treat as "exists".
    if (res.status === 409) return null;
    if (!res.ok) throw new Error(`createUser ${res.status}`);
    return res.json();
  },

  async getRounds(date, userKey) {
    const res = await fetch(
      `${API_BASE}/collections/rounds/${encodeURIComponent(roundsKey(date, userKey))}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRounds ${res.status}`);
    return res.json();
  },

  async putRounds(date, userKey, value) {
    const res = await fetch(
      `${API_BASE}/collections/rounds/${encodeURIComponent(roundsKey(date, userKey))}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }
    );
    if (!res.ok) throw new Error(`putRounds ${res.status}`);
    return res.json();
  },

  async allRounds() {
    const res = await fetch(`${API_BASE}/collections/rounds`);
    if (!res.ok) throw new Error(`allRounds ${res.status}`);
    return res.json();
  },
};

// ----- Session --------------------------------------------------------------

let session = {
  userKey: localStorage.getItem(LS_USER_KEY),
  name: localStorage.getItem(LS_USER_NAME),
  myCount: 0,
  range: localStorage.getItem(LS_RANGE) || 'today',
  view: 'totals',
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
  // confirm dialog (injected lazily)
  confirmDialog: null,
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

// ----- "Is this you?" dialog ------------------------------------------------
//
// Built in JS so index.html doesn't need new structural elements. The
// returned Promise resolves to true (yes, it's me) or false (no, different
// person).

function injectConfirmStyles() {
  if (document.getElementById('confirm-styles')) return;
  const css = document.createElement('style');
  css.id = 'confirm-styles';
  css.textContent = `
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55);
      display: flex; align-items: center; justify-content: center;
      z-index: 1000; padding: 16px;
    }
    .modal-card {
      background: #1a1a1a; color: #f3f3f3; border-radius: 14px;
      padding: 22px 22px 18px; max-width: 360px; width: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      font-family: inherit;
    }
    .modal-card h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
    .modal-card p  { margin: 0 0 18px; opacity: 0.78; font-size: 14px; line-height: 1.5; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .modal-actions button {
      padding: 9px 16px; border-radius: 999px; border: 0; cursor: pointer;
      font: inherit; font-size: 14px;
    }
    .modal-actions .btn-secondary {
      background: transparent; color: #ddd; border: 1px solid rgba(255,255,255,0.18);
    }
    .modal-actions .btn-primary {
      background: #d97706; color: #fff;
    }
    .modal-actions button:hover { filter: brightness(1.1); }
  `;
  document.head.appendChild(css);
}

function confirmReturning(displayName, joinedLabel) {
  injectConfirmStyles();
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <h3>Welcome back?</h3>
        <p>
          Someone named <strong class="mc-name"></strong>${joinedLabel ? ` joined on <strong>${joinedLabel}</strong>` : ' is already in the community'}.
          Is that you? Continuing will load that history and add today's rounds to it.
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" data-act="no">No, that's someone else</button>
          <button class="btn-primary"   data-act="yes">Yes, that's me</button>
        </div>
      </div>
    `;
    // Display name set safely (it's user input).
    backdrop.querySelector('.mc-name').textContent = displayName;

    backdrop.addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      document.body.removeChild(backdrop);
      resolve(act === 'yes');
    });

    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-act="yes"]').focus();
  });
}

// ----- Leaderboard chrome (unchanged from v2) -------------------------------

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
    b.style.visibility = session.view === 'streaks' ? 'hidden' : 'visible';
  });
  document.querySelectorAll('.lb-view').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === session.view);
  });
}

// ----- Data cache + aggregations (unchanged from v2) ------------------------

let cache = { byUser: new Map(), fetchedAt: 0 };

async function loadAndIndex() {
  const all = await api.allRounds();
  const byUser = new Map();
  for (const [, rec] of Object.entries(all)) {
    if (!rec || typeof rec.count !== 'number' || !rec.userId || !rec.date) continue;
    if (rec.count <= 0) continue;
    let u = byUser.get(rec.userId);
    if (!u) {
      u = { userId: rec.userId, name: rec.name || rec.userId, days: new Map(), _lastNameAt: '' };
      byUser.set(rec.userId, u);
    }
    if (rec.name && (rec.updatedAt || '') > u._lastNameAt) {
      u.name = rec.name;
      u._lastNameAt = rec.updatedAt || '';
    }
    u.days.set(rec.date, rec.count);
  }
  cache = { byUser, fetchedAt: Date.now() };
}

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
  rows.sort((a, b) => (b.count - a.count) || a.lastActive.localeCompare(b.lastActive));
  return rows;
}

function streakFor(user) {
  if (!user.days.size) return { current: 0, longest: 0, lastActive: '' };
  const sorted = [...user.days.keys()].sort();
  const lastActive = sorted[sorted.length - 1];
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = dayDiff(sorted[i], sorted[i - 1]);
    if (gap === 1) { run += 1; if (run > longest) longest = run; }
    else run = 1;
  }
  const today = todayLocal();
  let anchor;
  if (user.days.has(today)) anchor = today;
  else { const y = daysAgoLocal(1); anchor = user.days.has(y) ? y : null; }
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
  const today = todayLocal();
  let totalRounds = 0, devotees = 0;
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
    renderRows(streakRows(),
      (r) => `${r.current}🔥<span class="lb-secondary">best ${r.longest}</span>`,
      'streak');
    return;
  }
  const to = todayLocal();
  let from;
  switch (session.range) {
    case 'today': from = to; break;
    case '7d':    from = daysAgoLocal(6); break;
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
    const isMe = r.userId === session.userKey;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const row = document.createElement('div');
    row.className = 'leaderboard-row' + (isMe ? ' me' : '');
    row.innerHTML = `
      <span class="rank">${medal}</span>
      <span class="name"></span>
      <span class="count">${rightHtml(r)}</span>
    `;
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
    await api.putRounds(date, session.userKey, {
      userId: session.userKey,         // lowercased identity
      name: session.name,              // original-case display
      date,
      count: nextCount,
      updatedAt: new Date().toISOString(),
    });
    let u = cache.byUser.get(session.userKey);
    if (!u) {
      u = { userId: session.userKey, name: session.name, days: new Map(), _lastNameAt: '' };
      cache.byUser.set(session.userKey, u);
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
  const rec = await api.getRounds(todayLocal(), session.userKey);
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
      'updated ' + String(now.getHours()).padStart(2, '0') + ':' +
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

/**
 * The new join flow:
 *   1. Validate name (regex).
 *   2. Look up the user by lookupKey.
 *      a) Not found → register (POST /users) → log in.
 *      b) Found     → ask "is this you?" If yes, log in. If no, ask for a
 *                     different name.
 *   3. On login, persist {userKey, displayName} in localStorage.
 *
 * "Log in" here is purely client-side: we trust the user when they say yes.
 * The server has no concept of authentication.
 */
async function handleStart() {
  const raw = els.usernameInput.value;
  const displayName = raw.trim().replace(/\s+/g, ' ');

  if (!USERNAME_RE.test(displayName)) {
    toast('Name: 2–30 letters, digits, spaces, _ . -', 'error');
    els.usernameInput.focus();
    return;
  }

  const lookup = toLookupKey(displayName);
  els.startBtn.disabled = true;

  try {
    const existing = await api.getUser(lookup);

    if (existing) {
      const joined = formatJoined(existing.createdAt);
      const isMe = await confirmReturning(existing.displayName || displayName, joined);
      if (!isMe) {
        toast('Pick a different name then', 'info');
        els.usernameInput.focus();
        els.usernameInput.select();
        return;
      }
      // Continuing as the existing user — prefer their stored display casing.
      session.userKey = lookup;
      session.name = existing.displayName || displayName;
    } else {
      // Fresh registration.
      const created = await api.createUser(lookup, displayName);
      if (created === null) {
        // 409: someone took the name between our GET and POST. Re-fetch and
        // funnel through the "is this you?" path.
        const fresh = await api.getUser(lookup);
        const isMe = fresh ? await confirmReturning(fresh.displayName || displayName, formatJoined(fresh.createdAt)) : true;
        if (!isMe) { toast('Pick a different name then', 'info'); return; }
        session.userKey = lookup;
        session.name = fresh?.displayName || displayName;
      } else {
        session.userKey = lookup;
        session.name = displayName;
      }
    }

    localStorage.setItem(LS_USER_KEY, session.userKey);
    localStorage.setItem(LS_USER_NAME, session.name);
    showAppScreen();
    await refreshAll();
    startAutoRefresh();
  } catch (err) {
    console.error(err);
    toast('Could not reach the server. Is the backend up?', 'error');
  } finally {
    els.startBtn.disabled = false;
  }
}

function handleChangeUser() {
  localStorage.removeItem(LS_USER_KEY);
  localStorage.removeItem(LS_USER_NAME);
  session.userKey = null;
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
  else if (session.userKey) { refreshAll(); startAutoRefresh(); }
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
  if (session.userKey && session.name) {
    showAppScreen();
    await refreshAll();
    startAutoRefresh();
  } else {
    showSetupScreen();
  }
}

init();