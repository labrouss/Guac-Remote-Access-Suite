import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getGuacamoleAudioContext } from '../lib/guacamoleAudio';

// Requested directly, alongside the "no sound in any connection" report —
// see SessionViewport.tsx's own comments on audioResumedRef and the
// mousedown/touch handler for the full explanation and what's already
// confirmed there directly against the official Guacamole manual and
// guacamole-common-js's own source: audio is on by default, and the real,
// well-documented cause of silence is the browser's own autoplay policy
// leaving the page-wide Web Audio API AudioContext "suspended" until a
// real user gesture resumes it. SessionViewport's own mouse/touch handler
// already does this resume automatically on the very first click or tap
// within the session — this button exists as a visible, explicit,
// always-available fallback alongside that, for anyone who wants direct
// confirmation or control over it rather than relying on an invisible,
// automatic first-click behavior alone, and for the rarer case where
// something about the page's own load order meant that first, automatic
// resume attempt genuinely didn't land.
//
// Guacamole.AudioContextFactory.getAudioContext() maintains one single,
// real, page-wide singleton AudioContext — confirmed directly against
// guacamole-common-js's own JSDoc — the same one guacamole-common-js's
// own built-in audio playback already uses internally. Calling resume()
// on it here operates on that exact same, real, shared object; there's
// no separate "app-level" audio state to keep in sync with it.
export function UnmuteButton() {
  const { t } = useTranslation();
  const [suspended, setSuspended] = useState(true);

  useEffect(() => {
    // No Web Audio API support at all in this browser (very rare in any
    // modern browser, but confirmed as a real, possible case directly
    // from guacamole-common-js's own source — getAudioContext() itself
    // returns null in that situation) — nothing this button could ever
    // do, so it renders nothing at all further down rather than a
    // control that can never actually work.
    const context = getGuacamoleAudioContext();
    if (!context) return;
    setSuspended(context.state === 'suspended');
    const onStateChange = () => setSuspended(context.state === 'suspended');
    context.addEventListener('statechange', onStateChange);
    return () => context.removeEventListener('statechange', onStateChange);
  }, []);

  function unmute() {
    getGuacamoleAudioContext()?.resume();
  }

  if (!getGuacamoleAudioContext()) return null;

  return (
    <button
      className={`unmute-button${suspended ? ' unmute-button-muted' : ''}`}
      onClick={unmute}
      title={t('session.unmute')}
    >
      {suspended ? '🔇' : '🔊'} {t('session.unmute')}
    </button>
  );
}
