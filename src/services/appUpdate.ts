// Notices when the server is running a newer build than this tab, so a
// long-lived tab doesn't keep running old code after a deploy.

import { useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 5 * 60_000;

/** The commit this bundle was built from: the last segment of "0.0.20.abc1234". */
const BUILD_COMMIT = (process.env.NEXT_PUBLIC_APP_VERSION ?? '').split('.').pop() ?? '';

async function serverCommit(): Promise<string | null> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json())?.version ?? null;
  } catch {
    return null;
  }
}

/** True once the server reports a different build than the one this tab loaded. */
export function useAppUpdate(): boolean {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    // Dev builds have no fixed commit to compare against
    if (process.env.NODE_ENV !== 'production' || !BUILD_COMMIT) return;

    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      const live = await serverCommit();
      if (!stopped && live && live !== 'unknown' && live !== BUILD_COMMIT) setUpdateAvailable(true);
    };

    void check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  return updateAvailable;
}
