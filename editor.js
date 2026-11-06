/* MARKDOWN + UI INTEGRATION SCRIPT
   Todas as funções ficam no escopo global (window) para que
   os atributos onclick= do HTML as encontrem corretamente. */
/* ── Configuração do marked.js (executada quando a lib carregar) ── */
function _initMarked() {
  if (typeof marked !== 'undefined') {
    marked.setOptions({ gfm: true, breaks: true });
  }
}
// marked é carregado com defer, então aguardamos DOMContentLoaded
document.addEventListener('DOMContentLoaded', _initMarked);

/* ── Utilitários internos ─────────────────────────────────── */
function _renderMd(text) {
  if (!text || !text.trim()) return '';
  _initMarked(); // idempotente
  if (typeof marked === 'undefined') return _escHtml(text);
  const raw = marked.parse(text);
  return (typeof DOMPurify !== 'undefined')
    ? DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
    : raw;
}

function _escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _mdToPlainText(md) {
  if (!md) return '';
  return md
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/`{1,3}[\s\S]*?`{1,3}/g, '')
    .replace(/#{1,6} /g, '')
    .replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^[-*+] /gm, '')
    .replace(/^\d+\. /gm, '')
    .replace(/^> /gm, '')
    .replace(/\n+/g, ' ')
    .trim();
}

function _hasMdFormatting(text) {
  if (!text) return false;
  return /(\*{1,2}|_{1,2}|`|^#{1,6} |^- |\[.*?\]\(|^> |~~|\n)/m.test(text);
}

/* ── VIEWER MODAL ─────────────────────────────────────────── */
function openMdViewer(title, mdText) {
  document.getElementById('mdViewerTitle').textContent = title || 'Descrição';
  const content = document.getElementById('mdViewerContent');
  const html = _renderMd(mdText);
  content.innerHTML = html || '<p style="color:var(--text-dim);font-style:italic">Sem descrição.</p>';
  document.getElementById('mdViewerModal').classList.add('show');
}

function closeMdViewer() {
  document.getElementById('mdViewerModal').classList.remove('show');
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('mdViewerModal').addEventListener('click', function (e) {
    if (e.target === this) closeMdViewer();
  });
});

/* ── EDITOR: abas Editar / Preview ───────────────────────── */
function switchMdTab(tab) {
  const ta = document.getElementById('taskDesc');
  const preview = document.getElementById('mdPreviewPane');
  const toolbarContent = document.getElementById('mdToolbarContent');
  const chevron = document.getElementById('mdToolbarChevron');
  const btnEdit = document.getElementById('mdTabEdit');
  const btnPrev = document.getElementById('mdTabPreview');
  const hint = document.querySelector('.md-hint');

  if (tab === 'preview') {
    const html = _renderMd(ta.value);
    preview.innerHTML = html || '<p style="color:var(--text-dim);font-style:italic">Nada para visualizar ainda.</p>';
    ta.style.display = 'none';
    toolbarContent.style.display = 'none';
    if (chevron) chevron.style.display = 'none';
    if (hint) hint.style.display = 'none';
    preview.classList.add('active');
    btnEdit.classList.remove('active');
    btnPrev.classList.add('active');
  } else {
    ta.style.display = '';
    toolbarContent.style.display = '';
    if (chevron) chevron.style.display = '';
    if (hint) hint.style.display = '';
    preview.classList.remove('active');
    btnEdit.classList.add('active');
    btnPrev.classList.remove('active');
    ta.focus();
  }
}

/* ── COLLAPSIBLE TOOLBAR ─────────────────────────────────── */
function toggleMdToolbar() {
  const chevron = document.getElementById('mdToolbarChevron');
  const content = document.getElementById('mdToolbarContent');
  const isExpanded = chevron.classList.contains('expanded');
  if (isExpanded) {
    chevron.classList.remove('expanded');
    content.classList.remove('expanded');
  } else {
    chevron.classList.add('expanded');
    content.classList.add('expanded');
  }
}

function _resetMdToolbar() {
  const chevron = document.getElementById('mdToolbarChevron');
  const content = document.getElementById('mdToolbarContent');
  if (chevron) chevron.classList.remove('expanded');
  if (content) content.classList.remove('expanded');
}

/* ── BARRA DE FERRAMENTAS MARKDOWN ───────────────────────── */
function mdInsert(before, after) {
  const ta = document.getElementById('taskDesc');
  if (!ta || ta.style.display === 'none') return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || 'texto';
  ta.setRangeText(before + sel + after, s, e, 'select');
  if (s === e) {
    ta.selectionStart = s + before.length;
    ta.selectionEnd   = s + before.length + sel.length;
  }
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function mdInsertLine(prefix) {
  const ta = document.getElementById('taskDesc');
  if (!ta || ta.style.display === 'none') return;
  const s = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
  ta.setRangeText(prefix, lineStart, lineStart, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function mdInsertBlock(before, after) {
  const ta = document.getElementById('taskDesc');
  if (!ta || ta.style.display === 'none') return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || 'código aqui';
  ta.setRangeText(before + sel + after, s, e, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

function mdInsertLink() {
  const ta = document.getElementById('taskDesc');
  if (!ta || ta.style.display === 'none') return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  const sel = ta.value.substring(s, e) || 'texto do link';
  ta.setRangeText('[' + sel + '](https://)', s, e, 'end');
  ta.focus();
  ta.dispatchEvent(new Event('input'));
}

/* ── ATALHOS DE TECLADO no editor ────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  const ta = document.getElementById('taskDesc');
  if (!ta) return;
  ta.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'b') { e.preventDefault(); mdInsert('**', '**'); }
      if (e.key === 'i') { e.preventDefault(); mdInsert('*', '*'); }
      if (e.key === 'k') { e.preventDefault(); mdInsertLink(); }
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.setRangeText('  ', s, end, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
});

/* ── RESET DO EDITOR AO ABRIR O MODAL ────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  const taskModalEl = document.getElementById('taskModal');
  if (!taskModalEl) return;
  new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      if (m.attributeName === 'class' && taskModalEl.classList.contains('show')) {
        setTimeout(function () {
          switchMdTab('edit');
          _resetMdToolbar();
        }, 0);
      }
    });
  }).observe(taskModalEl, { attributes: true });
});

/* ── STATUS POR BOTÕES ───────────────────────────────────── */
/**
 * Define o status ativo no grupo de botões e atualiza o campo oculto.
 * Chamado pelos onclick dos botões e também pelo app.js ao abrir o modal.
 */
function setTaskStatus(status, silent) {
  document.getElementById('taskStatus').value = status;
  document.querySelectorAll('#statusBtnGroup .status-btn').forEach(function (btn) {
    var on = btn.dataset.status === status;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  // Escolha discreta: grava na hora, sem esperar o debounce da digitação.
  if (!silent && window.notifyDraftChange) window.notifyDraftChange({ immediate: true });
}

/**
 * Lê o valor do campo oculto. Compatibilidade retroativa:
 * o app.js pode chamar document.getElementById('taskStatus').value diretamente,
 * pois o campo hidden é mantido em sincronia.
 */
function getTaskStatusValue() {
  return document.getElementById('taskStatus').value || 'To Do';
}

/* ── PRIORIDADE POR BOTÕES ───────────────────────────────── */
/** Mesmo padrão do status: botão ativo + campo oculto lido pelo app.js. */
function setTaskPriorityInput(priority, silent) {
  document.getElementById('taskPriority').value = priority;
  document.querySelectorAll('#priorityBtnGroup .status-btn').forEach(function (btn) {
    var on = btn.dataset.priority === priority;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  if (!silent && window.notifyDraftChange) window.notifyDraftChange({ immediate: true });
}

function getTaskPriorityValue() {
  return document.getElementById('taskPriority').value || 'medium';
}

/* ── RECORRÊNCIA ─────────────────────────────────────────── */
/**
 * Um só caminho para os três controles (marcar, intervalo, unidade): grava na
 * hora, como status e datas, e reescreve a prévia do próximo pulo.
 */
function handleRecurrenceInput() {
  const on = document.getElementById('taskRecurring').checked;
  document.getElementById('recurFields').hidden = !on;
  if (window.notifyDraftChange) window.notifyDraftChange({ immediate: true });
}

/** Lê a recorrência do formulário — null quando a caixa está desmarcada. */
function getTaskRecurrence() {
  if (!document.getElementById('taskRecurring').checked) return null;
  const n = parseInt(document.getElementById('taskRecurInterval').value, 10);
  return { interval: (isNaN(n) || n < 1) ? 1 : n, unit: document.getElementById('taskRecurUnit').value };
}

/** Preenche os campos ao abrir/reverter uma tarefa (chamado pelo app.js). */
function setTaskRecurrence(rec) {
  document.getElementById('taskRecurring').checked = !!rec;
  document.getElementById('recurFields').hidden = !rec;
  document.getElementById('taskRecurInterval').value = rec ? rec.interval : 1;
  document.getElementById('taskRecurUnit').value = rec ? rec.unit : 'week';
}

/* ── INVERSÃO AUTOMÁTICA DE DATAS ────────────────────────── */
function handleDateInput() {
  const startEl  = document.getElementById('taskStart');
  const endEl    = document.getElementById('taskEnd');
  const notice   = document.getElementById('dateSwapNotice');
  const s = startEl.value, e = endEl.value;
  if (s && e && s > e) {
    startEl.value = e;
    endEl.value   = s;
    notice.classList.add('show');
    // Esconde o aviso após 3 s
    clearTimeout(handleDateInput._timer);
    handleDateInput._timer = setTimeout(function () {
      notice.classList.remove('show');
    }, 3000);
  } else {
    notice.classList.remove('show');
  }
  if (window.notifyDraftChange) window.notifyDraftChange({ immediate: true });
}

/* ── API PÚBLICA (chamada pelo app.js) ───────────────────── */

/**
 * Configura a célula de descrição na tabela.
 * Chame em app.js ao gerar cada <td> de descrição.
 */
window.setupDescCell = function (td, taskTitle, desc) {
  td.classList.add('task-desc-cell');
  const plain = _mdToPlainText(desc);
  td.textContent = plain || '—';
  if (_hasMdFormatting(desc)) {
    td.classList.add('has-md');
  } else {
    td.classList.remove('has-md');
  }
  if (desc && desc.trim()) {
    td.setAttribute('title', 'Clique para ver a descrição completa');
    td.onclick = function (e) {
      e.stopPropagation();
      openMdViewer(taskTitle, desc);
    };
  } else {
    td.removeAttribute('title');
    td.onclick = null;
  }
};

/**
 * Preenche a descrição no tooltip do Gantt com Markdown renderizado.
 */
window.setGanttTooltipDesc = function (text) {
  const el = document.getElementById('ttDesc');
  if (!el) return;
  el.innerHTML = text ? _renderMd(text) : '';
};

/** Renderiza Markdown para HTML sanitizado (uso geral no app.js). */
window.renderMarkdown = _renderMd;

/** Converte Markdown para texto simples. */
window.mdToPlain = _mdToPlainText;

/** Abre/fecha o viewer de descrição. */
window.openMdViewer  = openMdViewer;
window.closeMdViewer = closeMdViewer;

/** Expõe setTaskStatus para o app.js poder setar o status ao editar uma tarefa. */
window.setTaskStatus     = setTaskStatus;
window.getTaskStatusValue = getTaskStatusValue;

/** Recorrência: lida na gravação e escrita ao abrir/reverter a tarefa. */
window.getTaskRecurrence = getTaskRecurrence;
window.setTaskRecurrence = setTaskRecurrence;

/** Prioridade: lida na gravação e escrita ao abrir/reverter a tarefa. */
window.setTaskPriorityInput = setTaskPriorityInput;
window.getTaskPriorityValue = getTaskPriorityValue;
