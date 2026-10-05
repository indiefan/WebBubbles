"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChatRecord } from "@/lib/db";
import { Avatar, ChatFace } from "@/components/Avatar";

const RAIL_ROW_HEIGHT = 60;
const NO_FACE: ChatFace = { name: "", imageUrl: null };

/**
 * The order chats take in the collapsed sidebar: pinned ones first, in their
 * pinned order, then the rest as given (most recent first).
 */
export function orderForRail(chats: ChatRecord[]): { ordered: ChatRecord[]; pinnedCount: number } {
  const pinned = chats.filter((c) => c.isPinned).sort((a, b) => (a.pinIndex ?? 0) - (b.pinIndex ?? 0));
  const rest = chats.filter((c) => !c.isPinned);
  return { ordered: [...pinned, ...rest], pinnedCount: pinned.length };
}

interface RailItemProps {
  chat: ChatRecord;
  face: ChatFace;
  iconUrl?: string;
  active: boolean;
  /** Draws the line that separates pinned chats from the rest. */
  startsUnpinned: boolean;
  onOpen: (chatGuid: string) => void;
  onContextMenu: (e: React.MouseEvent, chatGuid: string) => void;
  onHover: (name: string | null, el: HTMLElement | null) => void;
}

const RailItem = memo(function RailItem({
  chat,
  face,
  iconUrl,
  active,
  startsUnpinned,
  onOpen,
  onContextMenu,
  onHover,
}: RailItemProps) {
  return (
    <button
      className={`chat-rail-item ${active ? "active" : ""} ${startsUnpinned ? "starts-unpinned" : ""}`}
      onClick={() => onOpen(chat.guid)}
      onContextMenu={(e) => onContextMenu(e, chat.guid)}
      onMouseEnter={(e) => onHover(face.name, e.currentTarget)}
      onMouseLeave={() => onHover(null, null)}
      onFocus={(e) => onHover(face.name, e.currentTarget)}
      onBlur={() => onHover(null, null)}
      aria-label={chat.hasUnreadMessage ? `${face.name}, unread` : face.name}
      aria-current={active ? "page" : undefined}
    >
      <span className="chat-rail-face">
        <Avatar name={face.name} imageUrl={iconUrl ?? face.imageUrl} members={face.members} size={44} />
        {chat.hasUnreadMessage && <span className="chat-rail-unread" />}
      </span>
    </button>
  );
});

interface ChatRailProps {
  /** Every chat, already ordered for the rail (see orderForRail). */
  chats: ChatRecord[];
  pinnedCount: number;
  faces: Map<string, ChatFace>;
  iconUrls: Record<string, string>;
  activeGuid: string | null;
  loading: boolean;
  onOpen: (chatGuid: string) => void;
  onContextMenu: (e: React.MouseEvent, chatGuid: string) => void;
}

/** The collapsed sidebar: one column of chat avatars. */
export function ChatRail({ chats, pinnedCount, faces, iconUrls, activeGuid, loading, onOpen, onContextMenu }: ChatRailProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ name: string; top: number; left: number } | null>(null);

  // Only the faces on screen are rendered; the list can hold thousands of chats
  const virtualizer = useVirtualizer({
    count: chats.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => RAIL_ROW_HEIGHT,
    overscan: 8,
  });

  // Faces alone don't say much, so name the one under the pointer
  const handleHover = useCallback((name: string | null, el: HTMLElement | null) => {
    if (!name || !el) {
      setTooltip(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setTooltip({ name, top: rect.top + rect.height / 2, left: rect.right + 6 });
  }, []);

  // Collapsing shouldn't lose track of the open chat when it is far down the
  // list: bring it into view once, as soon as there are chats to show.
  const hasChats = chats.length > 0;
  useEffect(() => {
    if (!hasChats) return;
    // Deferred so the list has finished mounting before it is scrolled
    const timer = setTimeout(() => {
      const index = activeGuid ? chats.findIndex((c) => c.guid === activeGuid) : -1;
      if (index > 0) virtualizer.scrollToIndex(index, { align: "center" });
    }, 0);
    return () => clearTimeout(timer);
    // Only on arrival: later changes to the open chat come from the user clicking here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasChats]);

  return (
    <div className="chat-rail" ref={listRef} onScroll={() => setTooltip(null)}>
      {loading ? (
        <div className="empty-state" style={{ paddingTop: 24 }}>
          <span className="loading-spinner"></span>
        </div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const chat = chats[item.index];
            return (
              <div
                key={chat.guid}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: RAIL_ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <RailItem
                  chat={chat}
                  face={faces.get(chat.guid) ?? NO_FACE}
                  iconUrl={iconUrls[chat.guid]}
                  active={chat.guid === activeGuid}
                  startsUnpinned={pinnedCount > 0 && item.index === pinnedCount}
                  onOpen={onOpen}
                  onContextMenu={onContextMenu}
                  onHover={handleHover}
                />
              </div>
            );
          })}
        </div>
      )}
      {tooltip && (
        <div className="chat-rail-tooltip" style={{ top: tooltip.top, left: tooltip.left }} role="tooltip">
          {tooltip.name}
        </div>
      )}
    </div>
  );
}
