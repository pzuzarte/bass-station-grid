"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const Backup = require("../backup.js");
const Music = require("../music.js");
const BassParams = require("../params.js");

const options = { scales: Music.SCALES, params: BassParams.BY_ID };

const fullState = () => ({
  root: 2,
  scale: "minor",
  bpm: 98,
  chain: "1 2",
  chainOn: true,
  slots: Array.from({ length: 16 }, (_, index) => ({
    bars: 1,
    notes: index ? [] : [{ time: 0, note: 36, velocity: 1, length: 240, probability: 100 }],
    ...(index ? {} : { lanes: { "filter.frequency": [{ time: 0, value: 10 }] } }),
  })),
});

test("every setting has a unique id and name, and either a controller or an NRPN", () => {
  const ids = BassParams.ALL.map((param) => param.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const param of BassParams.ALL) {
    assert.ok(param.name && param.help, param.id);
    assert.ok((param.cc !== undefined) !== (param.nrpn !== undefined), param.id);
  }
  const ccs = BassParams.ALL.filter((param) => param.cc !== undefined).map((param) => param.cc);
  assert.equal(new Set(ccs).size, ccs.length, "no two settings share a controller");
});

test("controllers match Novation's published list", () => {
  const cc = (id) => BassParams.BY_ID.get(id).cc;
  assert.equal(cc("filter.frequency"), 16);
  assert.equal(cc("filter.resonance"), 82);
  assert.equal(cc("ampEnv.attack"), 90);
  assert.equal(cc("modEnv.release"), 105);
  assert.equal(cc("glide"), 5);
  assert.equal(BassParams.BY_CC.get(110).id, "osc.sync");
  assert.deepEqual(BassParams.BY_ID.get("osc1.range").options.map((option) => option.value), [63, 64, 65, 66]);
});

test("only settings with a controller of their own can be drawn as knob movements", () => {
  const drawable = BassParams.ALL.filter((param) => BassParams.isSlider(param));
  assert.ok(drawable.length > 30);
  assert.ok(drawable.every((param) => param.cc !== undefined));
});

test("a backup restores every pattern and its knob movements", () => {
  const back = Backup.unpack(JSON.parse(JSON.stringify(Backup.pack(fullState(), new Date(0)))), options);
  assert.deepEqual(back.slots[0], fullState().slots[0]);
  assert.equal(back.chain, "1 2");
});

test("a damaged or unrelated backup is refused", () => {
  const damaged = (change) => {
    const file = JSON.parse(JSON.stringify(Backup.pack(fullState())));
    change(file);
    return file;
  };
  assert.throws(() => Backup.unpack({ app: "protein-grid" }, options), /isn't a Bass Station Grid backup/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.version = 2; }), options), /different version/);
  assert.throws(() => Backup.unpack(damaged((f) => { f.slots[0].lanes = { nonsense: [] }; }), options), /knob movement/);
});
