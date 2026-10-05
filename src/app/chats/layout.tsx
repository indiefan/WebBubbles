"use client";

import { memo, useEffect, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useConnectionStore } from "@/stores/connectionStore";
import { useChatStore } from "@/stores/chatStore";
import { useSyncStore } from "@/stores/syncStore";
import { useContactStore } from "@/stores/contactStore";
import { useMessageStore } from "@/stores/messageStore";
import { http } from "@/services/http";
import { socketService } from "@/services/socket";
import { registerActionHandlers } from "@/services/actionHandler";
import { ChatRecord, db } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";
import { NewChatModal } from "@/components/chat/NewChatModal";
import { SearchPanel } from "@/components/search/SearchPanel";
import { startSync, stopSync } from "@/services/sync";
import { chatIconCache } from "@/services/chatIconCache";
import { DEV_READ_ONLY } from "@/services/devSession";
import { useAppUpdate } from "@/services/appUpdate";
import { Avatar, AvatarPerson } from "@/components/Avatar";

const CHAT_ROW_HEIGHT = 72;
const NO_FACE: ChatFace = { name: "", imageUrl: null };

function sameFace(a: ChatFace, b: ChatFace): boolean {
  if (a.name !== b.name || a.imageUrl !== b.imageUrl) return false;
  const am = a.members ?? [];
  const bm = b.members ?? [];
  return am.length === bm.length && am.every((m, i) => m.name === bm[i].name && m.imageUrl === bm[i].imageUrl);
}

function formatTime(ts: number | null) {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: false });
  } catch {
    return "";
  }
}

/** What a chat's avatar is drawn from. */
interface ChatFace {
  name: string;
  imageUrl: string | null;
  /** Members of a group, for when it has no photo of its own. */
  members?: AvatarPerson[];
}

interface ChatRowProps {
  chat: ChatRecord;
  face: ChatFace;
  active: boolean;
  iconUrl?: string;
  onOpen: (chatGuid: string) => void;
  onContextMenu: (e: React.MouseEvent, chatGuid: string) => void;
}

const ChatRow = memo(function ChatRow({ chat, face, active, iconUrl, onOpen, onContextMenu }: ChatRowProps) {
  const name = face.name;
  return (
    <div
      className={`chat-list-item ${active ? "active" : ""}`}
      onClick={() => onOpen(chat.guid)}
      onContextMenu={(e) => onContextMenu(e, chat.guid)}
    >
      <Avatar name={name} imageUrl={iconUrl ?? face.imageUrl} members={face.members} />
      <div className="chat-info">
        <div className="chat-title-row">
          <span className="chat-name">{name}</span>
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
  );
});

export default function ChatsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const serverAddress = useConnectionStore((s) => s.serverAddress);
  const password = useConnectionStore((s) => s.password);
  const socketState = useConnectionStore((s) => s.socketState);
  const isSetup = useConnectionStore((s) => s.isSetup);
  const chats = useChatStore((s) => s.chats);
  // Subscribing to the contact maps re-renders names once contacts finish loading
  const contacts = useContactStore((s) => s.contacts);
  const handles = useContactStore((s) => s.handles);
  const avatarIndex = useContactStore((s) => s.avatarIndex);
  const resolveChatDisplayName = useContactStore((s) => s.resolveChatDisplayName);
  const updateAvailable = useAppUpdate();
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; chatGuid: string } | null>(null);
  const [chatIconUrls, setChatIconUrls] = useState<Record<string, string>>({});
  // Re-rendered once a minute so relative times ("5 minutes") stay current
  const [, setClock] = useState(0);

  useEffect(() => {
    if (!isSetup) {
      router.push("/");
      return;
    }

    http.configure(serverAddress, password);
    registerActionHandlers();
    if (!socketService.isStarted) {
      socketService.connect(serverAddress, password);
    }

    let cancelled = false;
    (async () => {
      // Show what we have locally straight away, then let sync bring it up to date
      let haveLocalChats = false;
      try {
        const cached = await db.chats.toArray();
        if (cancelled) return;
        haveLocalChats = cached.length > 0;
        if (haveLocalChats) {
          useChatStore.getState().setChats(cached);
          setLoading(false);
        }
        await useContactStore.getState().loadContacts();
      } catch (err) {
        console.error("[ChatsLayout] Failed to load cached chats:", err);
      }

      const firstSync = startSync();
      if (!haveLocalChats) {
        await firstSync;
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isSetup, serverAddress, password, router]);

  useEffect(() => {
    const timer = setInterval(() => setClock((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Find out which groups have a photo (remembered per chat, re-asked daily)
  const chatCount = chats.length;
  useEffect(() => {
    if (chatCount > 0) void chatIconCache.refreshGroupIcons();
  }, [chatCount]);

  // Load the photos of groups that have one
  useEffect(() => {
    for (const chat of chats) {
      if ((chat.hasIcon || chat.customAvatarPath) && !chatIconUrls[chat.guid]) {
        chatIconCache.getChatIconUrl(chat.guid).then((url) => {
          if (url) setChatIconUrls((prev) => (prev[chat.guid] === url ? prev : { ...prev, [chat.guid]: url }));
        });
      }
    }
  }, [chats]); // eslint-disable-line react-hooks/exhaustive-deps

  const facesRef = useRef(new Map<string, ChatFace>());
  const faces = useMemo(() => {
    const { resolveAvatar, resolveDisplayName } = useContactStore.getState();
    const prev = facesRef.current;
    const map = new Map<string, ChatFace>();
    for (const chat of chats) {
      const participants = chat.participantHandleAddresses ?? [];
      const face: ChatFace = {
        name: resolveChatDisplayName(chat),
        imageUrl: participants.length === 1 ? resolveAvatar(participants[0]) : null,
        members:
          participants.length > 1
            ? participants.slice(0, 2).map((addr) => ({ name: resolveDisplayName(addr), imageUrl: resolveAvatar(addr) }))
            : undefined,
      };
      // Rows are memoized on this object, so hand back the old one when nothing changed
      const before = prev.get(chat.guid);
      map.set(chat.guid, before && sameFace(before, face) ? before : face);
    }
    facesRef.current = map;
    return map;
    // contacts/handles/avatarIndex are listed so faces refresh when they load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, contacts, handles, avatarIndex, resolveChatDisplayName]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const [guid, face] of faces) map.set(guid, face.name);
    return map;
  }, [faces]);

  const filteredChats = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return chats;
    return chats.filter(
      (c) =>
        (names.get(c.guid) ?? "").toLowerCase().includes(query) ||
        (c.chatIdentifier || "").toLowerCase().includes(query) ||
        (c.lastMessageText || "").toLowerCase().includes(query),
    );
  }, [chats, names, searchQuery]);

  const pinned = useMemo(
    () => filteredChats.filter((c) => c.isPinned).sort((a, b) => (a.pinIndex ?? 0) - (b.pinIndex ?? 0)),
    [filteredChats],
  );
  const unpinned = useMemo(() => filteredChats.filter((c) => !c.isPinned), [filteredChats]);

  const openChat = useCallback(
    (chatGuid: string) => {
      useChatStore.getState().setActiveChatGuid(chatGuid);
      router.push(`/chats/${encodeURIComponent(chatGuid)}`);
    },
    [router],
  );

  const openContextMenu = useCallback((e: React.MouseEvent, chatGuid: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, chatGuid });
  }, []);

  // Only the rows on screen are rendered; the list can hold thousands of chats
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [rowsOffset, setRowsOffset] = useState(0);
  useLayoutEffect(() => {
    setRowsOffset(rowsRef.current?.offsetTop ?? 0);
  }, [pinned.length, loading]);

  // Rows are a fixed height, so positions depend only on the index. Nothing is
  // measured or cached per chat, which keeps reordering (a chat jumping to the
  // top on a new message) from ever showing stale rows.
  const virtualizer = useVirtualizer({
    count: unpinned.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => CHAT_ROW_HEIGHT,
    overscan: 8,
    scrollMargin: rowsOffset,
  });

  const activePath = pathname ?? "";
  const isActive = (chatGuid: string) => activePath === `/chats/${encodeURIComponent(chatGuid)}`;

  const handleLogout = async () => {
    stopSync();
    socketService.disconnect();
    useConnectionStore.getState().clear();
    useSyncStore.getState().setLastFullSync(null);
    useSyncStore.getState().reset();
    useChatStore.getState().setChats([]);
    useMessageStore.getState().clear();
    try {
      await Promise.all([
        db.chats.clear(),
        db.messages.clear(),
        db.handles.clear(),
        db.contacts.clear(),
        db.drafts.clear(),
        db.meta.clear(),
        typeof caches !== "undefined" ? caches.delete("bb-attachments") : Promise.resolve(),
      ]);
    } catch {}
    router.push("/");
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h2 style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            Messages
            <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400 }}>
              v{process.env.NEXT_PUBLIC_APP_VERSION || "dev"}
            </span>
            {DEV_READ_ONLY && (
              <span
                title="Dev build: nothing is sent to the server. Set NEXT_PUBLIC_BB_DEV_ALLOW_WRITES=1 to allow writes."
                style={{ fontSize: 10, color: "orange", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}
              >
                read-only
              </span>
            )}
            {updateAvailable && (
              <button className="update-pill" onClick={() => window.location.reload()} title="A newer version is ready">
                Update
              </button>
            )}
          </h2>
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
              onClick={handleLogout}
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

        <div className="chat-list" ref={listRef}>
          {loading ? (
            <div className="empty-state">
              <span className="loading-spinner"></span>
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              {searchQuery ? "No matching chats" : "No chats found"}
            </div>
          ) : (
            <>
              {/* Pinned chats horizontal row */}
              {pinned.length > 0 && (
                <div className="pinned-chats-section">
                  {pinned.map((chat) => {
                    const name = names.get(chat.guid) ?? "";
                    return (
                      <div
                        key={chat.guid}
                        className={`pinned-chat-item ${isActive(chat.guid) ? "active" : ""}`}
                        onClick={() => openChat(chat.guid)}
                        onContextMenu={(e) => openContextMenu(e, chat.guid)}
                        title={name}
                      >
                        <Avatar
                          name={name}
                          imageUrl={chatIconUrls[chat.guid] ?? faces.get(chat.guid)?.imageUrl}
                          members={faces.get(chat.guid)?.members}
                          size={44}
                        />
                        {chat.hasUnreadMessage && <span className="pinned-unread-dot" />}
                        <span className="pinned-chat-name">{name.split(" ")[0]}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Unpinned chats list */}
              <div ref={rowsRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const chat = unpinned[item.index];
                  return (
                    <div
                      key={chat.guid}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: CHAT_ROW_HEIGHT,
                        transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                      }}
                    >
                      <ChatRow
                        chat={chat}
                        face={faces.get(chat.guid) ?? NO_FACE}
                        active={isActive(chat.guid)}
                        iconUrl={chatIconUrls[chat.guid]}
                        onOpen={openChat}
                        onContextMenu={openContextMenu}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main */}
      <div className="main-view">{children}</div>

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}

      {/* Context menu overlay */}
      {contextMenu && (
        <div
          className="chat-context-overlay"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
        >
          <div
            className="chat-context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="chat-context-menu-item"
              onClick={() => {
                useChatStore.getState().togglePin(contextMenu.chatGuid);
                setContextMenu(null);
              }}
            >
              {chats.find((c) => c.guid === contextMenu.chatGuid)?.isPinned ? "📌 Unpin Chat" : "📌 Pin Chat"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
