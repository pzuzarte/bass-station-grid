"use strict";
/* The Bass Station II's sound settings and the MIDI controllers it uses for them, from
   Novation's published list (via midi.guide). The grid draws movements for the ones with
   a controller of their own. A few have no controller and use NRPN, and settings that
   take 0-255 also have a fine controller, which isn't needed here. */
const BassParams = (() => {
  const level = (id, name, cc, help) => ({ id, name, cc, help, type: "level" });
  const bipolar = (id, name, cc, help) => ({ id, name, cc, help, type: "bipolar" });
  const select = (id, name, address, options, help) => ({ id, name, ...address, help, type: "select", options });
  const list = (...labels) => labels.map((label, index) => ({ label, value: index }));
  const offOn = list("Off", "On");

  const osc = (n, { wave, range, coarse, fine, pw, lfo1, env, envPw, lfo2Pw }) => ({
    id: `osc${n}`,
    name: `Osc ${n}`,
    params: [
      select(`osc${n}.wave`, "Waveform", { nrpn: wave }, list("Sine", "Triangle", "Sawtooth", "Pulse"), "The oscillator's waveform."),
      select(`osc${n}.range`, "Range", { cc: range }, [16, 8, 4, 2].map((feet, index) => ({ label: `${feet}'`, value: 63 + index })), "Its octave, in feet: 16' is lowest."),
      bipolar(`osc${n}.coarse`, "Coarse", coarse, "Tuning in semitones."),
      bipolar(`osc${n}.fine`, "Fine", fine, "Fine tuning."),
      level(`osc${n}.pw`, "Pulse width", pw, "Pulse width, for the pulse wave. The middle is a square wave."),
      bipolar(`osc${n}.lfo1`, "LFO 1 pitch", lfo1, "How much LFO 1 moves its pitch, for vibrato."),
      bipolar(`osc${n}.env`, "Mod env pitch", env, "How much the mod envelope moves its pitch."),
      bipolar(`osc${n}.envPw`, "Mod env PW", envPw, "How much the mod envelope moves its pulse width."),
      bipolar(`osc${n}.lfo2Pw`, "LFO 2 PW", lfo2Pw, "How much LFO 2 moves its pulse width."),
    ],
  });

  const SECTIONS = [
    osc(1, { wave: 72, range: 70, coarse: 27, fine: 26, pw: 74, lfo1: 28, env: 71, envPw: 72, lfo2Pw: 73 }),
    {
      ...osc(2, { wave: 82, range: 75, coarse: 30, fine: 29, pw: 79, lfo1: 31, env: 76, envPw: 77, lfo2Pw: 78 }),
    },
    {
      id: "sub",
      name: "Sub osc and sync",
      params: [
        select("sub.wave", "Sub wave", { cc: 80 }, list("Sine", "Pulse", "Square"), "The sub oscillator's waveform."),
        select("sub.octave", "Sub octave", { cc: 81 }, [{ label: "-2", value: 62 }, { label: "-1", value: 63 }], "How many octaves below Osc 1 it plays."),
        select("osc.sync", "Osc sync", { cc: 110 }, offOn, "Syncs Osc 2 to Osc 1."),
        select("paraphonic", "Paraphonic", { nrpn: 107 }, offOn, "Plays two notes at once, one on each oscillator."),
      ],
    },
    {
      id: "mixer",
      name: "Mixer",
      params: [
        level("mix.osc1", "Osc 1", 20, "Osc 1's level."),
        level("mix.osc2", "Osc 2", 21, "Osc 2's level."),
        level("mix.sub", "Sub osc", 22, "The sub oscillator's level."),
        level("mix.noise", "Noise", 23, "The noise level."),
        level("mix.ring", "Ring mod", 24, "The ring modulator's level."),
        level("mix.external", "External", 25, "The external input's level."),
      ],
    },
    {
      id: "filter",
      name: "Filter",
      params: [
        level("filter.frequency", "Frequency", 16, "Brightness: the filter's cutoff."),
        level("filter.resonance", "Resonance", 82, "Emphasis at the cutoff."),
        bipolar("filter.env", "Mod env depth", 85, "How far the mod envelope opens or closes the filter."),
        bipolar("filter.lfo2", "LFO 2 depth", 17, "How much LFO 2 moves the filter."),
        level("filter.overdrive", "Overdrive", 114, "Drive into the filter."),
        select("filter.type", "Type", { cc: 83 }, list("Classic", "Acid"), "Classic is the multimode filter, Acid the 4-pole diode one."),
        select("filter.shape", "Shape", { cc: 84 }, list("Low-pass", "Band-pass", "High-pass"), "Which frequencies the classic filter lets through."),
        select("filter.slope", "Slope", { cc: 106 }, list("12 dB", "24 dB"), "How steeply the classic filter cuts."),
      ],
    },
    {
      id: "ampEnv",
      name: "Amp envelope",
      params: [
        level("ampEnv.attack", "Attack", 90, "How quickly notes reach full volume."),
        level("ampEnv.decay", "Decay", 91, "How quickly they fall to the sustain level."),
        level("ampEnv.sustain", "Sustain", 92, "The level held while a key is down."),
        level("ampEnv.release", "Release", 93, "How long notes take to fade after release."),
        level("ampEnv.velocity", "Velocity", 112, "How much playing harder raises the volume."),
        select("ampEnv.mode", "Triggering", { nrpn: 73 }, list("Multi", "Single", "Autoglide"), "Multi restarts the envelope on every note, Single only after a gap, and Autoglide also glides."),
      ],
    },
    {
      id: "modEnv",
      name: "Mod envelope",
      params: [
        level("modEnv.attack", "Attack", 102, "The mod envelope's attack."),
        level("modEnv.decay", "Decay", 103, "The mod envelope's decay."),
        level("modEnv.sustain", "Sustain", 104, "The mod envelope's sustain."),
        level("modEnv.release", "Release", 105, "The mod envelope's release."),
        level("modEnv.velocity", "Velocity", 113, "How much playing harder deepens the mod envelope."),
        select("modEnv.mode", "Triggering", { nrpn: 105 }, list("Multi", "Single", "Autoglide"), "When the mod envelope restarts."),
      ],
    },
    ...[1, 2].map((n) => ({
      id: `lfo${n}`,
      name: `LFO ${n}`,
      params: [
        level(`lfo${n}.speed`, "Speed", n === 1 ? 18 : 19, "How fast it moves."),
        level(`lfo${n}.delay`, "Delay", n === 1 ? 86 : 87, "How long after a note it fades in."),
        select(`lfo${n}.wave`, "Waveform", { cc: n === 1 ? 88 : 89 }, list("Triangle", "Sawtooth", "Square", "Sample and hold"), "Its shape."),
      ],
    })),
    {
      id: "fx",
      name: "Effects and master",
      params: [
        level("fx.distortion", "Distortion", 94, "Distortion after the filter."),
        level("fx.oscFilterMod", "Osc filter mod", 115, "How much Osc 2 modulates the filter."),
        level("fx.limit", "Limit", 95, "Keeps the output level in check."),
        level("glide", "Portamento", 5, "How long notes slide into each other. 0 is off."),
        bipolar("bend", "Bend range", 107, "How far pitch bend goes, up to an octave either way."),
        level("volume", "Patch volume", 7, "The sound's volume."),
      ],
    },
    {
      id: "arp",
      name: "Arpeggiator",
      params: [
        select("arp.on", "Arpeggiator", { cc: 108 }, offOn, "Turns the arpeggiator on."),
        select("arp.latch", "Latch", { cc: 109 }, offOn, "Keeps arpeggiating after you let go."),
        select("arp.mode", "Mode", { cc: 118 }, list("Up", "Down", "Up and down", "Up and down 2", "As played", "Random", "Play", "Record"), "The order it plays notes in."),
        select("arp.octaves", "Octaves", { cc: 111 }, list("1", "2", "3", "4"), "How many octaves it covers."),
        select("arp.rhythm", "Rhythm", { cc: 119 }, Array.from({ length: 32 }, (_, index) => ({ label: String(index + 1), value: index })), "One of its 32 rhythms."),
        level("arp.swing", "Swing", 116, "Swing, from 0 to 100. 50 is straight."),
      ],
    },
  ];

  const ALL = SECTIONS.flatMap((section) => section.params);
  const BY_ID = new Map(ALL.map((param) => [param.id, param]));
  const BY_CC = new Map(ALL.filter((param) => param.cc !== undefined).map((param) => [param.cc, param]));
  const isSlider = (param) => param.type === "level" || param.type === "bipolar";

  return { ALL, BY_CC, BY_ID, SECTIONS, isSlider };
})();

if (typeof module !== "undefined") module.exports = BassParams;
