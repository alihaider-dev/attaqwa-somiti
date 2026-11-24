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
  const CACHEABLE = ['dashboard', 'accounts', 'ledger', 'transactions', 'expenses', 'cashbook', 'profile', 'moneyAccounts', 'users', 'collectorNames', 'pending', 'monthReport'];
  const fresh = {};
  const ckey = (action, data) => 'c_' + (state.user ? state.user.id : '') + '_' + action + '_' + JSON.stringify(data || {});
  function clearCache() { try { Object.keys(localStorage).filter((k) => k.indexOf('ats_c_') === 0).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ } }
  async function api(action, data) {
    if (CACHEABLE.indexOf(action) < 0) {
      if (action !== 'login' && action !== 'logout' && action !== 'preview') { clearCache(); state.money = null; }
      return apiLive(action, data);
    }
    const k = ckey(action, data);
    if (fresh[k] !== undefined) { const d = fresh[k]; delete fresh[k]; return d; }
    const cached = store.get(k);
    if (cached === null || cached === undefined) { const d = await apiLive(action, data); store.set(k, d); return d; }
    const hash = location.hash;
    apiLive(action, data).then((d) => {
      store.set(k, d);
      if (JSON.stringify(d) !== JSON.stringify(cached) && location.hash === hash) { fresh[k] = d; state.accounts = null; go(true); }
    }).catch(() => {});
    return cached;
  }
  async function apiLive(action, data) {
    if (!CFG.API_URL || CFG.API_URL.indexOf('http') !== 0) throw new Error('App not set up: API_URL missing in config.js');
    const res = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight with Apps Script
      body: JSON.stringify(Object.assign({ action, token: state.token }, data || {}))
    });
    const j = await res.json();
    if (!j.ok) {
      if (j.code === 'AUTH') { logout(true); }
      throw new Error(j.error || 'Something went wrong');
    }
    return j.data;
  }

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms || 3000);
  }
  function busy(text) { view.innerHTML = '<div class="loading">' + esc(text || 'Loading…') + '</div>'; }
  function fail(e) { view.innerHTML = '<div class="card"><b>Could not load</b><div class="err">' + esc(e.message) + '</div><button class="btn sec" onclick="location.reload()">Try again</button></div>'; }

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
    const reason = (prompt('VOID ' + what + '\nThis removes it from the totals (a copy is kept in App_Voided).\n\nReason (required):') || '').trim();
    if (!reason) return;
    try { const r = await api('voidEntry', Object.assign({ reason }, payload)); toast('Voided ' + r.voided + ' row(s), ' + tk(r.total) + ' Tk'); state.accounts = null; after && after(); }
    catch (e) { toast(e.message, 5000); }
  }
  let collectorCache = null;
  async function collectorList() { if (!collectorCache) { try { collectorCache = await api('collectorNames'); } catch (e) { collectorCache = []; } } return collectorCache; }

  /* ---------- nav ---------- */
  function navItems() {
    if (!state.user) return [];
    if (!isStaff()) return [['#/accounts', '💳', 'My Accounts'], ['#/more', '⚙️', 'Settings']];
    const n = [['#/dashboard', '📊', 'Dashboard'], ['#/accounts', '👥', 'Accounts']];
    if (can('payments')) n.push(['#/pay', '➕', 'Payment']);
    n.push(['#/tx', '🧾', 'Activity'], ['#/more', '⚙️', 'More']);
    return n;
  }
  function renderChrome() {
    const nav = $('#nav');
    if (!state.user) { nav.classList.add('hidden'); $('#who').textContent = ''; return; }
    $('#who').innerHTML = esc(state.user.name) + '<br>' + esc(state.user.id) + ' · ' + esc(state.user.role);
    const cur = location.hash.split('/').slice(0, 2).join('/');
    nav.innerHTML = navItems().map(([h, i, l]) => '<a href="' + h + '" class="' + (cur === h ? 'on' : '') + '"><span class="i">' + i + '</span>' + l + '</a>').join('');
    nav.classList.remove('hidden');
  }

  /* ---------- router ---------- */
  const routes = {
    login: viewLogin, dashboard: viewDashboard, accounts: viewAccounts, ledger: viewLedger,
    pay: viewPay, tx: viewTx, more: viewMore, users: viewUsers,
    member: viewMemberForm, profile: viewProfile, expenses: viewExpenses, cash: viewCash, reminders: viewReminders, backups: viewBackups,
    report: viewReport, health: viewHealth, close: viewClose
  };
  function go(keepScroll) {
    const parts = (location.hash || '').replace(/^#\//, '').split('/');
    let name = parts[0];
    if (!state.token) name = 'login';
    else if (!name || name === 'login') { location.hash = isStaff() ? '#/dashboard' : '#/accounts'; return; }
    renderChrome();
    const y = window.scrollY;
    (routes[name] || viewAccounts)(parts.slice(1));
    if (keepScroll === true) setTimeout(() => window.scrollTo(0, y), 50); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => go());

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

  async function viewDashboard() {
    busy();
    try {
      const d = await api('dashboard');
      const sec = (s) => '<h3>' + esc(s.section || 'Summary') + '</h3><div class="card">' + s.items.map((i) => {
        const ok = /^ok$/i.test(i.value);
        return '<div class="kv"><span class="l">' + esc(i.label.replace(/\s*\((type here|calculated|liability|income)[^)]*\)/i, '')) + '</span><span class="v">' + (ok ? '<span class="chip ok">OK</span>' : esc(i.value)) + '</span></div>';
      }).join('') + '</div>';
      const due = d.members.filter((m) => /due/i.test(m.status));
      view.innerHTML = '<h2>Dashboard</h2>' + d.left.map(sec).join('') + d.right.map(sec).join('') +
        '<h3>Members with dues (' + due.length + ')</h3><div class="card list">' +
        (due.length ? due.map((m) => '<div class="item" data-mid="' + esc(m.mid) + '"><div><div class="t">' + esc(m.name) + '</div><div class="s">' + esc(m.mid) + ' · paid up to ' + esc(m.paidUpTo) + '</div></div>' + statusChip(m.status) + '</div>').join('') : '<div class="muted">Nobody is due 🎉</div>') + '</div>';
      view.querySelectorAll('[data-mid]').forEach((el) => el.onclick = () => location.hash = '#/ledger/' + el.dataset.mid);
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
            '<div class="item" data-mid="' + esc(a.mid) + '"><div><div class="t">' + esc(a.name) + (a.inactive ? ' <span class="chip due">Inactive</span>' : '') + '</div><div class="s">' + esc(a.mid) + ' · ' + esc(a.totalDeposit) + ' Tk · up to ' + esc(a.paidUpTo) + (a.holder && a.holder !== a.mid ? ' · under ' + esc(a.holder) : '') + '</div></div>' + statusChip(a.status) + '</div>').join('') +
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
          '<div class="kv"><span class="l">Status</span><span class="v">' + statusChip(s.status) + '</span></div>'
          : '<div class="kv"><span class="l">Total received</span><span class="v">' + tk(total) + ' Tk</span></div>') +
        '</div><button class="btn sec" id="pdf">⬇ Download statement (PDF)</button>' +
        (L.mid !== 'ATFS-0000' ? '<a class="btn sec" href="#/profile/' + esc(L.mid) + '">👤 Member profile</a>' : '') +
        (L.donations && L.donations.length ? '<h3>Mosjid Fund donations (' + tk(L.donations.reduce((t, d) => t + d.amount, 0)) + ' Tk)</h3><div class="card">' + L.donations.map((d) => '<div class="ent"><div><b>' + esc(d.date) + '</b><div class="muted">' + esc(d.receipt) + '</div></div><div class="amt">' + tk(d.amount) + '</div></div>').join('') + '</div>' : '') +
        '<h3>History (' + L.entries.length + ')</h3><div class="card">' +
        (L.entries.map((e, i) => '<div class="ent"><div><b>' + esc(e.forMonth) + '</b><div class="muted">Paid ' + esc(e.date) + (e.receipt ? ' · ' + esc(e.receipt) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' +
          '<div class="row" style="margin-top:4px;gap:6px">' + (e.receipt ? '<button class="btn sm sec" data-share="' + i + '">🧾 Receipt</button>' : '') + (state.user.role === 'admin' ? '<button class="btn sm sec" data-void="' + i + '" style="color:var(--red)">Void</button>' : '') + '</div></div>' +
          '<div class="amt">' + tk(e.deposit) + (e.sc ? '<div class="muted">+' + tk(e.sc) + ' SC</div>' : '') + '</div></div>').join('') || '<div class="muted">No entries yet</div>') + '</div>' +
        (state.user.role === 'admin' && L.mid !== 'ATFS-0000' && s.mid ? '<a class="btn sec" style="color:var(--red)" href="#/close/' + esc(L.mid) + '">Close account / withdrawal</a>' : '');
      $('#pdf').onclick = () => statementPdf(L);
      view.querySelectorAll('[data-share]').forEach((b) => b.onclick = () => {
        const e = L.entries[+b.dataset.share]; const same = L.entries.filter((x) => x.receipt === e.receipt);
        shareReceipt({ receipt: e.receipt, member: L.mid + ' · ' + L.name, forText: same.length > 1 ? same[same.length - 1].forMonth + ' to ' + same[0].forMonth + ' (' + same.length + ' months)' : e.forMonth, date: e.date, collectedBy: e.collectedBy, amount: same.reduce((t, x) => t + x.deposit + x.sc, 0) });
      });
      view.querySelectorAll('[data-void]').forEach((b) => b.onclick = () => {
        const e = L.entries[+b.dataset.void];
        const payload = e.receipt ? { tab: 'Receive', receipt: e.receipt } : { tab: 'Receive', row: e.row, mid: L.mid };
        const n = e.receipt ? L.entries.filter((x) => x.receipt === e.receipt).length : 1;
        voidFlow(payload, e.receipt ? 'receipt ' + e.receipt + ' (' + n + ' month' + (n > 1 ? 's' : '') + ')' : e.forMonth + ' entry', () => viewLedger([L.mid]));
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
      const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
      const s = L.summary || {};
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

  async function viewPay(args) {
    if (!can('payments')) { location.hash = '#/accounts'; return; }
    busy();
    let list, money;
    try { [list, money] = await Promise.all([loadAccounts(), moneyAccounts()]); } catch (e) { return fail(e); }
    const mode = args[0] === 'mosjid' ? 'mosjid' : 'member';
    const opts = list.map((a) => '<option value="' + esc(a.mid) + '">' + esc(a.mid + ' · ' + a.name) + '</option>').join('');
    const common = '<label>Deposit date</label><input id="dd" type="date" value="' + today() + '">' +
      '<label>Collected by</label><input id="cb" list="cbl" placeholder="Who received the money"><datalist id="cbl"></datalist>' +
      '<label>Received into</label><select id="acct">' + moneyOpts(money) + '</select>';
    view.innerHTML = '<h2>New Payment</h2><div class="tabs"><button class="' + (mode === 'member' ? 'on' : '') + '" onclick="location.hash=\'#/pay\'">Member deposit</button><button class="' + (mode === 'mosjid' ? 'on' : '') + '" onclick="location.hash=\'#/pay/mosjid\'">🕌 Mosjid Fund</button></div>' +
      '<div class="card">' + (mode === 'member'
        ? '<label>Member</label><select id="mid"><option value="">Choose member…</option>' + opts + '</select>' +
          '<label>Number of months</label><div class="stepper"><button type="button" id="minus">−</button><input id="cnt" type="number" min="1" max="60" value="1" inputmode="numeric"><button type="button" id="plus">+</button></div>' +
          common + '<label>Remarks (optional)</label><input id="rm">'
        : '<label>Donors</label><div id="donors"></div><button type="button" class="btn sm sec" id="addd" style="margin-top:8px">+ Add donor</button>' +
          '<div class="preview"><div class="kv"><span class="l">Total</span><span class="v total" id="dtot">0 Tk</span></div></div>' + common) +
      '<div id="pv"></div><div id="perr" class="err"></div>' +
      '<button class="btn" id="go">' + (mode === 'member' ? 'Preview' : 'Save donation') + '</button></div>';

    collectorList().then((l) => { const d = $('#cbl'); if (d) d.innerHTML = l.map((n) => '<option value="' + esc(n) + '">').join(''); });
    if (mode === 'mosjid') {
      const donorRow = () => {
        const d = document.createElement('div'); d.className = 'row'; d.style.marginTop = '8px';
        d.style.flexWrap = 'wrap';
        d.innerHTML = '<select class="dmid" style="flex:1 1 100%"><option value="">Other (type name)</option>' + opts + '</select><input class="dname" placeholder="Name" style="flex:2"><input class="damt" type="number" inputmode="numeric" placeholder="Tk" style="flex:1"><button type="button" class="btn sm sec drm">✕</button>';
        d.querySelector('.dmid').onchange = (e) => { const n = d.querySelector('.dname'); n.style.display = e.target.value ? 'none' : ''; };
        d.querySelector('.damt').oninput = sum;
        d.querySelector('.drm').onclick = () => { d.remove(); sum(); };
        $('#donors').appendChild(d);
      };
      const rows = () => Array.from(document.querySelectorAll('#donors .row')).map((d) => ({ mid: d.querySelector('.dmid').value, name: d.querySelector('.dmid').value ? '' : d.querySelector('.dname').value.trim(), amount: Number(d.querySelector('.damt').value || 0) })).filter((x) => x.amount > 0);
      function sum() { $('#dtot').textContent = tk(rows().reduce((t, x) => t + x.amount, 0)) + ' Tk'; }
      donorRow(); $('#addd').onclick = donorRow;
      $('#go').onclick = async () => {
        const b = $('#go'); $('#perr').textContent = '';
        const donors = rows(); const total = donors.reduce((t, x) => t + x.amount, 0);
        if (!donors.length) { $('#perr').textContent = 'Add at least one donor with an amount'; return; }
        if (!confirm('Save ' + tk(total) + ' Tk to Mosjid Fund from ' + donors.length + ' donor(s)?')) return;
        b.disabled = true; b.textContent = 'Saving…';
        try {
          const r = await api('addMosjid', { donors, depositDate: $('#dd').value, collectedBy: $('#cb').value, account: $('#acct').value });
          view.innerHTML = '<div class="card"><h2>✅ Saved</h2><div class="kv"><span class="l">Receipt</span><span class="v">' + esc(r.receipt) + '</span></div><div class="kv"><span class="l">Total</span><span class="v">' + tk(r.amount) + ' Tk</span></div><div class="kv"><span class="l">Donors</span><span class="v">' + esc(r.donors) + '</span></div><button class="btn sec" id="shr">🧾 Share receipt image</button><a class="btn sec" href="#/pay/mosjid" onclick="setTimeout(()=>location.reload(),50)">New entry</a></div>';
          $('#shr').onclick = () => shareReceipt({ receipt: r.receipt, member: 'Mosjid Fund donation', forText: r.donors, date: new Date().toDateString(), amount: r.amount });
        } catch (e) { $('#perr').textContent = e.message; b.disabled = false; b.textContent = 'Save donation'; }
      };
      return;
    }

    let pv = null;
    const reset = () => { pv = null; $('#pv').innerHTML = ''; $('#go').textContent = 'Preview'; };
    $('#mid').onchange = reset; $('#cnt').oninput = reset;
    $('#minus').onclick = () => { $('#cnt').value = Math.max(1, (+$('#cnt').value || 1) - 1); reset(); };
    $('#plus').onclick = () => { $('#cnt').value = Math.min(60, (+$('#cnt').value || 1) + 1); reset(); };
    $('#go').onclick = async () => {
      const b = $('#go'); $('#perr').textContent = '';
      const mid = $('#mid').value; if (!mid) { $('#perr').textContent = 'Choose a member'; return; }
      b.disabled = true;
      try {
        if (!pv) {
          b.textContent = 'Checking…';
          pv = await api('preview', { mid, count: $('#cnt').value });
          $('#pv').innerHTML = '<div class="preview"><div class="kv"><span class="l">Last paid</span><span class="v">' + esc(pv.lastPaid) + '</span></div>' +
            '<div class="kv"><span class="l">Months</span><span class="v">' + esc(pv.months.length === 1 ? pv.months[0] : pv.months[0] + ' → ' + pv.months[pv.months.length - 1]) + ' (' + pv.months.length + ')</span></div>' +
            '<div class="kv"><span class="l">Deposit + service charge</span><span class="v">' + tk(pv.deposit) + ' + ' + tk(pv.sc) + ' × ' + pv.months.length + '</span></div>' +
            '<div class="kv"><span class="l">Total to collect</span><span class="v total">' + tk(pv.total) + ' Tk</span></div></div>';
          b.textContent = 'Confirm & save'; b.disabled = false;
        } else {
          b.textContent = 'Saving…';
          const cbIn = $('#cb').value;
          const r = await api('addPayment', { mid, count: pv.months.length, expectFirst: pv.months[0], depositDate: $('#dd').value, collectedBy: $('#cb').value, remarks: $('#rm').value, account: $('#acct').value });
          state.accounts = null;
          view.innerHTML = '<div class="card"><h2>✅ Saved</h2><div class="kv"><span class="l">Receipt</span><span class="v">' + esc(r.receipt) + '</span></div><div class="kv"><span class="l">Member</span><span class="v">' + esc(r.mid + ' · ' + r.name) + '</span></div><div class="kv"><span class="l">Months</span><span class="v">' + esc(r.months.join(', ')) + '</span></div><div class="kv"><span class="l">Total</span><span class="v">' + tk(r.total) + ' Tk</span></div>' +
            (r.sms && !r.waOnly ? '<div class="kv"><span class="l">SMS</span><span class="v muted">' + esc(r.sms) + '</span></div>' : '') +
            (r.wa ? '<a class="btn ' + (r.waOnly ? '' : 'sec') + '" style="background:' + (r.waOnly ? '#25D366' : '') + '" href="' + esc(r.wa) + '" target="_blank" rel="noopener">💬 Send on WhatsApp' + (r.waOnly ? ' (no SMS for this number)' : '') + '</a>' : '') +
            '<button class="btn sec" id="shr">🧾 Share receipt image</button><a class="btn" href="#/ledger/' + esc(r.mid) + '">View ledger</a><a class="btn sec" href="#/pay" onclick="setTimeout(()=>location.reload(),50)">New payment</a></div>';
          const cbv = cbIn; $('#shr').onclick = () => shareReceipt({ receipt: r.receipt, member: r.mid + ' · ' + r.name, forText: r.months.length > 1 ? r.months[0] + ' to ' + r.months[r.months.length - 1] + ' (' + r.months.length + ' months)' : r.months[0], date: new Date().toDateString(), collectedBy: cbv, amount: r.total });
        }
      } catch (e) { $('#perr').textContent = e.message; b.disabled = false; b.textContent = pv ? 'Confirm & save' : 'Preview'; }
    };
  }

  async function viewTx() {
    busy();
    try {
      const t = await api('transactions', { limit: 100 });
      view.innerHTML = '<h2>Recent activity</h2><div class="card">' + t.map((e, i) =>
        '<div class="ent"><div><b>' + esc(e.name) + '</b> <span class="muted">' + esc(e.mid) + '</span><div class="muted">' + esc(e.date) + ' · for ' + esc(e.forMonth) + (e.receipt ? ' · ' + esc(e.receipt) : '') + (e.collectedBy ? ' · by ' + esc(e.collectedBy) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' +
        (state.user.role === 'admin' ? '<button class="btn sm sec" data-void="' + i + '" style="color:var(--red);margin-top:4px">Void</button>' : '') + '</div><div class="amt">' + tk(e.deposit) + '</div></div>').join('') + '</div>';
      view.querySelectorAll('[data-void]').forEach((b) => b.onclick = () => {
        const e = t[+b.dataset.void];
        voidFlow(e.receipt ? { tab: 'Receive', receipt: e.receipt } : { tab: 'Receive', row: e.row, mid: e.mid }, (e.receipt ? 'receipt ' + e.receipt : e.mid + ' ' + e.forMonth) + ' (' + e.name + ')', viewTx);
      });
    } catch (e) { fail(e); }
  }

  function viewMore() {
    const admin = state.user && state.user.role === 'admin';
    const links = [];
    if (admin) links.push(['#/member', '➕ Add member'], ['#/users', '👤 Users & account linking']);
    if (can('expenses')) links.push(['#/expenses', '💸 Expenses']);
    if (isStaff()) links.push(['#/cash', '🏦 Cash book (Cash / Bank / bKash)']);
    if (isStaff()) links.push(['#/report', '📄 Monthly report']);
    if (admin) links.push(['#/reminders', '🔔 Due reminders'], ['#/health', '🩺 Data check'], ['#/backups', '🗄️ Backups']);
    view.innerHTML = '<h2>' + (isStaff() ? 'More' : 'Settings') + '</h2>' + (links.length ? '<div class="card list">' + links.map(([h, l]) => '<a class="item" href="' + h + '" style="color:inherit;text-decoration:none"><span class="t">' + l + '</span><span class="muted">›</span></a>').join('') + '</div>' : '') +
      '<div class="card" style="margin-top:16px"><b>Change PIN</b><label>Current PIN</label><input id="op" type="password" inputmode="numeric" maxlength="6"><label>New PIN (4 to 6 digits)</label><input id="np" type="password" inputmode="numeric" maxlength="6"><button class="btn" id="cp">Change PIN</button><div id="cerr" class="err"></div></div>' +
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
    ['nominee', 'Nominee name'], ['nomineeRelation', 'Nominee relation'], ['nomineeAddress', 'Nominee address'], ['monthlyDeposit', 'Monthly deposit (Tk)']];

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
      if (!f.name) { $('#ferr').textContent = 'Name is required'; return; }
      const b = $('#save'); b.disabled = true; b.textContent = 'Saving…';
      try {
        if (mid) { await api('updateMember', { mid, fields: f }); toast('Saved'); location.hash = '#/profile/' + mid; return; }
        const r = await api('addMember', { fields: f, holderUserId: $('#holder').value.trim().toUpperCase(), sendPin: $('#sendpin').checked });
        state.accounts = null;
        view.innerHTML = '<div class="card"><h2>✅ Member added</h2><div class="kv"><span class="l">Member ID</span><span class="v">' + esc(r.mid) + '</span></div>' +
          (r.pin ? '<div class="kv"><span class="l">First PIN</span><span class="v">' + esc(r.pin.pin) + '</span></div><div class="kv"><span class="l">SMS</span><span class="v muted">' + esc(r.pin.waOnly ? 'foreign number, use WhatsApp' : r.pin.sms || '-') + '</span></div>' + (r.pin.wa ? '<a class="btn sec" target="_blank" rel="noopener" href="' + esc(r.pin.wa) + '">💬 Send PIN on WhatsApp</a>' : '') : '') +
          '<a class="btn" href="#/pay">Take first payment</a><a class="btn sec" href="#/member" onclick="setTimeout(()=>location.reload(),50)">Add another</a></div>';
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
        '<h3>Recent</h3><div class="card">' + (d.rows.map((e) => '<div class="ent"><div><b>' + esc(e.purpose) + '</b> <span class="chip">' + esc(e.fund) + '</span><div class="muted">' + esc(e.date) + (e.paidFrom ? ' · from ' + esc(e.paidFrom) : '') + (e.voucher ? ' · ' + esc(e.voucher) : '') + (e.remarks ? ' · ' + esc(e.remarks) : '') + '</div>' + (state.user.role === 'admin' && e.fund !== 'Withdrawal' ? '<button class="btn sm sec" data-ev="' + esc(e.row) + '|' + esc(e.amount) + '|' + esc(e.voucher) + '" style="color:var(--red);margin-top:4px">Void</button>' : '') + '</div><div class="amt">' + tk(e.amount) + '</div></div>').join('') || '<div class="muted">No expenses yet</div>') + '</div>';
      view.querySelectorAll('[data-ev]').forEach((b) => b.onclick = () => { const [row, amount, voucher] = b.dataset.ev.split('|'); voidFlow(voucher ? { tab: 'Expenses', receipt: voucher } : { tab: 'Expenses', row: +row, amount: +amount }, 'expense ' + (voucher || '') + ' (' + tk(amount) + ' Tk)', viewExpenses); });
      view.querySelectorAll('[data-ok],[data-no]').forEach((b) => b.onclick = async () => {
        const ok = !!b.dataset.ok; const id = b.dataset.ok || b.dataset.no;
        if (!confirm((ok ? 'Approve' : 'Reject') + ' this expense?')) return;
        try { const r = await api('decide', { id, approve: ok }); toast(ok ? 'Approved ' + r.voucher : 'Rejected'); viewExpenses(); } catch (e) { toast(e.message); }
      });
      let fund = 'Somiti';
      view.querySelectorAll('[data-fund]').forEach((b) => b.onclick = () => { fund = b.dataset.fund; view.querySelectorAll('[data-fund]').forEach((x) => x.classList.toggle('on', x === b)); });
      if ($('#esave')) $('#esave').onclick = async () => {
        const amt = Number($('#ea').value || 0);
        if (!confirm('Save ' + tk(amt) + ' Tk expense from the ' + fund + ' fund?')) return;
        try { const r = await api('addExpense', { fund, purpose: $('#ep').value, amount: amt, date: $('#ed').value, paidFrom: $('#ef').value, remarks: $('#er').value }); if (r.pending) alert('Saved for approval. This is a big amount, so a different admin or management member must approve it before it counts.'); else toast('Saved ' + r.voucher); viewExpenses(); }
        catch (e) { $('#eerr').textContent = e.message; }
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
          if (!confirm('Save opening balances? This is the starting point for all balances.')) return;
          try { for (const i of view.querySelectorAll('[data-open]')) await api('addCash', { type: 'OPENING', to: i.dataset.open, amount: Number(i.value || 0), date: $('#od').value, note: 'Opening balance' }); toast('Saved'); viewCash(); }
          catch (e) { $('#oerr').textContent = e.message; }
        };
        return;
      }
      const ck = c.check;
      view.innerHTML = '<a href="#/more" class="muted">← More</a><h2>Cash book</h2><div class="muted">Tracking since ' + esc(c.start) + '</div>' +
        '<div class="grid" style="margin-top:10px">' + Object.keys(c.balances).map((a) => '<div class="stat"><div class="l">' + esc(a) + '</div><div class="v">' + tk(c.balances[a]) + ' Tk</div>' + (c.lastRecon[a] ? '<div class="muted">Checked ' + esc(c.lastRecon[a].date) + (c.lastRecon[a].diff ? ' · <span style="color:var(--red)">diff ' + tk(c.lastRecon[a].diff) + '</span>' : ' · ✓') + '</div>' : '') + '</div>').join('') +
        '<div class="stat"><div class="l">Total</div><div class="v">' + tk(c.total) + ' Tk</div></div></div>' +
        '<div class="card" style="margin-top:12px;background:' + (ck.ok ? 'var(--grnbg)' : 'var(--redbg)') + '">' + (ck.ok ? '✅ Matches the Dashboard total' + (c.sinceStart.profit || c.sinceStart.charges ? ' (+ bank profit − charges)' : '') : '⚠️ Does not match the Dashboard: app ' + tk(c.total) + ' vs expected ' + tk(ck.expected) + '. Check opening balances or missing entries.') + '</div>' +
        (c.collectors && c.collectors.length ? '<h3>Cash held by collectors</h3><div class="card">' + c.collectors.map((x) => '<div class="kv"><span class="l">' + esc(x.name) + '</span><span class="v">' + tk(x.holding) + ' Tk</span></div>').join('') + '<div class="muted">Cash they received (into Cash) minus what they handed over.</div></div>' : '') +
        (admin ? '<h3>New entry</h3><div class="card"><div class="tabs" style="flex-wrap:wrap"><button data-t="HANDOVER">Handover</button><button class="on" data-t="TRANSFER">Transfer</button><button data-t="BANK_PROFIT">Bank profit</button><button data-t="BANK_CHARGE">Bank charge</button><button data-t="RECON">Check balance</button></div><div id="cf"></div><button class="btn" id="csave">Save</button><div id="cerr" class="err"></div></div>' : '') +
        '<h3>Entries</h3><div class="card">' + (c.entries.map((e) => '<div class="ent"><div><b>' + esc(e.type.replace('_', ' ').toLowerCase()) + '</b><div class="muted">' + esc(e.date) + ' · ' + esc([e.from, e.to].filter(Boolean).join(' → ')) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="amt">' + tk(e.amount) + '</div></div>').join('') || '<div class="muted">None</div>') + '</div>';
      if (!admin) return;
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
          if (t === 'RECON') { const r = await api('reconcile', { account: v('cacc'), statementBalance: v('camt'), date: v('cdate'), note: v('cnote') }); alert(r.account + ': real ' + tk(r.statement) + ', app ' + tk(r.app) + (r.difference ? '\nDifference: ' + tk(r.difference) + ' Tk. Find the missing entry.' : '\n✓ Matches')); }
          else await api('addCash', { type: t, from: v('cfrom'), to: v('cto'), person: v('cperson'), amount: v('camt'), date: v('cdate'), note: v('cnote') });
          toast('Saved'); viewCash();
        } catch (e) { $('#cerr').textContent = e.message; }
      };
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
        if (!confirm('Send due reminder SMS to ' + r.list.filter((x) => x.sms).length + ' members now?')) return;
        try { const s = await api('reminders', { send: true }); toast('Sent ' + s.list.filter((x) => x.sms).length + ' SMS'); viewReminders(); } catch (e) { toast(e.message); }
      };
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
        '<button class="btn" id="rpdf">⬇ Download PDF</button>';
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
        if (!confirm('Close ' + p.mid + ' and pay back ' + tk(p.deposits) + ' Tk to ' + $('#pto').value + '?\nTheir login will be switched off. This cannot be undone from the app.')) return;
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
          if (!confirm('Make a new PIN for ' + id + ' and send it by SMS?')) return;
          try {
            const r = await api('resetPin', { userId: id, sendSms: true });
            alert('New PIN for ' + id + ': ' + r.pin + '\nSMS: ' + (r.waOnly ? 'not possible (foreign number)' : (r.sms || 'not sent')));
            if (r.wa && (r.waOnly || confirm('Also send the PIN on WhatsApp?'))) window.open(r.wa, '_blank');
            viewUsers();
          } catch (e) { toast(e.message); }
        });
        $('#ul').querySelectorAll('[data-link]').forEach((b) => b.onclick = async () => {
          const mid = b.dataset.link;
          const to = (prompt('Put account ' + mid + ' under which Account Holder ID?\n(Enter ' + mid + ' itself to undo a link)') || '').trim().toUpperCase();
          if (!to) return;
          const reason = (prompt('Reason (required), e.g. "Child account of ' + to + '"') || '').trim();
          if (!reason) { toast('Reason is required'); return; }
          try { const r = await api('setHolder', { mid, holderUserId: to, reason }); toast('Moved ' + r.moved.join(', ') + ' to ' + r.to); viewUsers(); } catch (e) { toast(e.message, 5000); }
        });
        $('#ul').querySelectorAll('[data-phone]').forEach((b) => b.onclick = async () => {
          const id = b.dataset.phone; const cur = (users.find((x) => x.id === id) || {}).phone || '';
          const ph = prompt('Mobile number for ' + id + ' (01XXXXXXXXX, or with country code):', cur);
          if (ph === null) return;
          try { await api('setUserPhone', { userId: id, phone: ph.trim() }); toast('Saved'); viewUsers(); } catch (e) { toast(e.message); }
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
          alert('User added. First PIN: ' + r.pin + '\nGive it to them privately.'); viewUsers();
        } catch (e) { $('#nerr').textContent = e.message; }
      };
    } catch (e) { fail(e); }
  }

  /* ---------- start ---------- */
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  go();
})();
