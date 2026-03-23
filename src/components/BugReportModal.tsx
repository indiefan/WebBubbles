"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import html2canvas from "html2canvas";
import { logBuffer } from "@/services/logBuffer";
import { http } from "@/services/http";

type Phase = "idle" | "capturing" | "form" | "submitting" | "done" | "error";

/**
 * Capture a DOM diagnostic snapshot: the main content area's HTML structure
 * and computed styles for elements matching key selectors. This gives developers
 * the context needed to debug visual/layout bugs without needing to reproduce them.
 */
function captureDomSnapshot(): string {
  const lines: string[] = [];

  // 1. Viewport info
  lines.push(`## DOM Snapshot`);
  lines.push(`- Viewport: ${window.innerWidth}×${window.innerHeight} (dpr: ${window.devicePixelRatio})`);
  lines.push(`- User Agent: ${navigator.userAgent}`);
  lines.push(`- URL: ${window.location.href}`);
  lines.push(``);

  // 2. Computed styles for debug-relevant selectors
  const selectors = [
    '.reaction-picker',
    '.reaction-picker-btn',
    '.reaction-badge',
    '.message-bubble.sent',
    '.message-bubble.received',
    '.compose-area',
  ];

  lines.push(`### Computed Styles`);
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const cs = getComputedStyle(el);
      lines.push(`#### \`${sel}\``);
      lines.push(`- background: ${cs.background}`);
      lines.push(`- backgroundColor: ${cs.backgroundColor}`);
      lines.push(`- color: ${cs.color}`);
      lines.push(`- border: ${cs.border}`);
      lines.push(`- padding: ${cs.padding}`);
      lines.push(`- margin: ${cs.margin}`);
      lines.push(`- position: ${cs.position}`);
      lines.push(`- display: ${cs.display}`);
      lines.push(`- zIndex: ${cs.zIndex}`);
      lines.push(`- opacity: ${cs.opacity}`);
      lines.push(`- appearance: ${cs.appearance}`);
      lines.push(`- backdropFilter: ${cs.backdropFilter}`);
      lines.push(``);
    }
  }

  // 3. Condensed DOM tree for the active conversation area
  const mainView = document.querySelector('.main-view') || document.querySelector('.app-layout');
  if (mainView) {
    lines.push(`### DOM Tree (main view, depth=3)`);
    lines.push('```html');
    lines.push(condensedDom(mainView, 3));
    lines.push('```');
  }

  // 4. All loaded stylesheets (just names, not content)
  lines.push(``);
  lines.push(`### Stylesheets`);
  for (const sheet of document.styleSheets) {
    try {
      lines.push(`- ${sheet.href || '(inline)'} (${sheet.cssRules?.length ?? '?'} rules)`);
    } catch {
      lines.push(`- ${sheet.href || '(inline)'} (cross-origin, cannot read)`);
    }
  }

  return lines.join('\n');
}

function condensedDom(el: Element, maxDepth: number, depth = 0): string {
  if (depth >= maxDepth) {
    const childCount = el.children.length;
    return childCount > 0 ? `${'  '.repeat(depth)}... (${childCount} children)` : '';
  }

  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).join('.')}` : '';
  const id = el.id ? `#${el.id}` : '';
  const indent = '  '.repeat(depth);

  let result = `${indent}<${tag}${id}${cls}>`;

  if (el.children.length === 0) {
    const text = el.textContent?.trim();
    if (text && text.length > 40) {
      result += ` "${text.slice(0, 40)}..."`;
    } else if (text) {
      result += ` "${text}"`;
    }
    return result;
  }

  const childLines: string[] = [];
  // Limit to first 15 children to keep size manageable
  const kids = Array.from(el.children).slice(0, 15);
  for (const child of kids) {
    const childStr = condensedDom(child, maxDepth, depth + 1);
    if (childStr) childLines.push(childStr);
  }
  if (el.children.length > 15) {
    childLines.push(`${'  '.repeat(depth + 1)}... (+${el.children.length - 15} more)`);
  }

  return result + '\n' + childLines.join('\n');
}

export default function BugReportModal() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [description, setDescription] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [domSnapshot, setDomSnapshot] = useState("");
  const [result, setResult] = useState<{ issueUrl?: string; error?: string; reportPath?: string; githubError?: string } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setPhase("idle");
    setDescription("");
    setScreenshotUrl(null);
    setDomSnapshot("");
    setResult(null);
  }, []);

  const startReport = useCallback(async () => {
    // Capture DOM snapshot BEFORE opening the modal (so it captures current UI state)
    const snapshot = captureDomSnapshot();
    setDomSnapshot(snapshot);

    setPhase("capturing");
    try {
      const canvas = await html2canvas(document.body, {
        backgroundColor: "#0f1014",
        scale: 1,
        logging: false,
        useCORS: true,
      });
      const dataUrl = canvas.toDataURL("image/png");
      setScreenshotUrl(dataUrl);
      setPhase("form");
    } catch (err) {
      console.error("[BugReport] Screenshot failed:", err);
      setPhase("form");
    }
  }, []);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "submitting") {
        close();
      }
    };
    if (phase !== "idle") {
      window.addEventListener("keydown", handleKey);
      return () => window.removeEventListener("keydown", handleKey);
    }
  }, [phase, close]);

  // Global keyboard shortcut: Cmd+Shift+B (Mac) / Ctrl+Shift+B (other)
  useEffect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (phase === "idle") {
          startReport();
        } else {
          close();
        }
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [phase, startReport, close]);

  const submitReport = async () => {
    if (!description.trim()) return;
    setPhase("submitting");

    try {
      const clientLogs = logBuffer.formatRecent(5 * 60 * 1000);

      let serverLogs = "";
      try {
        const res = await http.serverStatTotals();
        serverLogs = `Server stats:\n${JSON.stringify(res?.data, null, 2)}`;
      } catch {
        serverLogs = "(Could not fetch server info)";
      }

      // Append DOM snapshot to client logs
      const fullLogs = clientLogs + (domSnapshot ? `\n\n${domSnapshot}` : "");

      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          screenshotDataUrl: screenshotUrl,
          clientLogs: fullLogs,
          serverLogs,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResult({ issueUrl: data.issueUrl, reportPath: data.reportPath, githubError: data.githubError });
        setPhase("done");
      } else {
        setResult({ error: data.error || "Unknown error" });
        setPhase("error");
      }
    } catch (err: any) {
      setResult({ error: err.message });
      setPhase("error");
    }
  };

  if (phase === "idle") {
    return (
      <button
        className="bug-report-trigger"
        onClick={startReport}
        title="Report a bug (⌘⇧B)"
        aria-label="Report a bug"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1"/>
          <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z"/>
          <path d="M12 20v2M6 13H2M6 17H3M18 13h4M18 17h3"/>
        </svg>
      </button>
    );
  }

  return (
    <div className="bug-report-overlay" onClick={(e) => e.target === e.currentTarget && phase !== "submitting" && close()}>
      <div className="bug-report-modal glass-panel" ref={modalRef}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h3 style={{ fontSize: 18, fontWeight: 600 }}>
            {phase === "capturing" && "Capturing..."}
            {phase === "form" && "Report a Bug"}
            {phase === "submitting" && "Submitting..."}
            {phase === "done" && "Bug Reported!"}
            {phase === "error" && "Submission Failed"}
          </h3>
          {phase !== "submitting" && (
            <button onClick={close} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 20 }}>✕</button>
          )}
        </div>

        {/* Capturing state */}
        {phase === "capturing" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 24 }}>
            <span className="loading-spinner" style={{ width: 32, height: 32 }}></span>
            <p style={{ color: "var(--muted)" }}>Taking screenshot &amp; capturing DOM...</p>
          </div>
        )}

        {/* Form state */}
        {phase === "form" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {screenshotUrl && (
              <div>
                <label style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6, display: "block" }}>Screenshot preview:</label>
                <img
                  src={screenshotUrl}
                  alt="Screenshot"
                  style={{ width: "100%", borderRadius: 8, border: "1px solid var(--card-border)", maxHeight: 200, objectFit: "cover", objectPosition: "top" }}
                />
              </div>
            )}
            <div>
              <label style={{ fontSize: 13, color: "var(--muted)", marginBottom: 6, display: "block" }}>What went wrong?</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the bug you encountered..."
                className="input-field"
                style={{ minHeight: 100, resize: "vertical", fontFamily: "inherit" }}
                autoFocus
              />
            </div>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              Client logs, DOM snapshot, and computed styles will be automatically attached.
            </p>
            <button
              className="button-primary"
              onClick={submitReport}
              disabled={!description.trim()}
            >
              Submit Bug Report
            </button>
          </div>
        )}

        {/* Submitting state */}
        {phase === "submitting" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: 24 }}>
            <span className="loading-spinner" style={{ width: 32, height: 32 }}></span>
            <p style={{ color: "var(--muted)" }}>Creating GitHub issue...</p>
          </div>
        )}

        {/* Done state */}
        {phase === "done" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ color: "var(--success)" }}>
              ✓ Bug report saved successfully!
            </p>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Saved to: <code style={{ fontSize: 12 }}>{result?.reportPath}</code>
            </p>
            {result?.issueUrl && (
              <a
                href={result.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
              >
                View Issue on GitHub →
              </a>
            )}
            {result?.githubError && !result?.issueUrl && (
              <p style={{ fontSize: 12, color: "var(--danger)" }}>
                ⚠ GitHub issue not created: {result.githubError}
              </p>
            )}
            <button className="button-primary" onClick={close} style={{ marginTop: 8 }}>Close</button>
          </div>
        )}

        {/* Error state */}
        {phase === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="error-message">{result?.error || "An unknown error occurred"}</div>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>
              Make sure GITHUB_TOKEN and GITHUB_REPO are set in <code>.env.local</code>
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="button-primary" onClick={() => setPhase("form")} style={{ flex: 1 }}>Try Again</button>
              <button className="button-primary" onClick={close} style={{ flex: 1, background: "var(--card-bg)" }}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
