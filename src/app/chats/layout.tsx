"use client";

import { useEffect, useCallback, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useChatStore } from "@/stores/chatStore";
import { useSyncStore } from "@/stores/syncStore";
import { http } from "@/services/http";
import { socketService } from "@/services/socket";
import { registerActionHandlers } from "@/services/actionHandler";
import { db } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverAddress, password, socketState, isSetup } = useConnectionStore();
  const { chats, setChats } = useChatStore();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (!isSetup) {
      router.push("/");
      return;
    }

    // Configure HTTP service
    http.configure(serverAddress, password);

    // Connect socket if not already connected
    if (!socketService.isConnected) {
      socketService.connect(serverAddress, password);
      registerActionHandlers();
    }

    // Load chats from IndexedDB
    const loadChats = async () => {
      try {
        const cached = await db.chats.orderBy("lastMessageDate").reverse().toArray();
        if (cached.length > 0) {
          setChats(cached);
        }
      } catch (err) {
        console.error("[ChatsLayout] Failed to load cached chats:", err);
      } finally {
        setLoading(false);
      }
    };

    loadChats();
  }, [isSetup, serverAddress, password, router, setChats]);

  const filteredChats = searchQuery
    ? chats.filter(
        (c) =>
          (c.displayName || c.chatIdentifier || "")
            .toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          (c.lastMessageText || "").toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : chats;

  const formatTime = useCallback((ts: number | null) => {
    if (!ts) return "";
    try {
      return formatDistanceToNow(new Date(ts), { addSuffix: false });
    } catch {
      return "";
    }
  }, []);

  const getInitials = (name: string | null, identifier: string) => {
    if (name) return name.charAt(0).toUpperCase();
    const clean = identifier.replace(/[^a-zA-Z0-9]/g, "");
    return clean.charAt(0).toUpperCase() || "#";
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Messages</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Connection indicator */}
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  socketState === "connected"
                    ? "var(--success)"
                    : socketState === "connecting"
                    ? "orange"
                    : "var(--danger)",
              }}
              title={`Socket: ${socketState}`}
            />
          </div>
        </div>

        <div className="search-bar">
          <input
            type="text"
            className="input-field"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ background: "rgba(255,255,255,0.05)", borderRadius: "12px" }}
          />
        </div>

        <div className="chat-list">
          {loading ? (
            <div className="empty-state">
              <span className="loading-spinner"></span>
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              {searchQuery ? "No matching chats" : "No chats found"}
            </div>
          ) : (
            filteredChats.map((chat) => (
              <div
                key={chat.guid}
                className={`chat-list-item ${
                  pathname === `/chats/${encodeURIComponent(chat.guid)}` ? "active" : ""
                }`}
                onClick={() => {
                  useChatStore.getState().setActiveChatGuid(chat.guid);
                  router.push(`/chats/${encodeURIComponent(chat.guid)}`);
                }}
              >
                <div className="avatar">
                  {getInitials(chat.displayName, chat.chatIdentifier)}
                </div>
                <div className="chat-info">
                  <div className="chat-title-row">
                    <span className="chat-name">
                      {chat.displayName || chat.chatIdentifier}
                    </span>
                    <span className="chat-time">{formatTime(chat.lastMessageDate)}</span>
                  </div>
                  <div className="chat-preview" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {chat.hasUnreadMessage && (
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--accent)",
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                      {chat.lastMessageText || "Attachment"}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Main */}
      <div className="main-view">{children}</div>
    </div>
  );
}
