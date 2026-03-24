# Chat-Keyed Message Store

## Problem

The `messageStore` holds a single flat `messages[]` array with no concept of which chat the messages belong to. When a new message arrives via socket, `handleNewMessage` calls `addMessage(msg)` unconditionally — appending it to the shared array regardless of `chatGuid`. Since `MessageView` subscribes to the entire array, messages from any sender appear in the currently active conversation.

The data is correctly persisted in IndexedDB (keyed by `chatGuid`), so the bug only manifests in the real-time Zustand path.

## Design

Replace the flat `messages[]` with a chat-keyed map:

```
Record<chatGuid, ChatMessageSlice>
```

where each slice contains its own messages array, loading state, and pagination cursor:

```ts
interface ChatMessageSlice {
  messages: MessageRecord[];
  loading: boolean;
  hasMore: boolean;
}

interface MessageState {
  // Core data — one slice per chat that has been opened/received messages
  slices: Record<string, ChatMessageSlice>;

  // Active chat tracking (moved from chatStore for co-location)
  activeChatGuid: string | null;

  // Reply state (global — only one reply compose at a time)
  replyToMessage: MessageRecord | null;

  // Actions scoped by chatGuid
  setMessages:     (chatGuid: string, msgs: MessageRecord[]) => void;
  prependMessages: (chatGuid: string, msgs: MessageRecord[]) => void;
  addMessage:      (chatGuid: string, msg: MessageRecord) => void;
  updateMessage:   (chatGuid: string, guid: string, updates: Partial<MessageRecord>) => void;
  replaceTempGuid: (chatGuid: string, tempGuid: string, realGuid: string, updates: Partial<MessageRecord>) => void;
  setLoading:      (chatGuid: string, loading: boolean) => void;
  setHasMore:      (chatGuid: string, hasMore: boolean) => void;
  clearChat:       (chatGuid: string) => void;

  // Reply (unchanged)
  setReplyToMessage:   (msg: MessageRecord | null) => void;
  clearReplyToMessage: () => void;

  // Full reset
  clear: () => void;
}
```

### Selector Pattern

Components subscribe only to the slice they care about:

```ts
// In MessageView
const messages = useMessageStore(s => s.slices[guid]?.messages ?? []);
const loading  = useMessageStore(s => s.slices[guid]?.loading ?? false);
```

This ensures re-renders are scoped — a message arriving for Chat B does not trigger a re-render in Chat A's view.

## Memory Management

Each opened chat creates a slice. Without limits, memory grows with every chat the user visits in a session.

### Strategy: LRU Eviction

- **Max cached slices**: 10 (configurable constant `MAX_CACHED_CHATS`)
- **Eviction trigger**: When `addMessage` or `setMessages` is called for a chat and the number of slices exceeds the limit
- **Eviction target**: The least-recently-accessed slice that is **not** the active chat
- **Access tracking**: A `lastAccessed` timestamp on each slice, updated on any read or write
- **No data loss**: Eviction only removes the in-memory Zustand slice; IndexedDB retains all messages. Re-opening an evicted chat simply re-fetches from IndexedDB (instant) and then the server.

### Why 10?

A typical message view holds ≤50 messages (the fetch limit). At ~1KB per `MessageRecord`, 10 chats ≈ 500KB — well within acceptable browser memory. Users rarely have more than a few chats actively open in one session.

## Impact on Consumers

| File | Change |
|---|---|
| `messageStore.ts` | Rewrite: flat array → keyed map with per-chat actions |
| `actionHandler.ts` | Pass `chatGuid` to `addMessage`, `updateMessage`, `replaceTempGuid` |
| `outgoingQueue.ts` | Pass `chatGuid` to `addMessage`, `replaceTempGuid`, `updateMessage` |
| `[guid]/page.tsx` | Use chat-scoped selectors; remove manual `clear()` on navigation |
| `MessageBubble.tsx` | Pass `chatGuid` to `updateMessage`, `setReplyToMessage` (unchanged) |
| `ComposeArea.tsx` | No change (only uses `replyToMessage`, which stays global) |
| `state-management.md` | Update docs to reflect new store shape |
| `messaging.md` | Update receive lifecycle to note chat-scoped routing |
| `phase2.test.ts` | Update calls to pass `chatGuid`; add cross-chat isolation test |
| `integration.test.ts` | Update `addMessage`/`clear` calls |
