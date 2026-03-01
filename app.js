// ─── DATABASE & STATE ───
let db = null;
let currentUser = null;
let tasks = [];
let activeFilters = new Set();
let searchQuery = '';
let editingId = null;
let statusChangeId = null;
let ganttStartDate = null;
const GANTT_DAYS = 28;
const DB_NAME = 'taskflow_db';
const DB_STORE = 'sqlitedb';

// ─── SHA-256 HASH ───
async function hashPassword(pw) {
    const buf = new TextEncoder().encode(pw);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── INDEXED-DB PERSISTENCE ───
function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function saveDBToIDB() {
    const data = db.export();
    const idb = await openIDB();
    const tx = idb.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(data, 'db');
    return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
}
async function loadDBFromIDB() {
    const idb = await openIDB();
    const tx = idb.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('db');
    return new Promise((resolve) => { req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null); });
}

// ─── INIT DATABASE ───
async function initDatabase() {
    const SQL = await initSqlJs({ locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${f}` });
    const saved = await loadDBFromIDB();
    if (saved) {
        db = new SQL.Database(new Uint8Array(saved));
    } else {
        db = new SQL.Database();
    }
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'To Do',
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
    await saveDBToIDB();

    // Migrate old localStorage tasks if they exist
    try {
        const old = localStorage.getItem('taskflow_tasks');
        if (old) {
            const oldTasks = JSON.parse(old);
            if (Array.isArray(oldTasks) && oldTasks.length > 0) {
                // Store for migration after first user registers
                window._migrationTasks = oldTasks;
            }
        }
    } catch (e) { }
}

// ─── AUTH FUNCTIONS ───
async function doRegister() {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const pw = document.getElementById('regPassword').value;
    const errEl = document.getElementById('registerError');
    errEl.classList.remove('show');

    if (!name || !email || !pw) { errEl.textContent = 'Preencha todos os campos.'; errEl.classList.add('show'); return; }
    if (pw.length < 4) { errEl.textContent = 'A senha deve ter no mínimo 4 caracteres.'; errEl.classList.add('show'); return; }

    const existing = db.exec("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length > 0 && existing[0].values.length > 0) {
        errEl.textContent = 'Este e-mail já está cadastrado.'; errEl.classList.add('show'); return;
    }

    const hash = await hashPassword(pw);
    db.run("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)", [name, email, hash]);
    await saveDBToIDB();

    const res = db.exec("SELECT id, name, email FROM users WHERE email = ?", [email]);
    currentUser = { id: res[0].values[0][0], name: res[0].values[0][1], email: res[0].values[0][2] };
    sessionStorage.setItem('taskflow_user', JSON.stringify(currentUser));

    // Migrate old localStorage tasks to this user
    if (window._migrationTasks && window._migrationTasks.length > 0) {
        for (const t of window._migrationTasks) {
            const id = t.id || genId();
            db.run("INSERT OR IGNORE INTO tasks (id, user_id, title, description, status, start_date, end_date) VALUES (?,?,?,?,?,?,?)",
                [id, currentUser.id, t.title || '', t.description || '', t.status || 'To Do', t.startDate || '', t.endDate || '']);
        }
        await saveDBToIDB();
        localStorage.removeItem('taskflow_tasks');
        delete window._migrationTasks;
    }

    showApp();
}

async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const pw = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.classList.remove('show');

    if (!email || !pw) { errEl.textContent = 'Preencha todos os campos.'; errEl.classList.add('show'); return; }

    const hash = await hashPassword(pw);
    const res = db.exec("SELECT id, name, email FROM users WHERE email = ? AND password_hash = ?", [email, hash]);
    if (res.length === 0 || res[0].values.length === 0) {
        errEl.textContent = 'E-mail ou senha incorretos.'; errEl.classList.add('show'); return;
    }

    currentUser = { id: res[0].values[0][0], name: res[0].values[0][1], email: res[0].values[0][2] };
    sessionStorage.setItem('taskflow_user', JSON.stringify(currentUser));
    showApp();
}

function doLogout() {
    currentUser = null;
    tasks = [];
    sessionStorage.removeItem('taskflow_user');
    closeUserDropdown();
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    // Clear form fields
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
}

async function doDeleteAccount() {
    if (!confirm('Tem certeza que deseja excluir sua conta? Todas as suas tarefas serão perdidas.')) return;
    db.run("DELETE FROM tasks WHERE user_id = ?", [currentUser.id]);
    db.run("DELETE FROM users WHERE id = ?", [currentUser.id]);
    await saveDBToIDB();
    doLogout();
}

// ─── AUTH UI ───
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', (tab === 'login' ? i === 0 : i === 1)));
    document.getElementById('loginForm').classList.toggle('active', tab === 'login');
    document.getElementById('registerForm').classList.toggle('active', tab === 'register');
    document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('show'));
}

// ─── USER MENU ───
function toggleUserMenu(e) {
    e.stopPropagation();
    document.getElementById('userDropdown').classList.toggle('show');
}
function closeUserDropdown() {
    document.getElementById('userDropdown').classList.remove('show');
}

// ─── PROFILE MODAL ───
function openProfileModal() {
    closeUserDropdown();
    document.getElementById('profileName').value = currentUser.name;
    document.getElementById('profileEmail').value = currentUser.email;
    document.getElementById('profilePassword').value = '';
    document.getElementById('profileError').classList.remove('show');
    document.getElementById('profileModal').classList.add('show');
}
function closeProfileModal() { document.getElementById('profileModal').classList.remove('show'); }
async function saveProfile() {
    const name = document.getElementById('profileName').value.trim();
    const email = document.getElementById('profileEmail').value.trim().toLowerCase();
    const pw = document.getElementById('profilePassword').value;
    const errEl = document.getElementById('profileError');
    errEl.classList.remove('show');

    if (!name || !email) { errEl.textContent = 'Nome e e-mail são obrigatórios.'; errEl.classList.add('show'); return; }

    // Check email uniqueness (excluding current user)
    const dup = db.exec("SELECT id FROM users WHERE email = ? AND id != ?", [email, currentUser.id]);
    if (dup.length > 0 && dup[0].values.length > 0) {
        errEl.textContent = 'Este e-mail já está em uso.'; errEl.classList.add('show'); return;
    }

    if (pw) {
        if (pw.length < 4) { errEl.textContent = 'A nova senha deve ter no mínimo 4 caracteres.'; errEl.classList.add('show'); return; }
        const hash = await hashPassword(pw);
        db.run("UPDATE users SET name = ?, email = ?, password_hash = ? WHERE id = ?", [name, email, hash, currentUser.id]);
    } else {
        db.run("UPDATE users SET name = ?, email = ? WHERE id = ?", [name, email, currentUser.id]);
    }
    await saveDBToIDB();

    currentUser.name = name;
    currentUser.email = email;
    sessionStorage.setItem('taskflow_user', JSON.stringify(currentUser));
    updateUserUI();
    closeProfileModal();
}

function updateUserUI() {
    document.getElementById('userAvatar').textContent = currentUser.name.charAt(0).toUpperCase();
    document.getElementById('userNameLabel').textContent = currentUser.name;
    document.getElementById('userDropdownName').textContent = currentUser.name;
    document.getElementById('userDropdownEmail').textContent = currentUser.email;
}

// ─── SHOW APP ───
function showApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'block';
    updateUserUI();
    loadTasksFromDB();
    ganttStartDate = getGanttDefaultStart();
    render();
}

// ─── TASK DB OPERATIONS ───
function loadTasksFromDB() {
    tasks = [];
    const res = db.exec("SELECT id, title, description, status, start_date, end_date FROM tasks WHERE user_id = ?", [currentUser.id]);
    if (res.length > 0) {
        for (const row of res[0].values) {
            tasks.push({ id: row[0], title: row[1], description: row[2], status: row[3], startDate: row[4], endDate: row[5] });
        }
    }
}

async function saveTaskToDB(t) {
    db.run("INSERT OR REPLACE INTO tasks (id, user_id, title, description, status, start_date, end_date) VALUES (?,?,?,?,?,?,?)",
        [t.id, currentUser.id, t.title, t.description, t.status, t.startDate, t.endDate]);
    await saveDBToIDB();
}

async function deleteTaskFromDB(id) {
    db.run("DELETE FROM tasks WHERE id = ? AND user_id = ?", [id, currentUser.id]);
    await saveDBToIDB();
}

async function saveAllTasksToDB() {
    // Batch save all current tasks
    for (const t of tasks) {
        db.run("INSERT OR REPLACE INTO tasks (id, user_id, title, description, status, start_date, end_date) VALUES (?,?,?,?,?,?,?)",
            [t.id, currentUser.id, t.title, t.description, t.status, t.startDate, t.endDate]);
    }
    await saveDBToIDB();
}

// ─── COMPATIBILITY WRAPPERS ───
function saveToStorage() { saveAllTasksToDB(); }

function genId() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5); }

// ─── RENDER ───
function render() {
    autoUpdateStatuses();
    renderTable();
    renderGantt();
}

function autoUpdateStatuses() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let changed = false;
    tasks.forEach(t => {
        if (t.status === 'Completed') return;
        const endDate = new Date(t.endDate + 'T00:00:00');
        const startDate = new Date(t.startDate + 'T00:00:00');
        if (today > endDate && t.status !== 'Overdue') { t.status = 'Overdue'; changed = true; }
        else if (t.status === 'To Do' && today >= startDate && today <= endDate) { t.status = 'In Progress'; changed = true; }
    });
    if (changed) saveToStorage();
}

function getFilteredTasks() {
    return tasks.filter(t => {
        const matchFilter = activeFilters.size === 0 || activeFilters.has(t.status);
        const matchSearch = !searchQuery || t.title.toLowerCase().includes(searchQuery.toLowerCase()) || t.description.toLowerCase().includes(searchQuery.toLowerCase());
        return matchFilter && matchSearch;
    }).sort((a, b) => {
        if (a.endDate < b.endDate) return -1; if (a.endDate > b.endDate) return 1;
        if (a.startDate < b.startDate) return -1; if (a.startDate > b.startDate) return 1;
        return 0;
    });
}

function statusClass(s) { return { 'Completed': 'status-completed', 'In Progress': 'status-inprogress', 'To Do': 'status-todo', 'Overdue': 'status-overdue' }[s] || 'status-todo'; }
function statusKey(s) { return { 'Completed': 'completed', 'In Progress': 'inprogress', 'To Do': 'todo', 'Overdue': 'overdue' }[s] || 'todo'; }
function formatDate(d) { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; }

function renderTable() {
    const filtered = getFilteredTasks();
    const tbody = document.getElementById('taskTableBody');
    const empty = document.getElementById('emptyState');
    if (filtered.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    tbody.innerHTML = filtered.map(t => `
    <tr>
      <td class="task-title-cell">${esc(t.title)}</td>
      <td class="task-desc-cell" title="${esc(t.description)}">${esc(t.description)}</td>
      <td><span class="status-badge ${statusClass(t.status)}" onclick="toggleStatusDropdown(event, '${t.id}')"><span class="dot"></span>${t.status}</span></td>
      <td class="date-cell">${formatDate(t.startDate)}</td>
      <td class="date-cell">${formatDate(t.endDate)}</td>
      <td><div class="action-btns">
        <button class="icon-btn" onclick="editTask('${t.id}')" title="Editar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="icon-btn delete" onclick="deleteTask('${t.id}')" title="Excluir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
      </div></td>
    </tr>`).join('');
}

// ─── GANTT ───
function getGanttDefaultStart() { const d = new Date(); d.setDate(d.getDate() - 7); d.setHours(0, 0, 0, 0); return d; }
function ganttPrev() { ganttStartDate.setDate(ganttStartDate.getDate() - 7); renderGantt(); }
function ganttNext() { ganttStartDate.setDate(ganttStartDate.getDate() + 7); renderGantt(); }
function ganttToday() { ganttStartDate = getGanttDefaultStart(); renderGantt(); }

function renderGantt() {
    const filtered = getFilteredTasks();
    const container = document.getElementById('ganttContent');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = 0; i < GANTT_DAYS; i++) { const d = new Date(ganttStartDate); d.setDate(d.getDate() + i); days.push(d); }
    const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    document.getElementById('ganttNavLabel').textContent = `${days[0].getDate()} ${months[days[0].getMonth()]} — ${days[days.length - 1].getDate()} ${months[days[days.length - 1].getMonth()]} ${days[days.length - 1].getFullYear()}`;

    let headerHTML = `<div class="gantt-header"><div class="gantt-label-col">Tarefa</div><div class="gantt-timeline">`;
    days.forEach(d => {
        headerHTML += `<div class="gantt-day ${d.getTime() === today.getTime() ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}"><span class="day-name">${dayNames[d.getDay()]}</span><span class="day-num">${d.getDate()}</span></div>`;
    });
    headerHTML += `</div></div>`;

    let rowsHTML = '';
    if (filtered.length === 0) {
        rowsHTML = `<div class="empty-state" style="padding:40px"><h3>Nenhuma tarefa para exibir</h3></div>`;
    } else {
        filtered.forEach(t => {
            const sk = statusKey(t.status);
            const tStart = new Date(t.startDate + 'T00:00:00'), tEnd = new Date(t.endDate + 'T00:00:00');
            const ganttStart = ganttStartDate.getTime();
            const dayWidth = 100 / GANTT_DAYS;
            const startOffset = (tStart.getTime() - ganttStart) / (1000 * 60 * 60 * 24);
            const duration = (tEnd.getTime() - tStart.getTime()) / (1000 * 60 * 60 * 24) + 1;
            const barLeft = startOffset * dayWidth, barWidth = duration * dayWidth;
            const barVisible = (startOffset + duration > 0) && (startOffset < GANTT_DAYS);

            rowsHTML += `<div class="gantt-row"><div class="gantt-row-label"><span class="dot" style="width:8px;height:8px;border-radius:50%;background:var(--${sk});flex-shrink:0"></span><span class="task-name" title="${esc(t.title)}">${esc(t.title)}</span></div><div class="gantt-row-timeline">`;
            days.forEach(d => { rowsHTML += `<div class="gantt-cell ${d.getTime() === today.getTime() ? 'today' : ''} ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}"></div>`; });

            if (barVisible) {
                const cL = Math.max(barLeft, 0), cR = Math.min(barLeft + barWidth, 100), cW = cR - cL;
                if (cW > 0) {
                    rowsHTML += `<div class="gantt-bar ${sk}" style="left:${cL}%;width:${cW}%;" data-task-id="${t.id}" onmouseenter="showTooltip(event,'${t.id}')" onmouseleave="hideTooltip()">
            <div class="gantt-handle gantt-handle-left" data-handle="left" data-task-id="${t.id}"></div>
            <span class="bar-label">${esc(t.title)}</span>
            <div class="gantt-handle gantt-handle-right" data-handle="right" data-task-id="${t.id}"></div></div>`;
                }
            }
            const todayOffset = (today.getTime() - ganttStart) / (1000 * 60 * 60 * 24);
            if (todayOffset >= 0 && todayOffset < GANTT_DAYS) rowsHTML += `<div class="gantt-today-line" style="left:${todayOffset * dayWidth}%"></div>`;
            rowsHTML += `</div></div>`;
        });
    }
    container.innerHTML = headerHTML + rowsHTML;
}

// ─── TOOLTIP ───
function showTooltip(e, id) {
    if (dragState.active) return;
    const t = tasks.find(tk => tk.id === id); if (!t) return;
    const tt = document.getElementById('ganttTooltip');
    document.getElementById('ttTitle').textContent = t.title;
    document.getElementById('ttDesc').textContent = t.description || 'Sem descrição';
    document.getElementById('ttDates').textContent = `${formatDate(t.startDate)} → ${formatDate(t.endDate)} · ${t.status}`;
    tt.classList.add('show'); positionTooltip(e);
}
function hideTooltip() { document.getElementById('ganttTooltip').classList.remove('show'); }
document.addEventListener('mousemove', e => { const tt = document.getElementById('ganttTooltip'); if (tt.classList.contains('show') && !dragState.active) positionTooltip(e); });
function positionTooltip(e) { const tt = document.getElementById('ganttTooltip'); tt.style.left = (e.clientX + 12) + 'px'; tt.style.top = (e.clientY - 10) + 'px'; }

// ─── GANTT DRAG ───
const dragState = { active: false, type: null, taskId: null, startX: 0, origStartDate: null, origEndDate: null, timelineEl: null, pxPerDay: 0, barEl: null };
function getTimelineMetrics(barEl) { const tl = barEl.closest('.gantt-row-timeline'); if (!tl) return null; const r = tl.getBoundingClientRect(); return { timeline: tl, rect: r, pxPerDay: r.width / GANTT_DAYS }; }
function pxToDateOffset(px) { return Math.round(px / dragState.pxPerDay); }
function addDaysToDateStr(ds, days) { const d = new Date(ds + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().split('T')[0]; }
function updateDragIndicator(e, ds) { const ind = document.getElementById('dragDateIndicator'); ind.textContent = formatDate(ds); ind.style.left = (e.clientX + 14) + 'px'; ind.style.top = (e.clientY - 32) + 'px'; ind.classList.add('show'); }
function hideDragIndicator() { document.getElementById('dragDateIndicator').classList.remove('show'); }

document.addEventListener('mousedown', e => {
    const handle = e.target.closest('.gantt-handle'), bar = e.target.closest('.gantt-bar');
    if (!handle && !bar) return;
    const taskId = handle ? handle.dataset.taskId : bar.dataset.taskId; if (!taskId) return;
    const task = tasks.find(t => t.id === taskId); if (!task) return;
    const targetBar = handle ? handle.closest('.gantt-bar') : bar;
    const metrics = getTimelineMetrics(targetBar); if (!metrics) return;
    e.preventDefault(); hideTooltip();
    dragState.active = true; dragState.taskId = taskId; dragState.startX = e.clientX;
    dragState.origStartDate = task.startDate; dragState.origEndDate = task.endDate;
    dragState.timelineEl = metrics.timeline; dragState.pxPerDay = metrics.pxPerDay; dragState.barEl = targetBar;
    dragState.type = handle ? handle.dataset.handle : 'move';
    if (handle) handle.classList.add('dragging');
    targetBar.classList.add('dragging');
    document.body.style.cursor = dragState.type === 'move' ? 'grabbing' : 'ew-resize';
    document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
    if (!dragState.active) return;
    const dx = e.clientX - dragState.startX, daysDelta = pxToDateOffset(dx);
    const task = tasks.find(t => t.id === dragState.taskId); if (!task) return;
    const dayWidth = 100 / GANTT_DAYS;
    if (dragState.type === 'left') { let ns = addDaysToDateStr(dragState.origStartDate, daysDelta); if (ns > dragState.origEndDate) ns = dragState.origEndDate; task.startDate = ns; updateDragIndicator(e, ns); }
    else if (dragState.type === 'right') { let ne = addDaysToDateStr(dragState.origEndDate, daysDelta); if (ne < dragState.origStartDate) ne = dragState.origStartDate; task.endDate = ne; updateDragIndicator(e, ne); }
    else { const ns = addDaysToDateStr(dragState.origStartDate, daysDelta), ne = addDaysToDateStr(dragState.origEndDate, daysDelta); task.startDate = ns; task.endDate = ne; const ind = document.getElementById('dragDateIndicator'); ind.textContent = `${formatDate(ns)} → ${formatDate(ne)}`; ind.style.left = (e.clientX + 14) + 'px'; ind.style.top = (e.clientY - 32) + 'px'; ind.classList.add('show'); }
    const tS = new Date(task.startDate + 'T00:00:00'), tE = new Date(task.endDate + 'T00:00:00');
    const so = (tS.getTime() - ganttStartDate.getTime()) / (1000 * 60 * 60 * 24), dur = (tE.getTime() - tS.getTime()) / (1000 * 60 * 60 * 24) + 1;
    const bL = so * dayWidth, bW = dur * dayWidth, cL = Math.max(bL, 0), cR = Math.min(bL + bW, 100), cW = Math.max(cR - cL, dayWidth * 0.5);
    dragState.barEl.style.left = cL + '%'; dragState.barEl.style.width = cW + '%';
});

document.addEventListener('mouseup', e => {
    if (!dragState.active) return;
    dragState.barEl.classList.remove('dragging');
    document.querySelectorAll('.gantt-handle.dragging').forEach(h => h.classList.remove('dragging'));
    document.body.style.cursor = ''; document.body.style.userSelect = ''; hideDragIndicator();
    const dx = Math.abs(e.clientX - dragState.startX);
    if (dx < 3 && dragState.type === 'move') { const task = tasks.find(t => t.id === dragState.taskId); if (task) { task.startDate = dragState.origStartDate; task.endDate = dragState.origEndDate; } dragState.active = false; editTask(dragState.taskId); return; }
    saveToStorage(); dragState.active = false; render();
});

// ─── FILTERS & SEARCH ───
function toggleFilter(filter, btn) {
    const allBtn = document.querySelector('.filter-btn[data-filter="all"]');
    const statusBtns = document.querySelectorAll('.filter-btn:not([data-filter="all"])');
    if (filter === 'all') { activeFilters.clear(); statusBtns.forEach(b => b.classList.remove('active')); allBtn.classList.add('active'); }
    else { allBtn.classList.remove('active'); if (activeFilters.has(filter)) { activeFilters.delete(filter); btn.classList.remove('active'); } else { activeFilters.add(filter); btn.classList.add('active'); } if (activeFilters.size === 0) allBtn.classList.add('active'); if (activeFilters.size === 4) { activeFilters.clear(); statusBtns.forEach(b => b.classList.remove('active')); allBtn.classList.add('active'); } }
    render();
}
function searchTasks(q) { searchQuery = q; render(); }

// ─── VIEW SWITCH ───
function switchView(view, btn) {
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    document.getElementById('tableView').style.display = view === 'table' ? 'block' : 'none';
    document.getElementById('ganttView').style.display = view === 'gantt' ? 'block' : 'none';
    if (view === 'gantt') renderGantt();
}

// ─── TASK MODAL ───
function openModal(taskId) {
    editingId = taskId || null;
    const modal = document.getElementById('taskModal'); modal.classList.add('show');
    if (editingId) {
        const t = tasks.find(tk => tk.id === editingId);
        document.getElementById('modalTitle').textContent = 'Editar Tarefa';
        document.getElementById('saveBtn').textContent = 'Salvar Alterações';
        document.getElementById('taskTitle').value = t.title; document.getElementById('taskDesc').value = t.description;
        document.getElementById('taskStatus').value = t.status; document.getElementById('taskStart').value = t.startDate; document.getElementById('taskEnd').value = t.endDate;
    } else {
        document.getElementById('modalTitle').textContent = 'Nova Tarefa'; document.getElementById('saveBtn').textContent = 'Criar Tarefa';
        document.getElementById('taskTitle').value = ''; document.getElementById('taskDesc').value = ''; document.getElementById('taskStatus').value = 'To Do';
        const td = new Date().toISOString().split('T')[0]; document.getElementById('taskStart').value = td; document.getElementById('taskEnd').value = td;
    }
    setTimeout(() => document.getElementById('taskTitle').focus(), 100);
}
function closeModal() { document.getElementById('taskModal').classList.remove('show'); editingId = null; }

function saveTask() {
    const title = document.getElementById('taskTitle').value.trim(), desc = document.getElementById('taskDesc').value.trim();
    const status = document.getElementById('taskStatus').value, startDate = document.getElementById('taskStart').value, endDate = document.getElementById('taskEnd').value;
    if (!title) { document.getElementById('taskTitle').focus(); return; } if (!startDate || !endDate) return;
    if (endDate < startDate) { alert('A data de término deve ser igual ou posterior à data de início.'); return; }
    if (editingId) { const t = tasks.find(tk => tk.id === editingId); t.title = title; t.description = desc; t.status = status; t.startDate = startDate; t.endDate = endDate; }
    else { tasks.push({ id: genId(), title, description: desc, status, startDate, endDate }); }
    saveToStorage(); closeModal(); render();
}
function editTask(id) { openModal(id); }
function deleteTask(id) { if (!confirm('Tem certeza que deseja excluir esta tarefa?')) return; tasks = tasks.filter(t => t.id !== id); deleteTaskFromDB(id); render(); }

// ─── STATUS DROPDOWN ───
function toggleStatusDropdown(e, id) { e.stopPropagation(); statusChangeId = id; const dd = document.getElementById('statusDropdown'); const rect = e.target.closest('.status-badge').getBoundingClientRect(); dd.style.top = (rect.bottom + 4) + 'px'; dd.style.left = rect.left + 'px'; dd.classList.toggle('show'); }
function changeStatus(ns) { if (statusChangeId) { const t = tasks.find(tk => tk.id === statusChangeId); if (t) { t.status = ns; saveToStorage(); render(); } } document.getElementById('statusDropdown').classList.remove('show'); statusChangeId = null; }
document.addEventListener('click', () => { document.getElementById('statusDropdown').classList.remove('show'); closeUserDropdown(); });

// ─── SYNC MODAL ───
let syncImportMode = 'merge';
function openSyncModal(tab) { document.getElementById('syncModal').classList.add('show'); switchSyncTab(tab || 'export'); if (tab === 'export') generateSyncExport(); }
function closeSyncModal() { document.getElementById('syncModal').classList.remove('show'); document.getElementById('syncExportText').value = ''; document.getElementById('syncImportText').value = ''; hideSyncStatus('syncExportStatus'); hideSyncStatus('syncImportStatus'); }
function switchSyncTab(tab) { ['export', 'import'].forEach(t => { document.getElementById('syncTab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === tab); document.getElementById('syncPanel' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('active', t === tab); }); document.getElementById('syncImportBtn').style.display = (tab === 'import') ? '' : 'none'; }
function setImportMode(m) { syncImportMode = m; document.getElementById('importModeMerge').classList.toggle('active', m === 'merge'); document.getElementById('importModeReplace').classList.toggle('active', m === 'replace'); }
function triggerFileImport() { document.getElementById('csvInput').click(); }
function showSyncStatus(id, msg, type) { const el = document.getElementById(id); el.textContent = msg; el.className = 'sync-status ' + type; }
function hideSyncStatus(id) { document.getElementById(id).className = 'sync-status'; }
function generateSyncExport() { const text = JSON.stringify(tasks, null, 2); document.getElementById('syncExportText').value = text; showSyncStatus('syncExportStatus', `${tasks.length} tarefa(s) gerada(s) em JSON.`, 'info'); }
function copySyncExport() { const ta = document.getElementById('syncExportText'); if (!ta.value) generateSyncExport(); navigator.clipboard.writeText(ta.value).then(() => { showSyncStatus('syncExportStatus', '✓ JSON copiado!', 'success'); }).catch(() => { ta.select(); document.execCommand('copy'); showSyncStatus('syncExportStatus', '✓ JSON copiado!', 'success'); }); }
function downloadSyncExport() { if (!document.getElementById('syncExportText').value) generateSyncExport(); const text = document.getElementById('syncExportText').value; const blob = new Blob([text], { type: 'application/json;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `taskflow_${new Date().toISOString().split('T')[0]}.json`; a.click(); URL.revokeObjectURL(url); showSyncStatus('syncExportStatus', '✓ Arquivo JSON baixado!', 'success'); }

function parseImportedJSON(text) {
    const parsed = JSON.parse(text); if (!Array.isArray(parsed)) throw new Error('JSON deve ser um array.');
    const vs = ['Completed', 'In Progress', 'To Do', 'Overdue'];
    return parsed.map(t => ({ id: t.id || genId(), title: String(t.title || '').trim(), description: String(t.description || '').trim(), status: vs.includes(t.status) ? t.status : 'To Do', startDate: t.startDate || new Date().toISOString().split('T')[0], endDate: t.endDate || new Date().toISOString().split('T')[0] })).filter(t => t.title);
}
function mergeTaskLists(incoming) {
    let added = 0, updated = 0;
    const byTitle = new Map(tasks.map(t => [t.title.toLowerCase(), t]));
    for (const inc of incoming) { const key = inc.title.toLowerCase(); if (byTitle.has(key)) { const ex = byTitle.get(key); if (ex.status !== inc.status || ex.startDate !== inc.startDate || ex.endDate !== inc.endDate) { ex.status = inc.status; ex.startDate = inc.startDate; ex.endDate = inc.endDate; if (!ex.description && inc.description) ex.description = inc.description; updated++; } } else { tasks.push({ ...inc, id: genId() }); added++; } }
    return { added, updated };
}
function executeSyncImport() {
    const text = document.getElementById('syncImportText').value.trim();
    if (!text) { showSyncStatus('syncImportStatus', 'Cole o JSON antes de importar.', 'error'); return; }
    try {
        const incoming = parseImportedJSON(text); if (incoming.length === 0) throw new Error('Nenhuma tarefa válida.');
        if (syncImportMode === 'replace') {
            // Delete all existing tasks for this user
            db.run("DELETE FROM tasks WHERE user_id = ?", [currentUser.id]);
            tasks = incoming.map(t => ({ ...t, id: genId() }));
            saveToStorage(); render();
            showSyncStatus('syncImportStatus', `✓ ${tasks.length} tarefa(s) importada(s) (substituição).`, 'success');
        } else {
            const { added, updated } = mergeTaskLists(incoming); saveToStorage(); render();
            const parts = []; if (added) parts.push(`${added} adicionada(s)`); if (updated) parts.push(`${updated} atualizada(s)`);
            const unch = incoming.length - added - updated; if (unch) parts.push(`${unch} sem alteração`);
            showSyncStatus('syncImportStatus', `✓ Mesclagem: ${parts.join(', ')}.`, 'success');
        }
    } catch (err) { showSyncStatus('syncImportStatus', '✗ Erro: ' + err.message, 'error'); }
}

function importFileJSON(event) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) { document.getElementById('syncImportText').value = e.target.result; hideSyncStatus('syncImportStatus'); if (document.getElementById('syncModal').classList.contains('show')) { switchSyncTab('import'); } else { openSyncModal('import'); } showSyncStatus('syncImportStatus', `Arquivo "${file.name}" carregado.`, 'info'); };
    reader.readAsText(file); event.target.value = '';
}

// ─── KEYBOARD ───
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); closeSyncModal(); closeProfileModal(); }
    if (e.key === 'Enter') {
        if (document.getElementById('taskModal').classList.contains('show') && document.activeElement.tagName !== 'TEXTAREA') saveTask();
        if (document.getElementById('loginForm').classList.contains('active') && document.getElementById('authScreen').style.display !== 'none') doLogin();
        if (document.getElementById('registerForm').classList.contains('active') && document.getElementById('authScreen').style.display !== 'none') doRegister();
    }
});

// ─── UTILS ───
function esc(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

// ─── STARTUP ───
(async function () {
    try {
        await initDatabase();
        document.getElementById('loadingScreen').style.display = 'none';

        // Check session
        const saved = sessionStorage.getItem('taskflow_user');
        if (saved) {
            try {
                currentUser = JSON.parse(saved);
                // Verify user still exists
                const res = db.exec("SELECT id, name, email FROM users WHERE id = ?", [currentUser.id]);
                if (res.length > 0 && res[0].values.length > 0) {
                    currentUser = { id: res[0].values[0][0], name: res[0].values[0][1], email: res[0].values[0][2] };
                    showApp();
                    return;
                }
            } catch (e) { }
        }

        // Show auth screen
        document.getElementById('authScreen').style.display = 'flex';
    } catch (err) {
        document.getElementById('loadingScreen').innerHTML = `<div style="color:var(--overdue)">Erro ao carregar banco de dados:<br>${err.message}</div>`;
    }
})();
