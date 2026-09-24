import { useEffect, useState } from 'react';

/**
 * Shows the instance name (set during setup) plus a small "vX.Y.Z" label
 * pulled live from /api/version, so it always matches whatever image is
 * actually running. Drop this into the setup wizard footer and the main
 * app shell.
 *
 * Previously showed only "vunknown" — /api/version's own file read was
 * silently failing every single time due to an off-by-one path bug (see
 * that route's own comment), and instance_name was never exposed by any
 * API at all before now. Requested live: an instance-identifying label
 * matters once someone's managing more than one deployment.
 */
export function VersionBadge() {
  const [version, setVersion] = useState<string | null>(null);
  const [instanceName, setInstanceName] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/version')
      .then((res) => res.json())
      .then((data) => {
        setVersion(data.version);
        setInstanceName(data.instanceName);
      })
      .catch(() => setVersion(null));
  }, []);

  if (!version && !instanceName) return null;

  return (
    <span className="version-badge">
      {instanceName && <span className="instance-name">{instanceName}</span>}
      {version && <span className="version-number">v{version}</span>}
    </span>
  );
}
