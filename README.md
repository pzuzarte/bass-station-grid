# Bass Station Grid

A pattern grid for the Novation Bass Station II, in the browser, with a sound editor on its own tab. It's unofficial and not affiliated with Novation.

- **Editor**: the [Bass Station II Web Editor](https://homestudio.app/bs2-editor/) by François Georgy, which edits every setting and reads the patch the Bass Station is playing. The copy in `editor/` is unchanged, and is free software under the GPL-3.0. See `editor/README.md`.
- **Grid**: a key-locked note grid with 16 patterns, Generate, chains, sub-steps, knob movements for the Bass Station's controllers, and MIDI file import and export. It can play together with S-1 Grid, MPC Grid and Protein Grid when they're open in the same browser.

## Requirements

A current Chrome or Edge on a computer, for Web MIDI.

## Running it

It's a static page with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8778
```

## Tests

```bash
node --test "test/*.test.js"
```
