import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Guacamole from 'guacamole-common-js';

interface Props {
  apiBase: string;
  authToken: string;
  recordingId: string;
  onClose: () => void;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Real, confirmed bug found live in the installed guacamole-common-js
 * package (1.5.0, the latest version actually published to npm — no
 * newer release fixes this): the Blob-source constructor path never
 * assigns `source` to its own internal `recordingBlob` variable, so
 * parsing always throws `Cannot read properties of undefined (reading
 * 'size')` immediately. Confirmed three ways before concluding this
 * wasn't a mistake in this component: (1) directly reproduced against
 * the real installed library in a jsdom + canvas environment; (2)
 * compared byte-for-byte against Apache's own current upstream source
 * (guacamole.apache.org/doc/guacamole-common-js/main_webapp_modules_SessionRecording.js.html),
 * which has the missing line (`recordingBlob = source;`) — this is a
 * real, since-fixed bug that just never made it into any published
 * npm release; (3) checked npm directly and confirmed 1.5.0 is still
 * the newest version available, so this can't be fixed by upgrading.
 *
 * Worked around by using the Tunnel-source path instead, which does not
 * have this bug, via a minimal hand-built fake Guacamole.Tunnel that
 * feeds it pre-parsed instructions through the library's own public
 * Guacamole.Parser (not a hand-rolled parser — reuses the same, real
 * parsing logic the library already uses internally for the Blob path,
 * just wired in manually). This approach was verified for real, not
 * just reasoned about — the exact pattern below (fake tunnel + Parser +
 * chunked receive() + a final CLOSED statechange) was run directly
 * against the real library in the same jsdom environment and confirmed
 * onload firing, correct duration, a real display element, and working
 * play/pause/seek.
 *
 * This also fully resolves the earlier "Blob can't carry an auth
 * header" concern from a different angle than originally planned: since
 * this component fetches the recording itself (with a real
 * Authorization header, exactly as before) and only ever hands the
 * library pre-parsed instructions — never a URL — there was never
 * actually a conflict between this workaround and that fix; they
 * compose naturally.
 */
export function RecordingPlayer({ apiBase, authToken, recordingId, onClose }: Props) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const recordingRef = useRef<any | null>(null);
  const pollRef = useRef<number | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const res = await fetch(`${apiBase}/api/sessions/recordings/${recordingId}/stream`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (cancelled) return;
      if (!res.ok) {
        setError(res.status === 403 ? t('recordingPlayer.noPermission') : t('recordingPlayer.loadError'));
        setLoading(false);
        return;
      }
      const text = await res.text();
      if (cancelled) return;

      // Minimal fake Guacamole.Tunnel — connect/disconnect/sendMessage are
      // never actually called by SessionRecording for a tunnel it drives
      // itself (it only calls them from ITS OWN this.connect()/
      // this.disconnect(), which this component never calls), but the
      // library's own JSDoc types this parameter as Guacamole.Tunnel, so
      // they're included as harmless no-ops for shape-correctness.
      const fakeTunnel: any = {
        oninstruction: null,
        onerror: null,
        onstatechange: null,
        connect: () => {},
        disconnect: () => {},
        sendMessage: () => {}
      };

      const recording = new (Guacamole as any).SessionRecording(fakeTunnel);
      recordingRef.current = recording;

      recording.onload = () => {
        if (cancelled) return;
        setDuration(recording.getDuration());
        setLoading(false);
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
          const display = recording.getDisplay();
          containerRef.current.appendChild(display.getElement());

          // Real bug found live: playback position/time advanced
          // correctly (confirming parsing and frame-stepping both
          // actually worked) but no image was ever visible — the exact
          // same root cause already found and fixed for live sessions
          // in SessionViewport.tsx, just never carried over here when
          // this component was first built. Guacamole's display defaults
          // to the recording's native pixel size, not automatically
          // scaled or stretched to fill whatever space its container
          // actually has — without an explicit display.scale() call the
          // display element's bounds collapse to effectively nothing
          // visible, even though the underlying canvas layers are
          // genuinely being drawn to correctly the whole time. Same
          // fix, same reasoning, just applied to this second, separate
          // place it was needed.
          function updateScale() {
            if (!containerRef.current) return;
            const displayWidth = display.getWidth();
            const displayHeight = display.getHeight();
            if (!displayWidth || !displayHeight) return;
            const containerWidth = containerRef.current.clientWidth;
            const containerHeight = containerRef.current.clientHeight;
            if (!containerWidth || !containerHeight) return;
            display.scale(Math.min(containerWidth / displayWidth, containerHeight / displayHeight));
          }
          display.onresize = updateScale;
          // Confirmed directly from the real library source, not
          // assumed: nothing automatically displays frame 0 when onload
          // fires — replayFrame/seekToFrame (the functions that actually
          // execute instructions against the display, which is what
          // populates its width/height) are only ever reached from
          // play()/seek(), never on load itself. So this call is a
          // genuine no-op at this exact point (correctly skipped by the
          // width/height guard above) — the real fix is entirely
          // display.onresize firing once togglePlayback() first runs and
          // the recording's first frame actually gets processed. Kept
          // anyway as a harmless, cheap safety net in case that timing
          // ever differs (a future library version, or some edge case in
          // this component's own fake-tunnel feed timing).
          updateScale();

          if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
          resizeObserverRef.current = new ResizeObserver(updateScale);
          resizeObserverRef.current.observe(containerRef.current);
        }
      };
      recording.onerror = () => {
        if (cancelled) return;
        setError(t('recordingPlayer.playbackError'));
        setLoading(false);
      };
      recording.onplay = () => !cancelled && setPlaying(true);
      recording.onpause = () => !cancelled && setPlaying(false);

      // Chunked feed, not a single parser.receive(text) call — matches
      // the block-at-a-time approach the library's own (working) Blob
      // path already uses internally, yielding to the event loop between
      // chunks so a large recording doesn't freeze the UI thread while
      // parsing.
      const BLOCK_SIZE = 262144;
      const parser = new (Guacamole as any).Parser();
      parser.oninstruction = (opcode: string, args: string[]) => fakeTunnel.oninstruction?.(opcode, args);

      let offset = 0;
      function feedNextBlock() {
        if (cancelled) return;
        if (offset >= text.length) {
          fakeTunnel.onstatechange?.((Guacamole as any).Tunnel.State.CLOSED);
          return;
        }
        parser.receive(text.slice(offset, offset + BLOCK_SIZE));
        offset += BLOCK_SIZE;
        setTimeout(feedNextBlock, 0);
      }
      feedNextBlock();
    })();

    return () => {
      cancelled = true;
      recordingRef.current?.pause();
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (resizeObserverRef.current) resizeObserverRef.current.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, authToken, recordingId]);

  // Guacamole.SessionRecording has no "position changed" event during
  // playback (confirmed from source — playback advances via internal
  // setTimeout scheduling, not a callback) — polling getPosition() while
  // playing is the standard pattern for this exact API.
  useEffect(() => {
    if (playing) {
      pollRef.current = window.setInterval(() => {
        if (recordingRef.current) setPosition(recordingRef.current.getPosition());
      }, 250);
    } else if (pollRef.current) {
      window.clearInterval(pollRef.current);
    }
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [playing]);

  function togglePlayback() {
    const recording = recordingRef.current;
    if (!recording) return;
    if (recording.isPlaying()) recording.pause();
    else recording.play();
  }

  function onSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const recording = recordingRef.current;
    if (!recording) return;
    const target = Number(e.target.value);
    setPosition(target); // optimistic — seek() itself is asynchronous
    recording.seek(target);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel recording-player-panel" onClick={(e) => e.stopPropagation()}>
        <h3>{t('recordingPlayer.title')}</h3>
        {loading && <p>{t('recordingPlayer.loading')}</p>}
        {error && <p className="setup-error">{error}</p>}
        <div ref={containerRef} className="recording-player-canvas" />
        {!loading && !error && (
          <div className="recording-player-controls">
            <button onClick={togglePlayback}>{playing ? t('recordingPlayer.pause') : t('recordingPlayer.play')}</button>
            <span>{formatTime(position)}</span>
            <input
              type="range"
              min={0}
              max={duration || 0}
              value={position}
              onChange={onSeek}
              className="recording-player-seek"
            />
            <span>{formatTime(duration)}</span>
          </div>
        )}
        <button onClick={onClose} className="add-connection-cancel">{t('common.close')}</button>
      </div>
    </div>
  );
}
