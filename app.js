/* =============================================================================
 * Japa Counter — app.js
 *
 * Backend: the dynamic bbolt-crud REST service on http://localhost:8080.
 *
 * IMPORTANT — CORS:
 *   If you open this index.html as a file:// URL, fetch() calls to localhost
 *   will be blocked by the browser. Two fixes, pick one:
 *     (a) Serve the HTML through any static server on a port, AND add CORS
 *         headers to the Go backend (Access-Control-Allow-Origin: *).
 *     (b) Serve index.html + app.js + style.css from the Go backend itself
 *         (http.FileServer on "/") — then it's same-origin and CORS is moot.
 *   (b) is what I'd do for this app.
 *
 * Schema (lives in bbolt as two collections):
 *   users:  key = userId (UUID)
 *           value = { name, createdAt }
 *   rounds: key = "<YYYY-MM-DD>:<userId>"
 *           value = { userId, name, date, count, updatedAt }
 *
 * Known trade-offs (discussed before coding):
 *   - "+" is read-modify-write on the client. Race-prone across tabs. Fine for
 *     a chanting tracker; swap to a server-side /increment endpoint if it ever
 *     matters. See incrementRound() for the single swap point.
 *   - "Today" is the user's local date. The server just stores the string.
 *   - Leaderboard fetches ALL rounds and filters to today. Replace with a
 *     server-side prefix query when the dataset grows. See loadLeaderboard().
 * ===========================================================================*/

'use strict';

// ----- Config ---------------------------------------------------------------

const API_BASE = 'http://localhost:8080';
const REFRESH_MS = 15_000;
const LS_USER_ID = 'japa.userId';
const LS_USER_NAME = 'japa.userName';

// ----- Tiny helpers ---------------------------------------------------------

/** Today's date in the user's local timezone, formatted YYYY-MM-DD. */
function todayLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Compose the rounds key for a given user + date. */
function roundsKey(date, userId) {
  return `${date}:${userId}`;
}

/** UUID v4 — crypto.randomUUID is available in all modern browsers. */
function newUserId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // fallback for ancient browsers; not cryptographically great but fine here
  return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ----- API client -----------------------------------------------------------
//
// Thin layer over fetch. Keeping every HTTP call in this object means the UI
// code below never sees URLs or status codes — easier to audit and to swap
// later (e.g. when adding a real /increment endpoint).

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

  /** Get one rounds record. Returns null on 404 (i.e. nothing logged today). */
  async getRounds(date, userId) {
    const res = await fetch(
      `${API_BASE}/collections/rounds/${encodeURIComponent(roundsKey(date, userId))}`
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getRounds failed: ${res.status}`);
    return res.json();
  },

  /** Replace today's record with `value`. PUT is upsert in this backend. */
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

  /** Fetch the full rounds collection. Server returns `{}` if not created yet. */
  async allRounds() {
    const res = await fetch(`${API_BASE}/collections/rounds`);
    if (!res.ok) throw new Error(`allRounds failed: ${res.status}`);
    return res.json(); // shape: { "<date>:<userId>": <record>, ... }
  },
};

// ----- Session state --------------------------------------------------------

let session = {
  userId: localStorage.getItem(LS_USER_ID),
  name: localStorage.getItem(LS_USER_NAME),
  myCount: 0,
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

// ----- Toast (the HTML mentions one is "injected dynamically") --------------

function toast(message, kind = 'info') {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    Object.assign(t.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '10px 18px',
      borderRadius: '999px',
      background: kind === 'error' ? '#7a1f1f' : '#2b2b2b',
      color: '#fff',
      fontSize: '14px',
      opacity: '0',
      transition: 'opacity 200ms ease',
      zIndex: '9999',
      pointerEvents: 'none',
    });
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.style.background = kind === 'error' ? '#7a1f1f' : '#2b2b2b';
  t.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.style.opacity = '0'), 2200);
}

// ----- Screen routing -------------------------------------------------------

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

// ----- Setup flow -----------------------------------------------------------

async function handleStart() {
  const name = els.usernameInput.value.trim();
  if (!name) {
    toast('Please enter your name', 'error');
    els.usernameInput.focus();
    return;
  }

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
  } catch (err) {
    console.error(err);
    toast('Could not reach the server. Is the backend running?', 'error');
  } finally {
    els.startBtn.disabled = false;
  }
}

function handleChangeUser() {
  // Don't wipe rounds — those belong to the old user on the server. Just
  // forget the local identity so the next person can enter a name.
  localStorage.removeItem(LS_USER_ID);
  localStorage.removeItem(LS_USER_NAME);
  session = { userId: null, name: null, myCount: 0 };
  stopAutoRefresh();
  showSetupScreen();
}

// ----- Counter logic --------------------------------------------------------

function renderMyCount() {
  els.myRounds.textContent = session.myCount;
  els.decBtn.disabled = session.myCount <= 0;
}

/** Encouragement after a chant. Each "+" is one mala (1 round = 108 beads). */
function showEncouragement(count) {
  // Milestones first, then a generic line.
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

/**
 * Apply a delta (+1 or -1) to today's count. Read-modify-write against the
 * server. If you later add a server-side /increment endpoint, this is the
 * single function to change.
 */
async function changeRound(delta) {
  const date = todayLocal();
  const nextCount = Math.max(0, session.myCount + delta);
  if (nextCount === session.myCount) return; // already at floor

  // Optimistic update — UI feels instant. Roll back on failure.
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
    // Community numbers move when I move; refresh them but don't block.
    loadCommunity().catch((e) => console.warn('community refresh:', e));
    loadLeaderboard().catch((e) => console.warn('leaderboard refresh:', e));
  } catch (err) {
    console.error(err);
    session.myCount = previous;
    renderMyCount();
    toast('Could not save — try again', 'error');
  }
}

// ----- Loaders --------------------------------------------------------------

async function loadMyCount() {
  const date = todayLocal();
  const rec = await api.getRounds(date, session.userId);
  session.myCount = rec?.count ?? 0;
  renderMyCount();
}

/**
 * Pull all rounds, filter to today, and compute the leaderboard + community
 * stats from the same payload. One round-trip instead of two.
 *
 * TODO: when the dataset grows, replace api.allRounds() with a prefix-scoped
 * endpoint (e.g. GET /collections/rounds?prefix=2026-05-24:) on the backend.
 */
async function loadCommunityAndLeaderboard() {
  const date = todayLocal();
  const prefix = `${date}:`;
  const all = await api.allRounds();

  const todays = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix) && v && typeof v.count === 'number') {
      todays.push(v);
    }
  }

  // Community totals
  const totalRounds = todays.reduce((s, r) => s + r.count, 0);
  const totalDevotees = todays.filter((r) => r.count > 0).length;
  els.totalRounds.textContent = totalRounds;
  els.totalDevotees.textContent = totalDevotees;

  // Leaderboard: sort desc by count, tiebreak by earlier updatedAt (rewards
  // the person who got there first).
  todays.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
  });

  renderLeaderboard(todays);
}

// Split helpers kept around so changeRound() can refresh just one bit
// without re-fetching everything.
const loadCommunity = loadCommunityAndLeaderboard;
const loadLeaderboard = loadCommunityAndLeaderboard;

function renderLeaderboard(rows) {
  if (!rows.length) {
    els.leaderboardList.innerHTML =
      '<div class="loading-state">Be the first to chant today 🌸</div>';
    return;
  }

  const html = rows
    .slice(0, 20) // top 20 is plenty for one screen
    .map((r, i) => {
      const isMe = r.userId === session.userId;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      // Treat name as untrusted user input — set via textContent, not innerHTML.
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (isMe ? ' me' : '');
      row.innerHTML = `
        <span class="rank">${medal}</span>
        <span class="name"></span>
        <span class="count">${r.count}</span>
      `;
      row.querySelector('.name').textContent = r.name + (isMe ? ' (you)' : '');
      return row.outerHTML;
    })
    .join('');
  els.leaderboardList.innerHTML = html;
}

async function refreshAll() {
  try {
    els.refreshStatus.textContent = 'refreshing…';
    await Promise.all([loadMyCount(), loadCommunityAndLeaderboard()]);
    const now = new Date();
    els.refreshStatus.textContent =
      'updated ' +
      String(now.getHours()).padStart(2, '0') +
      ':' +
      String(now.getMinutes()).padStart(2, '0');
  } catch (err) {
    console.error(err);
    els.refreshStatus.textContent = 'offline';
  }
}

// ----- Auto-refresh ---------------------------------------------------------

let refreshTimer = null;
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(loadCommunityAndLeaderboard, REFRESH_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// Don't burn requests while the tab is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopAutoRefresh();
  else if (session.userId) {
    refreshAll();
    startAutoRefresh();
  }
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