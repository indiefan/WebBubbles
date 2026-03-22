"use client";

import { useEffect, useCallback, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useConnectionStore } from "@/stores/connectionStore";
import { useChatStore } from "@/stores/chatStore";
import { useSyncStore } from "@/stores/syncStore";
import { useContactStore } from "@/stores/contactStore";
import { http } from "@/services/http";
import { socketService } from "@/services/socket";
import { registerActionHandlers } from "@/services/actionHandler";
import { db } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";
import { NewChatModal } from "@/components/chat/NewChatModal";
import { SearchPanel } from "@/components/search/SearchPanel";
import { syncContacts } from "@/services/sync";

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverAddress, password, socketState, isSetup } = useConnectionStore();
  const { chats, setChats } = useChatStore();
  const { resolveChatDisplayName, resolveDisplayName, loaded: contactsLoaded } = useContactStore();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

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
          // Load contacts into memory for display name resolution
          await useContactStore.getState().loadContacts();
          // Kick off a background contact sync from server
          syncContacts().then(() => useContactStore.getState().loadContacts()).catch(() => {});
        } else if (useSyncStore.getState().lastFullSync) {
          // Fallback: If localStorage claims we're synced but IndexedDB is empty
          // (browser cleared storage, or database renamed), we must nuke the flag and force a resync!
          console.warn("[ChatsLayout] App claims to be synced but zero chats found! Resetting sync state.");
          useSyncStore.getState().setLastFullSync(null);
          router.push("/");
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
        (c) => {
          const resolved = resolveChatDisplayName(c).toLowerCase();
          const query = searchQuery.toLowerCase();
          return resolved.includes(query) ||
            (c.chatIdentifier || "").toLowerCase().includes(query) ||
            (c.lastMessageText || "").toLowerCase().includes(query);
        },
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

  const getInitials = (resolvedName: string) => {
    if (resolvedName) {
      const firstChar = resolvedName.charAt(0);
      if (/[a-zA-Z]/.test(firstChar)) return firstChar.toUpperCase();
    }
    return "#";
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
            {/* Logout button */}
            <button
              onClick={async () => {
                socketService.disconnect();
                useConnectionStore.getState().clear();
                useSyncStore.getState().setLastFullSync(null);
                useSyncStore.getState().reset();
                useChatStore.getState().setChats([]);
                try { await db.delete(); } catch {}
                router.push("/");
              }}
              title="Logout"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 4,
                display: "flex",
                alignItems: "center",
                color: "var(--muted)",
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
            {/* Search messages button */}
            <button
              onClick={() => setShowSearch(true)}
              title="Search Messages"
              style={{
                background: "var(--accent)",
                border: "none",
                borderRadius: "50%",
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
            </button>
            {/* New chat button */}
            <button
              onClick={() => setShowNewChat(true)}
              title="New Chat"
              style={{
                background: "var(--accent)",
                border: "none",
                borderRadius: "50%",
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
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
                  {getInitials(resolveChatDisplayName(chat))}
                </div>
                <div className="chat-info">
                  <div className="chat-title-row">
                    <span className="chat-name">
                      {resolveChatDisplayName(chat)}
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

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
    </div>
  );
}
