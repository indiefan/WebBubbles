"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSyncStore } from "@/stores/syncStore";
import { http } from "@/services/http";
import { socketService } from "@/services/socket";
import { registerActionHandlers } from "@/services/actionHandler";
import { fetchDevSession } from "@/services/devSession";

export default function SetupPage() {
  const router = useRouter();
  const { serverAddress, password, setCredentials, setServerInfo } = useConnectionStore();

  const [url, setUrl] = useState(serverAddress || "");
  const [pw, setPw] = useState(password || "");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"form" | "connecting">("form");

  // If already set up and synced, redirect to chats
  useEffect(() => {
    if (serverAddress && password && useSyncStore.getState().lastFullSync) {
      router.push("/chats");
    }
  }, [serverAddress, password, router]);

  const connect = async (serverUrl: string, serverPassword: string) => {
    if (!serverUrl || !serverPassword) {
      setError("Please fill in both fields");
      return;
    }

    try {
      setError(null);
      setPhase("connecting");

      // Configure services
      const cleanUrl = serverUrl.replace(/\/$/, "");
      http.configure(cleanUrl, serverPassword);

      // Test connection
      await http.ping();

      // Fetch server info
      try {
        const info = await http.serverInfo();
        setServerInfo({
          version: info?.data?.server_version,
          privateAPI: info?.data?.private_api,
        });
      } catch {
        // Non-fatal — continue without server info
      }

      // Save credentials
      setCredentials(cleanUrl, serverPassword);

      // Set up socket
      socketService.connect(cleanUrl, serverPassword);
      registerActionHandlers();

      // The chat list and messages load in the background once the app is open
      useSyncStore.getState().setLastFullSync(Date.now());
      router.push("/chats");
    } catch (err: any) {
      setError(err.message || "Failed to connect");
      setPhase("form");
    }
  };

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    connect(url, pw);
  };

  // Dev builds sign themselves in from the keychain (see scripts/dev-login.sh)
  useEffect(() => {
    if (serverAddress && password && useSyncStore.getState().lastFullSync) return;
    let cancelled = false;
    fetchDevSession().then((session) => {
      if (!session || cancelled) return;
      setUrl(session.serverUrl);
      setPw(session.password);
      connect(session.serverUrl, session.password);
    });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="setup-container">
      <div className="bg-blob bg-blob-1"></div>
      <div className="bg-blob bg-blob-2"></div>

      <div className="glass-panel setup-card">
        <div className="setup-header">
          <h1 className="gradient-text">WebBubbles</h1>
          <p>Connect to your macOS server to continue.</p>
        </div>

        {(
          <form onSubmit={handleConnect} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div className="form-group">
              <label htmlFor="url">Server URL</label>
              <input
                id="url"
                type="url"
                className="input-field"
                placeholder="https://your-ngrok-url.ngrok-free.app"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={phase !== "form"}
              />
            </div>

            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className="input-field"
                placeholder="••••••••"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={phase !== "form"}
              />
            </div>

            {error && (
              <div className="error-message">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="8" x2="12" y2="12"></line>
                  <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="button-primary"
              disabled={phase !== "form"}
              style={{ marginTop: "8px" }}
            >
              {phase === "connecting" ? <span className="loading-spinner"></span> : "Connect"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
