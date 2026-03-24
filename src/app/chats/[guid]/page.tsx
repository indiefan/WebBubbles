"use client";

import { useEffect, useRef, useState, useCallback, use } from "react";
import { useMessageStore } from "@/stores/messageStore";
import { useChatStore } from "@/stores/chatStore";
import { useContactStore } from "@/stores/contactStore";
import { db, MessageRecord } from "@/lib/db";
import { http } from "@/services/http";
import { serverMessageToRecord } from "@/services/actionHandler";
import { format, isToday, isYesterday } from "date-fns";
import { ComposeArea } from "@/components/chat/ComposeArea";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ConversationDetails } from "@/components/chat/ConversationDetails";

import { TypingIndicator } from "@/components/chat/TypingIndicator";

export default function MessageView({ params }: { params: Promise<{ guid: string }> }) {
  const { guid: rawGuid } = use(params);
  const guid = decodeURIComponent(rawGuid);

  const messages = useMessageStore((s) => s.slices[guid]?.messages ?? []);
  const loading = useMessageStore((s) => s.slices[guid]?.loading ?? false);
  const { setMessages, setLoading, setHasMore } = useMessageStore.getState();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const isInitialLoadRef = useRef(true);
  const [showDetails, setShowDetails] = useState(false);

  // ─── Sticky auto-scroll ──────────────────────────────
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Track if user has scrolled up
  const handleScroll = useCallback(() => {
    const el = messageListRef.current;
    if (!el) return;
    // "Near bottom" = within 150px of the bottom
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distFromBottom < 150;
  }, []);

  // Auto-scroll when messages change (only if near bottom and NOT initial load)
  useEffect(() => {
    if (isInitialLoadRef.current) return; // skip — initial load handles its own scroll
    if (isNearBottomRef.current && messages.length > 0) {
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  }, [messages]);

  // Set active chat
  useEffect(() => {
    useChatStore.getState().setActiveChatGuid(guid);
    useChatStore.getState().markChatRead(guid);
    http.markChatRead(guid).catch(() => {});

    return () => {
      useChatStore.getState().setActiveChatGuid(null);
    };
  }, [guid]);

  // Load messages
  useEffect(() => {
    isNearBottomRef.current = true;
    isInitialLoadRef.current = true;

    const load = async () => {
      setLoading(guid, true);
      try {
        // Try IndexedDB first (sorted ASC — oldest first)
        const cached = await db.messages
          .where("[chatGuid+dateCreated]")
          .between([guid, -Infinity], [guid, Infinity])
          .limit(50)
          .toArray();

        if (cached.length > 0) {
          setMessages(guid, cached);
        }

        // Then fetch fresh from server (API returns DESC, we reverse to ASC)
        const res = await http.chatMessages(guid, { limit: 50 });
        const serverMsgs: MessageRecord[] = (res?.data || []).map(serverMessageToRecord);
        serverMsgs.reverse(); // oldest first

        if (serverMsgs.length > 0) {
          await db.messages.bulkPut(serverMsgs);
          setMessages(guid, serverMsgs);
          setHasMore(guid, serverMsgs.length >= 50);
        } else {
          setHasMore(guid, false);
        }
      } catch (err) {
        console.error("[MessageView] Failed to load messages:", err);
      } finally {
        setLoading(guid, false);
        // Instant scroll on initial load (no animation)
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
          // Allow smooth scrolling for future new messages
          isInitialLoadRef.current = false;
        });
      }
    };

    load();
  }, [guid, setMessages, setLoading, setHasMore]);

  const formatDateSeparator = (ts: number) => {
    const date = new Date(ts);
    if (isToday(date)) return "Today";
    if (isYesterday(date)) return "Yesterday";
    return format(date, "MMMM d, yyyy");
  };

  const formatTime = (ts: number) => {
    return format(new Date(ts), "h:mm a");
  };

  // Group messages by date
  const renderMessages = () => {
    if (messages.length === 0) {
      return (
        <div className="empty-state" style={{ padding: 24 }}>
          <p style={{ color: "var(--muted)" }}>No messages yet</p>
        </div>
      );
    }

    const elements: React.ReactNode[] = [];
    let lastDate = "";

    // Messages are sorted ASC (oldest first), rendered top-to-bottom
    // Filter out reaction messages — they appear as badges on the original message
    const displayMessages = messages.filter(msg => !msg.associatedMessageGuid);

    for (let i = 0; i < displayMessages.length; i++) {
      const msg = displayMessages[i];
      const msgDate = formatDateSeparator(msg.dateCreated);

      if (msgDate !== lastDate) {
        elements.push(
          <div key={`date-${msgDate}`} style={{ textAlign: "center", padding: "8px 0", color: "var(--muted)", fontSize: 12, fontWeight: 500 }}>
            {msgDate}
          </div>
        );
        lastDate = msgDate;
      }

      elements.push(
        <MessageBubble key={msg.guid} msg={msg} isGroupChat={!!isGroupChat} chatGuid={guid} />
      );
    }

    return elements;
  };

  if (loading && messages.length === 0) {
    return (
      <div className="empty-state">
        <span className="loading-spinner"></span>
      </div>
    );
  }

  // Get chat info
  const chat = useChatStore.getState().chats.find((c) => c.guid === guid);
  const { resolveChatDisplayName, resolveDisplayName } = useContactStore.getState();
  const chatTitle = chat ? resolveChatDisplayName(chat) : guid;
  const isGroupChat = chat && (chat.participantHandleAddresses?.length ?? 0) > 1;

  return (
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
        <div className="chat-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{chatTitle}</h3>
          <button
            onClick={() => setShowDetails(!showDetails)}
            title="Details"
            style={{ background: "none", border: "none", cursor: "pointer", color: showDetails ? "var(--accent)" : "var(--muted)", padding: 4 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          </button>
        </div>

        <div className="message-list" ref={messageListRef} onScroll={handleScroll}>
          {renderMessages()}
          <TypingIndicator chatGuid={guid} isGroupChat={!!isGroupChat} />
          <div ref={messagesEndRef} />
        </div>

        <ComposeArea 
          chatGuid={guid} 
          onSend={() => {
            isNearBottomRef.current = true;
          }} 
        />
      </div>

      {showDetails && chat && (
        <ConversationDetails chat={chat} onClose={() => setShowDetails(false)} />
      )}
    </div>
  );
}
