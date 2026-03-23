# Services

The service layer in `src/services/` mediates between the UI and the BlueBubbles server.

## HTTP Service (`http.ts`)

Wraps all REST API calls to the BlueBubbles server.

- **Base URL:** `{serverAddress}/api/v1`
- **Auth:** `guid` query parameter on every request (stateless, no cookies)
- **Timeout:** 30s default, 60s for text sends, 120s for attachment uploads
- **Tunnel support:** Auto-injects `ngrok-skip-browser-warning` or `skip_zrok_interstitial` headers

### API Groups

| Group | Methods |
|---|---|
| Server | `ping`, `serverInfo`, `serverStatTotals` |
| Chats | `queryChats`, `chatCount`, `singleChat`, `chatMessages`, `markChatRead/Unread`, `updateChat`, `deleteChat`, `createChat`, `addParticipant`, `removeParticipant`, `leaveChat`, `getChatIcon`, `setChatIcon`, `deleteChatIcon` |
| Messages | `queryMessages`, `messageCount`, `sendText`, `sendAttachment`, `sendReaction` |
| Handles | `queryHandles` |
| Attachments | `downloadAttachment`, `attachmentBlurhash` |
| Contacts | `getContacts` |
| FCM | `fcmClient` |

---

## Socket Service (`socket.ts`)

Manages the Socket.IO connection for real-time events.

- Events handled: `new-message`, `updated-message`, `typing-indicator`, `chat-read-status-changed`, `group-name-change`
- Auto-reconnect with backoff on disconnect
- Connection state exposed via `connectionStore.socketState`

---

## Action Handler (`actionHandler.ts`)

Central event router. Processes incoming server events and updates both IndexedDB and Zustand stores.

- **Duplicate detection:** Maintains a Set of 200 recently processed GUIDs
- **`handleNewMessage`:** Upserts message + handle + attachments to DB, updates chat's lastMessage, marks unread if not active chat
- **`handleUpdatedMessage`:** Upserts updated message (edits, delivery/read receipts)
- **Converters:** `serverMessageToRecord()` and `serverChatToRecord()` normalize server payloads to DB records

---

## Sync Service (`sync.ts`)

Two-tier sync replicating the mobile app's approach:

### Full Sync
Runs once after first setup. Fetches all chats (paginated, 200 per page) with participants and last message, then fetches messages per chat (25 per page). Uses `bulkPut()` for performance.

### Incremental Sync
Runs on reconnect. Uses timestamp-based range queries (`after`/`before`) to fetch only new messages.

### Contact Sync
Fetches contacts from `GET /api/v1/contact`, normalizes phone/email arrays, upserts to IndexedDB.

---

## Download Service (`downloads.ts`)

Manages attachment downloads with deduplication and Cache API storage.

- Deduplicates concurrent requests for the same GUID via a `Map<string, Promise>`
- Stores downloaded blobs in Cache API under `/api/v1/attachment/{guid}/download`
- Exposes loading state via `downloadStore`
- Provides blurhash fetching for image/video placeholders

---

## Outgoing Queue (`outgoingQueue.ts`)

Sequential message send queue with optimistic UI.

```
enqueue(item) → create temp message in DB + store → processNext()
  → send via HTTP (text or attachment) → replace temp GUID with real GUID
  → on error: mark message as errored in DB
```

- Generates temp GUIDs: `temp-{timestamp}-{random}`
- Sequential processing (one at a time) to avoid race conditions
- Supports text + optional attachment sends
