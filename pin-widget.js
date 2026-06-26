let currentNote = null;

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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  const today = new Date(todayStr() + 'T00:00:00');
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

function formatDate(dateStr) {
  if (!dateStr) return 'No due date';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const DUE_SOON_DAYS = 2;

function render(note) {
  currentNote = note;
  const card = document.getElementById('card');
  const colors = operatorColor(note.operator);
  card.style.backgroundColor = colors.bg;

  const overdue = note.status === 'open' && note.due_date && note.due_date < todayStr();
  const dueSoon = !overdue && note.status === 'open' && note.due_date && daysUntil(note.due_date) <= DUE_SOON_DAYS && daysUntil(note.due_date) >= 0;
  card.classList.toggle('overdue', overdue);
  card.classList.toggle('due-soon', dueSoon);

  document.getElementById('f-work-name').textContent = note.work_name;
  document.getElementById('f-due-date').textContent = (overdue ? '⚠ ' : '') + formatDate(note.due_date);

  const reqEl = document.getElementById('f-requested-by');
  reqEl.textContent = note.requested_by ? 'From: ' + note.requested_by : '';

  const opEl = document.getElementById('f-operator');
  if (note.operator) {
    opEl.textContent = note.operator;
    opEl.style.color = colors.tag;
    opEl.style.display = '';
  } else {
    opEl.style.display = 'none';
  }
}

widgetAPI.onInit(render);

const cardEl = document.getElementById('card');

let dragging = false;
let dragMoved = false;

cardEl.addEventListener('mousedown', (e) => {
  if (e.target.closest('#toolbar')) return;
  dragging = true;
  dragMoved = false;
  cardEl.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  if (e.movementX !== 0 || e.movementY !== 0) {
    dragMoved = true;
    widgetAPI.moveBy(e.movementX, e.movementY);
  }
});

window.addEventListener('mouseup', () => {
  dragging = false;
  cardEl.classList.remove('dragging');
});

cardEl.addEventListener('click', (e) => {
  if (e.target.closest('#toolbar')) return;
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  if (currentNote) widgetAPI.requestOpenMain(currentNote.id);
});

document.getElementById('unpin').addEventListener('click', () => {
  if (currentNote) widgetAPI.unpin(currentNote.id);
});
