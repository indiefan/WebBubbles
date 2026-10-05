// Dev-build helpers: keychain sign-in and the read-only guard.
// Everything here is inert outside `next dev`.

const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * Dev builds talk to a real iMessage account, so they are read-only unless
 * NEXT_PUBLIC_BB_DEV_ALLOW_WRITES=1 is set: no sends, reactions, edits,
 * read receipts or typing indicators leave the machine.
 */
export const DEV_READ_ONLY = IS_DEV && process.env.NEXT_PUBLIC_BB_DEV_ALLOW_WRITES !== '1';

export interface DevSession {
  serverUrl: string;
  password: string;
}

/** Credentials saved by scripts/dev-login.sh, or null when there are none. */
export async function fetchDevSession(): Promise<DevSession | null> {
  if (!IS_DEV) return null;
  try {
    const res = await fetch('/api/dev-session', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.serverUrl && data?.password ? data : null;
  } catch {
    return null;
  }
}

/** Queries are POSTs in the BlueBubbles API; everything else that isn't a GET changes state. */
export function isWriteRequest(method: string, path: string): boolean {
  if (method === 'GET') return false;
  return !(method === 'POST' && path.endsWith('/query'));
}
