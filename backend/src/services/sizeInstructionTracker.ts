/**
 * Real bug found live: a recording started mid-session via the manual
 * record toggle (the common path — force_record is opt-in per
 * connection, so most recordings start this way) never contains a
 * "size" instruction at all. guacd only sends one at connection open
 * and on actual resize events, not on every frame — and the recorder
 * only starts writing from the moment it's told to, with no way to
 * retroactively capture what was already sent before that. Playback
 * then has nothing to size the display from at all: the display element
 * never gets real dimensions, so scale() (see RecordingPlayer.tsx's own
 * fix for a *different* bug in this same area) never has anything
 * meaningful to compute against — the video area shows nothing, even
 * though frames are otherwise decoding and advancing correctly.
 *
 * This class solves that by tracking the most recently seen "size"
 * instruction *for the main, default visible layer (layer 0)* on the
 * raw guacd -> browser stream, independent of whether recording is
 * currently active at all — every open session feeds its stream through
 * one of these regardless, so a "size" instruction sent once at
 * connection open (long before the user ever toggles recording on) is
 * still available whenever recording actually starts.
 * SessionRecorder.start() writes this cached instruction as the new
 * recording's very first entry.
 *
 * The "layer 0 only" part is itself a fix for a second, real bug found
 * live after the first: guacd sends "size" instructions for more than
 * just the main display, most commonly also one for layer -1 (the mouse
 * cursor's own small, independent layer, typically 32×32) — confirmed
 * directly against real recording files on disk, several of which start
 * with a layer -1 size instead of the actual display's own. Tracking
 * "whichever size instruction arrived most recently" with no regard for
 * which layer it belonged to meant a later cursor-layer update could
 * silently overwrite an already-correct main-display one, seeding a
 * recording with the cursor's own tiny dimensions instead — so the main
 * display never actually received a size at all during playback and
 * stayed invisible the entire time despite this class having genuinely
 * captured *a* size instruction, just the wrong one.
 *
 * A real, stateful parser, not a naive per-chunk regex — TCP doesn't
 * respect instruction boundaries, so a "size" instruction can arrive
 * split across two separate 'data' events. Implements just enough of
 * the actual Guacamole protocol (length-prefixed elements,
 * comma-separated, semicolon-terminated) to correctly find instruction
 * boundaries despite that, and to read the layer argument specifically,
 * without needing a full instruction interpreter.
 */
export class SizeInstructionTracker {
  private buffer = '';
  private lastSizeInstruction: string | null = null;

  feed(chunk: string) {
    this.buffer += chunk;

    // Repeatedly try to extract one complete instruction from the front
    // of the buffer. An instruction is a sequence of length-prefixed
    // elements ("<digits>.<that many characters>"), comma-separated,
    // ending in ';' — the length prefix is exactly what makes it safe to
    // skip over embedded commas/semicolons within an element's own
    // content without mistaking them for structural characters.
    for (;;) {
      const instruction = this.tryExtractOneInstruction();
      if (instruction === null) break; // buffer doesn't yet contain a complete instruction — wait for more data
      this.recordIfSizeInstruction(instruction);
    }
  }

  /**
   * Returns the full text of one complete instruction (including its
   * trailing ';'), removing it from the front of the buffer — or null
   * if the buffer doesn't yet contain a complete instruction (leaving
   * the buffer untouched, so a future feed() can complete it).
   */
  private tryExtractOneInstruction(): string | null {
    let pos = 0;
    while (pos < this.buffer.length) {
      const dot = this.buffer.indexOf('.', pos);
      if (dot === -1) {
        // No length-prefix terminator found yet. A real instruction's
        // length prefix is at most a handful of digits (even a
        // gigabyte-sized element's length fits in ~10) — if the buffer
        // has grown well past any plausible prefix length without one
        // appearing, this was never a valid instruction stream to begin
        // with, not merely an incomplete one still waiting on more data.
        if (this.buffer.length - pos > 20) this.buffer = '';
        return null;
      }

      const lengthStr = this.buffer.slice(pos, dot);
      const length = Number(lengthStr);
      if (!Number.isInteger(length) || length < 0) {
        // Malformed — not a real Guacamole instruction stream at all.
        // Drop everything buffered so far rather than looping forever
        // on data this parser can't make sense of; a real, valid
        // instruction stream should never actually reach this branch.
        this.buffer = '';
        return null;
      }

      const contentStart = dot + 1;
      const contentEnd = contentStart + length;
      if (contentEnd >= this.buffer.length) return null; // element content not fully arrived yet (need at least one more byte for the following ',' or ';')

      const separator = this.buffer[contentEnd];
      if (separator === ',') {
        pos = contentEnd + 1; // more elements follow — continue scanning this same instruction
        continue;
      }
      if (separator === ';') {
        const fullInstruction = this.buffer.slice(0, contentEnd + 1);
        this.buffer = this.buffer.slice(contentEnd + 1);
        return fullInstruction;
      }
      // Any other separator means this isn't a real Guacamole stream —
      // same defensive reset as the malformed-length case above.
      this.buffer = '';
      return null;
    }
    return null;
  }

  private recordIfSizeInstruction(instruction: string) {
    // Only the very first element (the opcode) needs checking — its own
    // length prefix says exactly where it ends, so this reads it
    // directly rather than re-parsing the whole instruction.
    const dot = instruction.indexOf('.');
    const opcodeLength = Number(instruction.slice(0, dot));
    const opcode = instruction.slice(dot + 1, dot + 1 + opcodeLength);
    if (opcode !== 'size') return;

    // Real bug found live, confirmed directly against actual recording
    // files: guacd sends "size" instructions for more than just the
    // main, default visible layer (layer 0) — most commonly also for
    // layer -1, the mouse cursor's own small, independent layer
    // (typically 32×32). Naively tracking "whichever size instruction
    // arrived most recently" regardless of layer meant a later
    // cursor-layer size could silently overwrite an earlier, correct
    // main-display one — seeding a recording with the cursor's own tiny
    // dimensions instead of the real display's, which meant the main
    // display (layer 0) never actually received a size at all during
    // playback and stayed at 0×0 the entire time, exactly as reported.
    // The instruction's own args are (layer, width, height) — parse
    // just the layer argument, the same length-prefix scanning the main
    // extractor already uses, and only track this instruction when it's
    // genuinely for layer 0.
    const afterOpcode = instruction.slice(dot + 1 + opcodeLength);
    if (afterOpcode[0] !== ',') return; // malformed — no args at all, not a real size instruction
    const layerDot = afterOpcode.indexOf('.', 1);
    if (layerDot === -1) return;
    const layerLength = Number(afterOpcode.slice(1, layerDot));
    if (!Number.isInteger(layerLength) || layerLength < 0) return;
    const layer = afterOpcode.slice(layerDot + 1, layerDot + 1 + layerLength);

    if (layer === '0') this.lastSizeInstruction = instruction;
  }

  getLastSizeInstruction(): string | null {
    return this.lastSizeInstruction;
  }
}
