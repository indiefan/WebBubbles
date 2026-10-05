"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSyncStore } from "@/stores/syncStore";
import { deriveHealth, HealthLevel, ServerActionKind, useServerStatusStore } from "@/stores/serverStatusStore";
import { describeError, markAlertsRead, refreshServerStatus, runServerAction } from "@/services/serverStatus";
import { http } from "@/services/http";

function ago(ts: number | null) {
  if (!ts) return null;
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return null;
  }
}

function StatusDot({ level }: { level: HealthLevel | "off" }) {
  return <span className={`status-dot status-dot-${level}`} />;
}

interface Fix {
  kind: ServerActionKind;
  label: string;
  explanation: string;
  /** Asked before running, for the disruptive ones. */
  confirm?: string;
}

const FIXES: Fix[] = [
  {
    kind: "restart-messages",
    label: "Restart Messages",
    explanation: "For messages that won’t send, or a disconnected helper.",
  },
  {
    kind: "restart-services",
    label: "Restart server",
    explanation: "For new messages that stop arriving. Reconnects to the message database.",
  },
  {
    kind: "relaunch",
    label: "Relaunch server app",
    explanation: "Last resort: quits and reopens BlueBubbles on the Mac.",
    confirm:
      "Quit and reopen BlueBubbles on the Mac? It normally takes under a minute. If it doesn’t come back, it will need restarting on the Mac itself.",
  },
];

export function ServerPanel({ onClose }: { onClose: () => void }) {
  const socketState = useConnectionStore((s) => s.socketState);
  const lastSync = useSyncStore((s) => s.lastIncrementalSync);
  const { info, unreachable, checkedAt, alerts, update, action } = useServerStatusStore();
  const health = deriveHealth({ socketState, info, unreachable, action });
  const running = action?.phase === "running";
  const readOnly = http.readOnly;
  const [expanded, setExpanded] = useState<number | null>(null);
  const [alertError, setAlertError] = useState<string | null>(null);

  // Opening the panel is when fresh numbers matter
  useEffect(() => {
    void refreshServerStatus({ forceUpdateCheck: !update || Date.now() - update.checkedAt > 3600_000 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (fix: Fix) => {
    if (fix.confirm && !confirm(fix.confirm)) return;
    void runServerAction(fix.kind);
  };

  const installUpdate = () => {
    if (!confirm(`Update the server to ${update?.version ?? "the latest version"}? It restarts itself when the update is installed.`)) return;
    void runServerAction("install-update");
  };

  const unread = alerts.filter((a) => !a.isRead);
  const markAllRead = async () => {
    setAlertError(null);
    try {
      await markAlertsRead(unread.map((a) => a.id));
    } catch (err) {
      setAlertError(describeError(err));
    }
  };

  const connectionText =
    socketState === "connected" ? "Connected" : socketState === "connecting" ? "Reconnecting…" : "Disconnected";
  const helperLevel: HealthLevel | "off" = !info ? "off" : !info.privateApiEnabled ? "off" : info.helperConnected ? "ok" : "degraded";
  const helperText = !info
    ? "Unknown"
    : !info.privateApiEnabled
      ? "Private API is off"
      : info.helperConnected
        ? "Connected"
        : "Disconnected";
  // Restarting Messages is the fix for a disconnected helper, so it leads
  const recommended: ServerActionKind | null =
    health.level === "degraded" ? "restart-messages" : health.level === "down" && health.fixable ? "restart-services" : null;

  return (
    <div className="bug-report-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="server-panel glass-panel" role="dialog" aria-label="Server status">
        <div className="server-panel-header">
          <h3>Server</h3>
          <button className="server-panel-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>

        {health.detail && (
          <div className={`server-panel-callout server-panel-callout-${health.level}`}>
            <strong>{health.summary}.</strong> {health.detail}
          </div>
        )}

        <section className="server-panel-section">
          <div className="server-status-row">
            <StatusDot level={socketState === "connected" ? "ok" : socketState === "connecting" ? "busy" : "down"} />
            <span className="server-status-label">Connection</span>
            <span className="server-status-value">
              {connectionText}
              {lastSync && <span className="server-status-sub"> · synced {ago(lastSync)}</span>}
            </span>
          </div>
          <div className="server-status-row">
            <StatusDot level={helperLevel} />
            <span className="server-status-label">Messages helper</span>
            <span className="server-status-value">{helperText}</span>
          </div>
          <div className="server-status-row">
            <StatusDot level={update?.available ? "busy" : info ? "ok" : "off"} />
            <span className="server-status-label">BlueBubbles</span>
            <span className="server-status-value">
              {info?.version ?? "—"}
              {update?.available ? (
                <>
                  <span className="server-status-sub"> · {update.version ?? "an update"} available </span>
                  <button className="server-inline-button" onClick={installUpdate} disabled={running || readOnly}>
                    Install
                  </button>
                </>
              ) : update ? (
                <span className="server-status-sub"> · up to date</span>
              ) : null}
            </span>
          </div>
          <div className="server-status-row">
            <StatusDot level={info ? "ok" : "off"} />
            <span className="server-status-label">Mac</span>
            <span className="server-status-value">{info?.osVersion ? `macOS ${info.osVersion}` : "—"}</span>
          </div>
          {unreachable && checkedAt && (
            <div className="server-status-note">Last heard from the server {ago(checkedAt)}.</div>
          )}
        </section>

        <section className="server-panel-section">
          <h4>Fixes</h4>
          {FIXES.map((fix) => (
            <div key={fix.kind} className="server-fix">
              <button
                className={`server-fix-button ${recommended === fix.kind ? "recommended" : ""}`}
                onClick={() => run(fix)}
                disabled={running || readOnly}
              >
                {running && action?.kind === fix.kind ? <span className="loading-spinner" style={{ width: 14, height: 14 }} /> : null}
                {fix.label}
              </button>
              <span className="server-fix-explanation">{fix.explanation}</span>
            </div>
          ))}
          {readOnly && <div className="server-status-note">Fixes are turned off in the read-only dev build.</div>}
          {action && (
            <div className={`server-action-result server-action-${action.phase}`} role="status">
              {action.phase === "running" && <span className="loading-spinner" style={{ width: 14, height: 14 }} />}
              {action.message}
              {action.finishedAt && <span className="server-status-sub"> · {ago(action.finishedAt)}</span>}
            </div>
          )}
        </section>

        <section className="server-panel-section">
          <div className="server-alerts-header">
            <h4>Alerts{unread.length > 0 && <span className="server-alert-count">{unread.length} new</span>}</h4>
            {unread.length > 0 && (
              <button className="server-inline-button" onClick={markAllRead} disabled={readOnly}>
                Mark all read
              </button>
            )}
          </div>
          {alertError && <div className="server-status-note server-status-error">{alertError}</div>}
          {alerts.length === 0 ? (
            <div className="server-status-note">No alerts.</div>
          ) : (
            <ul className="server-alerts">
              {alerts.map((alert) => (
                <li
                  key={alert.id}
                  className={`server-alert ${alert.isRead ? "" : "unread"} ${expanded === alert.id ? "expanded" : ""}`}
                  onClick={() => setExpanded(expanded === alert.id ? null : alert.id)}
                  title={expanded === alert.id ? undefined : alert.message}
                >
                  <span className={`server-alert-type server-alert-${alert.type}`}>{alert.type}</span>
                  <span className="server-alert-message">{alert.message}</span>
                  <span className="server-alert-time">{ago(alert.created)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** One line above the chat list when something needs attention. */
export function ServerBanner({ onOpen }: { onOpen: () => void }) {
  const socketState = useConnectionStore((s) => s.socketState);
  const { info, unreachable, action } = useServerStatusStore();
  const health = deriveHealth({ socketState, info, unreachable, action });

  // A dropped connection usually recovers within seconds; only speak up if it doesn't
  const [downSince, setDownSince] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const isDown = health.level === "down";
  useEffect(() => {
    if (!isDown) {
      setDownSince(null);
      return;
    }
    setDownSince((prev) => prev ?? Date.now());
    const timer = setTimeout(() => setTick((n) => n + 1), DOWN_GRACE_MS + 100);
    return () => clearTimeout(timer);
  }, [isDown]);

  const show =
    health.level === "degraded" || (isDown && downSince !== null && Date.now() - downSince >= DOWN_GRACE_MS);
  if (!show) return null;

  return (
    <button className={`server-banner server-banner-${health.level}`} onClick={onOpen}>
      <span className="server-banner-text">
        <strong>{health.summary}.</strong> {health.level === "degraded" ? "Messages won’t send." : "New messages won’t arrive."}
      </span>
      <span className="server-banner-action">{health.fixable ? "Fix" : "Details"}</span>
    </button>
  );
}

const DOWN_GRACE_MS = 15_000;
