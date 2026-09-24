import { describe, it, expect } from 'vitest';
import { SizeInstructionTracker } from './sizeInstructionTracker';

function inst(opcode: string, ...args: string[]): string {
  return [opcode, ...args].map((e) => `${e.length}.${e}`).join(',') + ';';
}

describe('SizeInstructionTracker', () => {
  it('returns null when nothing has been fed yet', () => {
    const tracker = new SizeInstructionTracker();
    expect(tracker.getLastSizeInstruction()).toBeNull();
  });

  it('captures a single, complete size instruction fed in one chunk', () => {
    const tracker = new SizeInstructionTracker();
    const sizeInst = inst('size', '0', '1024', '768');
    tracker.feed(sizeInst);
    expect(tracker.getLastSizeInstruction()).toBe(sizeInst);
  });

  it('ignores non-size instructions entirely', () => {
    const tracker = new SizeInstructionTracker();
    tracker.feed(inst('sync', '12345'));
    tracker.feed(inst('img', '0', '0', '1', '0', '0'));
    expect(tracker.getLastSizeInstruction()).toBeNull();
  });

  it('keeps only the most recent size instruction when several arrive', () => {
    const tracker = new SizeInstructionTracker();
    const first = inst('size', '0', '800', '600');
    const second = inst('size', '0', '1920', '1080');
    tracker.feed(first + inst('sync', '1') + second + inst('sync', '2'));
    expect(tracker.getLastSizeInstruction()).toBe(second);
  });

  // The real-world case this parser exists for: TCP doesn't respect
  // instruction boundaries, so a real 'data' event stream can and does
  // split an instruction anywhere at all.
  it('correctly assembles a size instruction split across many separate feed() calls, at every possible split point', () => {
    const sizeInst = inst('size', '0', '1024', '768');
    for (let splitPoint = 1; splitPoint < sizeInst.length; splitPoint++) {
      const tracker = new SizeInstructionTracker();
      tracker.feed(sizeInst.slice(0, splitPoint));
      // Not yet complete — must not have (incorrectly) produced a result yet
      // for any split point that genuinely leaves the instruction incomplete.
      if (splitPoint < sizeInst.length) {
        expect(tracker.getLastSizeInstruction()).toBeNull();
      }
      tracker.feed(sizeInst.slice(splitPoint));
      expect(tracker.getLastSizeInstruction()).toBe(sizeInst);
    }
  });

  it('does not lose a trailing incomplete instruction when more instructions follow in a later feed() call', () => {
    const tracker = new SizeInstructionTracker();
    const sizeInst = inst('size', '0', '640', '480');
    // Feed everything except the last 3 characters, then the rest,
    // plus a second, later instruction in the same subsequent call.
    tracker.feed(sizeInst.slice(0, -3));
    tracker.feed(sizeInst.slice(-3) + inst('sync', '999'));
    expect(tracker.getLastSizeInstruction()).toBe(sizeInst);
  });

  // The entire reason each element is length-prefixed in the real
  // protocol: content can contain characters that would otherwise be
  // mistaken for structural delimiters. A parser that naively split on
  // every ',' or ';' would corrupt or lose this instruction; a correct
  // one uses the length prefix to skip over the content unconditionally.
  it('correctly handles an instruction whose content contains commas and semicolons', () => {
    const tracker = new SizeInstructionTracker();
    // Puts the tricky content in the width argument, not the layer —
    // realistic, since the layer argument is always a simple integer
    // string in the real protocol, and this class now specifically
    // parses that argument (see the "layer filtering" tests below), so
    // an artificial value there would test something that can't
    // actually happen rather than the embedded-delimiter case this test
    // is really about.
    const trickyArg = 'a,b;c,d;e';
    const sizeInst = inst('size', '0', trickyArg, '768');
    tracker.feed(sizeInst);
    expect(tracker.getLastSizeInstruction()).toBe(sizeInst);
  });

  it('resets cleanly on malformed input rather than looping or throwing', () => {
    const tracker = new SizeInstructionTracker();
    expect(() => tracker.feed('not a real guacamole instruction stream at all')).not.toThrow();
    // A subsequent, genuinely well-formed instruction should still work
    // correctly afterward — one bad chunk shouldn't permanently wedge
    // the tracker for the rest of a long-lived session.
    const sizeInst = inst('size', '0', '1024', '768');
    tracker.feed(sizeInst);
    expect(tracker.getLastSizeInstruction()).toBe(sizeInst);
  });

  // Real bug found live, confirmed against actual recording files on
  // disk: guacd sends "size" instructions for layers other than the
  // main display too — most commonly layer -1, the mouse cursor's own
  // small, independent layer. These must never be tracked as if they
  // described the overall recording's own dimensions.
  describe('layer filtering — only layer 0 (the main display) should ever be tracked', () => {
    it('ignores a size instruction for layer -1 (the cursor layer)', () => {
      const tracker = new SizeInstructionTracker();
      tracker.feed(inst('size', '-1', '32', '32'));
      expect(tracker.getLastSizeInstruction()).toBeNull();
    });

    it('tracks a size instruction for layer 0', () => {
      const tracker = new SizeInstructionTracker();
      const layer0 = inst('size', '0', '1024', '768');
      tracker.feed(layer0);
      expect(tracker.getLastSizeInstruction()).toBe(layer0);
    });

    // The actual, exact real-world failure mode this bug caused: a
    // correct layer-0 size arrives first, then a later cursor-layer
    // update must not be allowed to silently replace it.
    it('does not let a later cursor-layer (-1) size instruction overwrite an already-correct layer 0 one', () => {
      const tracker = new SizeInstructionTracker();
      const layer0 = inst('size', '0', '1024', '768');
      tracker.feed(layer0);
      tracker.feed(inst('size', '-1', '32', '32'));
      expect(tracker.getLastSizeInstruction()).toBe(layer0);
    });

    it('still updates to a genuinely newer layer 0 size instruction (a real resize), even after a cursor-layer one arrived in between', () => {
      const tracker = new SizeInstructionTracker();
      const firstLayer0 = inst('size', '0', '800', '600');
      const secondLayer0 = inst('size', '0', '1920', '1080');
      tracker.feed(firstLayer0);
      tracker.feed(inst('size', '-1', '32', '32'));
      tracker.feed(secondLayer0);
      expect(tracker.getLastSizeInstruction()).toBe(secondLayer0);
    });

    // Reproduces the exact real-world bytes found on disk in the actual
    // reported recordings, not just a synthetic equivalent — two of the
    // four inspected files began with precisely this instruction.
    it('correctly ignores the exact real-world instruction found in actual recording files', () => {
      const tracker = new SizeInstructionTracker();
      tracker.feed('4.size,2.-1,2.32,2.32;');
      expect(tracker.getLastSizeInstruction()).toBeNull();
    });
  });
});
