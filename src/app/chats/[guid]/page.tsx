"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, use } from "react";
import { NO_MESSAGES, useMessageStore } from "@/stores/messageStore";
import { useChatStore } from "@/stores/chatStore";
import { useContactStore } from "@/stores/contactStore";
import { MessageRecord } from "@/lib/db";
import { http } from "@/services/http";
import { loadOlder, openChat } from "@/services/sync";
import { isReaction } from "@/services/records";
import { buildReactionIndex, ReactionGroup } from "@/services/reactions";
import { format, isToday, isYesterday } from "date-fns";
import { ComposeArea } from "@/components/chat/ComposeArea";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ConversationDetails } from "@/components/chat/ConversationDetails";
import { chatIconCache } from "@/services/chatIconCache";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { Avatar } from "@/components/Avatar";

/** Within this distance of the newest message the view follows new arrivals. */
const STICK_TO_BOTTOM_PX = 150;
/** Within this distance of the oldest loaded message the next page is fetched. */
const LOAD_OLDER_PX = 800;

function formatDateSeparator(ts: number) {
  const date = new Date(ts);
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "MMMM d, yyyy");
}

export default function MessageView({ params }: { params: Promise<{ guid: string }> }) {
  const { guid: rawGuid } = use(params);
  const guid = decodeURIComponent(rawGuid);

  const slice = useMessageStore((s) => s.slices[guid]);
  const hydrated = slice?.hydrated ?? false;
  const messages = hydrated ? slice.messages : NO_MESSAGES;
  const pending = slice?.pending ?? NO_MESSAGES;
  const historyComplete = slice?.historyComplete ?? false;
  const loadingOlder = slice?.loadingOlder ?? false;

  const chat = useChatStore((s) => s.chats.find((c) => c.guid === guid));
  // Subscribing to the contact maps re-renders names once contacts finish loading
  const contacts = useContactStore((s) => s.contacts);
  const handles = useContactStore((s) => s.handles);
  const avatarIndex = useContactStore((s) => s.avatarIndex);
  const { resolveChatDisplayName, resolveDisplayName, resolveAvatar } = useContactStore.getState();

  const listRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showDetails, setShowDetails] = useState(false);
  const [chatIconUrl, setChatIconUrl] = useState<string | null>(null);

  const chatTitle = chat ? resolveChatDisplayName(chat) : guid;
  const participants = chat?.participantHandleAddresses ?? [];
  const isGroupChat = participants.length > 1;

  // ─── Loading ─────────────────────────────────────────

  // Local messages show at once; the server only adds to them afterwards
  useEffect(() => {
    useChatStore.getState().setActiveChatGuid(guid);
    void openChat(guid);

    return () => {
      useChatStore.getState().setActiveChatGuid(null);
      useMessageStore.getState().trim(guid);
    };
  }, [guid]);

  // Mark the chat read when it is opened, and again as messages arrive while it is on screen
  const newestIncomingGuid = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].isFromMe) return messages[i].guid;
    }
    return null;
  }, [messages]);

  const readStateRef = useRef<{ guid: string; incoming: string | null; settled: boolean } | null>(null);
  useEffect(() => {
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      useChatStore.getState().markChatRead(guid);
      http.markChatRead(guid).catch(() => {});
    };

    const state = readStateRef.current;
    if (!state || state.guid !== guid) {
      // Opening the chat reads it
      readStateRef.current = { guid, incoming: newestIncomingGuid, settled: hydrated };
      markRead();
    } else if (!state.settled) {
      // Local messages appearing isn't news; only what arrives after that is
      if (hydrated) {
        state.incoming = newestIncomingGuid;
        state.settled = true;
      }
    } else if (newestIncomingGuid && newestIncomingGuid !== state.incoming) {
      state.incoming = newestIncomingGuid;
      markRead();
    }

    document.addEventListener("visibilitychange", markRead);
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [guid, hydrated, newestIncomingGuid]);

  // Load chat icon
  const hasCustomIcon = !!(chat?.hasIcon || chat?.customAvatarPath);
  useEffect(() => {
    setChatIconUrl(null);
    if (hasCustomIcon) {
      chatIconCache.getChatIconUrl(guid).then((url) => setChatIconUrl(url));
    }
  }, [guid, hasCustomIcon]);

  // ─── Scrolling ───────────────────────────────────────
  //
  // The list is a column-reverse scroller: scrollTop is 0 at the newest message
  // and grows negative going back in time. It therefore opens at the bottom,
  // stays there as content arrives, and doesn't move when history is prepended.

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const fromBottom = Math.abs(el.scrollTop);
    atBottomRef.current = fromBottom < STICK_TO_BOTTOM_PX;

    const fromTop = el.scrollHeight - el.clientHeight - fromBottom;
    if (fromTop < LOAD_OLDER_PX) void loadOlder(guid);
  }, [guid]);

  // When the user is reading back and something lands below them, hold their place
  const newestKey = pending.length > 0 ? pending[pending.length - 1].guid : messages[messages.length - 1]?.guid;
  const anchorRef = useRef<{ guid: string; newestKey?: string; height: number }>({ guid, height: 0 });
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const prev = anchorRef.current;
    const height = el.scrollHeight;
    if (prev.guid === guid && prev.newestKey !== newestKey && prev.height > 0) {
      if (atBottomRef.current) el.scrollTop = 0;
      else el.scrollTop -= height - prev.height;
    }
    anchorRef.current = { guid, newestKey, height };
  }, [guid, newestKey, messages, pending]);

  // A chat with less than a screenful loaded needs its history fetched without a scroll
  useEffect(() => {
    const el = listRef.current;
    if (!el || !hydrated || historyComplete || loadingOlder || messages.length === 0) return;
    if (el.scrollHeight <= el.clientHeight + LOAD_OLDER_PX) void loadOlder(guid);
  }, [guid, hydrated, historyComplete, loadingOlder, messages.length]);

  const handleSend = useCallback(() => {
    atBottomRef.current = true;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  // ─── Rendering ───────────────────────────────────────

  const reactionIndexRef = useRef<Map<string, ReactionGroup[]>>(new Map());
  const reactionIndex = useMemo(() => {
    reactionIndexRef.current = buildReactionIndex(messages, reactionIndexRef.current);
    return reactionIndexRef.current;
  }, [messages]);

  const byGuid = useMemo(() => {
    const map = new Map<string, MessageRecord>();
    for (const m of messages) map.set(m.guid, m);
    return map;
  }, [messages]);

  const rows = useMemo(() => {
    const elements: React.ReactNode[] = [];
    let lastDate = "";

    // Reactions appear as badges on the message they target, not as rows
    const visible = [...messages, ...pending].filter((m) => !isReaction(m));
    // Consecutive messages from one person form a run: the name goes on the
    // first and the face on the last, as in Messages
    const days = visible.map((m) => formatDateSeparator(m.dateCreated));
    const sameRun = (a: number, b: number) =>
      a >= 0 &&
      b < visible.length &&
      !visible[a].isFromMe &&
      !visible[b].isFromMe &&
      !visible[a].itemType &&
      !visible[b].itemType &&
      visible[a].handleAddress === visible[b].handleAddress &&
      days[a] === days[b];

    for (let i = 0; i < visible.length; i++) {
      const msg = visible[i];
      const msgDate = days[i];
      if (msgDate !== lastDate) {
        elements.push(
          <div key={`date-${msgDate}`} className="message-date-separator">
            {msgDate}
          </div>,
        );
        lastDate = msgDate;
      }

      const replyGuid = msg.threadOriginatorGuid?.replace(/^(p:\d+\/|bp:)/, "");
      elements.push(
        <MessageBubble
          key={msg.tempGuid ?? msg.guid}
          msg={msg}
          chatGuid={guid}
          senderName={isGroupChat && !msg.isFromMe && msg.handleAddress ? resolveDisplayName(msg.handleAddress) : null}
          showSenderName={!sameRun(i - 1, i)}
          senderAvatar={isGroupChat && !msg.isFromMe ? resolveAvatar(msg.handleAddress) : undefined}
          hideFace={sameRun(i, i + 1)}
          reactions={reactionIndex.get(msg.guid)}
          replyTo={replyGuid ? byGuid.get(replyGuid) : undefined}
        />,
      );
    }
    return elements;
    // contacts/handles are listed so sender names refresh when they load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, pending, guid, isGroupChat, reactionIndex, byGuid, contacts, handles, avatarIndex]);

  const isEmpty = messages.length === 0 && pending.length === 0;

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <div className="chat-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar
              name={chatTitle}
              imageUrl={chatIconUrl ?? (participants.length === 1 ? resolveAvatar(participants[0]) : null)}
              members={
                isGroupChat
                  ? participants.slice(0, 2).map((addr) => ({ name: resolveDisplayName(addr), imageUrl: resolveAvatar(addr) }))
                  : undefined
              }
              size={32}
            />
            <h3 style={{ fontSize: 16, fontWeight: 600 }}>{chatTitle}</h3>
          </div>
          <button
            onClick={() => setShowDetails(!showDetails)}
            title="Details"
            style={{ background: "none", border: "none", cursor: "pointer", color: showDetails ? "var(--accent)" : "var(--muted)", padding: 4 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          </button>
        </div>

        {/* Keyed by chat so each one starts at its newest message */}
        <div key={`list:${guid}`} className="message-list" ref={listRef} onScroll={handleScroll}>
          <div className="message-list-inner">
            {!hydrated ? null : isEmpty ? (
              <div className="empty-state" style={{ padding: 24 }}>
                {historyComplete ? (
                  <p style={{ color: "var(--muted)" }}>No messages yet</p>
                ) : (
                  <span className="loading-spinner"></span>
                )}
              </div>
            ) : (
              <>
                {loadingOlder && (
                  <div className="message-list-status">
                    <span className="loading-spinner" style={{ width: 18, height: 18 }}></span>
                  </div>
                )}
                {rows}
              </>
            )}
            <TypingIndicator chatGuid={guid} isGroupChat={isGroupChat} />
          </div>
        </div>

        <ComposeArea key={`compose:${guid}`} chatGuid={guid} onSend={handleSend} />
      </div>

      {showDetails && chat && (
        <ConversationDetails chat={chat} onClose={() => setShowDetails(false)} />
      )}
    </div>
  );
}
