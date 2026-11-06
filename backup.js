"use strict";
/* All of the page's patterns as one file, as they otherwise only live in this browser. Restoring checks everything first, as the
   file could be anything. */
const Backup = (() => {
  const APP = "bass-station-grid";
  const VERSION = 1;
  const SLOTS = 16;

  function pack(state, now = new Date()) {
    return {
      app: APP,
      version: VERSION,
      saved: now.toISOString(),
      root: state.root,
      scale: state.scale,
      bpm: state.bpm,
      chain: state.chain,
      chainOn: state.chainOn,
      slots: state.slots,
    };
  }

  const finite = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;

  function cleanNote(item) {
    if (!item || !finite(item.time, 0, 1e7) || !finite(item.note, 0, 127) || !finite(item.length, 0.001, 1e7)
      || !finite(item.velocity, 0, 1)) {
      throw new Error("It has a damaged note.");
    }
    const note = {
      time: item.time, note: item.note, velocity: item.velocity, length: item.length, probability: finite(item.probability, 0, 100) ? item.probability : 100,
    };
    if (finite(item.substep, 1, 13)) note.substep = item.substep;
    return note;
  }

  function cleanLanes(lanes, known) {
    const clean = {};
    for (const [id, points] of Object.entries(lanes)) {
      if (!known(id) || !Array.isArray(points)) throw new Error("It has a damaged knob movement.");
      clean[id] = points.map((point) => {
        if (!point || !finite(point.time, 0, 1e7) || !finite(point.value, 0, 127)) throw new Error("It has a damaged knob movement.");
        return { time: point.time, value: point.value };
      });
    }
    return clean;
  }

  // Returns just the known fields, or throws if the file can't be used.
  function unpack(data, { scales, params }) {
    const known = (id) => params.has(id);
    if (!data || data.app !== APP) throw new Error("It isn't a Bass Station Grid backup.");
    if (data.version !== VERSION) throw new Error("It's from a different version of Bass Station Grid.");
    if (!Array.isArray(data.slots) || data.slots.length !== SLOTS) throw new Error("It doesn't have 16 patterns.");
    if (!finite(data.root, 0, 11) || !scales[data.scale] || !finite(data.bpm, 20, 300)) throw new Error("Its key or tempo isn't valid.");
    const slots = data.slots.map((item) => {
      if (!item || !finite(item.bars, 0.01, 64) || !Array.isArray(item.notes)) throw new Error("It has a damaged pattern.");
      const slot = { bars: item.bars, notes: item.notes.map(cleanNote) };
      if (item.lanes) slot.lanes = cleanLanes(item.lanes, known);
      return slot;
    });
    return {
      root: data.root,
      scale: data.scale,
      bpm: data.bpm,
      chain: typeof data.chain === "string" ? data.chain : "",
      chainOn: data.chainOn === true,
      slots,
    };
  }

  return { pack, unpack };
})();

if (typeof module !== "undefined") module.exports = Backup;
