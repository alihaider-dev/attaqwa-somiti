/**
 * At-Taqwa Somiti — App API (Phase 3)
 * Standalone Google Apps Script project. It opens your Google Sheet by ID,
 * so it never clashes with the script already inside the sheet.
 *
 * Script Properties needed (Project Settings > Script properties):
 *   SHEET_ID           the long ID from the Google Sheet URL
 *   BULKSMS_API_KEY    your BulkSMSBD API key
 *   BULKSMS_SENDER_ID  your BulkSMSBD sender ID
 *   GITHUB_TOKEN       (optional) fine-grained token with Contents read/write on the PRIVATE backup repo
 * Created automatically by setup():  PEPPER, NEXT_RECEIPT
 * After updating the code: run setup() once, then installTriggers() once.
 */

const CFG = {
  TABS: {
    DASH: 'Dashboard', RECEIVE: 'Receive', INFO: 'INFORMATION', EXP: 'Expenses',
    USERS: 'App_Users', ACCTS: 'App_Accounts', AUDIT: 'App_Audit_Log',
    SMS: 'App_SMS_Log', SETTINGS: 'App_Settings', CASH: 'App_Cashbook', RECON: 'App_Reconcile',
    VOID: 'App_Voided', PENDING: 'App_Pending', DOCS: 'App_Documents', PAYIN: 'Payment Entry', SCC: 'App_SC_Collections'
  },
  MOSJID_ID: 'ATFS-0000',
  SESSION_SECONDS: 6 * 60 * 60,
  MAX_TRIES: 5,
  LOCK_MINUTES: 15,
  LOCK_MAX_MINUTES: 24 * 60,
  HASH_ROUNDS: 200
};

const USER_COLS = ['UserID', 'Name', 'Phone', 'Role', 'Perms', 'PINHash', 'Salt', 'Status', 'FailedTries', 'LockedUntil', 'LastLogin', 'LockCount', 'MustChangePin'];
const ACCT_COLS = ['MID', 'AccountName', 'HolderUserID', 'LinkedAt', 'LinkedBy', 'Reason'];
const RECEIVE_EXTRA = ['Receipt No', 'Collected By', 'Entered At', 'Entered By', 'Account', 'Donor ID', 'SC Paid Later']; // Receive H:N
const SCC_COLS = ['Date', 'MID', 'Name', 'Months', 'Amount', 'Account', 'Collected By', 'Receipt', 'Entered At', 'Entered By'];
const EXP_EXTRA = ['Paid From', 'Voucher No', 'Entered At', 'Entered By']; // Expenses F:I
const CASH_COLS = ['Date', 'Type', 'From', 'To', 'Amount', 'Note', 'Ref', 'Entered At', 'Entered By'];
const RECON_COLS = ['Date', 'Account', 'Statement Balance', 'App Balance', 'Difference', 'Note', 'Entered At', 'Entered By'];
const DEFAULT_SETTINGS = [
  ['SOMITI_NAME', 'At-Taqwa Somiti', 'Shown in app and SMS'],
  ['SERVICE_CHARGE_PER_MONTH', 20, 'Tk added per deposit month'],
  ['RECEIPT_PREFIX', 'ATS', 'Receipt format ATS-2026-0001'],
  ['SMS_ON_PAYMENT', 'YES', 'YES or NO'],
  ['MONEY_ACCOUNTS', 'Cash,Bank,bKash', 'Where money can sit (comma separated)'],
  ['REMINDERS_ON', 'NO', 'YES = monthly due reminder SMS on REMINDER_DAY'],
  ['REMINDER_DAY', 5, 'Day of month for reminders'],
  ['REMINDER_MIN_MONTHS', 1, 'Remind when at least this many months due'],
  ['INACTIVE_AFTER_MONTHS', 6, 'Flag member Inactive at this many months due'],
  ['GITHUB_BACKUP_REPO', 'alihaider-dev/attaqwa-somiti-backup', 'e.g. alihaider-dev/attaqwa-somiti-backup (private)'],
  ['DRIVE_BACKUP_KEEP', 8, 'How many weekly Drive copies to keep'],
  ['ALERT_PHONE', '', 'Admin mobile for alerts (01XXXXXXXXX)'],
  ['ALERT_OVER', 5000, 'SMS the admin for any payment/expense at or above this (Tk)'],
  ['APPROVAL_OVER', 5000, 'Expenses at or above this need a second person to approve (0 = off)']
];
const VOID_COLS = ['Voided At', 'Voided By', 'Reason', 'Tab', 'Receipt', 'MID', 'Amount', 'Original Row (JSON)'];
const PENDING_COLS = ['ID', 'Created At', 'Created By', 'Kind', 'Data', 'Status', 'Decided By', 'Decided At', 'Note'];
const DOC_COLS = ['MID', 'Type', 'File ID', 'File Name', 'Uploaded At', 'Uploaded By'];

/* ---------------- helpers ---------------- */
function props_() { return PropertiesService.getScriptProperties(); }
/* Speed: within one request, each tab is read at most once (cleared after any write). */
let SS_ = null; let MEMO_ = {};
function memo_(k, fn) { if (!(k in MEMO_)) MEMO_[k] = fn(); return MEMO_[k]; }
function bust_() { MEMO_ = {}; }
function ss_() {
  if (SS_) return SS_;
  const id = props_().getProperty('SHEET_ID');
  if (!id) throw new Error('SHEET_ID script property is missing');
  SS_ = SpreadsheetApp.openById(id);
  return SS_;
}
function sh_(name) {
  const s = ss_().getSheetByName(name);
  if (!s) throw new Error('Missing tab: ' + name);
  return s;
}
function tz_() { return Session.getScriptTimeZone() || 'Asia/Dhaka'; }
function fmtDate_(d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'd-MMM-yyyy') : String(d || ''); }
function fmtMonth_(d) { return d instanceof Date ? Utilities.formatDate(d, tz_(), 'MMM-yyyy') : String(d || ''); }
function num_(v) { if (typeof v === 'number') return v; const n = Number(String(v || '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; }
const MONTHS_ = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/** Accepts Date, "1-May-2025", "May-2025", "2025-05-01". Returns Date or null. */
function toDate_(v) {
  if (v instanceof Date && !isNaN(v)) return dateIn_(v);
  const s = String(v || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
  if (m) { const mi = MONTHS_.indexOf(m[2].toLowerCase()); if (mi >= 0) return new Date(+m[3], mi, +m[1]); }
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/);
  if (m) { const mi = MONTHS_.indexOf(m[1].toLowerCase()); if (mi >= 0) return new Date(+m[2], mi, 1); }
  return null;
}
/*
 * Time zones: the spreadsheet may use a different time zone from this script (Asia/Dhaka).
 * Dates are written as midnight IN THE SPREADSHEET'S time zone and read back by the spreadsheet's calendar day,
 * so a day or month never slips (e.g. 1-Apr written from Dhaka showing as 31-Mar in the sheet).
 */
let SS_TZ_ = null;
function ssTz_() { if (!SS_TZ_) SS_TZ_ = ss_().getSpreadsheetTimeZone() || tz_(); return SS_TZ_; }
/** Sheet date value -> local calendar date (y, m, d as shown in the sheet). */
function dateIn_(v) {
  const p = Utilities.formatDate(v, ssTz_(), 'yyyy-MM-dd').split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}
/** Local calendar date -> value to write so the sheet shows exactly that day. */
function dateOut_(d) {
  if (!(d instanceof Date) || isNaN(d)) return d;
  return Utilities.parseDate(Utilities.formatDate(d, tz_(), 'yyyy-MM-dd') + ' 00:00', ssTz_(), 'yyyy-MM-dd HH:mm');
}
function monthStart_(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths_(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
function monthKey_(d) { return d.getFullYear() * 12 + d.getMonth(); }

function readTable_(name) {
  return memo_('t:' + name, () => {
    const s = sh_(name);
    const v = s.getDataRange().getValues();
    const head = v.shift() || [];
    return { sheet: s, head: head, rows: v };
  });
}
function rowsAsObjects_(name, cols) {
  const t = readTable_(name);
  return t.rows.map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => o[c] = r[j]);
    return o;
  }).filter(o => String(o[cols[0]] || '').trim() !== '');
}
function setCells_(name, rowNum, cols, obj) {
  bust_();
  const s = sh_(name);
  const vals = cols.map(c => obj[c] === undefined ? '' : obj[c]);
  s.getRange(rowNum, 1, 1, cols.length).setValues([vals]);
}
function getSettings_() {
  return memo_('settings', () => {
    const out = {};
    readTable_(CFG.TABS.SETTINGS).rows.forEach(r => { if (r[0]) out[String(r[0]).trim()] = r[1]; });
    return out;
  });
}
function audit_(user, action, details) {
  sh_(CFG.TABS.AUDIT).appendRow([new Date(), user ? user.UserID : 'system', action, typeof details === 'string' ? details : JSON.stringify(details)]);
}
function lastFilledRow_(sheet, col) {
  const v = sheet.getRange(1, col, sheet.getMaxRows(), 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]).trim() !== '') return i + 1;
  return 1;
}

function ensureHeaders_(sheet, startCol, names) {
  const cur = sheet.getRange(1, startCol, 1, names.length).getValues()[0];
  names.forEach((n, i) => { if (String(cur[i]).trim() === '') sheet.getRange(1, startCol + i).setValue(n).setFontWeight('bold'); });
}
/* No number formats are set on Receive/Expenses: they are Sheets tables with typed columns that format dates themselves
   (setting a format there fails, and Google only reports it after the rows are already saved). */
function markDirty_() { bust_(); props_().setProperty('BACKUP_DIRTY', String(Date.now())); }

/* ---------------- one-time setup ---------------- */
/** Run once from the editor. Safe to run again: it only adds what is missing. */
function setup() {
  const ss = ss_();
  const p = props_();
  if (!p.getProperty('PEPPER')) p.setProperty('PEPPER', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('NEXT_RECEIPT')) p.setProperty('NEXT_RECEIPT', '1');

  const ensure = (name, header) => {
    let s = ss.getSheetByName(name);
    if (!s) { s = ss.insertSheet(name); s.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); s.setFrozenRows(1); }
    return s;
  };
  ensure(CFG.TABS.USERS, USER_COLS);
  ensure(CFG.TABS.ACCTS, ACCT_COLS);
  ensure(CFG.TABS.AUDIT, ['Time', 'By', 'Action', 'Details']);
  ensure(CFG.TABS.SMS, ['Time', 'To', 'Number', 'Message', 'Result']);
  ensure(CFG.TABS.CASH, CASH_COLS);
  ensure(CFG.TABS.RECON, RECON_COLS);
  ensure(CFG.TABS.VOID, VOID_COLS);
  ensure(CFG.TABS.PENDING, PENDING_COLS);
  ensure(CFG.TABS.DOCS, DOC_COLS);
  ensure(CFG.TABS.SCC, SCC_COLS);
  const st = ensure(CFG.TABS.SETTINGS, ['Key', 'Value', 'Note']);
  const haveKeys = new Set(st.getDataRange().getValues().map(r => String(r[0]).trim()));
  const addKeys = DEFAULT_SETTINGS.filter(r => !haveKeys.has(r[0]));
  if (addKeys.length) st.getRange(st.getLastRow() + 1, 1, addKeys.length, 3).setValues(addKeys);

  // New header cells to the RIGHT of existing columns (only where empty). Existing data untouched.
  ensureHeaders_(sh_(CFG.TABS.RECEIVE), 8, RECEIVE_EXTRA);
  ensureHeaders_(sh_(CFG.TABS.EXP), 6, EXP_EXTRA);
  ensureHeaders_(sh_(CFG.TABS.USERS), 12, ['LockCount', 'MustChangePin']);

  // Accounts + users: one per Member ID, each is its own Account Holder at first.
  const users = rowsAsObjects_(CFG.TABS.USERS, USER_COLS);
  const accts = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS);
  const haveU = new Set(users.map(u => u.UserID));
  const haveA = new Set(accts.map(a => a.MID));
  const info = readInfo_();
  const newU = [], newA = [];
  Object.keys(info).forEach(mid => {
    if (mid === CFG.MOSJID_ID) return;
    if (!haveA.has(mid)) newA.push([mid, info[mid].name, mid, new Date(), 'setup', 'initial import']);
    if (!haveU.has(mid)) newU.push([mid, info[mid].name, info[mid].phone, 'member', '', '', '', 'active', 0, '', '', 0, '']);
  });
  if (newA.length) sh_(CFG.TABS.ACCTS).getRange(sh_(CFG.TABS.ACCTS).getLastRow() + 1, 1, newA.length, ACCT_COLS.length).setValues(newA);
  if (newU.length) sh_(CFG.TABS.USERS).getRange(sh_(CFG.TABS.USERS).getLastRow() + 1, 1, newU.length, USER_COLS.length).setValues(newU);
  // Fill blank phone numbers on member logins from INFORMATION (fixes Phase 1 import).
  let phones = 0;
  rowsAsObjects_(CFG.TABS.USERS, USER_COLS).forEach(u => {
    if (!String(u.Phone || '').trim() && info[u.UserID] && info[u.UserID].phone) { u.Phone = info[u.UserID].phone; setCells_(CFG.TABS.USERS, u._row, USER_COLS, u); phones++; }
  });
  audit_(null, 'setup', { accountsAdded: newA.length, usersAdded: newU.length, phonesFilled: phones });
  Logger.log('Setup done. Accounts added: ' + newA.length + ', users added: ' + newU.length + ', phones filled: ' + phones);
}

/** Run once. Creates ADMIN-01 with a random PIN shown in the Execution log. Change it in the app after first login. */
function setupAdmin() {
  const pin = newPin_();
  addStaff_('ADMIN-01', 'Admin', '', 'admin', '', pin);
  Logger.log('Admin ADMIN-01 created. First PIN: ' + pin + '  (change it in the app: More > Change PIN)');
}

function addStaff_(userId, name, phone, role, perms, pin) {
  const users = rowsAsObjects_(CFG.TABS.USERS, USER_COLS);
  if (users.some(u => u.UserID === userId)) throw new Error('User exists: ' + userId);
  const salt = Utilities.getUuid();
  sh_(CFG.TABS.USERS).appendRow([userId, name, phone, role, perms || '', hash_(pin, salt), salt, 'active', 0, '', '', 0, 'YES']); bust_();
  audit_(null, 'add_staff', { userId, role });
}

/* ---------------- security ---------------- */
function hash_(pin, salt) {
  const pepper = props_().getProperty('PEPPER') || '';
  let h = salt + ':' + pin + ':' + pepper;
  for (let i = 0; i < CFG.HASH_ROUNDS; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h));
  }
  return h;
}
function newPin_() {
  // Random source is a fresh UUID (secure random), not Math.random.
  const n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16);
  return String(100000 + (n % 900000));
}

function session_(token) {
  if (!token) throw authErr_();
  const uid = CacheService.getScriptCache().get('s_' + token);
  if (!uid) throw authErr_();
  const u = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === uid);
  if (!u || u.Status !== 'active') throw authErr_();
  CacheService.getScriptCache().put('s_' + token, uid, CFG.SESSION_SECONDS); // sliding expiry
  return u;
}
function authErr_() { const e = new Error('Please log in again'); e.code = 'AUTH'; return e; }
function isStaff_(u) { return u.Role === 'admin' || u.Role === 'management'; }
function can_(u, perm) {
  if (u.Role === 'admin') return true;
  if (u.Role !== 'management') return false;
  return String(u.Perms || '').split(',').map(s => s.trim()).indexOf(perm) >= 0;
}
function requireAdmin_(u) { if (u.Role !== 'admin') throw new Error('Admin only'); }
function myMids_(u) {
  return rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS).filter(a => a.HolderUserID === u.UserID).map(a => a.MID);
}
function canSee_(u, mid) { return isStaff_(u) || myMids_(u).indexOf(mid) >= 0; }

/* ---------------- web app entry ---------------- */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'At-Taqwa Somiti API' })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let out;
  try {
    const b = JSON.parse(e.postData.contents || '{}');
    const action = b.action;
    if (action === 'login') out = login_(b);
    else {
      const u = session_(b.token);
      const routes = {
        me: () => me_(u),
        logout: () => { CacheService.getScriptCache().remove('s_' + b.token); return true; },
        changePin: () => changePin_(u, b),
        dashboard: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return readDashboard_(); },
        accounts: () => accounts_(u),
        ledger: () => ledger_(u, b.mid),
        preview: () => { if (!can_(u, 'payments')) throw new Error('Not allowed'); return preview_(b.mid, b.count); },
        payInit: () => payInit_(u),
        sendQueued: () => { if (!can_(u, 'payments')) throw new Error('Not allowed'); return sendQueued_(b.key); },
        addPayment: () => addPayment_(u, b),
        addMosjid: () => addMosjid_(u, b),
        transactions: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return transactions_(b.limit || 50); },
        users: () => { requireAdmin_(u); return listUsers_(); },
        resetPin: () => { requireAdmin_(u); return resetPin_(u, b.userId, b.sendSms); },
        setHolder: () => { requireAdmin_(u); return setHolder_(u, b.mid, b.holderUserId, b.reason); },
        addStaff: () => { requireAdmin_(u); const pin = newPin_(); addStaff_(b.userId, b.name, b.phone, b.role, b.perms, pin); return { pin }; },
        setPerms: () => { requireAdmin_(u); return setPerms_(u, b.userId, b.perms); },
        // Phase 2
        moneyAccounts: () => moneyAccounts_(),
        profile: () => profile_(u, b.mid),
        addMember: () => { requireAdmin_(u); return addMember_(u, b); },
        updateMember: () => { requireAdmin_(u); return updateMember_(u, b.mid, b.fields || {}); },
        expenses: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return listExpenses_(b.limit || 100); },
        addExpense: () => addExpense_(u, b),
        cashbook: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return cashbook_(); },
        acctLedger: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return acctLedger_(b.account, b.month); },
        addCash: () => { requireAdmin_(u); return addCash_(u, b); },
        reconcile: () => { requireAdmin_(u); return reconcile_(u, b); },
        reminders: () => { requireAdmin_(u); return reminders_(u, !!b.send); },
        backupStatus: () => { requireAdmin_(u); return backupStatus_(); },
        backupNow: () => { requireAdmin_(u); return backupFull_('manual'); },
        // Phase 3
        voidEntry: () => { requireAdmin_(u); return voidEntry_(u, b); },
        closeAccount: () => { requireAdmin_(u); return closeAccount_(u, b); },
        closePreview: () => { requireAdmin_(u); return closePreview_(b.mid); },
        pending: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return listPending_(); },
        decide: () => decidePending_(u, b.id, !!b.approve, b.note),
        monthReport: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return monthReport_(b.month); },
        collectorNames: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return collectorNames_(); },
        docs: () => listDocs_(u, b.mid),
        doc: () => getDoc_(u, b.fileId),
        uploadDoc: () => { requireAdmin_(u); return uploadDoc_(u, b); },
        dataHealth: () => { requireAdmin_(u); return dataHealth_(); },
        setUserPhone: () => { requireAdmin_(u); return setUserPhone_(u, b.userId, b.phone); },
        scDue: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return scDueList_(); },
        collectSc: () => collectSc_(u, b),
        scHistory: () => { if (!isStaff_(u)) throw new Error('Not allowed'); return scHistory_(30); }
      };
      if (!routes[action]) throw new Error('Unknown action');
      if (publicUser_(u).mustChangePin && ['me', 'logout', 'changePin'].indexOf(action) < 0) { const e2 = new Error('Set your own PIN first'); e2.code = 'PIN'; throw e2; }
      out = once_(u, action, b.rid, routes[action]);
    }
    out = { ok: true, data: out };
  } catch (err) {
    out = { ok: false, error: String(err.message || err), code: err.code || '' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- one-time save ID (stops double saves) ---------------- */
const ONCE_ACTIONS = ['addPayment', 'addMosjid', 'addExpense', 'addCash', 'reconcile', 'collectSc', 'decide', 'closeAccount', 'voidEntry', 'addMember'];
/**
 * The app sends the same rid when it retries a save it got no answer for.
 * First time: run it and remember the answer for 6 hours. Same rid again: give back the remembered answer, save nothing.
 */
function once_(u, action, rid, fn) {
  rid = String(rid || '');
  if (ONCE_ACTIONS.indexOf(action) < 0 || !rid) return fn();
  const cache = CacheService.getScriptCache();
  const key = 'r_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, u.UserID + '|' + action + '|' + rid)).slice(0, 40);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let prev;
  try { prev = cache.get(key); if (!prev) cache.put(key, 'RUNNING', 360); } finally { lock.releaseLock(); }
  if (prev === 'RUNNING') throw new Error('This save is still running. Wait a moment, then check Activity before trying again.');
  if (prev) { const r = JSON.parse(prev); if (r && typeof r === 'object') r.repeat = true; return r; }
  let out;
  try { out = fn(); } catch (e) { cache.remove(key); throw e; }
  try { cache.put(key, JSON.stringify(out), 21600); } catch (e) { /* too big to remember: fine */ }
  return out;
}

/* ---------------- auth actions ---------------- */
function login_(b) {
  const id = String(b.userId || '').trim().toUpperCase();
  const pin = String(b.pin || '').trim();
  const users = rowsAsObjects_(CFG.TABS.USERS, USER_COLS);
  const u = users.find(x => String(x.UserID).toUpperCase() === id);
  const fail = 'Wrong ID or PIN';
  if (!u || u.Status !== 'active' || !u.PINHash) throw new Error(fail);
  const now = new Date();
  if (u.LockedUntil && new Date(u.LockedUntil) > now) throw new Error('Too many tries. Try again after ' + Utilities.formatDate(new Date(u.LockedUntil), tz_(), 'd-MMM h:mm a'));
  if (hash_(pin, u.Salt) !== u.PINHash) {
    u.FailedTries = num_(u.FailedTries) + 1;
    if (u.FailedTries >= CFG.MAX_TRIES) {
      // Each lock is twice as long as the one before (15 min, 30 min, 1 h ... up to 24 h). A correct login resets it.
      const n = num_(u.LockCount);
      const mins = Math.min(CFG.LOCK_MAX_MINUTES, CFG.LOCK_MINUTES * Math.pow(2, Math.min(n, 10)));
      u.LockedUntil = new Date(now.getTime() + mins * 60000); u.FailedTries = 0; u.LockCount = n + 1;
    }
    setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
    throw new Error(fail);
  }
  u.FailedTries = 0; u.LockedUntil = ''; u.LockCount = 0; u.LastLogin = now;
  setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, u.UserID, CFG.SESSION_SECONDS);
  audit_(u, 'login', '');
  return { token, user: publicUser_(u) };
}
function publicUser_(u) { return { id: u.UserID, name: u.Name, role: u.Role, perms: String(u.Perms || '').split(',').filter(Boolean), mustChangePin: String(u.MustChangePin || '').toUpperCase() === 'YES' }; }
function me_(u) { return { user: publicUser_(u), settings: getSettings_() }; }
function changePin_(u, b) {
  if (hash_(String(b.oldPin || ''), u.Salt) !== u.PINHash) throw new Error('Old PIN is wrong');
  const np = String(b.newPin || '');
  if (!/^\d{6}$/.test(np)) throw new Error('PIN must be exactly 6 digits');
  if (/^(\d)\1{5}$/.test(np) || np === '123456' || np === '654321') throw new Error('This PIN is too easy to guess. Choose another.');
  if (np === String(b.oldPin || '')) throw new Error('New PIN must be different from the old one');
  u.Salt = Utilities.getUuid(); u.PINHash = hash_(np, u.Salt); u.MustChangePin = '';
  setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
  audit_(u, 'change_pin', '');
  return true;
}

/* ---------------- read data ---------------- */
/** INFORMATION has a few title rows; the header is the row whose column A is "MID". */
function infoSheet_() { return memo_('infoSheet', infoSheetRead_); }
function infoSheetRead_() {
  const s = sh_(CFG.TABS.INFO);
  const v = s.getDataRange().getDisplayValues();
  let hr = v.findIndex(r => String(r[0]).trim().toUpperCase() === 'MID');
  if (hr < 0) hr = 0;
  return { sheet: s, head: v[hr].map(h => String(h).trim()), headerRow: hr + 1, rows: v.slice(hr + 1), firstDataRow: hr + 2 };
}
function readInfo_() { return memo_('info', readInfoRead_); }
function readInfoRead_() {
  const t = infoSheet_();
  const mobCol = t.head.findIndex(h => /mobile/i.test(h));
  const out = {};
  t.rows.forEach((r, i) => {
    const mid = String(r[0] || '').trim();
    if (/^ATFS-\d+/.test(mid)) {
      const fields = {}; t.head.forEach((h, j) => { if (h) fields[h] = r[j]; });
      out[mid] = { mid, name: String(r[1] || '').trim(), phone: mobCol >= 0 ? String(r[mobCol] || '').trim() : '', row: t.firstDataRow + i, fields };
    }
  });
  return out;
}

/** Reads the Dashboard tab as-is (its formulas do the maths). */
function readDashboard_() { return memo_('dash', readDashboardRead_); }
function readDashboardRead_() {
  const v = sh_(CFG.TABS.DASH).getDataRange().getDisplayValues();
  const left = [], right = [];
  let tableAt = -1;
  const push = (arr, label, value) => {
    label = String(label || '').trim(); value = String(value || '').trim();
    if (!label) return;
    if (!value) { arr.push({ section: label, items: [] }); return; }
    if (!arr.length) arr.push({ section: '', items: [] });
    arr[arr.length - 1].items.push({ label, value });
  };
  for (let r = 0; r < v.length; r++) {
    if (String(v[r][0]).trim() === 'MID') { tableAt = r; break; }
    if (r === 0) { right.push({ section: '', items: [{ label: v[r][3], value: v[r][5] }] }); continue; }
    push(left, v[r][0], v[r][1]);
    push(right, v[r][3], v[r][5]);
  }
  const members = [];
  if (tableAt >= 0) {
    for (let r = tableAt + 1; r < v.length; r++) {
      const row = v[r];
      if (!/^ATFS-/.test(String(row[0]).trim())) break;
      members.push({ mid: row[0], name: row[1], monthsPaid: row[2], totalDeposit: row[3], serviceCharge: row[4], paidUpTo: row[5], status: row[6], check: row[7] });
    }
  }
  return { left: left.filter(s => s.items.length), right: right.filter(s => s.items.length), members };
}

function accounts_(u) {
  const dash = readDashboard_().members;
  const accts = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS);
  const holderOf = {}; accts.forEach(a => holderOf[a.MID] = a.HolderUserID);
  const mine = isStaff_(u) ? null : new Set(myMids_(u));
  const lim = num_(getSettings_().INACTIVE_AFTER_MONTHS) || 6;
  const sc = scDueMap_();
  // nextKey = the first unpaid month (year * 12 + month), so the phone can show the months without asking the server.
  const lastKey = {}; receiveRows_().forEach(r => { if (r.forMonth) { const k = monthKey_(r.forMonth); if (!(r.mid in lastKey) || k > lastKey[r.mid]) lastKey[r.mid] = k; } });
  const startKey = monthKey_(startMonth_());
  return dash.filter(m => !mine || mine.has(m.mid)).map(m => Object.assign({ holder: holderOf[m.mid] || '', inactive: dueMonths_(m.status) >= lim, scOwed: sc[m.mid] ? sc[m.mid].amount : 0, scMonths: sc[m.mid] ? sc[m.mid].months.length : 0, nextKey: m.mid in lastKey ? lastKey[m.mid] + 1 : startKey }, m));
}
/** Everything the payment screen needs, in ONE call. */
function payInit_(u) {
  if (!can_(u, 'payments')) throw new Error('Not allowed');
  return { accounts: accounts_(u), money: moneyAccounts_(), collectors: collectorNames_(), deposit: monthlyDeposit_(), sc: num_(getSettings_().SERVICE_CHARGE_PER_MONTH) };
}

function dueMonths_(status) { const m = String(status || '').match(/^(\d+)\s*Due/i); return m ? Number(m[1]) : 0; }

function receiveRows_() { return memo_('recv', receiveRowsRead_).slice(); }
function receiveRowsRead_() {
  const s = sh_(CFG.TABS.RECEIVE);
  const last = lastFilledRow_(s, 3);
  if (last < 2) return [];
  const v = s.getRange(2, 1, last - 1, 14).getValues();
  return v.map((r, i) => ({
    row: i + 2, date: toDate_(r[0]), forMonth: toDate_(r[1]), mid: String(r[2]).trim(), name: r[3],
    deposit: num_(r[4]), sc: num_(r[5]), remarks: String(r[6] || ''), receipt: String(r[7] || ''), collectedBy: String(r[8] || ''),
    account: String(r[11] || '').trim(), donorId: String(r[12] || '').trim(), scLater: String(r[13] || '').trim()
  })).filter(x => x.mid);
}

function ledger_(u, mid) {
  if (!canSee_(u, mid)) throw new Error('Not allowed');
  const info = readInfo_()[mid] || { name: '' };
  const rows = receiveRows_().filter(r => r.mid === mid);
  rows.sort((a, b) => (b.date - a.date) || ((b.forMonth || 0) - (a.forMonth || 0)));
  const summary = readDashboard_().members.find(m => m.mid === mid) || null;
  const don = mid === CFG.MOSJID_ID ? [] : receiveRows_().filter(r => r.mid === CFG.MOSJID_ID && r.donorId === mid).sort((a, b) => b.date - a.date);
  return {
    mid, name: info.name, phone: isStaff_(u) ? info.phone : '', summary,
    entries: rows.map(r => ({ row: r.row, date: fmtDate_(r.date), forMonth: fmtMonth_(r.forMonth), deposit: r.deposit, sc: r.sc, remarks: r.remarks, receipt: r.receipt, collectedBy: r.collectedBy })),
    donations: don.map(r => ({ date: fmtDate_(r.date), amount: r.deposit, receipt: r.receipt })),
    scOwed: (scDueMap_()[mid] || { amount: 0 }).amount
  };
}

function transactions_(limit) {
  const rows = receiveRows_();
  rows.sort((a, b) => (b.date - a.date) || (b.row - a.row));
  return rows.slice(0, Math.min(limit, 300)).map(r => ({ row: r.row, date: fmtDate_(r.date), forMonth: fmtMonth_(r.forMonth), mid: r.mid, name: r.name, deposit: r.deposit, sc: r.sc, remarks: r.remarks, receipt: r.receipt, collectedBy: r.collectedBy }));
}

/* ---------------- payments ---------------- */
function monthlyDeposit_() {
  let md = 0;
  readDashboard_().right.forEach(s => s.items.forEach(i => { if (/monthly deposit/i.test(i.label)) md = num_(i.value); }));
  return md || 1000;
}
function startMonth_() {
  let sm = null;
  readDashboard_().right.forEach(s => s.items.forEach(i => { if (/start month/i.test(i.label)) sm = toDate_(i.value); }));
  return sm ? monthStart_(sm) : new Date(2025, 4, 1);
}

/** Next unpaid months for a Member ID, continuing the serial from the last paid month. */
function nextMonths_(mid, count, rows) {
  const paid = (rows || receiveRows_()).filter(r => r.mid === mid && r.forMonth).map(r => monthKey_(r.forMonth));
  const start = startMonth_();
  let next = paid.length ? Math.max.apply(null, paid) + 1 : monthKey_(start);
  const out = [];
  for (let i = 0; i < count; i++) { const k = next + i; out.push(new Date(Math.floor(k / 12), k % 12, 1)); }
  return { months: out, lastPaid: paid.length ? (function (k) { return new Date(Math.floor(k / 12), k % 12, 1); })(Math.max.apply(null, paid)) : null };
}

function preview_(mid, count) {
  count = Math.max(1, Math.min(60, Number(count) || 1));
  if (mid === CFG.MOSJID_ID) throw new Error('Use Mosjid Fund entry');
  const info = readInfo_()[mid]; if (!info) throw new Error('Unknown Member ID');
  const sc = num_(getSettings_().SERVICE_CHARGE_PER_MONTH);
  const dep = monthlyDeposit_();
  const nm = nextMonths_(mid, count);
  return { mid, name: info.name, lastPaid: nm.lastPaid ? fmtMonth_(nm.lastPaid) : 'none', months: nm.months.map(fmtMonth_), deposit: dep, sc, total: (dep + sc) * count, scOwed: (scDueMap_()[mid] || { amount: 0 }).amount };
}

function nextReceipt_() {
  const p = props_();
  const n = Number(p.getProperty('NEXT_RECEIPT') || '1');
  p.setProperty('NEXT_RECEIPT', String(n + 1));
  const prefix = getSettings_().RECEIPT_PREFIX || 'ATS';
  return prefix + '-' + new Date().getFullYear() + '-' + ('000' + n).slice(-4);
}

function writeReceive_(rows) {
  const s = sh_(CFG.TABS.RECEIVE);
  const start = lastFilledRow_(s, 3) + 1;
  rows = rows.map(r => { const x = r.slice(); while (x.length < 14) x.push(''); x[0] = dateOut_(x[0]); x[1] = dateOut_(x[1]); return x; });
  s.getRange(start, 1, rows.length, 14).setValues(rows);
  SpreadsheetApp.flush();
  // Verify every row landed (fixes the "vanished entry" problem: we never report success unless it's really there).
  const back = s.getRange(start, 3, rows.length, 1).getValues();
  const bad = back.filter((r, i) => String(r[0]).trim() !== rows[i][2]).length;
  if (bad) throw new Error('Save check failed for ' + bad + ' row(s). Nothing confirmed. Check the Receive tab.');
  markDirty_();
  return start;
}

function addPayment_(u, b) {
  if (!can_(u, 'payments')) throw new Error('Not allowed');
  const mid = String(b.mid || '').trim();
  const count = Math.max(1, Math.min(60, Number(b.count) || 1));
  const info = readInfo_()[mid];
  if (!info || mid === CFG.MOSJID_ID) throw new Error('Choose a valid Member ID');
  const depDate = toDate_(b.depositDate) || new Date();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let result;
  try {
    const scRate = num_(getSettings_().SERVICE_CHARGE_PER_MONTH);
    const sc = b.scPaid === false ? 0 : scRate; // member may pay the service charge later
    const dep = monthlyDeposit_();
    const nm = nextMonths_(mid, count); // re-check inside the lock
    if (b.expectFirst && fmtMonth_(nm.months[0]) !== b.expectFirst) throw new Error('Months changed: someone else saved a payment for this member. The form was refreshed. Check and save again.');
    const receipt = nextReceipt_();
    const now = new Date();
    const acct = checkAccount_(b.account);
    const rows = nm.months.map(m => [depDate, m, mid, info.name, dep, sc, String(b.remarks || ''), receipt, String(b.collectedBy || ''), now, u.UserID, acct, '']);
    const at = writeReceive_(rows);
    result = { receipt, mid, name: info.name, months: nm.months.map(fmtMonth_), total: (dep + sc) * count, row: at, scSkipped: sc === 0 && scRate > 0 };
    if (b.collectOldSc) {
      const old = scCollectLocked_(u, mid, { account: acct, collectedBy: b.collectedBy, date: depDate, receipt, excludeFrom: at });
      result.oldSc = old.amount; result.total += old.amount;
    }
    audit_(u, 'add_payment', result);
  } finally { lock.releaseLock(); }
  // deferSms: the app shows "Saved" at once and asks for the SMS in a second call (a timer sends it anyway if the app never asks).
  const defer = b.deferSms === true; const queue = [];
  if (b.sendSms !== false && String(getSettings_().SMS_ON_PAYMENT).toUpperCase() === 'YES') {
    const m = result.months;
    const period = m.length === 1 ? m[0] : m[0] + ' to ' + m[m.length - 1];
    const owedNow = (scDueMap_()[mid] || { amount: 0 }).amount;
    const msg = (getSettings_().SOMITI_NAME || 'At-Taqwa Somiti') + ': ' + result.mid + ' (' + result.name + ') ' +
      (result.total).toLocaleString('en-US') + ' Tk received for ' + period + (result.oldSc ? ' + old service charge' : '') + '. Paid up to ' + m[m.length - 1] + '.' +
      (owedNow ? ' Service charge due: ' + owedNow.toLocaleString('en-US') + ' Tk.' : '') + ' Receipt ' + result.receipt;
    if (defer) {
      const h = holderPhone_(mid);
      result.wa = waLink_(h.phone, msg); result.waOnly = !normPhone_(h.phone) && !!waNumber_(h.phone);
      if (normPhone_(h.phone)) queue.push({ to: h.to, phone: h.phone, msg });
    } else {
      const s = smsToHolder_(mid, msg);
      result.sms = s.sms; result.wa = s.wa; result.waOnly = s.waOnly;
    }
  }
  if (result.total >= (num_(getSettings_().ALERT_OVER) || Infinity)) {
    const text = 'Payment ' + result.receipt + ': ' + result.total.toLocaleString('en-US') + ' Tk from ' + result.mid + ' (' + result.name + ').';
    if (defer) { const it = alertItem_(text); if (it) queue.push(it); } else alert_(text);
  }
  if (queue.length) { queueSms_(result.receipt, queue); result.smsPending = true; }
  return result;
}

/**
 * Mosjid Fund donation, split per donor. b.donors = [{ mid: 'ATFS-0002' or '', name: 'Khokon', amount: 100 }, ...]
 * One receipt number for the whole entry, one Receive row per donor (Remarks = donor name, Donor ID = member ID).
 */
function addMosjid_(u, b) {
  if (!can_(u, 'payments')) throw new Error('Not allowed');
  const info = readInfo_();
  let donors = Array.isArray(b.donors) ? b.donors : [];
  if (!donors.length && b.amount) donors = [{ mid: '', name: String(b.donors || b.name || ''), amount: b.amount }]; // old app format
  donors = donors.map(d => ({ mid: String(d.mid || '').trim(), name: String(d.name || '').trim(), amount: num_(d.amount) }))
    .filter(d => d.amount > 0);
  if (!donors.length) throw new Error('Add at least one donor with an amount');
  donors.forEach(d => {
    if (d.mid) { if (!info[d.mid]) throw new Error('Unknown donor ID ' + d.mid); d.name = d.name || info[d.mid].name; }
    if (!d.name) throw new Error('Every donor needs a name');
  });
  const depDate = toDate_(b.depositDate) || new Date();
  const fund = info[CFG.MOSJID_ID] || { name: 'Mosjid Fund' };
  const acct = checkAccount_(b.account);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let result;
  try {
    const receipt = nextReceipt_();
    const now = new Date();
    writeReceive_(donors.map(d => [depDate, monthStart_(depDate), CFG.MOSJID_ID, fund.name, d.amount, 0, d.name, receipt, String(b.collectedBy || ''), now, u.UserID, acct, d.mid]));
    const total = donors.reduce((t, d) => t + d.amount, 0);
    result = { receipt, amount: total, donors: donors.map(d => d.name + ' ' + d.amount).join(', ') };
    audit_(u, 'add_mosjid', result);
  } finally { lock.releaseLock(); }
  return result;
}

/* ---------------- SMS (BulkSMSBD) ---------------- */
function normPhone_(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return '88' + d;
  if (/^8801\d{9}$/.test(d)) return d;
  return null; // foreign or invalid numbers are skipped (logged)
}
/** WhatsApp number in international format (no +). BD 01XXXXXXXXX -> 8801XXXXXXXXX, foreign kept as typed. */
function waNumber_(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return '88' + d;
  if (/^\d{10,15}$/.test(d) && d[0] !== '0') return d;
  return null;
}
function waLink_(phone, msg) {
  const n = waNumber_(phone);
  return n ? 'https://wa.me/' + n + '?text=' + encodeURIComponent(msg) : '';
}
function holderPhone_(mid) {
  const acct = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS).find(a => a.MID === mid);
  const holder = acct ? rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === acct.HolderUserID) : null;
  return { to: holder ? holder.UserID : mid, phone: holder ? holder.Phone : (readInfo_()[mid] || {}).phone };
}
/** SMS for BD numbers; for foreign numbers (e.g. Saudi 966…) returns a WhatsApp link instead. */
function smsToHolder_(mid, msg) {
  const h = holderPhone_(mid);
  const sms = sendSms_(h.to, h.phone, msg);
  return { sms, wa: waLink_(h.phone, msg), waOnly: !normPhone_(h.phone) && !!waNumber_(h.phone) };
}
function sendSms_(to, phone, msg) {
  const num = normPhone_(phone);
  let result;
  if (!num) result = 'skipped: not a BD mobile (' + phone + ')';
  else {
    try {
      const p = props_();
      const url = 'https://bulksmsbd.net/api/smsapi?api_key=' + encodeURIComponent(p.getProperty('BULKSMS_API_KEY') || '') +
        '&type=text&number=' + num + '&senderid=' + encodeURIComponent(p.getProperty('BULKSMS_SENDER_ID') || '') +
        '&message=' + encodeURIComponent(msg);
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      result = res.getResponseCode() + ' ' + res.getContentText().slice(0, 200);
    } catch (e) { result = 'error: ' + e.message; }
  }
  sh_(CFG.TABS.SMS).appendRow([new Date(), to, num || phone, msg, result]);
  return result;
}

/* ---------------- admin tools ---------------- */
function listUsers_() {
  const accts = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS);
  return rowsAsObjects_(CFG.TABS.USERS, USER_COLS).map(u => ({
    id: u.UserID, name: u.Name, phone: u.Phone, role: u.Role, perms: u.Perms, status: u.Status,
    hasPin: !!u.PINHash, lastLogin: u.LastLogin ? fmtDate_(new Date(u.LastLogin)) : '',
    accounts: accts.filter(a => a.HolderUserID === u.UserID).map(a => a.MID)
  }));
}

function resetPin_(admin, userId, sendSms) {
  const u = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === userId);
  if (!u) throw new Error('Unknown user');
  if (u.Status !== 'active') throw new Error('This ID has no login (linked under another Account Holder)');
  const pin = newPin_();
  u.Salt = Utilities.getUuid(); u.PINHash = hash_(pin, u.Salt); u.FailedTries = 0; u.LockedUntil = ''; u.LockCount = 0; u.MustChangePin = 'YES';
  setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
  audit_(admin, 'reset_pin', { userId });
  const msg = (getSettings_().SOMITI_NAME || 'At-Taqwa Somiti') + ' app login. ID: ' + userId + ' PIN: ' + pin + '. Change it after login.';
  let sms = '';
  if (sendSms) sms = sendSms_(userId, u.Phone, msg);
  return { pin, sms, wa: waLink_(u.Phone, msg), waOnly: !normPhone_(u.Phone) && !!waNumber_(u.Phone) };
}

/**
 * Put an account (MID) under an Account Holder. Used for linking and for transfer.
 * If the MID was its own holder and held other accounts, those move too, and its login is switched off.
 */
function setHolder_(admin, mid, holderUserId, reason) {
  if (!reason) throw new Error('Reason is required');
  const users = rowsAsObjects_(CFG.TABS.USERS, USER_COLS);
  const holder = users.find(x => x.UserID === holderUserId);
  if (holder && holderUserId === mid && holder.Status === 'linked') {
    // Undo a mistaken link: the MID becomes its own Account Holder again.
    holder.Status = 'active'; setCells_(CFG.TABS.USERS, holder._row, USER_COLS, holder);
  }
  if (!holder || holder.Status !== 'active') throw new Error('Account Holder must be an active login');
  const accts = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS);
  const a = accts.find(x => x.MID === mid);
  if (!a) throw new Error('Unknown account');
  const now = new Date();
  const moved = [];
  const move = (acc) => { acc.HolderUserID = holderUserId; acc.LinkedAt = now; acc.LinkedBy = admin.UserID; acc.Reason = reason; setCells_(CFG.TABS.ACCTS, acc._row, ACCT_COLS, acc); moved.push(acc.MID); };
  move(a);
  const ownUser = users.find(x => x.UserID === mid);
  if (ownUser && holderUserId !== mid) {
    accts.filter(x => x.HolderUserID === mid && x.MID !== mid).forEach(move);
    ownUser.Status = 'linked'; setCells_(CFG.TABS.USERS, ownUser._row, USER_COLS, ownUser);
  }
  audit_(admin, 'set_holder', { moved, to: holderUserId, reason });
  sendSms_(holderUserId, holder.Phone, (getSettings_().SOMITI_NAME || 'At-Taqwa Somiti') + ': ' + moved.join(', ') + ' now linked to your app login ' + holderUserId + '.');
  return { moved, to: holderUserId };
}

function setPerms_(admin, userId, perms) {
  const u = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === userId);
  if (!u || u.Role !== 'management') throw new Error('Only management users have extra permissions');
  u.Perms = (perms || []).filter(p => ['payments', 'expenses'].indexOf(p) >= 0).join(',');
  setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
  audit_(admin, 'set_perms', { userId, perms: u.Perms });
  return true;
}


/* =====================================================================
 * PHASE 2
 * ===================================================================== */

/* ---------------- money accounts ---------------- */
function moneyAccounts_() {
  return String(getSettings_().MONEY_ACCOUNTS || 'Cash,Bank,bKash').split(',').map(x => x.trim()).filter(Boolean);
}
function checkAccount_(a) {
  const list = moneyAccounts_();
  a = String(a || '').trim() || list[0];
  if (list.indexOf(a) < 0) throw new Error('Unknown money account: ' + a);
  return a;
}

/* ---------------- members ---------------- */
const MEMBER_FIELDS = {
  name: 'MEMBER NAME', father: "Father's Name", mother: "Mother's Name", presentAddress: 'Present Address',
  permanentAddress: 'Permanent Address', profession: 'Profession', religion: 'Religion', bloodGroup: 'Blood Group',
  email: 'Email', nationality: 'Nationality', phone: 'Mobile Number', dob: 'Date of Birth', monthlyDeposit: 'Monthly Deposit',
  nominee: 'Nominee Name', nomineeRelation: 'Relation with Applicant', nomineeAddress: 'Nominee Address', nid: 'NID'
};
function colOf_(head, label) {
  const i = head.findIndex(h => h.toLowerCase() === label.toLowerCase());
  return i;
}

function profile_(u, mid) {
  if (!canSee_(u, mid)) throw new Error('Not allowed');
  const t = infoSheet_();
  const i = readInfo_()[mid]; if (!i) throw new Error('Unknown Member ID');
  const out = { mid, fields: {} };
  Object.keys(MEMBER_FIELDS).forEach(k => { const c = colOf_(t.head, MEMBER_FIELDS[k]); if (c >= 0) out.fields[k] = i.fields[t.head[c]] || ''; });
  const acct = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS).find(a => a.MID === mid);
  out.holder = acct ? acct.HolderUserID : mid;
  out.hasNidColumn = colOf_(t.head, 'NID') >= 0;
  return out;
}

function nextMid_(info) {
  let max = 0;
  Object.keys(info).forEach(m => { const n = Number(m.replace(/\D/g, '')); if (n > max) max = n; });
  return 'ATFS-' + ('0000' + (max + 1)).slice(-4);
}

function writeMemberFields_(t, rowNum, fields) {
  Object.keys(fields).forEach(k => {
    if (!MEMBER_FIELDS[k]) return;
    const c = colOf_(t.head, MEMBER_FIELDS[k]);
    if (c >= 0) t.sheet.getRange(rowNum, c + 1).setValue(String(fields[k] == null ? '' : fields[k]));
  });
}

/** Adds a member to INFORMATION (the Dashboard member table picks it up by itself), plus account + login. */
function addMember_(admin, b) {
  const f = b.fields || {};
  if (!String(f.name || '').trim()) throw new Error('Name is required');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let mid, pinInfo = null;
  try {
    const info = readInfo_();
    mid = nextMid_(info);
    const t = infoSheet_();
    const row = lastFilledRow_(t.sheet, 1) + 1;
    t.sheet.getRange(row, 1).setValue(mid);
    if (!f.monthlyDeposit) f.monthlyDeposit = monthlyDeposit_();
    writeMemberFields_(t, row, f);
    const holder = String(b.holderUserId || '').trim().toUpperCase();
    const now = new Date();
    if (holder) {
      const hu = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === holder);
      if (!hu || hu.Status !== 'active') { t.sheet.getRange(row, 1, 1, t.head.length).clearContent(); throw new Error('Account Holder ' + holder + ' is not an active login'); }
    }
    bust_();
    sh_(CFG.TABS.ACCTS).appendRow([mid, f.name, holder || mid, now, admin.UserID, holder ? 'new share account under ' + holder : 'new member']);
    sh_(CFG.TABS.USERS).appendRow([mid, f.name, f.phone || '', 'member', '', '', '', holder ? 'linked' : 'active', 0, '', '', 0, '']);
    audit_(admin, 'add_member', { mid, name: f.name, holder: holder || mid });
    markDirty_();
  } finally { lock.releaseLock(); }
  if (!b.holderUserId && b.sendPin && f.phone) pinInfo = resetPin_(admin, mid, true);
  return { mid, pin: pinInfo };
}

function updateMember_(admin, mid, fields) {
  const i = readInfo_()[mid]; if (!i) throw new Error('Unknown Member ID');
  const t = infoSheet_();
  writeMemberFields_(t, i.row, fields);
  if (fields.phone !== undefined || fields.name !== undefined) {
    const u = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === mid);
    if (u) { if (fields.phone !== undefined) u.Phone = fields.phone; if (fields.name !== undefined) u.Name = fields.name; setCells_(CFG.TABS.USERS, u._row, USER_COLS, u); }
  }
  audit_(admin, 'update_member', { mid, fields: Object.keys(fields) });
  markDirty_();
  return true;
}

/* ---------------- expenses ---------------- */
function expenseRows_() { return memo_('exp', expenseRowsRead_).slice(); }
function expenseRowsRead_() {
  const s = sh_(CFG.TABS.EXP);
  const last = lastFilledRow_(s, 3);
  if (last < 2) return [];
  return s.getRange(2, 1, last - 1, 9).getValues().map((r, i) => ({
    row: i + 2, date: toDate_(r[0]), purpose: String(r[1] || ''), amount: num_(r[2]), remarks: String(r[3] || ''),
    fund: ['Mosjid', 'Withdrawal'].indexOf(String(r[4] || '')) >= 0 ? String(r[4]) : 'Somiti', paidFrom: String(r[5] || '').trim(), voucher: String(r[6] || ''), by: String(r[8] || '')
  })).filter(x => x.amount);
}
function listExpenses_(limit) {
  const rows = expenseRows_().sort((a, b) => (b.date - a.date) || (b.row - a.row));
  const tot = { Somiti: 0, Mosjid: 0, Withdrawal: 0 }; rows.forEach(r => tot[r.fund] += r.amount);
  return { totals: tot, rows: rows.slice(0, limit).map(r => Object.assign({}, r, { date: fmtDate_(r.date) })) };
}
function addExpense_(u, b) {
  if (!can_(u, 'expenses')) throw new Error('Not allowed');
  const amount = num_(b.amount);
  if (amount <= 0) throw new Error('Enter an amount');
  const purpose = String(b.purpose || '').trim(); if (!purpose) throw new Error('Enter the purpose');
  const fund = b.fund === 'Mosjid' ? 'Mosjid' : 'Somiti'; // Dashboard counts "Mosjid" vs everything else
  const acct = checkAccount_(b.paidFrom);
  const d = toDate_(b.date) || new Date();
  const data = { date: Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'), purpose, amount, fund, paidFrom: acct, remarks: String(b.remarks || '') };
  const limit = num_(getSettings_().APPROVAL_OVER);
  if (limit > 0 && amount >= limit) {
    const id = 'PND-' + Utilities.formatDate(new Date(), tz_(), 'yyMMddHHmmss');
    sh_(CFG.TABS.PENDING).appendRow([id, new Date(), u.UserID, 'expense', JSON.stringify(data), 'pending', '', '', '']);
    audit_(u, 'expense_pending', { id, amount, purpose });
    alert_('Expense waiting for approval: ' + amount.toLocaleString('en-US') + ' Tk, ' + purpose + ' (by ' + u.UserID + ').');
    return { pending: true, id, amount };
  }
  return writeExpense_(u, data, '');
}

function writeExpense_(u, data, approvedBy) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let r;
  try { r = writeExpenseLocked_(u, data, approvedBy); } finally { lock.releaseLock(); }
  expenseAlert_(r, data);
  return r;
}
function expenseAlert_(r, data) {
  if (data.amount >= (num_(getSettings_().ALERT_OVER) || Infinity)) alert_('Expense ' + r.voucher + ': ' + data.amount.toLocaleString('en-US') + ' Tk, ' + data.purpose + ' (' + data.fund + ', from ' + data.paidFrom + ').');
}
/** Caller must hold the script lock. */
function writeExpenseLocked_(u, data, approvedBy) {
  let voucher;
  {
    const s = sh_(CFG.TABS.EXP);
    const row = lastFilledRow_(s, 3) + 1;
    voucher = nextReceipt_().replace(/^[A-Z]+/, 'EXP');
    const remarks = data.remarks + (approvedBy ? (data.remarks ? ' · ' : '') + 'approved by ' + approvedBy : '');
    s.getRange(row, 1, 1, 9).setValues([[dateOut_(toDate_(data.date) || new Date()), data.purpose, data.amount, remarks, data.fund, data.paidFrom, voucher, new Date(), u.UserID]]);
    SpreadsheetApp.flush();
    if (num_(s.getRange(row, 3).getValue()) !== data.amount) throw new Error('Save check failed. Check the Expenses tab.');
    audit_(u, 'add_expense', { voucher, amount: data.amount, fund: data.fund, acct: data.paidFrom, purpose: data.purpose, approvedBy });
    markDirty_();
  }
  return { voucher, amount: data.amount, fund: data.fund, paidFrom: data.paidFrom };
}

/* ---------------- cash book (where the money is) ---------------- */
/**
 * Balances per money account. Start = date of the first OPENING entry (balance at the START of that day).
 * From then on: + receipts into the account (Receive col L, blank = first account), - expenses paid from it,
 * +/- transfers, + bank profit, - bank charges.
 */
function cashbook_() {
  const accts = moneyAccounts_();
  const cash = rowsAsObjects_(CFG.TABS.CASH, CASH_COLS).map(r => Object.assign(r, { d: toDate_(r.Date) }));
  const openings = cash.filter(r => r.Type === 'OPENING' && r.d);
  const recon = rowsAsObjects_(CFG.TABS.RECON, RECON_COLS);
  if (!openings.length) return { started: false, accounts: accts };
  const start = new Date(Math.min.apply(null, openings.map(r => r.d.getTime())));
  const bal = {}; accts.forEach(a => bal[a] = 0);
  const add = (a, n) => { if (bal[a] === undefined) bal[a] = 0; bal[a] += n; };
  let profit = 0, charges = 0, inflow = 0, outflow = 0;
  cash.forEach(r => {
    const amt = num_(r.Amount);
    if (r.Type === 'OPENING') add(r.To, amt);
    else if (r.Type === 'TRANSFER') { add(r.From, -amt); add(r.To, amt); }
    else if (r.Type === 'BANK_PROFIT') { add(r.To, amt); profit += amt; }
    else if (r.Type === 'BANK_CHARGE') { add(r.From, -amt); charges += amt; }
    else if (r.Type === 'HANDOVER' && r.To && r.To !== accts[0]) { add(accts[0], -amt); add(r.To, amt); }
  });
  const held = {}; const key = n => String(n || '').trim().toLowerCase();
  const label = {};
  receiveRows_().forEach(r => {
    if (r.date && r.date >= start) {
      const v = r.deposit + (r.scLater ? 0 : r.sc); const a = r.account || accts[0]; add(a, v); inflow += v;
      if (a === accts[0] && key(r.collectedBy)) { const k = key(r.collectedBy); held[k] = (held[k] || 0) + v; label[k] = label[k] || r.collectedBy.trim(); }
    }
  });
  rowsAsObjects_(CFG.TABS.SCC, SCC_COLS).forEach(r => {
    const d = toDate_(r.Date); if (!d || d < start) return;
    const v = num_(r.Amount); const a = r.Account || accts[0]; add(a, v); inflow += v;
    const k = key(r['Collected By']); if (a === accts[0] && k) { held[k] = (held[k] || 0) + v; label[k] = label[k] || String(r['Collected By']).trim(); }
  });
  cash.forEach(r => { if (r.Type === 'HANDOVER' && r.d >= start) { const k = key(r.Note.split('|')[0]); held[k] = (held[k] || 0) - num_(r.Amount); label[k] = label[k] || r.Note.split('|')[0].trim(); } });
  expenseRows_().forEach(r => { if (r.date && r.date >= start) { add(r.paidFrom || accts[0], -r.amount); outflow += r.amount; } });
  const total = Object.keys(bal).reduce((t, a) => t + bal[a], 0);
  let dashTotal = null;
  readDashboard_().left.forEach(s => s.items.forEach(i => { if (/^total balance/i.test(i.label)) dashTotal = num_(i.value); }));
  const expected = dashTotal === null ? null : dashTotal + profit - charges;
  const lastRecon = {};
  recon.forEach(r => { lastRecon[r.Account] = { date: fmtDate_(toDate_(r.Date)), statement: num_(r['Statement Balance']), diff: num_(r.Difference) }; });
  return {
    started: true, start: fmtDate_(start), accounts: accts, balances: bal, total,
    sinceStart: { inflow, outflow, profit, charges },
    check: { dashboardTotal: dashTotal, expected, ok: expected === null ? null : Math.round(expected) === Math.round(total) },
    lastRecon,
    collectors: Object.keys(held).filter(k => Math.round(held[k]) !== 0).map(k => ({ name: label[k], holding: held[k] })).sort((a, b) => b.holding - a.holding),
    entries: cash.sort((a, b) => b.d - a.d).slice(0, 50).map(r => ({ row: r._row, ref: String(r.Ref || ''), date: fmtDate_(r.d), type: r.Type, from: r.From, to: r.To, amount: num_(r.Amount), note: r.Note, by: r['Entered By'] }))
  };
}

function addCash_(u, b) {
  const type = String(b.type || '');
  if (['OPENING', 'TRANSFER', 'BANK_PROFIT', 'BANK_CHARGE', 'HANDOVER'].indexOf(type) < 0) throw new Error('Unknown entry type');
  if (type === 'HANDOVER') {
    const person = String(b.person || '').trim(); if (!person) throw new Error('Who is handing over the cash?');
    const to = checkAccount_(b.to); const amt = num_(b.amount); if (amt <= 0) throw new Error('Enter an amount');
    const ref = 'CB-' + Utilities.formatDate(new Date(), tz_(), 'yyMMddHHmmss');
    // Note keeps "person|note" so collector balances can be worked out
    sh_(CFG.TABS.CASH).appendRow([dateOut_(toDate_(b.date) || new Date()), 'HANDOVER', moneyAccounts_()[0], to, amt, person + '|' + String(b.note || ''), ref, new Date(), u.UserID]);
    audit_(u, 'cashbook_handover', { person, to, amt, ref }); markDirty_();
    return { ref };
  }
  const amount = num_(b.amount);
  if (type !== 'OPENING' && amount <= 0) throw new Error('Enter an amount');
  const from = type === 'TRANSFER' || type === 'BANK_CHARGE' ? checkAccount_(b.from) : '';
  const to = type === 'TRANSFER' || type === 'BANK_PROFIT' || type === 'OPENING' ? checkAccount_(b.to) : '';
  if (type === 'TRANSFER' && from === to) throw new Error('From and To must be different');
  const date = dateOut_(toDate_(b.date) || new Date());
  const ref = 'CB-' + Utilities.formatDate(new Date(), tz_(), 'yyMMddHHmmss');
  sh_(CFG.TABS.CASH).appendRow([date, type, from, to, amount, String(b.note || ''), ref, new Date(), u.UserID]);
  audit_(u, 'cashbook_' + type.toLowerCase(), { from, to, amount, ref });
  markDirty_();
  return { ref };
}

function reconcile_(u, b) {
  const acct = checkAccount_(b.account);
  const stmt = num_(b.statementBalance);
  const cb = cashbook_();
  if (!cb.started) throw new Error('Set opening balances first');
  const appBal = cb.balances[acct] || 0;
  const diff = stmt - appBal;
  sh_(CFG.TABS.RECON).appendRow([dateOut_(toDate_(b.date) || new Date()), acct, stmt, appBal, diff, String(b.note || ''), new Date(), u.UserID]);
  audit_(u, 'reconcile', { acct, stmt, appBal, diff });
  markDirty_();
  return { account: acct, statement: stmt, app: appBal, difference: diff };
}

/** Admin: void one cash book entry (transfer, handover, bank profit/charge, opening). A copy is kept in App_Voided. */
function voidCashEntry_(u, b, reason) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let out;
  try {
    bust_();
    const s = sh_(CFG.TABS.CASH); const rn = Number(b.row);
    const r = rn >= 2 && rn <= s.getLastRow() ? s.getRange(rn, 1, 1, CASH_COLS.length).getValues()[0] : null;
    // The row must still be the SAME entry (rows move when one above is voided).
    if (!r || String(r[1]) !== String(b.type || '') || num_(r[4]) !== num_(b.amount) || String(r[6] || '') !== String(b.ref || '')) throw new Error('Entry changed since you opened it. Refresh and try again.');
    if (r[1] === 'OPENING') {
      const all = s.getRange(2, 1, s.getLastRow() - 1, 2).getValues();
      if (all.filter(x => x[1] === 'OPENING').length <= 1) throw new Error('This is the only opening balance. Add the correct one first, then void this.');
    }
    const vs = sh_(CFG.TABS.VOID);
    vs.getRange(vs.getLastRow() + 1, 1, 1, VOID_COLS.length).setValues([[new Date(), u.UserID, reason, CFG.TABS.CASH, String(r[6] || ''), '', num_(r[4]), JSON.stringify(r)]]);
    s.deleteRow(rn);
    SpreadsheetApp.flush();
    out = { voided: 1, total: num_(r[4]), tab: CFG.TABS.CASH, receipt: String(r[6] || ''), type: r[1] };
    audit_(u, 'void', Object.assign({ reason }, out));
    markDirty_();
  } finally { lock.releaseLock(); }
  alert_('VOID by ' + u.UserID + ': cash book ' + String(out.type).toLowerCase() + ' ' + out.total.toLocaleString('en-US') + ' Tk. Reason: ' + reason);
  return out;
}

/* ---------------- account ledger: every in and out of one money account, with running balance ---------------- */
/** All money movements since the cash book start, using the SAME rules as cashbook_() (a test checks the totals agree). */
function cashMoves_() {
  const accts = moneyAccounts_();
  const cash = rowsAsObjects_(CFG.TABS.CASH, CASH_COLS).map(r => Object.assign(r, { d: toDate_(r.Date) }));
  const openings = cash.filter(r => r.Type === 'OPENING' && r.d);
  if (!openings.length) return { started: false, accts, moves: [] };
  const start = new Date(Math.min.apply(null, openings.map(r => r.d.getTime())));
  const moves = []; let seq = 0;
  const mv = (d, acct, amt, text, kind, ref, ord) => { if (amt) moves.push({ d: d || start, acct, amt, text, kind, ref: ref || '', ord: ord, seq: seq++ }); };
  cash.forEach(r => {
    const amt = num_(r.Amount); const note = String(r.Note || ''); const ref = String(r.Ref || '');
    if (r.Type === 'OPENING') mv(r.d, r.To, amt, 'Opening balance', 'opening', ref, 0);
    else if (r.Type === 'TRANSFER') { mv(r.d, r.From, -amt, 'Transfer to ' + r.To + (note ? ' · ' + note : ''), 'transfer', ref, 2); mv(r.d, r.To, amt, 'Transfer from ' + r.From + (note ? ' · ' + note : ''), 'transfer', ref, 2); }
    else if (r.Type === 'BANK_PROFIT') mv(r.d, r.To, amt, 'Bank profit' + (note ? ' · ' + note : ''), 'profit', ref, 2);
    else if (r.Type === 'BANK_CHARGE') mv(r.d, r.From, -amt, 'Bank charge' + (note ? ' · ' + note : ''), 'charge', ref, 2);
    else if (r.Type === 'HANDOVER' && r.To && r.To !== accts[0]) { const who = note.split('|')[0].trim(); mv(r.d, accts[0], -amt, 'Handed into ' + r.To + ' by ' + who, 'handover', ref, 2); mv(r.d, r.To, amt, 'Cash handed in by ' + who, 'handover', ref, 2); }
  });
  // receipts: one line per receipt (not per month)
  const grp = {}; const order = [];
  receiveRows_().forEach(r => {
    if (!r.date || r.date < start) return;
    const v = r.deposit + (r.scLater ? 0 : r.sc); const a = r.account || accts[0];
    const k = r.receipt ? r.receipt + '|' + a + '|' + r.date.getTime() : 'row' + r.row;
    if (!grp[k]) { grp[k] = { d: r.date, a, v: 0, n: 0, mid: r.mid, name: r.name, receipt: r.receipt, donors: [] }; order.push(k); }
    grp[k].v += v; grp[k].n++; if (r.mid === CFG.MOSJID_ID && r.remarks) grp[k].donors.push(r.remarks);
  });
  order.forEach(k => { const g = grp[k];
    const text = g.mid === CFG.MOSJID_ID ? 'Mosjid Fund donation' + (g.donors.length ? ' · ' + g.donors.slice(0, 3).join(', ') + (g.donors.length > 3 ? ' +' + (g.donors.length - 3) : '') : '') : g.mid + ' ' + g.name + ' · ' + g.n + ' month' + (g.n > 1 ? 's' : '');
    mv(g.d, g.a, g.v, text, 'receipt', g.receipt, 1); });
  rowsAsObjects_(CFG.TABS.SCC, SCC_COLS).forEach(r => { const d = toDate_(r.Date); if (!d || d < start) return; mv(d, r.Account || accts[0], num_(r.Amount), r.MID + ' ' + r.Name + ' · late service charge', 'sc', String(r.Receipt || ''), 1); });
  expenseRows_().forEach(r => { if (r.date && r.date >= start) mv(r.date, r.paidFrom || accts[0], -r.amount, (r.fund === 'Withdrawal' ? '' : r.fund + ' expense · ') + r.purpose, 'expense', r.voucher, 3); });
  moves.sort((a, b) => (a.d - b.d) || (a.ord - b.ord) || (a.seq - b.seq));
  return { started: true, accts, start, moves };
}
function acctLedger_(account, ym) {
  const cm = cashMoves_();
  if (!cm.started) return { started: false, accounts: cm.accts };
  const acct = checkAccount_(account);
  const now = new Date(); const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  const y = m ? +m[1] : now.getFullYear(), mo = m ? +m[2] - 1 : now.getMonth();
  const from = new Date(y, mo, 1), to = new Date(y, mo + 1, 1);
  let bal = 0, opening = 0, tin = 0, tout = 0; const rows = [];
  cm.moves.forEach(x => {
    if (x.acct !== acct || x.d >= to) return;
    if (x.d < from) { bal += x.amt; opening = bal; return; }
    bal += x.amt; if (x.amt > 0) tin += x.amt; else tout -= x.amt;
    rows.push({ date: fmtDate_(x.d), text: x.text, kind: x.kind, ref: x.ref, amt: x.amt, bal });
  });
  const months = []; let k = monthKey_(cm.start); const endK = Math.max(monthKey_(now), k);
  for (; k <= endK; k++) months.push(Math.floor(k / 12) + '-' + ('0' + (k % 12 + 1)).slice(-2));
  return { started: true, account: acct, accounts: cm.accts, month: y + '-' + ('0' + (mo + 1)).slice(-2), label: Utilities.formatDate(from, tz_(), 'MMMM yyyy'), months, opening, totalIn: tin, totalOut: tout, closing: bal, rows };
}

/* ---------------- due reminders ---------------- */
function reminders_(u, send) {
  const st = getSettings_();
  const min = num_(st.REMINDER_MIN_MONTHS) || 1;
  const dep = monthlyDeposit_();
  const name = st.SOMITI_NAME || 'At-Taqwa Somiti';
  const list = readDashboard_().members.filter(m => dueMonths_(m.status) >= min).map(m => {
    const n = dueMonths_(m.status);
    const h = holderPhone_(m.mid);
    const msg = name + ': ' + m.mid + ' (' + m.name + ') has ' + n + ' month' + (n > 1 ? 's' : '') + ' due (' + (n * dep).toLocaleString('en-US') + ' Tk). Paid up to ' + m.paidUpTo + '. Please pay soon. JazakAllah.';
    return { mid: m.mid, name: m.name, due: n, phone: h.phone, to: h.to, msg, wa: waLink_(h.phone, msg), sms: !!normPhone_(h.phone) };
  });
  if (send) {
    list.forEach(x => { x.result = x.sms ? sendSms_(x.to, x.phone, x.msg) : 'no SMS (use WhatsApp)'; });
    props_().setProperty('LAST_REMINDERS', Utilities.formatDate(new Date(), tz_(), 'yyyy-MM'));
    audit_(u, 'reminders_sent', { count: list.length });
  }
  return { on: String(st.REMINDERS_ON).toUpperCase() === 'YES', day: num_(st.REMINDER_DAY), minMonths: min, lastSent: props_().getProperty('LAST_REMINDERS') || '', list };
}

/* ---------------- backups (GitHub private repo + Google Drive) ---------------- */
function csvOf_(values) {
  return values.map(r => r.map(c => {
    let s = c instanceof Date ? Utilities.formatDate(c, tz_(), 'yyyy-MM-dd HH:mm:ss') : String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}
function backupTabs_(names) {
  const ss = ss_();
  const out = {};
  (names || ss.getSheets().map(s => s.getName())).forEach(n => {
    const s = ss.getSheetByName(n); if (!s) return;
    let v = s.getDataRange().getValues();
    if (n === CFG.TABS.USERS) v = v.map(r => r.map((c, j) => (j === 5 || j === 6) ? '' : c)); // never back up PIN hashes
    out[n] = csvOf_(v);
  });
  return out;
}
function githubPut_(repo, token, path, text, message) {
  const url = 'https://api.github.com/repos/' + repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const got = UrlFetchApp.fetch(url, { headers, muteHttpExceptions: true });
  const body = { message, content: Utilities.base64Encode(text, Utilities.Charset.UTF_8) };
  if (got.getResponseCode() === 200) body.sha = JSON.parse(got.getContentText()).sha;
  const res = UrlFetchApp.fetch(url, { method: 'put', headers, contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error('GitHub ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150));
}
function pushToGithub_(tabs, folders, why) {
  const repo = String(getSettings_().GITHUB_BACKUP_REPO || '').trim();
  const token = props_().getProperty('GITHUB_TOKEN');
  if (!repo || !token) return 'GitHub not set up (needs GITHUB_BACKUP_REPO setting + GITHUB_TOKEN property)';
  Object.keys(tabs).forEach(n => folders.forEach(f => githubPut_(repo, token, f + '/' + n.replace(/[^\w\- ]/g, '_') + '.csv', tabs[n], why + ': ' + n)));
  return 'ok';
}
function setBackupStatus_(key, val) { props_().setProperty(key, Utilities.formatDate(new Date(), tz_(), 'd-MMM-yyyy h:mm a') + ' · ' + val); }

/** Full backup of every tab: GitHub daily/<date>/ and latest/. */
function backupFull_(why) {
  let gh;
  try { gh = pushToGithub_(backupTabs_(), ['daily/' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), 'latest'], why || 'daily'); }
  catch (e) { gh = 'error: ' + e.message; }
  setBackupStatus_('BACKUP_FULL', gh);
  if (gh === 'ok') props_().deleteProperty('BACKUP_DIRTY');
  return backupStatus_();
}
/** Weekly copy of the whole spreadsheet into a Drive folder; keeps the newest N copies. */
function backupDrive_() {
  try {
    const keep = num_(getSettings_().DRIVE_BACKUP_KEEP) || 8;
    let folderId = props_().getProperty('DRIVE_BACKUP_FOLDER');
    let folder = null;
    try { folder = folderId ? DriveApp.getFolderById(folderId) : null; } catch (e) { folder = null; }
    if (!folder) { folder = DriveApp.createFolder('At-Taqwa Somiti Backups'); props_().setProperty('DRIVE_BACKUP_FOLDER', folder.getId()); }
    const file = DriveApp.getFileById(props_().getProperty('SHEET_ID'));
    file.makeCopy('Somiti backup ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'), folder);
    const files = []; const it = folder.getFiles(); while (it.hasNext()) files.push(it.next());
    files.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(keep).forEach(f => f.setTrashed(true));
    setBackupStatus_('BACKUP_DRIVE', 'ok (' + Math.min(files.length, keep) + ' copies kept)');
  } catch (e) { setBackupStatus_('BACKUP_DRIVE', 'error: ' + e.message); }
}
function backupStatus_() {
  const p = props_();
  return {
    full: p.getProperty('BACKUP_FULL') || 'never', quick: p.getProperty('BACKUP_QUICK') || 'never', drive: p.getProperty('BACKUP_DRIVE') || 'never',
    pending: !!p.getProperty('BACKUP_DIRTY'), repo: String(getSettings_().GITHUB_BACKUP_REPO || ''), hasToken: !!p.getProperty('GITHUB_TOKEN'),
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction())
  };
}

/* ---------------- scheduled jobs (names without _ so triggers can call them) ---------------- */
/** Every 10 minutes: if something changed, push the money tabs to GitHub latest/. */
function jobQuickBackup() {
  try { sweepSms_(); } catch (e) { /* never block the backup */ }
  if (!props_().getProperty('BACKUP_DIRTY')) return;
  let r;
  try { r = pushToGithub_(backupTabs_([CFG.TABS.RECEIVE, CFG.TABS.EXP, CFG.TABS.CASH, CFG.TABS.RECON, CFG.TABS.AUDIT, CFG.TABS.INFO, CFG.TABS.ACCTS]), ['latest'], 'after entry'); }
  catch (e) { r = 'error: ' + e.message; }
  setBackupStatus_('BACKUP_QUICK', r);
  if (r === 'ok') props_().deleteProperty('BACKUP_DIRTY');
}
/** Every day ~2 AM: full GitHub backup; Sundays: Drive copy; reminder day: due SMS (if REMINDERS_ON = YES). */
function jobDaily() {
  backupFull_('daily');
  const now = new Date();
  if (now.getDay() === 0) backupDrive_();
  if (now.getDate() === 1) { try { monthlySummarySms_(); } catch (e) { /* ignore */ } }
  const st = getSettings_();
  const month = Utilities.formatDate(now, tz_(), 'yyyy-MM');
  if (String(st.REMINDERS_ON).toUpperCase() === 'YES' && now.getDate() === num_(st.REMINDER_DAY) && props_().getProperty('LAST_REMINDERS') !== month) {
    reminders_(null, true);
  }
}
/** Run once from the editor after updating the code. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => { if (['jobQuickBackup', 'jobDaily'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('jobQuickBackup').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('jobDaily').timeBased().everyDays(1).atHour(2).create();
  Logger.log('Triggers installed: quick backup every 10 min, daily job at ~2 AM.');
}
/** Run once to test the Drive backup by hand. */
function testDriveBackup() { backupDrive_(); Logger.log(props_().getProperty('BACKUP_DRIVE')); }


/* =====================================================================
 * PHASE 3
 * ===================================================================== */

/* ---------------- admin alerts ---------------- */
function alertItem_(text) {
  const phone = String(getSettings_().ALERT_PHONE || '').trim();
  return phone ? { to: 'ALERT', phone, msg: (getSettings_().SOMITI_NAME || 'At-Taqwa Somiti') + ' alert: ' + text } : null;
}
function alert_(text) {
  const it = alertItem_(text);
  if (!it) return;
  try { sendSms_(it.to, it.phone, it.msg); } catch (e) { /* never block a save */ }
}

/* ---------------- SMS sent after the save (so "Saved" shows fast) ---------------- */
/** Kept in script properties (not the cache) so a queued SMS is never lost. */
function queueSms_(key, items) { props_().setProperty('SMSQ_' + key, JSON.stringify({ at: Date.now(), items })); }
/** Sends what was queued under this key, exactly once (take-then-send under the lock). */
function sendQueued_(key) {
  const p = props_(); const name = 'SMSQ_' + String(key || '');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Busy. The SMS will be sent in a few minutes.');
  let raw;
  try { raw = p.getProperty(name); if (raw) p.deleteProperty(name); } finally { lock.releaseLock(); }
  if (!raw) return { sms: 'already sent' };
  let first = '';
  JSON.parse(raw).items.forEach((it, i) => { const r = sendSms_(it.to, it.phone, it.msg); if (i === 0) first = r; });
  return { sms: first };
}
/** Timer: send any SMS the app never asked for (app closed right after saving). */
function sweepSms_() {
  const all = props_().getProperties();
  Object.keys(all).filter(k => k.indexOf('SMSQ_') === 0).forEach(k => {
    try { if (Date.now() - JSON.parse(all[k]).at > 120000) sendQueued_(k.slice(5)); } catch (e) { props_().deleteProperty(k); }
  });
}

/* ---------------- void a wrong entry ---------------- */
/**
 * Moves the entry rows out of Receive/Expenses into App_Voided (so every Dashboard formula updates by itself)
 * and keeps a full copy + reason. b: { tab: 'Receive'|'Expenses', receipt } or { tab, row, mid } for old rows without receipt.
 */
function voidEntry_(u, b) {
  const reason = String(b.reason || '').trim(); if (!reason) throw new Error('Reason is required');
  if (b.tab === 'SC') return voidScCollection_(u, String(b.receipt || '').trim(), reason);
  if (b.tab === 'Cash') return voidCashEntry_(u, b, reason);
  const tab = b.tab === 'Expenses' ? CFG.TABS.EXP : CFG.TABS.RECEIVE;
  const width = tab === CFG.TABS.EXP ? 9 : 14;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let out;
  try {
    const s = sh_(tab);
    const last = lastFilledRow_(s, 3);
    const v = last >= 2 ? s.getRange(2, 1, last - 1, width).getValues() : [];
    const keyCol = tab === CFG.TABS.EXP ? 6 : 7; // receipt / voucher column (0-based)
    let rows = [];
    if (b.receipt) v.forEach((r, i) => { if (String(r[keyCol]).trim() === String(b.receipt).trim()) rows.push(i + 2); });
    else if (b.row) {
      const r = v[Number(b.row) - 2];
      if (!r) throw new Error('Row not found');
      // The row must still be the SAME entry: same member, same month, same deposit. (Row numbers move when rows above are voided.)
      if (tab === CFG.TABS.RECEIVE && (String(r[2]).trim() !== String(b.mid || '').trim() || fmtMonth_(toDate_(r[1])) !== String(b.forMonth || '') || num_(r[4]) !== num_(b.deposit))) throw new Error('Row changed since you opened it. Refresh and try again.');
      if (tab === CFG.TABS.EXP && num_(r[2]) !== num_(b.amount)) throw new Error('Row changed since you opened it. Refresh and try again.');
      rows = [Number(b.row)];
    }
    if (!rows.length) throw new Error('Entry not found');
    const now = new Date(); let total = 0;
    const copies = rows.map(rn => { const r = v[rn - 2]; const amt = tab === CFG.TABS.EXP ? num_(r[2]) : num_(r[4]) + num_(r[5]); total += amt;
      return [now, u.UserID, reason, tab, String(r[keyCol] || ''), tab === CFG.TABS.EXP ? '' : String(r[2]), amt, JSON.stringify(r)]; });
    bust_();
    let scUndone = 0;
    if (tab === CFG.TABS.RECEIVE) {
      // 1) These rows had their service charge collected LATER (column N): take those months out of the collection record.
      const later = rows.map(rn => v[rn - 2]).filter(r => String(r[13] || '').trim() && num_(r[5]) > 0)
        .map(r => ({ mid: String(r[2]).trim(), month: fmtMonth_(toDate_(r[1])), sc: num_(r[5]), scReceipt: String(r[13]).trim() }));
      scShrinkCollections_(later, now, u, reason).forEach(c => copies.push(c));
      // 2) This receipt also collected OLD service charge from earlier months: undo that too.
      if (b.receipt) { const un = scUndoReceipt_(s, v, String(b.receipt).trim(), rows, now, u, reason); un.copies.forEach(c => copies.push(c)); scUndone = un.total; total += un.total; }
    }
    const vs = sh_(CFG.TABS.VOID);
    vs.getRange(vs.getLastRow() + 1, 1, copies.length, VOID_COLS.length).setValues(copies);
    rows.sort((a, b2) => b2 - a).forEach(rn => s.deleteRow(rn)); // bottom-up so row numbers stay valid
    SpreadsheetApp.flush();
    out = { voided: rows.length, total, tab, receipt: b.receipt || '', scUndone };
    audit_(u, 'void', Object.assign({ reason }, out));
    markDirty_();
  } finally { lock.releaseLock(); }
  alert_('VOID by ' + u.UserID + ': ' + out.voided + ' row(s), ' + out.total.toLocaleString('en-US') + ' Tk in ' + out.tab + '. Reason: ' + reason);
  return out;
}

/* ---- service charge collections and void (all callers hold the script lock) ---- */
/** Rows being voided had SC collected later: remove those months (and their money) from App_SC_Collections. Returns App_Voided copies. */
function scShrinkCollections_(items, now, u, reason) {
  if (!items.length) return [];
  const s = sh_(CFG.TABS.SCC); const last = s.getLastRow();
  if (last < 2) return [];
  const v = s.getRange(2, 1, last - 1, SCC_COLS.length).getValues();
  const copies = []; const touched = {};
  items.forEach(it => {
    const i = v.findIndex(r => String(r[7]).trim() === it.scReceipt && String(r[1]).trim() === it.mid && String(r[3]).split(',').map(x => x.trim()).indexOf(it.month) >= 0);
    if (i < 0) return;
    const months = String(v[i][3]).split(',').map(x => x.trim()).filter(Boolean); months.splice(months.indexOf(it.month), 1);
    v[i][3] = months.join(', '); v[i][4] = Math.max(0, num_(v[i][4]) - it.sc); touched[i] = true;
    copies.push([now, u.UserID, reason, CFG.TABS.SCC, it.scReceipt, it.mid, it.sc, JSON.stringify({ month: it.month, note: 'late service charge removed because its payment was voided' })]);
  });
  const del = [];
  Object.keys(touched).map(Number).forEach(i => { if (!v[i][3] || num_(v[i][4]) <= 0) del.push(i + 2); else s.getRange(i + 2, 4, 1, 2).setValues([[v[i][3], v[i][4]]]); });
  del.sort((a, b) => b - a).forEach(rn => s.deleteRow(rn));
  return copies;
}
/**
 * Undo every service charge collection saved under this receipt: the months go back to "service charge due".
 * recv/v = Receive sheet and its values from row 2. skipRows = Receive rows that are being deleted anyway.
 */
function scUndoReceipt_(recv, v, receipt, skipRows, now, u, reason) {
  const s = sh_(CFG.TABS.SCC); const last = s.getLastRow();
  const out = { copies: [], total: 0, months: 0 };
  if (last < 2 || !receipt) return out;
  const sv = s.getRange(2, 1, last - 1, SCC_COLS.length).getValues();
  const del = [];
  sv.forEach((r, i) => { if (String(r[7]).trim() === receipt) { del.push(i + 2); out.total += num_(r[4]); out.copies.push([now, u.UserID, reason, CFG.TABS.SCC, receipt, String(r[1]), num_(r[4]), JSON.stringify(r)]); } });
  if (!del.length) return out;
  const skip = {}; (skipRows || []).forEach(rn => skip[rn] = true);
  const back = []; v.forEach((r, i) => { const rn = i + 2; if (!skip[rn] && String(r[13] || '').trim() === receipt) back.push(rn); });
  if (back.length) { recv.getRangeList(back.map(rn => 'F' + rn)).setValue(0); recv.getRangeList(back.map(rn => 'N' + rn)).setValue(''); }
  out.months = back.length;
  del.sort((a, b) => b - a).forEach(rn => s.deleteRow(rn));
  return out;
}
/** Admin: void one service charge collection by its receipt number. */
function voidScCollection_(u, receipt, reason) {
  if (!receipt) throw new Error('Entry not found');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let out;
  try {
    bust_();
    const recv = sh_(CFG.TABS.RECEIVE); const last = lastFilledRow_(recv, 3);
    const v = last >= 2 ? recv.getRange(2, 1, last - 1, 14).getValues() : [];
    const un = scUndoReceipt_(recv, v, receipt, [], new Date(), u, reason);
    if (!un.copies.length) throw new Error('Entry not found');
    const vs = sh_(CFG.TABS.VOID);
    vs.getRange(vs.getLastRow() + 1, 1, un.copies.length, VOID_COLS.length).setValues(un.copies);
    SpreadsheetApp.flush();
    out = { voided: un.copies.length, total: un.total, tab: CFG.TABS.SCC, receipt, months: un.months };
    audit_(u, 'void', Object.assign({ reason }, out));
    markDirty_();
  } finally { lock.releaseLock(); }
  alert_('VOID by ' + u.UserID + ': service charge collection ' + receipt + ', ' + out.total.toLocaleString('en-US') + ' Tk. Reason: ' + reason);
  return out;
}
function scHistory_(limit) {
  return rowsAsObjects_(CFG.TABS.SCC, SCC_COLS).map(r => ({ date: fmtDate_(toDate_(r.Date)), mid: r.MID, name: r.Name, months: String(r.Months || ''), amount: num_(r.Amount), account: r.Account, collectedBy: r['Collected By'], receipt: String(r.Receipt || '') }))
    .reverse().slice(0, limit || 30);
}

/* ---------------- member exit / withdrawal ---------------- */
function infoStatusCol_() { const t = infoSheet_(); return { t, c: colOf_(t.head, 'Status') }; }

function closePreview_(mid) {
  const info = readInfo_()[mid]; if (!info) throw new Error('Unknown Member ID');
  const rows = receiveRows_().filter(r => r.mid === mid);
  const deposits = rows.reduce((t, r) => t + r.deposit, 0);
  const others = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS).filter(a => a.HolderUserID === mid && a.MID !== mid).map(a => a.MID);
  return { mid, name: info.name, months: rows.length, deposits, nominee: info.fields['Nominee Name'] || '', otherAccounts: others, ready: props_().getProperty('DASH_V2') === '1' };
}

function closeAccount_(u, b) {
  if (props_().getProperty('DASH_V2') !== '1') throw new Error('Run applyDashboardV2 once first (see setup guide)');
  const mid = String(b.mid || '').trim();
  const reason = String(b.reason || '').trim(); if (!reason) throw new Error('Reason is required');
  const pv = closePreview_(mid);
  if (pv.otherAccounts.length) throw new Error('This member is Account Holder for ' + pv.otherAccounts.join(', ') + '. Move those accounts first.');
  if (num_(b.confirmAmount) !== pv.deposits) throw new Error('Amount does not match the deposit total (' + pv.deposits + '). Refresh and try again.');
  const acct = checkAccount_(b.paidFrom);
  const paidTo = String(b.paidTo || pv.name).trim();
  const { t, c } = infoStatusCol_(); if (c < 0) throw new Error('INFORMATION has no Status column. Run applyDashboardV2.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let voucher = '';
  try {
    if (pv.deposits > 0) {
      const s = sh_(CFG.TABS.EXP); const row = lastFilledRow_(s, 3) + 1;
      voucher = nextReceipt_().replace(/^[A-Z]+/, 'WDL');
      s.getRange(row, 1, 1, 9).setValues([[dateOut_(toDate_(b.date) || new Date()), 'Member withdrawal ' + mid + ' (' + pv.name + ')', pv.deposits, 'Paid to: ' + paidTo + '. ' + reason, 'Withdrawal', acct, voucher, new Date(), u.UserID]]);
    }
    t.sheet.getRange(readInfo_()[mid].row, c + 1).setValue('Closed');
    const usr = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === mid);
    if (usr) { usr.Status = 'closed'; setCells_(CFG.TABS.USERS, usr._row, USER_COLS, usr); }
    SpreadsheetApp.flush();
    audit_(u, 'close_account', { mid, deposits: pv.deposits, voucher, paidTo, acct, reason });
    markDirty_();
  } finally { lock.releaseLock(); }
  alert_('Account CLOSED ' + mid + ' (' + pv.name + '): ' + pv.deposits.toLocaleString('en-US') + ' Tk paid to ' + paidTo + ' from ' + acct + '.');
  return { mid, paid: pv.deposits, voucher, paidTo };
}

/**
 * One-time change so withdrawals and closed members are counted correctly (run from the editor, after approval).
 * Adds INFORMATION "Status" column; Dashboard: member table skips Closed, deposits minus withdrawals,
 * "Withdrawal" not counted as a Somiti expense, total check includes withdrawals. Old formulas are saved in App_Audit_Log.
 */
function applyDashboardV2() {
  const ss = ss_(); const d = ss.getSheetByName(CFG.TABS.DASH);
  const t = infoSheet_();
  if (colOf_(t.head, 'Status') < 0) t.sheet.getRange(t.headerRow, t.head.filter(h => h).length + 1).setValue('Status').setFontWeight('bold');
  const t2 = infoSheet_(); const sc = colOf_(t2.head, 'Status') + 1;
  const colL = c => { let s = ''; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
  const S = colL(sc);
  const first = t2.firstDataRow;
  const changes = {
    A22: '=FILTER(INFORMATION!A' + first + ':B,INFORMATION!A' + first + ':A<>"",INFORMATION!A' + first + ':A<>"ATFS-0000",INFORMATION!' + S + first + ':' + S + '<>"Closed")',
    B3: '=SUMIFS(Receive!E2:E,Receive!C2:C,"<>ATFS-0000")-SUMIFS(Expenses!C2:C,Expenses!E2:E,"Withdrawal")',
    B5: '=SUMIFS(Expenses!C2:C,Expenses!E2:E,"<>Mosjid",Expenses!E2:E,"<>Withdrawal")',
    F19: '=IF(SUM(Receive!E2:E)+SUM(Receive!F2:F)=B3+B4+B8+SUMIFS(Expenses!C2:C,Expenses!E2:E,"Withdrawal"),"OK","MISMATCH")'
  };
  const old = {}; Object.keys(changes).forEach(a => { old[a] = d.getRange(a).getFormula(); d.getRange(a).setFormula(changes[a]); });
  audit_(null, 'dashboard_v2', { old, new: changes });
  props_().setProperty('DASH_V2', '1');
  Logger.log('Dashboard updated. Old formulas saved in App_Audit_Log.');
}

/** One-time: lock the old Payment Entry tab (warning only) so nobody enters payments outside the app. */
function retireOldForm() {
  const s = ss_().getSheetByName(CFG.TABS.PAYIN); if (!s) { Logger.log('No Payment Entry tab'); return; }
  const p = s.protect().setDescription('Old form retired: use the At-Taqwa Somiti app');
  p.setWarningOnly(true);
  s.getRange('A1').setNote('RETIRED: enter payments in the At-Taqwa Somiti app so they get receipt numbers, audit log and backups.');
  audit_(null, 'retire_old_form', '');
  Logger.log('Payment Entry tab now shows a warning before any edit.');
}

/* ---------------- two-person approval ---------------- */
function listPending_() {
  return rowsAsObjects_(CFG.TABS.PENDING, PENDING_COLS).filter(p => p.Status === 'pending')
    .map(p => Object.assign({ id: p.ID, by: p['Created By'], at: fmtDate_(new Date(p['Created At'])) }, JSON.parse(p.Data || '{}')));
}
function decidePending_(u, id, approve, note) {
  if (!can_(u, 'expenses')) throw new Error('Not allowed');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let p, res = null, data = null;
  try {
    bust_(); // read the newest status INSIDE the lock, so two quick taps cannot both approve
    p = rowsAsObjects_(CFG.TABS.PENDING, PENDING_COLS).find(x => x.ID === id);
    if (!p || p.Status !== 'pending') throw new Error('Already decided or not found');
    if (p['Created By'] === u.UserID) throw new Error('A different person must approve this');
    if (approve) { data = JSON.parse(p.Data); res = writeExpenseLocked_({ UserID: p['Created By'] }, data, u.UserID); }
    p.Status = approve ? 'approved' : 'rejected'; p['Decided By'] = u.UserID; p['Decided At'] = new Date(); p.Note = String(note || '') + (res ? ' ' + res.voucher : '');
    setCells_(CFG.TABS.PENDING, p._row, PENDING_COLS, p);
    SpreadsheetApp.flush();
    audit_(u, approve ? 'approve_expense' : 'reject_expense', { id });
  } finally { lock.releaseLock(); }
  if (res) expenseAlert_(res, data);
  return { id, status: p.Status, voucher: res ? res.voucher : '' };
}

/* ---------------- monthly report ---------------- */
function monthReport_(ym) {
  const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const y = m ? +m[1] : now.getFullYear(), mo = m ? +m[2] - 1 : now.getMonth();
  const from = new Date(y, mo, 1), to = new Date(y, mo + 1, 1);
  const inM = d => d && d >= from && d < to;
  const col = { deposits: 0, serviceCharge: 0, mosjid: 0, byAccount: {}, count: 0 };
  receiveRows_().forEach(r => { if (!inM(r.date)) return; col.count++;
    const scNow = r.scLater ? 0 : r.sc;
    if (r.mid === CFG.MOSJID_ID) col.mosjid += r.deposit; else { col.deposits += r.deposit; col.serviceCharge += scNow; }
    const a = r.account || 'not recorded'; col.byAccount[a] = (col.byAccount[a] || 0) + r.deposit + scNow; });
  rowsAsObjects_(CFG.TABS.SCC, SCC_COLS).forEach(r => { const d = toDate_(r.Date); if (!inM(d)) return; const v = num_(r.Amount); col.serviceCharge += v; col.lateServiceCharge = (col.lateServiceCharge || 0) + v; const a = r.Account || 'not recorded'; col.byAccount[a] = (col.byAccount[a] || 0) + v; });
  const exp = { Somiti: 0, Mosjid: 0, Withdrawal: 0, rows: [] };
  expenseRows_().forEach(e => { if (!inM(e.date)) return; const f = e.fund; exp[f] = (exp[f] || 0) + e.amount; exp.rows.push({ date: fmtDate_(e.date), purpose: e.purpose, amount: e.amount, fund: f }); });
  const newMembers = rowsAsObjects_(CFG.TABS.ACCTS, ACCT_COLS).filter(a => inM(toDate_(a.LinkedAt) || (a.LinkedAt instanceof Date ? a.LinkedAt : null)) && /^new/.test(a.Reason)).map(a => a.MID + ' ' + a.AccountName);
  const voided = rowsAsObjects_(CFG.TABS.VOID, VOID_COLS).filter(v => inM(v['Voided At'] instanceof Date ? v['Voided At'] : toDate_(v['Voided At']))).length;
  const lim = num_(getSettings_().INACTIVE_AFTER_MONTHS) || 6;
  const dash = readDashboard_();
  const due = dash.members.filter(x => dueMonths_(x.status) > 0).map(x => ({ mid: x.mid, name: x.name, due: dueMonths_(x.status), inactive: dueMonths_(x.status) >= lim }));
  let cb = null; try { cb = cashbook_(); } catch (e) { cb = null; }
  return { month: Utilities.formatDate(from, tz_(), 'MMMM yyyy'), collections: col, expenses: exp, newMembers, voided, due, dashboard: dash.left.concat(dash.right), balances: cb && cb.started ? cb.balances : null, collectors: cb && cb.started ? cb.collectors : [] };
}

/* ---------------- helpers for forms ---------------- */
function collectorNames_() {
  const c = {}; receiveRows_().forEach(r => { const n = r.collectedBy.trim(); if (n) c[n] = (c[n] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a]).slice(0, 30);
}
function setUserPhone_(admin, userId, phone) {
  const u = rowsAsObjects_(CFG.TABS.USERS, USER_COLS).find(x => x.UserID === userId); if (!u) throw new Error('Unknown user');
  if (/^ATFS-/.test(userId)) return updateMember_(admin, userId, { phone });
  u.Phone = String(phone || '').trim(); setCells_(CFG.TABS.USERS, u._row, USER_COLS, u);
  audit_(admin, 'set_phone', { userId }); return true;
}

/* ---------------- documents (Google Drive) ---------------- */
function docsFolder_(mid) {
  let id = props_().getProperty('DOCS_FOLDER'); let root = null;
  try { root = id ? DriveApp.getFolderById(id) : null; } catch (e) { root = null; }
  if (!root) { root = DriveApp.createFolder('At-Taqwa Somiti Documents'); props_().setProperty('DOCS_FOLDER', root.getId()); }
  const it = root.getFoldersByName(mid); return it.hasNext() ? it.next() : root.createFolder(mid);
}
function uploadDoc_(u, b) {
  const mid = String(b.mid || ''); if (!readInfo_()[mid]) throw new Error('Unknown Member ID');
  const type = ['Photo', 'NID front', 'NID back', 'Nominee NID', 'Nominee photo', 'Form', 'Other'].indexOf(b.type) >= 0 ? b.type : 'Other';
  const m = String(b.dataUrl || '').match(/^data:([\w/+.-]+);base64,(.+)$/); if (!m) throw new Error('Bad file');
  if (m[2].length > 4 * 1024 * 1024) throw new Error('File too big (max ~3 MB)');
  const ext = m[1] === 'application/pdf' ? 'pdf' : 'jpg';
  const name = mid + ' ' + type + ' ' + Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HHmm') + '.' + ext;
  const file = docsFolder_(mid).createFile(Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name));
  sh_(CFG.TABS.DOCS).appendRow([mid, type, file.getId(), name, new Date(), u.UserID]);
  audit_(u, 'upload_doc', { mid, type, name }); markDirty_();
  return { fileId: file.getId(), name };
}
function listDocs_(u, mid) {
  if (!canSee_(u, mid)) throw new Error('Not allowed');
  return rowsAsObjects_(CFG.TABS.DOCS, DOC_COLS).filter(d => d.MID === mid).map(d => ({ type: d.Type, fileId: d['File ID'], name: d['File Name'], at: fmtDate_(new Date(d['Uploaded At'])) }));
}
function getDoc_(u, fileId) {
  const d = rowsAsObjects_(CFG.TABS.DOCS, DOC_COLS).find(x => x['File ID'] === fileId); if (!d) throw new Error('Not found');
  if (!canSee_(u, d.MID)) throw new Error('Not allowed');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { name: d['File Name'], dataUrl: 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) };
}

/* ---------------- data check ---------------- */
function dataHealth_() {
  const info = readInfo_(); const issues = [];
  const users = rowsAsObjects_(CFG.TABS.USERS, USER_COLS);
  Object.keys(info).forEach(mid => {
    if (mid === CFG.MOSJID_ID) return; const i = info[mid]; const f = i.fields;
    if (String(f.Status || '') === 'Closed') return;
    if (!i.phone) issues.push({ mid, name: i.name, issue: 'No mobile number' });
    else if (!normPhone_(i.phone) && !waNumber_(i.phone)) issues.push({ mid, name: i.name, issue: 'Mobile is not a phone number: "' + i.phone + '"' });
    if (!String(f['Nominee Name'] || '').trim()) issues.push({ mid, name: i.name, issue: 'No nominee' });
    if (f.NID !== undefined && !String(f.NID || '').trim()) issues.push({ mid, name: i.name, issue: 'No NID' });
  });
  users.filter(x => x.Role !== 'member' && x.Status === 'active' && !String(x.Phone || '').trim()).forEach(x => issues.push({ mid: x.UserID, name: x.Name, issue: 'Staff login has no mobile number' }));
  if (!String(getSettings_().ALERT_PHONE || '').trim()) issues.push({ mid: 'Settings', name: 'App_Settings', issue: 'ALERT_PHONE is empty: no admin alerts will be sent' });
  return issues;
}

/* monthly summary SMS on the 1st (called from jobDaily) */
function monthlySummarySms_() {
  const prev = new Date(); prev.setDate(0);
  const r = monthReport_(Utilities.formatDate(prev, tz_(), 'yyyy-MM'));
  const c = r.collections, e = r.expenses;
  alert_(r.month + ': collected ' + (c.deposits + c.serviceCharge + c.mosjid).toLocaleString('en-US') + ' Tk, expenses ' + (e.Somiti + e.Mosjid).toLocaleString('en-US') + ' Tk, ' + r.due.length + ' members due. Full report in the app: More > Monthly report.');
}


/* =====================================================================
 * SERVICE CHARGE PAID LATER
 * A month saved without its service charge has Service Charge = 0 in Receive.
 * Due = those months x the service charge rate. When the member pays later, the app fills those rows
 * (so every Dashboard formula stays correct), marks them in "SC Paid Later" with the receipt, and logs the
 * money in App_SC_Collections with the real date + account (used by the cash book and monthly report).
 * ===================================================================== */
function scDueMap_() {
  return memo_('scdue', () => {
    const rate = num_(getSettings_().SERVICE_CHARGE_PER_MONTH);
    const out = {};
    if (!rate) return out;
    receiveRows_().forEach(r => {
      if (r.mid === CFG.MOSJID_ID || r.deposit <= 0 || r.sc > 0) return;
      const o = out[r.mid] || (out[r.mid] = { months: [], rows: [], amount: 0 });
      o.months.push(fmtMonth_(r.forMonth)); o.rows.push(r.row); o.amount += rate;
    });
    return out;
  });
}
function scDueList_() {
  const m = scDueMap_(); const info = readInfo_();
  return Object.keys(m).map(mid => ({ mid, name: (info[mid] || {}).name || '', months: m[mid].months, amount: m[mid].amount })).sort((a, b) => b.amount - a.amount);
}
function collectSc_(u, b) {
  if (!can_(u, 'payments')) throw new Error('Not allowed');
  const mid = String(b.mid || '').trim();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another save is running. Try again in a moment.');
  let r;
  try { r = scCollectLocked_(u, mid, { account: checkAccount_(b.account), collectedBy: b.collectedBy, date: toDate_(b.date) || new Date() }); }
  finally { lock.releaseLock(); }
  if (r.amount) {
    const info = readInfo_()[mid] || {};
    const msg = (getSettings_().SOMITI_NAME || 'At-Taqwa Somiti') + ': ' + mid + ' (' + (info.name || '') + ') service charge ' + r.amount.toLocaleString('en-US') + ' Tk received for ' + r.months.length + ' month(s). Receipt ' + r.receipt + '.';
    if (b.deferSms === true) {
      const h = holderPhone_(mid);
      r.wa = waLink_(h.phone, msg); r.waOnly = !normPhone_(h.phone) && !!waNumber_(h.phone);
      if (normPhone_(h.phone)) { queueSms_(r.receipt, [{ to: h.to, phone: h.phone, msg }]); r.smsPending = true; }
    } else {
      const s = smsToHolder_(mid, msg);
      r.sms = s.sms; r.wa = s.wa; r.waOnly = s.waOnly;
    }
  }
  return r;
}
/** Caller must hold the script lock. opts: { account, collectedBy, date, receipt?, excludeFrom? (row number: skip rows saved in this same payment) } */
function scCollectLocked_(u, mid, opts) {
  bust_();
  const due = scDueMap_()[mid];
  if (!due) return { amount: 0, months: [], receipt: opts.receipt || '' };
  const rows = due.rows.filter(rn => !opts.excludeFrom || rn < opts.excludeFrom);
  if (!rows.length) return { amount: 0, months: [], receipt: opts.receipt || '' };
  const rate = num_(getSettings_().SERVICE_CHARGE_PER_MONTH);
  const receipt = opts.receipt || nextReceipt_();
  const s = sh_(CFG.TABS.RECEIVE);
  // Two writes in total, however many months (was two per month).
  s.getRangeList(rows.map(rn => 'F' + rn)).setValue(rate);
  s.getRangeList(rows.map(rn => 'N' + rn)).setValue(receipt);
  const months = rows.map(rn => due.months[due.rows.indexOf(rn)]);
  const amount = rows.length * rate;
  const info = readInfo_()[mid] || {};
  sh_(CFG.TABS.SCC).appendRow([dateOut_(opts.date || new Date()), mid, info.name || '', months.join(', '), amount, opts.account || moneyAccounts_()[0], String(opts.collectedBy || ''), receipt, new Date(), u.UserID]);
  SpreadsheetApp.flush();
  audit_(u, 'collect_old_sc', { mid, months, amount, receipt });
  markDirty_();
  return { mid, amount, months, receipt };
}
