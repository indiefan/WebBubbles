"use client";

import { useEffect, useRef, useState, useCallback, use } from "react";
import { useMessageStore } from "@/stores/messageStore";
import { useChatStore } from "@/stores/chatStore";
import { useContactStore } from "@/stores/contactStore";
import { db, MessageRecord } from "@/lib/db";
import { http } from "@/services/http";
import { serverMessageToRecord } from "@/services/actionHandler";
import { outgoingQueue } from "@/services/outgoingQueue";
import { format, isToday, isYesterday } from "date-fns";

export default function MessageView({ params }: { params: Promise<{ guid: string }> }) {
  const { guid: rawGuid } = use(params);
  const guid = decodeURIComponent(rawGuid);

  const { messages, loading, setMessages, setLoading, setHasMore, clear } = useMessageStore();
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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

  // Auto-scroll when messages change (only if near bottom)
  useEffect(() => {
    if (isNearBottomRef.current && messages.length > 0) {
      // Use requestAnimationFrame to wait for DOM update
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    }
  }, [messages]);

  // Load draft from IndexedDB
  useEffect(() => {
    db.drafts.get(guid).then((d) => {
      if (d) {
        setText(d.text);
        setDraft(d.text);
      }
    });
  }, [guid]);

  // Auto-save draft
  useEffect(() => {
    if (text !== draft) {
      const timer = setTimeout(() => {
        db.drafts.put({ chatGuid: guid, text, attachmentPaths: [], updatedAt: Date.now() });
        setDraft(text);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [text, draft, guid]);

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
    clear();
    isNearBottomRef.current = true; // Reset scroll state on chat switch

    const load = async () => {
      setLoading(true);
      try {
        // Try IndexedDB first (sorted ASC — oldest first)
        const cached = await db.messages
          .where("[chatGuid+dateCreated]")
          .between([guid, -Infinity], [guid, Infinity])
          .limit(50)
          .toArray();

        if (cached.length > 0) {
          setMessages(cached);
        }

        // Then fetch fresh from server (API returns DESC, we reverse to ASC)
        const res = await http.chatMessages(guid, { limit: 50 });
        const serverMsgs: MessageRecord[] = (res?.data || []).map(serverMessageToRecord);
        serverMsgs.reverse(); // oldest first

        if (serverMsgs.length > 0) {
          await db.messages.bulkPut(serverMsgs);
          setMessages(serverMsgs);
          setHasMore(serverMsgs.length >= 50);
        } else {
          setHasMore(false);
        }
      } catch (err) {
        console.error("[MessageView] Failed to load messages:", err);
      } finally {
        setLoading(false);
        // Always scroll to bottom on initial load
        requestAnimationFrame(() => {
          messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
        });
      }
    };

    load();
  }, [guid, clear, setMessages, setLoading, setHasMore]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const messageText = text.trim();
    setText("");

    // Clear draft
    db.drafts.delete(guid).catch(() => {});

    // Force scroll to bottom when sending
    isNearBottomRef.current = true;

    outgoingQueue.enqueue({
      chatGuid: guid,
      tempGuid: outgoingQueue.generateTempGuid(),
      text: messageText,
    });
  };

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
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgDate = formatDateSeparator(msg.dateCreated);

      if (msgDate !== lastDate) {
        elements.push(
          <div key={`date-${msgDate}`} style={{ textAlign: "center", padding: "8px 0", color: "var(--muted)", fontSize: 12, fontWeight: 500 }}>
            {msgDate}
          </div>
        );
        lastDate = msgDate;
      }

      const isTemp = msg.guid.startsWith("temp-");
      const hasError = msg.error > 0;

      elements.push(
        <div key={msg.guid}>
          <div className={`message-bubble ${msg.isFromMe ? "sent" : "received"}`} style={{ opacity: isTemp ? 0.6 : 1 }}>
            {!msg.isFromMe && isGroupChat && msg.handleAddress && (
              <div style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--accent)",
                marginBottom: 2,
                opacity: 0.9,
              }}>
                {resolveDisplayName(msg.handleAddress)}
              </div>
            )}
            {msg.text || (msg.hasAttachments ? "[Attachment]" : "")}
          </div>
          <div style={{
            textAlign: msg.isFromMe ? "right" : "left",
            fontSize: 11,
            color: hasError ? "var(--danger)" : "var(--muted)",
            padding: "2px 4px",
            opacity: 0.7,
          }}>
            {hasError ? "Failed to send" : isTemp ? "Sending..." : formatTime(msg.dateCreated)}
          </div>
        </div>
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="chat-header">
        <h3 style={{ fontSize: 16, fontWeight: 600 }}>{chatTitle}</h3>
      </div>

      <div className="message-list" ref={messageListRef} onScroll={handleScroll}>
        {renderMessages()}
        <div ref={messagesEndRef} />
      </div>

      <form className="compose-area" onSubmit={handleSend}>
        <input
          type="text"
          className="compose-input"
          placeholder="iMessage"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="send-button" disabled={!text.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
          </svg>
        </button>
      </form>
    </div>
  );
}
