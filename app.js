// Public anon key — intentionally client-visible. Access is enforced by
// Row Level Security policies in Supabase, not by keeping this secret.
// Lives in the "worklog" Supabase project (not "lifelog") since this is a
// work-related app for the R&D team, same as WorkLog itself.
const SUPA_URL = 'https://uhlbrxyvhfmfeakckzlu.supabase.co';
const SUPA_KEY = 'sb_publishable_ddVyqs4A4o9j2WsUkDHeZQ_6UskvhMg';
const TABLE = 'pinboard_notes';

const supa = supabase.createClient(SUPA_URL, SUPA_KEY);

// Soft gate only — this is a small trusted team board, not real security.
// Change this if you want a different shared admin PIN.
const ADMIN_PIN = 'alex456';

let notes = [];
let pinnedIds = new Set();
let isAdmin = false;
let undoStack = [];
let redoStack = [];

const board = document.getElementById('board');
const doneBoard = document.getElementById('done-board');
const donePanel = document.getElementById('done-panel');
const binIcon = document.getElementById('bin-icon');
const stampTool = document.getElementById('stamp-tool');
const doneCountBadge = document.getElementById('done-count-badge');
const connStatus = document.getElementById('conn-status');

const modal = document.getElementById('note-modal');
const modalTitle = document.getElementById('modal-title');
const modalError = document.getElementById('modal-error');
const fWorkName = document.getElementById('f-work-name');
const fDueDate = document.getElementById('f-due-date');
const fOperator = document.getElementById('f-operator');
const fRequestedBy = document.getElementById('f-requested-by');
const fDetail = document.getElementById('f-detail');

const btnUndo = document.getElementById('btn-undo');
const btnRedo = document.getElementById('btn-redo');
const btnNew = document.getElementById('btn-new');
const btnSave = document.getElementById('btn-save');
const btnCancel = document.getElementById('btn-cancel');
const btnDelete = document.getElementById('btn-delete');
const btnMarkDone = document.getElementById('btn-mark-done');
const btnReopen = document.getElementById('btn-reopen');
const btnLock = document.getElementById('btn-lock');
const lockedNotice = document.getElementById('locked-notice');

const adminToggle = document.getElementById('admin-toggle');
const pinModal = document.getElementById('pin-modal');
const fAdminPin = document.getElementById('f-admin-pin');
const pinError = document.getElementById('pin-error');
const btnPinCancel = document.getElementById('btn-pin-cancel');
const btnPinSubmit = document.getElementById('btn-pin-submit');

let editingId = null; // null = creating a new note

// ---------- helpers ----------

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

const NOTE_COLORS = [
  { bg: '#fff7b2', tag: '#5b3a29' }, // yellow
  { bg: '#ffd6e8', tag: '#7a2a4a' }, // pink
  { bg: '#ffe0b2', tag: '#7a4a10' }, // orange
  { bg: '#d4f7c5', tag: '#1f5c2a' }, // green
  { bg: '#c5e3f7', tag: '#1f4a7a' }, // blue
  { bg: '#e0c5f7', tag: '#5a1f7a' }, // purple
  { bg: '#ffcab0', tag: '#7a3010' }, // peach
  { bg: '#b2f7e0', tag: '#0f5c4a' }, // mint
  { bg: '#f7c5d4', tag: '#7a1f3a' }, // rose
  { bg: '#d9d4f7', tag: '#3a2a7a' }, // lavender
];

function operatorColor(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return NOTE_COLORS[0];
  return NOTE_COLORS[hashString(trimmed.toLowerCase()) % NOTE_COLORS.length];
}

function rotationFor(id) {
  return (hashString(id) % 7) - 3; // -3..3 degrees
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function isOverdue(note) {
  return note.status === 'open' && note.due_date && note.due_date < todayStr();
}

const DUE_SOON_DAYS = 2;

function daysUntil(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00');
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function isDueSoon(note) {
  if (isOverdue(note) || note.status !== 'open' || !note.due_date) return false;
  const d = daysUntil(note.due_date);
  return d >= 0 && d <= DUE_SOON_DAYS;
}

function formatDate(dateStr) {
  if (!dateStr) return 'No due date';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function setConnStatus(state, text) {
  connStatus.className = 'conn-status conn-' + state;
  connStatus.textContent = text;
}

// ---------- rendering ----------

let dragState = null; // { id, card, startX, startY, origLeft, origTop, moved }
let reopenDrag = null; // { id, ghost, startX, startY, moved }
let stampDrag = null; // { ghost, targetCard }
const animatingIds = new Set(); // notes mid-"stamp then move to bin" animation
const defaultPosAssigned = new Set();

function defaultPositionFor(index) {
  const col = index % 5;
  const row = Math.floor(index / 5);
  return { x: 30 + col * 220, y: 30 + row * 200 };
}

// ---------- undo / redo ----------
// Tracks this client's own edits only (not other PCs' synced changes —
// applyRealtimeChange never calls pushUndo). 'create'/'delete' re-insert
// or remove the whole row (re-insert reuses the original id so anything
// else referencing it stays valid); everything else is a column-level
// before/after patch applied via the same update path.

function pushUndo(action) {
  undoStack.push(action);
  redoStack = [];
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  btnUndo.disabled = undoStack.length === 0;
  btnRedo.disabled = redoStack.length === 0;
}

async function revertAction(action, toBefore) {
  const { kind, id } = action;
  if (kind === 'create') {
    if (toBefore) {
      await supa.from(TABLE).delete().eq('id', id);
      notes = notes.filter((n) => n.id !== id);
    } else {
      const { data, error } = await supa.from(TABLE).insert(action.data).select().single();
      if (error) throw error;
      notes.push(data);
    }
  } else if (kind === 'delete') {
    if (toBefore) {
      const { data, error } = await supa.from(TABLE).insert(action.data).select().single();
      if (error) throw error;
      notes.push(data);
    } else {
      await supa.from(TABLE).delete().eq('id', id);
      notes = notes.filter((n) => n.id !== id);
    }
  } else {
    const fields = toBefore ? action.before : action.after;
    const { data, error } = await supa.from(TABLE).update(fields).eq('id', id).select().single();
    if (error) throw error;
    notes = notes.map((n) => (n.id === data.id ? data : n));
    if (pinnedIds.has(id)) window.pinAPI.refresh(data);
  }
  renderBoard();
}

async function undo() {
  if (!undoStack.length) return;
  const action = undoStack.pop();
  try {
    await revertAction(action, true);
    redoStack.push(action);
  } catch (err) {
    undoStack.push(action);
    showError('Undo failed: ' + err.message);
  }
  updateUndoRedoButtons();
}

async function redo() {
  if (!redoStack.length) return;
  const action = redoStack.pop();
  try {
    await revertAction(action, false);
    undoStack.push(action);
  } catch (err) {
    redoStack.push(action);
    showError('Redo failed: ' + err.message);
  }
  updateUndoRedoButtons();
}

async function persistPosition(id, x, y, trackUndo = true) {
  const before = notes.find((n) => n.id === id);
  const { data, error } = await supa.from(TABLE).update({ pos_x: x, pos_y: y }).eq('id', id).select().single();
  if (!error) {
    notes = notes.map((n) => (n.id === data.id ? data : n));
    if (trackUndo && before && (before.pos_x !== x || before.pos_y !== y)) {
      pushUndo({ kind: 'position', id, before: { pos_x: before.pos_x, pos_y: before.pos_y }, after: { pos_x: x, pos_y: y } });
    }
  }
}

function renderBoard() {
  if (dragState || animatingIds.size) return; // don't rebuild the DOM mid-drag/animation

  const open = notes.filter((n) => n.status !== 'done')
    .sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
    });
  const done = notes.filter((n) => n.status === 'done')
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

  board.innerHTML = '';
  open.forEach((note, idx) => {
    const card = buildCard(note, true);
    let { pos_x: x, pos_y: y } = note;
    if (x == null || y == null) {
      const def = defaultPositionFor(idx);
      x = def.x;
      y = def.y;
      if (!defaultPosAssigned.has(note.id)) {
        defaultPosAssigned.add(note.id);
        persistPosition(note.id, x, y, false);
      }
    }
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    board.appendChild(card);
  });

  doneBoard.innerHTML = '';
  done.forEach((note) => doneBoard.appendChild(buildCard(note, false)));
  doneCountBadge.textContent = String(done.length);
  doneCountBadge.classList.toggle('hidden', done.length === 0);
}

function isOverBin(clientX, clientY) {
  const rect = binIcon.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function isOverBoard(clientX, clientY) {
  const rect = board.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

// Plays the stamp animation in place on the board, then commits the
// status change — without this, a note marked done just vanishes
// instantly with no feedback.
async function animateStampThenComplete(id, card) {
  animatingIds.add(id);
  const stamp = document.createElement('div');
  stamp.className = 'done-stamp stamp-animate';
  stamp.textContent = 'Done / เสร็จ';
  card.appendChild(stamp);
  await new Promise((r) => setTimeout(r, 550));
  animatingIds.delete(id);
  try {
    await updateNoteStatus(id, 'done');
  } catch (err) {
    showError(err.message || 'Failed to mark note done.');
    renderBoard();
  }
}

function startReopenDrag(note, e, originalCard) {
  const ghost = originalCard.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.position = 'fixed';
  ghost.style.left = e.clientX - 100 + 'px';
  ghost.style.top = e.clientY - 20 + 'px';
  ghost.style.pointerEvents = 'none';
  ghost.style.zIndex = '2000';
  ghost.style.width = '200px';
  ghost.style.transform = 'none';
  document.body.appendChild(ghost);
  originalCard.style.opacity = '0.25';
  reopenDrag = { id: note.id, ghost, originalCard, startX: e.clientX, startY: e.clientY, moved: false };
}

async function reopenNote(id, x, y) {
  try {
    await updateNoteStatus(id, 'open');
    await persistPosition(id, Math.max(10, x), Math.max(10, y), false);
  } catch (err) {
    showError(err.message || 'Failed to reopen note.');
  }
}

document.addEventListener('mousemove', (e) => {
  if (dragState) {
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
    const maxLeft = board.clientWidth - dragState.card.offsetWidth - 4;
    const maxTop = board.clientHeight - dragState.card.offsetHeight - 4;
    const left = Math.min(Math.max(0, dragState.origLeft + dx), Math.max(0, maxLeft));
    const top = Math.min(Math.max(0, dragState.origTop + dy), Math.max(0, maxTop));
    dragState.card.style.left = left + 'px';
    dragState.card.style.top = top + 'px';
    binIcon.classList.toggle('drag-over', dragState.moved && isOverBin(e.clientX, e.clientY));
  } else if (reopenDrag) {
    const dx = e.clientX - reopenDrag.startX;
    const dy = e.clientY - reopenDrag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) reopenDrag.moved = true;
    reopenDrag.ghost.style.left = e.clientX - 100 + 'px';
    reopenDrag.ghost.style.top = e.clientY - 20 + 'px';
  } else if (stampDrag) {
    stampDrag.ghost.style.left = e.clientX - 24 + 'px';
    stampDrag.ghost.style.top = e.clientY - 24 + 'px';
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('#board .note-card:not(.done)');
    if (target !== stampDrag.targetCard) {
      if (stampDrag.targetCard) stampDrag.targetCard.classList.remove('stamp-target');
      if (target) target.classList.add('stamp-target');
      stampDrag.targetCard = target || null;
    }
  }
});

document.addEventListener('mouseup', (e) => {
  if (dragState) {
    const { id, card, moved } = dragState;
    card.classList.remove('dragging-card');
    card.style.zIndex = '';
    binIcon.classList.remove('drag-over');
    if (moved && isOverBin(e.clientX, e.clientY)) {
      card.dataset.justDragged = '1';
      animateStampThenComplete(id, card);
    } else if (moved) {
      card.dataset.justDragged = '1';
      persistPosition(id, parseFloat(card.style.left), parseFloat(card.style.top));
    }
    dragState = null;
  } else if (reopenDrag) {
    const { id, ghost, originalCard, moved } = reopenDrag;
    ghost.remove();
    if (moved && isOverBoard(e.clientX, e.clientY)) {
      // Leave it dimmed — the upcoming re-render removes it from the
      // done panel once the status flips, so no need to restore it.
      const rect = board.getBoundingClientRect();
      reopenNote(id, e.clientX - rect.left - 100 + board.scrollLeft, e.clientY - rect.top - 20 + board.scrollTop);
    } else {
      originalCard.style.opacity = '';
      if (!moved) {
        const note = notes.find((n) => n.id === id);
        if (note) openEditModal(note);
      }
    }
    reopenDrag = null;
  } else if (stampDrag) {
    const { ghost, targetCard } = stampDrag;
    ghost.remove();
    if (targetCard) {
      targetCard.classList.remove('stamp-target');
      animateStampThenComplete(targetCard.dataset.id, targetCard);
    }
    stampDrag = null;
  }
});

stampTool.addEventListener('mousedown', (e) => {
  const ghost = document.createElement('div');
  ghost.className = 'stamp-drag-ghost';
  ghost.textContent = '✔️';
  ghost.style.left = e.clientX - 24 + 'px';
  ghost.style.top = e.clientY - 24 + 'px';
  document.body.appendChild(ghost);
  stampDrag = { ghost, targetCard: null };
});

function buildCard(note, freeform) {
  const card = document.createElement('div');
  card.dataset.id = note.id;
  card.className = 'note-card'
    + (note.status === 'done' ? ' done' : '')
    + (isOverdue(note) ? ' overdue' : '')
    + (isDueSoon(note) ? ' due-soon' : '');
  const colors = operatorColor(note.operator);
  card.style.backgroundColor = colors.bg;
  card.style.transform = `rotate(${rotationFor(note.id)}deg)`;

  if (freeform) {
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('.pin-toggle')) return;
      if (note.locked && !isAdmin) return;
      dragState = {
        id: note.id,
        card,
        startX: e.clientX,
        startY: e.clientY,
        origLeft: parseFloat(card.style.left) || 0,
        origTop: parseFloat(card.style.top) || 0,
        moved: false,
      };
      card.classList.add('dragging-card');
      card.style.zIndex = 1000;
    });

    card.addEventListener('click', () => {
      if (card.dataset.justDragged === '1') {
        card.dataset.justDragged = '';
        return;
      }
      openEditModal(note);
    });
  } else {
    // Done-pile cards: dragging them out onto the board reopens them;
    // a plain click (no movement) opens the detail modal instead.
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('.pin-toggle')) return;
      startReopenDrag(note, e, card);
    });
  }

  const pinBtn = document.createElement('button');
  pinBtn.className = 'pin-toggle' + (pinnedIds.has(note.id) ? ' pinned' : '');
  pinBtn.title = pinnedIds.has(note.id) ? 'Unpin from desktop' : 'Pin to desktop';
  pinBtn.textContent = '📌';
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePin(note);
  });
  card.appendChild(pinBtn);

  const workName = document.createElement('div');
  workName.className = 'work-name';
  workName.textContent = note.work_name;
  card.appendChild(workName);

  const due = document.createElement('div');
  due.className = 'due-date';
  due.textContent = (note.locked ? '🔒 ' : '') + (isOverdue(note) ? '⚠ ' : '') + formatDate(note.due_date);
  card.appendChild(due);

  if (note.requested_by) {
    const req = document.createElement('div');
    req.className = 'meta-line';
    req.textContent = 'From: ' + note.requested_by;
    card.appendChild(req);
  }

  if (note.operator) {
    const tag = document.createElement('div');
    tag.className = 'operator-tag';
    tag.textContent = note.operator;
    tag.style.color = colors.tag;
    card.appendChild(tag);
  }

  if (note.status === 'done') {
    const stamp = document.createElement('div');
    stamp.className = 'done-stamp';
    stamp.textContent = 'Done / เสร็จ';
    card.appendChild(stamp);
  }

  return card;
}

// ---------- desktop pins ----------

async function togglePin(note) {
  if (pinnedIds.has(note.id)) {
    await window.pinAPI.close(note.id);
    pinnedIds.delete(note.id);
  } else {
    await window.pinAPI.open(note);
    pinnedIds.add(note.id);
  }
  renderBoard();
}

async function restorePins() {
  const pins = await window.pinAPI.list();
  pinnedIds = new Set(Object.keys(pins));
  for (const note of notes) {
    if (pinnedIds.has(note.id)) window.pinAPI.open(note);
  }
  renderBoard();
}

window.pinAPI.onOpenDetail((noteId) => {
  const note = notes.find((n) => n.id === noteId);
  if (note) openEditModal(note);
});

window.pinAPI.onUnpinned((noteId) => {
  if (pinnedIds.delete(noteId)) renderBoard();
});

// ---------- modal ----------

function openNewModal() {
  editingId = null;
  modalTitle.textContent = 'New Note / โน้ตใหม่';
  fWorkName.value = '';
  fDueDate.value = '';
  fOperator.value = '';
  fRequestedBy.value = '';
  fDetail.value = '';
  [fWorkName, fDueDate, fOperator, fRequestedBy, fDetail].forEach((el) => { el.disabled = false; });
  lockedNotice.classList.add('hidden');
  btnSave.classList.remove('hidden');
  btnLock.classList.add('hidden');
  hideError();
  btnDelete.classList.add('hidden');
  btnMarkDone.classList.add('hidden');
  btnReopen.classList.add('hidden');
  modal.classList.remove('hidden');
  fWorkName.focus();
}

function openEditModal(note) {
  editingId = note.id;
  modalTitle.textContent = 'Edit Note / แก้ไขโน้ต';
  fWorkName.value = note.work_name || '';
  fDueDate.value = note.due_date || '';
  fOperator.value = note.operator || '';
  fRequestedBy.value = note.requested_by || '';
  fDetail.value = note.detail || '';
  hideError();
  btnDelete.classList.remove('hidden');
  if (note.status === 'done') {
    btnMarkDone.classList.add('hidden');
    btnReopen.classList.remove('hidden');
  } else {
    btnMarkDone.classList.remove('hidden');
    btnReopen.classList.add('hidden');
  }

  const lockedForMe = note.locked && !isAdmin;
  [fWorkName, fDueDate, fOperator, fRequestedBy, fDetail].forEach((el) => {
    el.disabled = lockedForMe;
  });
  lockedNotice.classList.toggle('hidden', !lockedForMe);
  btnSave.classList.toggle('hidden', lockedForMe);

  if (isAdmin) {
    btnLock.classList.remove('hidden');
    btnLock.textContent = note.locked ? '🔓 Unlock / ปลดล็อก' : '🔒 Lock / ล็อก';
  } else {
    btnLock.classList.add('hidden');
  }

  modal.classList.remove('hidden');
}

async function toggleLock() {
  if (!editingId) return;
  const current = notes.find((n) => n.id === editingId);
  if (!current) return;
  try {
    const nextLocked = !current.locked;
    const { data, error } = await supa.from(TABLE).update({ locked: nextLocked }).eq('id', editingId).select().single();
    if (error) throw error;
    notes = notes.map((n) => (n.id === data.id ? data : n));
    pushUndo({ kind: 'lock', id: editingId, before: { locked: current.locked }, after: { locked: nextLocked } });
    renderBoard();
    openEditModal(data);
  } catch (err) {
    showError(err.message || 'Failed to update lock state.');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  editingId = null;
}

function showError(msg) {
  modalError.textContent = msg;
  modalError.classList.remove('hidden');
}
function hideError() {
  modalError.classList.add('hidden');
}

// ---------- actions ----------

async function saveNote() {
  const work_name = fWorkName.value.trim();
  if (!work_name) {
    showError('Name of work is required.');
    return;
  }
  const payload = {
    work_name,
    due_date: fDueDate.value || null,
    operator: fOperator.value.trim() || null,
    requested_by: fRequestedBy.value.trim() || null,
    detail: fDetail.value.trim() || null,
  };

  btnSave.disabled = true;
  try {
    if (editingId) {
      const before = notes.find((n) => n.id === editingId);
      const { data, error } = await supa.from(TABLE).update(payload).eq('id', editingId).select().single();
      if (error) throw error;
      notes = notes.map((n) => (n.id === data.id ? data : n));
      if (before) {
        pushUndo({
          kind: 'edit',
          id: editingId,
          before: {
            work_name: before.work_name,
            due_date: before.due_date,
            operator: before.operator,
            requested_by: before.requested_by,
            detail: before.detail,
          },
          after: payload,
        });
      }
    } else {
      const { data, error } = await supa.from(TABLE).insert(payload).select().single();
      if (error) throw error;
      notes.push(data);
      pushUndo({ kind: 'create', id: data.id, data });
    }
    renderBoard();
    closeModal();
  } catch (err) {
    showError(err.message || 'Failed to save note.');
  } finally {
    btnSave.disabled = false;
  }
}

async function deleteNote() {
  if (!editingId) return;
  if (!window.confirm('Delete this note? (Ctrl+Z to undo)')) return;
  const before = notes.find((n) => n.id === editingId);
  try {
    const { error } = await supa.from(TABLE).delete().eq('id', editingId);
    if (error) throw error;
    notes = notes.filter((n) => n.id !== editingId);
    if (before) pushUndo({ kind: 'delete', id: editingId, data: before });
    if (pinnedIds.has(editingId)) {
      await window.pinAPI.close(editingId);
      pinnedIds.delete(editingId);
    }
    renderBoard();
    closeModal();
  } catch (err) {
    showError(err.message || 'Failed to delete note.');
  }
}

async function updateNoteStatus(id, status) {
  const before = notes.find((n) => n.id === id);
  const { data, error } = await supa.from(TABLE).update({ status }).eq('id', id).select().single();
  if (error) throw error;
  notes = notes.map((n) => (n.id === data.id ? data : n));
  if (before && before.status !== status) {
    pushUndo({ kind: 'status', id, before: { status: before.status }, after: { status } });
  }
  if (pinnedIds.has(data.id)) {
    if (status === 'done') {
      // No point keeping a finished task pinned to the desktop.
      await window.pinAPI.close(data.id);
      pinnedIds.delete(data.id);
    } else {
      window.pinAPI.refresh(data);
    }
  }
  renderBoard();
  return data;
}

async function setStatus(status) {
  if (!editingId) return;
  if (status === 'done') {
    const id = editingId;
    const card = board.querySelector(`[data-id="${id}"]`);
    closeModal();
    if (card) {
      await animateStampThenComplete(id, card);
    } else {
      try {
        await updateNoteStatus(id, 'done');
      } catch (err) {
        console.error('Failed to mark note done:', err.message);
      }
    }
    return;
  }
  try {
    await updateNoteStatus(editingId, status);
    closeModal();
  } catch (err) {
    showError(err.message || 'Failed to update note.');
  }
}

// ---------- data sync ----------

async function fetchNotes() {
  const { data, error } = await supa.from(TABLE).select('*');
  if (error) {
    setConnStatus('error', 'load failed');
    console.error(error);
    return;
  }
  notes = data;
  renderBoard();
}

function applyRealtimeChange(payload) {
  if (payload.eventType === 'INSERT') {
    if (!notes.some((n) => n.id === payload.new.id)) notes.push(payload.new);
  } else if (payload.eventType === 'UPDATE') {
    notes = notes.map((n) => (n.id === payload.new.id ? payload.new : n));
    if (pinnedIds.has(payload.new.id)) {
      if (payload.new.status === 'done') {
        window.pinAPI.close(payload.new.id);
        pinnedIds.delete(payload.new.id);
      } else {
        window.pinAPI.refresh(payload.new);
      }
    }
  } else if (payload.eventType === 'DELETE') {
    notes = notes.filter((n) => n.id !== payload.old.id);
    if (pinnedIds.has(payload.old.id)) {
      window.pinAPI.close(payload.old.id);
      pinnedIds.delete(payload.old.id);
    }
  }
  renderBoard();
}

function subscribeRealtime() {
  supa
    .channel('pinboard_notes_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE }, applyRealtimeChange)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') setConnStatus('ok', 'live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setConnStatus('error', 'offline');
    });
}

// ---------- wiring ----------

btnNew.addEventListener('click', openNewModal);
btnCancel.addEventListener('click', closeModal);
btnSave.addEventListener('click', saveNote);
btnDelete.addEventListener('click', deleteNote);
btnMarkDone.addEventListener('click', () => setStatus('done'));
btnReopen.addEventListener('click', () => setStatus('open'));
btnLock.addEventListener('click', toggleLock);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return; // let native text-field undo work
  if (!modal.classList.contains('hidden') || !pinModal.classList.contains('hidden')) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === 'y') {
    e.preventDefault();
    redo();
  }
});

function setAdminUI(on) {
  isAdmin = on;
  adminToggle.classList.toggle('active', on);
  adminToggle.textContent = on ? '🔒 Admin / ผู้ดูแล' : '🔓 Admin / ผู้ดูแล';
  adminToggle.title = on ? 'Admin mode is ON — click to turn off' : 'Admin mode lets you lock/unlock notes';
  renderBoard();
}

function openPinModal() {
  fAdminPin.value = '';
  pinError.classList.add('hidden');
  pinModal.classList.remove('hidden');
  fAdminPin.focus();
}

function closePinModal() {
  pinModal.classList.add('hidden');
}

function submitAdminPin() {
  if (fAdminPin.value === ADMIN_PIN) {
    closePinModal();
    setAdminUI(true);
  } else {
    pinError.classList.remove('hidden');
  }
}

adminToggle.addEventListener('click', () => {
  if (isAdmin) {
    setAdminUI(false);
  } else {
    openPinModal();
  }
});
btnPinCancel.addEventListener('click', closePinModal);
btnPinSubmit.addEventListener('click', submitAdminPin);
fAdminPin.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAdminPin(); });
pinModal.addEventListener('click', (e) => { if (e.target === pinModal) closePinModal(); });

binIcon.addEventListener('click', () => {
  donePanel.classList.toggle('hidden');
});

document.addEventListener('click', (e) => {
  if (donePanel.classList.contains('hidden')) return;
  if (donePanel.contains(e.target) || binIcon.contains(e.target)) return;
  donePanel.classList.add('hidden');
});

window.pinAPI.version().then((v) => {
  document.getElementById('app-version').textContent = `v${v}`;
});

setConnStatus('unknown', 'connecting…');
fetchNotes().then(() => {
  subscribeRealtime();
  restorePins();
});
