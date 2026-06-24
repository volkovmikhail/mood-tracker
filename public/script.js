/* MoodTrack — PWA client script */
(() => {
  // ── State ──────────────────────────────────────────────────────
  let currentUser  = null;
  let currentYear  = new Date().getFullYear();
  let selectedDate = null;
  let dataCache    = {};
  let tempToken    = null;
  let saveLock     = false;

  // ── DOM shortcuts ──────────────────────────────────────────────
  const $  = id => document.getElementById(id);
  const $$ = sel => document.querySelectorAll(sel);

  // ── Toast ──────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(msg, type = 'info') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ── API wrapper ─────────────────────────────────────────────────
  async function api(url, opts = {}) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...opts,
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      // If session expired mid-session, kick to auth
      if (res.status === 401 && url !== '/api/auth/me') showAuth();
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: 'Нет соединения' } };
    }
  }

  // ── Date helpers ───────────────────────────────────────────────
  function fmtDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }
  function pad(n) { return String(n).padStart(2,'0'); }

  function fmtLong(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m-1, d).toLocaleDateString('ru-RU', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  // ── Auth UI ────────────────────────────────────────────────────
  function showAuth() {
    $('authScreen').classList.remove('hidden');
    $('mainScreen').classList.add('hidden');
    currentUser = null;
    dataCache   = {};
  }

  function showMain(user) {
    currentUser = user;
    $('authScreen').classList.add('hidden');
    $('mainScreen').classList.remove('hidden');
    const initial = user.username[0].toUpperCase();
    $('avatarInitial').textContent  = initial;
    $('profileAv').textContent      = initial;
    $('profileName').textContent    = user.username;
    $('profileEmail').textContent   = user.email;
    updateTwoFAState(user.totpEnabled);

    // Handle ?tab=today shortcut (PWA shortcut URL)
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab && ['grid','today','profile'].includes(tab)) {
      history.replaceState(null, '', '/');
      switchTab(tab);
    }

    initGrid();
  }

  // ── Auth tabs ──────────────────────────────────────────────────
  $$('.auth-tab').forEach(btn => btn.addEventListener('click', () => {
    $$('.auth-tab').forEach(t => t.classList.toggle('active', t === btn));
    $('loginForm').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('registerForm').classList.toggle('hidden', btn.dataset.tab !== 'register');
    $('totpLoginStep').classList.add('hidden');
    $('loginError').classList.add('hidden');
    $('registerError').classList.add('hidden');
  }));

  // ── Password toggle ────────────────────────────────────────────
  $$('.pw-toggle').forEach(btn => btn.addEventListener('click', () => {
    const inp = btn.previousElementSibling;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }));

  // ── Loading state helper ───────────────────────────────────────
  function setLoading(btn, on) {
    btn.querySelector('.btn-label').classList.toggle('hidden', on);
    btn.querySelector('.btn-spin').classList.toggle('hidden', !on);
    btn.disabled = on;
  }

  // ── Login ──────────────────────────────────────────────────────
  $('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email    = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    const errEl    = $('loginError');
    errEl.classList.add('hidden');

    const btn = $('loginSubmit');
    setLoading(btn, true);
    const { ok, data } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    setLoading(btn, false);

    if (data.requires2FA) {
      tempToken = data.tempToken;
      $('loginForm').classList.add('hidden');
      $('totpLoginStep').classList.remove('hidden');
      $('totpLoginCode').value = '';
      $('totpLoginCode').focus();
    } else if (ok) {
      showMain(data.user);
    } else {
      errEl.textContent = data.error || 'Ошибка входа';
      errEl.classList.remove('hidden');
    }
  });

  // ── TOTP login verification ────────────────────────────────────
  async function verifyTOTPLogin() {
    const token = $('totpLoginCode').value.trim();
    const errEl = $('totpLoginError');
    errEl.classList.add('hidden');
    if (token.length !== 6) {
      errEl.textContent = 'Введите 6-значный код';
      errEl.classList.remove('hidden');
      return;
    }
    const { ok, data } = await api('/api/auth/totp/verify', {
      method: 'POST', body: { tempToken, token },
    });
    if (ok) { tempToken = null; showMain(data.user); }
    else { errEl.textContent = data.error || 'Неверный код'; errEl.classList.remove('hidden'); }
  }

  $('totpVerifyBtn').addEventListener('click', verifyTOTPLogin);
  $('totpLoginCode').addEventListener('input', e => { if (e.target.value.length === 6) verifyTOTPLogin(); });
  $('totpBackBtn').addEventListener('click', () => {
    $('totpLoginStep').classList.add('hidden');
    $('loginForm').classList.remove('hidden');
    tempToken = null;
  });

  // ── Register ───────────────────────────────────────────────────
  $('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = $('regUsername').value.trim();
    const email    = $('regEmail').value.trim();
    const password = $('regPassword').value;
    const confirm  = $('regConfirm').value;
    const errEl    = $('registerError');
    errEl.classList.add('hidden');

    if (password !== confirm) {
      errEl.textContent = 'Пароли не совпадают';
      errEl.classList.remove('hidden');
      return;
    }

    const btn = $('registerSubmit');
    setLoading(btn, true);
    const { ok, data } = await api('/api/auth/register', {
      method: 'POST', body: { username, email, password },
    });
    setLoading(btn, false);

    if (ok) {
      showMain(data.user);
      // Suggest 2FA setup after a moment
      setTimeout(() => {
        toast('Аккаунт создан! Настройте 2FA в профиле для безопасности 🔐', 'info');
      }, 800);
    } else {
      errEl.textContent = data.error || 'Ошибка регистрации';
      errEl.classList.remove('hidden');
    }
  });

  // ── Logout ─────────────────────────────────────────────────────
  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    showAuth();
  });

  // ── Tab navigation ─────────────────────────────────────────────
  function switchTab(name) {
    $$('.tab-panel').forEach(p => {
      p.classList.toggle('active', p.id === `tab${name[0].toUpperCase() + name.slice(1)}`);
      p.classList.toggle('hidden', p.id !== `tab${name[0].toUpperCase() + name.slice(1)}`);
    });
    $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    if (name === 'today') refreshTodayTab();
  }

  $$('.nav-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('profileBtn').addEventListener('click', () => switchTab('profile'));

  // ── 2FA state ──────────────────────────────────────────────────
  function updateTwoFAState(enabled) {
    const desc = $('twoFADesc');
    const btn  = $('twoFABtn');
    if (enabled) {
      desc.textContent  = '✓ Включена';
      desc.style.color  = 'var(--success)';
      btn.textContent   = 'Отключить';
      btn.className     = 'btn-chip danger';
    } else {
      desc.textContent  = 'Не настроена';
      desc.style.color  = '';
      btn.textContent   = 'Настроить';
      btn.className     = 'btn-chip';
    }
    if (currentUser) currentUser.totpEnabled = enabled;
  }

  $('twoFABtn').addEventListener('click', () => {
    if (currentUser?.totpEnabled) openDisable2FA();
    else openSetup2FA();
  });

  // ── 2FA Setup ──────────────────────────────────────────────────
  async function openSetup2FA() {
    $('modal2FASetup').classList.remove('hidden');
    $('qrImg').src             = '';
    $('totpSecretDisplay').textContent = '';
    $('setup2FAToken').value   = '';
    $('setup2FAError').classList.add('hidden');

    const { ok, data } = await api('/api/auth/totp/setup');
    if (ok) {
      $('qrImg').src = data.qrCode;
      $('totpSecretDisplay').textContent = data.secret;
      setTimeout(() => $('setup2FAToken').focus(), 100);
    } else {
      toast('Ошибка загрузки настроек 2FA', 'error');
      $('modal2FASetup').classList.add('hidden');
    }
  }

  function closeSetup2FA() { $('modal2FASetup').classList.add('hidden'); }
  $('close2FASetup').addEventListener('click', closeSetup2FA);
  $('cancelSetup2FA').addEventListener('click', closeSetup2FA);

  $('modal2FASetup').addEventListener('click', e => {
    if (e.target === $('modal2FASetup')) closeSetup2FA();
  });

  async function confirmSetup2FA() {
    const token = $('setup2FAToken').value.trim();
    const errEl = $('setup2FAError');
    errEl.classList.add('hidden');
    if (token.length !== 6) {
      errEl.textContent = 'Введите 6-значный код';
      errEl.classList.remove('hidden');
      return;
    }
    const { ok, data } = await api('/api/auth/totp/enable', { method: 'POST', body: { token } });
    if (ok) {
      updateTwoFAState(true);
      closeSetup2FA();
      toast('Двухфакторная аутентификация включена! 🔐', 'success');
    } else {
      errEl.textContent = data.error || 'Неверный код';
      errEl.classList.remove('hidden');
    }
  }

  $('confirm2FABtn').addEventListener('click', confirmSetup2FA);
  $('setup2FAToken').addEventListener('input', e => { if (e.target.value.length === 6) confirmSetup2FA(); });

  // ── Disable 2FA ────────────────────────────────────────────────
  function openDisable2FA() {
    $('modal2FADisable').classList.remove('hidden');
    $('disable2FAToken').value = '';
    $('disable2FAError').classList.add('hidden');
    setTimeout(() => $('disable2FAToken').focus(), 100);
  }
  function closeDisable2FA() { $('modal2FADisable').classList.add('hidden'); }
  $('close2FADisable').addEventListener('click', closeDisable2FA);
  $('cancelDisable2FA').addEventListener('click', closeDisable2FA);
  $('modal2FADisable').addEventListener('click', e => {
    if (e.target === $('modal2FADisable')) closeDisable2FA();
  });

  async function confirmDisable2FA() {
    const token = $('disable2FAToken').value.trim();
    const errEl = $('disable2FAError');
    errEl.classList.add('hidden');
    if (token.length !== 6) {
      errEl.textContent = 'Введите 6-значный код';
      errEl.classList.remove('hidden');
      return;
    }
    const { ok, data } = await api('/api/auth/totp/disable', { method: 'POST', body: { token } });
    if (ok) {
      updateTwoFAState(false);
      closeDisable2FA();
      toast('2FA отключена', 'info');
    } else {
      errEl.textContent = data.error || 'Неверный код';
      errEl.classList.remove('hidden');
    }
  }

  $('confirmDisable2FABtn').addEventListener('click', confirmDisable2FA);
  $('disable2FAToken').addEventListener('input', e => { if (e.target.value.length === 6) confirmDisable2FA(); });

  // ── Mood Grid ──────────────────────────────────────────────────
  const gridEl  = $('grid');
  const tooltip = $('tileTooltip');

  function renderGrid(year) {
    $('yearLabel').textContent = year;
    gridEl.innerHTML = '';

    const start   = new Date(year, 0, 1);
    const end     = new Date(year, 11, 31);
    const todayStr = new Date().toISOString().slice(0, 10);

    const first = new Date(start);
    first.setDate(start.getDate() - start.getDay());
    const last = new Date(end);
    last.setDate(end.getDate() + (6 - end.getDay()));

    const DAY = 86400000;
    for (let d = new Date(first); d <= last; d = new Date(d.getTime() + DAY)) {
      const el      = document.createElement('div');
      const dateStr = fmtDate(d);
      const inYear  = d >= start && d <= end;

      if (!inYear) {
        el.className = 'tile ghost';
      } else {
        const mood   = dataCache[dateStr];
        const future = dateStr > todayStr;
        el.className = `tile${mood ? ` m${mood}` : ' empty'}${future ? ' future' : ''}`;
        el.dataset.date = dateStr;
        el.setAttribute('role', 'gridcell');
        el.setAttribute('aria-label', fmtLong(dateStr) + (mood ? `, настроение ${mood}` : ''));

        if (!future) {
          el.addEventListener('click',      () => selectDate(dateStr, el));
          el.addEventListener('mouseenter', e  => showTip(e, dateStr));
          el.addEventListener('mouseleave',     hideTip);
        }
      }
      gridEl.appendChild(el);
    }

    // Restore selected tile highlight
    if (selectedDate) {
      const sel = gridEl.querySelector(`[data-date="${selectedDate}"]`);
      if (sel) sel.classList.add('selected');
    }
  }

  function selectDate(dateStr, el) {
    $$('.tile.selected').forEach(t => t.classList.remove('selected'));
    el.classList.add('selected');
    selectedDate = dateStr;
    $('pickerLabel').classList.add('hidden');
    $('pickerDate').textContent = fmtLong(dateStr);
  }

  function showTip(e, dateStr) {
    const r = e.target.getBoundingClientRect();
    tooltip.textContent = fmtLong(dateStr);
    tooltip.style.left  = (r.left + r.width / 2) + 'px';
    tooltip.style.top   = r.top + 'px';
    tooltip.classList.add('show');
    tooltip.setAttribute('aria-hidden', 'false');
  }
  function hideTip() {
    tooltip.classList.remove('show');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  async function fetchYear(year) {
    const { ok, data } = await api(`/api/moods?from=${year}-01-01&to=${year}-12-31`);
    if (ok && Array.isArray(data)) data.forEach(r => { dataCache[r.date] = r.mood; });
  }

  async function saveMood(date, mood) {
    if (saveLock) return;
    saveLock = true;
    const { ok, data } = await api('/api/moods', { method: 'POST', body: { date, mood } });
    saveLock = false;
    if (ok) {
      dataCache[date] = mood;
      const tile = gridEl.querySelector(`[data-date="${date}"]`);
      if (tile) {
        tile.className = `tile m${mood} selected`;
        tile.setAttribute('aria-label', fmtLong(date) + `, настроение ${mood}`);
      }
      toast('Настроение сохранено!', 'success');
    } else {
      toast(data.error || 'Ошибка сохранения', 'error');
    }
  }

  // Mood picker buttons (Grid tab)
  $$('.mood-btn').forEach(btn => btn.addEventListener('click', () => {
    if (!selectedDate) {
      const today = new Date().toISOString().slice(0, 10);
      const tile  = gridEl.querySelector(`[data-date="${today}"]`);
      if (tile) selectDate(today, tile);
      else selectedDate = today;
    }
    saveMood(selectedDate, Number(btn.dataset.mood));
  }));

  $('prevYear').addEventListener('click', async () => {
    currentYear--;
    await fetchYear(currentYear);
    renderGrid(currentYear);
  });
  $('nextYear').addEventListener('click', async () => {
    currentYear++;
    await fetchYear(currentYear);
    renderGrid(currentYear);
  });

  // ── Today Tab ──────────────────────────────────────────────────
  function refreshTodayTab() {
    const todayStr = new Date().toISOString().slice(0, 10);
    const [y, m, d] = todayStr.split('-').map(Number);
    $('todayDate').textContent = new Date(y, m-1, d).toLocaleDateString('ru-RU', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const current = dataCache[todayStr];
    $$('.today-btn').forEach(btn => {
      const isActive = Number(btn.dataset.mood) === current;
      btn.classList.toggle('active', isActive);
      btn.querySelector('.today-check').classList.toggle('hidden', !isActive);
    });
  }

  $$('.today-btn').forEach(btn => btn.addEventListener('click', async () => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const mood     = Number(btn.dataset.mood);
    await saveMood(todayStr, mood);
    refreshTodayTab();
    // Sync the grid tile if viewing current year
    if (currentYear === new Date().getFullYear()) {
      const tile = gridEl.querySelector(`[data-date="${todayStr}"]`);
      if (tile) tile.className = `tile m${mood}`;
    }
  }));

  // ── PWA ───────────────────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ── Boot ──────────────────────────────────────────────────────
  async function initGrid() {
    currentYear  = new Date().getFullYear();
    dataCache    = {};
    selectedDate = new Date().toISOString().slice(0, 10);
    await fetchYear(currentYear);
    renderGrid(currentYear);

    // Auto-select today
    const tile = gridEl.querySelector(`[data-date="${selectedDate}"]`);
    if (tile) {
      tile.classList.add('selected');
      $('pickerLabel').classList.add('hidden');
      $('pickerDate').textContent = fmtLong(selectedDate);
    }
  }

  (async function boot() {
    const { ok, data } = await api('/api/auth/me');
    if (ok) showMain(data);
    else    showAuth();
  })();
})();
