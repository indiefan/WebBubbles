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

export default function MessageView({ params }: { params: Promise<{ guid: string }> }) {
  const { guid: rawGuid } = use(params);
  const guid = decodeURIComponent(rawGuid);

  const { messages, loading, setMessages, setLoading, setHasMore, clear } = useMessageStore();
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

      elements.push(
        <MessageBubble key={msg.guid} msg={msg} isGroupChat={!!isGroupChat} />
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

      <ComposeArea 
        chatGuid={guid} 
        onSend={() => {
          isNearBottomRef.current = true;
        }} 
      />
    </div>
  );
}
