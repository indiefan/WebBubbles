// Log buffer — intercepts console.log/warn/error and keeps the last 5 minutes.
// Usage: import '@/services/logBuffer' early in the app to start capturing.

export interface LogEntry {
  timestamp: number;
  level: 'log' | 'warn' | 'error' | 'info' | 'debug';
  message: string;
  args: string[];
}

const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 2000;

class LogBuffer {
  private entries: LogEntry[] = [];
  private installed = false;

  install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;

    const levels = ['log', 'warn', 'error', 'info', 'debug'] as const;
    for (const level of levels) {
      const original = console[level].bind(console);
      console[level] = (...args: any[]) => {
        this.push(level, args);
        original(...args);
      };
    }

    // Capture unhandled errors
    window.addEventListener('error', (event) => {
      this.push('error', [`Uncaught: ${event.message} at ${event.filename}:${event.lineno}`]);
    });

    window.addEventListener('unhandledrejection', (event) => {
      this.push('error', [`Unhandled rejection: ${event.reason}`]);
    });
  }

  private push(level: LogEntry['level'], args: any[]) {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message: args.map((a) => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' '),
      args: [],
    };
    this.entries.push(entry);

    // Prune old entries
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  /** Get all entries from the last `ms` milliseconds */
  getRecent(ms = MAX_AGE_MS): LogEntry[] {
    const cutoff = Date.now() - ms;
    return this.entries.filter((e) => e.timestamp >= cutoff);
  }

  /** Format entries as a string log file */
  formatRecent(ms = MAX_AGE_MS): string {
    return this.getRecent(ms)
      .map((e) => {
        const time = new Date(e.timestamp).toISOString();
        return `[${time}] [${e.level.toUpperCase()}] ${e.message}`;
      })
      .join('\n');
  }

  clear() {
    this.entries = [];
  }
}

export const logBuffer = new LogBuffer();
