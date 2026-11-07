"use strict";

const PPQ = Music.PPQ;
const BAR = PPQ * 4;
const SLOTS = 16;
const SCHEDULE_AHEAD_MS = 150;
const CHUNK_PULSES = 10; // Must divide CLOCK_PULSES.
const CLOCK_PULSES = PPQ / 24;
const VELOCITY_STEPS = [1.0, 0.7, 0.4];
const DRAG_THRESHOLD_PX = 4; // A press that moves less than this counts as a click.
const FINE_DIVISIONS = 8; // Resizing moves in eighths of a step, or quarters when steps are narrow.
const NARROW_STEP_PX = 32;
const MIN_CELL_PX = 14; // Below this, steps are too small to click reliably.
const DENSE_CELL_PX = 22;
const DEFAULT_CHANNEL = 0; // Channel 1.
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;
const STORE_KEY = "bass-station-grid";

const $ = (id) => document.getElementById(id);

const state = {
  root: 0,
  scale: "minor",
  moveNotes: true,
  slots: Array.from({ length: SLOTS }, () => ({ bars: 4, notes: [] })),
  current: 0,
  queued: null,
  bpm: 120,
  channel: DEFAULT_CHANNEL,
  newLength: "off",
  lowOctave: 3,
  span: 2,
  showAll: false,
  baseResolution: 240,
  triplets: false,
  resolution: 240,
  view: "grid",
  values: {}, // Knob positions the Bass Station has sent, for drawn movements to return to.
  page: 0,
  pageBars: 1,
  windowStart: 0,
  windowSpan: 0,
  undo: [],
  chain: "",
  chainOn: false,
  chainPos: 0,
  showLane: false,
  laneParam: "filter.frequency",
  laneDraw: null,
  selection: null,
  selecting: null,
  clipboard: null,
  editor: null,
  paint: null,
  lengthDrag: null,
  barsQueued: false,
  midi: null,
  output: null,
  input: null,
  playing: false,
  nextPulse: 0,
  nextTime: 0,
  saveTimer: null,
};

const slot = () => state.slots[state.current];
const lengthPulses = (item = slot()) => item.bars * BAR;
const notes = () => slot().notes;
const lowNote = () => (state.lowOctave + 1) * 12;

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").title = message;
  $("status").classList.toggle("error", isError);
}

/* ---------- Saving in this browser ---------- */

function saveSoon() {
  window.clearTimeout(state.saveTimer);
  state.saveTimer = window.setTimeout(() => {
    const saved = {};
    for (const key of ["root", "scale", "moveNotes", "slots", "current", "bpm", "channel",
      "newLength", "lowOctave", "span", "showAll", "baseResolution", "triplets", "view",
      "chain", "chainOn", "showLane", "laneParam"]) {
      saved[key] = state[key];
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (error) {
      setStatus("Couldn't save in this browser. Export your patterns to keep them.", true);
    }
  }, 300);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && Array.isArray(saved.slots) && saved.slots.length === SLOTS) {
      Object.assign(state, saved);
      state.resolution = state.triplets ? (state.baseResolution * 2) / 3 : state.baseResolution;
    }
  } catch (error) {
    // A missing or unreadable save just means starting fresh.
  }
}

/* ---------- Key ---------- */

function setKey(root, scale) {
  if (root === state.root && scale === state.scale) return;
  closeNoteEditor({ restoreFocus: false });
  remember();
  if (state.moveNotes) {
    for (const item of state.slots) {
      item.notes = Music.mapNotes(item.notes, state.root, state.scale, root, scale);
    }
  }
  state.root = root;
  state.scale = scale;
  renderAll();
  saveSoon();
  const name = `${Music.NOTE_NAMES[root]} ${Music.SCALES[scale].name.toLowerCase()}`;
  setStatus(state.moveNotes ? `Key: ${name}. Patterns moved to the new key.` : `Key: ${name}. Notes weren't moved.`);
}

function renderKey() {
  $("roots").replaceChildren(...Music.NOTE_NAMES.map((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("aria-pressed", String(index === state.root));
    button.addEventListener("click", () => setKey(index, state.scale));
    return button;
  }));
  $("scale").value = state.scale;
  $("move-notes").checked = state.moveNotes;
}

// Rows from high to low. Notes already in the pattern are never hidden.
function rowNotes() {
  const low = lowNote();
  const high = low + state.span * 12;
  const rows = new Set(state.showAll
    ? Array.from({ length: high - low + 1 }, (_, i) => low + i)
    : Music.notesInKey(state.root, state.scale, low, high));
  for (const item of notes()) rows.add(item.note);
  return [...rows].sort((a, b) => b - a);
}

/* ---------- Patterns ---------- */

function renderSlots() {
  const nodes = [];
  for (let index = 0; index < SLOTS; index += 1) {
    const count = state.slots[index].notes.length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "slot";
    button.textContent = String(index + 1);
    button.classList.toggle("has-pattern", count > 0);
    button.classList.toggle("queued", index === state.queued);
    button.setAttribute("aria-current", String(index === state.current));
    button.setAttribute("aria-label", `Pattern ${index + 1}, ${count ? `${count} notes` : "empty"}`);
    button.addEventListener("click", () => selectSlot(index));
    nodes.push(button);
  }
  $("slots").replaceChildren(...nodes);
}

function selectSlot(index) {
  if (index === state.current) {
    state.queued = null;
    renderSlots();
  } else if (state.playing) {
    state.queued = index;
    renderSlots();
    setStatus(`Pattern ${index + 1} starts at the end of this loop.`);
  } else {
    switchTo(index);
  }
}

// The sound stays as it is, so only loading a patch or a saved sound changes it.
function switchTo(index) {
  restoreAfterMotions();
  state.current = index;
  state.queued = null;
  state.page = 0;
  renderAll();
  saveSoon();
}

function duplicatePattern() {
  const target = state.slots.findIndex((item) => !item.notes.length);
  if (target < 0) {
    setStatus("All 16 patterns are in use. Clear one first.", true);
    return;
  }
  stop();
  remember();
  state.slots[target] = JSON.parse(JSON.stringify(slot()));
  switchTo(target);
  setStatus(`Copied to pattern ${target + 1}.`);
}

function generatePattern() {
  remember();
  const kind = $("generator").value;
  const low = kind === "bassline" ? lowNote() : lowNote() + 12;
  slot().notes = Music.generate(kind, {
    root: state.root, scale: state.scale, low, lengthTicks: lengthPulses(),
  });
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`New ${Music.GENERATORS[kind].toLowerCase()} in the key. Generate again for another, or Undo.`);
}

function shiftOctave(octaves) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftOctaves(notes(), octaves);
  if (!moved) {
    setStatus(`Can't move ${octaves > 0 ? "up" : "down"} an octave, as the notes would go past the MIDI range.`, true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  // The view only follows once the notes leave it.
  const pitches = moved.map((n) => n.note);
  if (Math.min(...pitches) < lowNote() || Math.max(...pitches) > lowNote() + state.span * 12) {
    state.lowOctave = Math.max(1, Math.min(6, state.lowOctave + octaves));
    $("octave").value = String(state.lowOctave);
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${octaves > 0 ? "up" : "down"} an octave.`);
}

function shiftInScale(steps) {
  if (!notes().length) {
    setStatus("This pattern has no notes to move.", true);
    return;
  }
  const moved = Music.shiftInScale(notes(), steps, state.root, state.scale);
  if (!moved) {
    setStatus("Can't move further, as the notes would go past the MIDI range.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  slot().notes = moved;
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${steps > 0 ? "up" : "down"} a step in the scale.`);
}

// Moves the whole pattern a step in time, wrapping around, along with its knob movements.
function shiftInTime(direction) {
  const lanes = lanesFor();
  if (!notes().length && !(lanes && Object.keys(lanes).length)) {
    setStatus("This pattern is empty.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const by = direction * state.resolution;
  const length = lengthPulses();
  slot().notes = Music.rotateNotes(notes(), by, length);
  if (lanes && Object.keys(lanes).length) {
    for (const [cc, points] of Object.entries(editableLanes())) {
      slot().lanes[cc] = points.map((point) => ({
        ...point,
        time: (Math.round((((point.time + by) % length + length) % length) / MOTION_TICKS) * MOTION_TICKS) % length,
      })).sort((a, b) => a.time - b.time);
    }
  }
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Moved pattern ${state.current + 1} ${direction > 0 ? "later" : "earlier"} by one step.`);
}

/* ---------- Selecting steps, copy and paste ---------- */

function updateSelectionMarks() {
  const range = state.selection;
  document.querySelectorAll(".cell, .step-number[data-time]").forEach((node) => {
    const time = Number(node.dataset.time);
    node.classList.toggle("selected", Boolean(range) && time >= range.start && time < range.end);
  });
}

function selectSteps(from, to) {
  const start = Math.min(from, to);
  state.selection = { start, end: Math.max(from, to) + state.resolution };
  updateSelectionMarks();
}

function clearSelection() {
  state.selection = null;
  updateSelectionMarks();
}

function copySelection() {
  const range = state.selection;
  if (!range) {
    setStatus("Click or drag along the step numbers above the grid to choose steps first.", true);
    return;
  }
  const copied = notes().filter((n) => n.time >= range.start && n.time < range.end);
  state.clipboard = { span: range.end - range.start, notes: copied.map((n) => ({ ...n, time: n.time - range.start })) };
  $("paste").disabled = false;
  setStatus(`Copied ${copied.length} ${copied.length === 1 ? "note" : "notes"}. Choose where it goes with the step numbers, then click Paste.`);
}

// Replaces what's in the steps it lands on, in this pattern or another.
function pasteClipboard() {
  if (!state.clipboard) return;
  if (!state.selection) {
    setStatus("Click a step number to choose where to paste.", true);
    return;
  }
  closeNoteEditor({ restoreFocus: false });
  remember();
  const { start } = state.selection;
  const length = lengthPulses();
  const end = Math.min(start + state.clipboard.span, length);
  const pasted = state.clipboard.notes
    .map((n) => ({ ...n, time: n.time + start }))
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  slot().notes = [...notes().filter((n) => n.time < start || n.time >= end), ...pasted]
    .sort((a, b) => a.time - b.time || a.note - b.note);
  state.selection = { start, end };
  renderGrid();
  renderChrome();
  saveSoon();
  setStatus(`Pasted ${pasted.length} ${pasted.length === 1 ? "note" : "notes"}. Undo takes it back.`);
}

// Sets velocity on the chosen steps, or the whole pattern if none are chosen.
function setBulkVelocity() {
  const value = Number($("bulk-velocity").value);
  if (!Number.isInteger(value) || value < 1 || value > 127) {
    setStatus("Velocity goes from 1 to 127.", true);
    return;
  }
  const range = state.selection;
  const targets = range ? notes().filter((n) => n.time >= range.start && n.time < range.end) : notes();
  if (!targets.length) {
    setStatus(range ? "There are no notes in the chosen steps." : "This pattern has no notes.", true);
    return;
  }
  remember();
  targets.forEach((n) => { n.velocity = value / 127; });
  document.querySelectorAll(".cell").forEach(paintCell);
  renderChrome();
  saveSoon();
  setStatus(`Set ${targets.length} ${targets.length === 1 ? "note" : "notes"} to velocity ${value}.`);
}

/* ---------- Undo ---------- */

function remember() {
  state.undo.push({
    json: JSON.stringify({ root: state.root, scale: state.scale, slots: state.slots, current: state.current, bpm: state.bpm }),
  });
  if (state.undo.length > 100) state.undo.shift();
  $("undo").disabled = false;
}

function undo() {
  const last = state.undo.pop();
  if (!last) return;
  closeNoteEditor({ restoreFocus: false });
  Object.assign(state, JSON.parse(last.json));
  renderAll();
  if (state.playing) announceTempo();
  saveSoon();
}

/* ---------- Rendering the grid ---------- */

function gridWidthForSteps() {
  const wrap = $("grid-wrap");
  const style = getComputedStyle(wrap);
  const label = document.querySelector(".note-label");
  return wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    - (label ? label.offsetWidth : 76);
}

// Everything fits on one page, until steps would be too small to click.
function updatePaging() {
  const totalBars = Math.ceil(slot().bars);
  const stepsPerBar = BAR / state.resolution;
  const available = gridWidthForSteps();
  let pageBars = totalBars;
  while (pageBars > 1 && available / (pageBars * stepsPerBar) < MIN_CELL_PX) {
    pageBars = Math.ceil(pageBars / 2);
  }
  state.pageBars = pageBars;
  const pages = Math.ceil(totalBars / pageBars);
  state.page = Math.min(state.page, pages - 1);
  $("pager").hidden = pages <= 1;
  const first = state.page * pageBars + 1;
  const last = Math.min(first + pageBars - 1, totalBars);
  $("page-label").textContent = first === last
    ? `Bar ${first} of ${totalBars}` : `Bars ${first}-${last} of ${totalBars}`;
  $("page-prev").disabled = state.page === 0;
  $("page-next").disabled = state.page >= pages - 1;
}

function goToPage(page) {
  state.page = page;
  renderGrid();
}

function renderGrid() {
  closeNoteEditor({ restoreFocus: false });
  const grid = $("grid");
  updatePaging();
  const windowStart = state.page * state.pageBars * BAR;
  const windowEnd = Math.min(windowStart + state.pageBars * BAR, lengthPulses());
  const stepCount = Math.ceil((windowEnd - windowStart) / state.resolution);
  state.windowStart = windowStart;
  state.windowSpan = stepCount * state.resolution;
  const rows = rowNotes();
  grid.style.gridTemplateColumns = `var(--label-width) repeat(${stepCount}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `20px repeat(${rows.length}, minmax(14px, 1fr))`;
  const dense = gridWidthForSteps() / stepCount < DENSE_CELL_PX;
  grid.classList.toggle("dense", dense);
  grid.style.setProperty("--grid-gap", dense ? "1px" : "2px");

  const nodes = [];
  const corner = document.createElement("div");
  corner.className = "corner";
  nodes.push(corner);
  for (let step = 0; step < stepCount; step += 1) {
    const time = windowStart + step * state.resolution;
    const label = document.createElement("div");
    label.className = "step-number";
    label.dataset.time = String(time);
    label.title = "Click or drag to choose steps for Copy, Paste and Velocity";
    if (time % BAR === 0) {
      label.classList.add("bar-start");
      label.textContent = String(time / BAR + 1);
    } else if (time % PPQ === 0) {
      label.textContent = String((time % BAR) / PPQ + 1);
    }
    nodes.push(label);
  }

  for (const note of rows) {
    const isRoot = (note - state.root) % 12 === 0;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "note-label";
    label.textContent = Music.noteName(note);
    label.classList.toggle("root", isRoot);
    const fits = Music.inKey(note, state.root, state.scale);
    label.classList.toggle("out-of-key", !fits);
    label.title = fits ? `Note ${note}. Click to hear it.` : `Note ${note}, outside the key. Click to hear it.`;
    label.addEventListener("pointerdown", () => audition([note]));
    nodes.push(label);
    for (let step = 0; step < stepCount; step += 1) {
      const time = windowStart + step * state.resolution;
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "cell";
      cell.dataset.note = String(note);
      cell.dataset.time = String(time);
      if (Math.floor(time / PPQ) % 2 === 0) cell.classList.add("beat");
      if (time % BAR === 0) cell.classList.add("bar-start");
      if (isRoot) cell.classList.add("root-row");
      nodes.push(cell);
    }
  }
  grid.replaceChildren(...nodes);
  document.querySelectorAll(".cell").forEach(paintCell);
  renderNoteBars();
  updateSelectionMarks();
  renderLane();
}

function notesInCell(note, time) {
  return notes().filter((n) => n.note === note && n.time >= time && n.time < time + state.resolution);
}

const cellElement = (note, time) =>
  document.querySelector(`.cell[data-note="${note}"][data-time="${time}"]`);

function paintCell(cell) {
  const time = Number(cell.dataset.time);
  const note = Number(cell.dataset.note);
  const found = notesInCell(note, time);
  const on = found.length > 0;
  queueNoteBars();
  cell.classList.toggle("on", on);
  cell.classList.toggle("chance", found.some((n) => (n.probability ?? 100) < 100));
  cell.setAttribute("aria-pressed", String(on));
  cell.setAttribute("aria-label", `${Music.noteName(note)}, pulse ${time}${on ? ", on" : ""}`);
  if (on) {
    const loudest = Math.max(...found.map((n) => n.velocity));
    cell.style.setProperty("--velocity", String(0.3 + 0.7 * loudest));
  } else {
    cell.style.removeProperty("--velocity");
  }
}

function queueNoteBars() {
  if (state.barsQueued) return;
  state.barsQueued = true;
  requestAnimationFrame(() => {
    state.barsQueued = false;
    renderNoteBars();
  });
}

function renderNoteBars() {
  document.querySelectorAll(".note-bar").forEach((bar) => bar.remove());
  document.querySelectorAll(".cell.has-bar").forEach((cell) => cell.classList.remove("has-bar"));
  const start = state.windowStart;
  const end = start + state.windowSpan;
  for (const note of notes()) {
    const noteEnd = note.time + note.length;
    if (noteEnd <= start || note.time >= end) continue;
    const cellTime = Math.floor(note.time / state.resolution) * state.resolution;
    const anchorTime = Math.max(cellTime, start);
    const cell = cellElement(note.note, anchorTime);
    if (!cell) continue;
    const barStart = Math.max(note.time, start);
    const barEnd = Math.min(noteEnd, end);
    const steps = (barEnd - barStart) / state.resolution;
    const bar = document.createElement("span");
    bar.className = "note-bar";
    bar.style.setProperty("--steps", String(steps));
    bar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(steps) - 1)));
    bar.style.left = `${((barStart - anchorTime) / state.resolution) * 100}%`;
    bar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
    if (note.substep && note.time === barStart) {
      const mark = document.createElement("span");
      mark.className = "note-sub";
      mark.textContent = Music.SUB_STEPS[note.substep];
      bar.classList.add("sub");
      bar.append(mark);
    }
    // A note running past this page can't be resized from here.
    if (noteEnd <= end) {
      const handle = document.createElement("span");
      handle.className = "note-handle";
      handle.title = "Drag to change where this note ends. Hold Alt for finer control.";
      bar.append(handle);
    }
    cell.append(bar);
    if (note.time === barStart) cell.classList.add("has-bar");
  }
}

function renderStepControls() {
  for (const button of $("steps").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.value) === state.baseResolution));
  }
  $("triplets").setAttribute("aria-pressed", String(state.triplets));
}

function renderChrome() {
  $("undo").disabled = state.undo.length === 0;
  renderSlots();
}

// Imported or restored patterns can be any number of steps, such as 6 or 12.
function renderBarsOptions() {
  const select = $("bars");
  const value = String(slot().bars);
  select.querySelector("[data-custom]")?.remove();
  if (![...select.options].some((option) => option.value === value)) {
    const option = new Option(`${slot().bars * 16} steps`, value);
    option.dataset.custom = "true";
    select.append(option);
  }
  select.value = value;
}

function renderAll() {
  renderKey();
  renderStepControls();
  renderBarsOptions();
  $("bpm").value = state.bpm;
  $("new-length").value = state.newLength;
  $("octave").value = String(state.lowOctave);
  $("span").value = String(state.span);
  $("show-all").checked = state.showAll;
  $("channel").value = String(state.channel + 1);
  renderGrid();
  renderChrome();
}

/* ---------- Editing ---------- */

function setSteps(baseResolution, triplets) {
  state.baseResolution = baseResolution;
  state.triplets = triplets;
  state.resolution = triplets ? (baseResolution * 2) / 3 : baseResolution;
  renderStepControls();
  renderGrid();
  saveSoon();
}

function setBars(bars) {
  remember();
  slot().bars = bars;
  const length = lengthPulses();
  slot().notes = notes()
    .filter((n) => n.time < length)
    .map((n) => ({ ...n, length: Math.min(n.length, length - n.time) }));
  if (slot().lanes) {
    for (const [cc, points] of Object.entries(slot().lanes)) slot().lanes[cc] = points.filter((point) => point.time < length);
  }
  if (state.nextPulse >= length) state.nextPulse = 0;
  renderGrid();
  renderChrome();
  saveSoon();
}

function newNoteLength(time) {
  const lengths = { off: state.resolution, step: state.resolution, beat: PPQ, bar: BAR };
  return Math.min(lengths[state.newLength], lengthPulses() - time);
}

// Adds the note and returns it. The Bass Station plays one note at a time, so it
// replaces any other note starting in the same step.
function addNotes(note, time) {
  if (notesInCell(note, time).length) return [];
  const replaced = notes().filter((n) => n.note !== note && n.time >= time && n.time < time + state.resolution);
  const item = { time, note, velocity: 1, length: newNoteLength(time), probability: 100 };
  slot().notes = [...notes().filter((n) => !replaced.includes(n)), item].sort((a, b) => a.time - b.time || a.note - b.note);
  repaintFor(replaced);
  return [item];
}

function repaintFor(items) {
  for (const item of items) {
    const time = Math.floor(item.time / state.resolution) * state.resolution;
    const cell = cellElement(item.note, time);
    if (cell) paintCell(cell);
  }
}

function needsRowsFor(items) {
  return items.some((item) => !cellElement(item.note, state.windowStart));
}

function describeLength(length) {
  const steps = length / state.resolution;
  const shown = Number.isInteger(steps) ? String(steps) : steps.toFixed(2);
  return `${shown} ${steps === 1 ? "step" : "steps"}`;
}

function cycleVelocity(cell) {
  const found = notesInCell(Number(cell.dataset.note), Number(cell.dataset.time));
  if (!found.length) return;
  remember();
  const current = VELOCITY_STEPS.findIndex((v) => found[0].velocity >= v - 0.001);
  const next = VELOCITY_STEPS[(Math.max(current, 0) + 1) % VELOCITY_STEPS.length];
  found.forEach((n) => { n.velocity = next; });
  paintCell(cell);
  renderChrome();
  saveSoon();
  setStatus(`Velocity ${Math.round(next * 127)} of 127.`);
}

function startLengthDrag(event, handle) {
  const cell = handle.closest(".cell");
  const note = Number(cell.dataset.note);
  const anchorTime = Number(cell.dataset.time);
  const found = notes().find((n) => n.note === note
    && n.time < anchorTime + state.resolution && n.time + n.length > anchorTime);
  if (!found) return;
  remember();
  state.lengthDrag = { items: [found], anchorTime, cell, pressed: true, startX: event.clientX };
  event.preventDefault();
}

// Where a resize ends. Drawing a new note uses whole steps, while resizing is finer so
// a note can end inside a step. Alt gives single ticks.
function dragEnd(event, drag, start, currentLength, box) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  // Follows the mouse from where the note was grabbed, so it doesn't jump at the start.
  if (!drag.drawing && drag.grabOffset === undefined) {
    drag.grabOffset = start + currentLength - ticksAt(drag.startX);
  }
  const pointer = ticksAt(event.clientX) + (drag.grabOffset || 0);
  if (event.altKey) return { end: Math.round(pointer), shortest: start + 1 };
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = drag.drawing ? state.resolution : state.resolution / divisions;
  return {
    end: Math.round(pointer / unit) * unit,
    shortest: Math.floor(start / unit) * unit + unit,
  };
}

function moveLengthDrag(event) {
  const drag = state.lengthDrag;
  const box = drag.cell.getBoundingClientRect();
  // A click that stays on its step keeps the Length setting.
  if (drag.drawing && !drag.moved) {
    if (event.clientX <= box.right) return;
    drag.moved = true;
  }
  if (drag.pressed && !drag.moved) {
    if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
  }
  const start = drag.items[0].time;
  const target = dragEnd(event, drag, start, drag.items[0].length, box);
  const end = Math.max(target.shortest, Math.min(target.end, state.windowStart + state.windowSpan, lengthPulses()));
  const length = end - start;
  if (length !== drag.items[0].length) {
    drag.items.forEach((item) => { item.length = length; });
    renderNoteBars();
  }
  setStatus(`Length: ${describeLength(length)} (${length} ticks).`);
}

function bindGridEvents() {
  const grid = $("grid");
  grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = event.target.closest(".cell");
    if (cell) openNoteEditor(cell);
  });
  window.addEventListener("pointermove", (event) => {
    if (state.lengthDrag) moveLengthDrag(event);
  });
  grid.addEventListener("pointerdown", (event) => {
    const number = event.target.closest(".step-number");
    if (number && event.button === 0) {
      const time = Number(number.dataset.time);
      const range = state.selection;
      // A click on the only chosen step clears it.
      if (range && range.start === time && range.end === time + state.resolution) {
        clearSelection();
      } else {
        state.selecting = time;
        selectSteps(time, time);
      }
      event.preventDefault();
      return;
    }
    const handle = event.target.closest(".note-handle");
    if (handle && event.button === 0 && !event.ctrlKey) {
      if (state.editor) closeNoteEditor({ restoreFocus: false });
      startLengthDrag(event, handle);
      return;
    }
    const cell = event.target.closest(".cell");
    // Control-click is a right-click on a Mac and opens the editor instead.
    if (!cell || event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    if (state.editor) {
      closeNoteEditor({ restoreFocus: false });
      return;
    }
    if (event.shiftKey) {
      cycleVelocity(cell);
      return;
    }
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    const on = !cell.classList.contains("on");
    if (on) {
      const added = addNotes(note, time);
      if (needsRowsFor(added)) {
        renderGrid();
      } else {
        repaintFor(added);
      }
      audition(added.map((item) => item.note));
      // Dragging draws one note at the dragged length. Cmd-drag fills separate steps.
      if (!event.metaKey && added.length) {
        state.lengthDrag = { items: added, anchorTime: time, cell: cellElement(note, time), drawing: true };
      } else {
        state.paint = { on: true };
      }
    } else if (event.metaKey) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
      state.paint = { on: false };
    } else {
      // Dragging a note resizes it, so it's only removed by a click that doesn't move.
      state.lengthDrag = {
        items: notesInCell(note, time), anchorTime: time, cell, pressed: true, startX: event.clientX,
      };
    }
    renderChrome();
    saveSoon();
  });
  grid.addEventListener("pointerover", (event) => {
    if (state.selecting !== null) {
      const over = event.target.closest(".step-number, .cell");
      if (over) selectSteps(state.selecting, Number(over.dataset.time));
      return;
    }
    const cell = event.target.closest(".cell");
    if (!cell || !state.paint) return;
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (state.paint.on && !notesInCell(note, time).length) {
      repaintFor(addNotes(note, time));
    } else if (!state.paint.on && notesInCell(note, time).length) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
    }
    paintCell(cell);
    renderChrome();
  });
  window.addEventListener("pointerup", () => {
    state.selecting = null;
    const drag = state.lengthDrag;
    if (drag && drag.pressed && !drag.moved) {
      slot().notes = notes().filter((n) => !drag.items.includes(n));
      paintCell(drag.cell);
      renderChrome();
    }
    if (state.lengthDrag || state.paint) saveSoon();
    state.lengthDrag = null;
    state.paint = null;
  });
  // Keyboard activation: pointer clicks are already handled on pointerdown.
  grid.addEventListener("click", (event) => {
    const cell = event.target.closest(".cell");
    if (!cell || event.detail !== 0) return;
    remember();
    const note = Number(cell.dataset.note);
    const time = Number(cell.dataset.time);
    if (cell.classList.contains("on")) {
      slot().notes = notes().filter((n) => !notesInCell(note, time).includes(n));
      paintCell(cell);
    } else {
      repaintFor(addNotes(note, time));
    }
    renderChrome();
    saveSoon();
  });
}

/* ---------- Step editor ---------- */

const editorNotes = () => notesInCell(state.editor.note, state.editor.time);

function openNoteEditor(cell) {
  closeNoteEditor({ restoreFocus: false });
  const note = Number(cell.dataset.note);
  const time = Number(cell.dataset.time);
  let remembered = false;
  if (!notesInCell(note, time).length) {
    remember();
    remembered = true;
    addNotes(note, time);
    renderChrome();
  }
  state.editor = { note, time, remembered };
  cell.classList.add("editing");
  paintCell(cell);
  const bar = Math.floor(time / BAR) + 1;
  const beat = ((time % BAR) / PPQ + 1).toFixed(2).replace(/\.?0+$/, "");
  $("editor-title").textContent = `${Music.noteName(note)}, bar ${bar}, beat ${beat}`;
  fillNoteEditor();
  const panel = $("note-editor");
  panel.hidden = false;
  const box = cell.getBoundingClientRect();
  const margin = 8;
  const fitsRight = box.right + margin + panel.offsetWidth < innerWidth;
  const left = fitsRight ? box.right + margin : box.left - panel.offsetWidth - margin;
  const top = Math.min(box.top, innerHeight - panel.offsetHeight - margin);
  panel.style.left = `${Math.max(margin, left)}px`;
  panel.style.top = `${Math.max(margin, top)}px`;
  $("edit-velocity").focus();
  $("edit-velocity").select();
}

function maxEditorOffset(found) {
  const times = found.map((n) => n.time);
  return state.resolution - 1 - (Math.max(...times) - Math.min(...times));
}

function fillNoteEditor() {
  const found = editorNotes();
  const [first] = found;
  const velocity = Math.max(1, Math.min(127, Math.round(first.velocity * 127)));
  const count = $("editor-count");
  count.hidden = found.length < 2;
  count.textContent = `Changes apply to all ${found.length} notes in this step.`;
  $("edit-velocity").value = velocity;
  $("edit-velocity-range").value = velocity;
  $("edit-length").value = first.length;
  $("edit-length").max = lengthPulses();
  $("edit-length-steps").textContent = `ticks, ${describeLength(first.length)}`;
  const maxOffset = maxEditorOffset(found);
  $("edit-offset").value = Math.min(...found.map((n) => n.time)) - state.editor.time;
  $("edit-offset").max = maxOffset;
  $("edit-offset-range").textContent = `ticks, 0-${maxOffset}`;
  $("edit-probability").value = first.probability ?? 100;
  $("edit-substep").value = String(first.substep || 0);
  for (const id of ["edit-velocity", "edit-length", "edit-offset", "edit-probability"]) {
    $(id).setAttribute("aria-invalid", "false");
  }
}

function changeEditorNotes(change) {
  if (!state.editor.remembered) {
    remember();
    state.editor.remembered = true;
  }
  change(editorNotes());
  notes().sort((a, b) => a.time - b.time || a.note - b.note);
  const cell = cellElement(state.editor.note, state.editor.time);
  if (cell) paintCell(cell);
  renderChrome();
  saveSoon();
}

// Applies a typed value if it's valid, and otherwise leaves the notes alone.
function editorNumber(id, low, high, apply) {
  const input = $(id);
  const value = Number(input.value);
  const valid = input.value !== "" && Number.isInteger(value) && value >= low && value <= high;
  input.setAttribute("aria-invalid", String(!valid));
  if (valid) apply(value);
}

function setEditorVelocity(value) {
  changeEditorNotes((found) => found.forEach((n) => { n.velocity = value / 127; }));
}

function bindNoteEditor() {
  $("edit-velocity").addEventListener("input", () => {
    editorNumber("edit-velocity", 1, 127, (value) => {
      $("edit-velocity-range").value = value;
      setEditorVelocity(value);
    });
  });
  $("edit-velocity-range").addEventListener("input", (event) => {
    const value = Number(event.target.value);
    $("edit-velocity").value = value;
    $("edit-velocity").setAttribute("aria-invalid", "false");
    setEditorVelocity(value);
  });
  $("edit-length").addEventListener("input", () => {
    editorNumber("edit-length", 1, lengthPulses(), (value) => {
      changeEditorNotes((found) => found.forEach((n) => {
        n.length = Math.min(value, lengthPulses() - n.time);
      }));
      $("edit-length-steps").textContent = `ticks, ${describeLength(value)}`;
    });
  });
  $("edit-offset").addEventListener("input", () => {
    editorNumber("edit-offset", 0, maxEditorOffset(editorNotes()), (value) => {
      changeEditorNotes((found) => {
        const start = Math.min(...found.map((n) => n.time));
        const delta = state.editor.time + value - start;
        found.forEach((n) => { n.time += delta; });
      });
    });
  });
  $("edit-probability").addEventListener("input", () => {
    editorNumber("edit-probability", 0, 100, (value) => {
      changeEditorNotes((found) => found.forEach((n) => { n.probability = value; }));
    });
  });
  $("edit-substep").addEventListener("change", (event) => {
    const value = Number(event.target.value);
    changeEditorNotes((found) => found.forEach((n) => {
      if (value) n.substep = value;
      else delete n.substep;
    }));
    renderNoteBars();
  });
  // Leaving a field with a bad value puts back the value actually in use.
  $("note-editor").addEventListener("focusout", (event) => {
    if (state.editor && event.target.getAttribute("aria-invalid") === "true") fillNoteEditor();
  });
  $("note-editor").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.tagName === "INPUT") closeNoteEditor();
  });
  $("edit-hear").addEventListener("click", () => {
    audition(editorNotes().map((n) => n.note), editorNotes()[0].velocity);
  });
  $("edit-delete").addEventListener("click", () => {
    changeEditorNotes((found) => {
      slot().notes = notes().filter((n) => !found.includes(n));
    });
    closeNoteEditor();
  });
  $("edit-done").addEventListener("click", () => closeNoteEditor());
  window.addEventListener("pointerdown", (event) => {
    if (!state.editor || $("note-editor").contains(event.target)) return;
    if (!event.target.closest("#grid")) closeNoteEditor({ restoreFocus: false });
  });
}

function closeNoteEditor({ restoreFocus = true } = {}) {
  if (!state.editor) return;
  const cell = cellElement(state.editor.note, state.editor.time);
  state.editor = null;
  $("note-editor").hidden = true;
  if (cell) {
    cell.classList.remove("editing");
    if (restoreFocus) cell.focus();
  }
}

/* ---------- Views ---------- */

// A copy of the editor's published build, kept beside this page so it shares its MIDI access.
const EDITOR_URL = "editor/";

// The editor is loaded the first time its tab is opened, as it asks for MIDI access.
function setView(view) {
  state.view = ["editor", "sounds"].includes(view) ? view : "grid";
  $("grid-view").hidden = state.view !== "grid";
  $("editor-view").hidden = state.view !== "editor";
  $("sounds-view").hidden = state.view !== "sounds";
  for (const button of $("views").querySelectorAll("button")) {
    button.setAttribute("aria-current", String(button.dataset.view === state.view));
  }
  if (state.view === "editor" && !$("editor-frame").getAttribute("src")) {
    shareEditorSettings();
    $("editor-frame").src = EDITOR_URL;
  }
  if (state.view === "grid") renderGrid();
  saveSoon();
}

/* The editor only finds the Bass Station by itself when its port has exactly the name it
   expects, and on the channel it was last set to. It keeps those choices in this site's
   storage, so the page fills them in with the ports and channel it's using, and reloads
   the editor when they change. */
const EDITOR_SETTINGS = "studiocode.bs2-editor.preferences";

function shareEditorSettings() {
  let saved = {};
  try {
    saved = JSON.parse(JSON.parse(localStorage.getItem(EDITOR_SETTINGS) || "null") || "{}");
  } catch {
    saved = {};
  }
  const wanted = {
    midi_channel: state.channel + 1,
    input_device_id: state.input ? state.input.id : saved.input_device_id ?? null,
    output_device_id: state.output ? state.output.id : saved.output_device_id ?? null,
  };
  const changed = Object.entries(wanted).some(([key, value]) => saved[key] !== value);
  if (!changed) return false;
  try {
    // Stored the way the editor stores it: its settings as JSON, saved as a JSON string.
    localStorage.setItem(EDITOR_SETTINGS, JSON.stringify(JSON.stringify({ ...saved, ...wanted })));
  } catch {
    return false;
  }
  return true;
}

function updateEditorSettings() {
  const frame = $("editor-frame");
  if (shareEditorSettings() && frame.getAttribute("src")) frame.src = EDITOR_URL;
}

/* ---------- MIDI ---------- */

async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiPill("MIDI needs Chrome or Edge", "warn");
    return;
  }
  $("midi-retry").hidden = true;
  try {
    // SysEx reads patches. Without it, everything but reading still works.
    state.midi = await navigator.requestMIDIAccess({ sysex: true }).catch(() => navigator.requestMIDIAccess({ sysex: false }));
  } catch (error) {
    setMidiPill("MIDI blocked", "warn");
    $("midi-retry").hidden = false;
    setStatus(`Chrome blocked MIDI (${error.name}). Click the icon left of the address, set MIDI devices to Allow, then click Allow MIDI.`, true);
    return;
  }
  setStatus("MIDI is allowed. Choose a key, then click or drag on the grid to add notes.");
  state.midi.onstatechange = refreshPorts;
  refreshPorts();
}

function setMidiPill(text, kind) {
  $("midi-state").textContent = text;
  $("midi-state").className = `pill ${kind || ""}`;
}

const isBassStation = (port) => /bass ?station/i.test(port.name);

function refreshPorts() {
  if (!state.midi) return;
  const outputs = [...state.midi.outputs.values()];
  const previous = state.output && state.output.id;
  $("output").replaceChildren(...outputs.map((port) => new Option(port.name, port.id)));
  state.output = outputs.find((port) => port.id === previous) || outputs.find(isBassStation) || null;
  if (state.output) $("output").value = state.output.id;
  if (state.output && isBassStation(state.output)) setMidiPill("MIDI: Bass Station", "ok");
  else if (state.output) setMidiPill(`MIDI: ${state.output.name}`);
  else setMidiPill("Bass Station not found. Connect it and turn it on.", "warn");

  // The input with the same name as the output, so a renamed or interface port still pairs up.
  // Every input is heard, for recording from any keyboard.
  const inputs = [...state.midi.inputs.values()];
  state.input = inputs.find((port) => state.output && port.name === state.output.name) || inputs.find(isBassStation) || null;
  for (const port of inputs) port.onmidimessage = (event) => handleMidiInput(event, port);
  recorder.refresh(state.midi);
  updateEditorSettings();
}

// Knobs turned on the Bass Station are remembered, so drawn knob movements return to them.
function handleMidiInput(event, port) {
  if (recorder.message(event, port)) return;
  if (port !== state.input) return;
  if (event.data[0] === 0xF0) {
    if (BassSounds.isPatch(event.data)) receivePatch(event.data);
    return;
  }
  const [status, first, second] = event.data;
  if ((status & 0x0F) !== state.channel || (status & 0xF0) !== 0xB0) return;
  const param = BassParams.BY_CC.get(first);
  if (!param) return;
  state.values[param.id] = second;
  if (param.id === state.laneParam) renderLane();
}

function sendController(cc, value, atTime) {
  if (!state.output) return false;
  const message = [0xB0 | state.channel, cc, Math.max(0, Math.min(127, Math.round(value)))];
  if (atTime === undefined) state.output.send(message);
  else state.output.send(message, atTime);
  return true;
}

const sendParam = (id, value, atTime) => sendController(BassParams.BY_ID.get(id).cc, value, atTime);

/* ---------- Recording ---------- */

let recorder = null;
let click = null;

function moveRecordCursor(time) {
  if (time < state.windowStart || time >= state.windowStart + state.windowSpan) {
    goToPage(Math.floor(time / (state.pageBars * BAR)));
  }
  selectSteps(time, time);
}

function setUpRecorder() {
  click = Recorder.createClick({ storageKey: "bass-station-grid-click", button: $("click") });
  recorder = Recorder.create({
    notes,
    makeNote: (fields) => ({ ...fields, probability: 100 }),
    // Off keeps each note as long as it was held.
    fixedLength: (time) => (state.newLength === "off" ? null : newNoteLength(time)),
    resolution: () => state.resolution,
    length: () => lengthPulses(),
    playing: () => state.playing,
    pulseAt,
    startStep: () => (state.selection ? state.selection.start : 0),
    moveCursor: moveRecordCursor,
    begin: () => {
      closeNoteEditor({ restoreFocus: false });
      remember();
      renderChrome();
    },
    // The Bass Station plays one note at a time, so a new note replaces others on its step.
    added: (item) => {
      const replaced = notes().filter((n) => n !== item && n.time >= item.time && n.time < item.time + state.resolution);
      if (replaced.length) slot().notes = notes().filter((n) => !replaced.includes(n));
      if (needsRowsFor([item])) renderGrid();
      else repaintFor([item, ...replaced]);
      renderChrome();
      saveSoon();
    },
    lengthened: () => {
      renderNoteBars();
      saveSoon();
    },
    status: setStatus,
    thru: ([status, note, velocity]) => {
      if (state.output) state.output.send([status | state.channel, note, velocity]);
    },
    isInstrument: (port) => port === state.input,
  }, { storageKey: "bass-station-grid-record-input", button: $("record"), input: $("record-input"), channel: $("record-channel") });
}

function sendNote(note, velocity, atTime, lengthMs) {
  if (!state.output) return;
  const value = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  recorder.sent(note, atTime);
  try {
    state.output.send([0x90 | state.channel, note, value], atTime);
    state.output.send([0x80 | state.channel, note, 0], atTime + lengthMs);
  } catch (error) {
    setStatus(`MIDI send failed: ${error.message}`, true);
    stop();
  }
}

function audition(noteList, velocity = 1) {
  if (!noteList.length) return;
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  const now = performance.now();
  noteList.forEach((note) => sendNote(note, velocity, now, 220));
}

/* ---------- Sounds tab ---------- */

const SOUNDS_KEY = "bass-station-grid-sounds"; // Where sounds were kept before the library folder.
const BACKUPS = "Backups";
const PATCH_WAIT_MS = 1500;
const PATCH_SETTLE_MS = 150; // The Bass Station needs a moment after a program change.
const sounds = { backups: [], search: "", waiting: [], busy: null };
const library = SoundFolder.create({
  db: "bass-station-grid-library",
  check: (bytes) => {
    if (BassSounds.split(bytes).length !== 1) throw new Error("It isn't one Bass Station patch.");
  },
});

// Waits that keep time while the tab is hidden, as Chrome slows a hidden page's own timers.
const timer = new Worker(URL.createObjectURL(new Blob(
  ["onmessage = (event) => setTimeout(() => postMessage(event.data.id), event.data.ms);"], { type: "text/javascript" })));
const timers = new Map();
let timerId = 0;
timer.onmessage = (event) => {
  timers.get(event.data)?.();
  timers.delete(event.data);
};
function pause(ms) {
  return new Promise((resolve) => {
    timerId += 1;
    timers.set(timerId, resolve);
    timer.postMessage({ id: timerId, ms });
  });
}

// Reconnects to the library folder chosen last time.
async function openLibrary() {
  await library.restore();
  const moved = await afterLibraryReady();
  renderSounds();
  if (moved) setStatus(moved);
}

async function chooseLibraryFolder() {
  try {
    if (!(await library.choose({ another: library.status === "ready" }))) return;
  } catch (error) {
    setStatus(`Couldn't open that folder: ${error.message}`, true);
    return;
  }
  const moved = await afterLibraryReady();
  renderSounds();
  if (library.status === "ready") setStatus(`Using "${library.folder.name}" as the sound library: ${plural(library.items.length, "sound")}.${moved ? ` ${moved}` : ""}`);
}

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

// Returns a message if sounds kept in the browser were moved into the folder.
async function afterLibraryReady() {
  if (library.status !== "ready") return "";
  const moved = await moveBrowserSounds();
  await readBackups();
  return moved;
}

const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
const inLibrary = (bytes) => library.items.some((item) => sameBytes(item.bytes, bytes));

// Sounds and backups kept in the browser before there was a folder move into it, once.
async function moveBrowserSounds() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SOUNDS_KEY) || "null");
  } catch {
    // Nothing readable to move.
  }
  if (!saved) return "";
  let moved = 0;
  let backups = 0;
  try {
    for (const item of saved.library || []) {
      let bytes;
      try {
        bytes = BassSounds.fromHex(item.data);
      } catch {
        continue;
      }
      if (inLibrary(bytes)) continue;
      await library.add(item.name, bytes, { from: item.from });
      moved += 1;
    }
    const folder = await library.subfolder(BACKUPS);
    for (const backup of saved.backups || []) {
      const bytes = (backup.patches || []).filter(Boolean).flatMap((data) => BassSounds.fromHex(data));
      if (!bytes.length) continue;
      await folder.write(backupName(new Date(backup.saved)), bytes);
      backups += 1;
    }
  } catch (error) {
    return `Couldn't move the sounds kept in this browser into the folder: ${error.message}`;
  }
  localStorage.removeItem(SOUNDS_KEY);
  return moved || backups ? `Moved ${plural(moved, "sound")} and ${plural(backups, "backup")} from this browser into it.` : "";
}

const pad = (number) => String(number).padStart(2, "0");
const backupName = (date) => `Bass Station backup ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;

async function readBackups() {
  try {
    const files = await (await library.subfolder(BACKUPS)).list();
    sounds.backups = files.map((file) => ({ ...file, patches: BassSounds.split(file.bytes) })).filter((backup) => backup.patches.length).reverse();
  } catch {
    sounds.backups = [];
  }
}

// Saving needs the folder, so this says what to do when it isn't ready.
function libraryReady() {
  if (library.status === "ready") return true;
  const advice = {
    unsupported: "Saving sounds needs a library folder, which needs Chrome or Edge on a computer.",
    permission: "Click Allow library folder first, so the page can save to it.",
    missing: "The library folder can't be found. Click Choose library folder.",
    none: "Click Choose library folder first, to pick where your sounds are saved.",
  };
  setStatus(advice[library.status], true);
  return false;
}

const today = () => new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

// The next patch the Bass Station sends, or null if none arrives in time.
function nextPatch() {
  return new Promise((resolve) => {
    const waiter = { resolve, done: false };
    sounds.waiting.push(waiter);
    pause(PATCH_WAIT_MS).then(() => {
      if (waiter.done) return;
      waiter.done = true;
      sounds.waiting = sounds.waiting.filter((other) => other !== waiter);
      resolve(null);
    });
  });
}

function receivePatch(bytes) {
  const waiter = sounds.waiting.shift();
  if (!waiter) return;
  waiter.done = true;
  waiter.resolve(Array.from(bytes));
}

function readyForPatches() {
  if (!state.output || !state.input) {
    setStatus("The Bass Station isn't connected. Check the MIDI output at the bottom.", true);
    return false;
  }
  if (!state.midi.sysexEnabled) {
    setStatus("Reading patches needs MIDI with SysEx. Click the icon left of the address, allow MIDI devices, then reload.", true);
    return false;
  }
  return true;
}

async function requestPatch() {
  const arriving = nextPatch();
  state.output.send(BassSounds.REQUEST);
  return arriving;
}

async function selectSlot(slot) {
  if (!state.output) {
    setStatus("No MIDI output connected.", true);
    return null;
  }
  state.output.send([0xC0 | state.channel, slot]);
  await pause(PATCH_SETTLE_MS);
  // Asking for the patch also brings the editor up to date, as it hears the reply too.
  return state.midi.sysexEnabled && state.input ? requestPatch() : null;
}

async function chooseSlot(slot) {
  if (sounds.busy) return;
  const patch = await selectSlot(slot);
  setStatus(`Chose patch ${slot}${slot < BassSounds.FACTORY.length ? `, "${BassSounds.factoryName(slot)}" from the factory` : ""}.${patch ? "" : " The editor updates once it hears the patch."}`);
}

async function saveCurrentSound() {
  if (sounds.busy || !libraryReady() || !readyForPatches()) return;
  const patch = await requestPatch();
  if (!patch) {
    setStatus("The Bass Station didn't send its patch. Check it's connected, and try again.", true);
    return;
  }
  const slot = BassSounds.slotOf(patch);
  const name = window.prompt("Name this sound", `Patch ${slot}`)?.trim();
  if (!name) return;
  try {
    const saved = await library.add(name, patch, { from: `Patch ${slot}, ${today()}` });
    setStatus(`Saved "${saved}.syx" in "${library.folder.name}".`);
  } catch (error) {
    setStatus(`Couldn't save it to the library folder: ${error.message}`, true);
  }
  renderSounds();
}

// Steps through all 128 patches, asking for each, then goes back to the one it started on.
async function backUpAll() {
  if (sounds.busy) {
    sounds.busy.cancelled = true;
    return;
  }
  if (!libraryReady() || !readyForPatches()) return;
  if (!window.confirm("This steps the Bass Station through all 128 patches to read each one, then goes back to the one you're on. Unsaved changes to the current sound will be lost. Back up now?")) return;
  const job = { cancelled: false };
  sounds.busy = job;
  $("backup-all").textContent = "Stop";
  const start = await requestPatch();
  const patches = [];
  let missing = 0;
  for (let slot = 0; slot < BassSounds.SLOTS && !job.cancelled; slot += 1) {
    setStatus(`Backing up patch ${slot + 1} of ${BassSounds.SLOTS}...`);
    let patch = await selectSlot(slot);
    if (!patch) patch = await requestPatch();
    if (patch) patches.push(patch);
    else {
      patches.push(null);
      missing += 1;
    }
  }
  if (start) await selectSlot(BassSounds.slotOf(start));
  sounds.busy = null;
  $("backup-all").textContent = "Back up all 128";
  if (job.cancelled) {
    setStatus("Stopped the backup. Nothing was saved.");
    return;
  }
  const name = backupName(new Date());
  const bytes = patches.filter(Boolean).flat();
  try {
    await (await library.subfolder(BACKUPS)).write(name, bytes);
  } catch (error) {
    download(`${name}.syx`, bytes);
    setStatus(`Couldn't save the backup to the library folder (${error.message}), so it was downloaded instead.`, true);
    return;
  }
  await readBackups();
  renderSounds();
  const gaps = missing ? ` ${missing} didn't arrive, so they're missing from it.` : "";
  setStatus(`Backed up ${patches.length - missing} patches to ${BACKUPS}/${name}.syx in "${library.folder.name}".${gaps}`, Boolean(missing));
}

// Sends a sound by loading it into the editor, as it knows how to set every control on the synth.
async function loadSound(item) {
  const frame = $("editor-frame");
  if (!frame.getAttribute("src")) {
    shareEditorSettings();
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.src = EDITOR_URL;
    });
    // Gives the editor time to connect to the Bass Station.
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
  }
  const field = frame.contentDocument?.getElementById("patch-file");
  if (!field) {
    setStatus("The editor isn't ready yet. Open the Editor tab once, then try again.", true);
    return;
  }
  const files = new DataTransfer();
  files.items.add(new File([item.bytes], `${item.name}.syx`, { type: "application/octet-stream" }));
  field.files = files.files;
  field.dispatchEvent(new Event("change", { bubbles: true }));
  setStatus(`Sent "${item.name}" to the Bass Station through the editor. Save it on the Bass Station to keep it in a patch slot.`);
}

function download(name, bytes) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const fileName = (name) => name.replace(/[^\w .-]+/g, "").trim() || "sound";

async function importSounds(file) {
  if (!libraryReady()) return;
  const patches = BassSounds.split(new Uint8Array(await file.arrayBuffer()));
  if (!patches.length) {
    setStatus(`${file.name} has no Bass Station patches.`, true);
    return;
  }
  const base = file.name.replace(/\.syx$/i, "");
  let added = 0;
  try {
    for (const [index, patch] of patches.entries()) {
      if (inLibrary(patch)) continue;
      await library.add(patches.length === 1 ? base : `${base} ${index + 1}`, patch, { from: `${file.name}, ${today()}` });
      added += 1;
    }
  } catch (error) {
    setStatus(`Couldn't save to the library folder: ${error.message}`, true);
  }
  renderSounds();
  const same = patches.length - added;
  setStatus(`Added ${added} ${added === 1 ? "sound" : "sounds"} from ${file.name}.${same ? ` ${same === 1 ? "1 was" : `${same} were`} already in the library.` : ""}`);
}

async function addBackupToLibrary(backup) {
  if (!libraryReady()) return;
  let added = 0;
  try {
    for (const patch of backup.patches) {
      if (inLibrary(patch)) continue;
      const slot = BassSounds.slotOf(patch);
      await library.add(slot < BassSounds.FACTORY.length ? `${slot} ${BassSounds.factoryName(slot)}` : `Patch ${slot}`, patch, { from: `${backup.name}, patch ${slot}` });
      added += 1;
    }
  } catch (error) {
    setStatus(`Couldn't save to the library folder: ${error.message}`, true);
  }
  renderSounds();
  setStatus(`Added ${added} sounds from the backup to the library. Names are the factory ones, so rename any you've changed.`);
}

function actionButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", onClick);
  return button;
}

function renderSounds() {
  $("slot-list").replaceChildren(...Array.from({ length: BassSounds.SLOTS }, (_, slot) => {
    const item = document.createElement("li");
    const button = actionButton(`${slot}`, "Choose this patch on the Bass Station", () => chooseSlot(slot));
    button.className = "slot-button";
    const name = document.createElement("span");
    name.textContent = BassSounds.factoryName(slot);
    button.append(name);
    item.append(button);
    return item;
  }));

  const ready = library.status === "ready";
  const folderState = {
    unsupported: ["Choose library folder", "Saving sounds to a folder needs Chrome or Edge on a computer."],
    none: ["Choose library folder", "Choose or create a folder on this computer for your sounds. Each sound is saved there as its own .syx file."],
    permission: ["Allow library folder", `Allow the page to use "${library.folder?.name}" again.`],
    missing: ["Choose library folder", `Couldn't read "${library.folder?.name}". Choose it again.`],
    ready: ["Change folder", ""],
  }[library.status];
  $("library-folder").textContent = folderState[0];
  $("library-folder").disabled = library.status === "unsupported";
  const skipped = library.skipped ? ` ${library.skipped} files there aren't single Bass Station patches, so they're left out.` : "";
  $("library-state").textContent = ready ? `"${library.folder.name}": ${plural(library.items.length, "sound")}.${skipped}` : folderState[1];
  for (const id of ["sound-import", "sound-export-all", "sound-search"]) $(id).disabled = !ready;

  const words = sounds.search.toLowerCase().split(/\s+/).filter(Boolean);
  const fromOf = (item) => library.info[item.name]?.from || "";
  const shown = ready ? library.items.filter((item) => words.every((word) => `${item.name} ${fromOf(item)}`.toLowerCase().includes(word))) : [];
  $("library-empty").hidden = !ready || library.items.length > 0;
  $("sound-list").replaceChildren(...shown.map((item) => {
    const row = document.createElement("li");
    row.className = "sound-row";
    const text = document.createElement("span");
    text.className = "sound-name";
    text.textContent = item.name;
    const from = document.createElement("small");
    from.textContent = fromOf(item) || `Patch ${BassSounds.slotOf(BassSounds.split(item.bytes)[0])}`;
    text.append(from);
    row.append(text,
      actionButton("Load", "Send this sound to the Bass Station", () => loadSound(item)),
      actionButton("Rename", "Rename this sound and its file", async () => {
        const name = window.prompt("Rename this sound", item.name)?.trim();
        if (!name) return;
        try {
          await library.rename(item, name);
        } catch (error) {
          setStatus(`Couldn't rename it: ${error.message}`, true);
        }
        renderSounds();
      }),
      actionButton("Delete", "Delete this sound's file from the library folder", async () => {
        if (!window.confirm(`Delete "${item.name}.syx" from the library folder?`)) return;
        try {
          await library.remove(item);
        } catch (error) {
          setStatus(`Couldn't delete it: ${error.message}`, true);
        }
        renderSounds();
      }));
    return row;
  }));

  $("backups-empty").hidden = !ready || sounds.backups.length > 0;
  $("backup-list").replaceChildren(...(ready ? sounds.backups : []).map((backup) => {
    const row = document.createElement("li");
    row.className = "sound-row";
    const text = document.createElement("span");
    text.className = "sound-name";
    text.textContent = backup.name;
    const count = document.createElement("small");
    count.textContent = `${plural(backup.patches.length, "patch", "patches")}, in the ${BACKUPS} folder`;
    text.append(count);
    row.append(text,
      actionButton("Add to library", "Add each of its patches to the library", () => addBackupToLibrary(backup)),
      actionButton("Delete", "Delete this backup's file", async () => {
        if (!window.confirm(`Delete "${backup.name}.syx" from the ${BACKUPS} folder?`)) return;
        try {
          await (await library.subfolder(BACKUPS)).remove(backup.name);
        } catch (error) {
          setStatus(`Couldn't delete it: ${error.message}`, true);
        }
        await readBackups();
        renderSounds();
      }));
    return row;
  }));
}

function bindSounds() {
  $("backup-all").addEventListener("click", backUpAll);
  $("save-current").addEventListener("click", saveCurrentSound);
  $("sound-search").addEventListener("input", (event) => {
    sounds.search = event.target.value;
    renderSounds();
  });
  $("sound-import").addEventListener("click", () => $("sound-import-file").click());
  $("sound-import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) importSounds(file);
  });
  $("sound-export-all").addEventListener("click", () => {
    if (!library.items.length) return;
    download(`bass-station-library-${new Date().toISOString().slice(0, 10)}.syx`, library.items.flatMap((item) => [...item.bytes]));
  });
  $("library-folder").addEventListener("click", chooseLibraryFolder);
}

/* ---------- Playback ---------- */

const ticker = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 25);"], { type: "text/javascript" })));
ticker.onmessage = () => { if (state.playing) schedule(); };

const msPerPulse = () => 60000 / (currentBpm() * PPQ);
const sendingClock = () => $("clock").checked;

function currentBpm() {
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

function schedule() {
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  const ms = msPerPulse();
  while (state.nextTime < horizon) {
    const playing = slot();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if (sendingClock() && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (from % PPQ === 0 && !state.sendOnce) click.at(state.nextTime, from % (4 * PPQ) === 0);
    scheduleMotions(from, to, ms);
    for (const note of playing.notes) {
      if (note.time >= from && note.time < to && Math.random() * 100 < (note.probability ?? 100)) {
        for (const part of Music.noteParts(note)) {
          sendNote(note.note, note.velocity, state.nextTime + (part.time - from) * ms, part.length * ms);
        }
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    state.nextPulse = to >= lengthPulses(playing) ? 0 : to;
    if (state.nextPulse === 0) {
      if (state.queued !== null) switchTo(state.queued);
      else advanceChain();
    }
  }
}

const chainList = () => (state.chainOn ? Music.parseChain(state.chain) || [] : []);

function advanceChain() {
  const chain = chainList();
  if (!chain.length) return;
  state.chainPos = (state.chainPos + 1) % chain.length;
  if (chain[state.chainPos] !== state.current) switchTo(chain[state.chainPos]);
  setStatus(`Chain: pattern ${chain[state.chainPos] + 1}, ${state.chainPos + 1} of ${chain.length}.`);
}

function setChain(text) {
  state.chain = text;
  const valid = Music.parseChain(text) !== null;
  $("chain").setAttribute("aria-invalid", String(!valid));
  if (!valid) setStatus("A chain is pattern numbers from 1 to 16, such as 1 1 2 3.", true);
  saveSoon();
}

// Plays the pattern's drawn knob movements. Each pass starts from the slider's value, as
// the movements only cover part of the pattern.
function scheduleMotions(from, to, ms) {
  const lanes = lanesFor();
  if (!lanes) return;
  const length = lengthPulses();
  for (const [id, points] of Object.entries(lanes)) {
    if (from === 0 && state.values[id] !== undefined) sendParam(id, state.values[id], state.nextTime);
    for (const point of points) {
      if (point.time >= from && point.time < to && point.time < length) {
        sendParam(id, point.value, state.nextTime + (point.time - from) * ms);
      }
    }
  }
}

function restoreAfterMotions() {
  const lanes = lanesFor();
  if (!lanes) return;
  for (const id of Object.keys(lanes)) {
    if (state.values[id] !== undefined) sendParam(id, state.values[id], performance.now() + SCHEDULE_AHEAD_MS + 25);
  }
}

/* ---------- Drawing knob movements ---------- */

const MOTION_TICKS = 30; // 8 points per 1/16 step.

// Movements drawn for a pattern, keyed by setting.
const lanesFor = (index = state.current) => state.slots[index].lanes || null;

function editableLanes() {
  slot().lanes ??= {};
  return slot().lanes;
}

// Settings with a controller of their own can move.
const SECTION_OF = new Map(BassParams.SECTIONS.flatMap((section) => section.params.map((param) => [param.id, section])));

function fillLaneOptions() {
  const lanes = lanesFor() || {};
  const select = $("lane-cc");
  const shown = BassParams.ALL.filter((param) => BassParams.isSlider(param) && param.cc !== undefined);
  select.replaceChildren(...shown.map((param) => new Option(
    `${lanes[param.id]?.length ? "* " : ""}${SECTION_OF.get(param.id).name} ${param.name}`, param.id)));
  if (!shown.some((param) => param.id === state.laneParam)) state.laneParam = shown[0]?.id || "";
  select.value = state.laneParam;
  // Keeps the choice when redrawing, and otherwise suggests the next pattern.
  const target = $("lane-copy-target");
  const chosen = Number(target.value);
  const others = state.slots.map((_, index) => index).filter((index) => index !== state.current);
  target.replaceChildren(...others.map((index) => new Option(`Pattern ${index + 1}`, String(index))));
  target.value = String(target.value !== "" && others.includes(chosen) ? chosen : (state.current + 1) % SLOTS);
}

// Copies every knob's movements, replacing whatever the other pattern has.
function copyLanesToPattern() {
  const lanes = lanesFor() || {};
  if (!Object.values(lanes).some((points) => points.length)) {
    setStatus("This pattern has no knob movements to copy.", true);
    return;
  }
  const index = Number($("lane-copy-target").value);
  const target = state.slots[index];
  const { lanes: copied, cut } = Music.copyLanes(lanes, lengthPulses(target));
  remember();
  target.lanes = copied;
  renderChrome();
  saveSoon();
  const count = Object.keys(copied).length;
  const past = cut ? " Pattern " + (index + 1) + " is shorter, so movements past its end were left out." : "";
  setStatus(`Copied ${count} ${count === 1 ? "knob's" : "knobs'"} movements to pattern ${index + 1}, replacing any it had. Undo takes it back.${past}`);
}

function setLaneVisible(visible) {
  state.showLane = visible;
  $("lane").hidden = !visible;
  $("lane-toggle").setAttribute("aria-pressed", String(visible));
  renderGrid();
  saveSoon();
}

function renderLane() {
  if (!state.showLane) return;
  fillLaneOptions();
  const first = document.querySelector(".cell");
  const last = document.querySelector(".grid > :last-child");
  if (!first || !last) return;
  const left = first.getBoundingClientRect().left;
  const width = last.getBoundingClientRect().right - left;
  const canvas = $("lane-canvas");
  const laneLeft = $("lane").getBoundingClientRect().left + parseFloat(getComputedStyle($("lane")).paddingLeft);
  canvas.style.marginLeft = `${left - laneLeft}px`;
  canvas.style.width = `${width}px`;
  const scale = window.devicePixelRatio || 1;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);
  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue("--cell");
  ctx.fillRect(0, 0, width, height);
  const span = state.windowSpan || 1;
  const xAt = (time) => ((time - state.windowStart) / span) * width;
  ctx.fillStyle = style.getPropertyValue("--line");
  for (let time = state.windowStart; time < state.windowStart + span; time += state.resolution) {
    ctx.fillRect(xAt(time), 0, 1, height);
  }
  ctx.fillStyle = style.getPropertyValue("--accent");
  const points = (lanesFor() || {})[state.laneParam] || [];
  for (const point of points) {
    if (point.time < state.windowStart || point.time >= state.windowStart + span) continue;
    const bar = (point.value / 127) * height;
    ctx.fillRect(xAt(point.time), height - bar, Math.max(1, xAt(point.time + MOTION_TICKS) - xAt(point.time)), bar);
  }
  // Where the knob sits outside the drawn movements.
  const resting = state.values[state.laneParam];
  if (resting !== undefined) {
    ctx.fillStyle = style.getPropertyValue("--strong");
    ctx.fillRect(0, height - (resting / 127) * height, width, 1);
  }
}

function setLanePoint(points, time, value, erase) {
  const index = points.findIndex((point) => point.time === time);
  if (erase) {
    if (index >= 0) points.splice(index, 1);
  } else if (index >= 0) {
    points[index].value = value;
  } else {
    points.push({ time, value });
  }
}

function laneStroke(event) {
  const drag = state.laneDraw;
  const box = $("lane-canvas").getBoundingClientRect();
  const x = Math.max(0, Math.min(box.width - 1, event.clientX - box.left));
  const y = Math.max(0, Math.min(box.height, event.clientY - box.top));
  const end = Math.min(state.windowStart + state.windowSpan, lengthPulses());
  const raw = state.windowStart + (x / box.width) * state.windowSpan;
  const time = Math.min(end - MOTION_TICKS, Math.floor(raw / MOTION_TICKS) * MOTION_TICKS);
  const value = Math.round((1 - y / box.height) * 127);
  const points = slot().lanes[state.laneParam];
  // Fills the gap since the last event, as a fast drag skips over points.
  const from = drag.last ? drag.last.time : time;
  const startValue = drag.last ? drag.last.value : value;
  const direction = time >= from ? MOTION_TICKS : -MOTION_TICKS;
  const count = Math.abs(time - from) / MOTION_TICKS;
  for (let index = 0; index <= count; index += 1) {
    const share = count ? index / count : 1;
    setLanePoint(points, from + index * direction, Math.round(startValue + (value - startValue) * share), drag.erase);
  }
  drag.last = { time, value };
  renderLane();
}

function bindLane() {
  const canvas = $("lane-canvas");
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!state.laneParam) {
      setStatus("Map a setting on the Synth tab first, then choose it here.", true);
      return;
    }
    remember();
    editableLanes()[state.laneParam] ??= [];
    state.laneDraw = { erase: event.altKey, last: null };
    canvas.setPointerCapture(event.pointerId);
    laneStroke(event);
    renderChrome();
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (state.laneDraw) laneStroke(event);
  });
  const finish = () => {
    if (!state.laneDraw) return;
    state.laneDraw = null;
    const lanes = slot().lanes;
    lanes[state.laneParam].sort((a, b) => a.time - b.time);
    if (!lanes[state.laneParam].length) delete lanes[state.laneParam];
    renderLane();
    saveSoon();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  $("lane-cc").addEventListener("change", (event) => {
    state.laneParam = event.target.value;
    renderLane();
    saveSoon();
  });
  $("lane-clear").addEventListener("click", () => {
    if (!(lanesFor() || {})[state.laneParam]?.length) return;
    remember();
    delete editableLanes()[state.laneParam];
    if (state.values[state.laneParam] !== undefined) sendParam(state.laneParam, state.values[state.laneParam]);
    renderLane();
    renderChrome();
    saveSoon();
  });
  $("lane-toggle").addEventListener("click", () => setLaneVisible(!state.showLane));
  setUpRecorder();
  $("lane-copy").addEventListener("click", copyLanesToPattern);
}

function renderPeers(names) {
  const pill = $("sync-peers");
  pill.hidden = !$("sync").checked;
  pill.textContent = names.length ? `Linked: ${names.join(", ")}` : "Not linked";
  pill.className = `pill ${names.length ? "ok" : ""}`;
  pill.title = names.length ? "Play, stop and tempo are shared with this page." : "The other grid isn't open in this browser, or has Sync off.";
}

// Plays together with the other grid when both are open. See sync.js.
const link = Sync.connect({
  name: "Bass Station Grid",
  checkbox: $("sync"),
  storageKey: "bass-station-grid-sync",
  start({ bpm, at }) {
    if (state.playing) stop({ fromLink: true });
    state.bpm = bpm;
    $("bpm").value = bpm;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  tempo({ bpm, at, pulse }) {
    state.bpm = bpm;
    $("bpm").value = bpm;
    if (!state.playing || !Number.isFinite(pulse)) return;
    state.nextTime = Sync.aligned({
      nextTime: state.nextTime, nextPulse: state.nextPulse, at, pulse, msPerPulse: msPerPulse(), pulsesPerBeat: PPQ,
    });
  },
  status: (message, isError) => setStatus(message, isError),
  peers: renderPeers,
});
renderPeers([]);

const announceTempo = () => link.announceTempo({
  bpm: currentBpm(), nextTime: state.nextTime, nextPulse: state.playing ? state.nextPulse : 0,
});

function play({ startAt = null, fromLink = false } = {}) {
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the Bass Station and turn it on.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const chain = chainList();
  if (chain.length) {
    state.chainPos = 0;
    if (state.current !== chain[0]) switchTo(chain[0]);
  }
  const shared = fromLink ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  if (sendingClock()) state.output.send([0xFA], state.nextTime);
  $("play").textContent = "Stop";
  $("playhead").hidden = false;
  schedule();
  requestAnimationFrame(drawPlayhead);
}

function allNotesOff(at) {
  sendController(CC_ALL_NOTES_OFF, 0, at);
}

function stop({ fromLink = false } = {}) {
  state.queued = null;
  if (!state.playing) return;
  if (!fromLink) link.announceStop();
  if (sendingClock() && state.output) state.output.send([0xFC]);
  state.playing = false;
  // Notes already scheduled can still start, so this repeats just after them.
  allNotesOff(performance.now());
  allNotesOff(performance.now() + SCHEDULE_AHEAD_MS + 20);
  restoreAfterMotions();
  $("play").textContent = "Play";
  $("playhead").hidden = true;
  renderSlots();
}

function panic() {
  stop();
  if (!sendController(CC_ALL_SOUND_OFF, 0)) {
    setStatus("No MIDI output connected.", true);
    return;
  }
  allNotesOff();
  setStatus("All notes off.");
}

// Where playback is at a given moment.
function pulseAt(time) {
  const length = lengthPulses();
  const behind = (state.nextTime - time) / msPerPulse();
  return ((state.nextPulse - behind) % length + length) % length;
}

function drawPlayhead() {
  if (!state.playing) return;
  const pulse = pulseAt(performance.now());
  const playingPage = Math.floor(pulse / (state.pageBars * BAR));
  // Page turns redraw the grid, so they wait while a step is being edited.
  if (playingPage !== state.page && !state.editor && !state.lengthDrag && !state.paint) goToPage(playingPage);
  const firstCell = document.querySelector(".cell");
  const lastCell = document.querySelector(".grid > :last-child");
  if (firstCell && lastCell) {
    const origin = firstCell.offsetLeft;
    const width = lastCell.offsetLeft + lastCell.offsetWidth - origin;
    const head = $("playhead");
    head.style.left = `${origin + ((pulse - state.windowStart) / state.windowSpan) * width}px`;
    head.style.height = `${$("grid").offsetHeight}px`;
    head.hidden = playingPage !== state.page;
  }
  requestAnimationFrame(drawPlayhead);
}

function exportMidi() {
  if (!notes().length) {
    setStatus("This pattern has no notes to export.", true);
    return;
  }
  const bytes = Music.midiFile(notes(), { bpm: currentBpm(), channel: state.channel });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  const key = `${Music.NOTE_NAMES[state.root].replace("#", "sharp")}-${state.scale}`;
  link.download = `bass-station-grid-pattern-${state.current + 1}-${key}.mid`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`Exported pattern ${state.current + 1}.`);
}

function downloadBackup() {
  const file = new Blob([JSON.stringify(Backup.pack(state))], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `bass-station-grid-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus("Saved all 16 patterns to a file.");
}

async function restoreBackup(file) {
  let data;
  try {
    data = Backup.unpack(JSON.parse(await file.text()), { scales: Music.SCALES, params: BassParams.BY_ID });
  } catch (error) {
    setStatus(`Couldn't restore ${file.name}: ${error.message}`, true);
    return;
  }
  if (state.slots.some((item) => item.notes.length)
    && !window.confirm(`Replace all 16 patterns with the ones in ${file.name}?`)) return;
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  Object.assign(state, data);
  state.page = 0;
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  renderAll();
  saveSoon();
  setStatus(`Restored ${file.name}. Undo brings back the patterns you had.`);
}

const IMPORT_BARS = [1, 2, 4, 8];

// Where a file has chords, keeps the highest note starting at each moment.
function topNotes(list) {
  const highest = new Map();
  for (const note of list) {
    const kept = highest.get(note.time);
    if (!kept || note.note > kept.note) highest.set(note.time, note);
  }
  return [...highest.values()].sort((a, b) => a.time - b.time);
}

// Replaces the current pattern, which Undo brings back. The sound doesn't change.
async function importMidi(file) {
  let parsed;
  try {
    parsed = Music.parseMidi(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    setStatus(`Couldn't read ${file.name}: ${error.message}`, true);
    return;
  }
  if (!parsed.notes.length) {
    setStatus(`${file.name} has no notes to import.`, true);
    return;
  }
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  const end = Math.max(...parsed.notes.map((n) => n.time + n.length));
  const bars = IMPORT_BARS.find((count) => end <= count * BAR) ?? IMPORT_BARS.at(-1);
  const limit = bars * BAR;
  const kept = topNotes(parsed.notes)
    .filter((n) => n.time < limit)
    .map((n) => ({ ...n, length: Math.min(n.length, limit - n.time) }));
  slot().bars = bars;
  slot().notes = kept;
  delete slot().lanes;
  if (parsed.bpm) state.bpm = Math.max(20, Math.min(300, Math.round(parsed.bpm * 10) / 10));
  const key = Music.detectKey(kept);
  if (key) Object.assign(state, key);
  const lowest = Math.min(...kept.map((n) => n.note));
  state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  state.page = 0;
  renderAll();
  saveSoon();
  const cut = end > limit ? ` It's longer than ${bars} bars, so the rest was cut.` : "";
  const count = `${kept.length} ${kept.length === 1 ? "note" : "notes"}`;
  setStatus(`Imported ${count} from ${file.name} into pattern ${state.current + 1}. Undo brings the old one back.${cut}`);
}

const THEME_KEY = "bass-station-grid-theme";

function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = theme === "light" ? "Dark mode" : "Light mode";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private windows can refuse storage, so the theme just isn't remembered.
  }
  renderLane();
}

/* ---------- Controls ---------- */

function openHelp() {
  closeNoteEditor({ restoreFocus: false });
  $("help").showModal();
  document.querySelector(".help-body").scrollTop = 0;
}

function fillSelects() {
  $("scale").replaceChildren(...Object.entries(Music.SCALES).map(
    ([id, scale]) => new Option(scale.name, id)));
  // Chords are left out, as the Bass Station plays one note at a time.
  $("generator").replaceChildren(...Object.entries(Music.GENERATORS).filter(([id]) => id !== "chords").map(
    ([id, name]) => new Option(name, id)));
  const octaves = [];
  for (let octave = 1; octave <= 6; octave += 1) octaves.push(new Option(`C${octave}`, String(octave)));
  $("octave").replaceChildren(...octaves);
  const channels = [];
  for (let channel = 1; channel <= 16; channel += 1) channels.push(new Option(String(channel), String(channel)));
  $("channel").replaceChildren(...channels);
}

function bindControls() {
  const number = (id, apply) => $(id).addEventListener("change", (event) => {
    apply(Number(event.target.value));
    saveSoon();
  });
  $("scale").addEventListener("change", (event) => setKey(state.root, event.target.value));
  $("move-notes").addEventListener("change", (event) => {
    state.moveNotes = event.target.checked;
    saveSoon();
  });
  $("steps").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setSteps(Number(button.dataset.value), state.triplets);
  });
  $("triplets").addEventListener("click", () => setSteps(state.baseResolution, !state.triplets));
  number("bars", setBars);
  number("bpm", (value) => { state.bpm = currentBpm(); $("bpm").value = state.bpm; announceTempo(); void value; });
  number("octave", (value) => { state.lowOctave = value; renderGrid(); });
  number("span", (value) => { state.span = value; renderGrid(); });
  number("channel", (value) => {
    state.channel = value - 1;
    updateEditorSettings();
  });
  $("new-length").addEventListener("change", (event) => { state.newLength = event.target.value; saveSoon(); });
  $("show-all").addEventListener("change", (event) => {
    state.showAll = event.target.checked;
    renderGrid();
    saveSoon();
  });
  $("output").addEventListener("change", (event) => {
    state.output = state.midi.outputs.get(event.target.value) || null;
    // Pairs the input with the new output, and passes both on to the editor.
    refreshPorts();
    if (state.output) setMidiPill(`MIDI: ${state.output.name}`, isBassStation(state.output) ? "ok" : "");
  });
  $("page-prev").addEventListener("click", () => goToPage(state.page - 1));
  $("page-next").addEventListener("click", () => goToPage(state.page + 1));
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderGrid, 100);
  });
  $("midi-retry").addEventListener("click", initMidi);
  $("play").addEventListener("click", () => (state.playing ? stop() : play()));
  $("stop-all").addEventListener("click", panic);
  $("export").addEventListener("click", exportMidi);
  $("import").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    // Cleared so that choosing the same file again still counts as a change.
    event.target.value = "";
    if (file) importMidi(file);
  });
  $("shift-left").addEventListener("click", () => shiftInTime(-1));
  $("shift-right").addEventListener("click", () => shiftInTime(1));
  $("scale-down").addEventListener("click", () => shiftInScale(-1));
  $("scale-up").addEventListener("click", () => shiftInScale(1));
  $("copy").addEventListener("click", copySelection);
  $("paste").addEventListener("click", pasteClipboard);
  $("velocity-set").addEventListener("click", setBulkVelocity);
  $("chain").addEventListener("change", (event) => setChain(event.target.value));
  $("chain-on").addEventListener("change", (event) => {
    state.chainOn = event.target.checked;
    saveSoon();
  });
  $("backup").addEventListener("click", downloadBackup);
  $("restore").addEventListener("click", () => $("restore-file").click());
  $("restore-file").addEventListener("change", (event) => {
    const [file] = event.target.files;
    event.target.value = "";
    if (file) restoreBackup(file);
  });
  $("theme-toggle").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "light" ? "Dark mode" : "Light mode";
  $("octave-down").addEventListener("click", () => shiftOctave(-1));
  $("octave-up").addEventListener("click", () => shiftOctave(1));
  $("generate").addEventListener("click", generatePattern);
  $("undo").addEventListener("click", undo);
  $("duplicate").addEventListener("click", duplicatePattern);
  $("clear").addEventListener("click", () => {
    if (!notes().length) return;
    remember();
    slot().notes = [];
    renderGrid();
    renderChrome();
    saveSoon();
  });
  $("views").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) setView(button.dataset.view);
  });
  $("help-open").addEventListener("click", openHelp);
  $("help-close").addEventListener("click", () => $("help").close());
  $("help").addEventListener("click", (event) => {
    if (event.target === $("help")) $("help").close();
  });

  const typing = (target) => /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);
  window.addEventListener("keydown", (event) => {
    if ($("help").open) return;
    if (event.key === "?" && !typing(event.target)) {
      openHelp();
      return;
    }
    if (event.key === "Escape" && state.editor) {
      closeNoteEditor();
      return;
    }
    // Space is the transport wherever you've last clicked, unless you're writing text.
    const writing = event.target.tagName === "TEXTAREA" || /^(text|search)$/.test(event.target.type);
    if (event.code === "Space" && !writing && !event.metaKey && !event.ctrlKey && !event.altKey
      && !event.target.closest?.("#note-editor") && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      if (!event.repeat) {
        if (state.playing) stop(); else play();
      }
      return;
    }
    if (typing(event.target) || event.target.closest?.("#note-editor")) return;
    if ((event.metaKey || event.ctrlKey) && event.key === "c") {
      event.preventDefault();
      copySelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "v") {
      event.preventDefault();
      pasteClipboard();
    } else if (event.key === "Escape") {
      clearSelection();
    } else if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      undo();
    } else if (event.key === "t" && !event.metaKey && !event.ctrlKey) {
      setSteps(state.baseResolution, !state.triplets);
    }
  });
}

async function start() {
  restore();
  fillSelects();
  bindControls();
  bindGridEvents();
  bindNoteEditor();
  bindLane();
  $("edit-substep").replaceChildren(...Music.SUB_STEPS.map((pattern, index) => new Option(index ? pattern.replaceAll("_", "-") : "Off", String(index))));
  $("chain").value = state.chain;
  $("chain-on").checked = state.chainOn;
  $("lane").hidden = !state.showLane;
  $("lane-toggle").setAttribute("aria-pressed", String(state.showLane));
  bindSounds();
  renderSounds();
  openLibrary().catch((error) => setStatus(`Couldn't open the library folder: ${error.message}`, true));
  renderAll();
  setView(state.view);
  setStatus("Choose a key, then click or drag on the grid to add notes.");
  await initMidi();
}

start().catch((error) => setStatus(error.message, true));
