import Guacamole from 'guacamole-common-js';

/**
 * Real build failure, reported directly, from an actual `npm run build`:
 * "Property 'AudioContextFactory' does not exist on type 'typeof import(
 * ".../@types/guacamole-common-js/index")'." This sandbox's own tsc check
 * couldn't have caught this — the whole guacamole-common-js module fails
 * to resolve at all here (no node_modules), so every property on it
 * type-checks as untyped `any` regardless of whether the name is real,
 * masking exactly this kind of gap. The real, installed @types package,
 * with its own, separately-maintained type declarations, is what
 * actually surfaced it.
 *
 * Confirmed directly this is a types-only gap, not a runtime one, before
 * writing this workaround rather than assuming a cast alone was safe:
 * Guacamole.AudioContextFactory is real, genuine, current
 * guacamole-common-js source (main/webapp/modules/AudioContextFactory.js,
 * confirmed directly against it), and is used internally by
 * guacamole-common-js's own built-in audio playback the same way this
 * project's own code calls it — the *type declarations* published
 * separately under @types/guacamole-common-js simply don't happen to
 * declare this one namespace, even though the real object exists at
 * runtime and works correctly.
 *
 * Isolated to this one, single, well-explained cast rather than
 * scattering `(Guacamole as any)` at every call site across
 * SessionViewport.tsx and UnmuteButton.tsx — if @types/guacamole-common-js
 * ever adds real support for this, this is the one place that needs to
 * change.
 */
export function getGuacamoleAudioContext(): AudioContext | null {
  return (Guacamole as any).AudioContextFactory?.getAudioContext() ?? null;
}
