/* =====================================================
   Japa Counter — Google Apps Script Backend
   Deploy this as a Web App (see README for steps).

   SHEET STRUCTURE (auto-created on first run):
     Column A: date      (YYYY-MM-DD in IST)
     Column B: username  (lowercase string)
     Column C: rounds    (integer ≥ 0)

   One row per user per day.  Multiple calls update
   the same row; they never create duplicates.

   ENDPOINTS:
     GET  ?action=leaderboard           → today's leaderboard
     POST { action:"increment", username:"..." }  → +1 round
     POST { action:"decrement", username:"..." }  → -1 round (min 0)
   ===================================================== */

// Name of the sheet tab where japa data is stored.
// Change this if you want to use a different tab name.
var SHEET_NAME = 'JapaLog';

// ─────────────────────────────────────────────────────
// GET handler
// Called by the browser for read-only requests.
// ─────────────────────────────────────────────────────
function doGet(e) {
  var action = e.parameter.action;

  if (action === 'leaderboard') {
    return buildLeaderboard();
  }

  return jsonOut({ error: 'Unknown action. Use: ?action=leaderboard' });
}

// ─────────────────────────────────────────────────────
// POST handler
// Called for increment / decrement operations.
// ─────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body     = JSON.parse(e.postData.contents);
    var action   = body.action;
    var username = (body.username || '').toString().trim().toLowerCase();

    // Basic validation
    if (!username) {
      return jsonOut({ error: 'username is required' });
    }
    if (username.length > 50) {
      return jsonOut({ error: 'username must be 50 characters or fewer' });
    }
    // Only allow letters, numbers, spaces, hyphens, dots
    if (!/^[a-z0-9 .\-]+$/.test(username)) {
      return jsonOut({ error: 'username contains invalid characters' });
    }

    if (action === 'increment') {
      return changeRounds(username, +1);
    }
    if (action === 'decrement') {
      return changeRounds(username, -1);
    }

    return jsonOut({ error: 'Unknown action. Use: increment or decrement' });

  } catch (err) {
    return jsonOut({ error: 'Invalid JSON body: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────────────

/**
 * Increments or decrements rounds for a user on today's date.
 * Uses a script-level lock to prevent race conditions when
 * multiple users click at the same moment.
 *
 * @param {string} username  Validated, lowercase username.
 * @param {number} delta     +1 for increment, -1 for decrement.
 */
function changeRounds(username, delta) {
  // Acquire an exclusive lock (wait up to 8 seconds)
  var lock = LockService.getScriptLock();
  lock.waitLock(8000);

  try {
    var sheet    = getOrCreateSheet();
    var today    = getISTDate();
    var rowIndex = findUserRow(sheet, today, username);

    if (rowIndex === -1) {
      // No row yet for this user today
      if (delta < 0) {
        // Nothing to decrement — return 0 gracefully
        return jsonOut({ username: username, date: today, rounds: 0 });
      }
      // Create a new row
      sheet.appendRow([today, username, delta]);
      return jsonOut({ username: username, date: today, rounds: delta });

    } else {
      // Update existing row
      var cell        = sheet.getRange(rowIndex, 3); // column C = rounds
      var current     = Number(cell.getValue()) || 0;
      var newRounds   = Math.max(0, current + delta);
      cell.setValue(newRounds);
      return jsonOut({ username: username, date: today, rounds: newRounds });
    }

  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns today's leaderboard — all users who have logged
 * at least one round today, sorted highest to lowest.
 */
function buildLeaderboard() {
  var sheet = getOrCreateSheet();
  var today = getISTDate();
  var rows  = sheet.getDataRange().getValues(); // all rows including header

  var entries = [];
  var total   = 0;

  // Row 0 is the header; start from row 1
  for (var i = 1; i < rows.length; i++) {
    var rowDate     = rows[i][0];
    var rowUsername = rows[i][1];
    var rowRounds   = Number(rows[i][2]) || 0;

    if (rowDate === today && rowRounds > 0) {
      entries.push({ username: rowUsername, rounds: rowRounds });
      total += rowRounds;
    }
  }

  // Sort descending by rounds
  entries.sort(function(a, b) { return b.rounds - a.rounds; });

  return jsonOut({ date: today, total: total, leaderboard: entries });
}

// ─────────────────────────────────────────────────────
// SHEET HELPERS
// ─────────────────────────────────────────────────────

/**
 * Returns the JapaLog sheet, creating it with headers if it
 * doesn't exist yet.
 */
function getOrCreateSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    var header = sheet.getRange(1, 1, 1, 3);
    header.setValues([['date', 'username', 'rounds']]);
    header.setFontWeight('bold');
    header.setBackground('#FCE8D5');
    // Lock column widths for readability
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 180);
    sheet.setColumnWidth(3, 80);
  }

  return sheet;
}

/**
 * Searches for an existing row matching (date, username).
 * Returns the 1-based row number, or -1 if not found.
 *
 * Starts from row 2 to skip the header row.
 *
 * NOTE: Google Sheets auto-converts stored date strings (e.g. "2025-05-24")
 * into JavaScript Date objects when read back via getValues(). We normalise
 * the cell value back to a "yyyy-MM-dd" string before comparing.
 */
function findUserRow(sheet, date, username) {
  var data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    // Normalise: Date object → formatted string, anything else → plain string
    var rowDate = (data[i][0] instanceof Date)
      ? Utilities.formatDate(data[i][0], 'Asia/Kolkata', 'yyyy-MM-dd')
      : String(data[i][0]);

    if (rowDate === date && data[i][1] === username) {
      return i + 1; // +1 because sheet rows are 1-based
    }
  }

  return -1;
}

// ─────────────────────────────────────────────────────
// DATE / TIME HELPERS
// ─────────────────────────────────────────────────────

/**
 * Returns today's date as "YYYY-MM-DD" in Indian Standard Time
 * (UTC+5:30), regardless of where the Apps Script server runs.
 */
function getISTDate() {
  return Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
}

// ─────────────────────────────────────────────────────
// RESPONSE HELPER
// ─────────────────────────────────────────────────────

/**
 * Wraps any JS object as a JSON ContentService response.
 * Google Apps Script automatically adds CORS headers for
 * web apps deployed with "Anyone" access.
 */
function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
