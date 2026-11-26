/* At-Taqwa Somiti — phone app (Phase 1). Plain JS, no build step. */
(function () {
  const CFG = window.APP_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const view = $('#view');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tk = (n) => Number(n || 0).toLocaleString('en-US');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('ats_' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('ats_' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem('ats_' + k); } catch (e) { /* ignore */ } }
  };
  const state = { token: store.get('token'), user: store.get('user'), accounts: null, money: null };
  async function moneyAccounts() { if (!state.money) state.money = await api('moneyAccounts'); return state.money; }
  const moneyOpts = (list, sel) => list.map((a) => '<option' + (a === sel ? ' selected' : '') + '>' + esc(a) + '</option>').join('');

  /* ---------- API ---------- */
  // Speed: read-only screens show the last saved copy instantly, then refresh in the background.
  const CACHEABLE = ['acctLedger', 'payInit', 'scDue', 'scHistory', 'dashboard', 'accounts', 'ledger', 'transactions', 'expenses', 'cashbook', 'profile', 'moneyAccounts', 'users', 'collectorNames', 'pending', 'monthReport'];
  const fresh = {};
  // True once the user has typed or picked something on the current screen: then a background refresh must not redraw it.
  let dirty = false;
  document.addEventListener('input', () => { dirty = true; }, true);
  document.addEventListener('change', () => { dirty = true; }, true);
  // One-time save ID: a retry of the SAME save (after no answer) carries the same ID, so the server saves it only once.
  const ONCE = ['addPayment', 'addMosjid', 'addExpense', 'addCash', 'reconcile', 'collectSc', 'decide', 'closeAccount', 'voidEntry', 'addMember'];
  const newNonce = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  let nonce = newNonce();
  function ridOf(action, data) {
    const str = action + '|' + JSON.stringify(data || {}); let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return nonce + '.' + (h >>> 0).toString(36) + '.' + str.length;
  }
  const ckey = (action, data) => 'c_' + (state.user ? state.user.id : '') + '_' + action + '_' + JSON.stringify(data || {});
  function clearCache() { try { Object.keys(localStorage).filter((k) => k.indexOf('ats_c_') === 0).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ } }
  async function api(action, data) {
    if (CACHEABLE.indexOf(action) < 0) {
      if (action !== 'login' && action !== 'logout' && action !== 'preview') { clearCache(); state.money = null; }
      if (ONCE.indexOf(action) < 0) return apiLive(action, data);
      const d = await apiLive(action, Object.assign({ rid: ridOf(action, data) }, data || {}), true);
      nonce = newNonce(); // saved: the next save is a new one
      return d;
    }
    const k = ckey(action, data);
    if (fresh[k] !== undefined) { const d = fresh[k]; delete fresh[k]; return d; }
    const cached = store.get(k);
    if (cached === null || cached === undefined) { const d = await apiLive(action, data); store.set(k, d); return d; }
    const hash = location.hash;
    apiLive(action, data).then((d) => {
      store.set(k, d);
      if (JSON.stringify(d) !== JSON.stringify(cached) && location.hash === hash && !dirty) { fresh[k] = d; state.accounts = null; go(true); }
    }).catch(() => {});
    return cached;
  }
  async function apiLive(action, data, isSave) {
    if (!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) throw new Error('App not set up: API_URL missing in config.js');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), isSave ? 60000 : 45000);
    let j;
    try {
      const res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight with Apps Script
        body: JSON.stringify(Object.assign({ action, token: state.token }, data || {})),
        signal: ctl.signal
      });
      j = await res.json();
    } catch (e) {
      // No answer: we cannot know if a save went through. Tapping the same button again is safe (same save ID).
      throw new Error(isSave ? 'No answer from the server. It may or may not be saved. Tap the button again to check: it will not be saved twice.'
        : (navigator.onLine === false ? 'No internet. Check your connection and try again.' : 'The server is slow or not reachable. Try again.'));
    } finally { clearTimeout(timer); }
    if (!j.ok) {
      if (j.code === 'AUTH') { logout(true); }
      if (j.code === 'PIN' && state.user) { state.user.mustChangePin = true; store.set('user', state.user); location.hash = '#/setpin'; }
      throw new Error(j.error || 'Something went wrong');
    }
    return j.data;
  }

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 3000);
  }
  /* In-app bottom sheet. Resolves null when cancelled, an object of field values (or true) when confirmed, or the chosen item. */
  function sheet(o) {
    return new Promise((done) => {
      const w = document.createElement('div'); w.className = 'ov';
      const fields = (o.fields || []).map((x) => '<label for="sh_' + x.id + '">' + esc(x.label) + '</label>' + (x.options
        ? '<select id="sh_' + x.id + '">' + x.options.map(([v, l]) => '<option value="' + esc(v) + '"' + (v === x.value ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>'
        : '<input id="sh_' + x.id + '" type="' + (x.type || 'text') + '"' + (x.inputmode ? ' inputmode="' + x.inputmode + '"' : '') + ' value="' + esc(x.value || '') + '" placeholder="' + esc(x.placeholder || '') + '" autocomplete="off">')).join('');
      w.innerHTML = '<div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(o.title || '') + '"><h2>' + esc(o.title || '') + '</h2>' +
        (o.text ? '<div class="shtext">' + esc(o.text).replace(/\n/g, '<br>') + '</div>' : '') + (o.html || '') + fields +
        (o.copy ? '<button type="button" class="btn sec" id="sh_copy">Copy</button>' : '') + '<div class="err" id="sh_err" role="alert"></div>' +
        (o.items ? o.items.map((it, i) => '<button type="button" class="btn sec" data-i="' + i + '"' + (it.danger ? ' style="color:var(--red)"' : '') + '>' + esc(it.label) + '</button>').join('')
          : '<button type="button" class="btn' + (o.danger ? ' danger' : '') + '" id="sh_ok">' + esc(o.ok || 'OK') + '</button>') +
        (o.cancel === false ? '' : '<button type="button" class="btn sec" id="sh_no">' + esc(o.cancel || 'Cancel') + '</button>') + '</div>';
      document.body.appendChild(w);
      const q = (sel) => w.querySelector(sel);
      const key = (e) => { if (e.key === 'Escape') close(null); };
      const close = (v) => { document.removeEventListener('keydown', key); w.remove(); done(v); };
      document.addEventListener('keydown', key);
      w.onclick = (e) => { if (e.target === w && o.cancel !== false) close(null); };
      if (q('#sh_no')) q('#sh_no').onclick = () => close(null);
      if (q('#sh_copy')) q('#sh_copy').onclick = async () => { try { await navigator.clipboard.writeText(o.copy); q('#sh_copy').textContent = 'Copied ✓'; } catch (e) { q('#sh_copy').textContent = 'Could not copy: write it down'; } };
      w.querySelectorAll('[data-i]').forEach((b) => b.onclick = () => close(o.items[+b.dataset.i]));
      if (q('#sh_ok')) q('#sh_ok').onclick = () => {
        const out = {};
        for (const x of (o.fields || [])) {
          const v = q('#sh_' + x.id).value.trim();
          if (x.required && !v) { q('#sh_err').textContent = x.label + ' is required'; q('#sh_' + x.id).focus(); return; }
          out[x.id] = v;
        }
        close((o.fields || []).length ? out : true);
      };
      const first = q('input,select'); if (first && o.focus !== false) setTimeout(() => first.focus(), 50);
    });
  }
  /* Member picker: search by name or ID, shows each member's status. Resolves the Member ID or null. */
  function pickMember(list) {
    return new Promise((done) => {
      const w = document.createElement('div'); w.className = 'ov';
      w.innerHTML = '<div class="sheet picker" role="dialog" aria-modal="true" aria-label="Choose member"><h2>Choose member</h2><input id="pk_q" type="search" placeholder="Search name or ID…" autocomplete="off" aria-label="Search name or ID"><div id="pk_l" class="pk-list"></div><button type="button" class="btn sec" id="pk_no">Cancel</button></div>';
      document.body.appendChild(w);
      const key = (e) => { if (e.key === 'Escape') close(null); };
      const close = (v) => { document.removeEventListener('keydown', key); w.remove(); done(v); };
      document.addEventListener('keydown', key);
      w.onclick = (e) => { if (e.target === w) close(null); };
      w.querySelector('#pk_no').onclick = () => close(null);
      const draw = () => {
        const q = w.querySelector('#pk_q').value.trim().toLowerCase();
        const f = list.filter((a) => !q || (a.name + ' ' + a.mid).toLowerCase().indexOf(q) >= 0);
        w.querySelector('#pk_l').innerHTML = f.map((a) => '<button type="button" class="pk" data-mid="' + esc(a.mid) + '"><span class="pk-t"><span class="t">' + esc(a.name) + '</span><span class="s">' + esc(a.mid) + ' · paid up to ' + esc(a.paidUpTo) + (a.scOwed ? ' · SC due ' + tk(a.scOwed) : '') + '</span></span>' + statusChip(a.status) + '</button>').join('') || '<div class="muted" style="padding:16px 0">No member found</div>';
        w.querySelectorAll('.pk').forEach((b) => b.onclick = () => close(b.dataset.mid));
      };
      w.querySelector('#pk_q').oninput = draw; draw();
      w.querySelector('#pk_q').onkeydown = (e) => { if (e.key === 'Enter') { const one = w.querySelectorAll('.pk'); if (one.length === 1) close(one[0].dataset.mid); } };
      setTimeout(() => w.querySelector('#pk_q').focus(), 50);
    });
  }
  const ask = (text, okLabel, danger) => sheet({ title: 'Please confirm', text, ok: okLabel || 'Yes, continue', danger }).then((v) => !!v);
  const info = (text, title) => sheet({ title: title || 'Note', text, ok: 'OK', cancel: false });
  const showPin = (id, pin, extra) => sheet({ title: 'First PIN for ' + id, html: '<div class="pin">' + esc(pin) + '</div><div class="shtext">' + esc(extra || '').replace(/\n/g, '<br>') + '<br>They must set their own PIN at first login.</div>', copy: pin, ok: 'Done', cancel: false });
  const rowMenu = async (title, items) => { const it = await sheet({ title, items, cancel: 'Close' }); if (it && it.run) it.run(); };
  const kvRow = (l, v, raw) => '<div class="kv"><span class="l">' + esc(l) + '</span><span class="v">' + (raw ? v : esc(v)) + '</span></div>';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthLabel = (k) => MON[k % 12] + '-' + Math.floor(k / 12);

  function busy(text) {
    dirty = false;
    view.innerHTML = '<div class="skel" role="status" aria-label="' + esc(text || 'Loading…') + '"><div class="sk h"></div><div class="sk c"></div><div class="sk c s"></div><div class="sk c"></div></div>';
  }
  function netBar() {
    let b = document.getElementById('offl');
    if (navigator.onLine === false) {
      if (!b) { b = document.createElement('div'); b.id = 'offl'; b.className = 'offl'; b.setAttribute('role', 'status'); b.textContent = 'No internet · showing saved data. Saving is not possible now.'; document.body.appendChild(b); }
    } else if (b) { b.remove(); if (state.token) go(true); }
  }
  // iPhone ignores the viewport "no zoom" setting, so the pinch gesture itself is cancelled.
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });
  window.addEventListener('online', netBar); window.addEventListener('offline', netBar);
  function fail(e) { view.innerHTML = '<div class="card"><b>Could not load</b><div class="err">' + esc(e.message) + '</div><button class="btn sec" id="retry">Try again</button></div>'; $('#retry').onclick = () => go(); }

  const isStaff = () => state.user && (state.user.role === 'admin' || state.user.role === 'management');
  const can = (p) => state.user && (state.user.role === 'admin' || (state.user.role === 'management' && (state.user.perms || []).indexOf(p) >= 0));

  function statusChip(s) {
    s = String(s || '');
    const cls = /due/i.test(s) ? 'due' : /adv/i.test(s) ? 'adv' : '';
    return '<span class="chip ' + cls + '">' + esc(s || '-') + '</span>';
  }

  /* ---------- receipt image (share on WhatsApp) ---------- */
  async function shareReceipt(r) {
    const c = document.createElement('canvas'); c.width = 720; c.height = 900; const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 720, 900);
    g.fillStyle = '#0f5b46'; g.fillRect(0, 0, 720, 150);
    g.fillStyle = '#ffffff'; g.font = 'bold 42px system-ui, sans-serif'; g.fillText('At-Taqwa Somiti', 40, 75);
    g.font = '26px system-ui, sans-serif'; g.fillText('Payment Receipt', 40, 118);
    let y = 210;
    const line = (k, v, big) => { g.font = '24px system-ui, sans-serif'; g.fillStyle = '#68736e'; g.fillText(k, 40, y); g.fillStyle = big ? '#0f5b46' : '#1d2421'; g.font = (big ? 'bold 40px' : 'bold 28px') + ' system-ui, sans-serif'; g.fillText(String(v || '-').slice(0, 44), 40, y + (big ? 46 : 36)); y += big ? 96 : 80; };
    line('Receipt No', r.receipt); line('Member', r.member); line('For', r.forText); line('Deposit date', r.date); if (r.collectedBy) line('Collected by', r.collectedBy);
    line('Amount', tk(r.amount) + ' Tk', true);
    g.fillStyle = '#e3e8e5'; g.fillRect(40, 840, 640, 2); g.fillStyle = '#68736e'; g.font = '20px system-ui, sans-serif'; g.fillText('At-Taqwa Somiti app · ' + new Date().toLocaleString(), 40, 875);
    const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const file = new File([blob], (r.receipt || 'receipt') + '.png', { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Receipt ' + (r.receipt || '') }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
  }
  async function voidFlow(payload, what, after) {
    const f = await sheet({ title: 'Void entry', text: what + '\n\nThis removes it from the totals. A copy is kept in App_Voided.', fields: [{ id: 'reason', label: 'Reason', required: true, placeholder: 'Why is this entry wrong?' }], ok: 'Void it', danger: true });
    if (!f) return;
    const reason = f.reason;
    try { const r = await api('voidEntry', Object.assign({ reason }, payload)); toast('Voided ' + r.voided + ' row(s), ' + tk(r.total) + ' Tk' + (r.scUndone ? ' (incl. ' + tk(r.scUndone) + ' Tk old service charge, now due again)' : ''), 5000); state.accounts = null; after && after(); }
    catch (e) { toast(e.message, 5000); }
  }

  /* ---------- nav ---------- */
  const svg = (d) => '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const IC = {
    dash: svg('<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>'),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    plus: svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>'),
    list: svg('<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>'),
    more: svg('<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'),
    card: svg('<rect width="20" height="14" x="2" y="5" rx="2"/><path d="M2 10h20"/>'),
    user: svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>')
  };
  function navItems() {
    if (!state.user) return [];
    if (!isStaff()) return [['#/accounts', IC.card, 'My Accounts'], ['#/more', IC.user, 'Settings']];
    const n = [['#/dashboard', IC.dash, 'Dashboard'], ['#/accounts', IC.users, 'Accounts']];
    if (can('payments')) n.push(['#/pay', IC.plus, 'Payment']);
    n.push(['#/tx', IC.list, 'Activity'], ['#/more', IC.more, 'More']);
    return n;
  }
  function renderChrome() {
    const nav = $('#nav');
    if (!state.user) { nav.classList.add('hidden'); $('#who').textContent = ''; return; }
    if (state.user.mustChangePin) { nav.classList.add('hidden'); $('#who').textContent = state.user.id; return; }
    $('#who').textContent = '';
    const cur = location.hash.split('/').slice(0, 2).join('/');
    nav.innerHTML = navItems().map(([h, i, l]) => '<a href="' + h + '" class="' + (cur === h ? 'on' : '') + '"' + (cur === h ? ' aria-current="page"' : '') + '><span class="i">' + i + '</span>' + l + '</a>').join('');
    nav.classList.remove('hidden');
  }

  /* ---------- router ---------- */
  const routes = {
    login: viewLogin, dashboard: viewDashboard, accounts: viewAccounts, ledger: viewLedger,
    pay: viewPay, tx: viewTx, more: viewMore, users: viewUsers,
    member: viewMemberForm, profile: viewProfile, expenses: viewExpenses, cash: viewCash, reminders: viewReminders, backups: viewBackups,
    report: viewReport, health: viewHealth, close: viewClose, scdue: viewScDue, setpin: viewSetPin, acct: viewAcct
  };
  function go(keepScroll) {
    const parts = (location.hash || '').replace(/^#\//, '').split('/');
    let name = parts[0];
    if (!state.token) name = 'login';
    else if (state.user && state.user.mustChangePin && name !== 'setpin') { location.hash = '#/setpin'; return; }
    else if (!name || name === 'login') { location.hash = isStaff() ? '#/dashboard' : '#/accounts'; return; }
    dirty = false;
    renderChrome();
    const y = window.scrollY;
    (routes[name] || viewAccounts)(parts.slice(1));
    if (keepScroll === true) setTimeout(() => window.scrollTo(0, y), 50); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => go());
  netBar();

  /* ---------- accessibility + error placement, applied to every screen as it is drawn ---------- */
  let uid = 0;
  function polish(root) {
    // every label points at its field, so tapping the label focuses it and screen readers read it
    root.querySelectorAll('label:not([for])').forEach((l) => {
      if (l.querySelector('input,select,textarea')) return;
      let f = l.nextElementSibling; if (f && !/^(INPUT|SELECT|TEXTAREA)$/.test(f.tagName)) f = f.querySelector && f.querySelector('input,select,textarea');
      if (!f) return; if (!f.id) f.id = 'f' + (++uid); l.htmlFor = f.id;
    });
    // tappable rows work with keyboard and are announced as links
    root.querySelectorAll('div[data-mid]').forEach((el) => { if (!el.hasAttribute('tabindex')) { el.tabIndex = 0; el.setAttribute('role', 'link'); } });
    root.querySelectorAll('.err').forEach((el) => { if (!el.hasAttribute('role')) el.setAttribute('role', 'alert'); });
  }
  new MutationObserver((muts) => {
    polish(document.body);
    // an error message that just got text is brought into view (it may be below the screen on a long form)
    muts.forEach((m) => { const t = m.target.nodeType === 3 ? m.target.parentElement : m.target; if (t && t.classList && t.classList.contains('err') && t.textContent.trim()) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('div[data-mid]')) { e.preventDefault(); e.target.click(); } });

  function logout(silent) {
    if (state.token && !silent) api('logout').catch(() => {});
    state.token = null; state.user = null; state.accounts = null;
    clearCache(); store.del('token'); store.del('user');
    location.hash = '#/login';
    if (silent) toast('Please log in again');
  }

  /* ---------- views ---------- */
  function viewLogin() {
    $('#nav').classList.add('hidden'); $('#who').textContent = '';
    view.innerHTML = '<div class="login card"><div class="logo"><img src="icon-192.png" alt=""><h2>At-Taqwa Somiti</h2><div class="muted">Log in with your ID and PIN</div></div>' +
      '<form id="lf"><label>ID</label><input id="lid" autocomplete="username" placeholder="e.g. ATFS-0001" autocapitalize="characters" required>' +
      '<label>PIN</label><input id="lpin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6" required>' +
      '<button class="btn" id="lbtn">Log in</button><div id="lerr" class="err"></div></form>' +
      '<p class="muted">Forgot your PIN? Ask the Somiti admin to reset it.</p></div>';
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      const b = $('#lbtn'); b.disabled = true; b.textContent = 'Checking…'; $('#lerr').textContent = '';
      try {
        const r = await api('login', { userId: $('#lid').value.trim(), pin: $('#lpin').value.trim() });
        state.token = r.token; state.user = r.user; store.set('token', r.token); store.set('user', r.user);
        location.hash = isStaff() ? '#/dashboard' : '#/accounts';
      } catch (err) { $('#lerr').textContent = err.message; b.disabled = false; b.textContent = 'Log in'; }
    };
  }

  /* First login (or after a PIN reset): the user must choose a PIN only they know. */
  function viewSetPin() {
    if (!state.user || !state.user.mustChangePin) { location.hash = isStaff() ? '#/dashboard' : '#/accounts'; return; }
    view.innerHTML = '<div class="login card"><h2>Set your own PIN</h2><div class="muted">The PIN you were given is only for the first login. Choose a new 6-digit PIN that only you know.</div>' +
      '<form id="sf"><label for="so">PIN you were given</label><input id="so" type="password" inputmode="numeric" autocomplete="current-password" maxlength="6" required>' +
      '<label for="sn">New PIN (6 digits)</label><input id="sn" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" required>' +
      '<label for="sn2">New PIN again</label><input id="sn2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="6" required>' +
      '<button class="btn" id="sb">Save PIN</button><div id="serr" class="err"></div></form><button class="btn sec" id="slo">Log out</button></div>';
    $('#slo').onclick = () => logout();
    $('#sf').onsubmit = async (e) => {
      e.preventDefault(); const b = $('#sb'); $('#serr').textContent = '';
      if (!/^\d{6}$/.test($('#sn').value)) { $('#serr').textContent = 'PIN must be exactly 6 digits'; return; }
      if ($('#sn').value !== $('#sn2').value) { $('#serr').textContent = 'The two new PINs are not the same'; return; }
      b.disabled = true; b.textContent = 'Saving…';
      try {
        await api('changePin', { oldPin: $('#so').value, newPin: $('#sn').value });
        state.user.mustChangePin = false; store.set('user', state.user); toast('PIN saved');
        location.hash = isStaff() ? '#/dashboard' : '#/accounts';
      } catch (err) { $('#serr').textContent = err.message; b.disabled = false; b.textContent = 'Save PIN'; }
    };
  }

  async function viewDashboard() {
    busy();
    try {
      const d = await api('dashboard');
      const sec = (s) => '<h3>' + esc(s.section || 'Summary') + '</h3><div class="card">' + s.items.map((i) => {
        const ok = /^ok$/i.test(i.value);
        return '<div class="kv"><span class="l">' + esc(i.label.replace(/\s*\((type here|calculated|liability|income)[^)]*\)/i, '')) + '</span><span class="v">' + (ok ? '<span class="chip ok">OK</span>' : esc(i.value)) + '</span></div>';
      }).join('') + '</div>';
      const due = d.members.filter((m) => /due/i.test(m.status));
      const all = []; d.left.concat(d.right).forEach((s) => s.items.forEach((i) => all.push(i)));
      const val = (re) => { const i = all.find((x) => re.test(x.label)); return i ? i.value : null; };
      const tile = (label, v, sub, href) => v === null || v === '' ? '' : '<' + (href ? 'a href="' + href + '"' : 'div') + ' class="stat tile"><div class="l">' + esc(label) + '</div><div class="v">' + esc(v) + '</div>' + (sub ? '<div class="s">' + esc(sub) + '</div>' : '') + '</' + (href ? 'a' : 'div') + '>';
      const tk2 = (v) => v === null ? null : v + ' Tk';
      const totalDue = val(/^total due/i);
      view.innerHTML = '<h2>Dashboard</h2><div class="grid tiles">' +
        tile('Total balance', tk2(val(/^total balance/i)), 'both funds') +
        tile('Received this month', tk2(val(/^received this month/i)), val(/^paid for this month/i) ? val(/^paid for this month/i) + ' of members paid' : '') +
        tile('Members due', String(due.length), totalDue ? totalDue + ' Tk to collect' : '', '#duelist') +
        tile('Cash in hand', tk2(val(/^cash in hand/i)), isStaff() ? 'tap for cash book' : '', '#/cash') + '</div>' +
        '<h3 id="duelist">Members with dues (' + due.length + ')</h3><div class="card list">' +
        (due.length ? due.map((m) => '<div class="item" data-mid="' + esc(m.mid) + '"><div><div class="t">' + esc(m.name) + '</div><div class="s">' + esc(m.mid) + ' · paid up to ' + esc(m.paidUpTo) + '</div></div><div class="row">' + statusChip(m.status) + (can('payments') ? '<a class="btn sm" href="#/pay/' + esc(m.mid) + '" data-stop>Collect</a>' : '') + '</div></div>').join('') : '<div class="muted">Nobody is due 🎉</div>') + '</div>' + d.left.map(sec).join('') + d.right.map(sec).join('');
      const dl = view.querySelector('a[href="#duelist"]'); if (dl) dl.onclick = (ev) => { ev.preventDefault(); $('#duelist').scrollIntoView({ behavior: 'smooth' }); };
      view.querySelectorAll('[data-mid]').forEach((el) => el.onclick = (ev) => { if (ev.target.closest('[data-stop]')) return; location.hash = '#/ledger/' + el.dataset.mid; });
    } catch (e) { fail(e); }
  }

  async function loadAccounts(force) {
    if (!state.accounts || force) state.accounts = await api('accounts');
    return state.accounts;
  }

  async function viewAccounts() {
    busy();
    try {
      const list = await loadAccounts(true);
      if (!isStaff()) {
        const total = list.reduce((s, a) => s + Number(String(a.totalDeposit).replace(/[^0-9.]/g, '') || 0), 0);
        view.innerHTML = '<h2>My Accounts</h2>' +
          (list.length > 1 ? '<div class="card"><div class="muted">Total deposit, all accounts</div><div class="total">' + tk(total) + ' Tk</div></div>' : '') +
          list.map((a) => '<div class="card item" data-mid="' + esc(a.mid) + '" style="cursor:pointer"><div class="row" style="justify-content:space-between"><div><div class="t">' + esc(a.name) + '</div><div class="s">' + esc(a.mid) + '</div></div>' + statusChip(a.status) + '</div>' +
            '<div class="grid" style="margin-top:10px"><div><div class="muted">Total deposit</div><b>' + esc(a.totalDeposit) + ' Tk</b></div><div><div class="muted">Paid up to</div><b>' + esc(a.paidUpTo) + '</b></div></div></div>').join('') +
          (list.length ? '' : '<div class="card muted">No accounts linked to your login yet.</div>');
      } else {
        view.innerHTML = '<div class="row" style="justify-content:space-between"><h2>Accounts (' + list.length + ')</h2>' + (state.user.role === 'admin' ? '<a class="btn sm" href="#/member">+ Add member</a>' : '') + '</div><input class="search" id="q" placeholder="Search name or ID"><div class="card list" id="al"></div>';
        const draw = () => {
          const q = $('#q').value.toLowerCase();
          $('#al').innerHTML = list.filter((a) => !q || (a.name + ' ' + a.mid).toLowerCase().indexOf(q) >= 0).map((a) =>
            '<div class="item" data-mid="' + esc(a.mid) + '"><div><div class="t">' + esc(a.name) + (a.inactive ? ' <span class="chip due">Inactive</span>' : '') + (a.scOwed ? ' <span class="chip due">SC due ' + tk(a.scOwed) + '</span>' : '') + '</div><div class="s">' + esc(a.mid) + ' · ' + esc(a.totalDeposit) + ' Tk · up to ' + esc(a.paidUpTo) + (a.holder && a.holder !== a.mid ? ' · under ' + esc(a.holder) : '') + '</div></div>' + statusChip(a.status) + '</div>').join('') +
            '<div class="item" data-mid="ATFS-0000"><div><div class="t">🕌 Mosjid Fund</div><div class="s">ATFS-0000 · donations</div></div><span class="chip">Fund</span></div>';
          $('#al').querySelectorAll('[data-mid]').forEach((el) => el.onclick = () => location.hash = '#/ledger/' + el.dataset.mid);
        };
        $('#q').oninput = draw; draw();
      }
      view.querySelectorAll('.card.item[data-mid]').forEach((el) => el.onclick = () => location.hash = '#/ledger/' + el.dataset.mid);
    } catch (e) { fail(e); }
  }

  async function viewLedger(args) {
    const mid = args[0];
    busy();
    try {
      const L = await api('ledger', { mid });
      const s = L.summary || {};
      const total = L.entries.reduce((t, e) => t + e.deposit, 0);
      view.innerHTML = '<a href="#/accounts" class="muted">← Accounts</a><h2>' + esc(L.name) + '</h2>' +
        '<div class="card"><div class="kv"><span class="l">Member ID</span><span class="v">' + esc(L.mid) + '</span></div>' +
        (L.phone ? '<div class="kv"><span class="l">Mobile</span><span class="v">' + esc(L.phone) + '</span></div>' : '') +
        (s.mid ? '<div class="kv"><span class="l">Months paid</span><span class="v">' + esc(s.monthsPaid) + '</span></div>' +
          '<div class="kv"><span class="l">Total deposit</span><span class="v">' + esc(s.totalDeposit) + ' Tk</span></div>' +
          '<div class="kv"><span class="l">Service charge</span><span class="v">' + esc(s.serviceCharge) + ' Tk</span></div>' +
          '<div class="kv"><span class="l">Paid up to</span><span class="v">' + esc(s.paidUpTo) + '</span></div>' +
          '<div class="kv"><span class="l">Status</span><span class="v">' + statusChip(s.status) + '</span></div>' +
          (L.scOwed ? '<div class="kv"><span class="l">Service charge due</span><span class="v" style="color:var(--red)">' + tk(L.scOwed) + ' Tk</span></div>' : '')
          : '<div class="kv"><span class="l">Total received</span><span class="v">' + tk(total) + ' Tk</span></div>') +
        '</div>' + (can('payments') && s.mid && L.mid !== 'ATFS-0000' ? '<a class="btn" href="#/pay/' + esc(L.mid) + '">Collect payment</a>' : '') +
        '<div class="acts"><button class="btn sm sec" id="pdf">Statement PDF</button>' +
        (L.mid !== 'ATFS-0000' ? '<a class="btn sm sec" href="#/profile/' + esc(L.mid) + '">Profile</a>' : '') +
        (L.scOwed && can('payments') ? '<a class="btn sm sec" href="#/scdue/' + esc(L.mid) + '">Collect SC ' + tk(L.scOwed) + ' Tk</a>' : '') + '</div>' +
        (L.donations && L.donations.length ? '<h3>Mosjid Fund donations (' + tk(L.donations.reduce((t, d) => t + d.amount, 0)) + ' Tk)</h3><div class="card">' + L.donations.map((d) => '<div class="ent"><div><b>' + esc(d.date) + '</b><div class="muted">' + esc(d.receipt) + '</div></div><div class="amt">' + tk(d.amount) + '</div></div>').join('') + '</div>' : '') +
        '<h3>History (' + L.entries.length + ')</h3><div class="card">' +
        (L.entries.map((e, i) => '<div class="ent"><div><b>' + esc(e.forMonth) + '</b><div class="muted">Paid ' + esc(e.date) + (e.receipt ? ' · ' + esc(e.receipt) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' +
          '<div class="row" style="margin-top:4px;gap:6px">' + (e.receipt ? '<button class="btn sm sec" data-share="' + i + '">Receipt</button>' : '') + (state.user.role === 'admin' ? '<button class="btn sm sec" data-void="' + i + '" aria-label="More actions for ' + esc(e.forMonth) + '">⋯</button>' : '') + '</div></div>' +
          '<div class="amt">' + tk(e.deposit) + (e.sc ? '<div class="muted">+' + tk(e.sc) + ' SC</div>' : '') + '</div></div>').join('') || '<div class="muted">No entries yet</div>') + '</div>' +
        (state.user.role === 'admin' && L.mid !== 'ATFS-0000' && s.mid ? '<p style="text-align:center;margin-top:24px"><a class="quiet" href="#/close/' + esc(L.mid) + '">Close this account / withdrawal…</a></p>' : '');
      $('#pdf').onclick = () => statementPdf(L);
      view.querySelectorAll('[data-share]').forEach((b) => b.onclick = () => {
        const e = L.entries[+b.dataset.share]; const same = L.entries.filter((x) => x.receipt === e.receipt);
        shareReceipt({ receipt: e.receipt, member: L.mid + ' · ' + L.name, forText: same.length > 1 ? same[same.length - 1].forMonth + ' to ' + same[0].forMonth + ' (' + same.length + ' months)' : e.forMonth, date: e.date, collectedBy: e.collectedBy, amount: same.reduce((t, x) => t + x.deposit + x.sc, 0) });
      });
      view.querySelectorAll('[data-void]').forEach((b) => b.onclick = () => {
        const e = L.entries[+b.dataset.void];
        const payload = e.receipt ? { tab: 'Receive', receipt: e.receipt } : { tab: 'Receive', row: e.row, mid: L.mid, forMonth: e.forMonth, deposit: e.deposit };
        const n = e.receipt ? L.entries.filter((x) => x.receipt === e.receipt).length : 1;
        const what = e.receipt ? 'Receipt ' + e.receipt + ' (' + n + ' month' + (n > 1 ? 's' : '') + ')' : e.forMonth + ' entry';
        rowMenu(what, [{ label: 'Void this ' + (e.receipt && n > 1 ? 'whole receipt' : 'entry') + '…', danger: true, run: () => voidFlow(payload, what, () => viewLedger([L.mid])) }]);
      });
    } catch (e) { fail(e); }
  }

  function loadScript(src) {
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load PDF tool. Check internet.')); document.head.appendChild(s); });
  }
  async function statementPdf(L) {
    try {
      toast('Preparing PDF…');
      if (!window.jspdf) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
      }
      const clean = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').trim(); // PDF font is Latin only
      const s = L.summary || {};
      if (/[^\x00-\x7F]/.test(L.name + L.entries.map((e) => e.remarks).join(''))) { statementAsPicture(L, s); return; }
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
      doc.setFontSize(16); doc.text('At-Taqwa Somiti', 40, 50);
      doc.setFontSize(11); doc.text('Member Statement', 40, 68);
      doc.setFontSize(10);
      const lines = [['Member ID', L.mid], ['Name', clean(L.name)], ['Months paid', s.monthsPaid], ['Total deposit (Tk)', s.totalDeposit], ['Service charge (Tk)', s.serviceCharge], ['Paid up to', s.paidUpTo], ['Status', s.status], ['Printed', new Date().toDateString()]];
      let y = 92; lines.forEach(([k, v]) => { if (v) { doc.text(k + ':', 40, y); doc.text(String(v), 170, y); y += 15; } });
      doc.autoTable({ startY: y + 8, head: [['Deposit Date', 'For Month', 'Deposit', 'Service Charge', 'Receipt', 'Remarks']],
        body: L.entries.map((e) => [e.date, e.forMonth, tk(e.deposit), tk(e.sc), e.receipt || '', clean(e.remarks)]),
        styles: { fontSize: 8 }, headStyles: { fillColor: [15, 91, 70] } });
      doc.save(L.mid + '-statement.pdf');
    } catch (e) { toast(e.message); }
  }

  /* The PDF library has no Bangla font and cannot shape Bangla letters. The phone can, so each page is drawn on a canvas and placed in the PDF. */
  function statementAsPicture(L, s) {
    const W = 1240, H = 1754, F = 'system-ui, "Noto Sans Bengali", sans-serif';
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const cols = [[60, 'Deposit Date'], [250, 'For Month'], [430, 'Deposit'], [570, 'Service Charge'], [760, 'Receipt'], [960, 'Remarks']];
    let c, g, y, page = 0;
    const flush = () => { if (page) doc.addPage(); doc.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 595.28, 841.89); page++; };
    const head = () => { g.fillStyle = '#0f5b46'; g.fillRect(50, y, W - 100, 44); g.fillStyle = '#fff'; g.font = 'bold 22px ' + F; cols.forEach(([x, t]) => g.fillText(t, x, y + 30)); y += 44; };
    const start = () => { c = document.createElement('canvas'); c.width = W; c.height = H; g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); y = 70; };
    start();
    g.fillStyle = '#1d2421'; g.font = 'bold 40px ' + F; g.fillText('At-Taqwa Somiti', 60, y + 20); g.font = '26px ' + F; g.fillText('Member Statement', 60, y + 60); y += 110;
    [['Member ID', L.mid], ['Name', L.name], ['Months paid', s.monthsPaid], ['Total deposit (Tk)', s.totalDeposit], ['Service charge (Tk)', s.serviceCharge], ['Paid up to', s.paidUpTo], ['Status', s.status], ['Printed', new Date().toDateString()]]
      .forEach(([k, v]) => { if (v) { g.font = '22px ' + F; g.fillStyle = '#68736e'; g.fillText(k + ':', 60, y); g.fillStyle = '#1d2421'; g.fillText(String(v), 330, y); y += 34; } });
    y += 16; head();
    L.entries.forEach((e, i) => {
      if (y > H - 90) { flush(); start(); head(); }
      if (i % 2) { g.fillStyle = '#f3f6f4'; g.fillRect(50, y, W - 100, 38); }
      g.fillStyle = '#1d2421'; g.font = '20px ' + F;
      [e.date, e.forMonth, tk(e.deposit), tk(e.sc), e.receipt || '', String(e.remarks || '').slice(0, 26)].forEach((t, j) => g.fillText(String(t), cols[j][0], y + 26));
      y += 38;
    });
    flush(); doc.save(L.mid + '-statement.pdf');
  }

  async function viewPay(args) {
    if (!can('payments')) { location.hash = '#/accounts'; return; }
    busy();
    let init;
    try { init = await api('payInit'); } catch (e) { return fail(e); }
    const list = init.accounts, money = init.money;
    const mode = args[0] === 'mosjid' ? 'mosjid' : 'member';
    const pre = mode === 'member' && args[0] ? args[0] : '';
    const lastCb = store.get('lastCb') || '', lastAcct = store.get('lastAcct') || '';
    const opts = (sel) => list.map((a) => '<option value="' + esc(a.mid) + '"' + (a.mid === sel ? ' selected' : '') + '>' + esc(a.mid + ' · ' + a.name) + '</option>').join('');
    const common = '<label for="dd">Deposit date</label><input id="dd" type="date" value="' + today() + '">' +
      '<label for="cb">Collected by</label><input id="cb" list="cbl" value="' + esc(lastCb) + '" placeholder="Who received the money" autocomplete="off"><datalist id="cbl">' + (init.collectors || []).map((n) => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<label for="acct">Received into</label><select id="acct">' + moneyOpts(money, lastAcct) + '</select>';
    view.innerHTML = '<h2>New Payment</h2><div class="tabs"><button type="button" class="' + (mode === 'member' ? 'on' : '') + '" id="tmem">Member deposit</button><button type="button" class="' + (mode === 'mosjid' ? 'on' : '') + '" id="tmos">🕌 Mosjid Fund</button></div>' +
      '<div class="card">' + (mode === 'member'
        ? '<label for="midbtn">Member</label><button type="button" class="pick" id="midbtn">Choose member…</button><input type="hidden" id="mid" value="' + esc(list.some((a) => a.mid === pre) ? pre : '') + '">' +
          '<div id="minfo"></div>' +
          '<label for="cnt">Number of months</label><div class="stepper"><button type="button" id="minus" aria-label="One month less">−</button><input id="cnt" type="number" min="1" max="60" value="1" inputmode="numeric"><button type="button" id="plus" aria-label="One month more">+</button></div>' +
          '<label class="check"><input type="checkbox" id="scnow" checked> Service charge paid now</label>' +
          '<label class="check" id="oldwrap" style="display:none"><input type="checkbox" id="oldsc"> <span id="oldtxt"></span></label>' +
          common + '<details class="more"><summary>Add a remark</summary><label for="rm">Remarks</label><input id="rm" autocomplete="off"></details>'
        : '<label>Donors</label><div id="donors"></div><button type="button" class="btn sm sec" id="addd" style="margin-top:8px">+ Add donor</button>' + common) +
      '</div><div id="perr" class="err" role="alert"></div><div style="height:96px"></div>' +
      '<div class="paybar"><div class="pb-l"><div class="muted" id="bsub">' + (mode === 'member' ? 'Choose a member' : 'Add a donor') + '</div><div class="total" id="btot">0 Tk</div></div><button type="button" class="btn" id="go" disabled>Save</button></div>';
    $('#tmem').onclick = () => { if (mode !== 'member') location.hash = '#/pay'; };
    $('#tmos').onclick = () => { if (mode !== 'mosjid') location.hash = '#/pay/mosjid'; };
    const remember = () => { store.set('lastCb', $('#cb').value.trim()); store.set('lastAcct', $('#acct').value); };
    const again = (m) => { if (location.hash === (m === 'mosjid' ? '#/pay/mosjid' : '#/pay')) viewPay(m === 'mosjid' ? ['mosjid'] : []); else location.hash = m === 'mosjid' ? '#/pay/mosjid' : '#/pay'; };

    if (mode === 'mosjid') {
      const rows = () => Array.from(document.querySelectorAll('#donors .row')).map((d) => ({ mid: d.querySelector('.dmid').value, name: d.querySelector('.dmid').value ? '' : d.querySelector('.dname').value.trim(), amount: Number(d.querySelector('.damt').value || 0) })).filter((x) => x.amount > 0);
      const sum = () => { const r = rows(); const t = r.reduce((x, y) => x + y.amount, 0); $('#btot').textContent = tk(t) + ' Tk'; $('#bsub').textContent = r.length ? r.length + ' donor' + (r.length > 1 ? 's' : '') + ' · Mosjid Fund' : 'Add a donor'; $('#go').disabled = !t; };
      const donorRow = () => {
        const d = document.createElement('div'); d.className = 'row'; d.style.marginTop = '8px'; d.style.flexWrap = 'wrap';
        d.innerHTML = '<select class="dmid" style="flex:1 1 100%" aria-label="Donor"><option value="">Other (type name)</option>' + opts('') + '</select><input class="dname" placeholder="Name" aria-label="Donor name" style="flex:2" autocomplete="off"><input class="damt" type="number" inputmode="numeric" placeholder="Tk" aria-label="Amount in Taka" style="flex:1"><button type="button" class="btn sm sec drm" aria-label="Remove donor">✕</button>';
        d.querySelector('.dmid').onchange = (e) => { d.querySelector('.dname').style.display = e.target.value ? 'none' : ''; };
        d.querySelector('.damt').oninput = sum;
        d.querySelector('.drm').onclick = () => { d.remove(); sum(); };
        $('#donors').appendChild(d);
      };
      donorRow(); $('#addd').onclick = donorRow;
      $('#go').onclick = async () => {
        const b = $('#go'); $('#perr').textContent = '';
        const donors = rows(); const total = donors.reduce((t, x) => t + x.amount, 0);
        if (!donors.length) return;
        const yes = await sheet({ title: 'Save this donation?', html: '<div class="preview">' + donors.map((d) => kvRow(d.mid || d.name || '(no name)', tk(d.amount))).join('') + kvRow('Total to Mosjid Fund', '<span class="total">' + tk(total) + ' Tk</span>', true) + '</div>', ok: 'Save ' + tk(total) + ' Tk' });
        if (!yes) return;
        b.disabled = true; b.textContent = 'Saving…';
        try {
          remember();
          const r = await api('addMosjid', { donors, depositDate: $('#dd').value, collectedBy: $('#cb').value, account: $('#acct').value });
          const dateTxt = $('#dd').value;
          view.innerHTML = '<div class="card"><h2>✅ Saved</h2>' + kvRow('Receipt', r.receipt) + kvRow('Total', tk(r.amount) + ' Tk') + kvRow('Donors', r.donors) + '<button class="btn sec" id="shr">Share receipt image</button><button class="btn" id="newp">New entry</button></div>';
          $('#shr').onclick = () => shareReceipt({ receipt: r.receipt, member: 'Mosjid Fund donation', forText: r.donors, date: dateTxt, amount: r.amount });
          $('#newp').onclick = () => again('mosjid');
        } catch (e) { $('#perr').textContent = e.message; toast(e.message, 6000); b.disabled = false; b.textContent = 'Save'; }
      };
      return;
    }

    // Member deposit: months and total are worked out on the phone (rates and next month came with payInit). The server checks again when saving.
    const calc = () => {
      const a = list.find((x) => x.mid === $('#mid').value); if (!a) return null;
      const n = Math.max(1, Math.min(60, Math.floor(+$('#cnt').value || 1)));
      const months = []; for (let i = 0; i < n; i++) months.push(monthLabel(a.nextKey + i));
      const scNow = $('#scnow').checked; const old = $('#oldsc').checked ? (a.scOwed || 0) : 0;
      return { a, n, months, scNow, old, dep: init.deposit * n, sc: scNow ? init.sc * n : 0, total: init.deposit * n + (scNow ? init.sc * n : 0) + old };
    };
    const paint = () => {
      const c = calc(); $('#perr').textContent = '';
      if (!c) { $('#bsub').textContent = 'Choose a member'; $('#btot').textContent = '0 Tk'; $('#go').disabled = true; return; }
      $('#bsub').textContent = c.n === 1 ? c.months[0] : c.months[0] + ' → ' + c.months[c.n - 1] + ' (' + c.n + ' months)';
      $('#btot').textContent = tk(c.total) + ' Tk'; $('#go').disabled = false;
    };
    const showMember = () => {
      const a = list.find((x) => x.mid === $('#mid').value);
      $('#midbtn').textContent = a ? a.mid + ' · ' + a.name : 'Choose member…'; $('#midbtn').classList.toggle('has', !!a);
      if (!a) { $('#minfo').innerHTML = ''; $('#oldwrap').style.display = 'none'; $('#oldsc').checked = false; paint(); return; }
      const due = (String(a.status).match(/^(\d+)\s*Due/i) || [])[1];
      $('#minfo').innerHTML = '<div class="preview" style="margin-top:10px">' + kvRow('Paid up to', a.paidUpTo) + kvRow('Status', statusChip(a.status), true) +
        (due ? kvRow('Due amount', '<span style="color:var(--red)">' + tk(Number(due) * init.deposit) + ' Tk (' + due + ' months)</span>', true) : '') +
        (a.scOwed ? kvRow('Service charge due', '<span style="color:var(--red)">' + tk(a.scOwed) + ' Tk (' + a.scMonths + ' months)</span>', true) : '') + '</div>';
      $('#cnt').value = due ? Math.min(60, Number(due)) : 1;
      $('#oldsc').checked = false;
      if (a.scOwed) { $('#oldwrap').style.display = ''; $('#oldtxt').textContent = 'Also collect old service charge due (' + tk(a.scOwed) + ' Tk)'; } else $('#oldwrap').style.display = 'none';
      paint();
    };
    $('#midbtn').onclick = async () => { const m = await pickMember(list); if (m) { $('#mid').value = m; dirty = true; showMember(); } };
    $('#cnt').oninput = paint; $('#scnow').onchange = paint; $('#oldsc').onchange = paint;
    $('#minus').onclick = () => { $('#cnt').value = Math.max(1, (+$('#cnt').value || 1) - 1); paint(); };
    $('#plus').onclick = () => { $('#cnt').value = Math.min(60, (+$('#cnt').value || 1) + 1); paint(); };
    if (pre) showMember();
    $('#go').onclick = async () => {
      const b = $('#go'); const c = calc(); if (!c) return;
      const yes = await sheet({ title: 'Save this payment?', focus: false, html: '<div class="preview">' + kvRow('Member', c.a.mid + ' · ' + c.a.name) +
        kvRow('Months', (c.n === 1 ? c.months[0] : c.months[0] + ' → ' + c.months[c.n - 1]) + ' (' + c.n + ')') +
        kvRow('Deposit', tk(init.deposit) + ' × ' + c.n + ' = ' + tk(c.dep)) +
        kvRow('Service charge', c.scNow ? tk(init.sc) + ' × ' + c.n + ' = ' + tk(c.sc) : '<span style="color:var(--red)">not paid now (' + tk(init.sc * c.n) + ' Tk will show as due)</span>', true) +
        (c.old ? kvRow('Old service charge', tk(c.old)) : '') + kvRow('Received into', $('#acct').value) +
        kvRow('Total to collect', '<span class="total">' + tk(c.total) + ' Tk</span>', true) + '</div>', ok: 'Save ' + tk(c.total) + ' Tk' });
      if (!yes) return;
      b.disabled = true; b.textContent = 'Saving…'; $('#perr').textContent = '';
      const mid = c.a.mid, cbv = $('#cb').value, dateTxt = $('#dd').value;
      try {
        remember();
        const r = await api('addPayment', { mid, count: c.n, expectFirst: c.months[0], depositDate: dateTxt, collectedBy: cbv, remarks: $('#rm').value, account: $('#acct').value, scPaid: c.scNow, collectOldSc: !!c.old, deferSms: true });
        state.accounts = null;
        view.innerHTML = '<div class="card"><h2>✅ Saved</h2>' + kvRow('Receipt', r.receipt) + kvRow('Member', r.mid + ' · ' + r.name) + kvRow('Months', r.months.join(', ')) + kvRow('Total', tk(r.total) + ' Tk') +
          (r.oldSc ? kvRow('Incl. old service charge', tk(r.oldSc) + ' Tk') : '') +
          (r.scSkipped ? kvRow('Service charge', '<span style="color:var(--red)">not paid now: shows as due</span>', true) : '') +
          (r.smsPending ? '<div class="kv"><span class="l">SMS</span><span class="v muted" id="smsst">sending…</span></div>' : (r.sms && !r.waOnly ? kvRow('SMS', r.sms) : '')) +
          (r.wa ? '<a class="btn ' + (r.waOnly ? '' : 'sec') + '" style="background:' + (r.waOnly ? '#25D366' : '') + '" href="' + esc(r.wa) + '" target="_blank" rel="noopener">Send on WhatsApp' + (r.waOnly ? ' (no SMS for this number)' : '') + '</a>' : '') +
          '<button class="btn sec" id="shr">Share receipt image</button><button class="btn" id="newp">New payment</button><a class="btn sec" href="#/ledger/' + esc(r.mid) + '">View ledger</a></div>';
        $('#shr').onclick = () => shareReceipt({ receipt: r.receipt, member: r.mid + ' · ' + r.name, forText: r.months.length > 1 ? r.months[0] + ' to ' + r.months[r.months.length - 1] + ' (' + r.months.length + ' months)' : r.months[0], date: dateTxt, collectedBy: cbv, amount: r.total });
        $('#newp').onclick = () => again('member');
        window.scrollTo(0, 0);
        if (r.smsPending) apiLive('sendQueued', { key: r.receipt }).then((q) => { const el = $('#smsst'); if (el) el.textContent = /^200/.test(q.sms) ? 'sent ✓' : q.sms; })
          .catch(() => { const el = $('#smsst'); if (el) el.textContent = 'will be sent in a few minutes'; });
      } catch (e) {
        if (/Months changed/.test(e.message)) { clearCache(); toast(e.message, 7000); viewPay([mid]); return; }
        $('#perr').textContent = e.message; toast(e.message, 6000); b.disabled = false; b.textContent = 'Save';
      }
    };
  }

  async function viewTx() {
    busy();
    try {
      const t = await api('transactions', { limit: 100 });
      view.innerHTML = '<h2>Recent activity</h2><div class="card">' + t.map((e, i) =>
        '<div class="ent"><div><b>' + esc(e.name) + '</b> <span class="muted">' + esc(e.mid) + '</span><div class="muted">' + esc(e.date) + ' · for ' + esc(e.forMonth) + (e.receipt ? ' · ' + esc(e.receipt) : '') + (e.collectedBy ? ' · by ' + esc(e.collectedBy) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' +
        (state.user.role === 'admin' ? '<button class="btn sm sec" data-void="' + i + '" style="margin-top:4px" aria-label="More actions">⋯</button>' : '') + '</div><div class="amt">' + tk(e.deposit) + '</div></div>').join('') + '</div>';
      view.querySelectorAll('[data-void]').forEach((b) => b.onclick = () => {
        const e = t[+b.dataset.void];
        const what = (e.receipt ? 'Receipt ' + e.receipt : e.mid + ' ' + e.forMonth) + ' (' + e.name + ')';
        rowMenu(what, [{ label: 'Open ledger', run: () => { location.hash = '#/ledger/' + e.mid; } }, { label: 'Void…', danger: true, run: () => voidFlow(e.receipt ? { tab: 'Receive', receipt: e.receipt } : { tab: 'Receive', row: e.row, mid: e.mid, forMonth: e.forMonth, deposit: e.deposit }, what, viewTx) }]);
      });
    } catch (e) { fail(e); }
  }

  function viewMore() {
    const admin = state.user && state.user.role === 'admin';
    const links = [];
    if (admin) links.push(['#/member', 'Add member'], ['#/users', 'Users & account linking']);
    if (can('expenses')) links.push(['#/expenses', 'Expenses']);
    if (isStaff()) links.push(['#/cash', 'Cash book (Cash / Bank / bKash)']);
    if (isStaff()) links.push(['#/scdue', 'Service charge due'], ['#/report', 'Monthly report']);
    if (admin) links.push(['#/reminders', 'Due reminders'], ['#/health', 'Data check'], ['#/backups', 'Backups']);
    view.innerHTML = '<h2>' + (isStaff() ? 'More' : 'Settings') + '</h2><div class="card who2"><div><div class="t">' + esc(state.user.name) + '</div><div class="muted">' + esc(state.user.id) + ' · ' + esc(state.user.role) + '</div></div><span class="chip ok">logged in</span></div>' + (links.length ? '<div class="card list">' + links.map(([h, l]) => '<a class="item" href="' + h + '" style="color:inherit;text-decoration:none"><span class="t">' + l + '</span><span class="muted">›</span></a>').join('') + '</div>' : '') +
      '<div class="card" style="margin-top:16px"><b>Change PIN</b><label>Current PIN</label><input id="op" type="password" inputmode="numeric" maxlength="6"><label>New PIN (6 digits)</label><input id="np" type="password" inputmode="numeric" maxlength="6"><button class="btn" id="cp">Change PIN</button><div id="cerr" class="err"></div></div>' +
      '<button class="btn sec" id="lo">Log out</button>' +
      '<p class="muted">To install: open the browser menu and choose “Add to Home screen”.</p>';
    $('#cp').onclick = async () => {
      try { await api('changePin', { oldPin: $('#op').value, newPin: $('#np').value }); toast('PIN changed'); $('#op').value = $('#np').value = ''; }
      catch (e) { $('#cerr').textContent = e.message; }
    };
    $('#lo').onclick = () => logout();
  }

  /* ---------- Phase 2 screens ---------- */
  const MF = [['name', 'Full name *'], ['phone', 'Mobile (01XXXXXXXXX or with country code)'], ['father', "Father's name"], ['mother', "Mother's name"],
    ['nid', 'NID number'], ['dob', 'Date of birth'], ['presentAddress', 'Present address'], ['permanentAddress', 'Permanent address'],
    ['profession', 'Profession'], ['bloodGroup', 'Blood group'], ['email', 'Email'], ['nationality', 'Nationality'],
    ['nominee', 'Nominee name'], ['nomineeRelation', 'Nominee relation'], ['nomineeAddress', 'Nominee address']]; // monthly deposit is one rate for everyone (Dashboard), so it is not asked per member

  async function viewMemberForm(args) {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    const mid = args[0];
    busy();
    let p = { fields: {} };
    try { if (mid) p = await api('profile', { mid }); } catch (e) { return fail(e); }
    const fields = MF.filter(([k]) => k !== 'nid' || !mid || p.hasNidColumn);
    view.innerHTML = '<a href="' + (mid ? '#/profile/' + esc(mid) : '#/accounts') + '" class="muted">← Back</a><h2>' + (mid ? 'Edit ' + esc(mid) : 'Add member') + '</h2><div class="card">' +
      fields.map(([k, l]) => '<label>' + esc(l) + '</label><input data-f="' + k + '" value="' + esc(p.fields[k] || '') + '"' + (k === 'phone' ? ' inputmode="tel"' : '') + (k === 'dob' ? ' placeholder="e.g. 12-Mar-1990"' : '') + '>').join('') +
      (mid ? '' : '<label>Share account under an existing Account Holder? (optional)</label><input id="holder" placeholder="e.g. ATFS-0002 — leave empty for own login" autocapitalize="characters"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="sendpin" checked style="width:auto"> Send login PIN by SMS (own login only)</label>') +
      '<button class="btn" id="save">' + (mid ? 'Save changes' : 'Add member') + '</button><div id="ferr" class="err"></div></div>' +
      (mid ? '' : '<p class="muted">The next Member ID is picked automatically. The member appears on the Dashboard straight away.</p>');
    $('#save').onclick = async () => {
      const f = {}; view.querySelectorAll('[data-f]').forEach((i) => { f[i.dataset.f] = i.value.trim(); });
      if (!f.name) { $('#ferr').textContent = 'Name is required'; view.querySelector('[data-f="name"]').focus(); return; }
      const b = $('#save'); b.disabled = true; b.textContent = 'Saving…';
      try {
        if (mid) { await api('updateMember', { mid, fields: f }); toast('Saved'); location.hash = '#/profile/' + mid; return; }
        const r = await api('addMember', { fields: f, holderUserId: $('#holder').value.trim().toUpperCase(), sendPin: $('#sendpin').checked });
        state.accounts = null;
        view.innerHTML = '<div class="card"><h2>✅ Member added</h2><div class="kv"><span class="l">Member ID</span><span class="v">' + esc(r.mid) + '</span></div>' +
          (r.pin ? '<div class="kv"><span class="l">First PIN</span><span class="v">' + esc(r.pin.pin) + '</span></div><div class="kv"><span class="l">SMS</span><span class="v muted">' + esc(r.pin.waOnly ? 'foreign number, use WhatsApp' : r.pin.sms || '-') + '</span></div>' + (r.pin.wa ? '<a class="btn sec" target="_blank" rel="noopener" href="' + esc(r.pin.wa) + '">Send PIN on WhatsApp</a>' : '') : '') +
          '<a class="btn" href="#/pay/' + esc(r.mid) + '">Take first payment</a><button type="button" class="btn sec" id="addmore">Add another</button></div>';
        $('#addmore').onclick = () => viewMemberForm([]);
      } catch (e) { $('#ferr').textContent = e.message; b.disabled = false; b.textContent = mid ? 'Save changes' : 'Add member'; }
    };
  }

  async function viewProfile(args) {
    const mid = args[0]; busy();
    try {
      const p = await api('profile', { mid });
      const label = Object.fromEntries(MF);
      view.innerHTML = '<a href="#/ledger/' + esc(mid) + '" class="muted">← Ledger</a><h2>' + esc(p.fields.name || mid) + '</h2><div class="card">' +
        '<div class="kv"><span class="l">Member ID</span><span class="v">' + esc(mid) + '</span></div>' +
        (p.holder && p.holder !== mid ? '<div class="kv"><span class="l">Account Holder</span><span class="v">' + esc(p.holder) + '</span></div>' : '') +
        Object.keys(p.fields).filter((k) => k !== 'name').map((k) => '<div class="kv"><span class="l">' + esc((label[k] || k).replace(' *', '').replace(/\s*\(.*\)/, '')) + '</span><span class="v">' + (esc(p.fields[k]) || '<span class="muted">—</span>') + '</span></div>').join('') + '</div>' +
        (!p.fields.nominee ? '<div class="card" style="background:var(--redbg)">⚠️ No nominee recorded. Every member should have a nominee.</div>' : '') +
        (state.user.role === 'admin' ? '<a class="btn sec" href="#/member/' + esc(mid) + '">✏️ Edit profile</a>' : '') +
        '<h3>Documents</h3><div class="card" id="docs"><div class="muted">Loading…</div></div>' +
        (state.user.role === 'admin' ? '<div class="card"><b>Upload document</b><label>Type</label><select id="dtype"><option>Photo</option><option>NID front</option><option>NID back</option><option>Nominee NID</option><option>Nominee photo</option><option>Form</option><option>Other</option></select><label>File (photo or PDF)</label><input id="dfile" type="file" accept="image/*,application/pdf"><button class="btn" id="dup">Upload</button><div id="derr" class="err"></div></div>' : '');
      const loadDocs = async () => {
        const d = await api('docs', { mid });
        $('#docs').innerHTML = d.length ? d.map((x) => '<div class="ent"><div><b>' + esc(x.type) + '</b><div class="muted">' + esc(x.at) + '</div></div><button class="btn sm sec" data-doc="' + esc(x.fileId) + '">View</button></div>').join('') : '<div class="muted">No documents yet</div>';
        $('#docs').querySelectorAll('[data-doc]').forEach((b) => b.onclick = async () => {
          b.textContent = '…';
          try {
            const f = await api('doc', { fileId: b.dataset.doc });
            const bin = atob(f.dataUrl.split(',')[1]); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([arr], { type: f.dataUrl.slice(5, f.dataUrl.indexOf(';')) }));
            window.open(url, '_blank');
          } catch (e) { toast(e.message); }
          b.textContent = 'View';
        });
      };
      loadDocs().catch((e) => { $('#docs').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
      if ($('#dup')) $('#dup').onclick = async () => {
        const f = $('#dfile').files[0]; if (!f) { $('#derr').textContent = 'Choose a file'; return; }
        const b = $('#dup'); b.disabled = true; b.textContent = 'Uploading…';
        try { const dataUrl = await shrink(f); await api('uploadDoc', { mid, type: $('#dtype').value, dataUrl }); toast('Uploaded'); $('#dfile').value = ''; await loadDocs(); }
        catch (e) { $('#derr').textContent = e.message; }
        b.disabled = false; b.textContent = 'Upload';
      };
    } catch (e) { fail(e); }
  }

  /** Photos are resized to max 1600px JPEG so uploads stay small; PDFs go as-is. */
  function shrink(file) {
    return new Promise((ok, no) => {
      const rd = new FileReader();
      rd.onerror = () => no(new Error('Could not read file'));
      rd.onload = () => {
        if (file.type === 'application/pdf') { if (rd.result.length > 4e6) return no(new Error('PDF too big (max ~3 MB)')); return ok(rd.result); }
        const img = new Image();
        img.onload = () => { const k = Math.min(1, 1600 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', 0.82)); };
        img.onerror = () => no(new Error('Not an image'));
        img.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }

  async function viewExpenses() {
    if (!can('expenses') && !isStaff()) { location.hash = '#/more'; return; }
    busy();
    try {
      const [d, money, pend] = await Promise.all([api('expenses', { limit: 100 }), moneyAccounts(), api('pending').catch(() => [])]);
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Expenses</h2><div class="grid"><div class="stat"><div class="l">Somiti expenses</div><div class="v">' + tk(d.totals.Somiti) + ' Tk</div></div><div class="stat"><div class="l">Mosjid expenses</div><div class="v">' + tk(d.totals.Mosjid) + ' Tk</div></div>' + (d.totals.Withdrawal ? '<div class="stat"><div class="l">Member withdrawals</div><div class="v">' + tk(d.totals.Withdrawal) + ' Tk</div></div>' : '') + '</div>' +
        (pend.length ? '<h3>Waiting for approval (' + pend.length + ')</h3><div class="card">' + pend.map((p) => '<div class="ent"><div><b>' + esc(p.purpose) + '</b> <span class="chip">' + esc(p.fund) + '</span><div class="muted">' + esc(p.date) + ' · by ' + esc(p.by) + ' · from ' + esc(p.paidFrom) + '</div>' + (can('expenses') && p.by !== state.user.id ? '<div class="row" style="gap:6px;margin-top:4px"><button class="btn sm" data-ok="' + esc(p.id) + '">Approve</button><button class="btn sm sec" data-no="' + esc(p.id) + '">Reject</button></div>' : '<div class="muted">Needs a different person to approve</div>') + '</div><div class="amt">' + tk(p.amount) + '</div></div>').join('') + '</div>' : '') +
        (can('expenses') ? '<h3>New expense</h3><div class="card"><label>Fund</label><div class="tabs"><button class="on" data-fund="Somiti">Somiti</button><button data-fund="Mosjid">🕌 Mosjid</button></div>' +
          '<label>Purpose</label><input id="ep" placeholder="e.g. Bank charge, printing forms"><label>Amount (Tk)</label><input id="ea" type="number" inputmode="numeric"><label>Date</label><input id="ed" type="date" value="' + today() + '"><label>Paid from</label><select id="ef">' + moneyOpts(money) + '</select><label>Remarks (optional)</label><input id="er">' +
          '<button class="btn" id="esave">Save expense</button><div id="eerr" class="err"></div></div>' : '') +
        '<h3>Recent</h3><div class="card">' + (d.rows.map((e) => '<div class="ent"><div><b>' + esc(e.purpose) + '</b> <span class="chip">' + esc(e.fund) + '</span><div class="muted">' + esc(e.date) + (e.paidFrom ? ' · from ' + esc(e.paidFrom) : '') + (e.voucher ? ' · ' + esc(e.voucher) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' + (state.user.role === 'admin' && e.fund !== 'Withdrawal' ? '<button class="btn sm sec" data-ev="' + esc(e.row) + '|' + esc(e.amount) + '|' + esc(e.voucher) + '" style="margin-top:4px" aria-label="More actions">⋯</button>' : '') + '</div><div class="amt">' + tk(e.amount) + '</div></div>').join('') || '<div class="muted">No expenses yet</div>') + '</div>';
      view.querySelectorAll('[data-ev]').forEach((b) => b.onclick = () => { const [row, amount, voucher] = b.dataset.ev.split('|'); const what = 'Expense ' + (voucher || '') + ' (' + tk(amount) + ' Tk)'; rowMenu(what, [{ label: 'Void…', danger: true, run: () => voidFlow(voucher ? { tab: 'Expenses', receipt: voucher } : { tab: 'Expenses', row: +row, amount: +amount }, what, viewExpenses) }]); });
      view.querySelectorAll('[data-ok],[data-no]').forEach((b) => b.onclick = async () => {
        const ok = !!b.dataset.ok; const id = b.dataset.ok || b.dataset.no;
        if (!await ask((ok ? 'Approve' : 'Reject') + ' this expense?')) return;
        view.querySelectorAll('[data-ok],[data-no]').forEach((x) => { x.disabled = true; });
        try { const r = await api('decide', { id, approve: ok }); toast(ok ? 'Approved ' + r.voucher : 'Rejected'); viewExpenses(); } catch (e) { toast(e.message, 5000); view.querySelectorAll('[data-ok],[data-no]').forEach((x) => { x.disabled = false; }); }
      });
      let fund = 'Somiti';
      view.querySelectorAll('[data-fund]').forEach((b) => b.onclick = () => { fund = b.dataset.fund; view.querySelectorAll('[data-fund]').forEach((x) => x.classList.toggle('on', x === b)); });
      if ($('#esave')) $('#esave').onclick = async () => {
        const amt = Number($('#ea').value || 0);
        if (!$('#ep').value.trim()) { $('#eerr').textContent = 'Enter the purpose'; $('#ep').focus(); return; }
        if (!(amt > 0)) { $('#eerr').textContent = 'Enter an amount'; $('#ea').focus(); return; }
        if (!await ask('Save ' + tk(amt) + ' Tk expense from the ' + fund + ' fund?')) return;
        const sb = $('#esave'); sb.disabled = true; sb.textContent = 'Saving…'; $('#eerr').textContent = '';
        try { const r = await api('addExpense', { fund, purpose: $('#ep').value, amount: amt, date: $('#ed').value, paidFrom: $('#ef').value, remarks: $('#er').value }); if (r.pending) await info('Saved for approval. This is a big amount, so a different admin or management member must approve it before it counts.'); else toast('Saved ' + r.voucher); viewExpenses(); }
        catch (e) { $('#eerr').textContent = e.message; sb.disabled = false; sb.textContent = 'Save expense'; }
      };
    } catch (e) { fail(e); }
  }

  async function viewCash() {
    if (!isStaff()) { location.hash = '#/more'; return; }
    busy();
    try {
      const c = await api('cashbook');
      const admin = state.user.role === 'admin';
      const accOpts = moneyOpts(c.accounts);
      if (!c.started) {
        view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Cash book</h2><div class="card"><b>Set opening balances</b><p class="muted">Enter how much is in each place at the START of the chosen day (count the cash, check the bank statement). From then on the app tracks every taka automatically, and the bank balance is never typed by hand again.</p>' +
          (admin ? '<label>Start date</label><input id="od" type="date" value="' + today() + '">' + c.accounts.map((a) => '<label>' + esc(a) + ' (Tk)</label><input data-open="' + esc(a) + '" type="number" inputmode="numeric" value="0">').join('') + '<button class="btn" id="osave">Save opening balances</button><div id="oerr" class="err"></div>' : '<p>Ask the admin to set opening balances.</p>') + '</div>';
        if ($('#osave')) $('#osave').onclick = async () => {
          if (!await ask('Save opening balances? This is the starting point for all balances.')) return;
          try { for (const i of view.querySelectorAll('[data-open]')) await api('addCash', { type: 'OPENING', to: i.dataset.open, amount: Number(i.value || 0), date: $('#od').value, note: 'Opening balance' }); toast('Saved'); viewCash(); }
          catch (e) { $('#oerr').textContent = e.message; }
        };
        return;
      }
      const ck = c.check;
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Cash book</h2><div class="muted">Tracking since ' + esc(c.start) + '</div>' +
        '<div class="grid" style="margin-top:10px">' + Object.keys(c.balances).map((a) => '<a class="stat tile" href="#/acct/' + encodeURIComponent(a) + '"><div class="l">' + esc(a) + '</div><div class="v">' + tk(c.balances[a]) + ' Tk</div>' + (c.lastRecon[a] ? '<div class="muted">Checked ' + esc(c.lastRecon[a].date) + (c.lastRecon[a].diff ? ' · <span style="color:var(--red)">diff ' + tk(c.lastRecon[a].diff) + '</span>' : ' · ✓') + '</div>' : '') + '<div class="s">View ledger ›</div></a>').join('') +
        '<div class="stat"><div class="l">Total</div><div class="v">' + tk(c.total) + ' Tk</div></div></div>' +
        '<div class="card" style="margin-top:12px;background:' + (ck.ok ? 'var(--grnbg)' : 'var(--redbg)') + '">' + (ck.ok ? '✅ Matches the Dashboard total' + (c.sinceStart.profit || c.sinceStart.charges ? ' (+ bank profit − charges)' : '') : '⚠️ Does not match the Dashboard: app ' + tk(c.total) + ' vs expected ' + tk(ck.expected) + '. Check opening balances or missing entries.') + '</div>' +
        (c.collectors && c.collectors.length ? '<h3>Cash held by collectors</h3><div class="card">' + c.collectors.map((x) => '<div class="kv"><span class="l">' + esc(x.name) + '</span><span class="v">' + tk(x.holding) + ' Tk</span></div>').join('') + '<div class="muted">Cash they received (into Cash) minus what they handed over.</div></div>' : '') +
        (admin ? '<h3>New entry</h3><div class="card"><div class="tabs" style="flex-wrap:wrap"><button data-t="HANDOVER">Handover</button><button class="on" data-t="TRANSFER">Transfer</button><button data-t="BANK_PROFIT">Bank profit</button><button data-t="BANK_CHARGE">Bank charge</button><button data-t="RECON">Check balance</button></div><div id="cf"></div><button class="btn" id="csave">Save</button><div id="cerr" class="err"></div></div>' : '') +
        '<h3>Entries</h3><div class="card">' + (c.entries.map((e, i) => '<div class="ent"><div><b>' + esc(e.type.replace('_', ' ').toLowerCase()) + '</b><div class="muted">' + esc(e.date) + ' · ' + esc([e.from, e.to].filter(Boolean).join(' → ')) + (e.note ? ' · ' + esc(e.note.replace('|', ' · ')) : '') + '</div>' + (admin ? '<button class="btn sm sec" data-cv="' + i + '" style="margin-top:4px" aria-label="More actions">⋯</button>' : '') + '</div><div class="amt">' + tk(e.amount) + '</div></div>').join('') || '<div class="muted">None</div>') + '</div>';
      if (!admin) return;
      view.querySelectorAll('[data-cv]').forEach((b) => b.onclick = () => {
        const e = c.entries[+b.dataset.cv];
        const what = e.type.replace('_', ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()) + ' ' + tk(e.amount) + ' Tk' + (e.from || e.to ? ' (' + [e.from, e.to].filter(Boolean).join(' → ') + ')' : '') + ', ' + e.date;
        rowMenu(what, [{ label: 'Void…', danger: true, run: () => voidFlow({ tab: 'Cash', row: e.row, ref: e.ref, type: e.type, amount: e.amount }, what + (e.type === 'OPENING' ? '\nThis is an opening balance: every balance after it will change.' : '\nThe balances go back to what they were before this entry.'), viewCash) }]);
      });
      let t = 'TRANSFER';
      const form = () => {
        const sel = (id, l) => '<label>' + l + '</label><select id="' + id + '">' + accOpts + '</select>';
        $('#cf').innerHTML = (t === 'HANDOVER' ? '<label>Who is handing over the cash</label><input id="cperson" list="cpl"><datalist id="cpl">' + (c.collectors || []).map((x) => '<option value="' + esc(x.name) + '">').join('') + '</datalist>' + sel('cto', 'Handed into') : t === 'TRANSFER' ? sel('cfrom', 'From') + sel('cto', 'To') : t === 'BANK_PROFIT' ? sel('cto', 'Into') : t === 'BANK_CHARGE' ? sel('cfrom', 'From') : sel('cacc', 'Account')) +
          '<label>' + (t === 'RECON' ? 'Real balance (count cash / bank statement)' : 'Amount (Tk)') + '</label><input id="camt" type="number" inputmode="numeric"><label>Date</label><input id="cdate" type="date" value="' + today() + '"><label>Note</label><input id="cnote">';
        if (t === 'TRANSFER' && $('#cto').options.length > 1) $('#cto').selectedIndex = 1;
      };
      view.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => { t = b.dataset.t; view.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b)); form(); });
      form();
      $('#csave').onclick = async () => {
        try {
          const v = (id) => ($('#' + id) || {}).value;
          if (t === 'RECON') { const r = await api('reconcile', { account: v('cacc'), statementBalance: v('camt'), date: v('cdate'), note: v('cnote') }); await info(r.account + ': real ' + tk(r.statement) + ', app ' + tk(r.app) + (r.difference ? '\nDifference: ' + tk(r.difference) + ' Tk. Find the missing entry.' : '\n✓ Matches')); }
          else await api('addCash', { type: t, from: v('cfrom'), to: v('cto'), person: v('cperson'), amount: v('camt'), date: v('cdate'), note: v('cnote') });
          toast('Saved'); viewCash();
        } catch (e) { $('#cerr').textContent = e.message; }
      };
    } catch (e) { fail(e); }
  }

  /* Ledger of one money account (Cash / Bank / bKash): every in and out for a month, with a running balance. */
  async function viewAcct(args) {
    if (!isStaff()) { location.hash = '#/more'; return; }
    const acct = decodeURIComponent(args[0] || ''); const month = args[1] || '';
    busy();
    try {
      const L = await api('acctLedger', { account: acct, month });
      if (!L.started) { view.innerHTML = '<a href="#/cash" class="muted">← Cash book</a><h2>Account ledger</h2><div class="card">Set opening balances in the Cash book first.</div>'; return; }
      const i = L.months.indexOf(L.month); const prev = i > 0 ? L.months[i - 1] : '', next = i >= 0 && i < L.months.length - 1 ? L.months[i + 1] : '';
      const link = (a, m) => '#/acct/' + encodeURIComponent(a) + (m ? '/' + m : '');
      view.innerHTML = '<a href="#/cash" class="muted">← Cash book</a><h2>' + esc(L.account) + ' ledger</h2>' +
        '<div class="tabs">' + L.accounts.map((a) => '<button type="button" class="' + (a === L.account ? 'on' : '') + '" data-acc="' + esc(a) + '">' + esc(a) + '</button>').join('') + '</div>' +
        '<div class="mnav">' + (prev ? '<a class="btn sm sec" href="' + link(L.account, prev) + '" aria-label="Previous month">‹</a>' : '<span class="btn sm sec off" aria-hidden="true">‹</span>') +
        '<b>' + esc(L.label) + '</b>' + (next ? '<a class="btn sm sec" href="' + link(L.account, next) + '" aria-label="Next month">›</a>' : '<span class="btn sm sec off" aria-hidden="true">›</span>') + '</div>' +
        '<div class="card">' + kvRow('Opening balance', tk(L.opening) + ' Tk') + kvRow('Money in', '<span style="color:var(--grn)">+ ' + tk(L.totalIn) + ' Tk</span>', true) + kvRow('Money out', '<span style="color:var(--red)">− ' + tk(L.totalOut) + ' Tk</span>', true) + kvRow('Closing balance', '<span class="total">' + tk(L.closing) + ' Tk</span>', true) + '</div>' +
        '<h3>Entries (' + L.rows.length + ')</h3><div class="card">' + (L.rows.map((r) => '<div class="ent"><div><b>' + esc(r.text) + '</b><div class="muted">' + esc(r.date) + (r.ref ? ' · ' + esc(r.ref) : '') + '</div></div>' +
          '<div class="amt" style="color:' + (r.amt < 0 ? 'var(--red)' : 'var(--grn)') + '">' + (r.amt < 0 ? '− ' : '+ ') + tk(Math.abs(r.amt)) + '<div class="muted">bal ' + tk(r.bal) + '</div></div></div>').join('') || '<div class="muted">Nothing moved in or out this month.</div>') + '</div>' +
        '<p class="muted">Newest entries are at the bottom. To fix a wrong transfer, void it in the Cash book.</p>';
      view.querySelectorAll('[data-acc]').forEach((b) => b.onclick = () => { location.hash = link(b.dataset.acc, L.month); });
    } catch (e) { fail(e); }
  }

  async function viewReminders() {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    busy();
    try {
      const r = await api('reminders', { send: false });
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Due reminders</h2><div class="card"><div class="kv"><span class="l">Automatic monthly reminder</span><span class="v">' + (r.on ? 'ON · day ' + r.day : 'OFF') + '</span></div><div class="kv"><span class="l">Remind from</span><span class="v">' + r.minMonths + '+ months due</span></div><div class="kv"><span class="l">Last sent</span><span class="v">' + esc(r.lastSent || 'never') + '</span></div><p class="muted">Turn automatic reminders on or off in the App_Settings tab (REMINDERS_ON = YES/NO).</p></div>' +
        '<h3>Members due (' + r.list.length + ')</h3><div class="card">' + (r.list.map((x) => '<div class="ent"><div><b>' + esc(x.name) + '</b> <span class="muted">' + esc(x.mid) + '</span><div class="muted">' + (x.sms ? 'SMS' : 'WhatsApp only') + '</div></div><div class="amt"><span class="chip due">' + x.due + ' Due</span>' + (x.wa ? '<div><a target="_blank" rel="noopener" href="' + esc(x.wa) + '">💬</a></div>' : '') + '</div></div>').join('') || '<div class="muted">Nobody is due</div>') + '</div>' +
        (r.list.length ? '<button class="btn" id="send">Send SMS reminders now (' + r.list.filter((x) => x.sms).length + ')</button>' : '');
      if ($('#send')) $('#send').onclick = async () => {
        if (!await ask('Send due reminder SMS to ' + r.list.filter((x) => x.sms).length + ' members now?')) return;
        try { const s = await api('reminders', { send: true }); toast('Sent ' + s.list.filter((x) => x.sms).length + ' SMS'); viewReminders(); } catch (e) { toast(e.message); }
      };
    } catch (e) { fail(e); }
  }

  async function viewScDue(args) {
    if (!isStaff()) { location.hash = '#/more'; return; }
    const only = args[0] || '';
    busy();
    try {
      const admin = state.user.role === 'admin';
      const [list0, money, hist0] = await Promise.all([api('scDue'), moneyAccounts(), api('scHistory').catch(() => [])]);
      const hist = only ? hist0.filter((x) => x.mid === only) : hist0;
      const list = only ? list0.filter((x) => x.mid === only) : list0;
      const total = list0.reduce((t, x) => t + x.amount, 0);
      view.innerHTML = '<a href="' + (only ? '#/ledger/' + esc(only) : '#/more') + '" class="muted">← Back</a><h2>Service charge due</h2>' +
        (!only ? '<div class="card"><div class="muted">Total not yet paid</div><div class="total">' + tk(total) + ' Tk</div><div class="muted">' + list0.length + ' member(s)</div></div>' : '') +
        (can('payments') && list.length ? '<div class="card"><label>Received into</label><select id="sacct">' + moneyOpts(money) + '</select><label>Collected by</label><input id="scb" placeholder="Who received the money"><label>Date</label><input id="sdate" type="date" value="' + today() + '"></div>' : '') +
        '<div class="card">' + (list.map((x) => '<div class="ent"><div><b>' + esc(x.name) + '</b> <span class="muted">' + esc(x.mid) + '</span><div class="muted">' + esc(x.months.join(', ')) + '</div>' +
          (can('payments') ? '<button class="btn sm" data-col="' + esc(x.mid) + '" style="margin-top:6px">Collect ' + tk(x.amount) + ' Tk</button>' : '') + '</div><div class="amt" style="color:var(--red)">' + tk(x.amount) + '</div></div>').join('') || '<div class="muted">✅ No service charge due</div>') + '</div>' +
        (hist.length ? '<h3>Collected lately (' + hist.length + ')</h3><div class="card">' + hist.map((x, i) => '<div class="ent"><div><b>' + esc(x.name) + '</b> <span class="muted">' + esc(x.mid) + '</span><div class="muted">' + esc(x.date) + ' · ' + esc(x.receipt) + ' · ' + esc(x.months) + (x.collectedBy ? ' · by ' + esc(x.collectedBy) : '') + '</div>' +
          (admin ? '<button class="btn sm sec" data-scv="' + i + '" style="margin-top:6px" aria-label="More actions">⋯</button>' : '') + '</div><div class="amt">' + tk(x.amount) + '</div></div>').join('') + '</div>' : '');
      view.querySelectorAll('[data-scv]').forEach((b) => b.onclick = () => {
        const x = hist[+b.dataset.scv];
        const what = 'Service charge ' + x.receipt + ' (' + tk(x.amount) + ' Tk, ' + x.name + ')';
        rowMenu(what, [{ label: 'Void…', danger: true, run: () => voidFlow({ tab: 'SC', receipt: x.receipt }, what + '\nThose months will show as service charge due again.', () => viewScDue(args)) }]);
      });
      view.querySelectorAll('[data-col]').forEach((b) => b.onclick = async () => {
        const x = list.find((y) => y.mid === b.dataset.col);
        if (!await ask('Collect ' + tk(x.amount) + ' Tk service charge from ' + x.mid + ' (' + x.name + ') for ' + x.months.length + ' month(s)?')) return;
        b.disabled = true; b.textContent = 'Saving…';
        try {
          const r = await api('collectSc', { mid: x.mid, account: $('#sacct').value, collectedBy: $('#scb').value, date: $('#sdate').value, deferSms: true });
          if (r.smsPending) apiLive('sendQueued', { key: r.receipt }).catch(() => {});
          toast('Saved ' + r.receipt + ' · ' + tk(r.amount) + ' Tk');
          if (r.waOnly && r.wa) window.open(r.wa, '_blank');
          state.accounts = null; viewScDue(args);
        } catch (e) { toast(e.message, 5000); b.disabled = false; b.textContent = 'Collect ' + tk(x.amount) + ' Tk'; }
      });
    } catch (e) { fail(e); }
  }

  async function viewReport(args) {
    if (!isStaff()) { location.hash = '#/more'; return; }
    const d0 = new Date(); d0.setDate(0); // default: last month
    const ym = args[0] || (d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0'));
    busy();
    try {
      const r = await api('monthReport', { month: ym });
      const c = r.collections, e = r.expenses;
      const kv = (l, v) => '<div class="kv"><span class="l">' + esc(l) + '</span><span class="v">' + esc(v) + '</span></div>';
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Monthly report</h2><input type="month" id="ym" value="' + esc(ym) + '">' +
        '<h3>' + esc(r.month) + ' · Collections</h3><div class="card">' + kv('Member deposits', tk(c.deposits) + ' Tk') + kv('Service charge', tk(c.serviceCharge) + ' Tk') + kv('Mosjid Fund', tk(c.mosjid) + ' Tk') + kv('Total received', tk(c.deposits + c.serviceCharge + c.mosjid) + ' Tk') + kv('Entries', c.count) +
        Object.keys(c.byAccount).map((a) => kv('Into ' + a, tk(c.byAccount[a]) + ' Tk')).join('') + '</div>' +
        '<h3>Money out</h3><div class="card">' + kv('Somiti expenses', tk(e.Somiti) + ' Tk') + kv('Mosjid expenses', tk(e.Mosjid) + ' Tk') + kv('Member withdrawals', tk(e.Withdrawal || 0) + ' Tk') + kv('Voided entries', r.voided) + '</div>' +
        (r.balances ? '<h3>Balances now</h3><div class="card">' + Object.keys(r.balances).map((a) => kv(a, tk(r.balances[a]) + ' Tk')).join('') + '</div>' : '') +
        '<h3>Members</h3><div class="card">' + kv('New members', r.newMembers.length ? r.newMembers.join(', ') : 'none') + kv('Members due', r.due.length) + kv('Inactive (6+ months)', r.due.filter((x) => x.inactive).length) + '</div>' +
        '<button class="btn" id="rpdf">Download PDF</button>';
      $('#ym').onchange = () => { location.hash = '#/report/' + $('#ym').value; };
      $('#rpdf').onclick = async () => {
        try {
          if (!window.jspdf) { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'); await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'); }
          const clean = (x) => String(x == null ? '' : x).replace(/[^\x20-\x7E]/g, '').trim();
          const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
          doc.setFontSize(16); doc.text('At-Taqwa Somiti - Monthly Report', 40, 50); doc.setFontSize(11); doc.text(r.month, 40, 68);
          const head = { headStyles: { fillColor: [15, 91, 70] }, styles: { fontSize: 9 } };
          doc.autoTable(Object.assign({ startY: 85, head: [['Collections', 'Tk']], body: [['Member deposits', tk(c.deposits)], ['Service charge', tk(c.serviceCharge)], ['Mosjid Fund', tk(c.mosjid)], ['Total received', tk(c.deposits + c.serviceCharge + c.mosjid)]].concat(Object.keys(c.byAccount).map((a) => ['Into ' + a, tk(c.byAccount[a])])) }, head));
          doc.autoTable(Object.assign({ head: [['Money out', 'Tk']], body: [['Somiti expenses', tk(e.Somiti)], ['Mosjid expenses', tk(e.Mosjid)], ['Member withdrawals', tk(e.Withdrawal || 0)], ['Voided entries (count)', String(r.voided)]] }, head));
          if (e.rows.length) doc.autoTable(Object.assign({ head: [['Date', 'Expense', 'Fund', 'Tk']], body: e.rows.map((x) => [x.date, clean(x.purpose), x.fund, tk(x.amount)]) }, head));
          if (r.balances) doc.autoTable(Object.assign({ head: [['Balance now', 'Tk']], body: Object.keys(r.balances).map((a) => [a, tk(r.balances[a])]) }, head));
          doc.autoTable(Object.assign({ head: [['Member ID', 'Name', 'Months due', 'Status']], body: r.due.map((x) => [x.mid, clean(x.name), String(x.due), x.inactive ? 'Inactive' : 'Due']) }, head));
          doc.autoTable(Object.assign({ head: [['Dashboard', 'Value']], body: r.dashboard.flatMap((sct) => sct.items.map((i) => [clean(i.label), clean(i.value)])) }, head));
          doc.save('Somiti-report-' + ym + '.pdf');
        } catch (err) { toast(err.message); }
      };
    } catch (e) { fail(e); }
  }

  async function viewHealth() {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    busy();
    try {
      const list = await api('dataHealth');
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Data check (' + list.length + ')</h2>' +
        (list.length ? '<div class="card">' + list.map((x) => '<div class="ent"><div><b>' + esc(x.name) + '</b> <span class="muted">' + esc(x.mid) + '</span><div class="muted">' + esc(x.issue) + '</div></div>' + (/^ATFS-/.test(x.mid) ? '<a class="btn sm sec" href="#/member/' + esc(x.mid) + '">Fix</a>' : /^(ADMIN|MGT)/.test(x.mid) ? '<a class="btn sm sec" href="#/users">Fix</a>' : '') + '</div>').join('') + '</div>' : '<div class="card">✅ Everything looks complete</div>');
    } catch (e) { fail(e); }
  }

  async function viewClose(args) {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    const mid = args[0]; busy();
    try {
      const [p, money] = await Promise.all([api('closePreview', { mid }), moneyAccounts()]);
      view.innerHTML = '<a href="#/ledger/' + esc(mid) + '" class="muted">← Ledger</a><h2>Close account</h2><div class="card">' +
        '<div class="kv"><span class="l">Member</span><span class="v">' + esc(p.mid + ' · ' + p.name) + '</span></div><div class="kv"><span class="l">Months paid</span><span class="v">' + p.months + '</span></div>' +
        '<div class="kv"><span class="l">Deposit to pay back</span><span class="v total">' + tk(p.deposits) + ' Tk</span></div><div class="muted">Service charges are Somiti income and are not paid back.</div></div>' +
        (!p.ready ? '<div class="card" style="background:var(--redbg)">⚠️ The one-time Dashboard update (applyDashboardV2) has not been run yet.</div>' :
          p.otherAccounts.length ? '<div class="card" style="background:var(--redbg)">⚠️ This member is Account Holder for ' + esc(p.otherAccounts.join(', ')) + '. Move those accounts to another holder first (More › Users › Link / transfer).</div>' :
          '<div class="card"><label>Paid to</label><input id="pto" value="' + esc(p.name) + '"><div class="muted">' + (p.nominee ? 'Nominee: ' + esc(p.nominee) : 'No nominee recorded') + '</div><label>Paid from</label><select id="pfrom">' + moneyOpts(money) + '</select><label>Date</label><input id="pdate" type="date" value="' + today() + '"><label>Reason</label><input id="prs" placeholder="e.g. Member left / passed away (paid to nominee)"><button class="btn" id="pgo" style="background:var(--red)">Close account & record payout</button><div id="perr" class="err"></div></div>');
      if ($('#pgo')) $('#pgo').onclick = async () => {
        if (!$('#prs').value.trim()) { $('#perr').textContent = 'Reason is required'; $('#prs').focus(); return; }
        const cf = await sheet({ title: 'Close ' + p.mid + '?', danger: true, ok: 'Close account', text: 'Pay back ' + tk(p.deposits) + ' Tk to ' + $('#pto').value + '.\nTheir login will be switched off. This cannot be undone from the app.',
          fields: [{ id: 'c', label: 'Type ' + p.mid + ' to confirm', required: true, placeholder: p.mid }] });
        if (!cf) return;
        if (cf.c.toUpperCase() !== p.mid) { toast('Member ID did not match. Nothing was closed.', 5000); return; }
        try {
          const r = await api('closeAccount', { mid, paidTo: $('#pto').value, paidFrom: $('#pfrom').value, date: $('#pdate').value, reason: $('#prs').value, confirmAmount: p.deposits }); state.accounts = null;
          view.innerHTML = '<div class="card"><h2>✅ Account closed</h2><div class="kv"><span class="l">Paid</span><span class="v">' + tk(r.paid) + ' Tk</span></div><div class="kv"><span class="l">Voucher</span><span class="v">' + esc(r.voucher) + '</span></div><div class="kv"><span class="l">Paid to</span><span class="v">' + esc(r.paidTo) + '</span></div><a class="btn" href="#/accounts">Back to accounts</a></div>';
        } catch (e) { $('#perr').textContent = e.message; }
      };
    } catch (e) { fail(e); }
  }

  async function viewBackups() {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    busy();
    try {
      const b = await api('backupStatus');
      const row = (l, v) => '<div class="kv"><span class="l">' + l + '</span><span class="v" style="font-weight:500">' + esc(v) + '</span></div>';
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Backups</h2><div class="card">' +
        row('GitHub repo', b.repo || 'not set') + row('GitHub token', b.hasToken ? 'set' : 'missing') +
        row('Last full backup', b.full) + row('Last quick backup', b.quick) + row('Last Drive copy', b.drive) +
        row('Waiting to back up', b.pending ? 'yes (within 10 min)' : 'no') + row('Schedules', b.triggers.length ? b.triggers.join(', ') : 'not installed') + '</div>' +
        '<button class="btn" id="bn">Back up now</button><div id="berr" class="err"></div>';
      $('#bn').onclick = async () => { const x = $('#bn'); x.disabled = true; x.textContent = 'Backing up…'; try { await api('backupNow'); toast('Done'); viewBackups(); } catch (e) { $('#berr').textContent = e.message; x.disabled = false; x.textContent = 'Back up now'; } };
    } catch (e) { fail(e); }
  }

  async function viewUsers() {
    if (!state.user || state.user.role !== 'admin') { location.hash = '#/more'; return; }
    busy();
    try {
      const users = await api('users');
      view.innerHTML = '<a href="#/more" class="muted">← Settings</a><h2>Users (' + users.length + ')</h2>' +
        '<input class="search" id="q" placeholder="Search name or ID"><div id="ul"></div>' +
        '<h3>Add management / admin user</h3><div class="card"><label>User ID</label><input id="nid" placeholder="e.g. MGT-01" autocapitalize="characters"><label>Name</label><input id="nname"><label>Mobile</label><input id="nphone" inputmode="tel"><label>Role</label><select id="nrole"><option value="management">Management</option><option value="admin">Admin</option></select><button class="btn" id="nadd">Add user</button><div id="nerr" class="err"></div></div>';
      const draw = () => {
        const q = $('#q').value.toLowerCase();
        $('#ul').innerHTML = users.filter((u) => !q || (u.name + ' ' + u.id).toLowerCase().indexOf(q) >= 0).map((u) =>
          '<div class="card"><div class="row" style="justify-content:space-between"><div><b>' + esc(u.name) + '</b><div class="muted">' + esc(u.id) + ' · ' + esc(u.role) + ' · ' + esc(u.phone) + '</div></div><span class="chip ' + (u.status === 'active' ? 'ok' : '') + '">' + esc(u.status === 'active' ? (u.hasPin ? 'login on' : 'no PIN yet') : 'no login') + '</span></div>' +
          (u.accounts.length ? '<div class="muted" style="margin-top:6px">Accounts: ' + esc(u.accounts.join(', ')) + '</div>' : '') +
          (u.role === 'management' ? '<div class="muted" style="margin-top:6px">Extra access: <label style="display:inline"><input type="checkbox" data-perm="payments" data-u="' + esc(u.id) + '" style="width:auto"' + (/payments/.test(u.perms) ? ' checked' : '') + '> payments</label> <label style="display:inline"><input type="checkbox" data-perm="expenses" data-u="' + esc(u.id) + '" style="width:auto"' + (/expenses/.test(u.perms) ? ' checked' : '') + '> expenses</label></div>' : '') +
          '<div class="row" style="margin-top:10px;flex-wrap:wrap">' +
          (u.status === 'active' ? '<button class="btn sm" data-reset="' + esc(u.id) + '">Reset PIN + SMS</button>' : '') +
          (/^ATFS-/.test(u.id) ? '<button class="btn sm sec" data-link="' + esc(u.id) + '">Link / transfer</button>' : '') +
          '<button class="btn sm sec" data-phone="' + esc(u.id) + '">Edit phone</button>' +
          '</div></div>').join('');
        $('#ul').querySelectorAll('[data-reset]').forEach((b) => b.onclick = async () => {
          const id = b.dataset.reset;
          if (!await ask('Make a new PIN for ' + id + ' and send it by SMS?\nTheir old PIN stops working.', 'Make new PIN')) return;
          try {
            const r = await api('resetPin', { userId: id, sendSms: true });
            await showPin(id, r.pin, 'SMS: ' + (r.waOnly ? 'not possible (foreign number)' : (r.sms || 'not sent')));
            if (r.wa && (r.waOnly || await ask('Also send the PIN on WhatsApp?', 'Open WhatsApp'))) window.open(r.wa, '_blank');
            viewUsers();
          } catch (e) { toast(e.message); }
        });
        $('#ul').querySelectorAll('[data-link]').forEach((b) => b.onclick = async () => {
          const mid = b.dataset.link;
          const holders = users.filter((x) => x.status === 'active' && /^ATFS-/.test(x.id) && x.id !== mid).map((x) => [x.id, x.id + ' · ' + x.name]);
          const f = await sheet({ title: 'Link / transfer ' + mid, text: 'Choose the Account Holder who will see this account in their login.',
            fields: [{ id: 'to', label: 'Account Holder', options: [[mid, mid + ' · itself (undo a link)']].concat(holders), value: holders.length ? holders[0][0] : mid }, { id: 'reason', label: 'Reason', required: true, placeholder: 'e.g. Child account' }], ok: 'Move account' });
          if (!f) return;
          const to = f.to, reason = f.reason;
          try {
            // Ask the server exactly what this will do, show it, and only then save.
            const pv = await apiLive('setHolder', { mid, holderUserId: to, dryRun: true });
            const others = pv.moved.filter((x) => x !== mid);
            const lines = [pv.undo ? mid + ' becomes its own account again.' : mid + ' will move under ' + pv.to + ' · ' + pv.toName + '.'];
            if (others.length) lines.push((pv.undo ? 'These come back with it: ' : 'Its ' + others.length + ' account' + (others.length > 1 ? 's' : '') + ' move too: ') + others.join(', ') + '.');
            if (pv.loginOff) lines.push(mid + "'s own login will switch OFF. " + pv.to + ' will see ' + (others.length ? 'all of these' : 'it') + ' in their app.');
            if (pv.loginOn) lines.push(mid + "'s own login will switch back ON (same PIN as before).");
            lines.push('No money moves. You can undo this later from the same button.');
            if (!await sheet({ title: pv.undo ? 'Undo this link?' : 'Move ' + pv.moved.length + ' account' + (pv.moved.length > 1 ? 's' : '') + '?', text: lines.join('\n\n'), ok: pv.undo ? 'Undo link' : 'Move', danger: pv.loginOff })) return;
            const r = await api('setHolder', { mid, holderUserId: to, reason }); toast('Moved ' + r.moved.join(', ') + ' to ' + r.to, 5000); viewUsers();
          } catch (e) { toast(e.message, 6000); }
        });
        $('#ul').querySelectorAll('[data-phone]').forEach((b) => b.onclick = async () => {
          const id = b.dataset.phone; const cur = (users.find((x) => x.id === id) || {}).phone || '';
          const f = await sheet({ title: 'Mobile number for ' + id, fields: [{ id: 'ph', label: 'Mobile (01XXXXXXXXX, or with country code)', type: 'tel', inputmode: 'tel', value: cur }], ok: 'Save' });
          if (!f) return;
          try { await api('setUserPhone', { userId: id, phone: f.ph }); toast('Saved'); viewUsers(); } catch (e) { toast(e.message); }
        });
        $('#ul').querySelectorAll('[data-perm]').forEach((c) => c.onchange = async () => {
          const id = c.dataset.u;
          const perms = Array.from($('#ul').querySelectorAll('[data-u="' + id + '"]')).filter((x) => x.checked).map((x) => x.dataset.perm);
          try { await api('setPerms', { userId: id, perms }); toast('Access updated'); } catch (e) { toast(e.message); }
        });
      };
      $('#q').oninput = draw; draw();
      $('#nadd').onclick = async () => {
        try {
          const r = await api('addStaff', { userId: $('#nid').value.trim().toUpperCase(), name: $('#nname').value.trim(), phone: $('#nphone').value.trim(), role: $('#nrole').value });
          await showPin($('#nid').value.trim().toUpperCase(), r.pin, 'Give it to them privately.'); viewUsers();
        } catch (e) { $('#nerr').textContent = e.message; }
      };
    } catch (e) { fail(e); }
  }

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // The app opens from the saved copy at once; when a newer version has been downloaded, offer it.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data !== 'update' || document.getElementById('upd')) return;
      const b = document.createElement('button'); b.id = 'upd'; b.className = 'upd'; b.type = 'button'; b.textContent = 'New version ready · tap to update';
      b.onclick = () => location.reload(); document.body.appendChild(b);
    });
  }
  go();
})();
