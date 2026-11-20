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

// A whole patch as librarians save it: header, slot at byte 8, sound, then a 16-byte name.
function namedPatch(slot, name, fill = 3) {
  const patch = [0xF0, 0x00, 0x20, 0x29, 0x00, 0x33, 0x00, 0x00, slot, 0x00, ...Array(127).fill(fill)];
  const padded = name.padEnd(16, " ").slice(0, 16);
  return [...patch, ...Array.from(padded, (char) => char.charCodeAt(0)), 0xF7];
}

test("a patch's own name is read from its last 16 bytes", () => {
  assert.equal(namedPatch(0, "Anabass 1").length, BassSounds.LENGTH);
  assert.equal(BassSounds.patchName(namedPatch(0, "Anabass 1")), "Anabass 1");
  assert.equal(BassSounds.patchName(namedPatch(5, "Woodpecker KP")), "Woodpecker KP");
  const unnamed = namedPatch(0, "");
  unnamed.splice(BassSounds.LENGTH - 17, 16, ...Array(16).fill(0));
  assert.equal(BassSounds.patchName(unnamed), "", "bytes that aren't text give no name");
});

test("the same sound stored in two slots counts as one", () => {
  assert.ok(BassSounds.sameSound(namedPatch(70, "INIT PATCH"), namedPatch(71, "INIT PATCH")));
  assert.ok(!BassSounds.sameSound(namedPatch(70, "INIT PATCH"), namedPatch(70, "INIT PATCH", 4)));
  assert.ok(!BassSounds.sameSound(namedPatch(0, "Bass"), namedPatch(0, "Lead")));
});
