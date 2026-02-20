// === NOTIFICATIONS ===
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
    if (['manager', 'owner'].includes(user.role)) {
      const r = await fetch(API + '/api/users/notifications?limit=20', {headers: hdr()});
      const d = await r.json();
      if (d.success && d.notifications) {
        notifications = d.notifications;
        renderStockNotifications();
        updateNotifBadge(d.notifications.filter(n => !n.is_read).length);
      }
      return;
    }
    const r = await fetch(API + '/api/payments/my-payments?limit=10', {headers: hdr()});
    const d = await r.json();
    if (d.success && d.payments) {
      notifications = d.payments;
      renderPaymentNotifications();
      updateNotifBadge(notifications.length);
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
    html += '<div style="font-family:\'Oxanium\',sans-serif;font-weight:700;color:var(--green);font-size:15px;">€' + (Number(n.amount)||0).toFixed(2) + '</div></div>';
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
  try {
    const r = await fetch(`${API}/api/notifications/${notifId}`, {method:'DELETE',headers:hdr()});
    if (r.ok) { loadNotifications(); toast('🗑️ Notification deleted'); }
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

// === APP ===
function showApp() {
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-app').style.display = 'block';
  document.getElementById('nav-name').textContent = user.nickname;
  document.getElementById('nav-role').textContent = user.role;
  loadNotifications();
  if (['manager', 'owner'].includes(user.role)) {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
    if (user.role === 'manager') {
      const payCalcBtn = document.getElementById('si-payments');
      const payCalcPanel = document.getElementById('panel-payments');
      if (payCalcBtn) payCalcBtn.style.display = 'none';
      if (payCalcPanel) payCalcPanel.style.display = 'none';
    }
    initChat();
    loadPendingEmployees();
  } else {
    document.querySelectorAll('.admin-only').forEach(el => { el.classList.add('hidden'); el.style.display = 'none'; });
  }
  loadClockStatus();
  loadStats();
  sendHeartbeat();
  // Pre-load employees silently so forum editor picker works immediately
  fetch(API + '/api/users', {headers: hdr()}).then(r => r.json()).then(d => {
    if (d.success && d.users) allEmployees = d.users.filter(u => u.is_active);
  }).catch(() => {});
}

function go(panel) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const si = document.getElementById('si-' + panel);
  if (si) si.classList.add('active');
  document.getElementById('panel-' + panel).classList.add('active');
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
}
