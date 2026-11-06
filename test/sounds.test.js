"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const BassSounds = require("../sounds.js");

// A patch the way the Bass Station sends one, for the given slot.
const patch = (slot, fill = 0) => {
  const bytes = new Array(BassSounds.LENGTH).fill(fill);
  bytes.splice(0, 6, 0xF0, 0x00, 0x20, 0x29, 0x00, 0x33);
  bytes[9] = slot;
  bytes[BassSounds.LENGTH - 1] = 0xF7;
  return bytes;
};

test("the factory names follow Novation's sheet", () => {
  assert.equal(BassSounds.FACTORY.length, 70);
  assert.equal(BassSounds.factoryName(0), "Anabass 1");
  assert.equal(BassSounds.factoryName(12), "Octave Lead");
  assert.equal(BassSounds.factoryName(69), "No Arp SID");
  assert.equal(BassSounds.factoryName(70), "Init patch");
});

test("a file of several patches splits into them, skipping anything else", () => {
  const other = [0xF0, 0x41, 0x10, 0x42, 0xF7];
  const bytes = [...patch(3), ...other, ...patch(4, 5), 0x00, 0x12];
  const found = BassSounds.split(new Uint8Array(bytes));
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(BassSounds.slotOf), [3, 4]);
  assert.equal(found[1][20], 5);
});

test("patches survive being stored as text, and damaged text is refused", () => {
  const original = patch(17, 9);
  assert.deepEqual(BassSounds.fromHex(BassSounds.toHex(original)), original);
  assert.throws(() => BassSounds.fromHex("f0002029"), /damaged patch/);
  assert.throws(() => BassSounds.fromHex("zz"), /damaged patch/);
  assert.throws(() => BassSounds.fromHex(42), /damaged patch/);
});

test("the request asks the Bass Station for its current patch", () => {
  assert.deepEqual(BassSounds.REQUEST, [0xF0, 0x00, 0x20, 0x29, 0x00, 0x33, 0x00, 0x40, 0xF7]);
});
