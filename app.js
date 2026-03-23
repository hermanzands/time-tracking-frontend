// ========================================================================
// GLOBALS — API config, state, helpers, clock
// ========================================================================

const API = 'https://time-tracking-backend-production-5baf.up.railway.app';
let token = localStorage.getItem('wt_token');
let user = JSON.parse(localStorage.getItem('wt_user') || 'null');
let allEntriesData = {};

// Simple data cache
const _cache = {};
function cacheSet(key, data) { _cache[key] = { data, ts: Date.now() }; }
function cacheGet(key, maxAgeMs = 30000) { const c = _cache[key]; return c && (Date.now() - c.ts < maxAgeMs) ? c.data : null; }
function cacheInvalidate(key) { delete _cache[key]; }

// Track expanded persons in all-hours table
const expandedPersons = new Set();
const expandedWeeks = new Set();

// All Hours panel state
let allHoursTab = 'active';
let allHoursWeekOffset = 0;

function getWeekRange(offset) {
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function getISOWeekKey(date) {
  const d = new Date(date);
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
}

function getWeekMondayFromKey(key) {
  const [year, w] = key.split('-W');
  const jan4 = new Date(parseInt(year), 0, 4);
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - (jan4.getDay() + 6) % 7 + (parseInt(w) - 1) * 7);
  return monday;
}

function formatWeekLabel(offset) {
  const { start, end } = getWeekRange(offset);
  if (offset === 0) return 'This week';
  if (offset === -1) return 'Last week';
  const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return fmt(start) + ' – ' + fmt(end);
}

function switchHoursTab(tab) {
  allHoursTab = tab;
  document.getElementById('ah-tab-active').classList.toggle('active', tab === 'active');
  document.getElementById('ah-tab-history').classList.toggle('active', tab === 'history');
  const weekNav = document.getElementById('ah-week-nav');
  if (weekNav) weekNav.style.display = tab === 'history' ? 'none' : 'flex';
  document.getElementById('ah-active-view').style.display = tab === 'active' ? '' : 'none';
  document.getElementById('ah-history-view').style.display = tab === 'history' ? '' : 'none';
  loadAllEntries();
}

function toggleHistoryWeek(wkey) {
  const body = document.getElementById('hw-body-' + wkey);
  const arr = document.getElementById('hw-arr-' + wkey);
  if (!body) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? '' : 'none';
  if (arr) arr.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
  if (isHidden) expandedWeeks.add(wkey);
  else expandedWeeks.delete(wkey);
}

window.onload = () => {
  tickClock();
  setInterval(tickClock, 1000);
  setDefaultDates();
  if (token && user) showApp();
};

function tickClock() {
  const n = new Date();
  document.getElementById('live-time').textContent = n.toLocaleTimeString([], {hour12: false});
  document.getElementById('live-date').textContent = n.toLocaleDateString([], {weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'});
}

function toast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(t._t);
  t._t = setTimeout(() => t.className = '', 3200);
}

function hdr() { return {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}; }
function showErr(el, msg) { el.textContent = msg; el.style.display = 'block'; }
function toHm(h) { let hrs = Math.floor(h); let mins = Math.round((h - hrs) * 60); if (mins === 60) { hrs += 1; mins = 0; } if (hrs === 0) return mins + 'm'; if (mins === 0) return hrs + 'h'; return hrs + 'h ' + mins + 'm'; }
function displayName(u) { return u.display_name || u.nickname || 'Unknown'; }
function fmtDate(s) { return new Date(s).toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'}); }
function fmtTime(s) { return new Date(s).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}); }
function togglePwd(inputId, btn) { const inp = document.getElementById(inputId); if (inp.type === 'password') { inp.type = 'text'; btn.textContent = '🙈'; } else { inp.type = 'password'; btn.textContent = '👁'; } }

// Keep backend awake — ping every 10 minutes
setInterval(() => {
  fetch(API + '/api/health').catch(() => {});
}, 10 * 60 * 1000);

// ========================================================================
// AUTH — Login, register, forgot password
// ========================================================================

function showForgotPassword() {
  document.getElementById('form-signin').classList.add('hidden');
  document.getElementById('form-register').classList.add('hidden');
  document.getElementById('form-forgot').classList.remove('hidden');
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
}

function authTab(tab) {
  document.getElementById('form-signin').classList.toggle('hidden', tab !== 'signin');
  document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
  document.getElementById('form-forgot').classList.add('hidden');
  document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
}

async function login() {
  const nick = document.getElementById('l-nick').value.trim();
  const pass = document.getElementById('l-pass').value;
  const errEl = document.getElementById('login-err');
  const btn = document.getElementById('btn-login');
  if (!nick || !pass) { showErr(errEl, 'Please fill in both fields'); return; }
  btn.innerHTML = '<span class="spinner"></span> Signing in...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/auth/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({nickname: nick, password: pass}) });
    const d = await r.json();
    if (d.success) { token = d.accessToken; user = d.user; localStorage.setItem('wt_token', token); localStorage.setItem('wt_user', JSON.stringify(user)); if (d.user.avatar) localStorage.setItem('avatar_' + d.user.id, d.user.avatar); showApp(); }
    else { showErr(errEl, d.error || 'Wrong username or password'); }
  } catch (e) { showErr(errEl, 'Cannot connect to server'); }
  btn.innerHTML = 'Sign In'; btn.disabled = false;
}

function logout() {
  token = null; user = null;
  localStorage.removeItem('wt_token'); localStorage.removeItem('wt_user');
  document.getElementById('screen-app').style.display = 'none';
  document.getElementById('screen-login').style.display = 'flex';
}

async function registerSelf() {
  const nick = document.getElementById('reg-nick').value.trim();
  const pass = document.getElementById('reg-pass').value;
  const errEl = document.getElementById('reg-err-login');
  const btn = document.getElementById('btn-reg');
  if (!nick || !pass) { showErr(errEl, 'Username and password are required'); return; }
  btn.innerHTML = '<span class="spinner"></span> Creating...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/auth/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({nickname: nick, password: pass, phone: document.getElementById('reg-phone')?.value.trim()||undefined, sid: document.getElementById('reg-sid')?.value.trim()||undefined, role: 'employee'}) });
    const d = await r.json();
    if (d.success) {
      authTab('signin');
      const el = document.getElementById('login-err');
      el.style.display = 'block'; el.style.background = 'rgba(0,229,160,.1)'; el.style.borderColor = 'rgba(0,229,160,.3)'; el.style.color = 'var(--green)';
      el.textContent = '✅ Account created! Ask your manager to activate it, then sign in.';
      document.getElementById('l-nick').value = nick;
    } else { showErr(errEl, d.error || 'Registration failed'); }
  } catch (e) { showErr(errEl, 'Cannot connect to server'); }
  btn.innerHTML = 'Create Account'; btn.disabled = false;
}

async function resetPassword() {
  const nick = document.getElementById('forgot-nick').value.trim();
  const errEl = document.getElementById('forgot-err');
  const btn = document.getElementById('btn-forgot');
  if (!nick) { showErr(errEl, 'Please fill in your username'); return; }
  btn.innerHTML = '<span class="spinner"></span> Sending...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/auth/forgot-password', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({nickname: nick}) });
    const d = await r.json();
    authTab('signin');
    const el = document.getElementById('login-err');
    el.style.display = 'block'; el.style.background = 'rgba(0,229,160,.1)'; el.style.borderColor = 'rgba(0,229,160,.3)'; el.style.color = 'var(--green)';
    el.textContent = '✅ If that username exists, please call Henk to reset your password.';
  } catch (e) { showErr(errEl, 'Connection error'); }
  btn.innerHTML = 'Reset Password'; btn.disabled = false;
}


// ========================================================================
// APP — Navigation, notifications, routing
// ========================================================================

let notifications = [];
let notifDropdownOpen = false;

function toggleNotifications() {
  const dropdown = document.getElementById('notif-dropdown');
  notifDropdownOpen = !notifDropdownOpen;
  if (notifDropdownOpen) { dropdown.classList.remove('hidden'); loadNotifications(); }
  else { dropdown.classList.add('hidden'); }
}

async function loadNotifications() {
  try {
    const r = await fetch(API + '/api/users/notifications?limit=20', {headers: hdr()});
    const d = await r.json();
    if (d.success && d.notifications) {
      notifications = d.notifications;
      renderStockNotifications();
      updateNotifBadge(d.notifications.filter(n => !n.is_read).length);
    }
  } catch (e) {}
}

function renderStockNotifications() {
  const list = document.getElementById('notif-list');
  if (notifications.length === 0) { list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">No notifications</div>'; return; }
  let html = '';
  notifications.forEach(notif => {
    const timeAgo = getTimeAgo(new Date(notif.created_at));
    const unreadClass = notif.is_read ? '' : 'unread';
    let icon = '📦', label = 'Stock Alert';
    if (notif.notification_type === 'payment') { icon = '💰'; label = 'Payment'; }
    else if (notif.notification_type === 'system') { icon = '📢'; label = 'System'; }
    html += `<div class="notif-item ${unreadClass}" style="padding:12px;border-bottom:1px solid #eee;">
      <div style="display:flex;align-items:start;gap:10px;">
        <span style="font-size:24px;cursor:pointer;" onclick="viewNotification('${notif.id}','${notif.notification_type}','${notif.related_id||''}')">${icon}</span>
        <div style="flex:1;cursor:pointer;" onclick="viewNotification('${notif.id}','${notif.notification_type}','${notif.related_id||''}')">
          <div style="font-weight:600;color:var(--text);margin-bottom:4px;">${label}</div>
          <div style="color:var(--muted);font-size:13px;">${notif.message}</div>
          <div style="color:var(--muted);font-size:11px;margin-top:4px;">${timeAgo}</div>
        </div>
        <button onclick="deleteNotification('${notif.id}');event.stopPropagation();" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:16px;" title="Delete">✕</button>
        ${!notif.is_read ? '<div style="width:8px;height:8px;background:var(--accent);border-radius:50%;margin-top:8px;"></div>' : ''}
      </div></div>`;
  });
  list.innerHTML = html;
}

function renderPaymentNotifications() {
  const list = document.getElementById('notif-list');
  if (notifications.length === 0) { list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px;">No payments yet</div>'; return; }
  let html = '';
  notifications.slice(0, 10).forEach(n => {
    html += '<div class="notif-item" onclick="viewPayment();event.stopPropagation();">';
    html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;"><div style="font-size:20px;">💰</div>';
    html += '<div style="flex:1;"><div style="font-weight:600;font-size:13px;">Payment Received</div>';
    html += '<div style="font-size:11px;color:var(--muted);">' + fmtDate(n.period_start) + ' – ' + fmtDate(n.period_end) + '</div></div>';
    html += '<div style="width:8px;height:8px;border-radius:50%;background:var(--accent);"></div></div>';
    html += '<div style="font-family:\'Oxanium\',sans-serif;font-weight:700;color:var(--green);font-size:15px;">$' + (Number(n.amount)||0).toFixed(2) + '</div></div>';
  });
  list.innerHTML = html;
}

function viewNotification(notifId, notifType, relatedId) {
  fetch(`${API}/api/users/notifications/${notifId}/read`, {method:'PATCH',headers:hdr()}).then(() => loadNotifications());
  if (notifType === 'stock_alert') go('stock');
  else if (notifType === 'payment') go('earnings');
  document.getElementById('notif-dropdown').classList.add('hidden');
  notifDropdownOpen = false;
}

async function deleteNotification(notifId) {
  // Remove instantly from DOM
  notifications = notifications.filter(n => n.id !== notifId);
  renderStockNotifications();
  updateNotifBadge(notifications.filter(n => !n.is_read).length);
  try {
    await fetch(`${API}/api/notifications/${notifId}`, {method:'DELETE',headers:hdr()});
  } catch(e) {}
}

function viewPayment() { document.getElementById('notif-dropdown').classList.add('hidden'); notifDropdownOpen = false; go('earnings'); }

async function markAllRead() {
  try {
    const r = await fetch(API + '/api/notifications/mark-all-read', {method:'POST',headers:hdr()});
    const d = await r.json();
    if (d.success) { updateNotifBadge(0); toast('✅ Marked all as read'); loadNotifications(); }
  } catch(e) {}
  document.getElementById('notif-dropdown').classList.add('hidden');
  notifDropdownOpen = false;
}

function updateNotifBadge(count) {
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count > 9 ? '9+' : count; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

function showApp() {
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-app').style.display = 'block';
  document.getElementById('nav-name').textContent = user.nickname;
  document.getElementById('nav-role').textContent = user.role;
  loadNotifications();
  if (['manager', 'owner'].includes(user.role)) {
    // Show all admin items
    document.querySelectorAll('.admin-only').forEach(el => { el.classList.remove('hidden'); el.style.display = ''; });
    document.querySelectorAll('.tab-bar').forEach(el => { el.classList.remove('hidden'); });
    // Hide owner-only items for managers
    if (user.role === 'manager') {
      document.querySelectorAll('.owner-only').forEach(el => { el.classList.add('hidden'); el.style.display = 'none'; });
      const payCalcPanel = document.getElementById('panel-payments');
      if (payCalcPanel) payCalcPanel.style.display = 'none';
      const clearBtn = document.getElementById('ah-clear-btn');
      if (clearBtn) clearBtn.style.display = 'none';
    }
    initChat();
    loadPendingEmployees();
  } else {
    document.querySelectorAll('.admin-only').forEach(el => { el.classList.add('hidden'); el.style.display = 'none'; });
    document.querySelectorAll('.tab-bar').forEach(el => { el.classList.add('hidden'); });
  }
sendHeartbeat();
const lastPanel = localStorage.getItem('wt_last_panel');
if (lastPanel && document.getElementById('panel-' + lastPanel)) go(lastPanel);
else go('clock');
  fetch(API + '/api/users', {headers: hdr()}).then(r => r.json()).then(d => {
    if (d.success && d.users) allEmployees = d.users.filter(u => u.is_active);
  }).catch(() => {});
  // Register push notifications
  initPushNotifications();
}

// === PUSH NOTIFICATIONS ===
const VAPID_PUBLIC_KEY = 'BHOEJ-yhOEPT7sLzxU7IsNlyqgrQLcRoZbI8XC8KDtpwAC_15IxPY1NBblW9LXtxSzVk22fq0PgWqCiocy7vbac';

async function initPushNotifications() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Don't auto-request permission — show a button instead
    if (Notification.permission === 'default') {
      showPushPrompt();
      return;
    }
    if (Notification.permission !== 'granted') return;
    await registerPushSubscription();
  } catch(e) {
    console.log('Push notification setup failed:', e);
  }
}

function showPushPrompt() {
  // Only show once per session
  if (sessionStorage.getItem('push_prompt_shown')) return;
  sessionStorage.setItem('push_prompt_shown', '1');
  const banner = document.createElement('div');
  banner.id = 'push-prompt-banner';
  banner.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid #444;border-radius:14px;padding:14px 18px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 8px 32px rgba(0,0,0,.5);max-width:340px;width:90%;';
  banner.innerHTML = `
    <span style="font-size:24px;">🔔</span>
    <div style="flex:1;font-size:13px;color:#e0e0e0;">Enable push notifications to stay updated</div>
    <button onclick="enablePushNotifications()" style="background:var(--accent);border:none;color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">Enable</button>
    <button onclick="document.getElementById('push-prompt-banner').remove()" style="background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 4px;">✕</button>
  `;
  document.body.appendChild(banner);
  // Auto-hide after 10 seconds
  setTimeout(() => banner.remove(), 10000);
}

async function enablePushNotifications() {
  document.getElementById('push-prompt-banner')?.remove();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { toast('Notifications blocked', 'err'); return; }
  await registerPushSubscription();
  toast('🔔 Notifications enabled!');
}

async function registerPushSubscription() {
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const r = await fetch(API + '/api/push/subscribe', {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ subscription: sub.toJSON() })
    });
    const d = await r.json();
    if (!d.success) console.error('Push subscribe failed:', d);
    else console.log('Push subscription saved ✅');
  } catch(e) {
    console.error('registerPushSubscription error:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function go(panel) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const si = document.getElementById('si-' + panel);
  if (si) si.classList.add('active');
  const msi = document.getElementById('msi-' + panel);
  if (msi) msi.classList.add('active');
  document.getElementById('panel-' + panel).classList.add('active');
  localStorage.setItem('wt_last_panel', panel);
  if (panel === 'hours') loadMyEntries();
  if (panel === 'earnings') loadMyPayments();
  if (panel === 'workers') { loadWorkers(); loadPendingEmployees(); }
  if (panel === 'pending') loadPendingEmployees();
  if (panel === 'allhours') loadAllEntries();
  if (panel === 'payments') setDefaultDates();
  if (panel === 'stock') loadStockAlerts();
  if (panel === 'employees') loadEmployees();
  if (panel === 'profile') loadProfile();
  if (panel === 'forum') loadForumPosts();
  if (panel === 'reimburse') loadReimbursements();
  if (panel === 'stats') loadFinanceStats();
  if (panel === 'clock') { loadClockStatus(); loadStats(); }
}


// ========================================================================
// CLOCK — Clock in/out, my entries, my payments, profile
// ========================================================================

async function loadClockStatus() {
  const cached = localStorage.getItem('wt_clock_cache');
  if (cached) {
    const { clocked, clockIn } = JSON.parse(cached);
    if (clocked) setClocked(true, new Date(clockIn));
  }
  try {
    const r = await fetch(API + '/api/time-entries/my-entries?status=active&limit=1', {headers: hdr()});
    const d = await r.json();
    console.log('API response:', d); // ← tijdelijk
    if (d.success && d.entries && d.entries.length > 0 && d.entries[0].status === 'active') {
      const clockIn = d.entries[0].clock_in;
      localStorage.setItem('wt_clock_cache', JSON.stringify({ clocked: true, clockIn }));
      setClocked(true, new Date(clockIn));
    } else {
      localStorage.removeItem('wt_clock_cache');
      setClocked(false);
    }
  } catch(e) {
    console.log('loadClockStatus error:', e); // ← binnen catch
  }
}

function setClocked(on, since) {
  console.log('setClocked called:', on, since);
  const pill = document.getElementById('status-pill'), dot = document.getElementById('status-dot'), txt = document.getElementById('status-txt');
  const ci = document.getElementById('btn-ci'), co = document.getElementById('btn-co'), info = document.getElementById('clock-since');
  if (on) { pill.className = 'status-pill in'; dot.className = 'dot pulse'; txt.textContent = 'Currently clocked in'; ci.disabled = true; co.disabled = false; info.textContent = since ? 'Started at ' + since.toLocaleTimeString() : ''; }
  else { pill.className = 'status-pill out'; dot.className = 'dot'; txt.textContent = 'Not clocked in'; ci.disabled = false; co.disabled = true; info.textContent = ''; }
}

async function clockIn() {
  const btn = document.getElementById('btn-ci'); btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;
  try { const r = await fetch(API + '/api/time-entries/clock-in', {method:'POST',headers:hdr()}); const d = await r.json(); if (d.success) {    const clockIn = new Date().toISOString();   localStorage.setItem('wt_clock_cache', JSON.stringify({ clocked: true, clockIn }));   setClocked(true, new Date());    toast('✅ Clocked in!');    loadStats();  } else { toast(d.error || 'Failed', 'err'); btn.disabled = false; } } catch(e) { toast('Connection error', 'err'); btn.disabled = false; }
  btn.innerHTML = 'Clock In';
}

async function clockOut() {
  const btn = document.getElementById('btn-co'); btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;
  try { const r = await fetch(API + '/api/time-entries/clock-out', {method:'POST',headers:hdr()}); const d = await r.json(); if (d.success) { setClocked(false); toast('👋 Clocked out!'); loadStats(); } else { toast(d.error || 'Failed', 'err'); btn.disabled = false; } } catch(e) { toast('Connection error', 'err'); btn.disabled = false; }
  btn.innerHTML = 'Clock Out';
}

async function loadStats() {
  try {
    const now = new Date(), todayStr = now.toDateString();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    weekStart.setHours(0,0,0,0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const r = await fetch(API + '/api/time-entries/my-entries?limit=500', {headers: hdr()});
    const d = await r.json();
    if (!d.success) return;
    loadClockedInUsers();

    let today = 0, week = 0, month = 0, total = 0;
    (d.entries || []).forEach(e => {
      if (!e.total_hours) return;
      const h = Number(e.total_hours);
      const dt = new Date(e.clock_in);
      total += h;
      if (dt.toDateString() === todayStr) today += h;
      if (dt >= weekStart) week += h;
      if (dt >= monthStart) month += h;
    });

    // Fetch archived entries for month and all-time
    try {
      const ar = await fetch(API + '/api/time-entries?archived=true&limit=2000', {headers: hdr()});
      const ad = await ar.json();
      if (ad.success && ad.entries) {
        ad.entries.forEach(e => {
          if (!e.total_hours || e.user_id !== user.id) return;
          const h = Number(e.total_hours);
          const dt = new Date(e.clock_in);
          total += h;
          if (dt >= monthStart) month += h;
        });
      }
    } catch(e) {}

    document.getElementById('st-today').textContent = toHm(today);
    document.getElementById('st-week').textContent = toHm(week);
    document.getElementById('st-month').textContent = toHm(month);
    const totalEl = document.getElementById('st-total');
    if (totalEl) totalEl.textContent = toHm(total);
  } catch(e) {}
}

async function loadMyEntries() {
  const tb = document.getElementById('my-entries-body');
  tb.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner"></span></td></tr>';
  try {
    const r = await fetch(API + '/api/time-entries/my-entries?limit=100', {headers: hdr()});
    const d = await r.json();
    if (!d.success || !d.entries || d.entries.length === 0) { tb.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📭</div><p>No entries yet</p></div></td></tr>'; return; }
    const validEntries = d.entries.filter(e => e.total_hours && Number(e.total_hours) > 0);
    if (validEntries.length === 0) { tb.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">📭</div><p>No completed entries yet</p></div></td></tr>'; return; }
    let html = '';
    validEntries.forEach(e => { html += '<tr><td>' + fmtDate(e.clock_in) + '</td><td>' + fmtTime(e.clock_in) + '</td><td>' + fmtTime(e.clock_out) + '</td><td>' + Number(e.total_hours).toFixed(2) + 'h</td><td><span class="badge badge-' + e.status + '">' + e.status + '</span></td></tr>'; });
    tb.innerHTML = html;
  } catch(e) { tb.innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">❌</div><p>Failed to load</p></div></td></tr>'; }
}

async function loadMyPayments() {
  const tb = document.getElementById('my-pay-body');
  tb.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner"></span></td></tr>';
  try {
    const r = await fetch(API + '/api/payments/my-payments', {headers: hdr()});
    const d = await r.json();
    if (!d.success || !d.payments || d.payments.length === 0) { tb.innerHTML = '<tr><td colspan="4"><div class="empty"><div class="empty-icon">💵</div><p>No payments recorded yet</p></div></td></tr>'; return; }
    let html = '';
    d.payments.forEach(p => { html += '<tr><td>' + fmtDate(p.period_start) + ' – ' + fmtDate(p.period_end) + '</td><td>' + Number(p.total_hours).toFixed(1) + 'h</td><td style="font-family:\'Oxanium\',sans-serif;font-weight:700;color:var(--green)">$' + (Number(p.amount)||0).toFixed(2) + '</td>' + (['manager','owner'].includes(user.role) ? '<td><button onclick="deletePayment(\'' + p.id + '\')" class="btn-ghost" style="background:rgba(255,85,102,.15);border-color:rgba(255,85,102,.3);color:var(--danger);padding:6px 12px;font-size:12px;">🗑️</button></td></tr>' : '') + ''; });
    tb.innerHTML = html;
    loadNotifications();
  } catch(e) { tb.innerHTML = '<tr><td colspan="4"><div class="empty"><div class="empty-icon">❌</div><p>Failed to load</p></div></td></tr>'; }
}

function loadProfile() {
  if (!user) return;
  const displayName = user.display_name || user.nickname;
  document.getElementById('profile-name').textContent = displayName;
  document.getElementById('profile-role-txt').textContent = user.role;
  document.getElementById('avatar-letter').textContent = displayName[0].toUpperCase();
  const displayNameInput = document.getElementById('profile-display-name');
  if (displayNameInput) displayNameInput.value = user.display_name || '';
  const savedAvatar = localStorage.getItem('avatar_' + user.id);
  if (savedAvatar) { document.getElementById('avatar-img').src = savedAvatar; document.getElementById('avatar-img').style.display = 'block'; }
  else { document.getElementById('avatar-img').style.display = 'none'; }
}

async function updateDisplayName() {
  const input = document.getElementById('profile-display-name');
  const errEl = document.getElementById('display-name-err');
  const display_name = input.value.trim();
  errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/users/me', {
      method: 'PATCH', headers: hdr(),
      body: JSON.stringify({ display_name })
    });
    const d = await r.json();
    if (d.success) {
      user.display_name = display_name;
      localStorage.setItem('wt_user', JSON.stringify(user));
      toast('✅ Display name updated!');
      loadProfile();
    } else { showErr(errEl, d.error || 'Failed to update'); }
  } catch(e) { showErr(errEl, 'Connection error'); }
}

async function uploadAvatar(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Image too large. Max 5MB', 'err'); return; }
  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    try {
      const r = await fetch(API + '/api/users/avatar', {
        method: 'POST', headers: hdr(),
        body: JSON.stringify({ avatar: dataUrl })
      });
      const d = await r.json();
      if (d.success) {
        localStorage.setItem('avatar_' + user.id, dataUrl);
        document.getElementById('avatar-img').src = dataUrl;
        document.getElementById('avatar-img').style.display = 'block';
        toast('✅ Profile picture updated!');
      } else { toast(d.error || 'Failed to save', 'err'); }
    } catch(e) { toast('Connection error', 'err'); }
  };
  reader.readAsDataURL(file);
}

async function removeAvatar() {
  if (!user) return;
  try {
    const r = await fetch(API + '/api/users/avatar', { method: 'DELETE', headers: hdr() });
    const d = await r.json();
    if (d.success) {
      localStorage.removeItem('avatar_' + user.id);
      document.getElementById('avatar-img').style.display = 'none';
      document.getElementById('avatar-img').src = '';
      toast('🗑️ Profile picture removed');
    } else { toast(d.error || 'Failed to remove', 'err'); }
  } catch(e) { toast('Connection error', 'err'); }
}

async function updateProfile() {
  const errEl = document.getElementById('profile-err'); errEl.style.display = 'none';
  toast('Nothing to update');
}

async function changePassword() {
  const current = document.getElementById('pwd-current').value, newPwd = document.getElementById('pwd-new').value; const errEl = document.getElementById('pwd-err'); errEl.style.display = 'none';
  if (!current || !newPwd) { showErr(errEl, 'Please fill in both fields'); return; }
  try { const r = await fetch(API + '/api/auth/change-password', {method:'PATCH',headers:hdr(),body:JSON.stringify({current_password:current,new_password:newPwd})}); const d = await r.json(); if (d.success) { toast('✅ Password changed!'); document.getElementById('pwd-current').value = ''; document.getElementById('pwd-new').value = ''; } else { showErr(errEl, d.error || 'Failed to change password'); } } catch(e) { showErr(errEl, 'Connection error'); }
}


// ========================================================================
// WORKERS — Employee directory, all hours
// ========================================================================

async function loadWorkers() {
  const grid = document.getElementById('workers-grid');
  const cached = cacheGet('workers');
  if (cached) renderWorkers(cached);
  else grid.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const r = await fetch(API + '/api/users', {headers: hdr()});
    const d = await r.json();
    cacheSet('workers', d);
    renderWorkers(d);
  } catch(e) { if (!cached) grid.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><p>Failed to load</p></div>'; }
}

function renderWorkers(d) {
  const grid = document.getElementById('workers-grid');
    if (!d.success || !d.users || d.users.length === 0) { grid.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><p>No workers yet</p></div>'; return; }
    const activeUsers = d.users.filter(u => u.is_active);
    if (activeUsers.length === 0) { grid.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><p>No active workers yet</p></div>'; return; }
    let html = '';
    activeUsers.forEach(u => {
      const safeId = u.id.replace(/[^a-zA-Z0-9]/g, '_');
      const safeName = displayName(u).replace(/'/g, "\\'");
      html += '<div class="worker-card"><div class="worker-row">';
      html += '<div class="avatar"><span class="avatar-letter">' + displayName(u)[0].toUpperCase() + '</span><img class="avatar-img av-' + safeId + '"></div>';
      html += '<div class="worker-info"><div class="worker-name">' + displayName(u) + '</div></div>';
      const isOnline = onlineUsers.has(u.id);
      const dotClass = getInactivityDotClass(u.last_clock_in, isOnline);
      const dotTitle = getInactivityLabel(u.last_clock_in, isOnline);
      html += '<div class="online-dot ' + dotClass + '" title="' + dotTitle + '"></div>';
      html += '</div><div class="worker-actions">';
      html += '<select onchange="updateRole(\'' + u.id + '\', this.value)">';
      (['employee','farmer','loa','manager'].concat(user.role === 'owner' ? ['owner'] : [])).forEach(role => { html += '<option value="' + role + '"' + (u.role === role ? ' selected' : '') + '>' + (role === 'loa' ? 'LOA' : role.charAt(0).toUpperCase()+role.slice(1)) + '</option>'; });
      html += '</select>';
      if (u.id !== user.id) { html += '<button onclick="deleteWorker(\'' + u.id + '\', \'' + safeName + '\')" class="btn-ghost" style="background:rgba(255,85,102,.15);border-color:rgba(255,85,102,.3);color:var(--danger);">🗑️</button>'; }
      html += '</div></div>';
    });
    grid.innerHTML = html;
    activeUsers.forEach(u => { const saved = localStorage.getItem('avatar_' + u.id); if (saved) { const safeId = u.id.replace(/[^a-zA-Z0-9]/g, '_'); document.querySelectorAll('.av-' + safeId).forEach(img => { img.src = saved; img.style.display = 'block'; }); } });
}

async function registerWorker() {
  const displayName = document.getElementById('r-nick').value.trim();
  const sid = document.getElementById('r-sid').value.trim(), phone = document.getElementById('r-phone').value.trim();
  const pass = document.getElementById('r-pass').value, role = document.getElementById('r-role').value;
  const errEl = document.getElementById('reg-err'), btn = document.getElementById('btn-add-worker');
  if (!displayName || !pass) { showErr(errEl, 'Name and password are required'); return; }
  btn.innerHTML = '<span class="spinner"></span> Adding...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/auth/register', {method:'POST',headers:hdr(),body:JSON.stringify({nickname:displayName,password:pass,role,sid:sid||undefined,phone:phone||undefined})});
    const d = await r.json();
    if (d.success) {
      toast('✅ ' + displayName + ' added!');
      ['r-nick','r-pass'].forEach(id => { document.getElementById(id).value = ''; });
      if (d.user && d.user.id) await fetch(API + '/api/users/' + d.user.id + '/activate', {method:'POST',headers:hdr()});
      loadWorkers();
    } else { showErr(errEl, d.error || 'Failed to add worker'); }
  } catch(e) { showErr(errEl, 'Connection error'); }
  btn.innerHTML = 'Add Worker'; btn.disabled = false;
}

async function updateRole(userId, newRole) {
  cacheInvalidate('workers');
  try { const r = await fetch(API + '/api/users/' + userId, {method:'PATCH',headers:hdr(),body:JSON.stringify({role:newRole})}); const d = await r.json(); if (d.success) toast('✅ Role updated!'); else { toast(d.error || 'Failed to update role', 'err'); loadWorkers(); } } catch(e) { toast('Connection error', 'err'); loadWorkers(); }
}

async function deleteWorker(userId, name) {
  const confirmed = await showModal({icon:'🗑️',title:'Delete Worker?',message:'This will permanently delete ' + name + ' and all their data. This action cannot be undone.',confirmText:'Delete',danger:true});
  if (!confirmed) return;
  cacheInvalidate('workers'); cacheInvalidate('allEntries');
  try {
    const r = await fetch(API + '/api/users/' + userId, {method:'DELETE',headers:hdr()});
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (d.success) { toast('🗑️ Worker deleted'); loadWorkers(); } else { toast(d.error || 'Failed to delete', 'err'); }
  } catch(e) { toast('Failed to delete worker', 'err'); }
}

async function unarchiveWeek(wkey) {
  const confirmed = await showModal({
    icon: '↩',
    title: 'Restore Week?',
    message: 'All entries from this week will be moved back to Active. Are you sure?',
    confirmText: 'Restore',
    danger: false
  });
  if (!confirmed) return;
  try {
    // Get all archived entries for this week
    const r = await fetch(API + '/api/time-entries?archived=true&limit=2000', {headers: hdr()});
    const d = await r.json();
    if (!d.success) { toast('Failed to load entries', 'err'); return; }
    const monday = getWeekMondayFromKey(wkey);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23,59,59,999);
    const weekEntries = d.entries.filter(e => {
      const t = new Date(e.clock_in);
      return t >= monday && t <= sunday;
    });
    if (weekEntries.length === 0) { toast('No entries found for this week', 'err'); return; }
    await Promise.all(weekEntries.map(e =>
      fetch(API + '/api/time-entries/' + e.id + '/unarchive', {method: 'PATCH', headers: hdr()})
    ));
    toast('✅ Week restored to Active');
    loadAllEntries();
  } catch(e) { toast('Connection error', 'err'); }
}

async function archiveAllHours() {
  if (user.role !== 'owner') return;

  // Check for active shifts first
  try {
    const activeRes = await fetch(API + '/api/time-entries/active', {headers: hdr()});
    const activeData = await activeRes.json();
    if (activeData.success && activeData.entries && activeData.entries.length > 0) {
      const names = activeData.entries.map(e => e.nickname || 'Unknown').join(', ');
      await showModal({
        icon: '⚠️',
        title: 'Active Shifts Running',
        message: `Cannot archive while employees are clocked in: ${names}. Please clock them out first.`,
        confirmText: 'OK',
        danger: false,
        hideCancel: true
      });
      return;
    }
  } catch(e) {}

  const confirmed = await showModal({
    icon: '📦',
    title: 'Archive All Hours?',
    message: 'All current time entries will be archived and remain visible in the History tab. This cannot be undone.',
    confirmText: 'Archive All',
    danger: false
  });
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/time-entries/all', {method: 'DELETE', headers: hdr()});
    const d = await r.json();
    if (d.success) {
      toast('📦 All hours archived');
      ['active','history'].forEach(t => { for (let i = -52; i <= 0; i++) cacheInvalidate('allEntries_' + t + '_' + i); });
      loadAllEntries();
    } else toast(d.error || 'Failed to archive', 'err');
  } catch(e) { toast('Connection error', 'err'); }
}

async function loadAllEntries() {
  if (allHoursTab === 'active') {
    await loadActiveEntries();
  } else {
    await loadHistoryEntries();
  }
}

async function loadActiveEntries() {
  const tb = document.getElementById('all-entries-body');
  const totalsBar = document.getElementById('ah-totals-bar');
  const totalsText = document.getElementById('ah-totals-text');
  tb.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)"><span class="spinner"></span></td></tr>';
  if (totalsBar) totalsBar.style.display = 'none';

  try {
    const r = await fetch(API + '/api/time-entries?limit=500&archived=false', {headers: hdr()});
    const d = await r.json();
    if (!d.success || !d.entries) { tb.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📭</div><p>No entries yet</p></div></td></tr>'; return; }

    const entries = d.entries.filter(e => e.total_hours && Number(e.total_hours) > 0);

    if (entries.length === 0) {
      tb.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📭</div><p>No entries yet</p></div></td></tr>';
      return;
    }

    const byPerson = {};
    entries.forEach(e => {
      if (!e.total_hours || Number(e.total_hours) === 0) return;
      const key = e.display_name || e.nickname || e.user_id || 'Unknown';
      if (!byPerson[key]) byPerson[key] = {entries:[], user_id:e.user_id};
      byPerson[key].entries.push(e);
      allEntriesData[e.id] = e;
    });

    if (Object.keys(byPerson).length === 0) {
      tb.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">📭</div><p>No completed entries</p></div></td></tr>';
      return;
    }

    let html = '';
    let grandTotal = 0;
    Object.entries(byPerson).forEach(([name, data]) => {
      const personEntries = data.entries;
      const totalHrs = personEntries.reduce((sum, e) => sum + (Number(e.total_hours)||0), 0);
      grandTotal += totalHrs;
      const pid = 'p_' + name.replace(/[^a-z0-9]/gi, '_');
      const safeId = data.user_id ? data.user_id.replace(/[^a-zA-Z0-9]/g, '_') : 'unknown';
      html += '<tr style="background:var(--surface2);cursor:pointer;" onclick="togglePerson(\'' + pid + '\')">';
      html += '<td colspan="6" style="padding:14px 20px;"><div style="display:flex;align-items:center;justify-content:space-between;">';
      html += '<div style="display:flex;align-items:center;gap:12px;"><div class="avatar" style="width:34px;height:34px;border-radius:10px;font-size:14px;"><span class="avatar-letter">' + name[0].toUpperCase() + '</span><img class="avatar-img av-' + safeId + '"></div>';
      html += '<div><div style="font-weight:600;font-size:15px">' + name + '</div><div style="font-size:12px;color:var(--muted);margin-top:2px">' + personEntries.length + ' ' + (personEntries.length === 1 ? 'entry' : 'entries') + ' · ' + toHm(totalHrs) + ' total</div></div></div>';
      html += '<span id="arr_' + pid + '" style="color:var(--muted);font-size:18px;transition:transform .2s;display:inline-block;transform:rotate(-90deg)">▼</span></div></td></tr>';
      personEntries.forEach(e => {
        const hrs = Number(e.total_hours);
        html += '<tr class="entry-row-' + pid + '" style="background:rgba(0,0,0,.15);display:none;">';
        html += '<td style="padding-left:66px;color:var(--muted);font-size:13px">' + fmtDate(e.clock_in) + '</td>';
        html += '<td>' + fmtTime(e.clock_in) + '</td>';
        html += '<td>' + (e.clock_out ? fmtTime(e.clock_out) : '<span style="color:var(--green);font-weight:600">Active ●</span>') + '</td>';
        html += '<td style="font-family:\'Oxanium\',sans-serif;font-weight:600;color:var(--accent)">' + toHm(hrs) + '</td>';
        html += '<td><span class="badge badge-' + e.status + '">' + e.status + '</span></td>';
        html += '<td><button onclick="editTimeEntry(\'' + e.id + '\');event.stopPropagation();" class="btn-ghost" style="padding:6px 12px;font-size:12px;">✏️ Edit</button></td></tr>';
      });
    });
    tb.innerHTML = html;

    // Totals bar
    if (totalsBar && totalsText) {
      const workerCount = Object.keys(byPerson).length;
      totalsText.textContent = toHm(grandTotal) + ' across ' + workerCount + ' worker' + (workerCount !== 1 ? 's' : '');
      totalsBar.style.display = 'flex';
    }

    // Restore avatars
    Object.entries(byPerson).forEach(([name, data]) => {
      if (data.user_id) {
        const saved = localStorage.getItem('avatar_' + data.user_id);
        if (saved) { const sid = data.user_id.replace(/[^a-zA-Z0-9]/g,'_'); document.querySelectorAll('.av-' + sid).forEach(img => { img.src = saved; img.style.display = 'block'; }); }
      }
    });

    // Restore expanded state
    expandedPersons.forEach(pid => {
      const rows = document.querySelectorAll('.entry-row-' + pid);
      const arr = document.getElementById('arr_' + pid);
      if (rows.length) { rows.forEach(row => { row.style.display = ''; }); if (arr) arr.style.transform = 'rotate(0deg)'; }
      else expandedPersons.delete(pid);
    });
  } catch(e) { tb.innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">❌</div><p>Failed to load</p></div></td></tr>'; }
}

async function loadHistoryEntries() {
  const histBody = document.getElementById('ah-history-body');
  histBody.innerHTML = '<div class="empty"><span class="spinner"></span></div>';

  try {
    const r = await fetch(API + '/api/time-entries?limit=2000&archived=true', {headers: hdr()});
    const d = await r.json();
    if (!d.success || !d.entries || d.entries.length === 0) {
      histBody.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>No history yet</p></div>';
      return;
    }

    // Group by ISO week
    const byWeek = {};
    d.entries.forEach(e => {
      if (!e.total_hours || Number(e.total_hours) === 0) return;
      const wkey = getISOWeekKey(e.clock_in);
      if (!byWeek[wkey]) byWeek[wkey] = {};
      const name = e.display_name || e.nickname || 'Unknown';
      if (!byWeek[wkey][name]) byWeek[wkey][name] = { hours: 0, userId: e.user_id };
      byWeek[wkey][name].hours += Number(e.total_hours);
    });

    // Sort weeks newest first
    const sortedWeeks = Object.keys(byWeek).sort((a, b) => b.localeCompare(a));

    if (sortedWeeks.length === 0) {
      histBody.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><p>No history yet</p></div>';
      return;
    }

    let html = '';
    sortedWeeks.forEach((wkey, idx) => {
      const monday = getWeekMondayFromKey(wkey);
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      const fmt = dt => dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
      const [year, wnum] = wkey.split('-W');
      const weekTotal = Object.values(byWeek[wkey]).reduce((sum, p) => sum + p.hours, 0);
      const workerCount = Object.keys(byWeek[wkey]).length;
      const safeKey = wkey.replace('-', '_');
      const isExpanded = expandedWeeks.has(wkey);

      html += '<div style="border:1px solid rgba(255,255,255,.07);border-radius:12px;margin-bottom:8px;overflow:hidden;">';
      // Week header row
      html += '<div onclick="toggleHistoryWeek(\'' + wkey + '\')" style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--surface2);cursor:pointer;">';
      html += '<div style="display:flex;align-items:center;gap:14px;">';
      html += '<div style="font-family:\'Oxanium\',sans-serif;font-weight:700;font-size:22px;color:var(--accent);min-width:32px;text-align:center;">' + parseInt(wnum) + '</div>';
      html += '<div><div style="font-weight:600;font-size:14px;">Week ' + parseInt(wnum) + ' <span style="color:var(--muted);font-weight:400;font-size:12px;">· ' + fmt(monday) + ' – ' + fmt(sunday) + '</span></div>';
      html += '<div style="font-size:12px;color:var(--muted);margin-top:2px;">' + workerCount + ' worker' + (workerCount !== 1 ? 's' : '') + ' · ' + toHm(weekTotal) + ' total</div></div>';
      html += '</div>';
      html += '<div style="display:flex;align-items:center;gap:10px;">';
      if (user.role === 'owner') html += '<button onclick="event.stopPropagation();unarchiveWeek(\'' + wkey + '\')" style="font-size:11px;padding:4px 10px;background:rgba(11,191,255,.1);border:1px solid rgba(11,191,255,.3);border-radius:6px;color:var(--accent);cursor:pointer;">↩ Restore</button>';
      html += '<span id="hw-arr-' + wkey + '" style="color:var(--muted);font-size:16px;transition:transform .2s;display:inline-block;transform:' + (isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)') + '">▼</span>';
      html += '</div></div>';

      // Week body: persons
      html += '<div id="hw-body-' + wkey + '" style="display:' + (isExpanded ? '' : 'none') + ';">';
      Object.entries(byWeek[wkey])
        .sort((a, b) => b[1].hours - a[1].hours)
        .forEach(([name, pdata]) => {
          const safeId = pdata.userId ? pdata.userId.replace(/[^a-zA-Z0-9]/g,'_') : 'unknown';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 18px 10px 58px;border-top:1px solid rgba(255,255,255,.04);">';
          html += '<div style="display:flex;align-items:center;gap:10px;">';
          html += '<div class="avatar" style="width:28px;height:28px;border-radius:8px;font-size:12px;"><span class="avatar-letter">' + name[0].toUpperCase() + '</span><img class="avatar-img av-' + safeId + '"></div>';
          html += '<span style="font-size:14px;font-weight:500;">' + name + '</span></div>';
          html += '<span style="font-family:\'Oxanium\',sans-serif;font-weight:600;font-size:14px;color:var(--accent);">' + toHm(pdata.hours) + '</span>';
          html += '</div>';
        });
      html += '</div>';
      html += '</div>';
    });

    histBody.innerHTML = html;

    // Restore avatars
    d.entries.forEach(e => {
      if (e.user_id) {
        const saved = localStorage.getItem('avatar_' + e.user_id);
        if (saved) { const sid = e.user_id.replace(/[^a-zA-Z0-9]/g,'_'); document.querySelectorAll('.av-' + sid).forEach(img => { img.src = saved; img.style.display = 'block'; }); }
      }
    });
  } catch(e) { histBody.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><p>Failed to load</p></div>'; }
}

function togglePerson(pid) {
  const entries = document.querySelectorAll('.entry-row-' + pid), arr = document.getElementById('arr_' + pid);
  if (!entries.length) return;
  const isHidden = entries[0].style.display === 'none';
  entries.forEach(row => { row.style.display = isHidden ? '' : 'none'; });
  arr.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
  if (isHidden) expandedPersons.add(pid);
  else expandedPersons.delete(pid);
}


// ========================================================================
// PAYMENTS — Pay calculator
// ========================================================================

function setDefaultDates() {
  const now = new Date(), s = document.getElementById('pay-start'), e = document.getElementById('pay-end');
  if (s && !s.value) s.value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  if (e && !e.value) e.value = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  if (s && e) {
    s.onchange = () => { if (s.value > e.value) e.value = s.value; };
    e.onchange = () => { if (e.value < s.value) s.value = e.value; };
  }
}

function setPayThisWeek() {
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = d => d.toISOString().split('T')[0];
  document.getElementById('pay-start').value = fmt(monday);
  document.getElementById('pay-end').value = fmt(sunday);
}

function setPayLastWeek() {
  const now = new Date();
  const dow = now.getDay();
  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  thisMonday.setHours(0,0,0,0);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const fmt = d => d.toISOString().split('T')[0];
  document.getElementById('pay-start').value = fmt(lastMonday);
  document.getElementById('pay-end').value = fmt(lastSunday);
}

function togglePaidItem(safeId, paid) {
  const item = document.getElementById('pay-item-' + safeId);
  const amt = document.getElementById('pay-amt-' + safeId);
  if (!item) return;
  item.style.opacity = paid ? '0.4' : '1';
  if (amt) amt.style.textDecoration = paid ? 'line-through' : '';
}

async function calcPayments() {
  const start = document.getElementById('pay-start').value, end = document.getElementById('pay-end').value, total = parseFloat(document.getElementById('pay-total').value);
  const errEl = document.getElementById('pay-err'), btn = document.getElementById('btn-calc');
  if (!start || !end || !total || total <= 0) { showErr(errEl, 'Please fill in all fields'); return; }
  if (new Date(start) > new Date(end)) { showErr(errEl, 'Start date cannot be after end date'); return; }
  btn.innerHTML = '<span class="spinner"></span> Calculating...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/payments/calculate', {method:'POST',headers:hdr(),body:JSON.stringify({period_start:start,period_end:end,total_amount:total})});
    const d = await r.json();
    if (d.success && d.distributions) {
      const workersRes = await fetch(API + '/api/users', {headers: hdr()}); const workersData = await workersRes.json();
      const allManagers = workersData.success ? workersData.users.filter(u => u.role === 'manager') : [];
      const userMap = {};
      if (workersData.success) workersData.users.forEach(u => { userMap[u.id] = u; });

      // Add managers who didn't work (still get flat 5% bonus share)
      allManagers.forEach(manager => {
        const alreadyIncluded = d.distributions.find(p => p.user_id === manager.id);
        if (!alreadyIncluded) d.distributions.push({user_id:manager.id,nickname:manager.display_name||manager.nickname,role:'manager',total_hours:0,amount:0,percentage:0});
      });

      // Use backend amounts directly — no frontend recalculation
      d.distributions.forEach(p => {
        if (p.role === 'manager' && p._managerBonus === undefined) {
          p._managerBonus = true; // just flag for the +5% bonus tag display
        }
      });
      const list = document.getElementById('pay-list'), wrap = document.getElementById('pay-results');
      wrap.classList.remove('hidden');
      let html = '<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">✓ Check off each person after paying them</div>';
      d.distributions.forEach(p => {
        const safeId = p.user_id ? p.user_id.replace(/[^a-zA-Z0-9]/g,'_') : 'unknown';
        const pct = p.percentage ? ' · ' + (Number(p.percentage)||0).toFixed(1) + '%' : '';
        const bonusTag = p._managerBonus ? ' · <span style="color:var(--green);font-size:11px;">+5% bonus</span>' : '';
        const sid = userMap[p.user_id]?.sid;
        const sidTag = sid ? '<div style="font-size:11px;color:var(--muted);margin-top:1px;">ID: ' + escapeHtml(sid) + '</div>' : '';
        const cbId = 'cb-' + safeId;
        html += '<div class="pay-result-item" id="pay-item-' + safeId + '" style="transition:opacity .2s;">';
        html += '<input type="checkbox" data-sid="' + safeId + '" onchange="togglePaidItem(this.dataset.sid,this.checked)" style="width:18px;height:18px;accent-color:var(--green);flex-shrink:0;cursor:pointer;margin-right:12px;">';
        html += '<div class="pay-worker"><div class="avatar avatar-sm"><span class="avatar-letter">' + (p.display_name||p.nickname||'?')[0].toUpperCase() + '</span><img class="avatar-img pay-av-' + safeId + '"></div>';
        html += '<div><div style="font-weight:500">' + (p.display_name||p.nickname||'Unknown') + '</div>' + sidTag + '<div class="pay-meta">' + Number(p.total_hours||0).toFixed(1) + 'h · <span class="badge badge-' + p.role + '">' + p.role + '</span>' + pct + bonusTag + '</div></div></div>';
        html += '<div class="pay-amount" id="pay-amt-' + safeId + '">$' + Math.round(Number(p.amount)||0) + '</div></div>';
      });
      list.innerHTML = html;
      d.distributions.forEach(p => { if (p.user_id) { const saved = localStorage.getItem('avatar_' + p.user_id); if (saved) { const safeId = p.user_id.replace(/[^a-zA-Z0-9]/g,'_'); document.querySelectorAll('.pay-av-' + safeId).forEach(img => { img.src = saved; img.style.display = 'block'; }); } } });
      document.getElementById('btn-process').classList.remove('hidden');
      toast('✅ Calculation done!');
    } else { showErr(errEl, d.error || 'Calculation failed'); }
  } catch(e) { showErr(errEl, 'Connection error'); }
  btn.innerHTML = 'Calculate'; btn.disabled = false;
}

// ── Add Hours modal (All Hours panel) ─────────────────────────────────────
function showAddHoursModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const box = overlay.querySelector('.modal-box');
    const today = new Date().toISOString().split('T')[0];
    let employeeOptions = allEmployees.map(e =>
      `<option value="${e.id}">${escapeHtml(e.nickname)} (${e.role})</option>`
    ).join('');
    box.innerHTML = `
      <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;margin-bottom:20px;">➕ Add Hours</div>
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="field" style="margin-bottom:0;"><label>Employee</label><select id="add-hours-employee">${employeeOptions}</select></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="field" style="margin-bottom:0;"><label>Date</label><input id="add-hours-date" type="date" value="${today}"></div>
          <div class="field" style="margin-bottom:0;"><label>Hours worked</label><input id="add-hours-amount" type="number" min="0.25" max="24" step="0.25" placeholder="e.g. 4.5"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="field" style="margin-bottom:0;"><label>Clock in</label><input id="add-hours-start" type="time" value="08:00"></div>
          <div class="field" style="margin-bottom:0;"><label>Clock out</label><input id="add-hours-end" type="time" value="16:00"></div>
        </div>
        <div id="add-hours-err" style="display:none;color:var(--danger);font-size:13px;padding:8px 12px;background:rgba(255,85,102,.1);border-radius:8px;border:1px solid rgba(255,85,102,.2);"></div>
      </div>
      <div class="modal-buttons" style="margin-top:20px;">
        <button id="ah-cancel-btn" class="modal-btn modal-btn-cancel">Cancel</button>
        <button id="ah-confirm-btn" class="modal-btn modal-btn-primary">Add Hours</button>
      </div>`;

    // Auto-calc clock out when hours change
    document.getElementById('add-hours-amount').addEventListener('input', () => {
      const startVal = document.getElementById('add-hours-start').value;
      const hrs = parseFloat(document.getElementById('add-hours-amount').value);
      if (startVal && hrs > 0) {
        const [h, m] = startVal.split(':').map(Number);
        const endMins = h * 60 + m + Math.round(hrs * 60);
        const endH = String(Math.floor(endMins / 60) % 24).padStart(2, '0');
        const endM = String(endMins % 60).padStart(2, '0');
        document.getElementById('add-hours-end').value = endH + ':' + endM;
      }
    });

    overlay.classList.add('show');

    document.getElementById('ah-cancel-btn').onclick = () => { overlay.classList.remove('show'); resolve(false); };
    document.getElementById('ah-confirm-btn').onclick = async () => {
      const userId  = document.getElementById('add-hours-employee').value;
      const date    = document.getElementById('add-hours-date').value;
      const startT  = document.getElementById('add-hours-start').value;
      const endT    = document.getElementById('add-hours-end').value;
      const errEl   = document.getElementById('add-hours-err');
      if (!userId || !date || !startT || !endT) { errEl.textContent = 'Please fill in all fields'; errEl.style.display = 'block'; return; }
      const clockIn  = new Date(date + 'T' + startT);
      const clockOut = new Date(date + 'T' + endT);
      if (clockOut <= clockIn) { errEl.textContent = 'Clock out must be after clock in'; errEl.style.display = 'block'; return; }
      const btn = document.getElementById('ah-confirm-btn');
      btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;
      try {
        const r = await fetch(API + '/api/time-entries', {
          method: 'POST', headers: hdr(),
          body: JSON.stringify({ user_id: userId, clock_in: clockIn.toISOString(), clock_out: clockOut.toISOString() })
        });
        const d = await r.json();
        if (d.success) { overlay.classList.remove('show'); resolve(true); }
        else { errEl.textContent = d.error || 'Failed to add hours'; errEl.style.display = 'block'; btn.innerHTML = 'Add Hours'; btn.disabled = false; }
      } catch(e) { errEl.textContent = 'Connection error'; errEl.style.display = 'block'; btn.innerHTML = 'Add Hours'; btn.disabled = false; }
    };
  });
}

async function openAddHoursModal() {
  if (allEmployees.length === 0) {
    const r = await fetch(API + '/api/users', {headers: hdr()});
    const d = await r.json();
    if (d.success) allEmployees = d.users.filter(u => u.is_active);
  }
  const confirmed = await showAddHoursModal();
  if (confirmed) { toast('✅ Hours added!'); loadAllEntries(); }
}

async function processPayments() {
  const start = document.getElementById('pay-start').value, end = document.getElementById('pay-end').value, total = parseFloat(document.getElementById('pay-total').value);
  const errEl = document.getElementById('pay-err'), btn = document.getElementById('btn-process');
  if (!start || !end || !total || total <= 0) { showErr(errEl, 'Please calculate first'); return; }
  btn.innerHTML = '<span class="spinner"></span> Processing...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/payments/process', {method:'POST',headers:hdr(),body:JSON.stringify({period_start:start,period_end:end,total_amount:total})});
    const d = await r.json();
    if (d.success) { toast('✅ Payments processed! Workers have been notified.'); document.getElementById('pay-results').classList.add('hidden'); document.getElementById('btn-process').classList.add('hidden'); ['pay-start','pay-end','pay-total'].forEach(id => { document.getElementById(id).value = ''; }); setDefaultDates(); loadFinanceStats(); }
    else { showErr(errEl, d.error || 'Failed to process payments'); btn.disabled = false; }
  } catch(e) { showErr(errEl, 'Connection error'); btn.disabled = false; }
  btn.innerHTML = 'Process & Send Payments';
}

async function deletePayment(paymentId) {
  const confirmed = await showModal({icon:'💰',title:'Delete Payment?',message:'This will permanently delete this payment record. This action cannot be undone.',confirmText:'Delete',danger:true});
  if (!confirmed) return;
  try { const r = await fetch(API + '/api/payments/' + paymentId, {method:'DELETE',headers:hdr()}); const d = await r.json(); if (d.success) { toast('🗑️ Payment deleted'); loadMyPayments(); } else { toast(d.error || 'Failed to delete', 'err'); } } catch(e) { toast('Connection error', 'err'); }
}


// ========================================================================
// CHAT — Online status, live chat, modal, clocked-in widget, pending approvals
// ========================================================================

let chatOpen = false, onlineUsers = new Set(), lastMessageId = null, chatPollInterval = null;

function getInactivityDotClass(lastClockIn, isOnline) {
  if (isOnline) return 'on';
  if (!lastClockIn) return 'danger'; // never clocked in
  const daysSince = (Date.now() - new Date(lastClockIn).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince < 7) return 'on';
  if (daysSince < 14) return 'warning';
  return 'danger';
}

function getInactivityLabel(lastClockIn, isOnline) {
  if (isOnline) return 'Currently active';
  if (!lastClockIn) return 'Never clocked in';
  const daysSince = Math.floor((Date.now() - new Date(lastClockIn).getTime()) / (1000 * 60 * 60 * 24));
  if (daysSince === 0) return 'Clocked in today';
  if (daysSince === 1) return 'Last seen yesterday';
  if (daysSince < 7) return 'Last seen ' + daysSince + ' days ago';
  if (daysSince < 14) return '⚠️ Inactive for ' + daysSince + ' days';
  return '🔴 Inactive for ' + daysSince + ' days';
}

async function sendHeartbeat() {
  if (!token || !user) return;
  try { const r = await fetch(API + '/api/users/heartbeat', {method:'POST',headers:hdr()}); if (!r.ok && r.status === 401) { logout(); return; } updateOnlineUsers(); } catch(e) {}
}

async function updateOnlineUsers() {
  if (!token) return;
  try { const r = await fetch(API + '/api/users/online', {headers:hdr()}); if (!r.ok) return; const d = await r.json(); if (d.success && d.online_users) { onlineUsers = new Set(d.online_users.map(u => u.id)); } } catch(e) {}
}

setInterval(updateOnlineUsers, 3000);

function toggleChat() {
  const panel = document.getElementById('chat-panel'), arrow = document.getElementById('chat-arrow');
  chatOpen = !chatOpen;
  if (chatOpen) { panel.classList.remove('minimized'); arrow.textContent = '▼'; loadChatMessages(); if (!chatPollInterval) chatPollInterval = setInterval(loadChatMessages, 5000); document.getElementById('chat-badge').classList.add('hidden'); }
  else { panel.classList.add('minimized'); arrow.textContent = '▲'; if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; } }
}

async function loadChatMessages() {
  if (!user || !['manager', 'owner'].includes(user.role)) return;
  try { const r = await fetch(API + '/api/users/chat/messages?limit=50', {headers:hdr()}); if (!r.ok) return; const d = await r.json(); if (d.success && d.messages) { renderChatMessages(d.messages); if (!chatOpen && d.messages.length > 0) { const latestId = d.messages[d.messages.length-1].id; if (lastMessageId && latestId !== lastMessageId) { const badge = document.getElementById('chat-badge'); badge.classList.remove('hidden'); badge.textContent = (parseInt(badge.textContent||'0')+1).toString(); } lastMessageId = latestId; } } } catch(e) {}
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages');
  if (messages.length === 0) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:12px;">No messages yet</div>'; return; }
  let html = '';
  messages.forEach(msg => { const isMe = msg.user_id === user.id; const time = new Date(msg.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); html += '<div class="chat-msg ' + (isMe?'chat-msg-me':'chat-msg-other') + '"><div class="chat-bubble">' + escapeHtml(msg.message) + '</div><div class="chat-meta">' + (isMe?'You':msg.nickname) + ' • ' + time + '</div></div>'; });
  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage() {
  const input = document.getElementById('chat-input'), message = input.value.trim(); if (!message) return;
  try { const r = await fetch(API + '/api/users/chat/send', {method:'POST',headers:hdr(),body:JSON.stringify({message})}); const d = await r.json(); if (d.success) { input.value = ''; loadChatMessages(); } else { toast(d.error || 'Failed to send', 'err'); } } catch(e) { toast('Connection error', 'err'); }
}

function escapeHtml(text) { const div = document.createElement('div'); div.textContent = text; return div.innerHTML; }

function initChat() {
  const chatPanel = document.getElementById('chat-panel'); if (!chatPanel) return;
  if (['manager', 'owner'].includes(user.role)) { chatPanel.classList.remove('hidden'); chatPanel.style.display = 'flex'; loadChatMessages(); setInterval(loadChatMessages, 10000); }
  else { chatPanel.style.display = 'none'; }
}

let modalResolve = null;

function showModal(options) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    const overlay = document.getElementById('modal-overlay');
    const box = overlay.querySelector('.modal-box');
    // Always rebuild so previous modals can't break it
    box.innerHTML = `
      <div id="modal-icon" class="modal-icon"></div>
      <div id="modal-title" class="modal-title"></div>
      <div id="modal-message" class="modal-message"></div>
      <div class="modal-buttons">
        <button id="modal-cancel" class="modal-btn modal-btn-cancel">Cancel</button>
        <button id="modal-confirm" class="modal-btn modal-btn-primary">Confirm</button>
      </div>`;
    document.getElementById('modal-icon').textContent = options.icon || '⚠️';
    document.getElementById('modal-title').textContent = options.title || 'Confirm Action';
    document.getElementById('modal-message').textContent = options.message || 'Are you sure?';
    const confirmBtn = document.getElementById('modal-confirm');
    confirmBtn.textContent = options.confirmText || 'Confirm';
    confirmBtn.className = 'modal-btn ' + (options.danger ? 'modal-btn-confirm' : 'modal-btn-primary');
    document.getElementById('modal-cancel').textContent = 'Cancel';
    document.getElementById('modal-cancel').onclick = closeModal;
    confirmBtn.onclick = confirmModal;
    overlay.classList.add('show');
  });
}

function closeModal() { document.getElementById('modal-overlay').classList.remove('show'); if (modalResolve) { modalResolve(false); modalResolve = null; } }
function confirmModal() { document.getElementById('modal-overlay').classList.remove('show'); if (modalResolve) { modalResolve(true); modalResolve = null; } }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('modal-overlay').classList.contains('show')) closeModal(); });

async function forceClockOut(userId) {
  const confirmed = await showModal({icon:'⏏️', title:'Force Clock Out?', message:'This will clock out this employee immediately.', confirmText:'Clock Out', danger:false});
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/time-entries/force-clock-out/' + userId, {method:'POST', headers:hdr()});
    const d = await r.json();
    if (d.success) {
      toast('✅ Employee clocked out');
      cacheInvalidate('allEntries');
      await loadClockedInUsers();
      loadStats();
    } else { toast(d.error || 'Failed to clock out', 'err'); }
  } catch(e) { toast('Connection error', 'err'); }
}

async function loadClockedInUsers() {
  if (!user) return;
  try { const r = await fetch(API + '/api/time-entries/active', {headers:hdr()}); if (!r.ok) return; const d = await r.json(); if (d.success && d.entries) renderClockedInUsers(d.entries); } catch(e) {}
}

function renderClockedInUsers(entries) {
  const widget = document.getElementById('clocked-in-widget'), list = document.getElementById('clocked-in-list'), count = document.getElementById('clocked-in-count');
  if (!widget || !list || !count) return;
  widget.classList.remove('hidden'); widget.style.display = 'block';
  count.textContent = entries.length;
  if (entries.length === 0) { list.innerHTML = '<div class="clocked-in-empty">No one is clocked in right now</div>'; return; }
  let html = '';
  entries.forEach(entry => {
    const clockedInTime = new Date(entry.clock_in), now = new Date();
    const hours = Math.floor((now-clockedInTime)/1000/60/60), minutes = Math.floor(((now-clockedInTime)/1000/60)%60);
    const duration = hours > 0 ? hours+'h '+minutes+'m' : minutes+'m';
    const initial = (entry.nickname||'?')[0].toUpperCase(), userId = entry.user_id ? entry.user_id.replace(/[^a-zA-Z0-9]/g,'_') : 'unknown';
    html += '<div class="clocked-in-item"><div class="clocked-in-avatar avatar-sm"><span class="avatar-letter">' + initial + '</span><img class="avatar-img clocked-av-' + userId + '"></div>';
    html += '<div class="clocked-in-info"><div class="clocked-in-name">' + (entry.nickname||'Unknown') + '</div><div class="clocked-in-time">Since ' + fmtTime(entry.clock_in) + ' • ' + duration + '</div></div>';
    html += '<div class="clocked-in-badge"><span class="clocked-in-pulse"></span>Active</div>';
    if (['manager','owner'].includes(user.role)) { html += '<button class="btn-ghost" style="padding:4px 10px;font-size:11px;margin-left:8px;" onclick="forceClockOut(\'' + entry.user_id + '\')" title="Force clock out">⏏️</button>'; }
    html += '</div>';
  });
  list.innerHTML = html;
  entries.forEach(entry => { if (entry.user_id) { const saved = localStorage.getItem('avatar_' + entry.user_id); if (saved) { document.querySelectorAll('.clocked-av-' + entry.user_id.replace(/[^a-zA-Z0-9]/g,'_')).forEach(img => { img.src = saved; img.style.display = 'block'; }); } } });
}

async function loadPendingEmployees() {
  if (!user || !['manager', 'owner'].includes(user.role)) return;
  try { const r = await fetch(API + '/api/users/pending', {headers:hdr()}); const d = await r.json(); if (d.success && d.pending) renderPendingEmployees(d.pending); } catch(e) {}
}

function renderPendingEmployees(pending) {
  const list = document.getElementById('pending-list'), count = document.getElementById('pending-count');
  if (!list || !count) return;
  count.textContent = pending.length;
  if (pending.length === 0) { list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;"><div style="font-size:48px;margin-bottom:12px;">✅</div><div style="font-weight:600;margin-bottom:6px;">No Pending Approvals</div><div style="font-size:13px;">All registrations have been reviewed</div></div>'; return; }
  let html = '';
  pending.forEach(emp => {
    const initial = (emp.nickname||'?')[0].toUpperCase(), safeName = emp.nickname.replace(/'/g,"\\'");
    const registeredTime = new Date(emp.created_at), now = new Date();
    const diffMs = now-registeredTime, diffMins = Math.floor(diffMs/1000/60), diffHours = Math.floor(diffMins/60), diffDays = Math.floor(diffHours/24);
    let timeAgo = diffDays>0?diffDays+'d ago':diffHours>0?diffHours+'h ago':diffMins>0?diffMins+'m ago':'Just now';
    html += '<div class="pending-item"><div class="pending-avatar">' + initial + '</div><div class="pending-info"><div class="pending-name">' + emp.nickname + '</div>';
    html += '<div class="pending-time"><span class="pending-time-dot"></span>Registered ' + timeAgo + '</div></div>';
    html += '<div class="pending-actions"><button class="btn-approve" onclick="approveEmployee(\'' + emp.id + '\', \'' + safeName + '\')">✓ Approve</button><button class="btn-reject" onclick="rejectEmployee(\'' + emp.id + '\', \'' + safeName + '\')">✕ Reject</button></div></div>';
  });
  list.innerHTML = html;
}

async function approveEmployee(userId, nickname) {
  const confirmed = await showModal({icon:'✅',title:'Approve Employee?',message:'Activate '+nickname+'\'s account so they can start logging hours.',confirmText:'Approve',danger:false});
  if (!confirmed) return;
  try { const r = await fetch(API + '/api/users/' + userId + '/activate', {method:'POST',headers:hdr()}); const d = await r.json(); if (d.success) { toast('✅ ' + nickname + ' approved!'); loadPendingEmployees(); loadWorkers(); } else { toast(d.error || 'Failed to approve', 'err'); } } catch(e) { toast('Connection error', 'err'); }
}

async function rejectEmployee(userId, nickname) {
  const confirmed = await showModal({icon:'⚠️',title:'Reject Employee?',message:'This will permanently delete '+nickname+'\'s registration.',confirmText:'Reject',danger:true});
  if (!confirmed) return;
  try { const r = await fetch(API + '/api/users/' + userId, {method:'DELETE',headers:hdr()}); const d = await r.json(); if (d.success) { toast('❌ ' + nickname + ' rejected'); loadPendingEmployees(); } else { toast(d.error || 'Failed to reject', 'err'); } } catch(e) { toast('Connection error', 'err'); }
}

setInterval(() => { if (user && ['manager','owner'].includes(user.role)) loadPendingEmployees(); }, 30000);
setInterval(loadClockedInUsers, 30000);


// ========================================================================
// STOCK — Stock alerts, edit time entry
// ========================================================================

let currentStockTab = 'pending', stockPhotoData = null;

function previewStockPhoto(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Image too large. Max 10MB', 'err'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    stockPhotoData = e.target.result;
    document.getElementById('stock-photo-img').src = stockPhotoData;
    document.getElementById('stock-photo-preview').style.display = 'block';
    updateStockSubmitButton();
  };
  reader.onerror = () => { toast('Failed to read image, try another file', 'err'); };
  reader.readAsDataURL(file);
}

function updateStockSubmitButton() {
  const btn = document.getElementById('btn-submit-stock');
  if (!btn) return;
  const note = document.getElementById('stock-note-input')?.value.trim();
  btn.disabled = !stockPhotoData || !note;
}

// Wire up note input listener robustly
async function submitStockAlert() {
  const note = document.getElementById('stock-note-input').value.trim(), errEl = document.getElementById('stock-err'), btn = document.getElementById('btn-submit-stock');
  if (!stockPhotoData) { showErr(errEl, 'Please upload a photo'); return; }
  if (!note) { showErr(errEl, 'Please describe what needs restocking'); return; }
  btn.innerHTML = '<span class="spinner"></span> Submitting...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/stock-alerts', {method:'POST',headers:hdr(),body:JSON.stringify({image_data:stockPhotoData,note})});
    const d = await r.json();
    if (d.success) { toast('✅ Stock alert submitted!'); stockPhotoData = null; document.getElementById('stock-photo-input').value = ''; document.getElementById('stock-photo-preview').style.display = 'none'; document.getElementById('stock-note-input').value = ''; loadStockAlerts(); }
    else { showErr(errEl, d.error || 'Failed to submit alert'); btn.disabled = false; }
  } catch(e) { showErr(errEl, 'Connection error'); btn.disabled = false; }
  btn.innerHTML = '➕ Submit Alert';
}

async function loadStockAlerts() {
  const list = document.getElementById('stock-alerts-list'); if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner"></span></div>';
  try {
    let url = API + '/api/stock-alerts';
    if (['manager','owner'].includes(user.role)) url += '?status=' + (currentStockTab === 'pending' ? 'pending' : 'restocked');
    const r = await fetch(url, {headers:hdr()}); const d = await r.json();
    if (d.success && d.alerts) { renderStockAlerts(d.alerts); updateStockCounts(d.alerts); }
    else { list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;"><div style="font-size:48px;margin-bottom:12px;">📦</div><div style="font-weight:600;margin-bottom:6px;">No Stock Alerts</div></div>'; }
  } catch(e) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);">Failed to load alerts</div>'; }
}

function renderStockAlerts(alerts) {
  const list = document.getElementById('stock-alerts-list');
  if (alerts.length === 0) { const emptyMsg = currentStockTab === 'pending' ? 'No pending stock alerts' : 'No completed restocks yet'; list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;"><div style="font-size:48px;margin-bottom:12px;">✅</div><div style="font-weight:600;margin-bottom:6px;">' + emptyMsg + '</div></div>'; return; }
  let html = '';
  alerts.forEach(alert => {
    const isRestocked = alert.status === 'restocked', timeAgo = getTimeAgo(new Date(alert.created_at)), showUser = ['manager','owner'].includes(user.role);
    html += '<div class="stock-alert-item' + (isRestocked?' restocked':'') + '" style="position:relative;"><button onclick="deleteStockAlert(\'' + alert.id + '\')" style="position:absolute;top:8px;right:8px;z-index:2;width:24px;height:24px;border-radius:50%;border:none;background:rgba(0,0,0,.5);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;backdrop-filter:blur(4px);">✕</button><img src="' + alert.image_data + '" class="stock-alert-photo"><div class="stock-alert-content">';
    html += '<div class="stock-alert-header">';
    if (showUser) { html += '<div class="stock-alert-user"><span class="avatar" style="width:24px;height:24px;font-size:11px;"><span class="avatar-letter">' + (alert.user_nickname||'?')[0].toUpperCase() + '</span></span>' + alert.user_nickname + '</div>'; }
    html += '<span class="badge badge-' + alert.status + '">' + alert.status.toUpperCase() + '</span></div>';
    html += '<div class="stock-alert-note">' + escapeHtml(alert.note) + '</div>';
    html += '<div class="stock-alert-meta"><span>📅 ' + timeAgo + '</span>' + (isRestocked && alert.restocked_by_nickname ? '<span>✅ Restocked by ' + alert.restocked_by_nickname + '</span>' : '') + '</div>';
    if (['manager','owner'].includes(user.role) && !isRestocked) { html += '<div class="stock-alert-actions"><button onclick="markRestocked(\'' + alert.id + '\')" class="btn-restock">✓ Mark Restocked</button><button onclick="deleteStockAlert(\'' + alert.id + '\')" class="btn-ghost" style="background:rgba(255,85,102,.15);border-color:rgba(255,85,102,.3);color:var(--danger);padding:8px 16px;">🗑️</button></div>'; }
    html += '</div></div>';
  });
  list.innerHTML = html;
}

function updateStockCounts(allAlerts) { if (!['manager','owner'].includes(user.role)) return; fetchStockCounts(); }

let editingEntryId = null;

// Update person header totals after a row is removed without full reload
function updatePersonTotals() {
  const tb = document.getElementById('all-entries-body');
  if (!tb) return;
  // Find all person header rows
  tb.querySelectorAll('tr[onclick^="togglePerson"]').forEach(headerRow => {
    const onclick = headerRow.getAttribute('onclick');
    const pid = onclick.match(/togglePerson\('([^']+)'\)/)?.[1];
    if (!pid) return;
    const entryRows = tb.querySelectorAll('.entry-row-' + pid);
    if (entryRows.length === 0) {
      // No entries left, remove the header row too
      headerRow.remove();
      return;
    }
    // Recalculate total hours
    let totalHrs = 0;
    entryRows.forEach(row => {
      const hoursCell = row.cells[3];
      if (hoursCell) {
        const txt = hoursCell.textContent.trim();
        const h = txt.match(/(\d+)h/), m = txt.match(/(\d+)m/);
        if (h) totalHrs += parseInt(h[1]);
        if (m) totalHrs += parseInt(m[1]) / 60;
      }
    });
    // Update the subtitle
    const subtitle = headerRow.querySelector('div > div > div:last-child div:last-child');
    if (subtitle) subtitle.textContent = entryRows.length + ' entries · ' + toHm(totalHrs) + ' total';
  });
}

async function editTimeEntry(entryId) {
  editingEntryId = entryId;
  const entry = allEntriesData[entryId];
  if (!entry) { toast('Entry not found. Please refresh the page.', 'err'); return; }
  const confirmed = await showEditTimeModal(entry);
  if (confirmed) { cacheInvalidate('allEntries'); loadAllEntries(); toast('✅ Time entry updated!'); }
}

function showEditTimeModal(entry) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const box = overlay.querySelector('.modal-box');
    const clockInDate  = new Date(entry.clock_in);
    const clockOutDate = entry.clock_out ? new Date(entry.clock_out) : new Date();
    const ciDateStr = clockInDate.toISOString().split('T')[0];
    const ciTimeStr = clockInDate.toTimeString().slice(0, 5);
    const coDateStr = clockOutDate.toISOString().split('T')[0];
    const coTimeStr = clockOutDate.toTimeString().slice(0, 5);
    let html = '';
    html += '<div style="font-family:\'Syne\',sans-serif;font-weight:700;font-size:20px;margin-bottom:20px;">✏️ Edit Time Entry</div>';
    html += '<div style="color:var(--muted);font-size:13px;margin-bottom:20px;">Editing entry for: <strong style="color:var(--text)">' + (entry.nickname || 'Unknown') + '</strong></div>';
    html += '<div style="display:flex;flex-direction:column;gap:16px;">';
    html += '<div><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;">CLOCK IN</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += '<div class="field" style="margin-bottom:0;"><label>Date</label><input id="edit-ci-date" type="date" value="' + ciDateStr + '"></div>';
    html += '<div class="field" style="margin-bottom:0;"><label>Time</label><input id="edit-ci-time" type="time" value="' + ciTimeStr + '"></div>';
    html += '</div></div>';
    html += '<div><div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;">CLOCK OUT</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">';
    html += '<div class="field" style="margin-bottom:0;"><label>Date</label><input id="edit-co-date" type="date" value="' + coDateStr + '"></div>';
    html += '<div class="field" style="margin-bottom:0;"><label>Time</label><input id="edit-co-time" type="time" value="' + coTimeStr + '"></div>';
    html += '</div></div>';
    html += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">';
    html += '<input type="checkbox" id="edit-still-active" ' + (entry.status === 'active' ? 'checked' : '') + ' onchange="toggleClockOutFields(this.checked)">';
    html += '<span style="font-size:13px;">Still clocked in (no clock out yet)</span></label>';
    html += '</div>';
    html += '<div class="modal-buttons" style="margin-top:20px;">';
    html += '<button id="et-cancel-btn" class="modal-btn modal-btn-cancel">Cancel</button>';
    html += '<button id="et-delete-btn" class="modal-btn" style="background:rgba(255,85,102,.15);border-color:rgba(255,85,102,.3);color:var(--danger);">🗑️ Delete</button>';
    html += '<button id="et-confirm-btn" class="modal-btn modal-btn-primary">Save Changes</button>';
    html += '</div>';
    box.innerHTML = html;
    window.toggleClockOutFields = function(isActive) {
      const coD = document.getElementById('edit-co-date'), coT = document.getElementById('edit-co-time');
      coD.disabled = isActive; coT.disabled = isActive;
      coD.style.opacity = isActive ? '0.5' : '1'; coT.style.opacity = isActive ? '0.5' : '1';
    };
    toggleClockOutFields(entry.status === 'active');
    const cancelBtn  = document.getElementById('et-cancel-btn');
    const confirmBtn = document.getElementById('et-confirm-btn');
    const deleteBtn  = document.getElementById('et-delete-btn');

    deleteBtn.onclick = () => {
      // Replace modal content with inline confirmation
      box.innerHTML = `
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:20px;margin-bottom:12px;">🗑️ Delete Entry?</div>
        <div style="color:var(--muted);font-size:14px;margin-bottom:24px;">This will permanently delete this time entry. This cannot be undone.</div>
        <div class="modal-buttons">
          <button id="del-cancel-btn" class="modal-btn modal-btn-cancel">Cancel</button>
          <button id="del-confirm-btn" class="modal-btn modal-btn-confirm">Delete</button>
        </div>`;
      document.getElementById('del-cancel-btn').onclick = () => { overlay.classList.remove('show'); resolve(false); };
      document.getElementById('del-confirm-btn').onclick = async () => {
        const btn = document.getElementById('del-confirm-btn');
        btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;
        overlay.classList.remove('show');
        try {
          const r = await fetch(API + '/api/time-entries/' + editingEntryId, {method:'DELETE', headers:hdr()});
          const d = await r.json();
          if (d.success) {
            toast('🗑️ Entry deleted');
            cacheInvalidate('allEntries');
            // Find and remove just the deleted row smoothly
            const allRows = document.querySelectorAll('tr');
            allRows.forEach(row => {
              if (row.innerHTML.includes('editTimeEntry(\'' + editingEntryId + '\')')) {
                row.style.transition = 'opacity .2s';
                row.style.opacity = '0';
                setTimeout(() => { row.remove(); updatePersonTotals(); }, 200);
              }
            });
            resolve(true);
          } else { toast(d.error || 'Failed to delete', 'err'); resolve(false); }
        } catch(e) { toast('Connection error', 'err'); resolve(false); }
      };
    };
    overlay.classList.add('show');
    cancelBtn.onclick = () => { overlay.classList.remove('show'); resolve(false); };
    confirmBtn.onclick = async () => {
      const ciDate     = document.getElementById('edit-ci-date').value;
      const ciTime     = document.getElementById('edit-ci-time').value;
      const coDate     = document.getElementById('edit-co-date').value;
      const coTime     = document.getElementById('edit-co-time').value;
      const stillActive = document.getElementById('edit-still-active').checked;
      if (!ciDate || !ciTime) { toast('Clock in date and time required', 'err'); return; }
      if (!stillActive && (!coDate || !coTime)) { toast('Clock out date and time required', 'err'); return; }
      const clockIn  = new Date(ciDate + 'T' + ciTime);
      const clockOut = stillActive ? null : new Date(coDate + 'T' + coTime);
      if (clockOut && clockOut <= clockIn) { toast('Clock out must be after clock in', 'err'); return; }
      confirmBtn.innerHTML = '<span class="spinner"></span>'; confirmBtn.disabled = true;
      try {
        const r = await fetch(API + '/api/time-entries/' + editingEntryId, {
          method: 'PATCH', headers: hdr(),
          body: JSON.stringify({ clock_in: clockIn.toISOString(), clock_out: clockOut ? clockOut.toISOString() : null })
        });
        const d = await r.json();
        if (d.success) { overlay.classList.remove('show'); resolve(true); }
        else { toast(d.error || 'Failed to update', 'err'); confirmBtn.disabled = false; confirmBtn.textContent = 'Save Changes'; }
      } catch(e) { toast('Connection error', 'err'); confirmBtn.disabled = false; confirmBtn.textContent = 'Save Changes'; }
    };
  });
}

function showEmployeeEditModal(emp) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const box = overlay.querySelector('.modal-box');
    let html = '';
    html += '<div style="font-family:\'Syne\',sans-serif;font-weight:700;font-size:20px;margin-bottom:20px;">Edit Employee</div>';
    html += '<div style="display:flex;flex-direction:column;gap:16px;">';
    html += '<div class="field"><label>Full Name (login)</label><input type="text" value="' + escapeHtml(emp.nickname) + '" disabled style="opacity:0.5;cursor:not-allowed;"></div>';
    html += '<div class="field"><label>Display Name</label><input id="emp-edit-displayname" type="text" placeholder="How they appear to others" value="' + escapeHtml(emp.display_name || '') + '"></div>';
    html += '<div class="field"><label>Employee ID / SID</label><input id="emp-edit-sid" type="text" placeholder="e.g. EMP001" value="' + escapeHtml(emp.sid || '') + '"></div>';
    html += '<div class="field"><label>Phone Number</label><input id="emp-edit-phone" type="tel" placeholder="e.g. +31 6 12345678" value="' + escapeHtml(emp.phone || '') + '"></div>';
    html += '<div class="field"><label>Role</label><select id="emp-edit-role">';
    (['employee','farmer','loa','manager'].concat(user.role === 'owner' ? ['owner'] : [])).forEach(r => {
      html += '<option value="' + r + '"' + (emp.role === r ? ' selected' : '') + '>' + (r === 'loa' ? 'LOA' : r.charAt(0).toUpperCase() + r.slice(1)) + '</option>';
    });
    html += '</select></div>';
    html += '</div>';
    html += '<div class="modal-buttons" style="margin-top:20px;">';
    html += '<button id="ee-cancel-btn" class="modal-btn modal-btn-cancel">Cancel</button>';
    html += '<button id="ee-confirm-btn" class="modal-btn modal-btn-primary">Save Changes</button>';
    html += '</div>';
    box.innerHTML = html;
    const cancelBtn  = document.getElementById('ee-cancel-btn');
    const confirmBtn = document.getElementById('ee-confirm-btn');
    overlay.classList.add('show');
    cancelBtn.onclick = () => { overlay.classList.remove('show'); resolve(false); };
    confirmBtn.onclick = async () => {
      const display_name = document.getElementById('emp-edit-displayname').value.trim();
      const sid   = document.getElementById('emp-edit-sid').value.trim();
      const phone = document.getElementById('emp-edit-phone').value.trim();
      const role  = document.getElementById('emp-edit-role').value;
      confirmBtn.innerHTML = '<span class="spinner"></span>'; confirmBtn.disabled = true;
      try {
        const r = await fetch(API + '/api/users/' + emp.id, {
          method: 'PATCH', headers: hdr(),
          body: JSON.stringify({ display_name: display_name||null, sid: sid||null, phone: phone||null, role })
        });
        const d = await r.json();
        if (d.success) { toast('✅ Employee updated!'); overlay.classList.remove('show'); resolve(true); }
        else { toast(d.error || 'Failed to update', 'err'); confirmBtn.disabled = false; confirmBtn.textContent = 'Save Changes'; }
      } catch(e) { toast('Connection error', 'err'); confirmBtn.disabled = false; confirmBtn.textContent = 'Save Changes'; }
    };
  });
}

function showSelfEditModal() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const box = overlay.querySelector('.modal-box');
    let html = '';
    html += '<div style="font-family:\'Syne\',sans-serif;font-weight:700;font-size:20px;margin-bottom:20px;">✏️ Edit My Info</div>';
    html += '<div style="display:flex;flex-direction:column;gap:16px;">';
    html += '<div class="field"><label>Username (login)</label><input type="text" value="' + escapeHtml(user.nickname) + '" disabled style="opacity:0.5;cursor:not-allowed;"></div>';
    html += '<div class="field"><label>Display Name</label><input id="self-edit-displayname" type="text" placeholder="How you appear to others" value="' + escapeHtml(user.display_name || '') + '"></div>';
    html += '<div class="field"><label>Employee ID / SID</label><input id="self-edit-sid" type="text" placeholder="e.g. EMP001" value="' + escapeHtml(user.sid || '') + '"></div>';
    html += '<div class="field"><label>Phone Number</label><input id="self-edit-phone" type="tel" placeholder="e.g. +31 6 12345678" value="' + escapeHtml(user.phone || '') + '"></div>';
    html += '</div>';
    html += '<div class="modal-buttons" style="margin-top:20px;">';
    html += '<button id="se-cancel-btn" class="modal-btn modal-btn-cancel">Cancel</button>';
    html += '<button id="se-confirm-btn" class="modal-btn modal-btn-primary">Save Changes</button>';
    html += '</div>';
    box.innerHTML = html;
    overlay.classList.add('show');
    document.getElementById('se-cancel-btn').onclick = () => { overlay.classList.remove('show'); resolve(false); };
    document.getElementById('se-confirm-btn').onclick = async () => {
      const display_name = document.getElementById('self-edit-displayname').value.trim();
      const sid = document.getElementById('self-edit-sid').value.trim();
      const phone = document.getElementById('self-edit-phone').value.trim();
      const btn = document.getElementById('se-confirm-btn');
      btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true;
      try {
        const r = await fetch(API + '/api/users/me', {
          method: 'PATCH', headers: hdr(),
          body: JSON.stringify({ display_name: display_name||null, sid: sid||null, phone: phone||null })
        });
        const d = await r.json();
        if (d.success) {
          user.display_name = display_name;
          user.sid = sid;
          user.phone = phone;
          localStorage.setItem('wt_user', JSON.stringify(user));
          overlay.classList.remove('show');
          resolve(true);
        } else { toast(d.error || 'Failed to update', 'err'); btn.disabled = false; btn.textContent = 'Save Changes'; }
      } catch(e) { toast('Connection error', 'err'); btn.disabled = false; btn.textContent = 'Save Changes'; }
    };
  });
}

async function openSelfEditModal() {
  const confirmed = await showSelfEditModal();
  if (confirmed) { toast('✅ Profile updated!'); loadEmployees(); }
}

let allEmployees = [], editingEmployeeId = null;

async function loadEmployees() {
  const grid = document.getElementById('employees-grid'); if (!grid) return;
  grid.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  try {
    const r = await fetch(API + '/api/users', {headers:hdr()}); const d = await r.json();
    if (!d.success || !d.users || d.users.length === 0) { grid.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><p>No employees yet</p></div>'; return; }
    allEmployees = d.users.filter(u => u.is_active);
    if (allEmployees.length === 0) { grid.innerHTML = '<div class="empty"><div class="empty-icon">👥</div><p>No active employees yet</p></div>'; return; }
    renderEmployees(allEmployees);
  } catch(e) { grid.innerHTML = '<div class="empty"><div class="empty-icon">❌</div><p>Failed to load employees</p></div>'; }
}

function renderEmployees(employees) {
  const grid = document.getElementById('employees-grid'); if (!grid) return;
  const roleOrder = {owner:0,manager:1,employee:2,farmer:3};
  const sorted = [...employees].sort((a,b) => {   if (a.id === user.id) return -1;   if (b.id === user.id) return 1;   return (roleOrder[a.role]||99)-(roleOrder[b.role]||99); });
  let html = '';
  sorted.forEach(emp => {
    const initial = displayName(emp)[0].toUpperCase(), safeId = emp.id.replace(/[^a-zA-Z0-9]/g,'_');
    const isMe = emp.id === user.id; html += '<div class="employee-card" onclick="' + (isMe ? 'openSelfEditModal()' : 'openEmployeeModal(\'' + emp.id + '\')') + '">';
    html += '<div class="employee-card-header"><div class="employee-avatar-large"><span class="avatar-letter">' + initial + '</span><img class="avatar-img emp-av-' + safeId + '"></div>';
    html += '<div class="employee-header-info"><div class="employee-name">' + displayName(emp) + '</div><span class="badge badge-' + emp.role + '">' + emp.role + '</span></div></div>';
    html += '<div class="employee-details">';
    if (emp.sid) { html += '<div class="employee-detail-row"><div class="employee-detail-icon">🆔</div><div class="employee-detail-content"><div class="employee-detail-label">Employee ID</div><div class="employee-detail-value">' + escapeHtml(emp.sid) + '</div></div></div>'; }
    if (emp.phone) { html += '<div class="employee-detail-row"><div class="employee-detail-icon">📞</div><div class="employee-detail-content"><div class="employee-detail-label">Phone</div><div class="employee-detail-value">' + escapeHtml(emp.phone) + '</div></div></div>'; }
    html += '<div class="employee-detail-row"><div class="employee-detail-icon">📅</div><div class="employee-detail-content"><div class="employee-detail-label">Joined</div><div class="employee-detail-value">' + fmtDate(emp.created_at) + '</div></div></div>';
    html += '</div></div>';
  });
  grid.innerHTML = html;
  sorted.forEach(emp => { const saved = localStorage.getItem('avatar_' + emp.id); if (saved) { const safeId = emp.id.replace(/[^a-zA-Z0-9]/g,'_'); document.querySelectorAll('.emp-av-' + safeId).forEach(img => { img.src = saved; img.style.display = 'block'; }); } });
}

function filterEmployees(searchText) {
  if (!searchText) { renderEmployees(allEmployees); return; }
  const search = searchText.toLowerCase();
  renderEmployees(allEmployees.filter(emp => emp.nickname?.toLowerCase().includes(search) || emp.sid?.toLowerCase().includes(search) || emp.phone?.toLowerCase().includes(search)));
}

async function openEmployeeModal(employeeId) {
  event.stopPropagation();
  if (!['manager', 'owner'].includes(user.role)) return;
  editingEmployeeId = employeeId;
  const emp = allEmployees.find(e => e.id === employeeId);
  if (!emp) return;
  const confirmed = await showEmployeeEditModal(emp);
  if (confirmed) loadEmployees();
}

function exportEmployees() {
  if (allEmployees.length === 0) { toast('No employees to export', 'err'); return; }
  let csv = 'Name,Employee ID,Phone,Role,Joined\n';
  allEmployees.forEach(emp => { csv += '"' + (emp.nickname||'').replace(/"/g,'""') + '","' + (emp.sid||'').replace(/"/g,'""') + '","' + (emp.phone||'').replace(/"/g,'""') + '","' + emp.role + '","' + fmtDate(emp.created_at) + '"\n'; });
  const blob = new Blob([csv], {type:'text/csv'}), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = 'employees-' + new Date().toISOString().split('T')[0] + '.csv'; a.click(); URL.revokeObjectURL(url);
  toast('📥 CSV exported!');
}


// ========================================================================
// FORUM — Forum posts, replies, editor, color picker
// ========================================================================

let forumPosts = [], forumSectionState = {pinned: true, posts: true};

async function deleteStockAlert(alertId) {
  const confirmed = await showModal({icon:'🗑️',title:'Delete Stock Alert?',message:'This will permanently delete this stock alert.',confirmText:'Delete',danger:true});
  if (!confirmed) return;
  // Remove instantly from DOM
  const el = document.querySelector(`[onclick*="${alertId}"]`)?.closest('.stock-alert-item');
  if (el) { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }
  try {
    await fetch(API + '/api/stock-alerts/' + alertId, {method:'DELETE',headers:hdr()});
    toast('🗑️ Alert deleted');
  } catch(e) { toast('Connection error', 'err'); loadStockAlerts(); }
}

async function fetchStockCounts() {
  try {
    const [pendingRes, completedRes] = await Promise.all([fetch(API + '/api/stock-alerts?status=pending',{headers:hdr()}), fetch(API + '/api/stock-alerts?status=restocked',{headers:hdr()})]);
    const pendingData = await pendingRes.json(), completedData = await completedRes.json();
    const pc = document.getElementById('stock-pending-count'), cc = document.getElementById('stock-completed-count');
    if (pc) pc.textContent = pendingData.alerts?.length || 0;
    if (cc) cc.textContent = completedData.alerts?.length || 0;
  } catch(e) {}
}

function getTimeAgo(date) {
  const now = new Date(), diffMs = now-date, diffMins = Math.floor(diffMs/1000/60), diffHours = Math.floor(diffMins/60), diffDays = Math.floor(diffHours/24);
  if (diffDays>0) return diffDays+'d ago'; if (diffHours>0) return diffHours+'h ago'; if (diffMins>0) return diffMins+'m ago'; return 'Just now';
}

async function markRestocked(alertId) {
  const confirmed = await showModal({icon:'✅',title:'Mark as Restocked?',message:'Confirm that this item has been restocked.',confirmText:'Mark Restocked',danger:false});
  if (!confirmed) return;
  try { const r = await fetch(API + '/api/stock-alerts/' + alertId + '/restock', {method:'PATCH',headers:hdr()}); const d = await r.json(); if (d.success) { toast('✅ Marked as restocked!'); loadStockAlerts(); } else { toast(d.error || 'Failed to update', 'err'); } } catch(e) { toast('Connection error', 'err'); }
}

function renderForumContent(text) {
  if (!text) return '';
  let out = escapeHtml(text);
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  out = out.replace(/\*(.+?)\*/g, '<i>$1</i>');
  out = out.replace(/\[color=([^\]]+)\]([\s\S]*?)\[\/color\]/g, '<span style="color:$1">$2</span>');
  const sizeMap = {small:'11px', normal:'15px', large:'18px', huge:'24px'};
  out = out.replace(/\[size=([^\]]+)\]([\s\S]*?)\[\/size\]/g, (m, sz, txt) => `<span style="font-size:${sizeMap[sz]||'15px'}">${txt}</span>`);
  out = out.replace(/\[img\](https?:\/\/[^\s\[\]]+)\[\/img\]/g, '<img src="$1" onerror="this.style.display=\'none\'" style="max-width:100%;border-radius:10px;margin:10px 0;display:block;border:1px solid var(--border);">');
  out = out.replace(/\n/g, '<br>');
  return out;
}

function switchStockTab(tab) {
  currentStockTab = tab;
  document.querySelectorAll('.stock-tab').forEach(t => { t.classList.toggle('active', t.dataset.tab === tab); });
  const title = document.getElementById('stock-list-title'); if (title) title.textContent = tab === 'pending' ? 'Pending Alerts' : 'Completed Restocks';
  loadStockAlerts();
}

async function loadReplies(postId) {
  const list = document.getElementById('forum-replies-list');
  if (!list) return;
  try {
    const r = await fetch(API + '/api/forum/' + postId + '/replies', {headers: hdr()});
    const d = await r.json();
    if (!d.success) { list.innerHTML = '<div style="padding:16px 20px;color:var(--muted);font-size:13px;">Could not load replies.</div>'; return; }
    const replies = d.replies || [];
    const countEl = document.getElementById('forum-reply-count');
    if (countEl) countEl.textContent = replies.length ? '(' + replies.length + ')' : '';
    if (replies.length === 0) {
      list.innerHTML = '<div style="padding:16px 20px;color:var(--muted);font-size:13px;">No replies yet. Be the first!</div>';
      return;
    }
    list.innerHTML = replies.map(rep => {
      const isAdmin = ['manager','owner'].includes(user.role);
      const canDel = rep.user_id === user.id || isAdmin;
      const repSafeId = rep.user_id ? rep.user_id.replace(/[^a-zA-Z0-9]/g,'_') : 'unknown';

      return `<div class="forum-reply" id="reply-${rep.id}">
        <div class="avatar avatar-sm" style="flex-shrink:0;"><span class="avatar-letter">${(rep.author_name||'?')[0].toUpperCase()}</span><img class="avatar-img forum-rep-av-${repSafeId}"></div>
        <div class="forum-reply-body">
          <div class="forum-reply-meta">
            <span class="forum-reply-author">${escapeHtml(rep.author_name||'Unknown')}</span>
            <span>${getTimeAgo(new Date(rep.created_at))}</span>
          </div>
          <div class="forum-reply-content">${escapeHtml(rep.content)}</div>
          ${canDel ? `<div class="forum-reply-actions"><button class="forum-reply-btn" onclick="deleteReply('${rep.id}','${postId}')">🗑️ Delete</button></div>` : ''}
        </div>
      </div>`;
    }).join('');
    // Load avatars from localStorage
    replies.forEach(rep => {
      if (!rep.user_id) return;
      const saved = localStorage.getItem('avatar_' + rep.user_id);
      if (saved) {
        const safeId = rep.user_id.replace(/[^a-zA-Z0-9]/g,'_');
        document.querySelectorAll('.forum-rep-av-' + safeId).forEach(img => { img.src = saved; img.style.display = 'block'; });
      }
    });
  } catch(e) { list.innerHTML = '<div style="padding:16px 20px;color:var(--muted);font-size:13px;">Failed to load replies.</div>'; }
}

async function submitReply(postId) {
  const input = document.getElementById('reply-input-' + postId);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  input.disabled = true;
  try {
    const r = await fetch(API + '/api/forum/' + postId + '/replies', {
      method: 'POST', headers: hdr(), body: JSON.stringify({content})
    });
    const d = await r.json();
    if (d.success) {
      input.value = '';
      await loadReplies(postId);
      const p = forumPosts.find(p => p.id === postId);
      if (p) { p.reply_count = (p.reply_count || 0) + 1; }
    } else { toast(d.error || 'Failed to reply', 'err'); }
  } catch(e) { toast('Connection error', 'err'); }
  input.disabled = false;
  input.focus();
}

async function deleteReply(replyId, postId) {
  const confirmed = await showModal({icon:'🗑️', title:'Delete Reply?', message:'This will permanently delete this reply.', confirmText:'Delete', danger:true});
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/forum/replies/' + replyId, {method:'DELETE', headers:hdr()});
    const d = await r.json();
    if (d.success) { toast('Reply deleted'); await loadReplies(postId); }
    else toast(d.error || 'Failed', 'err');
  } catch(e) { toast('Connection error', 'err'); }
}


// === COLOR PICKER (HSV Canvas) ===
let colorPickerOpen = false;
let cpHue = 0, cpSat = 1, cpVal = 1;
let cpDraggingSV = false, cpDraggingHue = false;
let cpCurrentColor = '#a78bfa';

function hsvToHex(h, s, v) {
  let r, g, b;
  const i = Math.floor(h * 6), f = h * 6 - i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  switch(i%6){case 0:r=v;g=t;b=p;break;case 1:r=q;g=v;b=p;break;case 2:r=p;g=v;b=t;break;case 3:r=p;g=q;b=v;break;case 4:r=t;g=p;b=v;break;case 5:r=v;g=p;b=q;break;}
  return '#'+[r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

function hexToHsv(hex) {
  let r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0, s=max===0?0:d/max, v=max;
  if(d!==0){if(max===r)h=(g-b)/d%6;else if(max===g)h=(b-r)/d+2;else h=(r-g)/d+4; h/=6; if(h<0)h+=1;}
  return {h,s,v};
}

function cpDrawSV() {
  const canvas = document.getElementById('cp-sv-canvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const hueHex = hsvToHex(cpHue, 1, 1);
  const gradH = ctx.createLinearGradient(0,0,W,0);
  gradH.addColorStop(0,'#fff'); gradH.addColorStop(1,hueHex);
  ctx.fillStyle = gradH; ctx.fillRect(0,0,W,H);
  const gradV = ctx.createLinearGradient(0,0,0,H);
  gradV.addColorStop(0,'rgba(0,0,0,0)'); gradV.addColorStop(1,'#000');
  ctx.fillStyle = gradV; ctx.fillRect(0,0,W,H);
}

function cpDrawHue() {
  const canvas = document.getElementById('cp-hue-canvas'); if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const grad = ctx.createLinearGradient(0,0,W,0);
  [0,1/6,2/6,3/6,4/6,5/6,1].forEach((t,i) => {
    const h = i/6; grad.addColorStop(t, hsvToHex(h,1,1));
  });
  ctx.fillStyle = grad; ctx.fillRect(0,0,W,H);
}

function cpUpdateCursors() {
  const sv = document.getElementById('cp-sv-canvas');
  const svC = document.getElementById('cp-sv-cursor');
  const hC = document.getElementById('cp-hue-cursor');
  if(!sv||!svC||!hC) return;
  svC.style.left = (cpSat * 100) + '%';
  svC.style.top = ((1-cpVal) * 100) + '%';
  hC.style.left = (cpHue * 100) + '%';
}

function cpUpdatePreview() {
  const hex = hsvToHex(cpHue, cpSat, cpVal);
  cpCurrentColor = hex;
  const prev = document.getElementById('cp-preview');
  const inp = document.getElementById('cp-hex-input');
  if(prev) prev.style.background = hex;
  if(inp) inp.value = hex;
  document.getElementById('forum-color-swatch').style.background = hex;
}

function cpSetFromSVEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
  cpSat = x; cpVal = 1 - y;
  cpUpdateCursors(); cpUpdatePreview();
}

function cpSetFromHueEvent(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  cpHue = Math.max(0, Math.min(0.9999, (e.clientX - rect.left) / rect.width));
  cpDrawSV(); cpUpdateCursors(); cpUpdatePreview();
}

function cpHexInputChange(val) {
  if(/^#[0-9a-fA-F]{6}$/.test(val)) {
    const hsv = hexToHsv(val);
    cpHue = hsv.h; cpSat = hsv.s; cpVal = hsv.v;
    cpDrawSV(); cpUpdateCursors();
    document.getElementById('cp-preview').style.background = val;
    cpCurrentColor = val;
    document.getElementById('forum-color-swatch').style.background = val;
  }
}

function cpApply() {
  const hex = hsvToHex(cpHue, cpSat, cpVal);
  applyColor(hex);
}

function applyColor(hex) {
  closeColorPicker(false);
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  if (forumEditorSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(forumEditorSavedRange);
  }
  
  document.execCommand('foreColor', false, hex);
  document.getElementById('forum-color-swatch').style.background = hex;
}

function cpInitEvents() {
  const svCanvas = document.getElementById('cp-sv-canvas');
  const hueCanvas = document.getElementById('cp-hue-canvas');
  if(!svCanvas||!hueCanvas) return;
  svCanvas.addEventListener('mousedown', e => { cpDraggingSV=true; cpSetFromSVEvent(e,svCanvas); });
  hueCanvas.addEventListener('mousedown', e => { cpDraggingHue=true; cpSetFromHueEvent(e,hueCanvas); });
  document.addEventListener('mousemove', e => {
    if(cpDraggingSV) cpSetFromSVEvent(e,svCanvas);
    if(cpDraggingHue) cpSetFromHueEvent(e,hueCanvas);
  });
  document.addEventListener('mouseup', () => { cpDraggingSV=false; cpDraggingHue=false; });
  svCanvas.addEventListener('touchstart', e=>{e.preventDefault();cpDraggingSV=true;cpSetFromSVEvent(e.touches[0],svCanvas);},{passive:false});
  hueCanvas.addEventListener('touchstart', e=>{e.preventDefault();cpDraggingHue=true;cpSetFromHueEvent(e.touches[0],hueCanvas);},{passive:false});
  document.addEventListener('touchmove', e=>{
    if(cpDraggingSV)cpSetFromSVEvent(e.touches[0],svCanvas);
    if(cpDraggingHue)cpSetFromHueEvent(e.touches[0],hueCanvas);
  });
  document.addEventListener('touchend', ()=>{cpDraggingSV=false;cpDraggingHue=false;});
}

function toggleColorPicker(e) {
  const popup = document.getElementById('color-picker-popup');
  if (colorPickerOpen) { closeColorPicker(); return; }
  const btn = document.getElementById('forum-color-btn');
  const rect = btn.getBoundingClientRect();
  const popupW = 240;
  let left = rect.left;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.style.left = Math.max(8, left) + 'px';
  popup.classList.add('show');
  colorPickerOpen = true;
  requestAnimationFrame(() => {
    cpDrawSV(); cpDrawHue(); cpUpdateCursors(); cpUpdatePreview();
    cpInitEvents();
  });
}

function closeColorPicker(andApply = false) {
  document.getElementById('color-picker-popup').classList.remove('show');
  colorPickerOpen = false;
  if (andApply) {
    const editor = document.getElementById('forum-body-input');
    editor.focus();
    if (forumEditorSavedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(forumEditorSavedRange);
    }
    document.execCommand('foreColor', false, cpCurrentColor);
    document.getElementById('forum-color-swatch').style.background = cpCurrentColor;
  }
}

document.addEventListener('click', (e) => {
  if (colorPickerOpen && !e.target.closest('#color-picker-popup') && !e.target.closest('#forum-color-btn')) {
    closeColorPicker(true);
  }
});

// === FORUM TOOLBAR STATE ===
function updateForumToolbarState() {
  const commands = ['bold', 'italic', 'underline', 'strikeThrough'];
  commands.forEach(cmd => {
    const btn = document.getElementById('forum-btn-' + cmd);
    if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
  });

  // Sync font size dropdown to cursor position
  const fontSizeSelect = document.getElementById('forum-font-size');
  if (fontSizeSelect) {
    const node = window.getSelection()?.anchorNode;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    const editor = document.getElementById('forum-body-input');
    if (el && el !== editor) {
      const px = parseInt(window.getComputedStyle(el).fontSize);
      let closest = null, closestDiff = Infinity;
      for (const opt of fontSizeSelect.options) {
        const diff = Math.abs(parseInt(opt.value) - px);
        if (diff < closestDiff) { closestDiff = diff; closest = opt.value; }
      }
      if (closest) fontSizeSelect.value = closest;
    }
  }
}

// === ALIGNMENT ===
function forumAlign(cmd) {
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  document.execCommand(cmd);
}

// === EMOJI PICKER ===
let emojiPickerOpen = false;
const EMOJIS = [
  '😀','😂','😍','🥰','😎','🤔','😅','😭','🔥','💯',
  '👍','👎','👏','🙌','🤝','💪','✅','❌','⚠️','💡',
  '📦','📋','💰','💳','⏱️','📅','🗑️','✏️','📌','🔧',
  '🎉','🚀','⭐','💎','🏆','❤️','💚','💜','🧡','💙',
  '🌿','🌱','🌾','🍃','🌻','☀️','🌙','⚡','🌊','🎯',
];

function toggleEmojiPicker(e) {
  e.stopPropagation();
  e.preventDefault();
  // Create popup dynamically if it doesn't exist yet
  let popup = document.getElementById('emoji-picker-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'emoji-picker-popup';
    popup.className = 'emoji-picker-popup';
    popup.addEventListener('click', ev => ev.stopPropagation());
    EMOJIS.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.textContent = em;
      btn.onmousedown = (ev) => { ev.preventDefault(); insertEmoji(em); };
      popup.appendChild(btn);
    });
    document.body.appendChild(popup);
  }
  if (emojiPickerOpen) { closeEmojiPicker(); return; }
  const btn = document.getElementById('forum-emoji-btn');
  const rect = btn.getBoundingClientRect();
  const popupW = 224;
  let left = rect.left;
  if (left + popupW > window.innerWidth - 8) left = window.innerWidth - popupW - 8;
  popup.style.top = (rect.bottom + 6) + 'px';
  popup.style.left = Math.max(8, left) + 'px';
  popup.classList.add('show');
  emojiPickerOpen = true;
  const sel = window.getSelection();
  if (sel && sel.rangeCount) forumEditorSavedRange = sel.getRangeAt(0).cloneRange();
}

function closeEmojiPicker() {
  document.getElementById('emoji-picker-popup').classList.remove('show');
  emojiPickerOpen = false;
}

function insertEmoji(emoji) {
  closeEmojiPicker();
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  if (forumEditorSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(forumEditorSavedRange);
  }
  document.execCommand('insertText', false, emoji);
}

document.addEventListener('click', (e) => {
  if (emojiPickerOpen && !e.target.closest('#emoji-picker-popup') && !e.target.closest('#forum-emoji-btn')) {
    closeEmojiPicker();
  }
});

// Stop clicks inside emoji popup from bubbling to document
document.addEventListener('DOMContentLoaded', () => {
  const ep = document.getElementById('emoji-picker-popup');
  if (ep) ep.addEventListener('click', e => e.stopPropagation());
});

// === TABLE INSERT + RESIZE ===
// === TABLE INSERT + RESIZE ===
function forumInsertTable() {
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  const tableId = 'tbl' + Date.now();
  const cs = 'border:1px solid #444;padding:8px 12px;position:relative;';

  // Build wrapper div
  const wrap = document.createElement('div');
  wrap.id = tableId;
  wrap.contentEditable = 'false';
  wrap.style.cssText = 'margin:12px 0;display:inline-block;';

  // Build toolbar (contenteditable=false so it doesn't get edited)
  const bar = document.createElement('div');
  bar.contentEditable = 'false';
  bar.style.cssText = 'display:flex;gap:4px;margin-bottom:6px;user-select:none;';
  [
    ['+ Row', () => forumTableAddRow(tableId)],
    ['+ Col', () => forumTableAddCol(tableId)],
    ['− Row', () => forumTableDelRow(tableId)],
    ['− Col', () => forumTableDelCol(tableId)],
    ['🗑', () => forumTableDelete(tableId), 'rgba(255,85,102,.15)', 'rgba(255,85,102,.3)', '#ff5566'],
  ].forEach(([label, fn, bg, border, color]) => {
    const b = document.createElement('span');
    b.textContent = label;
    b.style.cssText = `font-size:11px;padding:3px 8px;background:${bg||'#18182a'};border:1px solid ${border||'#444'};color:${color||'#aaa'};border-radius:5px;cursor:pointer;`;
    b.onmousedown = e => { e.preventDefault(); fn(); };
    bar.appendChild(b);
  });
  wrap.appendChild(bar);

  // Build table using DOM (not innerHTML) so IDs/events are preserved
  const table = document.createElement('table');
  table.id = tableId + '-t';
  table.style.cssText = 'width:auto;min-width:200px;border-collapse:collapse;table-layout:auto;';
  for (let r = 0; r < 3; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < 3; c++) {
      const cell = r === 0 ? document.createElement('th') : document.createElement('td');
      cell.setAttribute('style', cs + (r === 0 ? 'background:#18182a;font-weight:700;' : ''));
      cell.textContent = r === 0 ? 'Header' : 'Cell';
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);

  // Insert at cursor position
  const sel = window.getSelection();
  if (sel && sel.rangeCount && editor.contains(sel.getRangeAt(0).startContainer)) {
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const before = document.createElement('p'); before.innerHTML = '<br>';
    const after = document.createElement('p'); after.innerHTML = '<br>';
    range.insertNode(after);
    range.insertNode(wrap);
    range.insertNode(before);
    const newRange = document.createRange();
    newRange.setStart(after, 0);
    sel.removeAllRanges();
    sel.addRange(newRange);
  } else {
    const p1 = document.createElement('p'); p1.innerHTML = '<br>';
    const p2 = document.createElement('p'); p2.innerHTML = '<br>';
    editor.appendChild(p1);
    editor.appendChild(wrap);
    editor.appendChild(p2);
  }
  forumTableInitResize(tableId);
}

function forumTableAddRow(tableId) {
  const table = document.getElementById(tableId + '-t');
  if (!table) return;
  const cols = table.rows[0]?.cells.length || 3;
  const tr = document.createElement('tr');
  for (let c = 0; c < cols; c++) {
    const td = document.createElement('td');
    td.setAttribute('style', 'border:1px solid #444;padding:8px 12px;position:relative;');
    td.textContent = 'Cell';
    tr.appendChild(td);
  }
  table.appendChild(tr);
  forumTableInitResize(tableId);
}

function forumTableAddCol(tableId) {
  const table = document.getElementById(tableId + '-t');
  if (!table) return;
  Array.from(table.rows).forEach((row, i) => {
    const cell = i === 0 ? document.createElement('th') : document.createElement('td');
    cell.setAttribute('style', 'border:1px solid #444;padding:8px 12px;position:relative;' + (i === 0 ? 'background:#18182a;font-weight:700;' : ''));
    cell.textContent = i === 0 ? 'Header' : 'Cell';
    row.appendChild(cell);
  });
  forumTableInitResize(tableId);
}

function forumTableDelRow(tableId) {
  const table = document.getElementById(tableId + '-t');
  if (!table || table.rows.length <= 1) return;
  table.deleteRow(table.rows.length - 1);
}

function forumTableDelCol(tableId) {
  const table = document.getElementById(tableId + '-t');
  if (!table || (table.rows[0]?.cells.length || 0) <= 1) return;
  Array.from(table.rows).forEach(row => { if (row.cells.length > 0) row.deleteCell(row.cells.length - 1); });
}

function forumTableDelete(tableId) {
  document.getElementById(tableId)?.remove();
}

function forumTableInitResize(tableId) {
  const table = document.getElementById(tableId + '-t');
  if (!table) return;
  // Freeze current pixel widths so columns resize independently
  Array.from(table.rows[0]?.cells || []).forEach(cell => {
    if (!cell.style.width) cell.style.width = cell.offsetWidth + 'px';
  });
  table.style.tableLayout = 'fixed';
  table.querySelectorAll('th, td').forEach(cell => {
    cell.querySelector('.col-resize-handle')?.remove();
    cell.style.position = 'relative';
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    handle.style.cssText = 'position:absolute;right:0;top:0;bottom:0;width:6px;cursor:col-resize;z-index:10;';
    handle.addEventListener('mousedown', e => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, startW = cell.offsetWidth;
      const onMove = ev => { cell.style.width = Math.max(40, startW + ev.clientX - startX) + 'px'; };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    cell.appendChild(handle);
  });
}


async function loadForumPosts() {
  renderForumSections(null);
  try {
    const r = await fetch(API + '/api/forum', {headers: hdr()});
    const d = await r.json();
    if (d.success) { forumPosts = d.posts || []; renderForumSections(forumPosts); }
    else renderForumSections([]);
  } catch(e) { renderForumSections([]); }
}

function renderForumSections(posts) {
  const pinnedEl = document.getElementById('forum-section-pinned');
  const postsEl = document.getElementById('forum-section-posts');
  if (!pinnedEl || !postsEl) return;
  if (posts === null) {
    const spinner = '<div style="padding:24px;text-align:center;color:var(--muted);"><span class="spinner"></span></div>';
    pinnedEl.innerHTML = spinner; postsEl.innerHTML = spinner; return;
  }
  const pinned = posts.filter(p => p.is_pinned);
  const regular = posts.filter(p => !p.is_pinned);
  pinnedEl.innerHTML = pinned.length === 0
    ? '<div style="padding:18px 20px;font-size:13px;color:var(--muted);">No pinned posts yet.</div>'
    : pinned.map(p => forumRowHTML(p)).join('');
  postsEl.innerHTML = regular.length === 0
    ? '<div style="padding:18px 20px;font-size:13px;color:var(--muted);">No posts yet — be the first!</div>'
    : regular.map(p => forumRowHTML(p)).join('');
  attachForumRowEvents();
}

function forumRowHTML(post) {
  const timeStr = getTimeAgo(new Date(post.created_at));
  const replyCount = post.reply_count || 0;
  const isAdmin = ['manager','owner'].includes(user.role);
  const dragHandle = (isAdmin && post.is_pinned) ? `
    <div class="forum-drag-handle" title="Drag to reorder">⠿</div>` : '';
  return `<div class="forum-row${post.is_pinned && isAdmin ? ' draggable-post' : ''}" 
    data-post-id="${post.id}"
    ${post.is_pinned && isAdmin ? `draggable="true"` : ''}>
    <div class="forum-row-icon${post.is_pinned?' pinned':''}">💬</div>
    <div class="forum-row-info">
      <div class="forum-row-title">${escapeHtml(post.title)}</div>
      <div class="forum-row-sub">
        ${post.is_pinned ? '<span class="forum-row-badge pinned">📌 Pinned</span> ' : ''}
        <span style="color:var(--accent);font-weight:600;">${escapeHtml(post.author_name||'Unknown')}</span>
        · ${timeStr}
      </div>
    </div>
<div class="forum-row-stat">
      <span class="forum-row-stat-label">Replies</span>
      <span class="forum-row-stat-val">${replyCount}</span>
    </div>
    <div class="forum-row-stat forum-views-btn" data-post-id="${post.id}" style="position:relative;cursor:pointer;" onmouseenter="loadForumViewers(this)" onmouseleave="hideForumViewers(this)">
      <span class="forum-row-stat-label">Views</span>
      <span class="forum-row-stat-val">👁 ${post.view_count || 0}</span>
      <div class="forum-viewers-tooltip" style="display:none;position:absolute;bottom:calc(100% + 8px);right:0;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;min-width:140px;max-width:220px;font-size:12px;z-index:999;box-shadow:0 4px 20px rgba(0,0,0,.3);white-space:nowrap;"></div>
    </div>
    <div class="forum-row-stat" style="display:flex;flex-direction:row;align-items:center;gap:8px;">
      <div style="display:flex;flex-direction:column;align-items:center;">
        <span class="forum-row-stat-label">Posted</span>
        <span class="forum-row-stat-val" style="font-size:12px;font-weight:600;color:var(--muted);">${new Date(post.created_at).toLocaleDateString([],{month:'short',day:'numeric'})}</span>
      </div>
      ${dragHandle}
    </div>
  </div>`;
}

async function loadForumViewers(el) {
  const tooltip = el.querySelector('.forum-viewers-tooltip');
  const postId = el.dataset.postId;
  tooltip.style.display = 'block';
  tooltip.innerHTML = '<span style="color:var(--muted);">Loading...</span>';
  try {
    const r = await fetch(API + '/api/forum/' + postId + '/views', { headers: hdr() });
    const d = await r.json();
    if (d.success && d.viewers.length > 0) {
      tooltip.innerHTML = d.viewers.map(v =>
        '<div style="padding:2px 0;color:var(--text);">👤 ' + escapeHtml(v.display_name || v.nickname) + '</div>'
      ).join('');
    } else {
      tooltip.innerHTML = '<span style="color:var(--muted);">No views yet</span>';
    }
  } catch(e) {
    tooltip.innerHTML = '<span style="color:var(--muted);">Error</span>';
  }
}

function hideForumViewers(el) {
  const tooltip = el.querySelector('.forum-viewers-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}

// Attach drag events + click after rendering forum rows
function attachForumRowEvents() {
  document.querySelectorAll('.draggable-post').forEach(row => {
    row.addEventListener('click', (e) => {
      if (forumWasDragging) { forumWasDragging = false; return; }
      openForumPost(row.dataset.postId);
    });
    row.addEventListener('dragstart', forumDragStart);
    row.addEventListener('dragover', forumDragOver);
    row.addEventListener('dragleave', forumDragLeave);
    row.addEventListener('drop', forumDrop);
    row.addEventListener('dragend', forumDragEnd);
  });
  // Non-draggable rows still need click
  document.querySelectorAll('.forum-row:not(.draggable-post)').forEach(row => {
    row.addEventListener('click', () => openForumPost(row.dataset.postId));
  });
}

let forumDragSrcId = null;
let forumWasDragging = false;

function forumDragStart(e) {
  forumDragSrcId = e.currentTarget.dataset.postId;
  forumWasDragging = true;
  e.currentTarget.style.opacity = '0.4';
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', forumDragSrcId);
}

function forumDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.draggable-post').forEach(r => r.classList.remove('drag-over'));
  if (e.currentTarget.dataset.postId !== forumDragSrcId) {
    e.currentTarget.classList.add('drag-over');
  }
}

function forumDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function forumDragEnd(e) {
  e.currentTarget.style.opacity = '';
  document.querySelectorAll('.draggable-post').forEach(r => r.classList.remove('drag-over'));
}

async function forumDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const targetId = e.currentTarget.dataset.postId;
  if (!forumDragSrcId || forumDragSrcId === targetId) return;

  const rows = [...document.querySelectorAll('.draggable-post')];
  const ids = rows.map(r => r.dataset.postId);
  const srcIdx = ids.indexOf(forumDragSrcId);
  const tgtIdx = ids.indexOf(targetId);
  ids.splice(srcIdx, 1);
  ids.splice(tgtIdx, 0, forumDragSrcId);

  forumDragSrcId = null;

  try {
    const r = await fetch(API + '/api/forum/reorder-pinned', {
      method: 'POST', headers: hdr(), body: JSON.stringify({ ids })
    });
    const d = await r.json();
    if (!d.success) toast('Failed to reorder', 'err');
    await loadForumPosts();
  } catch(e) { toast('Connection error', 'err'); }
}

function toggleForumSection(section) {
  const body = document.getElementById('forum-section-' + section);
  const toggle = document.getElementById('forum-toggle-' + section);
  if (!body) return;
  forumSectionState[section] = !forumSectionState[section];
  body.style.display = forumSectionState[section] ? 'block' : 'none';
  toggle.classList.toggle('collapsed', !forumSectionState[section]);
}

function openForumPost(postId) {
  const post = forumPosts.find(p => p.id === postId);
  if (!post) return;
  fetch(API + '/api/forum/' + postId + '/view', { method: 'POST', headers: hdr() }).catch(() => {});
  document.getElementById('forum-index-view').style.display = 'none';
  document.getElementById('forum-new-view').style.display = 'none';
  document.getElementById('forum-detail-view').style.display = 'block';
  const isAdmin = ['manager','owner'].includes(user.role);
  const isAuthor = post.user_id === user.id;
  const allowedEditors = post.allowed_editors || [];
  const canEdit = isAdmin || isAuthor || allowedEditors.includes(user.nickname);
  const canDelete = isAuthor || isAdmin;
  const canPin = isAdmin;
  const html = `<div class="forum-detail">
    <div class="forum-detail-title">${escapeHtml(post.title)}${post.is_pinned ? ' <span class="forum-pin-badge">📌 Pinned</span>' : ''}</div>
    <div class="forum-detail-meta">
      <div class="avatar avatar-sm"><span class="avatar-letter">${(post.author_name||'?')[0].toUpperCase()}</span><img class="avatar-img" ${post.user_id && localStorage.getItem('avatar_'+post.user_id) ? `src="${localStorage.getItem('avatar_'+post.user_id)}" style="display:block;"` : ''}></div>
      <div><div style="font-weight:600;font-size:13px;">${escapeHtml(post.author_name||'Unknown')}</div>
      <div style="font-size:11px;color:var(--muted);">${new Date(post.created_at).toLocaleDateString([],{day:'numeric',month:'short',year:'numeric'})} · ${new Date(post.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}</div></div>
      ${post.updated_at && post.updated_at !== post.created_at ? '<span style="font-size:11px;color:var(--muted);margin-left:8px;">(edited)</span>' : ''}
    </div>
    <div class="forum-detail-body">${post.content || ''}</div>
    <div class="forum-detail-actions">
      ${canPin ? `<button class="btn-ghost" style="font-size:12px;padding:6px 12px;" onclick="togglePinPost('${post.id}',${post.is_pinned})">${post.is_pinned ? '📌 Unpin' : '📌 Pin'}</button>` : ''}
      ${canEdit ? `<button class="btn-ghost" style="font-size:12px;padding:6px 12px;" onclick="openEditPost('${post.id}')">✏️ Edit</button>` : ''}
      ${canDelete ? `<button class="btn-ghost" style="font-size:12px;padding:6px 12px;background:rgba(255,85,102,.1);border-color:rgba(255,85,102,.2);color:var(--danger);" onclick="deleteForumPost('${post.id}')">🗑️ Delete</button>` : ''}
    </div>
  </div>
  <div class="forum-replies-wrap" id="forum-replies-wrap">
    <div class="forum-replies-header">💬 Replies <span id="forum-reply-count" style="color:var(--muted);font-weight:400;font-size:11px;"></span></div>
    <div id="forum-replies-list"><div style="padding:20px;text-align:center;color:var(--muted);"><span class="spinner"></span></div></div>
    <div style="padding:14px 16px;border-top:1px solid var(--border);">
      <div class="forum-reply-box">
        <div class="avatar avatar-sm" style="flex-shrink:0;margin-top:2px;"><span class="avatar-letter">${user.nickname[0].toUpperCase()}</span><img class="avatar-img" id="forum-reply-box-avatar" ${localStorage.getItem('avatar_'+user.id) ? `src="${localStorage.getItem('avatar_'+user.id)}" style="display:block;"` : ''}></div>
        <textarea class="forum-reply-input" id="reply-input-${post.id}" placeholder="Write a reply..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();submitReply('${post.id}');}"></textarea>
        <button class="btn btn-primary btn-sm" style="flex-shrink:0;margin-top:2px;" onclick="submitReply('${post.id}')">Reply</button>
      </div>
    </div>
  </div>`;
  document.getElementById('forum-detail-content').innerHTML = html;
  loadReplies(postId);
}

let forumEditorSavedRange = null;

function forumEditorFocus() {
  const editor = document.getElementById('forum-body-input');
  if (editor) editor.focus();
}

function forumSetColor(color) {
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  if (forumEditorSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(forumEditorSavedRange);
  }
  document.execCommand('foreColor', false, color);
}

// ✅ FIXED font size — no execCommand, direct DOM manipulation
function forumSetFontSizePx(px) {
  if (!px || px < 1) return;
  px = parseInt(px);
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);

  if (range.collapsed) {
    // No selection — place a sized span at cursor so next typed text uses this size
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    span.appendChild(document.createTextNode('\u200B'));
    range.insertNode(span);
    range.setStart(span.firstChild, 1);
    range.setEnd(span.firstChild, 1);
    sel.removeAllRanges();
    sel.addRange(range);
  } else {
    // Has selection — wrap in sized span
    const contents = range.extractContents();
    const span = document.createElement('span');
    span.style.fontSize = px + 'px';
    span.appendChild(contents);
    range.insertNode(span);
    range.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function forumInsertImage() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) forumEditorSavedRange = sel.getRangeAt(0).cloneRange();
  document.getElementById('image-modal-url').value = '';
  document.getElementById('image-modal-preview').style.display = 'none';
  document.getElementById('image-modal-img').src = '';
  document.getElementById('image-modal-overlay').classList.add('show');
  setTimeout(() => document.getElementById('image-modal-url').focus(), 50);
}

document.addEventListener('DOMContentLoaded', () => {
  // Stock note input
  const noteInput = document.getElementById('stock-note-input');
  if (noteInput) noteInput.addEventListener('input', updateStockSubmitButton);
  const urlInput = document.getElementById('image-modal-url');
  if (urlInput) urlInput.addEventListener('input', () => {
    const v = urlInput.value.trim();
    const preview = document.getElementById('image-modal-preview');
    const img = document.getElementById('image-modal-img');
    if (v.match(/\.(jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i) || v.startsWith('https://')) {
      img.src = v;
      img.onload = () => { preview.style.display = 'block'; };
      img.onerror = () => { preview.style.display = 'none'; };
    } else { preview.style.display = 'none'; }
  });

  // Forum editor toolbar state
  const bodyInput = document.getElementById('forum-body-input');
  if (bodyInput) {
    bodyInput.addEventListener('keyup', updateForumToolbarState);
    bodyInput.addEventListener('mouseup', updateForumToolbarState);
    bodyInput.addEventListener('selectionchange', updateForumToolbarState);

    // Save selection when editor loses focus so toolbar buttons can restore it
    bodyInput.addEventListener('blur', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) forumEditorSavedRange = sel.getRangeAt(0).cloneRange();
    });

    // Backspace: delete table if cursor is immediately after or before it
    bodyInput.addEventListener('keydown', e => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      let node = range.startContainer;

      // Check if cursor is right at the start of a node whose previous sibling is a table (Backspace)
      // or right at the end of a node whose next sibling is a table (Delete)
      const checkNode = (n) => {
        while (n && n !== bodyInput) {
          if (e.key === 'Backspace' && n.previousSibling?.id?.startsWith('tbl')) {
            // Only delete if we're at the very start of this node
            if (range.startOffset === 0) {
              e.preventDefault();
              n.previousSibling.remove();
              return true;
            }
          }
          if (e.key === 'Delete' && n.nextSibling?.id?.startsWith('tbl')) {
            e.preventDefault();
            n.nextSibling.remove();
            return true;
          }
          n = n.parentNode;
        }
        return false;
      };

      // Also handle when cursor is directly adjacent to the table wrapper itself
      if (node === bodyInput) {
        const el = e.key === 'Backspace'
          ? bodyInput.children[range.startOffset - 1]
          : bodyInput.children[range.startOffset];
        if (el?.id?.startsWith('tbl')) {
          e.preventDefault();
          el.remove();
          return;
        }
      }

      checkNode(node);
    });
  }

  // Populate emoji picker
  const ep = document.getElementById('emoji-picker-popup');
  if (ep) {
    EMOJIS.forEach(em => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.textContent = em;
      btn.onmousedown = (e) => { e.preventDefault(); insertEmoji(em); };
      ep.appendChild(btn);
    });
  }

  try { document.execCommand('enableObjectResizing', false, false); } catch(e) {}
  try { document.execCommand('enableInlineTableEditing', false, false); } catch(e) {}

  // Prevent toolbar buttons from stealing focus — makes H1/H2/H3 work
document.querySelectorAll('.forum-toolbar button').forEach(el => {
    el.addEventListener('mousedown', e => e.preventDefault());
  });
const fontSizeSelect = document.getElementById('forum-font-size');
  if (fontSizeSelect) {
    fontSizeSelect.addEventListener('mousedown', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) forumEditorSavedRange = sel.getRangeAt(0).cloneRange();
    });
  }
});

function closeImageModal() {
  document.getElementById('image-modal-overlay').classList.remove('show');
}

function confirmImageModal() {
  const url = document.getElementById('image-modal-url').value.trim();
  if (!url) return;
  closeImageModal();
  const editor = document.getElementById('forum-body-input');
  editor.focus();
  if (forumEditorSavedRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(forumEditorSavedRange);
  }
  document.execCommand('insertHTML', false, `<img src="${url}" style="max-width:100%;border-radius:10px;margin:8px 0;display:block;border:1px solid var(--border);" onerror="this.style.display='none'">`);
}

function showForumIndex() {
  document.getElementById('forum-index-view').style.display = 'block';
  document.getElementById('forum-detail-view').style.display = 'none';
  document.getElementById('forum-new-view').style.display = 'none';
}

function showForumNewPost() {
  document.getElementById('forum-form-title').textContent = '✏️ New Post';
  document.getElementById('forum-edit-id').value = '';
  document.getElementById('forum-title-input').value = '';
  document.getElementById('forum-body-input').innerHTML = '';
  document.getElementById('forum-editors-field').style.display = 'block';
  initEditorPicker([]);
  document.getElementById('forum-index-view').style.display = 'none';
  document.getElementById('forum-detail-view').style.display = 'none';
  document.getElementById('forum-new-view').style.display = 'block';
}

function openEditPost(postId) {
  const post = forumPosts.find(p => p.id === postId);
  if (!post) return;
  const isAuthor = post.user_id === user.id;
  document.getElementById('forum-form-title').textContent = '✏️ Edit Post';
  document.getElementById('forum-edit-id').value = postId;
  document.getElementById('forum-title-input').value = post.title;
  document.getElementById('forum-body-input').innerHTML = post.content || '';
  const editorsField = document.getElementById('forum-editors-field');
  editorsField.style.display = isAuthor ? 'block' : 'none';
  if (isAuthor) initEditorPicker(post.allowed_editors || []);
  document.getElementById('forum-index-view').style.display = 'none';
  document.getElementById('forum-detail-view').style.display = 'none';
  document.getElementById('forum-new-view').style.display = 'block';
}

let editorPickerSelected = [];

function initEditorPicker(preselected) {
  editorPickerSelected = [...preselected];
  renderEditorTags();
  renderEditorDropdown();
}

function renderEditorTags() {
  const wrap = document.getElementById('forum-editors-tags');
  if (!wrap) return;
  wrap.innerHTML = editorPickerSelected.map(name =>
    `<span class="editor-tag">${escapeHtml(name)}<button onclick="removeEditorTag('${name}')" title="Remove">✕</button></span>`
  ).join('');
}

function renderEditorDropdown() {
  const wrap = document.getElementById('forum-editors-dropdown');
  if (!wrap) return;
  const others = allEmployees.filter(e => e.id !== user.id);
  if (others.length === 0) { wrap.innerHTML = '<span style="font-size:12px;color:var(--muted);">No other employees</span>'; return; }
  wrap.innerHTML = others.map(e => {
    const selected = editorPickerSelected.includes(e.nickname);
    return `<button class="editor-pick-btn${selected ? ' selected' : ''}" onclick="toggleEditorTag('${e.nickname}')">${escapeHtml(e.nickname)}</button>`;
  }).join('');
}

function toggleEditorTag(name) {
  if (editorPickerSelected.includes(name)) {
    editorPickerSelected = editorPickerSelected.filter(n => n !== name);
  } else {
    editorPickerSelected.push(name);
  }
  renderEditorTags();
  renderEditorDropdown();
}

function removeEditorTag(name) {
  editorPickerSelected = editorPickerSelected.filter(n => n !== name);
  renderEditorTags();
  renderEditorDropdown();
}

function getEditorPickerValues() {
  return [...editorPickerSelected];
}

async function submitForumPost() {
  const title = document.getElementById('forum-title-input').value.trim();
  const editor = document.getElementById('forum-body-input');
  const content = editor.innerHTML.trim();
  const editId = document.getElementById('forum-edit-id').value;
  const allowed_editors = getEditorPickerValues();
  const errEl = document.getElementById('forum-err');
  if (!title) { showErr(errEl, 'Title is required'); return; }
  if (!content || content === '<br>') { showErr(errEl, 'Content is required'); return; }
  try {
    const body = {title, content, allowed_editors};
    const r = editId
      ? await fetch(API + '/api/forum/' + editId, {method:'PATCH', headers:hdr(), body:JSON.stringify(body)})
      : await fetch(API + '/api/forum', {method:'POST', headers:hdr(), body:JSON.stringify(body)});
    const d = await r.json();
    if (d.success) {
      toast(editId ? '✅ Post updated!' : '✅ Post published!');
      errEl.style.display = 'none';
      await loadForumPosts();
      if (editId) {
        document.getElementById('forum-index-view').style.display = 'none';
        document.getElementById('forum-new-view').style.display = 'none';
        document.getElementById('forum-detail-view').style.display = 'block';
        openForumPost(editId);
      } else {
        showForumIndex();
      }
    }
    else showErr(errEl, d.error || 'Failed to post');
  } catch(e) { showErr(errEl, 'Connection error'); }
}

async function deleteForumPost(postId) {
  const confirmed = await showModal({icon:'🗑️', title:'Delete Post?', message:'This will permanently delete this post.', confirmText:'Delete', danger:true});
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/forum/' + postId, {method:'DELETE', headers:hdr()});
    const d = await r.json();
    if (d.success) { toast('🗑️ Post deleted'); await loadForumPosts(); showForumIndex(); }
    else toast(d.error || 'Failed', 'err');
  } catch(e) { toast('Connection error', 'err'); }
}

async function togglePinPost(postId, currentlyPinned) {
  try {
    const r = await fetch(API + '/api/forum/' + postId + '/pin', {method:'PATCH', headers:hdr(), body:JSON.stringify({is_pinned: !currentlyPinned})});
    const d = await r.json();
    if (d.success) { toast(currentlyPinned ? 'Post unpinned' : '📌 Post pinned'); await loadForumPosts(); openForumPost(postId); }
    else toast(d.error || 'Failed', 'err');
  } catch(e) { toast('Connection error', 'err'); }
}

// ========================================================================
// REIMBURSEMENTS — Submit receipts, approve/reject
// ========================================================================

let currentReimburseTab = 'pending', reimbursePhotoData = null;

function previewReimbursePhoto(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('Image too large. Max 5MB', 'err'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    reimbursePhotoData = e.target.result;
    document.getElementById('reimburse-photo-img').src = reimbursePhotoData;
    document.getElementById('reimburse-photo-preview').style.display = 'block';
    updateReimburseSubmitButton();
  };
  reader.readAsDataURL(file);
}

function updateReimburseSubmitButton() {
  const btn = document.getElementById('btn-submit-reimburse');
  const amount = parseFloat(document.getElementById('reimburse-amount-input')?.value);
  btn.disabled = !reimbursePhotoData || !amount || amount <= 0;
}

async function submitReimbursement() {
  const amount = parseFloat(document.getElementById('reimburse-amount-input').value);
  const errEl = document.getElementById('reimburse-err');
  const btn = document.getElementById('btn-submit-reimburse');
  if (!reimbursePhotoData) { showErr(errEl, 'Please upload a receipt photo'); return; }
  if (!amount || amount <= 0) { showErr(errEl, 'Please enter a valid amount'); return; }
  btn.innerHTML = '<span class="spinner"></span> Submitting...'; btn.disabled = true; errEl.style.display = 'none';
  try {
    const r = await fetch(API + '/api/reimbursements', {
      method: 'POST', headers: hdr(),
      body: JSON.stringify({ image_data: reimbursePhotoData, amount })
    });
    const d = await r.json();
    if (d.success) {
      toast('✅ Reimbursement submitted!');
      reimbursePhotoData = null;
      document.getElementById('reimburse-photo-input').value = '';
      document.getElementById('reimburse-photo-preview').style.display = 'none';
      document.getElementById('reimburse-amount-input').value = '';
      updateReimburseSubmitButton();
      loadReimbursements();
    } else { showErr(errEl, d.error || 'Failed to submit'); btn.disabled = false; }
  } catch(e) { showErr(errEl, 'Connection error'); btn.disabled = false; }
  btn.innerHTML = '➕ Submit Request';
}

function switchReimburseTab(tab) {
  currentReimburseTab = tab;
  document.querySelectorAll('#reimburse-manager-tabs .stock-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  const title = document.getElementById('reimburse-list-title');
  if (title) title.textContent = tab === 'pending' ? 'Pending Requests' : 'Paid Requests';
  loadReimbursements();
}

async function loadReimbursements() {
  const list = document.getElementById('reimburse-list'); if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:20px;"><span class="spinner"></span></div>';
  try {
    const isAdmin = ['manager','owner'].includes(user.role);
    const url = API + '/api/reimbursements' + (isAdmin ? '?status=' + currentReimburseTab : '');
    const r = await fetch(url, {headers: hdr()});
    const d = await r.json();
    if (d.success && d.reimbursements) {
      renderReimbursements(d.reimbursements);
      updateReimburseCounts();
    } else {
      renderReimbursements([]);
    }
  } catch(e) { list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--danger);">Failed to load</div>'; }
}

function renderReimbursements(items) {
  const list = document.getElementById('reimburse-list');
  if (items.length === 0) {
    list.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;"><div style="font-size:48px;margin-bottom:12px;">🧾</div><div style="font-weight:600;margin-bottom:6px;">No reimbursements</div></div>';
    return;
  }
  const isAdmin = ['manager','owner'].includes(user.role);
  list.innerHTML = '<div class="reimburse-grid">' + items.map(item => {
    const timeAgo = getTimeAgo(new Date(item.created_at));
    const statusColor = item.status === 'paid' ? 'var(--green)' : 'var(--amber)';
    const statusIcon = item.status === 'paid' ? '✅' : '⏳';
    let html = `<div class="reimburse-item ${item.status}" style="position:relative;">
      <button onclick="deleteReimbursement('${item.id}')" style="position:absolute;top:8px;right:8px;z-index:2;width:24px;height:24px;border-radius:50%;border:none;background:rgba(0,0,0,.5);color:#fff;font-size:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;backdrop-filter:blur(4px);">✕</button>
      <div class="reimburse-photo-wrap">
        <img src="${item.image_data}" class="reimburse-photo" onclick="openReimburseLightbox('${item.id}')" alt="Receipt">
      </div>
      <div class="reimburse-body">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <div style="font-family:'Oxanium',sans-serif;font-weight:700;font-size:20px;color:var(--green);">$${parseFloat(item.amount).toFixed(2)}</div>
          <span class="badge" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;font-size:10px;">${statusIcon} ${item.status.toUpperCase()}</span>
        </div>`;
    if (isAdmin) {
      html += `<div style="display:flex;align-items:center;gap:6px;">
        <div class="avatar" style="width:20px;height:20px;font-size:10px;display:inline-flex;flex-shrink:0;"><span class="avatar-letter">${(item.user_nickname||'?')[0].toUpperCase()}</span></div>
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text);">${escapeHtml(item.user_nickname||'Unknown')}</div>
          ${item.user_sid ? `<div style="font-size:10px;color:var(--muted);">SID: ${escapeHtml(item.user_sid)}</div>` : ''}
        </div>
      </div>`;
    }
    html += `<div class="reimburse-meta"><span>📅 ${timeAgo}</span>`;
    if (item.status === 'paid' && item.reviewed_by_nickname) html += ` · <span>✅ ${escapeHtml(item.reviewed_by_nickname)}</span>`;
    html += `</div>`;
    if (isAdmin && item.status === 'pending') {
      html += `<div class="reimburse-actions">
        <button onclick="reviewReimbursement('${item.id}','paid')" class="btn-approve" style="flex:1;padding:8px;">✅ Paid</button>
        <button onclick="deleteReimbursement('${item.id}')" class="btn-delete-reimburse">🗑️</button>
      </div>`;
    }
    html += `</div></div>`;
    return html;
  }).join('') + '</div>';
  window._reimburseItems = items;
}

function openReimburseLightbox(id) {
  const item = (window._reimburseItems||[]).find(i => i.id === id);
  if (!item) return;
  const lb = document.createElement('div');
  lb.id = 'reimburse-lightbox';
  lb.onclick = () => lb.remove();
  lb.innerHTML = `<img src="${item.image_data}" alt="Receipt">`;
  document.body.appendChild(lb);
}

async function reviewReimbursement(id, status) {
  const confirmed = await showModal({
    icon: '✅', title: 'Mark as Paid?', message: 'Mark this reimbursement as paid?',
    confirmText: 'Mark Paid', danger: false
  });
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/reimbursements/' + id + '/review', {
      method: 'PATCH', headers: hdr(), body: JSON.stringify({ status })
    });
    const d = await r.json();
    if (d.success) { toast('✅ Marked as paid!'); loadReimbursements(); }
    else { toast(d.error || 'Failed', 'err'); }
  } catch(e) { toast('Connection error', 'err'); }
}

async function deleteReimbursement(id) {
  const confirmed = await showModal({
    icon: '🗑️', title: 'Delete Request?', message: 'Are you sure you want to delete this reimbursement request?',
    confirmText: 'Delete', danger: true
  });
  if (!confirmed) return;
  // Remove instantly from DOM
  const el = document.querySelector(`.reimburse-item button[onclick*="${id}"]`)?.closest('.reimburse-item');
  if (el) { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }
  try {
    await fetch(API + '/api/reimbursements/' + id, { method: 'DELETE', headers: hdr() });
    toast('🗑️ Deleted');
  } catch(e) { toast('Connection error', 'err'); loadReimbursements(); }
}

async function updateReimburseCounts() {
  if (!['manager','owner'].includes(user.role)) return;
  try {
    const [rPending, rPaid] = await Promise.all([
      fetch(API + '/api/reimbursements?status=pending', {headers: hdr()}),
      fetch(API + '/api/reimbursements?status=paid', {headers: hdr()})
    ]);
    const [dPending, dPaid] = await Promise.all([rPending.json(), rPaid.json()]);
    const pc = document.getElementById('reimburse-pending-count');
    const pd = document.getElementById('reimburse-paid-count');
    if (pc) pc.textContent = dPending.reimbursements?.length || 0;
    if (pd) pd.textContent = dPaid.reimbursements?.length || 0;
  } catch(e) {}
}

// ============================================================
// STATS & FINANCE
// ============================================================
let statsChart = null;
let statsRange = 'week';
let statsType = 'bar';
let allPayouts = [];
let statsData = null;

async function loadFinanceStats() {
  try {
    const r = await fetch(API + '/api/stats', {headers: hdr()});
    const d = await r.json();
    if (!d.success) return;
    statsData = d;
    allPayouts = d.recentLog || [];
    renderStatCards();
    renderStatsChart();
    renderPayoutLog();
  } catch(e) { console.error('Stats error:', e); }
}

function renderStatCards() {
  if (!statsData) return;
  const c = statsData.cards;
  document.getElementById('stat-week').textContent = '$' + Math.round(c.thisWeek).toLocaleString('en-US');
  document.getElementById('stat-month').textContent = '$' + Math.round(c.thisMonth).toLocaleString('en-US');
  document.getElementById('stat-alltime').textContent = '$' + Math.round(c.allTime).toLocaleString('en-US');
  document.getElementById('stat-record').textContent = '$' + Math.round(c.record).toLocaleString('en-US');
}

function renderPayoutLog() {
  const el = document.getElementById('payout-log-list');
  if (!allPayouts.length) {
    el.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--muted);font-size:14px;">
      <div style="font-size:48px;margin-bottom:12px;">💸</div>
      <div style="font-weight:600;margin-bottom:6px;">No payouts yet</div>
      <div style="font-size:13px;">Add your first payout to get started</div>
    </div>`;
    return;
  }

  const sorted = [...allPayouts].sort((a, b) => new Date(b.payout_date) - new Date(a.payout_date));

  el.innerHTML = sorted.map((p, i) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:32px;height:32px;border-radius:10px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-weight:700;color:var(--muted);font-size:13px;">#${sorted.length - i}</div>
        <div>
          <div style="font-weight:600;font-size:14px;">${p.note || 'Payout'}</div>
          <div style="font-size:12px;color:var(--muted);">${new Date(p.payout_date).toLocaleDateString('en-US', {year:'numeric',month:'short',day:'numeric'})}${p.creator_name ? ' · by ' + p.creator_name : ''}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="font-family:'Oxanium',sans-serif;font-weight:700;font-size:16px;color:var(--green);">$${parseFloat(p.amount).toLocaleString('en-US', {minimumFractionDigits:2})}</div>
        <button onclick="deletePayout(${p.id})" style="background:rgba(255,85,102,.1);border:1px solid rgba(255,85,102,.2);color:var(--danger);border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;">🗑</button>
      </div>
    </div>
  `).join('');
}

function renderStatsChart() {
  if (!statsData) return;
  const ctx = document.getElementById('stats-chart').getContext('2d');

  let chartPoints;
  if (statsRange === 'week') chartPoints = statsData.charts.daily;
  else if (statsRange === 'month') chartPoints = statsData.charts.weekly;
  else chartPoints = statsData.charts.monthly;

  const labels = chartPoints.map(p => p.label);
  const values = chartPoints.map(p => p.total);

  if (statsChart) statsChart.destroy();

  const maxVal = values.length ? Math.max(...values) : 0;
  const bgColors = values.map(v => v === maxVal && v > 0 ? 'rgba(255,181,71,.7)' : 'rgba(139,92,246,.35)');
  const pointColors = values.map(v => v === maxVal && v > 0 ? '#ffb547' : '#8b5cf6');
  const pointRadii = values.map(v => v === maxVal && v > 0 ? 8 : 4);

  statsChart = new Chart(ctx, {
    type: statsType,
    data: {
      labels,
      datasets: [{
        label: 'Payout ($)',
        data: values,
        backgroundColor: statsType === 'bar' ? bgColors : 'rgba(139,92,246,.35)',
        borderColor: statsType === 'line' ? '#8b5cf6' : bgColors,
        borderWidth: statsType === 'line' ? 2 : 0,
        borderRadius: statsType === 'bar' ? 8 : 0,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointColors,
        pointRadius: statsType === 'line' ? pointRadii : undefined,
        tension: 0.4,
        fill: statsType === 'line',
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => '$' + ctx.parsed.y.toLocaleString('en-US', {minimumFractionDigits:2})
          }
        }
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#888' } },
        y: {
          grid: { color: 'rgba(255,255,255,.05)' },
          ticks: {
            color: '#888',
            callback: v => '$' + v.toLocaleString()
          },
          beginAtZero: true
        }
      }
    }
  });
}

function setStatsRange(range) {
  statsRange = range;
  document.querySelectorAll('.stats-range-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderStatsChart();
}

function setStatsType(type) {
  statsType = type;
  document.querySelectorAll('.stats-type-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  renderStatsChart();
}

// --- Add Payout Modal ---
function openAddPayoutModal() {
  document.getElementById('payout-amount-input').value = '';
  document.getElementById('payout-date-input').value = new Date().toISOString().split('T')[0];
  document.getElementById('payout-note-input').value = '';
  document.getElementById('payout-err').textContent = '';
  document.getElementById('add-payout-overlay').style.display = 'flex';
}

function closeAddPayoutModal() {
  document.getElementById('add-payout-overlay').style.display = 'none';
}

async function submitPayout() {
  const amount = parseFloat(document.getElementById('payout-amount-input').value);
  const payout_date = document.getElementById('payout-date-input').value;
  const note = document.getElementById('payout-note-input').value.trim();
  const errEl = document.getElementById('payout-err');

  if (!amount || amount <= 0) { errEl.textContent = 'Enter a valid amount.'; return; }
  if (!payout_date) { errEl.textContent = 'Select a date.'; return; }

  try {
    const res = await fetch(API + '/api/payouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ amount, payout_date, note })
    });
    const data = await res.json();
    if (!res.ok || !data.success) { errEl.textContent = data.error || 'Failed to save.'; return; }
    closeAddPayoutModal();
    await loadPayouts();
    renderStatCards();
    renderStatsChart();
    showToast('Payout saved! 💸');
  } catch (e) {
    errEl.textContent = 'Server error.';
  }
}

async function deletePayout(id) {
  const confirmed = await showModal({ icon: '🗑️', title: 'Delete Payout', message: 'Are you sure you want to delete this payout? This cannot be undone.', confirmText: 'Delete', danger: true });
  if (!confirmed) return;
  try {
    const r = await fetch(API + '/api/payouts/' + id, { method: 'DELETE', headers: hdr() });
    const d = await r.json();
    if (d.success) { toast('🗑️ Payout deleted'); loadFinanceStats(); }
    else toast(d.error || 'Failed to delete', 'err');
  } catch(e) { toast('Connection error', 'err'); }
}

(function initCursor() {
  if (window.matchMedia('(hover: none)').matches) return;

  const style = document.createElement('style');
  style.textContent = '*, *:hover { cursor: none !important; }';
  document.head.appendChild(style);

  // Logo blue: #0BBFFF — between cyan and the graffiti blue
  const COLOR_NORMAL = '#0BBFFF';
  const COLOR_HOVER  = '#A855F7';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99997;mix-blend-mode:screen;';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const cc = document.createElement('canvas');
  cc.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;';
  document.body.appendChild(cc);
  const cctx = cc.getContext('2d');

  function resize() { canvas.width = cc.width = window.innerWidth; canvas.height = cc.height = window.innerHeight; }
  resize();
  window.addEventListener('resize', resize);

  const TRAIL = 22;
  const OFFSET_X = 4;
  const OFFSET_Y = 10;

  let mx = -200, my = -200;
  let isHover = false;

  const trail = Array(TRAIL).fill(null).map(() => ({ x: -200, y: -200 }));

  const INTERACTIVE = 'button, a, input, select, textarea, [onclick], [contenteditable], .nav-item, .forum-row, .employee-card, .worker-card, .chip, label';

  document.addEventListener('mousemove', e => {
    mx = e.clientX;
    my = e.clientY;
    // Check directly what's under the cursor
    isHover = !!e.target.closest(INTERACTIVE);
  });
  document.addEventListener('mouseleave', () => { mx = -200; my = -200; isHover = false; });

  function drawArrow(x, y) {
    cctx.clearRect(0, 0, cc.width, cc.height);
    if (x < 0) return;
    const color = isHover ? COLOR_HOVER : COLOR_NORMAL;
    cctx.save();
    cctx.translate(x, y);
    cctx.shadowBlur = 10;
    cctx.shadowColor = color;
    cctx.fillStyle = color;
    cctx.beginPath();
    cctx.moveTo(0, 0); cctx.lineTo(0, 18);
    cctx.lineTo(4, 13); cctx.lineTo(8, 20);
    cctx.lineTo(10.5, 18.5); cctx.lineTo(6.5, 11.5);
    cctx.lineTo(12, 11.5); cctx.closePath();
    cctx.fill();
    cctx.strokeStyle = 'rgba(0,0,0,0.35)';
    cctx.lineWidth = 0.8;
    cctx.stroke();
    cctx.restore();
  }

  function animate() {
    const ox = mx < 0 ? -200 : mx + OFFSET_X;
    const oy = my < 0 ? -200 : my + OFFSET_Y;

    for (let i = TRAIL - 1; i > 0; i--) {
      trail[i].x += (trail[i-1].x - trail[i].x) * 0.4;
      trail[i].y += (trail[i-1].y - trail[i].y) * 0.4;
    }
    trail[0].x = ox;
    trail[0].y = oy;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < TRAIL; i++) {
      const pos = trail[i];
      if (pos.x < 0) continue;
      const progress = i / TRAIL;
      // Trail: logo-blue → purple
      const r = Math.round(11  + (168 - 11)  * progress);
      const g = Math.round(191 * (1 - progress));
      const b = Math.round(255 * (1 - progress * 0.03) + 247 * progress * 0.03);
      const alpha = (1 - progress) * 0.5;
      const size = Math.max(1, 4.5 - i * 0.18);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.fill();
    }

    drawArrow(mx, my);
    requestAnimationFrame(animate);
  }
  animate();
})();
