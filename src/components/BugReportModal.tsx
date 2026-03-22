"use client";

import { useState, useRef, useEffect } from "react";
import html2canvas from "html2canvas";
import { logBuffer } from "@/services/logBuffer";
import { http } from "@/services/http";

type Phase = "idle" | "capturing" | "form" | "submitting" | "done" | "error";

export default function BugReportModal() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [description, setDescription] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{ issueUrl?: string; error?: string; reportPath?: string } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

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
  }, [phase]);

  const close = () => {
    setPhase("idle");
    setDescription("");
    setScreenshotUrl(null);
    setResult(null);
  };

  const startReport = async () => {
    setPhase("capturing");
    try {
      // Capture screenshot of the entire page
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
      // Continue without screenshot
      setPhase("form");
    }
  };

  const submitReport = async () => {
    if (!description.trim()) return;
    setPhase("submitting");

    try {
      // Gather client logs
      const clientLogs = logBuffer.formatRecent(5 * 60 * 1000);

      // Try to get server logs from BlueBubbles server
      let serverLogs = "";
      try {
        const res = await http.serverStatTotals();
        serverLogs = `Server stats:\n${JSON.stringify(res?.data, null, 2)}`;
      } catch {
        serverLogs = "(Could not fetch server info)";
      }

      // Send to our API route
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: description.trim(),
          screenshotDataUrl: screenshotUrl,
          clientLogs,
          serverLogs,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setResult({ issueUrl: data.issueUrl, reportPath: data.reportPath });
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
        title="Report a bug"
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
            <p style={{ color: "var(--muted)" }}>Taking screenshot...</p>
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
              Client logs (last 5 min) will be automatically attached.
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
