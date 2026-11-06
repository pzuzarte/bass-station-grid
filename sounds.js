"use strict";
/* Bass Station II patches as the synth sends them: one 154-byte SysEx message, which
   starts F0 00 20 29 (Novation) 00 33 and holds the patch number at byte 9. The synth
   sends its current patch when asked with REQUEST. Files can hold several patches
   one after another. The factory names are from Novation's patch sheet. */
const BassSounds = (() => {
  const REQUEST = [0xF0, 0x00, 0x20, 0x29, 0x00, 0x33, 0x00, 0x40, 0xF7];
  const HEADER = [0xF0, 0x00, 0x20, 0x29, 0x00, 0x33];
  const LENGTH = 154;
  const SLOTS = 128;
  const NUMBER_AT = 9;

  const FACTORY = ["Anabass 1", "Pulse Sync", "Owl Bass", "Wobbiness", "Acid Morphing", "Wizard of Oz", "Hellish Run",
    "Vinspired 1", "Catch the Metro", "Dr. Organ", "Straight Ahead", "Simple Lead", "Octave Lead", "Punch Stack",
    "Deep Fuzz", "Daft Oscillator", "Clicky Sub", "Clint is On", "Birdland Bass", "League of Bass", "Perc'd Bass",
    "Teddys", "Berlin", "Acid House", "Fretless", "Overdriven", "Anabass 2", "Filter Press", "AnaSlapped",
    "Basse de Maison", "Pulsar Arp", "Pointy Bass", "Acid Square", "Self Res Saw Bounce", "City Livin'", "Vinspired 2",
    "Stacked Lead", "Harmonic Sweep", "Enola", "Trilogy Lead", "Fast Mod Lead", "Morphering Lead", "Sleepwalk Lead",
    "WeCame2Lead", "I've Gone", "Brassic", "Pink 3rds", "5ths Pad", "Look No Hands", "FM ness", "Vocal Woes",
    "Vocal Yeeeeaaaaahhh", "Delayed", "Distorted Synced Thing", "Lead - WTFM", "Mushroom", "Depeche Toi", "Synth Riser",
    "Ultra Stab", "Rainbow Chord 1", "Heavy Chord 2", "Sliding Chord 3", "Organic Perc", "Glide Organ", "Hi-Hats",
    "Cheap Snare", "Ringing Kick", "Sampled Dialog", "Ring My Bell", "No Arp SID"];

  // A slot's name when the Bass Station left the factory. 70-127 started as init patches.
  const factoryName = (slot) => FACTORY[slot] ?? "Init patch";

  const isPatch = (bytes) => bytes.length >= 10 && HEADER.every((byte, index) => bytes[index] === byte) && bytes.at(-1) === 0xF7;

  // Every patch in a file or a stream of messages, in order.
  function split(bytes) {
    const patches = [];
    let start = -1;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0xF0) start = index;
      else if (bytes[index] === 0xF7 && start >= 0) {
        const message = Array.from(bytes.slice(start, index + 1));
        if (isPatch(message)) patches.push(message);
        start = -1;
      }
    }
    return patches;
  }

  const slotOf = (patch) => patch[NUMBER_AT];

  const toHex = (bytes) => bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  function fromHex(text) {
    if (typeof text !== "string" || !/^([0-9a-f]{2})+$/i.test(text)) throw new Error("It has a damaged patch.");
    const bytes = [];
    for (let index = 0; index < text.length; index += 2) bytes.push(parseInt(text.slice(index, index + 2), 16));
    if (!isPatch(bytes)) throw new Error("It has a damaged patch.");
    return bytes;
  }

  return { FACTORY, LENGTH, REQUEST, SLOTS, factoryName, fromHex, isPatch, slotOf, split, toHex };
})();

if (typeof module !== "undefined") module.exports = BassSounds;
