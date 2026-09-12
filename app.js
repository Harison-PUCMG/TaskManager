// ─── DATABASE & STATE ───
let db = null;
let currentUser = null;
let tasks = [];
let tombstones = [];
let logBaseline = new Map();
let logBaselineReady = false;
// Ao abrir, o app mostra o trabalho vivo: Em andamento, A fazer e Atrasadas.
// "Concluídas" fica desmarcada — quem quiser vê-las clica no filtro (ou em "Todas").
const DEFAULT_FILTERS = ['In Progress', 'To Do', 'Overdue'];
let activeFilters = new Set(DEFAULT_FILTERS);
let searchQuery = '';
let statusChangeId = null;
let gistDataLoaded = false;
let ganttStartDate = null;
const GANTT_DAYS = 28;
const DB_NAME = 'taskflow_db';
const DB_STORE = 'sqlitedb';

// ─── TIMEZONE UTILITIES (GMT-3 / São Paulo) ───
const TZ_OFFSET_MS = -3 * 60 * 60 * 1000;

function todayStrGMT3() {
    const d = new Date(Date.now() + TZ_OFFSET_MS);
    return d.toISOString().slice(0, 10);
}

function nowISOGMT3() {
    const local = new Date(Date.now() + TZ_OFFSET_MS);
    return local.toISOString().slice(0, -1) + '-03:00';
}

function dateFromStrGMT3(dateStr) {
    return new Date(dateStr + 'T00:00:00-03:00');
}

function todayGMT3() {
    return dateFromStrGMT3(todayStrGMT3());
}

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

// ─── LOCAL TASK PERSISTENCE (durable cache — survives reload even if Gist is offline) ───
async function saveLocalState(source = 'sync') {
    if (!db || !currentUser) return;
    logChanges(source);
    const payload = JSON.stringify({ tasks, tombstones });
    db.run("INSERT OR REPLACE INTO task_store (user_id, data) VALUES (?, ?)", [currentUser.id, payload]);
    await saveDBToIDB();
}

// ─── TASK CHANGE LOG (audit journal so data lost to a bad reconciliation is recoverable) ───
function taskSnapshot(t) {
    return { id: t.id, title: t.title, description: t.description, status: t.status, startDate: t.startDate, endDate: t.endDate, order: orderValue(t.order), createdAt: t.createdAt, modifiedAt: t.modifiedAt };
}
function serializeForLog(t) { return JSON.stringify(taskSnapshot(t)); }
function initLogBaseline() {
    logBaseline = new Map(tasks.map(t => [t.id, serializeForLog(t)]));
    logBaselineReady = true;
}
function appendTaskLog(op, snap, source) {
    db.run("INSERT INTO task_log (user_id, ts, op, source, task_id, title, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [currentUser.id, nowISOGMT3(), op, source || 'sync', snap.id || '', snap.title || '', JSON.stringify(snap)]);
}
// Diff the current task list against the last journaled baseline and record every
// create / update / delete. Lives inside saveLocalState, so it captures BOTH user
// edits and reconcile/sync-driven changes — including catastrophic removals, where
// the deleted task's full snapshot is preserved for recovery.
function logChanges(source) {
    if (!db || !currentUser) return;
    const current = new Map(tasks.map(t => [t.id, serializeForLog(t)]));
    if (!logBaselineReady) { logBaseline = current; logBaselineReady = true; return; }
    for (const t of tasks) {
        const prev = logBaseline.get(t.id);
        if (prev === undefined) appendTaskLog('create', taskSnapshot(t), source);
        else if (prev !== current.get(t.id)) appendTaskLog('update', taskSnapshot(t), source);
    }
    for (const [id, prevSer] of logBaseline) {
        if (current.has(id)) continue;
        let snap; try { snap = JSON.parse(prevSer); } catch (e) { snap = { id }; }
        appendTaskLog('delete', snap, source);
    }
    logBaseline = current;
}
function pruneTaskLog() {
    if (!db || !currentUser) return;
    try {
        db.run("DELETE FROM task_log WHERE user_id = ? AND log_id NOT IN (SELECT log_id FROM task_log WHERE user_id = ? ORDER BY log_id DESC LIMIT 2000)", [currentUser.id, currentUser.id]);
    } catch (e) { console.warn('pruneTaskLog failed:', e.message); }
}
function safeParseLog(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function getTaskLogRows() {
    if (!db || !currentUser) return [];
    const res = db.exec("SELECT ts, op, source, task_id, title, snapshot FROM task_log WHERE user_id = ? ORDER BY log_id DESC", [currentUser.id]);
    if (!res.length || !res[0].values) return [];
    return res[0].values.map(v => ({ ts: v[0], op: v[1], source: v[2], taskId: v[3], title: v[4], task: safeParseLog(v[5]) }));
}
function downloadTaskLog() {
    const rows = getTaskLogRows();
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `taskflow_log_${todayStrGMT3()}.json`; a.click(); URL.revokeObjectURL(url);
    if (document.getElementById('syncExportStatus')) showSyncStatus('syncExportStatus', `✓ Log baixado (${rows.length} registro(s)).`, 'success');
}
// Console recovery helpers (open DevTools → Console):
//   listDeletedInLog()              → lista tarefas cujo último evento foi exclusão
//   recoverTaskFromLog('task_xxx')  → restaura uma tarefa excluída a partir do log
function listDeletedInLog() {
    if (!db || !currentUser) return [];
    const res = db.exec("SELECT op, task_id, snapshot FROM task_log WHERE user_id = ? ORDER BY log_id ASC", [currentUser.id]);
    const rows = (res.length && res[0].values) ? res[0].values : [];
    const latest = new Map();
    for (const [op, taskId, snapshot] of rows) latest.set(taskId, { op, snapshot });
    const present = new Set(tasks.map(t => t.id));
    const out = [];
    for (const [taskId, info] of latest) {
        if (info.op === 'delete' && !present.has(taskId)) { const s = safeParseLog(info.snapshot); if (s && s.title) out.push(s); }
    }
    try { console.table(out.map(s => ({ id: s.id, title: s.title, status: s.status, endDate: s.endDate, modifiedAt: s.modifiedAt }))); } catch (e) { console.log(out); }
    return out;
}
function recoverTaskFromLog(taskId) {
    if (!db || !currentUser) return null;
    const res = db.exec("SELECT snapshot FROM task_log WHERE user_id = ? AND task_id = ? ORDER BY log_id DESC LIMIT 1", [currentUser.id, taskId]);
    if (!res.length || !res[0].values.length) { console.warn('Nenhum registro de log para', taskId); return null; }
    const snap = safeParseLog(res[0].values[0][0]);
    if (!snap || !snap.title) { console.warn('Snapshot inválido para', taskId); return null; }
    const restored = { ...snap, id: genId(), modifiedAt: nowISOGMT3() };
    tasks.push(restored);
    // clear any tombstone for this task so the restore survives the next sync
    tombstones = tombstones.filter(tb => tb.id !== snap.id && (tb.title || '').toLowerCase() !== (snap.title || '').toLowerCase());
    saveToStorage(); render();
    console.log('Recuperada:', restored.title);
    return restored;
}

function loadLocalState() {
    if (!db || !currentUser) return { tasks: [], tombstones: [] };
    try {
        const res = db.exec("SELECT data FROM task_store WHERE user_id = ?", [currentUser.id]);
        if (res.length > 0 && res[0].values.length > 0) {
            const parsed = JSON.parse(res[0].values[0][0] || '{}');
            return {
                tasks: Array.isArray(parsed.tasks) ? normalizeTasks(parsed.tasks) : [],
                tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.filter(t => t && t.id && t.deletedAt) : []
            };
        }
    } catch (e) { console.warn('loadLocalState failed:', e.message); }
    return { tasks: [], tombstones: [] };
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
    db.run(`CREATE TABLE IF NOT EXISTS gist_config (
    user_id INTEGER PRIMARY KEY,
    gist_token TEXT NOT NULL,
    gist_id TEXT NOT NULL,
    auto_sync INTEGER DEFAULT 0,
    last_sync TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS task_store (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
    db.run(`CREATE TABLE IF NOT EXISTS task_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ts TEXT NOT NULL,
    op TEXT NOT NULL,
    source TEXT,
    task_id TEXT,
    title TEXT,
    snapshot TEXT
  )`);
    await saveDBToIDB();
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
    stopGistPolling();
    gistDataLoaded = false;
    currentUser = null;
    tasks = [];
    tombstones = [];
    logBaseline = new Map();
    logBaselineReady = false;
    activeFilters = new Set(DEFAULT_FILTERS);
    searchQuery = '';
    const searchEl = document.getElementById('searchInput');
    if (searchEl) searchEl.value = '';
    syncFilterButtons();
    hideActionToast();
    sessionStorage.removeItem('taskflow_user');
    closeUserDropdown();
    document.getElementById('appContainer').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('loginEmail').value = '';
    document.getElementById('loginPassword').value = '';
}

async function doDeleteAccount() {
    if (!confirm('Tem certeza que deseja excluir sua conta? Todas as suas tarefas serão perdidas.')) return;
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

// ─── TEMA (escuro / claro) E PALETA DE COR ───
// As duas preferências vivem no localStorage (e não no banco) porque a tela de
// login, anterior a qualquer usuário, também precisa delas. O <head> as aplica
// antes da primeira pintura; aqui só garantimos os atributos e a interface.
// Modo e paleta são independentes: cada paleta existe em claro e em escuro.
const THEME_KEY = 'taskflow_theme';
const PALETTE_KEY = 'taskflow_palette';
const INTENSITY_KEY = 'taskflow_intensity';

// Os tons de cada paleta ficam no CSS (blocos [data-palette] e .pal-*); aqui
// só o que a interface precisa nomear. Uma paleta nova custa uma linha nesta
// lista, um bloco por modo no CSS e o mesmo id nos dois lugares — e o filtro
// do <head>, que barra valores inventados antes de o app.js carregar.
const PALETTES = [
    { id: 'indigo', name: 'Índigo' },
    { id: 'teal', name: 'Teal' },
    { id: 'amber', name: 'Âmbar' },
    { id: 'rose', name: 'Rosa' },
    { id: 'slate', name: 'Grafite' }
];
const DEFAULT_PALETTE = 'indigo';

function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }

function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { }
    updateThemeButtons();
}

function toggleTheme() { applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); }

function updateThemeButtons() {
    const label = 'Mudar para o tema ' + (currentTheme() === 'light' ? 'escuro' : 'claro');
    document.querySelectorAll('.theme-toggle').forEach(b => { b.title = label; b.setAttribute('aria-label', label); });
}

function isPalette(id) { return PALETTES.some(p => p.id === id); }

function currentPalette() {
    const p = document.documentElement.getAttribute('data-palette');
    return isPalette(p) ? p : DEFAULT_PALETTE;
}

function applyPalette(id) {
    const p = isPalette(id) ? id : DEFAULT_PALETTE;
    document.documentElement.setAttribute('data-palette', p);
    try { localStorage.setItem(PALETTE_KEY, p); } catch (e) { }
    updatePaletteButtons();
    closePaletteMenus();
}

// Intensidade da tintura do fundo: 1 é a mais fraca (padrão), 5 a mais forte.
// Os tons ficam no CSS (blocos [data-intensity]); aqui só os limites do slider.
const INTENSITY_MIN = 1, INTENSITY_MAX = 5, DEFAULT_INTENSITY = 1;

function currentIntensity() {
    const n = parseInt(document.documentElement.getAttribute('data-intensity'), 10);
    return (n >= INTENSITY_MIN && n <= INTENSITY_MAX) ? n : DEFAULT_INTENSITY;
}

function applyIntensity(value) {
    let n = parseInt(value, 10);
    if (!(n >= INTENSITY_MIN && n <= INTENSITY_MAX)) n = DEFAULT_INTENSITY;
    document.documentElement.setAttribute('data-intensity', String(n));
    try { localStorage.setItem(INTENSITY_KEY, String(n)); } catch (e) { }
    updateIntensityControls();
}

// Os dois menus compartilham o mesmo valor, então um slider espelha o outro.
function updateIntensityControls() {
    const n = currentIntensity();
    document.querySelectorAll('.palette-range').forEach(r => { if (r.value !== String(n)) r.value = n; });
    document.querySelectorAll('.palette-intensity-val').forEach(v => { v.textContent = n; });
}

// O mostruário aparece em dois lugares (cabeçalho do app e tela de login), daí
// montá-lo por código em vez de repetir cinco botões no HTML duas vezes.
function renderPaletteMenus() {
    const check = '<span class="palette-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
    const html = PALETTES.map(p =>
        `<button class="palette-swatch pal-${p.id}" type="button" role="menuitemradio" aria-checked="false" data-palette="${p.id}" onclick="applyPalette('${p.id}')">` +
        `<span class="palette-dot"></span><span>${p.name}</span>${check}</button>`
    ).join('');
    document.querySelectorAll('.palette-grid').forEach(g => { g.innerHTML = html; });

    const slider = '<div class="palette-divider"></div>' +
        '<label class="palette-intensity-row" onclick="event.stopPropagation()">' +
        '<span class="palette-intensity-label">Intensidade <b class="palette-intensity-val">1</b></span>' +
        `<input type="range" class="palette-range" min="${INTENSITY_MIN}" max="${INTENSITY_MAX}" step="1"` +
        ' oninput="applyIntensity(this.value)" aria-label="Intensidade da cor de fundo"></label>';
    document.querySelectorAll('.palette-intensity').forEach(c => { c.innerHTML = slider; });

    updatePaletteButtons();
    updateIntensityControls();
}

function updatePaletteButtons() {
    const active = currentPalette();
    const name = (PALETTES.find(p => p.id === active) || PALETTES[0]).name;
    document.querySelectorAll('.palette-swatch').forEach(b => {
        b.setAttribute('aria-checked', String(b.dataset.palette === active));
    });
    document.querySelectorAll('.palette-btn').forEach(b => { b.title = 'Cor do tema: ' + name; });
}

function togglePaletteMenu(e) {
    e.stopPropagation();
    const wrapper = e.currentTarget.closest('.palette-wrapper');
    const open = !wrapper.classList.contains('show');
    closePaletteMenus();
    if (open) {
        wrapper.classList.add('show');
        wrapper.querySelector('.palette-btn').setAttribute('aria-expanded', 'true');
    }
}

function closePaletteMenus() {
    document.querySelectorAll('.palette-wrapper.show').forEach(w => {
        w.classList.remove('show');
        w.querySelector('.palette-btn').setAttribute('aria-expanded', 'false');
    });
}

function initTheme() {
    let savedTheme = null, savedPalette = null, savedIntensity = null;
    try {
        savedTheme = localStorage.getItem(THEME_KEY);
        savedPalette = localStorage.getItem(PALETTE_KEY);
        savedIntensity = localStorage.getItem(INTENSITY_KEY);
    } catch (e) { }
    document.documentElement.setAttribute('data-theme', savedTheme === 'light' ? 'light' : 'dark');
    document.documentElement.setAttribute('data-palette', isPalette(savedPalette) ? savedPalette : DEFAULT_PALETTE);
    const n = parseInt(savedIntensity, 10);
    document.documentElement.setAttribute('data-intensity',
        String((n >= INTENSITY_MIN && n <= INTENSITY_MAX) ? n : DEFAULT_INTENSITY));
    updateThemeButtons();
    renderPaletteMenus();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTheme);
else initTheme();

// ─── SHOW APP ───
async function showApp() {
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appContainer').style.display = 'block';
    updateUserUI();
    await loadTasksFromGist();
    pruneTaskLog();
    await purgeOldCompletedTasksSilent();
    ganttStartDate = getGanttDefaultStart();
    syncFilterButtons();
    render();
    startGistPolling();
}

// ─── COMPATIBILITY WRAPPERS ───
// gistDelayMs adia o push ao Gist: durante a digitação no modal usamos um atraso
// maior, para não publicar títulos pela metade (e não gastar chamadas de API).
function saveToStorage(gistDelayMs) {
    saveLocalState('local');
    scheduleGistPush(typeof gistDelayMs === 'number' ? gistDelayMs : 2000);
}

function scheduleGistPush(delayMs) {
    clearTimeout(saveToStorage._gistTimer);
    saveToStorage._gistTimer = setTimeout(() => silentPushToGist(), delayMs);
}

function genId() { return 'task_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 5); }

// ─── PRIORIDADE (ordem manual) ───
// A posição de cada tarefa vive no campo `order`: menor = mais prioritária, mais
// acima na lista. Usamos passos largos e pontos médios entre vizinhos para que
// arrastar UMA tarefa altere só ela — renumerar tudo faria toda a lista viajar
// no sync a cada arrasto.
const ORDER_STEP = 1000;

function orderValue(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function compareByDate(a, b) {
    if (a.endDate < b.endDate) return -1; if (a.endDate > b.endDate) return 1;
    if (a.startDate < b.startDate) return -1; if (a.startDate > b.startDate) return 1;
    return 0;
}

// Ordem manual manda; datas só desempatam (e cobrem tarefas ainda sem ordem).
function compareTasks(a, b) {
    const ao = orderValue(a.order), bo = orderValue(b.order);
    if (ao !== null && bo !== null) { if (ao !== bo) return ao - bo; return compareByDate(a, b); }
    if (ao !== null) return -1;
    if (bo !== null) return 1;
    return compareByDate(a, b);
}

// A REGRA PADRÃO DE ENTRADA é a data de término: a tarefa entra logo abaixo da
// última que NÃO termina depois dela. Numa lista ainda em ordem de data isso dá
// exatamente a posição da data; numa lista já reordenada à mão, evita que uma
// tarefa nova salte por cima das que foram priorizadas manualmente.
// `list` está na ordem em que aparece na tela.
function dateSlot(list, t) {
    let i = list.length;
    while (i > 0 && compareByDate(list[i - 1], t) > 0) i--;
    return i;
}

// Toda tarefa que ainda não tem posição — recém-criada, antiga (anterior a este
// campo) ou vinda de um dispositivo que não gravava ordem — entra pela regra da
// data. Depois disso a posição só muda se o usuário arrastar: a ordenação manual
// tem precedência sobre a padrão.
function ensureTaskOrder() {
    const pending = tasks.filter(t => orderValue(t.order) === null);
    if (pending.length === 0) return false;
    const placed = tasks.filter(t => orderValue(t.order) !== null).sort(compareTasks);
    pending.sort(compareByDate).forEach(t => {
        const i = dateSlot(placed, t);
        const prev = placed[i - 1], next = placed[i];
        if (!prev && !next) t.order = ORDER_STEP;
        else if (!prev) t.order = orderValue(next.order) - ORDER_STEP;
        else if (!next) t.order = orderValue(prev.order) + ORDER_STEP;
        else t.order = (orderValue(prev.order) + orderValue(next.order)) / 2;
        placed.splice(i, 0, t);
    });
    // Folga esgotada entre dois vizinhos: redistribui preservando a ordem visível.
    for (let i = 1; i < placed.length; i++) {
        if (Math.abs(orderValue(placed[i].order) - orderValue(placed[i - 1].order)) < 1) { renumberOrders(); break; }
    }
    return true;
}

// Só quando os pontos médios esgotam a folga entre dois vizinhos (muitos arrastos
// no mesmo ponto) redistribuímos os valores, preservando a ordem visível.
function renumberOrders() {
    tasks.slice().sort(compareTasks).forEach((t, i) => { t.order = (i + 1) * ORDER_STEP; });
}

/** Move `draggedId` para logo antes (after=false) ou logo depois (after=true) de `targetId`. */
function moveTaskTo(draggedId, targetId, after) {
    if (!draggedId || !targetId || draggedId === targetId) return false;
    const dragged = tasks.find(t => t.id === draggedId);
    if (!dragged) return false;
    ensureTaskOrder();
    const rest = tasks.filter(t => t.id !== draggedId).sort(compareTasks);
    const idx = rest.findIndex(t => t.id === targetId);
    if (idx === -1) return false;
    const pos = after ? idx + 1 : idx;
    const prev = rest[pos - 1], next = rest[pos];
    if (!prev && !next) return false;
    if (!prev) dragged.order = orderValue(next.order) - ORDER_STEP;
    else if (!next) dragged.order = orderValue(prev.order) + ORDER_STEP;
    else dragged.order = (orderValue(prev.order) + orderValue(next.order)) / 2;
    dragged.modifiedAt = nowISOGMT3();
    if (prev && next && Math.abs(orderValue(next.order) - orderValue(prev.order)) < 1) renumberOrders();
    saveToStorage();
    render();
    return true;
}

/** Um passo para cima (-1) ou para baixo (+1) na lista visível — atalho de teclado. */
function moveTaskRelative(id, dir) {
    const list = getFilteredTasks();
    const i = list.findIndex(t => t.id === id);
    if (i === -1) return false;
    const j = i + dir;
    if (j < 0 || j >= list.length) return false;
    return moveTaskTo(id, list[j].id, dir > 0);
}

// ─── RENDER ───
function render() {
    autoUpdateStatuses();
    if (ensureTaskOrder()) saveToStorage();
    renderTable();
    renderGantt();
}

function autoUpdateStatuses() {
    const today = todayGMT3();
    let changed = false;
    tasks.forEach(t => {
        if (t.status === 'Completed') return;
        const endDate = dateFromStrGMT3(t.endDate);
        const startDate = dateFromStrGMT3(t.startDate);
        if (today > endDate && t.status !== 'Overdue') {
            t.status = 'Overdue';
            t.modifiedAt = nowISOGMT3();
            changed = true;
        } else if (t.status === 'To Do' && today >= startDate && today <= endDate) {
            t.status = 'In Progress';
            t.modifiedAt = nowISOGMT3();
            changed = true;
        }
    });
    if (changed) saveToStorage();
}

/**
 * Reclassifica uma tarefa que estava "Overdue" depois que suas datas mudaram.
 * Se o novo término ainda é passado, ela permanece atrasada; caso contrário
 * volta para "In Progress" (já começou) ou "To Do" (começa no futuro).
 */
function reconcileStatusAfterDateChange(t, prevStatus) {
    if (!t || prevStatus !== 'Overdue' || t.status !== 'Overdue') return false;
    const today = todayGMT3();
    if (today > dateFromStrGMT3(t.endDate)) return false;
    t.status = today >= dateFromStrGMT3(t.startDate) ? 'In Progress' : 'To Do';
    return true;
}

function getFilteredTasks() {
    return tasks.filter(t => {
        const matchFilter = activeFilters.size === 0 || activeFilters.has(t.status);
        const matchSearch = !searchQuery || t.title.toLowerCase().includes(searchQuery.toLowerCase()) || t.description.toLowerCase().includes(searchQuery.toLowerCase());
        return matchFilter && matchSearch;
    }).sort(compareTasks);
}

function statusClass(s) { return { 'Completed': 'status-completed', 'In Progress': 'status-inprogress', 'To Do': 'status-todo', 'Overdue': 'status-overdue' }[s] || 'status-todo'; }
// Só de apresentação: o status gravado/sincronizado permanece em inglês, para não
// quebrar os JSONs já existentes no Gist nem os exports antigos.
const STATUS_LABELS = { 'To Do': 'A fazer', 'In Progress': 'Em andamento', 'Completed': 'Concluída', 'Overdue': 'Atrasada' };
function statusLabel(s) { return STATUS_LABELS[s] || s; }
function statusKey(s) { return { 'Completed': 'completed', 'In Progress': 'inprogress', 'To Do': 'todo', 'Overdue': 'overdue' }[s] || 'todo'; }
function formatDate(d) { if (!d) return '—'; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; }

function isFilteringOrSearching() { return activeFilters.size > 0 || !!searchQuery.trim(); }

// Distingue "ainda não há tarefas" de "os filtros escondem tudo" — sem isso o
// usuário vê "crie sua primeira tarefa" mesmo tendo 40 tarefas cadastradas.
function emptyStateHTML() {
    if (tasks.length > 0 && isFilteringOrSearching()) {
        return `<div class="empty-icon">🔎</div>
      <h3>Nenhuma tarefa corresponde aos filtros</h3>
      <p>Existe${tasks.length === 1 ? '' : 'm'} ${tasks.length} tarefa${tasks.length === 1 ? '' : 's'} cadastrada${tasks.length === 1 ? '' : 's'}, mas nenhuma passa pela busca/filtros atuais.</p>
      <div class="empty-actions">
        <button class="btn" onclick="clearFiltersAndSearch()">Limpar filtros e busca</button>
      </div>`;
    }
    return `<div class="empty-icon">📋</div>
      <h3>Nenhuma tarefa por aqui</h3>
      <p>Crie a primeira tarefa — ela é salva sozinha assim que você digitar um título.</p>
      <div class="empty-actions">
        <button class="btn btn-primary" onclick="openModal()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>Nova tarefa
        </button>
      </div>`;
}

function clearFiltersAndSearch() {
    activeFilters.clear();
    searchQuery = '';
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    syncFilterButtons();
    render();
}

function renderTable() {
    const filtered = getFilteredTasks();
    const tbody = document.getElementById('taskTableBody');
    const empty = document.getElementById('emptyState');
    if (filtered.length === 0) {
        tbody.innerHTML = '';
        empty.innerHTML = emptyStateHTML();
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';
    tbody.innerHTML = filtered.map(t => `
    <tr data-reorder-id="${t.id}">
      <td class="drag-cell">${DRAG_HANDLE_HTML}</td>
      <td class="task-title-cell" onclick="editTask('${t.id}')" title="Clique para abrir a tarefa">${esc(t.title)}</td>
      <td class="task-desc-cell" onclick="window.openMdViewer && openMdViewer('${esc(t.title).replace(/'/g,"\\'")}', ${JSON.stringify(t.description || '')})" title="${t.description ? 'Clique para ver a descrição completa' : ''}">${esc(window.mdToPlain ? window.mdToPlain(t.description) : t.description) || '—'}</td>
      <td><span class="status-badge ${statusClass(t.status)}" role="button" tabindex="0" title="Clique para alterar o status"
            onclick="toggleStatusDropdown(event, '${t.id}')"
            onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleStatusDropdown(event,'${t.id}')}"><span class="dot"></span>${statusLabel(t.status)}</span></td>
      <td class="date-cell">${formatDate(t.startDate)}</td>
      <td class="date-cell">${formatDate(t.endDate)}</td>
      <td><div class="action-btns">
        <button class="icon-btn" onclick="editTask('${t.id}')" title="Editar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="icon-btn delete" onclick="deleteTask('${t.id}')" title="Excluir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
      </div></td>
    </tr>`).join('');
}

// ─── GANTT ───
function getGanttDefaultStart() {
    const d = todayGMT3();
    d.setDate(d.getDate() - 7);
    return d;
}
function ganttPrev() { ganttStartDate.setDate(ganttStartDate.getDate() - 7); renderGantt(); }
function ganttNext() { ganttStartDate.setDate(ganttStartDate.getDate() + 7); renderGantt(); }
function ganttToday() { ganttStartDate = getGanttDefaultStart(); renderGantt(); }

function renderGantt() {
    if (!ganttStartDate) ganttStartDate = getGanttDefaultStart();
    const filtered = getFilteredTasks();
    const container = document.getElementById('ganttContent');
    const today = todayGMT3();
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
        rowsHTML = `<div class="empty-state" style="padding:40px">${emptyStateHTML()}</div>`;
    } else {
        filtered.forEach(t => {
            const sk = statusKey(t.status);
            const tStart = dateFromStrGMT3(t.startDate);
            const tEnd = dateFromStrGMT3(t.endDate);
            const ganttStart = ganttStartDate.getTime();
            const dayWidth = 100 / GANTT_DAYS;
            const startOffset = (tStart.getTime() - ganttStart) / (1000 * 60 * 60 * 24);
            const duration = (tEnd.getTime() - tStart.getTime()) / (1000 * 60 * 60 * 24) + 1;
            const barLeft = startOffset * dayWidth, barWidth = duration * dayWidth;
            const barVisible = (startOffset + duration > 0) && (startOffset < GANTT_DAYS);

            rowsHTML += `<div class="gantt-row" data-reorder-id="${t.id}"><div class="gantt-row-label">${DRAG_HANDLE_HTML}<span class="dot" style="width:8px;height:8px;border-radius:50%;background:var(--${sk});flex-shrink:0"></span><span class="task-name clickable" title="Clique para abrir a tarefa" onclick="editTask('${t.id}')">${esc(t.title)}</span></div><div class="gantt-row-timeline">`;
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
    // Usa renderização Markdown se disponível
    if (window.setGanttTooltipDesc) {
        window.setGanttTooltipDesc(t.description);
    } else {
        document.getElementById('ttDesc').textContent = t.description || 'Sem descrição';
    }
    document.getElementById('ttDates').textContent = `${formatDate(t.startDate)} → ${formatDate(t.endDate)} · ${statusLabel(t.status)}`;
    tt.classList.add('show'); positionTooltip(e);
}
function hideTooltip() { document.getElementById('ganttTooltip').classList.remove('show'); }
document.addEventListener('mousemove', e => { const tt = document.getElementById('ganttTooltip'); if (tt.classList.contains('show') && !dragState.active) positionTooltip(e); });
function positionTooltip(e) { const tt = document.getElementById('ganttTooltip'); tt.style.left = (e.clientX + 12) + 'px'; tt.style.top = (e.clientY - 10) + 'px'; }

// ─── GANTT DRAG ───
const dragState = { active: false, type: null, taskId: null, startX: 0, origStartDate: null, origEndDate: null, timelineEl: null, pxPerDay: 0, barEl: null };
function getTimelineMetrics(barEl) { const tl = barEl.closest('.gantt-row-timeline'); if (!tl) return null; const r = tl.getBoundingClientRect(); return { timeline: tl, rect: r, pxPerDay: r.width / GANTT_DAYS }; }
function pxToDateOffset(px) { return Math.round(px / dragState.pxPerDay); }
function addDaysToDateStr(ds, days) {
    const d = dateFromStrGMT3(ds);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}
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
    const tS = dateFromStrGMT3(task.startDate);
    const tE = dateFromStrGMT3(task.endDate);
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
    const draggedTask = tasks.find(t => t.id === dragState.taskId);
    if (draggedTask) { reconcileStatusAfterDateChange(draggedTask, draggedTask.status); draggedTask.modifiedAt = nowISOGMT3(); }
    saveToStorage(); dragState.active = false; render();
});

// ─── REORDENAR POR PRIORIDADE (arrastar pelo punho) ───
// Só o punho arrasta: a linha inteira continua clicável para abrir a tarefa, e o
// arrasto horizontal das barras do Gantt (que muda datas) segue intocado.
const DRAG_HANDLE_HTML = '<button type="button" class="drag-handle" draggable="true" title="Arraste para mudar a prioridade (ou use as setas ↑ e ↓ com o punho em foco)" aria-label="Mover tarefa para cima ou para baixo">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<line x1="12" y1="4" x2="12" y2="20"/><polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/></svg></button>';

const reorderDrag = { id: null, rowEl: null, listEl: null, targetEl: null, after: false };

function clearReorderMarks() {
    document.querySelectorAll('.reorder-before, .reorder-after').forEach(el => el.classList.remove('reorder-before', 'reorder-after'));
}

function endReorderDrag() {
    clearReorderMarks();
    if (reorderDrag.rowEl) reorderDrag.rowEl.classList.remove('reorder-dragging');
    reorderDrag.id = null; reorderDrag.rowEl = null; reorderDrag.listEl = null; reorderDrag.targetEl = null; reorderDrag.after = false;
}

function closestEl(target, selector) {
    return (target && target.closest) ? target.closest(selector) : null;
}

document.addEventListener('dragstart', e => {
    const handle = closestEl(e.target, '.drag-handle');
    if (!handle) return;
    const row = handle.closest('[data-reorder-id]');
    if (!row) return;
    reorderDrag.id = row.dataset.reorderId;
    reorderDrag.rowEl = row;
    reorderDrag.listEl = row.closest('[data-reorder-list]');
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', reorderDrag.id); } catch (err) { }
        if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(row, 24, 16);
    }
    // Esmaecer a linha só depois que o navegador tirou a "foto" do arrasto.
    setTimeout(() => { if (reorderDrag.rowEl === row) row.classList.add('reorder-dragging'); }, 0);
});

document.addEventListener('dragover', e => {
    if (!reorderDrag.id) return;
    const row = closestEl(e.target, '[data-reorder-id]');
    // Tabela e Gantt são listas distintas: nunca se arrasta de uma para a outra.
    if (!row || row.closest('[data-reorder-list]') !== reorderDrag.listEl) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (row.dataset.reorderId === reorderDrag.id) { clearReorderMarks(); reorderDrag.targetEl = null; return; }
    const r = row.getBoundingClientRect();
    const after = (e.clientY - r.top) > r.height / 2;
    if (reorderDrag.targetEl !== row || reorderDrag.after !== after) {
        clearReorderMarks();
        row.classList.add(after ? 'reorder-after' : 'reorder-before');
        reorderDrag.targetEl = row;
        reorderDrag.after = after;
    }
});

document.addEventListener('drop', e => {
    if (!reorderDrag.id) return;
    e.preventDefault();
    const target = reorderDrag.targetEl;
    const draggedId = reorderDrag.id, after = reorderDrag.after;
    endReorderDrag();
    if (target) moveTaskTo(draggedId, target.dataset.reorderId, after);
});

document.addEventListener('dragend', () => { if (reorderDrag.id) endReorderDrag(); });

// Alternativa sem mouse: com o punho em foco, ↑ / ↓ movem a tarefa uma posição.
document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const handle = closestEl(e.target, '.drag-handle');
    if (!handle) return;
    const row = handle.closest('[data-reorder-id]');
    if (!row) return;
    e.preventDefault();
    const id = row.dataset.reorderId;
    const listId = row.closest('[data-reorder-list]') ? row.closest('[data-reorder-list]').id : null;
    if (!moveTaskRelative(id, e.key === 'ArrowUp' ? -1 : 1)) return;
    // render() reconstrói as linhas: devolve o foco ao punho da mesma tarefa.
    const scope = listId ? document.getElementById(listId) : document;
    const again = scope && scope.querySelector('[data-reorder-id="' + id + '"] .drag-handle');
    if (again) again.focus();
});

// ─── FILTERS & SEARCH ───
function toggleFilter(filter) {
    if (filter === 'all') activeFilters.clear();
    else if (activeFilters.has(filter)) activeFilters.delete(filter);
    else activeFilters.add(filter);
    // Tudo marcado equivale a nenhum filtro — volta para "Todas".
    if (activeFilters.size === 4) activeFilters.clear();
    syncFilterButtons();
    render();
}

// Uma única fonte da verdade para o visual dos filtros (classe + aria-pressed).
function syncFilterButtons() {
    document.querySelectorAll('.filter-btn').forEach(b => {
        const f = b.dataset.filter;
        const on = f === 'all' ? activeFilters.size === 0 : activeFilters.has(f);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}
function searchTasks(q) { searchQuery = q; render(); }

// ─── VIEW SWITCH ───
function switchView(view, btn) {
    document.querySelectorAll('.view-tab').forEach(b => b.classList.remove('active')); btn.classList.add('active');
    document.getElementById('tableView').style.display = view === 'table' ? 'block' : 'none';
    document.getElementById('ganttView').style.display = view === 'gantt' ? 'block' : 'none';
    if (view === 'gantt') renderGantt();
}

// ─── TASK MODAL — SALVAMENTO AUTOMÁTICO ───
// Não existe mais botão "Criar Tarefa": depois de uma pausa na digitação a tarefa
// é gravada sozinha, assim que houver um título.
//
// O ponto delicado é o RENOMEAR: quem digita devagar faz a primeira gravação
// acontecer com um título pela metade ("Reuni"), e o título final ("Reunião de
// planejamento") chega depois. Por isso a PRIMEIRA gravação cria a tarefa e guarda
// o id em draft.taskId; toda gravação seguinte procura a tarefa POR ID e apenas
// atualiza os campos. Renomear vira update, nunca um segundo registro — e como o
// id não muda, a reconciliação com o Gist casa por id e não duplica nada.
const DRAFT_DEBOUNCE_MS = 700;    // pausa na digitação que dispara a gravação
const DRAFT_GIST_DELAY_MS = 6000; // enquanto se edita, o push ao Gist fica adiado

const draft = {
    open: false,        // modal de tarefa aberto
    taskId: null,       // id ao qual este rascunho está vinculado (null = ainda não gravado)
    createdHere: false, // a tarefa nasceu nesta sessão do modal (habilita "Descartar")
    committing: false,  // trava de reentrância: impede duas criações simultâneas
    wrote: false,       // gravou algo desde que o modal abriu
    original: null,     // estado da tarefa ao abrir o modal (habilita "Reverter")
    timer: null,
    lastSavedAt: null
};

function resetDraftState() {
    clearTimeout(draft.timer);
    draft.timer = null;
    draft.open = false;
    draft.taskId = null;
    draft.createdHere = false;
    draft.committing = false;
    draft.wrote = false;
    draft.original = null;
}

function openModal(taskId) {
    const existing = taskId ? tasks.find(t => t.id === taskId) : null;

    resetDraftState();
    draft.open = true;
    draft.taskId = existing ? existing.id : null;
    draft.lastSavedAt = null;

    const modal = document.getElementById('taskModal');
    modal.classList.add('show');

    const notice = document.getElementById('dateSwapNotice');
    if (notice) notice.classList.remove('show');

    if (existing) {
        // Com o autosave não há mais "Cancelar": guardamos o estado de entrada para
        // que o usuário possa reverter a edição inteira em um clique.
        draft.original = taskSnapshot(existing);
        document.getElementById('modalTitle').textContent = 'Editar tarefa';
        document.getElementById('taskTitle').value = existing.title;
        document.getElementById('taskDesc').value = existing.description;
        if (window.setTaskStatus) window.setTaskStatus(existing.status, true);
        document.getElementById('taskStart').value = existing.startDate;
        document.getElementById('taskEnd').value = existing.endDate;
        setAutosaveState('saved-idle');
    } else {
        document.getElementById('modalTitle').textContent = 'Nova tarefa';
        document.getElementById('taskTitle').value = '';
        document.getElementById('taskDesc').value = '';
        if (window.setTaskStatus) window.setTaskStatus('To Do', true);
        const td = todayStrGMT3();
        document.getElementById('taskStart').value = td;
        document.getElementById('taskEnd').value = td;
        setAutosaveState('awaiting-title');
    }
    updateTitleHint();
    updateDraftChrome();
    setTimeout(() => document.getElementById('taskTitle').focus(), 100);
}

function closeModal() {
    if (draft.open) commitDraft();
    const pushNow = draft.wrote;
    const createdId = (draft.open && draft.createdHere) ? draft.taskId : null;
    resetDraftState();
    document.getElementById('taskModal').classList.remove('show');
    const hint = document.getElementById('taskTitleHint');
    if (hint) { hint.className = 'field-hint'; hint.textContent = ''; }
    const titleEl = document.getElementById('taskTitle');
    if (titleEl) titleEl.classList.remove('invalid');
    // Edição encerrada: antecipa o envio ao Gist, que ficou adiado durante a digitação.
    // O autosave gera um evento de journal por pausa na digitação, então a poda —
    // antes só no login — passa a rodar também aqui, ao fim de cada edição.
    if (pushNow) { pruneTaskLog(); scheduleGistPush(1200); }

    // A tarefa foi salva, mas os filtros ativos a escondem: sem este aviso o
    // usuário conclui que o salvamento automático falhou.
    if (createdId && !getFilteredTasks().some(t => t.id === createdId)) {
        showActionToast('Tarefa salva, mas escondida pelos filtros atuais.', 'Limpar filtros', clearFiltersAndSearch);
    }
}

// Equivalente ao antigo "Cancelar" para uma tarefa recém-criada pelo autosave:
// remove a tarefa que acabou de nascer, com desfazer disponível no toast.
function discardDraft() {
    if (!draft.createdHere || !draft.taskId) { closeModal(); return; }
    const id = draft.taskId;
    resetDraftState();
    document.getElementById('taskModal').classList.remove('show');
    const snap = removeTaskById(id);
    if (!snap) return;
    saveToStorage(1200);
    render();
    showActionToast(`Tarefa “${truncate(snap.title, 40)}” descartada.`, 'Desfazer', () => restoreTask(snap));
}

function draftDiffersFromOriginal() {
    const o = draft.original;
    if (!o || !draft.taskId) return false;
    const t = tasks.find(tk => tk.id === draft.taskId);
    if (!t) return false;
    return t.title !== o.title || t.description !== o.description || t.status !== o.status
        || t.startDate !== o.startDate || t.endDate !== o.endDate;
}

// Desfaz, de uma vez, tudo que foi alterado desde que o modal abriu.
function revertDraft() {
    const o = draft.original;
    if (!o || !draft.taskId) return;
    const t = tasks.find(tk => tk.id === draft.taskId);
    if (!t) return;
    clearTimeout(draft.timer);
    draft.timer = null;

    t.title = o.title;
    t.description = o.description;
    t.status = o.status;
    t.startDate = o.startDate;
    t.endDate = o.endDate;
    t.modifiedAt = nowISOGMT3();

    document.getElementById('taskTitle').value = o.title;
    document.getElementById('taskDesc').value = o.description;
    if (window.setTaskStatus) window.setTaskStatus(o.status, true);
    document.getElementById('taskStart').value = o.startDate;
    document.getElementById('taskEnd').value = o.endDate;

    draft.wrote = true;
    saveToStorage(1200);
    render();
    updateDraftChrome();
    updateTitleHint();
    setAutosaveState('reverted');
}

function readTaskForm() {
    return {
        title: document.getElementById('taskTitle').value.trim(),
        description: document.getElementById('taskDesc').value.trim(),
        status: (window.getTaskStatusValue ? window.getTaskStatusValue() : document.getElementById('taskStatus').value) || 'To Do',
        startDate: document.getElementById('taskStart').value,
        endDate: document.getElementById('taskEnd').value
    };
}

// Chamado a cada alteração de campo (também pelo script inline do index.html).
// opts.immediate = controles discretos (status, datas), que não precisam esperar.
function notifyDraftChange(opts) {
    if (!draft.open) return;
    updateTitleHint();
    clearTimeout(draft.timer);
    draft.timer = null;

    if (!document.getElementById('taskTitle').value.trim()) {
        setAutosaveState(draft.taskId ? 'title-required' : 'awaiting-title');
        return;
    }
    setAutosaveState('saving');
    if (opts && opts.immediate) commitDraft();
    else draft.timer = setTimeout(commitDraft, DRAFT_DEBOUNCE_MS);
}

function commitDraft() {
    if (!draft.open || draft.committing) return false;
    clearTimeout(draft.timer);
    draft.timer = null;

    const form = readTaskForm();
    const existing = draft.taskId ? tasks.find(t => t.id === draft.taskId) : null;

    // A tarefa sumiu debaixo da edição (exclusão vinda de outro dispositivo):
    // não descarta o que está na tela — a próxima gravação recria com id novo.
    if (draft.taskId && !existing) {
        draft.taskId = null;
        draft.createdHere = true;
    }

    if (!form.title) {
        setAutosaveState(draft.taskId ? 'title-required' : 'awaiting-title');
        return false;
    }

    draft.committing = true;
    try {
        const now = nowISOGMT3();
        if (existing) {
            // Campo de data vazio (ou incompleto) nunca apaga a data já salva.
            let startDate = form.startDate || existing.startDate;
            let endDate = form.endDate || existing.endDate;
            if (endDate < startDate) { const tmp = startDate; startDate = endDate; endDate = tmp; }
            const unchanged = existing.title === form.title
                && existing.description === form.description
                && existing.status === form.status
                && existing.startDate === startDate
                && existing.endDate === endDate;
            if (unchanged) { setAutosaveState(draft.wrote ? 'saved' : 'saved-idle'); return false; }
            const prevStatus = existing.status;
            existing.title = form.title;
            existing.description = form.description;
            existing.status = form.status;
            existing.startDate = startDate;
            existing.endDate = endDate;
            reconcileStatusAfterDateChange(existing, prevStatus);
            existing.modifiedAt = now;
        } else {
            const today = todayStrGMT3();
            let startDate = form.startDate || today;
            let endDate = form.endDate || startDate;
            if (endDate < startDate) { const tmp = startDate; startDate = endDate; endDate = tmp; }
            const created = {
                id: genId(), title: form.title, description: form.description, status: form.status,
                startDate, endDate, order: null, createdAt: now, modifiedAt: now
            };
            tasks.push(created);
            ensureTaskOrder();   // posiciona pela data de término, sem esperar o render
            draft.taskId = created.id;   // ← vínculo por id: daqui em diante é sempre update
            draft.createdHere = true;
        }

        draft.wrote = true;
        saveToStorage(DRAFT_GIST_DELAY_MS);
        render();

        // render() pode reclassificar o status (autoUpdateStatuses); reflete isso nos
        // botões, senão o modal mostraria um status diferente do que está gravado.
        const stored = tasks.find(t => t.id === draft.taskId);
        if (stored && window.setTaskStatus && stored.status !== form.status) {
            window.setTaskStatus(stored.status, true);
        }

        updateDraftChrome();
        updateTitleHint();
        setAutosaveState((form.startDate && form.endDate) ? 'saved' : 'dates-kept');
        return true;
    } finally {
        draft.committing = false;
    }
}

// ─── FEEDBACK DO AUTOSAVE ───
function setAutosaveState(state) {
    const chip = document.getElementById('autosaveChip');
    const text = document.getElementById('autosaveChipText');
    if (!chip || !text) return;
    chip.classList.remove('saving', 'saved', 'warn');
    let msg = '';
    switch (state) {
        case 'awaiting-title':
            msg = 'A tarefa é salva sozinha assim que tiver um título.';
            break;
        case 'saving':
            chip.classList.add('saving');
            msg = 'Salvando…';
            break;
        case 'saved':
            chip.classList.add('saved');
            draft.lastSavedAt = new Date();
            msg = 'Salva automaticamente · ' + formatClock(draft.lastSavedAt);
            break;
        case 'saved-idle':
            chip.classList.add('saved');
            msg = draft.lastSavedAt
                ? 'Salva automaticamente · ' + formatClock(draft.lastSavedAt)
                : 'As alterações são salvas automaticamente.';
            break;
        case 'title-required':
            chip.classList.add('warn');
            msg = 'Título vazio — mantendo o último título salvo.';
            break;
        case 'reverted':
            chip.classList.add('saved');
            draft.lastSavedAt = new Date();
            msg = 'Alterações revertidas · ' + formatClock(draft.lastSavedAt);
            break;
        case 'dates-kept':
            chip.classList.add('warn');
            draft.lastSavedAt = new Date();
            msg = 'Salva · datas incompletas, mantidas as anteriores.';
            break;
    }
    text.textContent = msg;
}

function formatClock(d) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR') + ' ' + formatClock(d);
}

// Linha "criada em / alterada em" + visibilidade do botão Descartar.
function updateDraftChrome() {
    const t = draft.taskId ? tasks.find(tk => tk.id === draft.taskId) : null;
    const meta = document.getElementById('taskMeta');
    if (meta) {
        if (t) {
            meta.textContent = `Criada em ${formatDateTime(t.createdAt)}  ·  última alteração ${formatDateTime(t.modifiedAt)}`;
            meta.classList.add('show');
        } else {
            meta.textContent = '';
            meta.classList.remove('show');
        }
    }
    const discard = document.getElementById('discardBtn');
    if (discard) discard.style.display = (draft.createdHere && draft.taskId) ? '' : 'none';
    const revert = document.getElementById('revertBtn');
    if (revert) revert.style.display = (!draft.createdHere && draftDiffersFromOriginal()) ? '' : 'none';
}

// Validação inline do título: nunca bloqueia a digitação, apenas avisa.
function updateTitleHint() {
    const input = document.getElementById('taskTitle');
    const hint = document.getElementById('taskTitleHint');
    if (!input || !hint) return;
    const title = input.value.trim();
    const key = title.toLowerCase();
    const duplicate = !!title && tasks.some(t => t.id !== draft.taskId && (t.title || '').toLowerCase() === key);

    if (!title && draft.taskId) {
        input.classList.add('invalid');
        hint.className = 'field-hint warn show';
        hint.textContent = 'O título não pode ficar vazio — o último título salvo continua valendo.';
    } else if (duplicate) {
        input.classList.remove('invalid');
        hint.className = 'field-hint warn show';
        hint.textContent = 'Já existe outra tarefa com este título. Títulos repetidos atrapalham a sincronização entre dispositivos.';
    } else {
        input.classList.remove('invalid');
        hint.className = 'field-hint';
        hint.textContent = '';
    }
}

function editTask(id) { openModal(id); }

// ─── EXCLUSÃO COM DESFAZER ───
// Remove a tarefa e registra o tombstone (a exclusão precisa viajar até os outros
// dispositivos — ausência nunca é tratada como exclusão pela reconciliação).
function removeTaskById(id) {
    const t = tasks.find(tk => tk.id === id);
    if (!t) return null;
    const snap = { ...t };
    tombstones.push({ id: t.id, title: t.title, deletedAt: nowISOGMT3() });
    tasks = tasks.filter(tk => tk.id !== id);
    return snap;
}

function deleteTask(id) {
    // Se a tarefa aberta no modal for a excluída, encerra o rascunho SEM gravar —
    // gravar aqui recriaria a tarefa que o usuário acabou de excluir.
    if (draft.open && draft.taskId === id) {
        resetDraftState();
        document.getElementById('taskModal').classList.remove('show');
    }
    const snap = removeTaskById(id);
    if (!snap) return;
    saveToStorage();
    render();
    showActionToast(`Tarefa “${truncate(snap.title, 40)}” excluída.`, 'Desfazer', () => restoreTask(snap));
}

function restoreTask(snap) {
    if (!snap || !snap.id || tasks.some(t => t.id === snap.id)) return;
    const key = (snap.title || '').toLowerCase();
    // Limpa os tombstones da tarefa para que a restauração sobreviva ao próximo sync.
    tombstones = tombstones.filter(tb => tb.id !== snap.id && (tb.title || '').toLowerCase() !== key);
    tasks.push({ ...snap, modifiedAt: nowISOGMT3() });
    saveToStorage(1200);
    render();
    showActionToast('Tarefa restaurada.', null, null, 2500);
}

// ─── TOAST COM AÇÃO ───
function showActionToast(msg, actionLabel, onAction, durationMs) {
    let toast = document.getElementById('actionToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'actionToast';
        toast.className = 'action-toast';
        toast.innerHTML = '<span class="toast-msg"></span>'
            + '<button type="button" class="toast-action"></button>'
            + '<button type="button" class="toast-close" aria-label="Fechar aviso">✕</button>';
        document.body.appendChild(toast);
        toast.querySelector('.toast-close').addEventListener('click', hideActionToast);
        toast.querySelector('.toast-action').addEventListener('click', () => {
            const fn = toast._onAction;
            hideActionToast();
            if (fn) fn();
        });
    }
    toast._onAction = onAction || null;
    toast.querySelector('.toast-msg').textContent = msg;
    const actionBtn = toast.querySelector('.toast-action');
    actionBtn.textContent = actionLabel || '';
    actionBtn.style.display = actionLabel ? '' : 'none';
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(hideActionToast, durationMs || 7000);
}

function hideActionToast() {
    const toast = document.getElementById('actionToast');
    if (!toast) return;
    clearTimeout(toast._timer);
    toast.classList.remove('show');
    toast._onAction = null;
}

function truncate(str, max) {
    str = str || '';
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── LIGAÇÃO DOS CAMPOS AO AUTOSAVE ───
function initTaskDraftUI() {
    const title = document.getElementById('taskTitle');
    const desc = document.getElementById('taskDesc');
    if (title) {
        title.addEventListener('input', () => notifyDraftChange());
        // Sair do campo fecha o título: grava sem esperar o resto do debounce.
        // Exceção: se o foco vai para "Descartar", não faz sentido criar para apagar.
        title.addEventListener('blur', e => {
            const to = e.relatedTarget && e.relatedTarget.id;
            if (to === 'discardBtn' || to === 'revertBtn') return;
            notifyDraftChange({ immediate: true });
        });
    }
    // Cobre também os botões da barra Markdown, que disparam 'input' no textarea.
    if (desc) desc.addEventListener('input', () => notifyDraftChange());

    const overlay = document.getElementById('taskModal');
    if (overlay) {
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    }
    // Usado pelo script inline do index.html (status e datas).
    window.notifyDraftChange = notifyDraftChange;
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTaskDraftUI);
else initTaskDraftUI();

// ─── STATUS DROPDOWN (na tabela) ───
function toggleStatusDropdown(e, id) { e.stopPropagation(); statusChangeId = id; const dd = document.getElementById('statusDropdown'); const rect = e.target.closest('.status-badge').getBoundingClientRect(); dd.style.top = (rect.bottom + 4) + 'px'; dd.style.left = rect.left + 'px'; dd.classList.toggle('show'); }
function changeStatus(ns) {
    if (statusChangeId) {
        const t = tasks.find(tk => tk.id === statusChangeId);
        if (t) { t.status = ns; t.modifiedAt = nowISOGMT3(); saveToStorage(); render(); }
    }
    document.getElementById('statusDropdown').classList.remove('show'); statusChangeId = null;
}
document.addEventListener('click', () => { document.getElementById('statusDropdown').classList.remove('show'); closeUserDropdown(); closePaletteMenus(); });

// ─── SYNC MODAL ───
let syncImportMode = 'merge';
function openSyncModal(tab) {
    document.getElementById('syncModal').classList.add('show');
    switchSyncTab(tab || 'gist');
    if (tab === 'export') generateSyncExport();
    if (tab === 'gist') refreshGistUI();
}
function closeSyncModal() {
    document.getElementById('syncModal').classList.remove('show');
    document.getElementById('syncExportText').value = '';
    document.getElementById('syncImportText').value = '';
    hideSyncStatus('syncExportStatus');
    hideSyncStatus('syncImportStatus');
    hideSyncStatus('gistSyncStatus');
}
function switchSyncTab(tab) {
    ['gist', 'export', 'import'].forEach(t => {
        const tabBtn = document.getElementById('syncTab' + t.charAt(0).toUpperCase() + t.slice(1));
        const panel = document.getElementById('syncPanel' + t.charAt(0).toUpperCase() + t.slice(1));
        if (tabBtn) tabBtn.classList.toggle('active', t === tab);
        if (panel) panel.classList.toggle('active', t === tab);
    });
    document.getElementById('syncImportBtn').style.display = (tab === 'import') ? '' : 'none';
}
function setImportMode(m) { syncImportMode = m; document.getElementById('importModeMerge').classList.toggle('active', m === 'merge'); document.getElementById('importModeReplace').classList.toggle('active', m === 'replace'); }
function triggerFileImport() { document.getElementById('csvInput').click(); }
function showSyncStatus(id, msg, type) { const el = document.getElementById(id); el.textContent = msg; el.className = 'sync-status ' + type; }
function hideSyncStatus(id) { document.getElementById(id).className = 'sync-status'; }
function generateSyncExport() { const exportData = tasks.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status, startDate: t.startDate, endDate: t.endDate, order: orderValue(t.order), createdAt: t.createdAt, modifiedAt: t.modifiedAt })); const text = JSON.stringify(exportData, null, 2); document.getElementById('syncExportText').value = text; showSyncStatus('syncExportStatus', `${tasks.length} tarefa(s) gerada(s) em JSON.`, 'info'); }
function copySyncExport() { const ta = document.getElementById('syncExportText'); if (!ta.value) generateSyncExport(); navigator.clipboard.writeText(ta.value).then(() => { showSyncStatus('syncExportStatus', '✓ JSON copiado!', 'success'); }).catch(() => { ta.select(); document.execCommand('copy'); showSyncStatus('syncExportStatus', '✓ JSON copiado!', 'success'); }); }
function downloadSyncExport() { if (!document.getElementById('syncExportText').value) generateSyncExport(); const text = document.getElementById('syncExportText').value; const blob = new Blob([text], { type: 'application/json;charset=utf-8;' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `taskflow_${todayStrGMT3()}.json`; a.click(); URL.revokeObjectURL(url); showSyncStatus('syncExportStatus', '✓ Arquivo JSON baixado!', 'success'); }

function normalizeTasks(arr) {
    const vs = ['Completed', 'In Progress', 'To Do', 'Overdue'];
    const now = nowISOGMT3();
    return arr.map(t => ({ id: t.id || genId(), title: String(t.title || '').trim(), description: String(t.description || '').trim(), status: vs.includes(t.status) ? t.status : 'To Do', startDate: t.startDate || todayStrGMT3(), endDate: t.endDate || todayStrGMT3(), order: orderValue(t.order), createdAt: t.createdAt || now, modifiedAt: t.modifiedAt || now })).filter(t => t.title);
}
function parseImportedJSON(text) {
    const parsed = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null);
    if (!arr) throw new Error('JSON deve ser um array de tarefas.');
    return normalizeTasks(arr);
}
function parseTombstonesContent(content) {
    try {
        const parsed = JSON.parse(content);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tombstones) ? parsed.tombstones : []);
        return arr.filter(t => t && t.id && t.deletedAt).map(t => ({ id: t.id, title: t.title || '', deletedAt: t.deletedAt }));
    } catch (e) { return []; }
}
// Read tasks / tombstones from a fetched Gist payload (tombstones live in a sidecar
// file so legacy clients that only know taskflow.json keep working unchanged).
function readGistTasks(data) {
    if (!data.files || !data.files['taskflow.json']) return null;
    return parseImportedJSON(data.files['taskflow.json'].content);
}
function readGistTombstones(data) {
    if (!data.files || !data.files['taskflow.deleted.json']) return [];
    return parseTombstonesContent(data.files['taskflow.deleted.json'].content);
}
function buildGistFiles() {
    const taskArr = tasks.map(t => ({ id: t.id, title: t.title, description: t.description, status: t.status, startDate: t.startDate, endDate: t.endDate, order: orderValue(t.order), createdAt: t.createdAt, modifiedAt: t.modifiedAt }));
    return {
        'taskflow.json': { content: JSON.stringify(taskArr, null, 2) },
        'taskflow.deleted.json': { content: JSON.stringify(tombstones, null, 2) }
    };
}
function mergeTaskLists(incoming) {
    let added = 0, updated = 0;
    const byTitle = new Map(tasks.map(t => [t.title.toLowerCase(), t]));
    for (const inc of incoming) {
        const key = inc.title.toLowerCase();
        if (byTitle.has(key)) {
            const ex = byTitle.get(key);
            const exMod = ex.modifiedAt || '1970-01-01T00:00:00.000-03:00';
            const incMod = inc.modifiedAt || '1970-01-01T00:00:00.000-03:00';
            if (incMod > exMod) {
                ex.status = inc.status; ex.startDate = inc.startDate; ex.endDate = inc.endDate;
                ex.description = inc.description || ex.description;
                if (orderValue(inc.order) !== null) ex.order = orderValue(inc.order);
                ex.modifiedAt = inc.modifiedAt;
                if (inc.createdAt && (!ex.createdAt || inc.createdAt < ex.createdAt)) ex.createdAt = inc.createdAt;
                updated++;
            } else if (exMod === incMod) {
                if (!ex.description && inc.description) { ex.description = inc.description; updated++; }
            }
        } else { tasks.push({ ...inc }); added++; }
    }
    return { added, updated };
}

// ─── TOMBSTONE HELPERS ───
function mergeTombstones(a, b) {
    const map = new Map();
    for (const t of [...(a || []), ...(b || [])]) {
        if (!t || !t.id || !t.deletedAt) continue;
        const prev = map.get(t.id);
        if (!prev || t.deletedAt > prev.deletedAt) map.set(t.id, { id: t.id, title: t.title || '', deletedAt: t.deletedAt });
    }
    return Array.from(map.values());
}
function pruneTombstones(tombs) {
    const cutoffMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
    return (tombs || []).filter(t => { const d = Date.parse(t.deletedAt); return isNaN(d) || d >= cutoffMs; });
}

// ─── BIDIRECTIONAL RECONCILE (per-task modifiedAt wins; deletions only via tombstones) ───
// A task absent from the remote is NEVER dropped by absence — that was the data-loss bug.
// It is removed only when a tombstone for it exists whose deletedAt is newer than the
// task's modifiedAt (so a task re-created/edited after deletion still survives).
function reconcileWithRemote(localTasks, localTombstones, remoteTasks, remoteTombstones) {
    const tombs = mergeTombstones(localTombstones, remoteTombstones);
    const tombById = new Map();
    const tombByTitle = new Map();
    for (const tb of tombs) {
        tombById.set(tb.id, tb);
        if (tb.title) {
            const k = tb.title.toLowerCase();
            const prev = tombByTitle.get(k);
            if (!prev || tb.deletedAt > prev.deletedAt) tombByTitle.set(k, tb);
        }
    }
    const isDead = (task) => {
        const tb = tombById.get(task.id) || tombByTitle.get((task.title || '').toLowerCase());
        return !!tb && (tb.deletedAt || '') > (task.modifiedAt || '');
    };

    const localById = new Map(localTasks.map(t => [t.id, t]));
    const localByTitle = new Map(localTasks.map(t => [t.title.toLowerCase(), t]));
    const remoteByTitle = new Map(remoteTasks.map(t => [t.title.toLowerCase(), t]));

    const merged = [];
    const processedLocalIds = new Set();
    let added = 0, updated = 0, removed = 0, localOnly = 0;

    // Process all remote tasks
    for (const rt of remoteTasks) {
        const localMatch = localById.get(rt.id) || localByTitle.get(rt.title.toLowerCase());
        if (localMatch) processedLocalIds.add(localMatch.id);
        const chosen = (localMatch && (localMatch.modifiedAt || '') >= (rt.modifiedAt || '')) ? localMatch : rt;
        if (isDead(chosen)) { removed++; continue; }
        if (!localMatch) added++;
        else if (chosen === rt) updated++;
        // A cópia vencedora pode vir de um dispositivo que ainda não gravava a
        // prioridade: nesse caso a ordem local é mantida, e não zerada.
        const out = { ...chosen };
        if (orderValue(out.order) === null && localMatch && orderValue(localMatch.order) !== null) out.order = orderValue(localMatch.order);
        merged.push(out);
    }

    // Process local-only tasks (absent from remote) — kept unless explicitly tombstoned
    for (const lt of localTasks) {
        if (processedLocalIds.has(lt.id)) continue;
        if (remoteByTitle.has(lt.title.toLowerCase())) continue;
        if (isDead(lt)) { removed++; continue; }
        merged.push({ ...lt });
        localOnly++;
    }

    return { merged, tombstones: pruneTombstones(tombs), added, updated, removed, localOnly };
}

function executeSyncImport() {
    const text = document.getElementById('syncImportText').value.trim();
    if (!text) { showSyncStatus('syncImportStatus', 'Cole o JSON antes de importar.', 'error'); return; }
    try {
        const incoming = parseImportedJSON(text); if (incoming.length === 0) throw new Error('Nenhuma tarefa válida.');
        if (syncImportMode === 'replace') {
            const now = nowISOGMT3();
            tasks = incoming.map(t => ({ ...t, id: genId(), createdAt: t.createdAt || now, modifiedAt: t.modifiedAt || now }));
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

// ─── GIST SYNC ───
function loadGistConfig() {
    if (!db || !currentUser) return null;
    const res = db.exec("SELECT gist_token, gist_id, auto_sync, last_sync FROM gist_config WHERE user_id = ?", [currentUser.id]);
    if (res.length > 0 && res[0].values.length > 0) {
        const r = res[0].values[0];
        return { token: r[0], gistId: r[1], autoSync: !!r[2], lastSync: r[3] || '' };
    }
    return null;
}

function extractGistId(input) {
    if (!input) return '';
    input = input.trim();
    const urlMatch = input.match(/gist\.github\.com\/(?:[^/]+\/)?([a-f0-9]+)/i);
    if (urlMatch) return urlMatch[1];
    if (/^[a-f0-9]+$/i.test(input)) return input;
    return input;
}

async function saveGistConfig() {
    if (!db || !currentUser) return;
    const token = document.getElementById('gistToken').value.trim();
    const rawUrl = document.getElementById('gistUrl').value.trim();
    const gistId = extractGistId(rawUrl);
    if (!token) { showSyncStatus('gistSyncStatus', 'Informe o GitHub Personal Access Token.', 'error'); return; }
    if (!gistId) { showSyncStatus('gistSyncStatus', 'Informe o ID ou URL do Gist.', 'error'); return; }
    db.run("INSERT OR REPLACE INTO gist_config (user_id, gist_token, gist_id, auto_sync, last_sync) VALUES (?, ?, ?, COALESCE((SELECT auto_sync FROM gist_config WHERE user_id = ?), 0), COALESCE((SELECT last_sync FROM gist_config WHERE user_id = ?), ''))",
        [currentUser.id, token, gistId, currentUser.id, currentUser.id]);
    await saveDBToIDB();
    showSyncStatus('gistSyncStatus', '✓ Configuração salva com sucesso.', 'success');
    refreshGistUI();
}

async function createNewGist() {
    const token = document.getElementById('gistToken').value.trim();
    if (!token) { showSyncStatus('gistSyncStatus', 'Informe o token antes de criar um novo Gist.', 'error'); return; }
    showSyncStatus('gistSyncStatus', 'Criando Gist...', 'info');
    try {
        const resp = await fetch('https://api.github.com/gists', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'TaskFlow Sync — ' + (currentUser.name || 'User'), public: false, files: buildGistFiles() }) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'HTTP ' + resp.status); }
        const data = await resp.json();
        const gistId = data.id;
        db.run("INSERT OR REPLACE INTO gist_config (user_id, gist_token, gist_id, auto_sync, last_sync) VALUES (?, ?, ?, 0, ?)", [currentUser.id, token, gistId, nowISOGMT3()]);
        await saveDBToIDB();
        document.getElementById('gistUrl').value = gistId;
        showSyncStatus('gistSyncStatus', `✓ Gist criado! ID: ${gistId}`, 'success');
        refreshGistUI();
    } catch (err) { showSyncStatus('gistSyncStatus', '✗ Erro ao criar Gist: ' + err.message, 'error'); }
}

async function testGistConnection() {
    const token = document.getElementById('gistToken').value.trim();
    const rawUrl = document.getElementById('gistUrl').value.trim();
    const gistId = extractGistId(rawUrl);
    if (!token || !gistId) { showSyncStatus('gistSyncStatus', 'Preencha token e ID/URL do Gist.', 'error'); return; }
    showSyncStatus('gistSyncStatus', 'Testando conexão...', 'info');
    try {
        const resp = await fetch('https://api.github.com/gists/' + gistId, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github.v3+json' } });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'HTTP ' + resp.status); }
        const data = await resp.json();
        const hasFile = data.files && data.files['taskflow.json'];
        const owner = data.owner ? data.owner.login : 'desconhecido';
        if (hasFile) { showSyncStatus('gistSyncStatus', `✓ Conexão OK! Gist de @${owner}, arquivo taskflow.json encontrado.`, 'success'); }
        else { showSyncStatus('gistSyncStatus', `⚠ Gist de @${owner} encontrado, mas sem arquivo taskflow.json.`, 'info'); }
    } catch (err) { showSyncStatus('gistSyncStatus', '✗ Falha na conexão: ' + err.message, 'error'); }
}

async function pushToGist() {
    const cfg = loadGistConfig();
    if (!cfg) { showSyncStatus('gistSyncStatus', 'Configure o Gist primeiro.', 'error'); return; }
    showSyncStatus('gistSyncStatus', 'Sincronizando com Gist...', 'info');
    try {
        // Pull and merge before pushing to avoid overwriting newer remote data
        const getResp = await fetch('https://api.github.com/gists/' + cfg.gistId, {
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (getResp.ok) {
            const getData = await getResp.json();
            const remoteTasks = readGistTasks(getData);
            if (remoteTasks) {
                const r = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(getData));
                tasks = r.merged; tombstones = r.tombstones;
                render();
            }
        }
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ files: buildGistFiles() }) });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'HTTP ' + resp.status); }
        await saveLocalState();
        const syncTime = nowISOGMT3();
        db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [syncTime, currentUser.id]);
        await saveDBToIDB();
        showSyncStatus('gistSyncStatus', `✓ ${tasks.length} tarefa(s) sincronizada(s) com o Gist.`, 'success');
        refreshGistUI();
    } catch (err) { showSyncStatus('gistSyncStatus', '✗ Erro ao sincronizar: ' + err.message, 'error'); }
}

async function pullFromGist() {
    const cfg = loadGistConfig();
    if (!cfg) { showSyncStatus('gistSyncStatus', 'Configure o Gist primeiro.', 'error'); return; }
    showSyncStatus('gistSyncStatus', 'Baixando do Gist...', 'info');
    try {
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, { headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' } });
        if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.message || 'HTTP ' + resp.status); }
        const data = await resp.json();
        const remoteTasks = readGistTasks(data);
        if (!remoteTasks) { showSyncStatus('gistSyncStatus', '⚠ Arquivo taskflow.json não encontrado no Gist.', 'info'); return; }
        const { merged, tombstones: ts, added, updated } = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(data));
        tasks = merged; tombstones = ts;
        render();
        await saveLocalState();
        const syncTime = nowISOGMT3();
        db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [syncTime, currentUser.id]);
        await saveDBToIDB();
        const parts = []; if (added) parts.push(`${added} adicionada(s)`); if (updated) parts.push(`${updated} atualizada(s)`); if (!added && !updated) parts.push('nenhuma alteração');
        showSyncStatus('gistSyncStatus', `✓ Mesclagem do Gist: ${parts.join(', ')}.`, 'success');
        refreshGistUI();
    } catch (err) { showSyncStatus('gistSyncStatus', '✗ Erro ao baixar: ' + err.message, 'error'); }
}

async function silentPushToGist() {
    if (!gistDataLoaded) return;
    const cfg = loadGistConfig();
    if (!cfg) return;
    clearTimeout(saveToStorage._gistTimer);
    try {
        // Pull remote first to avoid overwriting newer data
        const getResp = await fetch('https://api.github.com/gists/' + cfg.gistId, {
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!getResp.ok) {
            // Can't verify remote state — DON'T push (would risk clobbering remote).
            // Local cache already holds the change, so retry later instead of dropping it.
            scheduleSilentPushRetry();
            return;
        }
        const getData = await getResp.json();
        const remoteTasks = readGistTasks(getData);
        if (remoteTasks) {
            const r = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(getData));
            const changed = r.added > 0 || r.updated > 0 || r.removed > 0;
            tasks = r.merged; tombstones = r.tombstones;
            if (changed) render();
            clearTimeout(saveToStorage._gistTimer); // prevent re-push from autoUpdateStatuses
        }
        // Push merged result (tasks + tombstones)
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, { method: 'PATCH', headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }, body: JSON.stringify({ files: buildGistFiles() }) });
        if (resp.ok) {
            await saveLocalState();
            const syncTime = nowISOGMT3();
            db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [syncTime, currentUser.id]);
            await saveDBToIDB();
            const etag = resp.headers.get('ETag');
            if (etag) gistPoll.etag = etag;
        } else {
            scheduleSilentPushRetry();
        }
    } catch (err) { console.warn('Auto-sync failed:', err.message); scheduleSilentPushRetry(); }
}

function scheduleSilentPushRetry() {
    clearTimeout(saveToStorage._gistTimer);
    saveToStorage._gistTimer = setTimeout(() => silentPushToGist(), 30000);
}

async function toggleAutoSync(checked) {
    if (!db || !currentUser) return;
    db.run("UPDATE gist_config SET auto_sync = ? WHERE user_id = ?", [checked ? 1 : 0, currentUser.id]);
    await saveDBToIDB();
    if (checked) { startGistPolling(); } else { stopGistPolling(); }
}

async function clearGistConfig() {
    if (!confirm('Remover a configuração do Gist deste dispositivo?\n\n(O Gist no GitHub permanece intacto.)')) return;
    stopGistPolling();
    db.run("DELETE FROM gist_config WHERE user_id = ?", [currentUser.id]);
    await saveDBToIDB();
    showSyncStatus('gistSyncStatus', '✓ Configuração removida.', 'success');
    refreshGistUI();
}

function refreshGistUI() {
    const cfg = loadGistConfig();
    const badge = document.getElementById('gistStatusBadge');
    const configSection = document.getElementById('gistConfigSection');
    const syncSection = document.getElementById('gistSyncSection');
    const infoEl = document.getElementById('gistSyncInfo');

    if (cfg && cfg.token && cfg.gistId) {
        badge.innerHTML = '<span class="gist-connected">&#9679; Gist Conectado</span>';
        configSection.style.display = 'none';
        syncSection.style.display = 'block';
        document.getElementById('autoSyncCheck').checked = cfg.autoSync;
        let info = `<strong>Gist ID:</strong> <span class="last-sync">${cfg.gistId}</span>`;
        if (cfg.lastSync) { const d = new Date(cfg.lastSync); info += `<br><strong>Última sincronização:</strong> <span class="last-sync">${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR')}</span>`; }
        else { info += `<br><strong>Última sincronização:</strong> <em style="color:var(--text-dim)">nunca</em>`; }
        if (cfg.autoSync && gistPoll.running) { info += `<br><strong>Observador:</strong> <span style="color:var(--completed)">&#9679; ativo</span> <span style="color:var(--text-dim);font-size:11px">(polling 60s com ETag)</span>`; }
        info += `<br><br><button class="btn" style="font-size:11px;padding:4px 10px" onclick="showGistEditForm()">Alterar Configuração</button>`;
        infoEl.innerHTML = info;
    } else {
        badge.innerHTML = '<span class="gist-disconnected">&#9675; Gist não configurado</span>';
        configSection.style.display = 'block';
        syncSection.style.display = 'none';
        document.getElementById('gistToken').value = '';
        document.getElementById('gistUrl').value = '';
    }
}

function showGistEditForm() {
    const cfg = loadGistConfig();
    document.getElementById('gistConfigSection').style.display = 'block';
    if (cfg) { document.getElementById('gistToken').value = cfg.token; document.getElementById('gistUrl').value = cfg.gistId; }
}

// ─── GIST POLLING ───
const gistPoll = { etag: null, intervalId: null, INTERVAL_MS: 60000, running: false, lastCheck: 0 };

async function loadTasksFromGist() {
    // Always start from the durable local cache so nothing is lost if the Gist is
    // unreachable. The Gist is then MERGED in, never used as a blind replacement.
    const local = loadLocalState();
    tasks = local.tasks;
    tombstones = local.tombstones;
    initLogBaseline();
    const cfg = loadGistConfig();
    if (!cfg) { gistDataLoaded = true; return; }
    try {
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, {
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!resp.ok) { gistDataLoaded = true; return; } // offline — keep local cache, sync later
        const newEtag = resp.headers.get('ETag');
        if (newEtag) gistPoll.etag = newEtag;
        gistPoll.lastCheck = Date.now();
        const data = await resp.json();
        const remoteTasks = readGistTasks(data);
        if (!remoteTasks) { gistDataLoaded = true; return; }
        const { merged, tombstones: ts, localOnly } = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(data));
        tasks = merged;
        tombstones = ts;
        gistDataLoaded = true;
        await saveLocalState();
        db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [nowISOGMT3(), currentUser.id]);
        await saveDBToIDB();
        // Local cache had task(s) the Gist never received (e.g. an earlier failed push) —
        // push them up now so they are no longer at risk.
        if (localOnly > 0) saveToStorage();
    } catch (err) { console.warn('Failed to load tasks from Gist:', err.message); gistDataLoaded = true; }
}

function startGistPolling() {
    stopGistPolling();
    const cfg = loadGistConfig();
    if (!cfg || !cfg.autoSync) return;
    gistPoll.running = true;
    gistPoll.intervalId = setInterval(gistPollTick, gistPoll.INTERVAL_MS);
    setTimeout(gistPollTick, 3000);
}

function stopGistPolling() {
    if (gistPoll.intervalId) { clearInterval(gistPoll.intervalId); gistPoll.intervalId = null; }
    gistPoll.running = false;
    gistPoll.etag = null;
}

async function gistPollTick() {
    if (document.hidden) return;
    const cfg = loadGistConfig();
    if (!cfg || !cfg.autoSync) { stopGistPolling(); return; }
    try {
        const headers = { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' };
        if (gistPoll.etag) headers['If-None-Match'] = gistPoll.etag;
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, { headers });
        if (resp.status === 304) { gistPoll.lastCheck = Date.now(); return; }
        if (!resp.ok) return;
        const newEtag = resp.headers.get('ETag');
        if (newEtag) gistPoll.etag = newEtag;
        gistPoll.lastCheck = Date.now();
        const data = await resp.json();
        const remoteTasks = readGistTasks(data);
        if (!remoteTasks) return;
        const { merged, tombstones: ts, added, updated, removed } = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(data));
        if (added > 0 || updated > 0 || removed > 0) {
            tasks = merged;
            tombstones = ts;
            render();
            clearTimeout(saveToStorage._gistTimer);
            await saveLocalState();
            const syncTime = nowISOGMT3();
            db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [syncTime, currentUser.id]);
            await saveDBToIDB();
            showPollToast(added, updated);
        } else {
            tombstones = ts;
        }
    } catch (err) { console.warn('Gist poll error:', err.message); }
}

function showPollToast(added, updated) {
    let toast = document.getElementById('gistPollToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'gistPollToast';
        toast.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:9999;background:var(--surface-elevated);border:1px solid var(--completed-border);color:var(--completed);border-radius:10px;padding:10px 18px;font-family:'DM Sans',sans-serif;font-size:13px;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,0.3);opacity:0;transition:opacity 0.3s,transform 0.3s;transform:translateY(10px);pointer-events:none;`;
        document.body.appendChild(toast);
    }
    const parts = []; if (added) parts.push(`${added} nova(s)`); if (updated) parts.push(`${updated} atualizada(s)`);
    toast.textContent = '⟳ Gist sync: ' + parts.join(', ');
    toast.style.opacity = '1'; toast.style.transform = 'translateY(0)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)'; }, 4000);
}

async function reconcileOnReturn() {
    const cfg = loadGistConfig();
    if (!cfg) return;
    try {
        const resp = await fetch('https://api.github.com/gists/' + cfg.gistId, {
            headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!resp.ok) return;
        const etag = resp.headers.get('ETag');
        if (etag) gistPoll.etag = etag;
        gistPoll.lastCheck = Date.now();
        const data = await resp.json();
        const remoteTasks = readGistTasks(data);
        if (!remoteTasks) return;
        const { merged, tombstones: ts, added, updated, removed } = reconcileWithRemote(tasks, tombstones, remoteTasks, readGistTombstones(data));
        tombstones = ts;
        if (added > 0 || updated > 0 || removed > 0) {
            tasks = merged;
            gistDataLoaded = true;
            render();
            clearTimeout(saveToStorage._gistTimer);
            await saveLocalState();
            db.run("UPDATE gist_config SET last_sync = ? WHERE user_id = ?", [nowISOGMT3(), currentUser.id]);
            await saveDBToIDB();
        }
    } catch (err) { console.warn('Visibility sync failed:', err.message); }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden || !currentUser) return;
    const elapsed = Date.now() - gistPoll.lastCheck;
    if (elapsed > 2 * 60 * 1000) {
        reconcileOnReturn();
    } else if (gistPoll.running && elapsed > gistPoll.INTERVAL_MS) {
        setTimeout(gistPollTick, 500);
    }
});

// ─── KEYBOARD ───
function isTypingTarget(el) {
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

document.addEventListener('keydown', e => {
    const taskModalOpen = document.getElementById('taskModal').classList.contains('show');

    // Esc apenas fecha: com o autosave, o que foi digitado já está gravado.
    if (e.key === 'Escape') {
        closeModal(); closeSyncModal(); closeProfileModal(); closeMdViewer(); hideActionToast(); closePaletteMenus();
        return;
    }

    if (e.key === 'Enter') {
        // Ctrl/Cmd+Enter conclui de qualquer campo, inclusive da descrição.
        if (taskModalOpen && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closeModal(); return; }
        if (taskModalOpen && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); closeModal(); return; }
        const authVisible = document.getElementById('authScreen').style.display !== 'none';
        if (authVisible && document.getElementById('loginForm').classList.contains('active')) doLogin();
        if (authVisible && document.getElementById('registerForm').classList.contains('active')) doRegister();
        return;
    }

    // Atalhos globais: só com o app aberto, fora de campos de texto e sem modais.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!currentUser || isTypingTarget(e.target)) return;
    if (document.querySelector('.modal-overlay.show')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openModal(); }
    else if (e.key === '/') { e.preventDefault(); const si = document.getElementById('searchInput'); if (si) si.focus(); }
});

// ─── UTILS ───
function esc(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

// ─── PURGE OLD COMPLETED TASKS ───
function showPurgeToast(msg, type) {
    let toast = document.getElementById('purgeToast');
    if (!toast) { toast = document.createElement('div'); toast.id = 'purgeToast'; toast.className = 'purge-toast'; document.body.appendChild(toast); }
    toast.textContent = msg;
    toast.className = 'purge-toast ' + (type || 'info') + ' show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

async function purgeOldCompletedTasks(showConfirm = true) {
    const cutoffDate = new Date(Date.now() + TZ_OFFSET_MS);
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);
    const count = tasks.filter(t => t.status === 'Completed' && t.endDate <= cutoffStr).length;
    if (showConfirm) {
        if (count === 0) { showPurgeToast('✅ Nenhuma tarefa elegível para remoção.', 'info'); return 0; }
        const plural = count === 1 ? 'tarefa' : 'tarefas';
        const ok = window.confirm(`Remover ${count} ${plural} concluída(s)\ncujo término foi há mais de 30 dias?\n\n(referência: ${cutoffStr})\n\nEsta ação não pode ser desfeita.`);
        if (!ok) return 0;
    }
    if (count === 0) return 0;
    const purgeTs = nowISOGMT3();
    tasks.forEach(t => { if (t.status === 'Completed' && t.endDate <= cutoffStr) tombstones.push({ id: t.id, title: t.title, deletedAt: purgeTs }); });
    tasks = tasks.filter(t => !(t.status === 'Completed' && t.endDate <= cutoffStr));
    saveToStorage();
    render();
    if (showConfirm) { const plural2 = count === 1 ? 'tarefa removida' : 'tarefas removidas'; showPurgeToast(`🗑️ ${count} ${plural2} com sucesso.`, 'success'); }
    return count;
}

async function purgeOldCompletedTasksSilent() { return purgeOldCompletedTasks(false); }

// ─── STARTUP ───
(async function () {
    try {
        await initDatabase();
        document.getElementById('loadingScreen').style.display = 'none';
        const saved = sessionStorage.getItem('taskflow_user');
        if (saved) {
            try {
                currentUser = JSON.parse(saved);
                const res = db.exec("SELECT id, name, email FROM users WHERE id = ?", [currentUser.id]);
                if (res.length > 0 && res[0].values.length > 0) {
                    currentUser = { id: res[0].values[0][0], name: res[0].values[0][1], email: res[0].values[0][2] };
                    showApp();
                    return;
                }
            } catch (e) { }
        }
        document.getElementById('authScreen').style.display = 'flex';
    } catch (err) {
        document.getElementById('loadingScreen').innerHTML = `<div style="color:var(--overdue)">Erro ao carregar banco de dados:<br>${err.message}</div>`;
    }
})();
