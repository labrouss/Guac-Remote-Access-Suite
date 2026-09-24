import { useEffect, useState } from 'react';

interface Props {
  sessionId: string;
  apiBase: string;
  authToken: string;
}

export function RecordButtonStrip({ sessionId, apiBase, authToken }: Props) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [shownFirstTimeNotice, setShownFirstTimeNotice] = useState(
    () => localStorage.getItem('guac.recordNoticeShown') === 'true'
  );

  useEffect(() => {
    if (!recording) return;
    const interval = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [recording]);

  async function toggle() {
    const action = recording ? 'stop' : 'start';
    const res = await fetch(`${apiBase}/api/sessions/${sessionId}/record`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action })
    });
    if (!res.ok) return;
    const result = await res.json();
    setRecording(result.recording);
    if (result.recording) {
      setSeconds(0);
      if (!shownFirstTimeNotice) {
        localStorage.setItem('guac.recordNoticeShown', 'true');
        setShownFirstTimeNotice(true);
        // eslint-disable-next-line no-alert
        window.alert('Recording started — this session is being saved for playback.');
      }
    }
  }

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="record-strip">
      <button className={`record-toggle ${recording ? 'is-recording' : ''}`} onClick={toggle}>
        <span className="record-dot" />
        {recording ? `REC ${fmt(seconds)}` : 'Record'}
      </button>
    </div>
  );
}
