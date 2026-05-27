/* =============================================================================
 * Naam Jap — app.js (v3: username-as-identity)
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
const LS_USER_KEY = 'japa.userKey';        // lookup key (lowercased name)
const LS_USER_NAME = 'japa.userName';      // original-case display name
const LS_RANGE = 'japa.range';

// Beads page settings
const BEADS_PER_MALA = 108;
const LS_BEAD_COUNT = 'japa.beadCount';    // in-progress beads in current mala
const LS_BEAD_DATE = 'japa.beadDate';      // date that count belongs to
const LS_SOUND_ON = 'japa.soundOn';
const LS_HAPTICS_ON = 'japa.hapticsOn';
const SWIPE_MIN_DISTANCE = 40;             // px — minimum upward travel
const SWIPE_MIN_VELOCITY = 0.25;           // px/ms
const SWIPE_DEBOUNCE_MS = 180;             // protect against double-fires

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
  page: 'home',                            // 'home' | 'beads'
  beadCount: 0,                            // 0..107 in current mala
  soundOn: localStorage.getItem(LS_SOUND_ON) !== '0',
  hapticsOn: localStorage.getItem(LS_HAPTICS_ON) !== '0',
};

// ----- DOM ------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  setupScreen: $('setup-screen'),
  appScreen: $('app-screen'),
  beadsScreen: $('beads-screen'),
  bottomNav: $('bottom-nav'),
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
  // Beads page
  beadsBackBtn: $('beads-back-btn'),
  beadsMenuBtn: $('beads-menu-btn'),
  beadsMalaNum: $('beads-mala-num'),
  beadsUser: $('beads-user'),
  beadStage: $('bead-stage'),
  beadRingDots: $('bead-ring-dots'),
  beadCount: $('bead-count'),
  beadInstruction: $('bead-instruction'),
  flyingBead: $('flying-bead'),
  beadsTodayRounds: $('beads-today-rounds'),
  beadsProgressPct: $('beads-progress-pct'),
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

// ----- Beads page -----------------------------------------------------------
//
// The digital-mala page. Each upward swipe = one bead. At 108 beads we:
//   1) reset the bead counter to 0
//   2) call changeRound(+1) so the round syncs to the backend + leaderboard
//   3) show a celebration overlay
//
// In-progress bead state survives reload (saved to localStorage), but is
// scoped per-day so opening the app the next morning starts fresh.

// --- Persistence helpers ---

function loadBeadCount() {
  const savedDate = localStorage.getItem(LS_BEAD_DATE);
  const today = todayLocal();
  if (savedDate !== today) {
    // stale — wipe
    localStorage.setItem(LS_BEAD_DATE, today);
    localStorage.setItem(LS_BEAD_COUNT, '0');
    return 0;
  }
  const n = parseInt(localStorage.getItem(LS_BEAD_COUNT) || '0', 10);
  return Number.isFinite(n) && n >= 0 && n < BEADS_PER_MALA ? n : 0;
}

function saveBeadCount(n) {
  localStorage.setItem(LS_BEAD_DATE, todayLocal());
  localStorage.setItem(LS_BEAD_COUNT, String(n));
}

// --- Ring rendering (108 small dots arranged in a circle) ---

function buildBeadRing() {
  if (els.beadRingDots.childElementCount) return; // build once
  const cx = 160, cy = 160, r = 142;
  const svgNs = 'http://www.w3.org/2000/svg';
  // Start at top (12 o'clock) and go clockwise. -90deg in radians = -PI/2.
  for (let i = 0; i < BEADS_PER_MALA; i++) {
    const angle = (i / BEADS_PER_MALA) * Math.PI * 2 - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    const dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    dot.setAttribute('r', '3.2');
    dot.classList.add('dot');
    dot.dataset.idx = i;
    els.beadRingDots.appendChild(dot);
  }
}

function renderBeadRing() {
  const dots = els.beadRingDots.children;
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    d.classList.remove('filled', 'current');
    if (i < session.beadCount) d.classList.add('filled');
    if (i === session.beadCount - 1 && session.beadCount > 0) {
      d.classList.add('current');
      d.setAttribute('r', '5');
    } else {
      d.setAttribute('r', '3.2');
    }
  }
}

function renderBeadsPage() {
  els.beadCount.textContent = session.beadCount;
  els.beadsMalaNum.textContent = session.myCount + 1;
  els.beadsUser.textContent = session.name || '';
  els.beadsTodayRounds.textContent = session.myCount;
  const pct = Math.round((session.beadCount / BEADS_PER_MALA) * 100);
  els.beadsProgressPct.textContent = pct + '%';
  renderBeadRing();
}

// --- Audio: a soft bell using WebAudio (no asset file needed) ---

let audioCtx = null;
function getAudio() {
  if (!session.soundOn) return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return null; }
  }
  return audioCtx;
}

function playBeadTick() {
  const ctx = getAudio();
  if (!ctx) return;
  // Tiny, percussive click — wood-bead-on-string feel.
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, now);
  osc.frequency.exponentialRampToValueAtTime(440, now + 0.08);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.14);
}

function playMalaBell() {
  const ctx = getAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  // Two-tone temple bell: a fundamental plus a fifth, with a long decay.
  [528, 792].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.28 - i * 0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 2.4);
  });
}

// --- Haptics ---
// navigator.vibrate is not supported on iOS Safari; disable gracefully.
const supportsHaptics = typeof navigator.vibrate === 'function';

function hapticBead() {
  if (!session.hapticsOn || !supportsHaptics) return;
  navigator.vibrate(18);
}
function hapticMala() {
  if (!session.hapticsOn || !supportsHaptics) return;
  navigator.vibrate([60, 40, 60, 40, 200]);
}

// --- The core: advance one bead ---

function advanceOneBead() {
  // Hide the "swipe up to chant" hint after first bead
  els.beadInstruction.classList.add('hide');

  session.beadCount += 1;

  // Visual: flying bead animation
  els.flyingBead.classList.remove('fly');
  // Force a reflow so the animation restarts cleanly
  // eslint-disable-next-line no-unused-expressions
  els.flyingBead.offsetHeight;
  els.flyingBead.classList.add('fly');

  // Count bump
  els.beadCount.classList.remove('bump');
  // eslint-disable-next-line no-unused-expressions
  els.beadCount.offsetHeight;
  els.beadCount.classList.add('bump');

  if (session.beadCount >= BEADS_PER_MALA) {
    // Mala complete!
    completeMala();
  } else {
    hapticBead();
    playBeadTick();
    saveBeadCount(session.beadCount);
    renderBeadsPage();
  }
}

function completeMala() {
  hapticMala();
  playMalaBell();

  // Big celebration animation on the stage
  els.beadStage.classList.add('celebrate');
  setTimeout(() => els.beadStage.classList.remove('celebrate'), 1800);

  // Reset bead count and sync the new mala round to the backend.
  // We optimistically render the ring as fully filled for a beat before
  // resetting to 0, so the user sees the completion.
  session.beadCount = BEADS_PER_MALA;
  renderBeadsPage();

  setTimeout(() => {
    session.beadCount = 0;
    saveBeadCount(0);
    renderBeadsPage();
  }, 1200);

  // Sync to backend — this updates myCount + leaderboard
  changeRound(+1).then(() => {
    showMalaCompleteModal(session.myCount);
    renderBeadsPage();
  }).catch(() => {
    // changeRound already toasts on error and rolls back its own state,
    // but we still want the user to see the celebration locally.
    showMalaCompleteModal(session.myCount);
  });
}

// --- Mala-complete modal ---

function showMalaCompleteModal(totalToday) {
  const overlay = document.createElement('div');
  overlay.className = 'mala-complete-overlay';
  overlay.innerHTML = `
    <div class="mala-complete-card" role="dialog" aria-modal="true">
      <span class="om" aria-hidden="true">🕉</span>
      <h3>Mala Complete</h3>
      <p>108 beads chanted with focus. Your sadhana grows stronger.</p>
      <span class="total"></span>
      <p style="margin-bottom:24px;">malas completed today</p>
      <div class="mala-complete-actions">
        <button data-act="done">Done</button>
        <button class="primary" data-act="next">Chant another</button>
      </div>
    </div>
  `;
  overlay.querySelector('.total').textContent = totalToday;
  overlay.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    document.body.removeChild(overlay);
    if (act === 'done') navigateTo('home');
  });
  document.body.appendChild(overlay);
}

// --- Swipe-up gesture handling ---

let swipeState = null;
let lastSwipeAt = 0;

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  swipeState = {
    startX: e.clientX,
    startY: e.clientY,
    startT: performance.now(),
    pointerId: e.pointerId,
  };
  // Capture so we get the up event even if it leaves the element
  try { els.beadStage.setPointerCapture(e.pointerId); } catch {}
}

function onPointerUp(e) {
  if (!swipeState || swipeState.pointerId !== e.pointerId) return;
  const dx = e.clientX - swipeState.startX;
  const dy = e.clientY - swipeState.startY;
  const dt = performance.now() - swipeState.startT;
  const distance = Math.hypot(dx, dy);
  const velocity = distance / Math.max(dt, 1);
  swipeState = null;

  // Must be:
  //   - upward (dy negative, meaningfully so)
  //   - mostly vertical (|dy| > |dx|)
  //   - long enough, OR short but fast (flick)
  const isUp = dy < -SWIPE_MIN_DISTANCE && Math.abs(dy) > Math.abs(dx);
  const isFlick = dy < -20 && velocity > SWIPE_MIN_VELOCITY && Math.abs(dy) > Math.abs(dx);

  if (!isUp && !isFlick) return;

  // Debounce: ignore swipes that come faster than humanly chant-able
  const now = performance.now();
  if (now - lastSwipeAt < SWIPE_DEBOUNCE_MS) return;
  lastSwipeAt = now;

  advanceOneBead();
}

function onPointerCancel() { swipeState = null; }

// Also support keyboard (space/arrow up) and click as a fallback for accessibility
function onStageKey(e) {
  if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'Enter') {
    e.preventDefault();
    const now = performance.now();
    if (now - lastSwipeAt < SWIPE_DEBOUNCE_MS) return;
    lastSwipeAt = now;
    advanceOneBead();
  }
}

function bindBeadSwipe() {
  const stage = els.beadStage;
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerCancel);
  // Wheel: scrolling up on desktop also counts (nice for testing + non-touch)
  stage.addEventListener('wheel', (e) => {
    if (e.deltaY < -10) {
      const now = performance.now();
      if (now - lastSwipeAt < SWIPE_DEBOUNCE_MS) return;
      lastSwipeAt = now;
      advanceOneBead();
    }
  }, { passive: true });
  stage.tabIndex = 0;
  stage.addEventListener('keydown', onStageKey);
}

// --- Options sheet ---

function openBeadsSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'beads-sheet';
  sheet.innerHTML = `
    <div class="beads-sheet-card" role="dialog" aria-modal="true">
      <h4>Bead options</h4>
      <div class="beads-sheet-row">
        <span>Sound</span>
        <button class="beads-sheet-toggle ${session.soundOn ? 'on' : ''}" data-act="sound" aria-label="Toggle sound"></button>
      </div>
      <div class="beads-sheet-row">
        <span>Haptics${supportsHaptics ? '' : ' <small style="opacity:0.5">(not supported on this device)</small>'}</span>
        <button class="beads-sheet-toggle ${session.hapticsOn && supportsHaptics ? 'on' : ''}" data-act="haptics" aria-label="Toggle haptics" ${supportsHaptics ? '' : 'disabled style="opacity:0.35;cursor:not-allowed"'}></button>
      </div>
      <div class="beads-sheet-row">
        <span>Reset current round</span>
        <button class="danger" data-act="reset">Reset</button>
      </div>
      <div class="beads-sheet-row" style="justify-content:center;">
        <button data-act="close" style="padding:8px 22px;">Close</button>
      </div>
    </div>
  `;
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) { document.body.removeChild(sheet); return; }
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    if (act === 'sound') {
      session.soundOn = !session.soundOn;
      localStorage.setItem(LS_SOUND_ON, session.soundOn ? '1' : '0');
      e.target.classList.toggle('on', session.soundOn);
    } else if (act === 'haptics') {
      if (!supportsHaptics) return;
      session.hapticsOn = !session.hapticsOn;
      localStorage.setItem(LS_HAPTICS_ON, session.hapticsOn ? '1' : '0');
      e.target.classList.toggle('on', session.hapticsOn);
      if (session.hapticsOn) hapticBead();
    } else if (act === 'reset') {
      session.beadCount = 0;
      saveBeadCount(0);
      renderBeadsPage();
      els.beadInstruction.classList.remove('hide');
      document.body.removeChild(sheet);
      toast('Round reset', 'info');
    } else if (act === 'close') {
      document.body.removeChild(sheet);
    }
  });
  document.body.appendChild(sheet);
}

// --- Page navigation ---

function navigateTo(page) {
  session.page = page;
  if (page === 'beads') {
    els.appScreen.classList.add('hidden');
    els.beadsScreen.classList.remove('hidden');
    document.body.classList.add('beads-mode');
    session.beadCount = loadBeadCount();
    buildBeadRing();
    renderBeadsPage();
    if (session.beadCount > 0) els.beadInstruction.classList.add('hide');
    else els.beadInstruction.classList.remove('hide');
    // Resume audio context on first user interaction (browser autoplay policy)
    els.beadStage.focus({ preventScroll: true });
  } else {
    els.beadsScreen.classList.add('hidden');
    els.appScreen.classList.remove('hidden');
    document.body.classList.remove('beads-mode');
  }
  // Update nav active state
  document.querySelectorAll('#bottom-nav .nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === page);
  });
}

function bindBeadsPageEvents() {
  els.beadsBackBtn.addEventListener('click', () => navigateTo('home'));
  els.beadsMenuBtn.addEventListener('click', openBeadsSheet);
  bindBeadSwipe();
  // Bottom nav
  els.bottomNav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    navigateTo(btn.dataset.page);
  });
}

// ----- Setup / change-user --------------------------------------------------

function showSetupScreen() {
  els.setupScreen.classList.remove('hidden');
  els.appScreen.classList.add('hidden');
  els.beadsScreen.classList.add('hidden');
  els.bottomNav.classList.add('hidden');
  document.body.classList.remove('beads-mode');
  els.usernameInput.value = '';
  els.usernameInput.focus();
}

function showAppScreen() {
  els.setupScreen.classList.add('hidden');
  els.appScreen.classList.remove('hidden');
  els.beadsScreen.classList.add('hidden');
  els.bottomNav.classList.remove('hidden');
  document.body.classList.remove('beads-mode');
  els.displayUsername.textContent = session.name;
  // Reset nav state
  document.querySelectorAll('#bottom-nav .nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === 'home');
  });
  session.page = 'home';
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
  showSetupScreen();
}

// ----- Visibility-based refresh (no polling interval) -----------------------

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session.userKey) refreshAll();
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
  bindBeadsPageEvents();
}

async function init() {
  bindEvents();
  if (session.userKey && session.name) {
    showAppScreen();
    await refreshAll();
  } else {
    showSetupScreen();
  }
}

init();

// PWA: register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}

// ============================================================================
// SELF-REMINDERS
// ----------------------------------------------------------------------------
// Local daily reminder at user-chosen time. No backend, no push.
//
// Three execution paths, in order of reliability:
//   1) Notification Triggers API  (Chrome/Edge Android only): true wake-up.
//   2) Service worker fallback   : SW periodically checks if it's time.
//   3) Foreground setTimeout     : works while the tab/PWA is open.
//
// We always set up paths 2+3. Path 1 is added on top when supported.
// ============================================================================

const LS_REMIND_ON   = 'japa.remindOn';
const LS_REMIND_TIME = 'japa.remindTime';      // "HH:MM"
const LS_REMIND_LAST = 'japa.remindLastFired'; // "YYYY-MM-DD"

const reminder = {
  enabled: localStorage.getItem(LS_REMIND_ON) === '1',
  time: localStorage.getItem(LS_REMIND_TIME) || '06:00',
};

// --- Permission ---

function notificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const r = await Notification.requestPermission();
    return r;
  } catch {
    return 'denied';
  }
}

// --- Time math ---

function nextReminderDate(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setSeconds(0, 0);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

function reminderCopy() {
  // Streak-aware where possible, devotional otherwise.
  const u = cache?.byUser?.get(session.userKey);
  if (u) {
    const s = streakFor(u);
    if (s.current >= 2) {
      return {
        title: `🔥 ${s.current}-day streak`,
        body: `Keep it alive — chant today, ${session.name}`,
      };
    }
  }
  return {
    title: '🕉 Time for your sadhana',
    body: `Hare Krishna, ${session.name || 'devotee'} — your mala is waiting`,
  };
}

// --- The actual show ---

async function showReminderNow() {
  // Skip if already chanted today
  if (session.myCount > 0) return false;

  const today = todayLocal();
  if (localStorage.getItem(LS_REMIND_LAST) === today) return false; // already fired today

  if (notificationPermission() !== 'granted') return false;

  const { title, body } = reminderCopy();
  const opts = {
    body,
    icon: '/icon-192.png',   // adjust to your manifest icon
    badge: '/icon-192.png',
    tag: 'japa-daily-reminder',
    renotify: false,
    data: { kind: 'daily-reminder', url: '/' },
  };

  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, opts);
    } else if ('Notification' in window) {
      new Notification(title, opts);
    }
    localStorage.setItem(LS_REMIND_LAST, today);
    return true;
  } catch (err) {
    console.warn('reminder failed:', err);
    return false;
  }
}

// --- Scheduling ---

// Path 1: Notification Triggers (Chrome Android). True alarm, works offline.
async function scheduleNativeTrigger() {
  if (!reminder.enabled) return false;
  if (notificationPermission() !== 'granted') return false;

  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg || !('showTrigger' in Notification.prototype === false)) {
    // Feature-detect properly via TimestampTrigger
  }
  if (typeof TimestampTrigger === 'undefined') return false;

  const when = nextReminderDate(reminder.time);
  const { title, body } = reminderCopy();

  try {
    // Clear any previously scheduled trigger with same tag
    const existing = await reg.getNotifications({ tag: 'japa-daily-reminder', includeTriggered: false });
    existing.forEach((n) => n.close());

    await reg.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'japa-daily-reminder',
      showTrigger: new TimestampTrigger(when.getTime()),
      data: { kind: 'daily-reminder', url: '/' },
    });
    return true;
  } catch (err) {
    console.warn('native trigger failed:', err);
    return false;
  }
}

// Path 3: foreground timer. Fires while the page is open.
let foregroundTimer = null;
function scheduleForegroundCheck() {
  if (foregroundTimer) clearTimeout(foregroundTimer);
  if (!reminder.enabled) return;
  const when = nextReminderDate(reminder.time);
  const delay = when.getTime() - Date.now();
  // Cap delay to ~6 hours so we re-check periodically even if user keeps tab open
  const ms = Math.min(delay, 6 * 60 * 60 * 1000);
  foregroundTimer = setTimeout(() => {
    // If we've reached the actual time, fire. Otherwise just re-arm.
    if (Date.now() >= when.getTime() - 1000) {
      showReminderNow();
    }
    scheduleForegroundCheck();
  }, ms);
}

// On every app load, check if we missed today's reminder (e.g. user opened
// the app at 9 AM but reminder was set for 6 AM and didn't fire).
async function maybeFireMissedReminder() {
  if (!reminder.enabled) return;
  if (notificationPermission() !== 'granted') return;

  const [h, m] = reminder.time.split(':').map(Number);
  const now = new Date();
  const todayReminder = new Date();
  todayReminder.setHours(h, m, 0, 0);

  // If we're past today's reminder time AND haven't fired AND haven't chanted: nudge.
  if (now.getTime() >= todayReminder.getTime()) {
    await showReminderNow(); // it has its own "fired today" guard
  }
}

async function applyReminderSchedule() {
  await scheduleNativeTrigger();   // best-effort, no-op where unsupported
  scheduleForegroundCheck();
}

// --- Settings UI ---

function openHomeSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'home-sheet';

  const perm = notificationPermission();
  const supported = perm !== 'unsupported';
  const denied = perm === 'denied';

  sheet.innerHTML = `
    <div class="home-sheet-card" role="dialog" aria-modal="true">
      <h4>Settings</h4>
      <p class="sheet-sub">Daily nudge to keep your sadhana steady.</p>

      <div class="home-sheet-row">
        <span class="row-label">
          <span>Daily reminder</span>
          <span class="row-hint">Skipped if you've already chanted today</span>
        </span>
        <button class="toggle ${reminder.enabled ? 'on' : ''}" data-act="toggle" aria-label="Toggle reminder" ${supported && !denied ? '' : 'disabled'}></button>
      </div>

      <div class="home-sheet-row">
        <span class="row-label">
          <span>Time</span>
          <span class="row-hint">Brahma muhurta is traditional — pick what works for you</span>
        </span>
        <input type="time" data-act="time" value="${reminder.time}" ${reminder.enabled ? '' : 'disabled'}>
      </div>

      <div class="home-sheet-row">
        <span class="row-label">
          <span>Test reminder</span>
          <span class="row-hint">Send a notification right now</span>
        </span>
        <button class="ghost-btn" data-act="test" ${supported && !denied ? '' : 'disabled'}>Send test</button>
      </div>

      ${
        !supported
          ? `<div class="sheet-status warn">Your browser doesn't support notifications. Try Chrome on Android or Edge.</div>`
          : denied
            ? `<div class="sheet-status warn">Notifications are blocked. Enable them for this site in your browser settings.</div>`
            : (typeof TimestampTrigger === 'undefined')
              ? `<div class="sheet-status">Best-effort reminders: works on Android Chrome reliably. On iOS, fires only when the app is open or in the background briefly.</div>`
              : `<div class="sheet-status">Scheduled alarms enabled — reminders will fire even if the app is closed.</div>`
      }

      <div class="sheet-close-row">
        <button data-act="close">Close</button>
      </div>
    </div>
  `;

  sheet.addEventListener('click', async (e) => {
    if (e.target === sheet) { document.body.removeChild(sheet); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;

    if (act === 'close') {
      document.body.removeChild(sheet);
      return;
    }

    if (act === 'toggle') {
      if (!reminder.enabled) {
        const p = await requestNotificationPermission();
        if (p !== 'granted') {
          toast(
            p === 'denied'
              ? 'Permission blocked — enable in browser settings'
              : 'Notifications not available here',
            'error'
          );
          return;
        }
        reminder.enabled = true;
      } else {
        reminder.enabled = false;
        // Cancel any pending native trigger
        try {
          const reg = await navigator.serviceWorker?.getRegistration();
          const pending = await reg?.getNotifications({ tag: 'japa-daily-reminder', includeTriggered: false }) || [];
          pending.forEach((n) => n.close());
        } catch {}
      }
      localStorage.setItem(LS_REMIND_ON, reminder.enabled ? '1' : '0');
      e.target.classList.toggle('on', reminder.enabled);
      sheet.querySelector('input[type="time"]').disabled = !reminder.enabled;
      await applyReminderSchedule();
      toast(reminder.enabled ? `Reminder set for ${reminder.time}` : 'Reminder off');
    }

    if (act === 'test') {
      const p = await requestNotificationPermission();
      if (p !== 'granted') {
        toast('Permission needed for notifications', 'error');
        return;
      }
      // Bypass the "already fired today" guard for the test
      const last = localStorage.getItem(LS_REMIND_LAST);
      localStorage.removeItem(LS_REMIND_LAST);
      const myCountBackup = session.myCount;
      session.myCount = 0; // bypass the "already chanted" guard
      await showReminderNow();
      session.myCount = myCountBackup;
      if (last) localStorage.setItem(LS_REMIND_LAST, last);
      else localStorage.removeItem(LS_REMIND_LAST);
    }
  });

  sheet.addEventListener('change', async (e) => {
    if (e.target.dataset.act === 'time') {
      const val = e.target.value;
      if (!/^\d{2}:\d{2}$/.test(val)) return;
      reminder.time = val;
      localStorage.setItem(LS_REMIND_TIME, val);
      await applyReminderSchedule();
      toast(`Reminder time updated to ${val}`);
    }
  });

  document.body.appendChild(sheet);
}

// --- Wire-up ---

(function initReminders() {
  const btn = document.getElementById('home-menu-btn');
  if (btn) btn.addEventListener('click', openHomeSheet);

  // After the rest of init finishes, set up scheduling
  // (waitASec ensures cache is populated for streak-aware copy)
  setTimeout(async () => {
    if (reminder.enabled && notificationPermission() === 'granted') {
      await applyReminderSchedule();
      await maybeFireMissedReminder();
    }
  }, 1500);
})();