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
  favouritesOnly: false, // The Sound library shows only favourites.
  slotFavourites: [], // Patches on the Bass Station marked as favourites.
  slotFavouritesOnly: false,
  chosenSlot: null, // The patch last chosen, highlighted in the list.
  arp: "patch", // The arpeggiator: as each patch has it, or kept "off" or "on".
  loadedSound: null, // The sound last sent to or chosen on the Bass Station, as bytes, to mark it in the library.
  keyOff: false, // No key: every note shows, and nothing is marked as in or out of it.
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
  redo: [],
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
      "newLength", "lowOctave", "span", "showAll", "keyOff", "loadedSound", "favouritesOnly", "baseResolution", "triplets", "view",
      "slotFavourites", "slotFavouritesOnly", "chosenSlot", "arp",
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

// The key the grid and its tools follow. With the key off, that's every note.
const keyRoot = () => (state.keyOff ? 0 : state.root);
const keyScale = () => (state.keyOff ? "chromatic" : state.scale);
const currentKeyName = () => `${Music.NOTE_NAMES[state.root]} ${Music.SCALES[state.scale].name.toLowerCase()}`;

// Turns the key off or back on. Notes stay where they are either way.
function setKeyOff(off) {
  if (off === state.keyOff) return;
  closeNoteEditor({ restoreFocus: false });
  state.keyOff = off;
  renderAll();
  saveSoon();
  setStatus(off ? "Key off. The grid shows every note, and notes stay where they are." : `Key: ${currentKeyName()}. Notes weren't moved.`);
}

function setKey(root, scale) {
  if (state.keyOff) {
    // Turning the key on snaps each note to the nearest one in the key, without moving
    // the pattern to another root, so imported notes fall into place.
    closeNoteEditor({ restoreFocus: false });
    remember();
    if (state.moveNotes) {
      for (const item of state.slots) item.notes = Music.mapNotes(item.notes, root, "chromatic", root, scale);
    }
    state.root = root;
    state.scale = scale;
    state.keyOff = false;
    renderAll();
    saveSoon();
    setStatus(state.moveNotes ? `Key: ${currentKeyName()}. Notes moved to the nearest notes in the key.` : `Key: ${currentKeyName()}. Notes weren't moved.`);
    return;
  }
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
  $("root").value = state.keyOff ? "off" : String(state.root);
  $("scale").value = state.keyOff ? "off" : state.scale;
  $("move-notes").checked = state.moveNotes;
  $("generate").disabled = state.keyOff;
  $("generate").title = state.keyOff
    ? "Choose a key to generate a pattern, as ideas are written in a key"
    : "Replaces this pattern with a new one in the key. Undo brings the old one back.";
}

// Rows from high to low. Notes already in the pattern are never hidden.
function rowNotes() {
  const low = lowNote();
  const high = low + state.span * 12;
  const rows = new Set(state.showAll || state.keyOff
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

// A pattern with a sound sends it as it starts. Without one, the sound stays as it is.
function switchTo(index) {
  restoreAfterMotions();
  state.current = index;
  state.queued = null;
  state.page = 0;
  renderAll();
  saveSoon();
  sendPatternSound();
}

/* ---------- A sound for each pattern ---------- */

// The pattern keeps its own copy of the sound, so renaming or deleting it in the
// library doesn't change the pattern.
function sendPatternSound() {
  const sound = slot().sound;
  if (!sound || !state.output) return;
  loadSound({ name: sound.name, bytes: Uint8Array.from(sound.bytes) }, { quiet: true })
    .catch((error) => setStatus(`Couldn't send pattern ${state.current + 1}'s sound: ${error.message}`, true));
}

function renderPatternSound() {
  const select = $("pattern-sound");
  if (!select) return;
  const sound = slot().sound;
  const options = [new Option("Whatever's loaded", "")];
  const items = library.status === "ready" ? library.items : [];
  const match = sound ? items.findIndex((item) => BassSounds.sameSound(item.bytes, Uint8Array.from(sound.bytes))) : -1;
  if (sound && match < 0) options.push(new Option(`${sound.name} (kept with the pattern)`, "kept"));
  for (const [index, item] of items.entries()) options.push(new Option(item.name, String(index)));
  select.replaceChildren(...options);
  select.value = !sound ? "" : match >= 0 ? String(match) : "kept";
  select.title = sound ? `Pattern ${state.current + 1} plays with "${sound.name}"` : `Pattern ${state.current + 1} plays with whatever sound is loaded`;
}

function choosePatternSound(value) {
  if (value === "kept") return;
  if (value === "") {
    slot().sound = null;
    setStatus(`Pattern ${state.current + 1} now plays with whatever sound is loaded.`);
  } else {
    const item = library.items[Number(value)];
    if (!item) return;
    slot().sound = { name: item.name, bytes: Array.from(item.bytes) };
    if (state.output) {
      setStatus(`Pattern ${state.current + 1} now plays with "${item.name}". Sending it to the Bass Station...`);
      loadSound(item, { quiet: true })
        .then(() => setStatus(`Pattern ${state.current + 1} now plays with "${item.name}", and it's been sent to the Bass Station.`))
        .catch((error) => setStatus(`Couldn't send "${item.name}": ${error.message}`, true));
    } else {
      setStatus(`Pattern ${state.current + 1} now plays with "${item.name}". It's sent once the Bass Station is connected and the pattern starts.`, true);
    }
  }
  renderPatternSound();
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
  // The copy is a new pattern, so it doesn't save over the original's file.
  state.slots[target].fileKey = null;
  if (state.slots[target].name) state.slots[target].name = `${state.slots[target].name} copy`;
  switchTo(target);
  setStatus(`Copied to pattern ${target + 1}.`);
}

function generatePattern() {
  if (state.keyOff) {
    setStatus("Choose a key first. Ideas are written in a key.", true);
    return;
  }
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
  const moved = Music.shiftInScale(notes(), steps, keyRoot(), keyScale());
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

// The state that Undo and Redo bring back.
function snapshot() {
  return {
    json: JSON.stringify({ root: state.root, scale: state.scale, keyOff: state.keyOff, slots: state.slots, current: state.current, bpm: state.bpm }),
  };
}

function remember() {
  state.undo.push(snapshot());
  if (state.undo.length > 100) state.undo.shift();
  state.redo = [];
  renderUndo();
}

function renderUndo() {
  $("undo").disabled = state.undo.length === 0;
  $("redo").disabled = state.redo.length === 0;
}

const undo = () => stepHistory(state.undo, state.redo);
const redo = () => stepHistory(state.redo, state.undo);

// Brings back the last state from one list, keeping the current one in the other.
function stepHistory(from, to) {
  const last = from.pop();
  if (!last) return;
  to.push(snapshot());
  closeNoteEditor({ restoreFocus: false });
  Object.assign(state, JSON.parse(last.json));
  renderAll();
  if (state.playing) announceTempo();
  saveSoon();
  renderUndo();
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
    const isRoot = !state.keyOff && (note - state.root) % 12 === 0;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "note-label";
    label.textContent = Music.noteName(note);
    label.classList.toggle("root", isRoot);
    const fits = state.keyOff || Music.inKey(note, state.root, state.scale);
    label.classList.toggle("out-of-key", !fits);
    label.title = fits ? `Note ${note}. Click to hear it.` : `Note ${note}, outside the key. Click to hear it.`;
    holdNoteOn(label, note);
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
  const PATTERN_END = lengthPulses();
  for (const note of notes()) {
    const noteEnd = note.time + note.length;
    // The part of a note that crosses the pattern's end, drawn at its start.
    const overflow = noteEnd - PATTERN_END;
    if (overflow > 0 && overflow > start && 0 < end) {
      const tailStart = Math.max(0, start);
      const tailCell = cellElement(note.note, Math.floor(tailStart / state.resolution) * state.resolution);
      if (tailCell) {
        const tailSteps = (Math.min(overflow, end) - tailStart) / state.resolution;
        const tailBar = document.createElement("span");
        tailBar.className = "note-bar wrapped";
        tailBar.title = "The end of a note that starts near the end of the pattern";
        tailBar.style.setProperty("--steps", String(tailSteps));
        tailBar.style.setProperty("--gaps", String(Math.max(0, Math.ceil(tailSteps) - 1)));
        tailBar.style.left = `${((tailStart - Math.floor(tailStart / state.resolution) * state.resolution) / state.resolution) * 100}%`;
        tailBar.style.setProperty("--velocity", String(0.3 + 0.7 * note.velocity));
        tailCell.append(tailBar);
      }
    }
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
    // Its start, when the note begins on this page.
    if (note.time === barStart) {
      const startHandle = document.createElement("span");
      startHandle.className = "note-handle note-start";
      startHandle.title = "Drag to change where this note starts. Its end stays put. Hold Alt for finer control.";
      bar.append(startHandle);
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
  renderUndo();
  renderSlots();
  renderPatternName();
  renderPatternSound();
  renderArp();
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
  const edge = handle.classList.contains("note-start") ? "start" : "end";
  state.lengthDrag = { items: [found], anchorTime, cell, pressed: true, startX: event.clientX, edge };
  event.preventDefault();
}

// Dragging a note's start moves where it begins, while its end stays put. Like resizing,
// it moves in fine steps, and Alt gives single ticks.
function moveStartDrag(event, drag, box, items, setItems) {
  const gap = parseFloat(getComputedStyle($("grid")).getPropertyValue("--grid-gap")) || 0;
  const ticksAt = (x) => drag.anchorTime + ((x - box.left) / (box.width + gap)) * state.resolution;
  drag.ends ??= items.map((item) => item.time + item.length);
  if (drag.grabOffset === undefined) drag.grabOffset = items[0].time - ticksAt(drag.startX);
  const pointer = ticksAt(event.clientX) + drag.grabOffset;
  const divisions = box.width < NARROW_STEP_PX ? FINE_DIVISIONS / 2 : FINE_DIVISIONS;
  const unit = event.altKey ? 1 : state.resolution / divisions;
  const latest = Math.min(...drag.ends) - (event.altKey ? 1 : unit);
  const start = Math.max(state.windowStart, Math.min(latest, Math.round(pointer / unit) * unit));
  const before = items[0].time;
  if (start !== before) {
    items.forEach((item, index) => {
      item.time = start;
      item.length = drag.ends[index] - start;
    });
    setItems();
    for (const time of [before, start]) {
      const cell = cellElement(items[0].note, Math.floor(time / state.resolution) * state.resolution);
      if (cell) paintCell(cell);
    }
    renderNoteBars();
  }
  const step = start / state.resolution + 1;
  setStatus(`Starts at step ${Number.isInteger(step) ? step : step.toFixed(2)}, ${describeLength(drag.ends[0] - start)} long. The end stays where it was.`);
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
  if (drag.edge === "start") {
    moveStartDrag(event, drag, box, drag.items, () => notes().sort((a, b) => a.time - b.time || a.note - b.note));
    return;
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
      // Dragging a note changes it, so it's only removed by a click that doesn't move. The
      // left part of the note moves its start, and the rest changes its length.
      const box = cell.getBoundingClientRect();
      state.lengthDrag = {
        items: notesInCell(note, time), anchorTime: time, cell, pressed: true, startX: event.clientX,
        edge: event.clientX < box.left + box.width * 0.4 ? "start" : "end",
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
  // A patch chosen on the Bass Station brings its own arpeggiator setting, so a kept
  // setting is sent again once the patch has loaded.
  if ((status & 0x0F) === state.channel && (status & 0xF0) === 0xC0) {
    state.chosenSlot = first;
    renderSounds();
    window.setTimeout(() => applyArp(), PATCH_SETTLE_MS);
    return;
  }
  if ((status & 0x0F) !== state.channel || (status & 0xF0) !== 0xB0) return;
  const param = BassParams.BY_CC.get(first);
  if (!param) return;
  const at = event.timeStamp || performance.now();
  if (isEcho(first, second, at)) return;
  state.values[param.id] = second;
  const recorded = BassParams.isSlider(param) && recordKnob(param.id, second, at);
  if (!recorded && param.id === state.laneParam) renderLane();
}

function sendController(cc, value, atTime) {
  if (!state.output) return false;
  const message = [0xB0 | state.channel, cc, Math.max(0, Math.min(127, Math.round(value)))];
  sentControllers.set(cc, { value: message[2], at: atTime ?? performance.now() });
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
      state.knobTake = new Map();
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
  }, { storageKey: "bass-station-grid-record-input", button: $("record"), input: $("record-input"), channel: $("record-channel"), snap: $("record-snap") });
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

// A note name plays its note for as long as it's held down.
function holdNoteOn(element, note) {
  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!state.output) {
      setStatus("No MIDI output connected.", true);
      return;
    }
    const output = state.output;
    const channel = state.channel;
    const now = performance.now();
    recorder.sent(note, now);
    output.send([0x90 | channel, note, 127]);
    element.classList.add("held");
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      output.send([0x80 | channel, note, 0]);
      element.classList.remove("held");
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element.removeEventListener(type, release);
    };
    // Captures the pointer, so letting go anywhere ends the note.
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // It still ends when let go over the name.
    }
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) element.addEventListener(type, release);
    // In case the grid is redrawn while the name is held.
    window.addEventListener("pointerup", release, { once: true });
  });
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
  const cleared = await removeDuplicates();
  await readBackups();
  await readPatterns();
  return [moved, clearedMessage(cleared)].filter(Boolean).join(" ");
}

// Deletes sounds that are the same as another in the library, wherever each was stored on
// the Bass Station, keeping one of each. The copy named after the patch's own name is the
// one kept, if there is one. Returns how many were deleted.
async function removeDuplicates() {
  const kept = [];
  const extra = [];
  for (const item of library.items) {
    const index = kept.findIndex((other) => BassSounds.sameSound(other.bytes, item.bytes));
    if (index < 0) {
      kept.push(item);
      continue;
    }
    const own = BassSounds.patchName(item.bytes);
    if (own && item.name === own && kept[index].name !== own) {
      extra.push(kept[index]);
      kept[index] = item;
    } else {
      extra.push(item);
    }
  }
  try {
    for (const item of extra) await library.remove(item);
  } catch (error) {
    setStatus(`Couldn't clear duplicate sounds from the library folder: ${error.message}`, true);
  }
  return extra.length;
}

const clearedMessage = (count) => (count ? `Cleared ${plural(count, "duplicate sound")} from the library.` : "");

/* ---------- Pattern library ---------- */

// Patterns are kept as .json files in the library folder's Patterns folder, with their
// notes, bars, knob movements and tempo, so they come back exactly as saved, and the
// Bass Station's sound when they were saved, if it could be read.
const PATTERNS = "Patterns";
const patterns = { items: [], search: "" };
const patternFolder = () => library.subfolder(PATTERNS, ".json");

function readPatternFile(bytes) {
  try {
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || data.app !== "bass-station-grid" || !Array.isArray(data.notes)) return null;
    const notes = data.notes.filter((item) => item && [item.time, item.note, item.length].every(Number.isFinite)
      && item.note >= 0 && item.note <= 127 && item.time >= 0 && item.length > 0);
    const sound = Array.isArray(data.sound) ? new Uint8Array(data.sound) : null;
    return {
      bars: [1, 2, 4, 8].includes(data.bars) ? data.bars : 4,
      notes,
      lanes: data.lanes && typeof data.lanes === "object" ? data.lanes : null,
      bpm: Number.isFinite(data.bpm) ? Math.max(20, Math.min(300, data.bpm)) : null,
      sound: sound && BassSounds.split(sound).length === 1 ? sound : null,
      soundFrom: typeof data.soundFrom === "string" ? data.soundFrom : "",
    };
  } catch {
    return null;
  }
}

async function readPatterns() {
  patterns.items = [];
  if (library.status !== "ready") return;
  try {
    for (const file of await (await patternFolder()).list()) {
      const pattern = readPatternFile(file.bytes);
      if (pattern) patterns.items.push({ name: file.name, ...pattern });
    }
  } catch {
    // The folder can't be read, so the list stays empty.
  }
}

// Patterns are saved in the library folder, so this asks for it first if it isn't open.
// It's called straight from a click, as the browser only shows its folder picker then.
async function ensureLibrary() {
  if (library.status === "ready") return true;
  if (library.status === "unsupported") return libraryReady();
  setStatus("Choose the library folder, where your sounds and patterns are saved.");
  await chooseLibraryFolder();
  return library.status === "ready";
}

/* ---------- Pattern files ---------- */

// Patterns are saved as files with the Mac's Save dialog, anywhere, starting in the library
// folder's Patterns folder. Each pattern remembers its file, so Save writes to it again.
const patternFiles = NamedFile.create({
  db: "bass-station-grid-files", id: "bass-station-grid-patterns", extension: ".json",
  description: "Bass Station Grid pattern", mime: "application/json",
});

function renderPatternName() {
  const name = slot().name || "";
  const label = $("pattern-name");
  if (!label) return;
  label.textContent = name || "Untitled";
  label.classList.toggle("untitled", !name);
  label.title = name
    ? `Pattern ${state.current + 1} is "${name}". Save writes to its file again.`
    : `Pattern ${state.current + 1} hasn't been saved as a file yet. Save asks where to save it.`;
}

// Where the Save and Open dialogs start, the first time: the library's Patterns folder.
async function patternsStart() {
  if (library.status !== "ready") return undefined;
  try {
    return await library.folder.getDirectoryHandle(PATTERNS, { create: true });
  } catch {
    return undefined;
  }
}

// The pattern as a file, with its sound: its own, or the Bass Station's, edits included.
async function patternContents(index, result) {
  const item = state.slots[index];
  const data = { app: "bass-station-grid", version: 1, bars: item.bars, bpm: currentBpm(), notes: item.notes, lanes: item.lanes || null };
  const canRead = state.output && state.input && state.midi.sysexEnabled && !sounds.busy;
  const patch = item.sound ? Uint8Array.from(item.sound.bytes) : canRead ? await requestPatch() : null;
  if (patch) {
    data.sound = Array.from(patch);
    data.soundFrom = item.sound ? `"${item.sound.name}", ${today()}` : `Patch ${BassSounds.slotOf(patch)}, ${today()}`;
  }
  result.patch = patch;
  return new TextEncoder().encode(JSON.stringify(data, null, 1));
}

// Save writes to the pattern's file again. Save as, or Save with no file yet, asks where.
async function savePattern({ asNew = false } = {}) {
  const index = state.current;
  const item = state.slots[index];
  if (!item.notes.length && !(item.lanes && Object.keys(item.lanes).length)) {
    setStatus(`Pattern ${index + 1} is empty, so there's nothing to save. Add notes first.`, true);
    return;
  }
  if (!patternFiles.supported()) {
    setStatus("Saving patterns as files needs Chrome or Edge on a computer.", true);
    return;
  }
  const result = {};
  try {
    let saved = null;
    if (!asNew && item.fileKey) saved = await patternFiles.save(item.fileKey, () => patternContents(index, result));
    if (!saved) {
      const key = NamedFile.newKey();
      saved = await patternFiles.saveAs(key, item.name || `Pattern ${index + 1}`, () => patternContents(index, result), { startIn: await patternsStart() });
      if (!saved) {
        setStatus("Not saved.");
        return;
      }
      item.fileKey = key;
    }
    item.name = saved.name;
    // The sound also goes into the sound library, named after the pattern, unless it's there.
    let soundAdded = null;
    if (result.patch && library.status === "ready" && !inLibrary(result.patch)) {
      try {
        soundAdded = await library.add(saved.name, result.patch, { from: `Pattern "${saved.name}", ${today()}` });
      } catch {
        soundAdded = null;
      }
    }
    saveSoon();
    renderPatternName();
    if (library.status === "ready") await readPatterns();
    renderSounds();
    const withSound = !result.patch
      ? ". The Bass Station's sound couldn't be read, so it was saved without one"
      : soundAdded ? `, with its sound, which is also in the sound library as "${soundAdded}"` : ", with its sound";
    setStatus(`Saved "${saved.name}"${withSound}.`, !result.patch);
  } catch (error) {
    setStatus(`Couldn't save it: ${error.message}`, true);
  }
}

// Opens a pattern file from anywhere, with the Mac's Open dialog, into the pattern you're on.
async function openPattern() {
  if (!patternFiles.supported()) {
    setStatus("Opening pattern files needs Chrome or Edge on a computer.", true);
    return;
  }
  const key = NamedFile.newKey();
  try {
    const opened = await patternFiles.open(key, { startIn: await patternsStart() });
    if (!opened) return;
    const pattern = readPatternFile(opened.bytes);
    if (!pattern) {
      await patternFiles.forget(key);
      setStatus(`"${opened.name}" isn't a Bass Station Grid pattern.`, true);
      return;
    }
    loadSavedPattern({ name: opened.name, ...pattern, fileKey: key });
  } catch (error) {
    setStatus(`Couldn't open it: ${error.message}`, true);
  }
}

// Loads a pattern from the library list, remembering its file so Save writes to it.
async function loadLibraryPattern(item, options) {
  let fileKey = null;
  try {
    const folder = await patternsStart();
    if (folder) {
      fileKey = NamedFile.newKey();
      await patternFiles.remember(fileKey, await folder.getFileHandle(`${item.name}.json`));
    }
  } catch {
    fileKey = null;
  }
  loadSavedPattern({ ...item, fileKey }, options);
}

// Shows the saved patterns, on the Library tab.
async function showSavedPatterns() {
  if (!(await ensureLibrary())) return;
  setView("sounds");
  renderSounds();
  $("pattern-search").scrollIntoView({ block: "center" });
  $("pattern-search").focus();
  setStatus(patterns.items.length
    ? `Click Load on a pattern to put it into pattern ${state.current + 1}.`
    : "No saved patterns yet. Save, beside the pattern's name on the Grid tab, saves the one you're on.");
}

// Puts a saved pattern into the current pattern, and its sound on the Bass Station unless
// notesOnly. Undo brings back the notes that were there.
function loadSavedPattern(item, { notesOnly = false } = {}) {
  stop();
  closeNoteEditor({ restoreFocus: false });
  remember();
  state.slots[state.current] = { bars: item.bars, notes: JSON.parse(JSON.stringify(item.notes)), name: item.name, fileKey: item.fileKey || null };
  if (item.lanes) state.slots[state.current].lanes = JSON.parse(JSON.stringify(item.lanes));
  if (item.sound && !notesOnly) state.slots[state.current].sound = { name: item.name, bytes: Array.from(item.sound) };
  if (item.bpm) state.bpm = item.bpm;
  if (item.notes.length) {
    const lowest = Math.min(...item.notes.map((n) => n.note));
    state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  }
  state.page = 0;
  renderAll();
  saveSoon();
  setStatus(`Loaded "${item.name}" into pattern ${state.current + 1}. Undo brings back what was there.`);
  if (item.sound && !notesOnly) {
    loadSound({ name: item.name, bytes: item.sound }).then(() => {
      setStatus(`Loaded "${item.name}" into pattern ${state.current + 1}, and sent its sound to the Bass Station. Undo brings back the notes that were there.`);
    });
  }
}

function renderPatterns() {
  const ready = library.status === "ready";
  $("pattern-search").disabled = !ready;
  const words = patterns.search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = ready ? patterns.items.filter((item) => words.every((word) => item.name.toLowerCase().includes(word))) : [];
  $("patterns-empty").hidden = ready && shown.length > 0;
  $("patterns-empty").textContent = !ready
    ? "Patterns are saved in the library folder too. Choose it under Sound library."
    : patterns.items.length
      ? "No saved patterns match that search."
      : "No saved patterns yet. Save, beside the pattern's name on the Grid tab, saves the one you're on, and Save as asks where.";
  $("pattern-list").replaceChildren(...shown.map((item) => {
    const row = document.createElement("li");
    row.className = "sound-row";
    const text = document.createElement("span");
    text.className = "sound-name";
    text.textContent = item.name;
    const about = document.createElement("small");
    about.textContent = `${plural(item.bars, "bar")}, ${plural(item.notes.length, "note")}${item.bpm ? `, ${item.bpm} BPM` : ""}${item.sound ? ", with sound" : ""}`;
    if (item.soundFrom) about.title = `Sound from ${item.soundFrom}`;
    text.append(about);
    const buttons = [actionButton("Load", item.sound
      ? `Put it into pattern ${state.current + 1} on the Grid tab, and send its sound to the Bass Station`
      : `Put it into pattern ${state.current + 1} on the Grid tab`, () => loadLibraryPattern(item))];
    if (item.sound) buttons.push(actionButton("Notes only", `Put it into pattern ${state.current + 1}, keeping the sound the Bass Station has now`, () => loadLibraryPattern(item, { notesOnly: true })));
    row.append(text, ...buttons,
      actionButton("Rename", "Rename this pattern and its file", async () => {
        const name = SoundFolder.cleanName(window.prompt("Rename this pattern", item.name) || "");
        if (!name || name === item.name) return;
        const fileName = SoundFolder.uniqueName(name, patterns.items.filter((other) => other !== item).map((other) => other.name));
        try {
          const folder = await patternFolder();
          const [file] = (await folder.list()).filter((entry) => entry.name === item.name);
          await folder.write(fileName, file.bytes);
          await folder.remove(item.name);
        } catch (error) {
          setStatus(`Couldn't rename it: ${error.message}`, true);
        }
        await readPatterns();
        renderSounds();
      }),
      actionButton("Delete", "Delete this pattern's file from the library folder", async () => {
        if (!window.confirm(`Delete "${item.name}.json" from the ${PATTERNS} folder?`)) return;
        try {
          await (await patternFolder()).remove(item.name);
        } catch (error) {
          setStatus(`Couldn't delete it: ${error.message}`, true);
        }
        await readPatterns();
        renderSounds();
      }));
    return row;
  }));
}

// The same sound counts once, wherever it was stored on the Bass Station.
const inLibrary = (bytes) => library.items.some((item) => BassSounds.sameSound(item.bytes, bytes));

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
    setStatus("The Bass Station isn't connected. Check the MIDI output at the top.", true);
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

// Remembers the sound the Bass Station has now, so the library marks it, or forgets it.
function markLoaded(bytes) {
  state.loadedSound = bytes ? Array.from(bytes) : null;
  saveSoon();
  renderSounds();
}

// Favourites are kept with each sound's details in the library folder's info file.
const isFavourite = (item) => Boolean(library.info[item.name]?.favourite);

async function toggleFavourite(item) {
  const details = { ...(library.info[item.name] || {}) };
  if (details.favourite) delete details.favourite;
  else details.favourite = true;
  library.info[item.name] = details;
  try {
    await library.saveInfo();
  } catch (error) {
    setStatus(`Couldn't save favourites to the library folder: ${error.message}`, true);
  }
  renderSounds();
}

const isLoaded = (item) => Boolean(state.loadedSound) && BassSounds.sameSound(item.bytes, state.loadedSound);

function toggleSlotFavourite(slot) {
  const favourites = new Set(state.slotFavourites);
  if (favourites.has(slot)) favourites.delete(slot);
  else favourites.add(slot);
  state.slotFavourites = [...favourites].sort((a, b) => a - b);
  saveSoon();
  renderSounds();
}

async function chooseSlot(slot) {
  if (sounds.busy) return;
  state.chosenSlot = slot;
  renderSounds();
  const patch = await selectSlot(slot);
  applyArp();
  markLoaded(patch);
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
    markLoaded(patch);
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
  // Every patch read also goes into the sound library, so each can be loaded on its own.
  setStatus("Adding the patches to the sound library...");
  const added = await addPatchesToLibrary({ name, patches });
  await readBackups();
  renderSounds();
  if (added === null) return;
  const gaps = missing ? ` ${missing} didn't arrive, so they're missing from it.` : "";
  setStatus(`Backed up ${patches.length - missing} patches to ${BACKUPS}/${name}.syx in "${library.folder.name}", and added ${plural(added, "new sound")} to the library. Names are the factory ones, so rename any you've changed.${gaps}`, Boolean(missing));
}

// The editor sends a whole sound as a burst of a few hundred controller messages at once,
// and the Bass Station can miss some, leaving a mix of the old sound and the new one. This
// spaces out anything it sends straight away, keeping the order.
const EDITOR_GAP_MS = 1.5;

function paceEditorMidi(frame) {
  const win = frame.contentWindow;
  if (!win || !win.MIDIOutput || win.MIDIOutput.prototype.paced) return;
  const send = win.MIDIOutput.prototype.send;
  let next = 0;
  win.MIDIOutput.prototype.send = function paced(data, timestamp) {
    if (timestamp) return send.call(this, data, timestamp);
    const now = win.performance.now();
    next = Math.max(next, now);
    const at = next;
    next += EDITOR_GAP_MS;
    return send.call(this, data, at);
  };
  win.MIDIOutput.prototype.paced = true;
}

// Sends a sound by loading it into the editor, as it knows how to set every control on the synth.
async function loadSound(item, { quiet = false } = {}) {
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
  paceEditorMidi(frame);
  const field = frame.contentDocument?.getElementById("patch-file");
  if (!field) {
    setStatus("The editor isn't ready yet. Open the Editor tab once, then try again.", true);
    return;
  }
  const files = new DataTransfer();
  files.items.add(new File([item.bytes], `${item.name}.syx`, { type: "application/octet-stream" }));
  field.files = files.files;
  field.dispatchEvent(new Event("change", { bubbles: true }));
  markLoaded(item.bytes);
  // Knob positions the page remembered belong to the sound before, so they're forgotten,
  // and drawn knob movements don't send them over this one.
  state.values = {};
  if (state.showLane) renderLane();
  // The sound brings its own arpeggiator setting, so a kept one is sent again after it.
  window.setTimeout(() => applyArp(), PATCH_SETTLE_MS * 2);
  if (!quiet) setStatus(`Sent "${item.name}" to the Bass Station through the editor. Save it on the Bass Station to keep it in a patch slot.`);
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

// Adds every patch in one or more .syx files, such as a whole sound pack, leaving out
// patches the library already has.
async function importSounds(files) {
  if (!libraryReady()) return;
  let added = 0;
  let same = 0;
  let empty = 0;
  let renamed = 0;
  try {
    for (const [number, file] of files.entries()) {
      if (files.length > 1) setStatus(`Importing ${number + 1} of ${files.length}: ${file.name}...`);
      const patches = BassSounds.split(new Uint8Array(await file.arrayBuffer()));
      if (!patches.length) empty += 1;
      const base = file.name.replace(/\.syx$/i, "");
      for (const [index, patch] of patches.entries()) {
        const existing = library.items.find((item) => BassSounds.sameSound(item.bytes, patch));
        if (existing) {
          same += 1;
          // A sound imported before patch names were read was named after its file, as
          // "silverPack 12". Importing it again gives it its own name.
          const own = BassSounds.patchName(patch);
          const fileNamed = existing.name === base || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`).test(existing.name);
          if (own && fileNamed && existing.name !== own) {
            await library.rename(existing, own);
            renamed += 1;
          }
          continue;
        }
        // Patches from librarians carry their own names, which are used where there is one.
        const own = BassSounds.patchName(patch);
        await library.add(own || (patches.length === 1 ? base : `${base} ${index + 1}`), patch, { from: `${file.name}, ${today()}` });
        added += 1;
      }
    }
  } catch (error) {
    setStatus(`Couldn't save to the library folder: ${error.message}`, true);
    renderSounds();
    return;
  }
  const cleared = await removeDuplicates();
  renderSounds();
  const from = files.length === 1 ? files[0].name : plural(files.length, "file");
  if (empty === files.length) {
    setStatus(`${files.length === 1 ? from : "Those files"} ${files.length === 1 ? "has" : "have"} no Bass Station patches.`, true);
    return;
  }
  const already = same ? ` ${same === 1 ? "1 was" : `${same} were`} already in the library${renamed ? `, and ${plural(renamed, "was", "were")} given ${renamed === 1 ? "its" : "their"} own ${renamed === 1 ? "name" : "names"}` : ""}.` : "";
  const skipped = empty ? ` ${plural(empty, "file")} had no Bass Station patches.` : "";
  setStatus(`Added ${plural(added, "sound")} from ${from}.${already}${skipped}${cleared ? ` ${clearedMessage(cleared)}` : ""}`);
}

// Adds a backup's patches to the sound library, leaving out any it already has. Returns
// how many were added, or null if the folder couldn't be written.
async function addPatchesToLibrary(backup) {
  let added = 0;
  try {
    for (const patch of backup.patches) {
      if (!patch || inLibrary(patch)) continue;
      const slot = BassSounds.slotOf(patch);
      await library.add(slot < BassSounds.FACTORY.length ? `${slot} ${BassSounds.factoryName(slot)}` : `Patch ${slot}`, patch, { from: `${backup.name}, patch ${slot}` });
      added += 1;
    }
  } catch (error) {
    setStatus(`Couldn't save to the library folder: ${error.message}`, true);
    return null;
  }
  return added;
}

async function addBackupToLibrary(backup) {
  if (!libraryReady()) return;
  const added = await addPatchesToLibrary(backup);
  renderSounds();
  if (added !== null) setStatus(`Added ${added} sounds from the backup to the library. Names are the factory ones, so rename any you've changed.`);
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
  renderPatterns();
  renderPatternSound();
  const favourites = new Set(state.slotFavourites);
  const shownSlots = Array.from({ length: BassSounds.SLOTS }, (_, slot) => slot)
    .filter((slot) => !state.slotFavouritesOnly || favourites.has(slot));
  $("slot-favourites-only").setAttribute("aria-pressed", String(state.slotFavouritesOnly));
  const rows = shownSlots.map((slot) => {
    const item = document.createElement("li");
    item.className = "slot-row";
    const button = actionButton(`${slot}`, "Choose this patch on the Bass Station", () => chooseSlot(slot));
    button.className = "slot-button";
    button.classList.toggle("chosen", slot === state.chosenSlot);
    button.setAttribute("aria-pressed", String(slot === state.chosenSlot));
    const name = document.createElement("span");
    name.textContent = BassSounds.factoryName(slot);
    button.append(name);
    const star = actionButton(favourites.has(slot) ? "\u2605" : "\u2606",
      favourites.has(slot) ? "Remove from favourites" : "Add to favourites", () => toggleSlotFavourite(slot));
    star.className = "favourite";
    star.setAttribute("aria-pressed", String(favourites.has(slot)));
    star.setAttribute("aria-label", `Favourite patch ${slot}`);
    item.append(button, star);
    return item;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "sounds-note";
    empty.textContent = "No favourite patches yet. Click the star beside a patch to add it.";
    rows.push(empty);
  }
  $("slot-list").replaceChildren(...rows);

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
  const shown = ready ? library.items.filter((item) => (!state.favouritesOnly || isFavourite(item))
    && words.every((word) => `${item.name} ${fromOf(item)}`.toLowerCase().includes(word))) : [];
  $("favourites-only").setAttribute("aria-pressed", String(state.favouritesOnly));
  $("favourites-only").disabled = !ready;
  $("library-empty").hidden = !ready || shown.length > 0;
  $("library-empty").textContent = !library.items.length
    ? "No sounds in this folder yet. Save the current sound, import a .syx file, or add a backup's patches."
    : state.favouritesOnly && !library.items.some(isFavourite)
      ? "No favourites yet. Click the star beside a sound to make it one."
      : "No sounds match.";
  $("sound-list").replaceChildren(...shown.map((item) => {
    const row = document.createElement("li");
    const loaded = isLoaded(item);
    const favourite = isFavourite(item);
    const star = actionButton(favourite ? "\u2605" : "\u2606", favourite ? "Remove from favourites" : "Add to favourites", () => toggleFavourite(item));
    star.className = "favourite";
    star.setAttribute("aria-pressed", String(favourite));
    star.setAttribute("aria-label", `${favourite ? "Remove" : "Add"} ${item.name} ${favourite ? "from" : "to"} favourites`);
    row.className = `sound-row selectable${loaded ? " loaded" : ""}`;
    if (loaded) row.setAttribute("aria-current", "true");
    // The name is a button, so clicking anywhere on the row, or pressing Enter on it,
    // sends the sound to the Bass Station.
    const text = document.createElement("button");
    text.type = "button";
    text.className = "sound-name";
    text.textContent = item.name;
    text.title = loaded ? "This sound is on the Bass Station now. Click to send it again." : "Send this sound to the Bass Station";
    const from = document.createElement("small");
    from.textContent = `${loaded ? "On the Bass Station now. " : ""}${fromOf(item) || `Patch ${BassSounds.slotOf(BassSounds.split(item.bytes)[0])}`}`;
    text.append(from);
    row.addEventListener("click", (event) => {
      if (event.target.closest("button") && !event.target.closest(".sound-name")) return;
      loadSound(item);
    });
    row.append(star, text,
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
  $("pattern-save").addEventListener("click", () => savePattern());
  $("pattern-save-as").addEventListener("click", () => savePattern({ asNew: true }));
  $("pattern-open").addEventListener("click", openPattern);
  $("load-pattern").addEventListener("click", showSavedPatterns);
  $("pattern-search").addEventListener("input", (event) => {
    patterns.search = event.target.value;
    renderPatterns();
  });
  $("backup-all").addEventListener("click", backUpAll);
  $("save-current").addEventListener("click", saveCurrentSound);
  $("sound-search").addEventListener("input", (event) => {
    sounds.search = event.target.value;
    renderSounds();
  });
  $("favourites-only").addEventListener("click", () => {
    state.favouritesOnly = !state.favouritesOnly;
    saveSoon();
    renderSounds();
  });
  $("sound-import").addEventListener("click", () => $("sound-import-file").click());
  $("sound-import-file").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    if (files.length) importSounds(files);
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
ticker.onmessage = () => {
  if (state.playing) {
    idleClock.next = null;
    schedule();
  } else {
    sendIdleClock();
  }
};

const msPerPulse = () => 60000 / (currentBpm() * PPQ);
const sendingClock = () => $("clock").checked;

/* ---------- The arpeggiator ---------- */

const ARP_CC = 108;
const ARP_MODES = [["patch", "As the patch"], ["off", "Off"], ["on", "On"]];
// The arpeggiator follows MIDI clock, so unless it's kept off it gets the grid's tempo.
const arpClock = () => state.arp !== "off";

function renderArp() {
  for (const select of document.querySelectorAll(".arp-mode")) {
    if (!select.options.length) select.replaceChildren(...ARP_MODES.map(([value, label]) => new Option(label, value)));
    select.value = state.arp;
  }
}

// Sets the arpeggiator as chosen, as a patch change brings back the patch's own setting.
function applyArp(atTime) {
  if (state.arp === "patch" || !state.output) return;
  const value = state.arp === "on" ? 127 : 0;
  state.values["arp.on"] = value;
  sendController(ARP_CC, value, atTime);
}

function chooseArp(mode) {
  state.arp = mode;
  renderArp();
  saveSoon();
  applyArp();
  idleClock.next = null;
  const messages = {
    patch: "The arpeggiator now follows each patch. It keeps time with the grid's tempo.",
    off: "The arpeggiator is off, and stays off when the patch changes.",
    on: "The arpeggiator is on, in time with the grid's tempo, and stays on when the patch changes.",
  };
  setStatus(state.output ? messages[mode] : `${messages[mode]} No MIDI output is connected yet.`, !state.output);
}

// While stopped, clock is sent at the grid's tempo so the arpeggiator keeps time. It's only
// timing clock, without start or stop, so the Bass Station's own sequencer doesn't start.
const idleClock = { next: null };

function sendIdleClock() {
  if (!arpClock() || !state.output) {
    idleClock.next = null;
    return;
  }
  const now = performance.now();
  const interval = 60000 / (currentBpm() * 24);
  if (idleClock.next === null || idleClock.next < now - interval * 4) idleClock.next = now;
  try {
    while (idleClock.next < now + SCHEDULE_AHEAD_MS) {
      state.output.send([0xF8], idleClock.next);
      idleClock.next += interval;
    }
  } catch {
    idleClock.next = null;
  }
}

function currentBpm() {
  const value = Number($("bpm").value);
  return value >= 20 && value <= 300 ? value : 120;
}

/* A song from Song Grid while it plays one: { bars, loop, cues, pulse, muted }. Each cue
   starts a pattern from its first step, or silence, at a bar, and the song ends or loops
   after its last bar. The part arrives just before Song Grid starts playback. See sync.js. */
let song = null;
let pendingSong = null;

// Called at the start of each chunk. Returns false once the song has ended.
// What a song's cue asks for besides its pattern: a tempo, and a preset by program change.
function setSongBpm(bpm) {
  if (bpm === currentBpm()) return;
  state.bpm = bpm;
  $("bpm").value = bpm;
}

function sendProgram(program, atTime) {
  if (state.output) state.output.send([0xC0 | state.channel, program], atTime);
}

// Notes shift by the song section's transpose, kept in range.
const songNote = (note) => Math.max(0, Math.min(127, note + (song?.transpose || 0)));

function followSong() {
  if (song.pulse % BAR !== 0) return true;
  // Each bar after the first moves the song on, following any move from Song Grid.
  if (song.pulse > 0 && !Sync.songNextBar(song)) {
    stop({ fromLink: true });
    setStatus("The song has ended.");
    return false;
  }
  const bar = song.bar;
  const cue = Sync.songCue(song, bar);
  if (cue) {
    song.off = cue.pattern === null;
    if (!song.off && cue.pattern !== state.current) switchTo(cue.pattern);
    song.transpose = cue.transpose || 0;
    if (cue.bpm) setSongBpm(cue.bpm);
    if (Number.isInteger(cue.program)) sendProgram(cue.program, state.nextTime);
    state.nextPulse = 0;
    setStatus(song.off ? `Song: silent from bar ${bar + 1}.` : `Song: pattern ${cue.pattern + 1} from bar ${bar + 1}.`);
  }
  // Song Grid's mute and solo buttons can silence this grid from any bar.
  song.muted = song.off || Sync.songSilenced(song);
  return true;
}

// Notes played while their key is still held while recording. Each one sounds until
// its key is let go, so playing over it doesn't cut it short, and it's heard even with
// the synth's Local off.
const heldSounding = new Map();

function startHeldNote(item, note, atTime) {
  if (!state.output || heldSounding.has(item)) return;
  recorder.sent(note, atTime);
  const value = Math.max(1, Math.min(127, Math.round(item.velocity * 127)));
  state.output.send([0x90 | state.channel, note, value], atTime);
  heldSounding.set(item, { note, at: atTime });
}

function releaseHeldNotes({ all = false } = {}) {
  for (const [item, held] of heldSounding) {
    if (!all && recorder?.holding(item)) continue;
    if (state.output) state.output.send([0x80 | state.channel, held.note, 0], Math.max(performance.now(), held.at + 1));
    heldSounding.delete(item);
  }
}

function schedule() {
  releaseHeldNotes();
  const horizon = performance.now() + SCHEDULE_AHEAD_MS;
  let ms = msPerPulse();
  while (state.nextTime < horizon) {
    if (song && !followSong()) return;
    ms = msPerPulse(); // A song can change the tempo at a bar.
    const playing = song?.muted ? { notes: [], bars: slot().bars } : slot();
    const from = state.nextPulse;
    const to = from + CHUNK_PULSES;
    if ((sendingClock() || arpClock()) && from % CLOCK_PULSES === 0 && state.output) {
      state.output.send([0xF8], state.nextTime);
    }
    if (from % PPQ === 0 && !state.sendOnce) click.at(state.nextTime, from % (4 * PPQ) === 0);
    if (!song?.muted) scheduleMotions(from, to, ms);
    for (const note of playing.notes) {
      if (note.time >= from && note.time < to && Math.random() * 100 < (note.probability ?? 100)) {
        // A note whose key is still held starts, and ends when the key is let go.
        if (recorder?.holding(note)) {
          startHeldNote(note, songNote(note.note), state.nextTime + (note.time - from) * ms);
          continue;
        }
        for (const part of Music.noteParts(note)) {
          sendNote(songNote(note.note), note.velocity, state.nextTime + (part.time - from) * ms, part.length * ms);
        }
      }
    }
    state.nextTime += CHUNK_PULSES * ms;
    if (song) song.pulse += CHUNK_PULSES;
    state.nextPulse = to >= lengthPulses(playing) ? 0 : to;
    if (state.nextPulse === 0 && !song) {
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
    if (knobHeld(id)) continue;
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

/* ---------- Recording knob turns ---------- */

// Controllers this page sent lately, so the synth echoing one back isn't recorded.
const sentControllers = new Map();
const ECHO_MS = 60;
const HOLD_MS = 400; // A knob turned this recently isn't played from its lane.

function isEcho(cc, value, at) {
  const sent = sentControllers.get(cc);
  return Boolean(sent) && sent.value === value && Math.abs(at - sent.at) < ECHO_MS;
}

// While recording and playing, a knob turned on the synth writes its movement into this
// pattern's lane for it, where in the pattern it was turned. Undo takes back the take.
function recordKnob(key, value, at) {
  // Playback starts just after Play is pressed, so a turn before then isn't in the pattern yet.
  if (!recorder?.on || !state.playing || at < (state.playStartAt ?? 0)) return false;
  const length = lengthPulses();
  const time = Math.max(0, Math.min(length - MOTION_TICKS, Math.floor(pulseAt(at) / MOTION_TICKS) * MOTION_TICKS));
  state.knobTake ??= new Map();
  const last = state.knobTake.get(key);
  const lanes = editableLanes();
  lanes[key] ??= [];
  const points = lanes[key];
  // Knobs send fewer messages when turned slowly, so short gaps are filled in.
  const gap = last ? time - last.time : 0;
  if (last && gap > 0 && gap <= 16 * MOTION_TICKS) {
    const count = gap / MOTION_TICKS;
    for (let index = 1; index <= count; index += 1) {
      setLanePoint(points, last.time + index * MOTION_TICKS, Math.round(last.value + (value - last.value) * (index / count)), false);
    }
  } else {
    setLanePoint(points, time, value, false);
  }
  points.sort((a, b) => a.time - b.time);
  state.knobTake.set(key, { time, value, at });
  if (!last) {
    if (state.showLane) state.laneParam = key;
    setStatus(`Recording ${knobName(key)} into the Knobs lane. Undo takes back the whole take.`);
    renderChrome();
  }
  if (state.showLane) renderLane();
  saveSoon();
  return true;
}

// A knob being turned plays as it's turned, not from its lane.
function knobHeld(key) {
  const last = state.knobTake?.get(key);
  return Boolean(last) && recorder?.on && performance.now() - last.at < HOLD_MS;
}

const knobName = (key) => `${SECTION_OF.get(key).name} ${BassParams.BY_ID.get(key).name}`;

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
// Puts the patterns kept with a song in Song Grid back into their slots, and sends its
// sound. Undo brings back the patterns that were in those slots. See sync.js.
const listOf = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join(""));

function loadSlotAssets(assets) {
  const slots = Sync.assetSlots(assets, SLOTS);
  if (!slots.length) return "";
  closeNoteEditor({ restoreFocus: false });
  remember();
  for (const { index, data } of slots) {
    state.slots[index] = data;
  }
  if (slots.some(({ index }) => index === state.queued)) state.queued = null;
  renderAll();
  saveSoon();
  const numbers = listOf(slots.map(({ index }) => index + 1));
  return `Put ${slots.length === 1 ? `pattern ${numbers}` : `patterns ${numbers}`} in. Undo here brings back what was there.`;
}

// Tells Song Grid what was put in, and shows it here.
function reportLoaded(parts, ok) {
  const message = parts.filter(Boolean).join(" ") || "There was nothing to put in.";
  setStatus(`From Song Grid: ${message}`, !ok);
  return { ok, message };
}

async function loadAssets(assets) {
  const patterns = loadSlotAssets(assets);
  const patch = assets.sound?.data?.patch;
  const valid = Array.isArray(patch) && patch.length === 154 && patch[0] === 0xF0 && patch[patch.length - 1] === 0xF7
    && patch.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xFF);
  let sound = "";
  if (valid) {
    if (!state.output) {
      sound = "There's no MIDI output, so the sound wasn't sent to the Bass Station.";
    } else {
      await loadSound({ name: assets.sound.label || "Song sound", bytes: new Uint8Array(patch) });
      sound = "Sent the sound to the Bass Station through the editor. Save it on the Bass Station to keep it in a patch slot.";
    }
  }
  return reportLoaded([patterns, sound], Boolean(patterns || valid) && (!valid || Boolean(state.output)));
}

/* What this grid can offer Song Grid for a song, to pick from: the patterns in its slots,
   those in its library, and sounds. fetchPicked gives the ones picked, as assets. Library
   patterns come without a pattern number, as Song Grid chooses one. See sync.js. */
const barsText = (bars) => `${bars} bar${bars === 1 ? "" : "s"}`;
const notesText = (count) => `${count} note${count === 1 ? "" : "s"}`;
const filledSlots = () => state.slots.map((item, index) => ({ item, index }))
  .filter(({ item }) => item.notes.length || (item.lanes && Object.keys(item.lanes).length));
const slotAsset = ({ item, index }) => ({
  id: `slot:${index}`, ref: index, label: `Pattern ${index + 1}`, length: barsText(item.bars), notes: item.notes.length, data: JSON.parse(JSON.stringify(item)),
});
const slotChoices = () => filledSlots().map(({ item, index }) => ({ id: `slot:${index}`, label: `Pattern ${index + 1}`, meta: `${barsText(item.bars)}, ${notesText(item.notes.length)}` }));

function pickedSlots(ids) {
  return ids.map((id) => /^slot:(\d+)$/.exec(id)).filter((match) => match && state.slots[Number(match[1])])
    .map((match) => slotAsset({ item: state.slots[Number(match[1])], index: Number(match[1]) }));
}

const savedPatternById = (id) => patterns.items.find((item) => `file:${item.name}` === id);
const soundById = (id) => (library.status === "ready" ? library.items.find((item) => `lib:${item.name}` === id) : null);
const canReadPatch = () => Boolean(state.output && state.input && state.midi?.sysexEnabled && !sounds.busy);

function catalog() {
  const ready = library.status === "ready";
  return {
    grid: slotChoices(),
    patterns: ready ? patterns.items.map((item) => ({ id: `file:${item.name}`, label: item.name, meta: `${barsText(item.bars)}, ${notesText(item.notes.length)}` })) : [],
    sounds: [
      ...(canReadPatch() ? [{ id: "current", label: "The sound the Bass Station is playing", meta: "Read from it" }] : []),
      ...(ready ? library.items.map((item) => ({ id: `lib:${item.name}`, label: item.name, meta: "Sound", favourite: isFavourite(item) })) : []),
    ],
    note: ready ? "" : "Choose the sound library folder in Bass Station Grid to pick from its saved patterns and sounds too.",
  };
}

async function fetchPicked({ patterns: ids = [], sound = null } = {}) {
  const list = Array.isArray(ids) ? ids : [];
  const picked = pickedSlots(list);
  for (const id of list) {
    const item = savedPatternById(id);
    if (!item) continue;
    const data = { bars: item.bars, notes: JSON.parse(JSON.stringify(item.notes)) };
    if (item.lanes) data.lanes = JSON.parse(JSON.stringify(item.lanes));
    picked.push({ id, ref: null, label: item.name, length: barsText(item.bars), notes: item.notes.length, data });
  }
  let kept = null;
  if (sound === "current") kept = (await collectAssets()).sound;
  else if (soundById(sound)) kept = { label: soundById(sound).name, data: { patch: Array.from(soundById(sound).bytes) } };
  return { patterns: picked, sound: kept };
}

// What Song Grid keeps of this grid for a song: its patterns, and its sound where it has
// one. See sync.js.
async function collectAssets() {
  const patterns = state.slots.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.notes.length || (item.lanes && Object.keys(item.lanes).length))
    .map(({ item, index }) => ({
      id: `slot:${index}`, ref: index, label: `Pattern ${index + 1}`,
      length: `${item.bars} bar${item.bars === 1 ? "" : "s"}`, notes: item.notes.length, data: JSON.parse(JSON.stringify(item)),
    }));
  // The sound the Bass Station is playing, edits included, if it can be read.
  const canRead = state.output && state.input && state.midi?.sysexEnabled && !sounds.busy;
  const patch = canRead ? await requestPatch() : null;
  const sound = patch ? { label: `Patch ${BassSounds.slotOf(patch)} as the Bass Station has it`, data: { patch: Array.from(patch) } } : null;
  return { patterns, sound };
}

const link = Sync.connect({
  startOff: true, // Each visit starts with Sync off.
  name: "Bass Station Grid",
  checkbox: $("sync"),
  storageKey: "bass-station-grid-sync",
  start({ bpm, at }) {
    if (state.playing) stop({ fromLink: true });
    state.bpm = bpm;
    $("bpm").value = bpm;
    // Song Grid sends this page its part just before it starts playback.
    song = pendingSong;
    pendingSong = null;
    play({ startAt: at, fromLink: true });
    return state.playing;
  },
  stop: () => stop({ fromLink: true }),
  song: (part) => { pendingSong = part; },
  assets: collectAssets,
  loadAssets,
  answers: { catalog, fetch: fetchPicked },
  songMoved(data) {
    const move = song && Sync.songMove(data, song.bars);
    if (move) song.moves.push(move);
  },
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
  if (!fromLink) song = null;
  if (song) Object.assign(Sync.songStart(song), { pulse: 0, muted: false });
  if (!state.output) {
    setStatus("No MIDI output connected. Connect the Bass Station and turn it on.", true);
    return;
  }
  state.playing = true;
  state.nextPulse = 0;
  const chain = song ? [] : chainList();
  const switching = chain.length > 0 && state.current !== chain[0];
  if (chain.length) {
    state.chainPos = 0;
    if (switching) switchTo(chain[0]);
  }
  if (!switching) sendPatternSound();
  const shared = fromLink ? null : link.announcePlay(currentBpm());
  state.nextTime = startAt ?? shared ?? performance.now() + 60;
  state.playStartAt = state.nextTime;
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
  releaseHeldNotes({ all: true });
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
  const key = state.keyOff ? "no-key" : `${Music.NOTE_NAMES[state.root].replace("#", "sharp")}-${state.scale}`;
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
  // Notes come in as written, with the key off. The likely key is kept for when it's turned on.
  const key = Music.detectKey(kept);
  if (key) Object.assign(state, key);
  state.keyOff = true;
  const lowest = Math.min(...kept.map((n) => n.note));
  state.lowOctave = Math.max(1, Math.min(6, Math.floor(lowest / 12) - 1));
  state.page = 0;
  renderAll();
  saveSoon();
  const cut = end > limit ? ` It's longer than ${bars} bars, so the rest was cut.` : "";
  const count = `${kept.length} ${kept.length === 1 ? "note" : "notes"}`;
  const guess = key ? ` The key is off, so every note shows as written. It sounds like ${currentKeyName()}: click ${Music.NOTE_NAMES[state.root]} under Key to use that.` : "";
  setStatus(`Imported ${count} from ${file.name} into pattern ${state.current + 1}. Undo brings the old one back.${cut}${guess}`);
}

// Shared by all the grids, so switching one switches them all.
const THEME_KEY = "midi-grids-theme";

function setTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  $("theme-toggle").textContent = theme === "light" ? "☾" : "☀";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private windows can refuse storage, so the theme just isn't remembered.
  }
  renderLane();
}

// Follows a switch made on another grid open in this browser.
window.addEventListener("storage", (event) => {
  if (event.key === THEME_KEY && event.newValue) setTheme(event.newValue === "light" ? "light" : "dark");
});

/* ---------- Controls ---------- */

function openHelp() {
  closeNoteEditor({ restoreFocus: false });
  $("help").showModal();
  document.querySelector(".help-body").scrollTop = 0;
}

function fillSelects() {
  $("root").replaceChildren(new Option("Off", "off"), ...Music.NOTE_NAMES.map((name, index) => new Option(name, String(index))));
  $("root").addEventListener("change", (event) => {
    if (event.target.value === "off") setKeyOff(true);
    else setKey(Number(event.target.value), state.scale);
  });
  $("scale").replaceChildren(new Option("Off", "off"), ...Object.entries(Music.SCALES).map(
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
  $("scale").addEventListener("change", (event) => {
    if (event.target.value === "off") setKeyOff(true);
    else setKey(state.root, event.target.value);
  });
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
  $("theme-toggle").textContent = document.documentElement.dataset.theme === "light" ? "☾" : "☀";
  $("octave-down").addEventListener("click", () => shiftOctave(-1));
  $("octave-up").addEventListener("click", () => shiftOctave(1));
  $("generate").addEventListener("click", generatePattern);
  $("undo").addEventListener("click", undo);
  $("redo").addEventListener("click", redo);
  $("duplicate").addEventListener("click", duplicatePattern);
  $("pattern-sound").addEventListener("change", (event) => choosePatternSound(event.target.value));
  for (const select of document.querySelectorAll(".arp-mode")) {
    select.addEventListener("change", (event) => chooseArp(event.target.value));
  }
  renderArp();
  $("slot-favourites-only").addEventListener("click", () => {
    state.slotFavouritesOnly = !state.slotFavouritesOnly;
    saveSoon();
    renderSounds();
  });
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
    // Cmd+S saves the pattern to its file, and Cmd+Shift+S saves it as a new one.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!event.repeat) savePattern({ asNew: event.shiftKey });
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
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (event.key === "t" && !event.metaKey && !event.ctrlKey) {
      setSteps(state.baseResolution, !state.triplets);
    }
  });
}

async function start() {
  restore();
  // Each visit starts with the key and scale off. Choosing a key brings back the last one.
  state.keyOff = true;
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
