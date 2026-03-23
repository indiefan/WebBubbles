# BlueBubbles Web Client — Implementation Plan

## 1. Executive Summary

This plan describes how to build a full-featured web client for BlueBubbles that connects to the same macOS server the mobile app uses. The web app will be built with **Next.js 16 + React 19 + TypeScript**, communicating over the server's REST API (`/api/v1/...`) and Socket.IO WebSocket for real-time events. Local persistence will use **IndexedDB** (via Dexie.js) in place of the mobile app's ObjectBox database.

An early scaffold already exists in `next-web/` with a setup page, a chat list sidebar, a basic message view, and a thin API wrapper. This plan builds on that scaffold to reach full feature parity with the mobile client.

---

## 2. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js 16 (App Router) | Already in scaffold; SSR for setup, CSR for chat UI |
| Language | TypeScript (strict) | Type safety across 60+ API endpoints and complex models |
| State management | Zustand | Lightweight, React 19–friendly, replaces GetX reactive model |
| Local database | Dexie.js (IndexedDB) | Indexed queries, transactions, live queries — closest browser analog to ObjectBox |
| Real-time | socket.io-client | Already in scaffold; matches server's Socket.IO protocol |
| HTTP client | ky (or native fetch wrapper) | Lightweight, retry/timeout support, interceptors |
| Styling | Tailwind CSS 4 | Utility-first, fast iteration, responsive design built-in |
| Media playback | Native HTML5 `<video>` / `<audio>` | No native plugin needed; covers all common formats |
| Encryption | Web Crypto API + CryptoJS-compat lib | AES-256-CBC with CryptoJS-compatible key derivation |
| Notifications | Web Notifications API + Service Worker | Push-like behavior when tab is open; true push via FCM later |
| Virtualized lists | TanStack Virtual | Performant rendering for chats with thousands of messages |
| Date formatting | date-fns | Tree-shakable, locale-aware |

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        Next.js App                           │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │   Pages /    │  │  Zustand     │  │  Service Layer      │ │
│  │   Components │←→│  Stores      │←→│  (API, Socket,      │ │
│  │   (React)    │  │  (state)     │  │   Sync, Downloads)  │ │
│  └─────────────┘  └──────────────┘  └────────┬────────────┘ │
│                                               │              │
│                   ┌───────────────────────────┤              │
│                   │                           │              │
│          ┌────────▼────────┐       ┌──────────▼──────────┐   │
│          │  Dexie.js       │       │  HTTP Client         │   │
│          │  (IndexedDB)    │       │  + Socket.IO Client  │   │
│          └─────────────────┘       └──────────┬──────────┘   │
│                                               │              │
└───────────────────────────────────────────────┼──────────────┘
                                                │
                                    ┌───────────▼───────────┐
                                    │  BlueBubbles Server   │
                                    │  (macOS)              │
                                    └───────────────────────┘
```

### 3.1 Core Architectural Principles

1. **Server is the source of truth.** The web client caches data locally for performance, but never assumes its cache is authoritative. Every sync resolves conflicts by trusting the server.

2. **Offline-tolerant, online-first.** Unlike the mobile app which works extensively offline, the web client treats the server connection as essential. IndexedDB is a performance cache and draft store, not an offline database.

3. **Event-driven updates.** Socket.IO events flow into the Zustand store, which triggers React re-renders. No polling loops.

4. **Progressive enhancement.** Core messaging works immediately. Advanced features (scheduled messages, Find My, FaceTime indicators) are layered in later phases.

---

## 4. Data Layer

### 4.1 IndexedDB Schema (Dexie.js)

The schema mirrors the mobile app's ObjectBox entities, adapted for IndexedDB's key-value model.

```typescript
// db.ts
import Dexie, { Table } from 'dexie';

interface ChatRecord {
  guid: string;             // primary key
  chatIdentifier: string;
  displayName: string | null;
  isArchived: boolean;
  isPinned: boolean;
  pinIndex: number;
  hasUnreadMessage: boolean;
  muteType: string | null;
  muteArgs: string | null;
  autoSendReadReceipts: boolean | null;
  autoSendTypingIndicators: boolean | null;
  title: string | null;
  lastMessageGuid: string | null;
  lastMessageDate: number | null; // epoch ms, indexed for sort
  lastMessageText: string | null;
  lastReadMessageGuid: string | null;
  dateDeleted: number | null;
  style: number | null;
  customAvatarPath: string | null;
  participantHandleAddresses: string[]; // denormalized for quick lookup
}

interface MessageRecord {
  guid: string;             // primary key
  chatGuid: string;         // indexed
  handleAddress: string | null;
  text: string | null;
  subject: string | null;
  dateCreated: number;      // epoch ms, indexed
  dateRead: number | null;
  dateDelivered: number | null;
  dateEdited: number | null;
  dateDeleted: number | null;
  isFromMe: boolean;
  hasAttachments: boolean;
  hasReactions: boolean;
  isBookmarked: boolean;
  associatedMessageGuid: string | null;   // for reactions
  associatedMessageType: string | null;
  associatedMessagePart: string | null;
  threadOriginatorGuid: string | null;     // for replies
  threadOriginatorPart: string | null;
  expressiveSendStyleId: string | null;    // bubble/screen effects
  error: number;
  itemType: number | null;
  groupTitle: string | null;
  groupActionType: number | null;
  balloonBundleId: string | null;
  attributedBody: object | null;   // JSON
  messageSummaryInfo: object | null;
  payloadData: object | null;
  metadata: object | null;
}

interface HandleRecord {
  address: string;          // primary key (unique address)
  service: string;          // "iMessage" | "SMS"
  formattedAddress: string | null;
  country: string | null;
  color: string | null;
  contactId: string | null; // FK to contact
  originalROWID: number | null;
}

interface AttachmentRecord {
  guid: string;             // primary key
  messageGuid: string;      // indexed
  uti: string | null;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number | null;
  height: number | null;
  width: number | null;
  hasLivePhoto: boolean;
  webUrl: string | null;
  metadata: object | null;
  // Blob storage handled separately via a dedicated object store or Cache API
}

interface ContactRecord {
  id: string;               // primary key
  displayName: string;
  phones: string[];
  emails: string[];
  structuredName: object | null;
  avatarHash: string | null; // hash key into avatar blob store
}

interface ChatParticipantRecord {
  chatGuid: string;
  handleAddress: string;
  // compound index: [chatGuid, handleAddress]
}

interface DraftRecord {
  chatGuid: string;         // primary key
  text: string;
  attachmentPaths: string[];
  updatedAt: number;
}

class BlueBubblesDB extends Dexie {
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  handles!: Table<HandleRecord, string>;
  attachments!: Table<AttachmentRecord, string>;
  contacts!: Table<ContactRecord, string>;
  chatParticipants!: Table<ChatParticipantRecord>;
  drafts!: Table<DraftRecord, string>;

  constructor() {
    super('BlueBubblesWeb');
    this.version(1).stores({
      chats: 'guid, lastMessageDate, chatIdentifier',
      messages: 'guid, chatGuid, dateCreated, [chatGuid+dateCreated], associatedMessageGuid, threadOriginatorGuid',
      handles: 'address, contactId',
      attachments: 'guid, messageGuid',
      contacts: 'id, displayName, *phones, *emails',
      chatParticipants: '[chatGuid+handleAddress], chatGuid, handleAddress',
      drafts: 'chatGuid',
    });
  }
}
```

### 4.2 Attachment Blob Storage

Binary attachment data (images, audio, video, documents) will NOT be stored in IndexedDB records. Instead:

- **Cache API** (`caches.open('bb-attachments')`) stores downloaded attachment blobs keyed by attachment GUID.
- A helper `getAttachmentUrl(guid)` checks the cache first; on miss, fetches from `/api/v1/attachment/{guid}/download`, stores in cache, and returns an object URL.
- A **cache eviction policy** (LRU by access time, configurable max size — default 500 MB) prevents unbounded storage growth. Metadata about cache entries (GUID, size, lastAccessed) is tracked in a small IndexedDB table.
- Contact avatars use the same cache, keyed by contact ID.

### 4.3 Live Queries

Dexie's `liveQuery()` provides reactive data binding similar to ObjectBox's `.watch()`:

```typescript
// In a React component or Zustand store
const messages = useLiveQuery(
  () => db.messages
    .where('[chatGuid+dateCreated]')
    .between([chatGuid, Dexie.minKey], [chatGuid, Dexie.maxKey])
    .reverse()
    .limit(50)
    .toArray(),
  [chatGuid]
);
```

This automatically re-renders when IndexedDB data changes — no manual subscription wiring needed.

---

## 5. Service Layer

### 5.1 HTTP Service (`services/http.ts`)

Wraps all REST API calls. Mirrors the mobile app's `http_service.dart` method signatures.

**Core design:**
- Base URL: `{serverAddress}/api/v1`
- Auth: `guid` query parameter on every request
- Configurable timeout (default 30s, extended for uploads)
- Automatic retry with exponential backoff (max 3 retries for 5xx/network errors)
- Request/response interceptor for logging and error normalization
- Custom header injection for ngrok/zrok/cloudflare tunnels
- CancelToken support via AbortController

**API method groups (matching mobile app 1:1):**

```
Server:       ping, serverInfo, softRestart, hardRestart, checkUpdate,
              installUpdate, serverStatistics, serverLogs

Chats:        queryChats, chatCount, createChat, singleChat, updateChat,
              deleteChat, leaveChat, chatMessages, addParticipant,
              removeParticipant, markChatRead, markChatUnread,
              getChatIcon, setChatIcon, deleteChatIcon, deleteMessage

Messages:     queryMessages, messageCount, singleMessage, embeddedMedia,
              sendText, sendAttachment, sendMultipart, sendReaction,
              unsendMessage, editMessage, notifyMessage

Attachments:  getAttachment, downloadAttachment, downloadLivePhoto,
              attachmentBlurhash, attachmentCount

Handles:      queryHandles, handleCount, singleHandle, focusHandle,
              checkIMessageAvailability, checkFaceTimeAvailability

Contacts:     getContacts, queryContacts, createContact

Scheduled:    getScheduled, createScheduled, updateScheduled, deleteScheduled

FindMy:       getDevices, refreshDevices, getFriends, refreshFriends

iCloud:       getAccount, getContacts, setAlias

Backup:       getThemeBackup, setThemeBackup, deleteThemeBackup,
              getSettings, setSettings, deleteSettings

FCM:          registerDevice, getClientConfig

FaceTime:     answerCall, leaveCall

Mac:          lockMac, restartIMessage
```

### 5.2 Socket Service (`services/socket.ts`)

Manages the Socket.IO connection and event routing.

**Events handled (matching mobile app):**
- `new-message` → upsert message in IndexedDB, update chat's lastMessage, trigger notification
- `updated-message` → update message record (edits, reactions, delivery/read status)
- `typing-indicator` → update typing state in Zustand store
- `chat-read-status-changed` → update chat read state
- `group-name-change` → update chat displayName
- `participant-added` / `participant-removed` / `participant-left` → update chat participants
- `ft-call-status-changed` / `incoming-facetime` → update call state
- `imessage-aliases-removed` → handle alias changes

**Encryption support:**
- When server sends `{ encrypted: true, data: "..." }`, decrypt using AES-256-CBC with the GUID as passphrase
- Implement CryptoJS-compatible key derivation: MD5-based PBKDF with "Salted__" prefix format

**Connection lifecycle:**
- Auto-reconnect with backoff on disconnect
- On reconnect: trigger incremental sync to catch missed messages
- Connection state exposed in Zustand store for UI indicators
- Health check ping every 30s

### 5.3 Sync Service (`services/sync.ts`)

Replicates the mobile app's two-tier sync system.

#### 5.3.1 Full Sync (Initial Setup)

Runs once after first connection. Mirrors `FullSyncManager`:

1. Fetch chat count via `GET /api/v1/chat/count`
2. Stream chats in pages of 200 via `POST /api/v1/chat/query` with `{ with: ["lastmessage", "participants"], sort: "lastmessage", offset, limit: 200 }`
3. For each chat, fetch messages in pages of 25 via `GET /api/v1/chat/{guid}/message` with `withQuery=attachments,message.attributedBody,message.messageSummaryInfo,message.payloadData`
4. Upsert all data into IndexedDB in bulk transactions
5. Record `lastIncrementalSync` timestamp and `lastIncrementalSyncRowId` in localStorage
6. Delete chats with zero participants (server artifact cleanup)
7. Report progress to UI via Zustand store (current/total counts)

**Performance considerations:**
- Use Dexie's `bulkPut()` for batch writes (much faster than individual puts)
- Process chats in parallel batches of 5 (avoid overwhelming the server, but don't serialize everything)
- Show a progress UI during full sync (chat X of Y, messages loaded)
- Allow user to start using the app after initial chat list loads (lazy-load messages per chat)

#### 5.3.2 Incremental Sync (Ongoing)

Runs on: app focus, socket reconnect, periodic timer (every 60s while connected). Mirrors `IncrementalSyncManager`:

**For server v1.6.0+:**
- Use `lastIncrementalSyncRowId` with WHERE clause: `message.ROWID > :startRowId`
- Fetch in pages of 1000 via `POST /api/v1/message/query` with `{ where: [{statement: 'message.ROWID > :val', args: {val: lastRowId}}], with: ["chats", "chats.participants", "attachments", "attributedBody", "messageSummaryInfo", "payloadData"], limit: 1000 }`

**For server < v1.6.0:**
- Use timestamp-based: `after: lastIncrementalSync, before: now`
- Fetch via message count then paginated retrieval

**Post-sync:**
- Upsert new/updated messages and their chats into IndexedDB
- Update `lastIncrementalSync` and `lastIncrementalSyncRowId`
- Dexie live queries auto-propagate changes to UI

#### 5.3.3 Contact Sync

- Fetch contacts via `GET /api/v1/contact`
- Upsert into contacts table
- Match handles to contacts by phone/email address
- Optionally upload local contacts to server (if user enables)

### 5.4 Download Service (`services/downloads.ts`)

Manages attachment downloads with a concurrent queue.

- Max 3 concurrent downloads (adjustable)
- Priority queue: active chat's attachments first
- Progress tracking per download (for UI progress bars)
- Downloaded blobs stored in Cache API
- Automatic download for small attachments (< 1 MB) when message is visible
- Manual download trigger for large files
- Blurhash placeholder display while downloading (via `GET /api/v1/attachment/{guid}/blurhash`)

### 5.5 Notification Service (`services/notifications.ts`)

- Request `Notification.permission` on first message receive
- Show browser notifications for messages when tab is not focused
- Notification content: sender name + message preview (respecting redacted mode)
- Click notification → focus tab and navigate to chat
- Notification sound playback via `<audio>` element
- Per-chat mute settings respected
- Group notification batching (don't flood with 20 notifications for a group chat burst)

### 5.6 Action Handler (`services/actionHandler.ts`)

Central event router, mirrors mobile app's `ActionHandler`:

- `handleNewMessage(data)` → parse message, resolve handle, upsert to DB, trigger notification if needed, update chat lastMessage
- `handleUpdatedMessage(data)` → update existing message (edit, reaction, delivery/read receipt)
- `handleNewOrUpdatedChat(data)` → fetch full chat from server, upsert to DB
- `handleTypingIndicator(data)` → update typing state in store
- Duplicate detection: maintain a Set of recently processed GUIDs (last 200) to prevent double-processing

### 5.7 Outgoing Queue (`services/outgoingQueue.ts`)

Mirrors mobile app's queue system:

1. `queue(item)` → assign temp GUID (`temp-{timestamp}-{random}`), optimistically add message to DB and UI
2. `processNext()` → send via HTTP, await server response
3. On success: replace temp GUID with real GUID in DB, update message metadata
4. On failure: mark message with error state, optionally cancel remaining queued items for that chat
5. Attachment sends: use `FormData` with progress tracking via `XMLHttpRequest` or fetch `ReadableStream`
6. Sequential processing per chat, parallel across different chats

---

## 6. State Management (Zustand Stores)

### 6.1 Store Structure

```
stores/
├── connectionStore.ts    — server URL, auth key, connection status, socket state
├── chatStore.ts          — chat list, active chat, pinned chats, filters
├── messageStore.ts       — messages for active chat, pagination cursor, thread state
├── contactStore.ts       — contacts, handles, display name resolution
├── typingStore.ts        — per-chat typing indicators
├── settingsStore.ts      — all user preferences (mirrors mobile app's 92 settings)
├── syncStore.ts          — sync status, progress, last sync timestamps
├── downloadStore.ts      — download queue state, progress per attachment
├── uiStore.ts            — sidebar open/closed, active panel, search state, modals
└── notificationStore.ts  — notification permissions, unread counts, sound settings
```

### 6.2 Reactivity Model

The mobile app uses GetX `Rx` wrappers for reactive state. In the web app:
- Zustand stores expose state + actions
- Components subscribe to specific slices via selectors: `useStore(s => s.activeChat)`
- Dexie `useLiveQuery` handles DB-driven reactivity (chat list, message list)
- Socket events update Zustand stores, which trigger re-renders
- Settings persisted to localStorage (not IndexedDB — small, frequently accessed)

---

## 7. UI Components & Pages

### 7.1 Page Structure

```
app/
├── page.tsx                          — Setup/connect page (exists)
├── layout.tsx                        — Root layout, font loading, providers
├── chats/
│   ├── layout.tsx                    — Split-panel layout: sidebar + main
│   ├── page.tsx                      — Empty state ("Select a chat")
│   └── [guid]/
│       └── page.tsx                  — Conversation view
├── settings/
│   └── page.tsx                      — Settings panels
└── findmy/
    └── page.tsx                      — Find My map view (Phase 3)
```

### 7.2 Component Breakdown

#### Setup/Connection
- `SetupPage` — Server URL + password form (exists, needs polish)
- `ConnectionStatusBadge` — Persistent indicator showing connected/disconnected/syncing

#### Chat List (Sidebar)
- `ChatList` — Virtualized list of chat tiles, sorted by lastMessageDate
- `ChatListItem` — Avatar, name, preview, timestamp, unread badge, pin indicator, typing indicator
- `PinnedChats` — Horizontal row of pinned chat avatars at top
- `ChatListSearch` — Search input with local + server search modes
- `ChatListFilters` — Archive toggle, unknown sender filter
- `NewChatButton` — Opens chat creator

#### Conversation View
- `ConversationView` — Container: header + message list + compose area
- `ConversationHeader` — Chat name, participant count, avatar, info button
- `MessageList` — Virtualized, reverse-scroll list with date separators
- `MessageBubble` — Text, metadata, delivery status, error state
- `MessageReactions` — Reaction emoji stacked on bubble
- `ReplyThread` — Reply-line connector + original message preview
- `MessageAttachment` — Inline image/video/audio/file display
- `MessageEvent` — System messages (participant joined, name changed, etc.)
- `TypingIndicator` — Animated dots with sender avatar
- `DateSeparator` — "Today", "Yesterday", "March 15" dividers
- `MessageActions` — Context menu: react, reply, edit, delete, copy, forward
- `ReactionPicker` — 6 tapback emoji selector popup
- `EffectPicker` — Send with effect selector (bubble + screen effects)

#### Compose Area
- `ComposeArea` — Text input + attachment bar + send button
- `AttachmentPreview` — Thumbnail strip of pending attachments
- `MentionSuggest` — @ mention autocomplete popup
- `EmojiPicker` — Emoji selector (use a library like emoji-mart)
- `GifPicker` — Giphy integration panel
- `AudioRecorder` — Voice message recording via MediaRecorder API

#### Conversation Details Panel
- `ConversationDetails` — Slide-out panel or separate view
- `ParticipantList` — Avatars, names, add/remove actions
- `SharedMedia` — Grid of images/videos shared in chat
- `SharedLinks` — List of URL previews
- `ChatActions` — Pin, archive, mute, leave group, notification settings

#### Settings
- `SettingsPage` — Tabbed/accordion panels
- Panels: Connection, Chat List, Conversation, Attachments, Theming, Notifications, Server Management, Privacy, About
- `ThemePicker` — Light/dark/system toggle, accent color picker
- `ServerInfo` — Server version, connection details, restart buttons

#### Search
- `SearchView` — Full-screen or panel search
- `SearchResults` — Message results with chat context, date highlighting
- `SearchFilters` — Date range, from/not-from, specific chat

#### Media Viewer
- `FullscreenMedia` — Lightbox for images/video
- `ImageViewer` — Zoom, pan, navigate between images
- `VideoPlayer` — HTML5 video with controls
- `AudioPlayer` — Waveform visualization + playback controls

### 7.3 Responsive Layout

- **Desktop (>1024px):** Three-column — sidebar (320px) | conversation (flex) | details panel (360px, collapsible)
- **Tablet (768-1024px):** Two-column — sidebar (280px) | conversation (flex); details as overlay
- **Mobile (<768px):** Single column — chat list OR conversation (with back button); details as full-screen overlay

---

## 8. Feature Implementation Details

### 8.1 Message Sending

```
User types message → ComposeArea
  ↓
Generate tempGuid ("temp-{Date.now()}-{Math.random()}")
  ↓
Optimistically insert message into IndexedDB with tempGuid, isFromMe=true, status="sending"
  ↓
Update chat.lastMessageDate for immediate sort update
  ↓
OutgoingQueue.enqueue({ type: 'text', chatGuid, tempGuid, text, subject?, replyGuid?, effectId? })
  ↓
HTTP POST /api/v1/message/text → server responds with real message object
  ↓
Replace temp message in DB: tempGuid → realGuid, populate server fields
  ↓
If error: set message.error, show retry option in UI
```

### 8.2 Attachment Sending

```
User selects file(s) via <input type="file"> or drag-and-drop
  ↓
Show attachment preview thumbnails in compose area
  ↓
On send: for each attachment:
  1. Generate temp attachment GUID
  2. Create FormData with file blob
  3. POST /api/v1/message/attachment with progress tracking
  4. Store blob in Cache API under real GUID
  5. Update message record with attachment metadata
```

### 8.3 Message Receiving (Real-time)

```
Socket event: "new-message" → { data: MessagePayload }
  ↓
ActionHandler.handleNewMessage(payload)
  ↓
Check duplicate set → skip if already processed
  ↓
Resolve handle (lookup in IndexedDB, fallback to address string)
  ↓
Upsert message to IndexedDB → Dexie liveQuery auto-updates MessageList
  ↓
Update chat.lastMessageDate, chat.hasUnreadMessage (if not active chat)
  ↓
If tab not focused → show browser notification
  ↓
If attachment present → queue for download (or show blurhash placeholder)
```

### 8.4 Reactions (Tapbacks)

**Displaying:** Messages with `hasReactions: true` query for associated messages where `associatedMessageGuid == msg.guid`. Group by reaction type, show stacked emoji badges on bubble.

**Sending:** `POST /api/v1/message/react` with `{ chatGuid, selectedMessageText, selectedMessageGuid, reaction: "+1" | "heart" | ... }`. Optimistically show reaction in UI.

### 8.5 Replies / Threads

**Displaying:** Messages with `threadOriginatorGuid` render with a reply-line visual connector and a truncated preview of the original message. Clicking the reply opens a thread popup showing all messages in that thread.

**Sending:** Set `selectedMessageGuid` and `partIndex` when composing a reply.

### 8.6 Message Editing & Unsending

**Edit:** `POST /api/v1/message/{guid}/edit` with new text. `updated-message` socket event reflects the change. `messageSummaryInfo.editedContent` stores edit history for display.

**Unsend:** `POST /api/v1/message/{guid}/unsend`. Message text is cleared, UI shows "Message unsent" placeholder with retracted styling.

### 8.7 Read Receipts & Delivery Status

- Outgoing messages: track `dateDelivered` and `dateRead` from `updated-message` events
- Display as subtle status text below the last message: "Delivered" / "Read [time]"
- Mark chat as read: `POST /api/v1/chat/{guid}/read` when user views a chat
- Auto-send read receipts: respect per-chat and global `autoSendReadReceipts` setting

### 8.8 Typing Indicators

- Receive via socket `typing-indicator` event → show animated dots with sender avatar
- Send typing status via socket emit when user is composing (debounced, every 3s while typing)
- Respect `autoSendTypingIndicators` setting
- Auto-clear after 5s of no updates from sender

### 8.9 Search

**Local search:** Query IndexedDB `messages` table with Dexie's full-text search or `.filter()` on `text` field.

**Server search:** `POST /api/v1/message/query` with WHERE clause containing text match, date range, chat filter.

**UI:** Results show message snippet with highlighted search term, chat name, and date. Tap to jump to message in conversation view.

### 8.10 Group Chat Management

- Create group: `POST /api/v1/chat/new` with list of participant addresses
- Rename: `PUT /api/v1/chat/{guid}` with new `displayName`
- Add participant: `POST /api/v1/chat/{guid}/participant/add`
- Remove participant: `POST /api/v1/chat/{guid}/participant/remove`
- Leave chat: `POST /api/v1/chat/{guid}/leave`
- Chat icon: `POST /api/v1/chat/{guid}/icon` (upload), `DELETE /api/v1/chat/{guid}/icon`
- System messages for participant changes rendered as `MessageEvent` components

### 8.11 Scheduled Messages

- List: `GET /api/v1/message/schedule`
- Create: `POST /api/v1/message/schedule` with `{ chatGuid, message, scheduledDate }`
- Edit: `PUT /api/v1/message/schedule/{id}`
- Cancel: `DELETE /api/v1/message/schedule/{id}`
- UI: Settings panel showing scheduled messages with edit/cancel actions

### 8.12 Notification System

1. On first message, prompt for Notification permission
2. When tab loses focus, show `new Notification(title, { body, icon })` for incoming messages
3. Respect per-chat mute settings and global `notifyReactions` setting
4. Notification click: `window.focus()` + navigate to chat
5. Optional: play sound via `<audio>` element (respect `notificationSound` setting)
6. Badge count: update `document.title` with unread count: `(3) BlueBubbles`

### 8.13 iMessage vs SMS Handling

- Handles have a `service` field: "iMessage" or "SMS"
- Visual distinction in UI: blue bubbles for iMessage, green for SMS
- When creating a new chat, allow toggling service type
- Display service badge on chat tiles for mixed-service contacts
- `GET /api/v1/handle/availability/imessage` to check if a contact can receive iMessages

### 8.14 URL Previews / Link Metadata

Messages with URLs: parse `payloadData` for server-generated previews containing title, description, thumbnail URL, and site name. Render as a card below the message bubble.

For messages where the server hasn't generated a preview, optionally fetch metadata client-side via a lightweight Open Graph parser.

### 8.15 Bubble & Screen Effects

- `expressiveSendStyleId` on messages maps to effects: "com.apple.MobileSMS.expressivesend.impact" (slam), "com.apple.MobileSMS.expressivesend.gentle", "com.apple.MobileSMS.expressivesend.loud", "com.apple.messages.effect.CKHappyEffect" (confetti), etc.
- Implement CSS/JS animations for: confetti, balloons, fireworks, lasers, love hearts, spotlight, echo
- Trigger on first render of the message (use a "played" flag in state)
- Effect picker in compose area for outgoing messages

### 8.16 Emoji & Sticker Support

- Large emoji detection: if message is 1-3 emoji only, render at 3x size (matching mobile `bigEmoji` behavior)
- Emoji picker component for compose area
- Sticker display: render sticker attachments inline with transparent background

---

## 9. Security

### 9.1 Authentication

- GUID auth key stored in localStorage (same approach as existing scaffold)
- Passed as query parameter on all API calls and socket connection
- No cookies, no session tokens — stateless auth per request

### 9.2 Encryption

- Socket payloads may be AES-encrypted when server has encryption enabled
- Implement CryptoJS-compatible AES-256-CBC decrypt:
  - Parse "Salted__" + 8-byte salt + ciphertext format
  - Derive 32-byte key + 16-byte IV using MD5-based key derivation (3 rounds of MD5)
  - Decrypt with PKCS7 padding removal
- Use Web Crypto API for AES operations where possible; fall back to a JS implementation for CryptoJS format compatibility

### 9.3 Content Security

- Sanitize all message HTML/rich text before rendering (prevent XSS from attributed body content)
- Attachment URLs use server-side auth (GUID in query param) — no additional token needed
- No client-side credential storage beyond the GUID key
- HTTPS enforced for all server communication (warn user if HTTP)

---

## 10. Performance Considerations

### 10.1 Message List Virtualization

The mobile app handles thousands of messages per chat. The web app must match this:

- **TanStack Virtual** for windowed rendering — only DOM nodes for visible messages + buffer
- Reverse scroll (newest at bottom, older messages load on scroll up)
- Dynamic row heights: measure each message bubble, cache heights for smooth scrolling
- **Pagination:** Load 50 messages initially, fetch 50 more on scroll-to-top
- **Skeleton loaders** during pagination fetches

### 10.2 Chat List Performance

- Virtualized chat list for users with 1000+ conversations
- Sort by `lastMessageDate` DESC in IndexedDB query (indexed field)
- Pinned chats sorted separately by `pinIndex`
- Debounced search input (300ms) to avoid excessive queries

### 10.3 Image & Media Optimization

- Thumbnails: request resized versions from server where API supports it
- Lazy loading: only fetch attachment data when message scrolls into viewport
- Blurhash placeholders while loading (fetched from `/api/v1/attachment/{guid}/blurhash`)
- Progressive JPEG display for large images
- Video: don't autoplay; show poster frame from first frame or server thumbnail

### 10.4 Network Optimization

- Batch IndexedDB writes using `bulkPut()` during sync
- Debounce typing indicator emissions (3s interval)
- Connection-aware: reduce sync frequency on slow connections
- Attachment download prioritization: visible items first, queued items by recency

### 10.5 Memory Management

- Dispose attachment object URLs when messages scroll out of viewport
- Limit in-memory message cache to active chat + 2 recent chats
- Clear typing indicator state for inactive chats
- Use Web Workers for heavy operations: full sync data processing, encryption/decryption of large payloads

---

## 11. Implementation Phases

### Phase 1: Foundation (Weeks 1–3)

**Goal:** Core messaging works end-to-end.

- [x] Set up project structure: Tailwind, Zustand, Dexie, TypeScript strict
- [x] Implement IndexedDB schema and Dexie database class
- [x] Build full HTTP service with all API methods and error handling
- [x] Build Socket.IO service with all event handlers and encryption support
- [x] Implement ActionHandler for processing incoming events
- [x] Implement outgoing message queue with temp GUID → real GUID resolution
- [x] Build full sync service (full + incremental)
- [x] Build settings store with localStorage persistence
- [x] Rework setup page: validate connection, trigger full sync, show progress
- [x] Build chat list with virtualization, proper sorting, unread badges
- [x] Build conversation view: message list, message bubbles, date separators
- [x] Build compose area: text input, send button, draft auto-save
- [x] Connection status indicator
- [x] Basic responsive layout (desktop + mobile breakpoints)

**Exit criteria:** User can connect to server, see all chats, send/receive text messages in real time, messages persist across page refreshes.

### Phase 2: Rich Messaging (Weeks 4–6)

**Goal:** Full message feature parity.

- [x] Attachment sending (file picker, drag-and-drop, progress)
- [x] Attachment display (inline images, video player, audio player, generic files)
- [x] Attachment download service with Cache API storage and LRU eviction
- [x] Blurhash placeholders during attachment loading
- [x] Reactions: display on bubbles, reaction picker, send reactions
- [x] Replies: display with thread connector, reply compose mode, thread popup
- [x] Message editing and unsending
- [ ] Read receipts and delivery status display
- [ ] Typing indicators (send and receive)
- [ ] Pinned chats display and management
- [ ] Chat muting and notification settings
- [ ] Browser notifications with sound
- [ ] URL preview cards (from payloadData)
- [ ] System/event messages (group name change, participant added/removed)
- [ ] Big emoji rendering
- [ ] Message context menu (right-click / long-press)
- [ ] Copy message text
- [ ] iMessage vs SMS bubble colors

**Exit criteria:** All message types render correctly, attachments load, reactions and replies work, notifications fire.

### Phase 3: Advanced Features (Weeks 7–9)

**Goal:** Feature-complete.

- [x] Search: local + server, date range filter, per-chat filter
- [x] Group chat management: create, rename, add/remove participants, leave
- [ ] Chat icon upload and display
- [x] Conversation details panel: participants, shared media grid, shared links
- [x] New chat creator with contact search
- [x] Contact sync and display name resolution
- [ ] Scheduled messages (list, create, edit, delete)
- [ ] Fullscreen media viewer (lightbox with zoom/pan)
- [ ] Audio recording and voice message sending
- [ ] Emoji picker (emoji-mart or similar)
- [ ] GIF picker (Giphy integration)
- [ ] Mention/tag support in compose
- [ ] Bubble effects and screen effects (CSS/JS animations)
- [ ] Effect picker for outgoing messages
- [ ] Archive/unarchive chats
- [ ] Mark chat as unread
- [ ] Keyboard shortcuts (Escape to close panels, Enter to send, Cmd+K for search)

**Exit criteria:** All features from the mobile app that are applicable to web are implemented.

### Phase 4: Polish & Performance (Weeks 10–12)

**Goal:** Production-ready quality.

- [ ] Theme system: light/dark/system, accent color picker, custom themes
- [ ] Responsive design pass: test all breakpoints, fix layout issues
- [ ] Accessibility: ARIA labels, keyboard navigation, screen reader support
- [ ] Settings page: all applicable settings from the mobile app's 92 settings
- [ ] Server management panel: server info, restart, logs, version check
- [ ] Backup/restore: theme and settings backup to server
- [ ] Performance audit: Lighthouse, bundle analysis, lazy loading of routes
- [x] PWA support: manifest, service worker, offline shell, install prompt
- [ ] Error handling: global error boundary, network error recovery, user-friendly messages
- [ ] Redacted mode (blur content for privacy)
- [ ] Find My integration (map view with device/friend locations)
- [ ] Comprehensive testing: unit tests for services, integration tests for sync, E2E tests for core flows
- [ ] Documentation: setup guide, architecture overview, contribution guide

**Exit criteria:** App is polished, performant, accessible, and ready for public use.

---

## 12. Testing Strategy

### 12.1 Unit Tests

- **Services:** HTTP service (mock server responses), Socket service (mock events), Sync service (mock API + verify DB state), Action Handler (event routing), Outgoing Queue (temp GUID lifecycle)
- **Stores:** Zustand store actions and computed state
- **Utilities:** Encryption/decryption, date formatting, message helpers
- **Framework:** Vitest (fast, ESM-native, compatible with Next.js)

### 12.2 Integration Tests

- Full sync: mock server API → verify complete IndexedDB state
- Incremental sync: mock delta → verify correct upserts
- Message send/receive cycle: compose → queue → API → socket event → DB → UI
- Attachment lifecycle: select → upload → download → cache → display

### 12.3 E2E Tests

- Playwright for browser automation
- Core flows: setup → connect → view chats → send message → receive message → search → settings
- Cross-browser: Chrome, Firefox, Safari
- Responsive: test mobile and desktop viewports

---

## 13. Migration Path from Existing Scaffold

The current `next-web/` scaffold has:
- ✅ Setup page (needs: sync trigger, progress UI)
- ✅ Chat list layout (needs: virtualization, proper data layer, real-time updates)
- ✅ Basic message view (needs: everything — attachments, reactions, threads, etc.)
- ✅ API wrapper with 5 methods (needs: expansion to 60+ methods, error handling, retry)
- ✅ Socket.IO connection (needs: all event handlers, encryption, reconnection)

**Migration steps:**
1. Add new dependencies: Dexie, Zustand, Tailwind, TanStack Virtual, date-fns, emoji-mart
2. Create the IndexedDB schema and database class
3. Replace the singleton `api` object with proper service classes
4. Build Zustand stores to replace component-local `useState`
5. Incrementally replace existing components with new implementations
6. Keep the existing pages working throughout migration (avoid big-bang rewrites)

---

## 14. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| IndexedDB storage limits | Browser may restrict to 50-100 MB | Implement LRU cache eviction for attachments; store only metadata for old messages; lazy-load message text from server |
| Socket.IO disconnections (ngrok/zrok tunnel instability) | Missed messages | Incremental sync on every reconnect; timestamp-based catch-up; visual indicator of connection loss |
| Large chat history (50k+ messages) | Slow full sync, memory pressure | Paginated sync with progress UI; lazy-load messages per chat; don't preload all chats' messages |
| CryptoJS-compatible encryption complexity | Decryption failures | Comprehensive test suite against known CryptoJS outputs; fallback to unencrypted mode with user warning |
| Cross-browser IndexedDB inconsistencies | Data corruption on Safari | Dexie normalizes most differences; test on Safari specifically; add error recovery for corrupt DB (full re-sync) |
| Web Notifications permission denied | No notification delivery | Fall back to in-app notification badge + sound; periodic title flash ("New message") |
| Server API version differences (v1.2 vs v1.6+) | Sync strategy differences | Server version detection on connect (via `/api/v1/server/info`); branch sync logic accordingly |
| Memory leaks in long sessions | Tab crashes after hours | Object URL cleanup on component unmount; periodic garbage collection of unused attachment blobs; limit in-memory caches |

---

## 15. Features Intentionally Excluded from Web

These mobile-specific features have no meaningful web equivalent:

- **Background isolates / threads:** Web Workers used where needed, but no persistent background processing
- **Native file system access:** All file operations use browser APIs (File API, Cache API)
- **Battery optimization:** N/A for web
- **Local network scanning:** Not possible from browser (security sandbox)
- **Launch at startup:** PWA install provides similar UX
- **System tray / foreground service:** N/A for web
- **Native contacts access:** Contacts synced from server only
- **Haptic feedback:** N/A for web
- **Display mode / refresh rate settings:** N/A for web
- **Method channels / JNI interop:** N/A for web
- **Tasker integration:** N/A for web
- **In-app review prompt:** N/A for web

---

## 16. Self-Review: Identified Gaps and Resolutions

After a full review pass of this plan, the following gaps were identified and resolved:

### Gap 1: Handle multi-device conflict resolution
**Issue:** If the mobile app and web app are both connected, who "wins" for read receipts and typing indicators?
**Resolution:** No conflict. Both clients send read receipts and typing indicators independently. The server broadcasts to all connected clients. The last read receipt wins (newest timestamp). This matches how iMessage itself works across Mac/iPhone.

### Gap 2: Draft synchronization across devices
**Issue:** The mobile app stores drafts locally. If a user starts typing on web, will the mobile app see it?
**Resolution:** Drafts are local-only (stored in IndexedDB `drafts` table). There is no server API for draft sync. This is acceptable — iMessage itself doesn't sync drafts across devices. Document this as a known limitation.

### Gap 3: Firebase Cloud Messaging for push notifications
**Issue:** The mobile app uses FCM for push when the app is backgrounded. How does web handle this?
**Resolution:** Phase 1-3 rely on Socket.IO for real-time delivery (only works while tab is open). For true background push, a service worker + FCM Web Push can be added in Phase 4. The server already has FCM infrastructure (`/api/v1/fcm/client`). The web client can register as an FCM device and receive push via the browser's Push API. Added to Phase 4 scope.

### Gap 4: Server address changes (dynamic URL via Firebase)
**Issue:** The mobile app uses Firebase Realtime Database to detect when the server URL changes (e.g., ngrok tunnel restart).
**Resolution:** The web client should also support this. On initial setup, if FCM data is available from `/api/v1/fcm/client`, initialize a Firebase connection to watch for URL changes. On URL change, update `connectionStore`, reconnect socket, and re-validate with ping. Added to Phase 1 scope as part of connection management.

### Gap 5: Chat list sorting consistency
**Issue:** The mobile app sorts by `dbOnlyLatestMessageDate`. Need to ensure the web app uses the same sort field.
**Resolution:** The IndexedDB schema already includes `lastMessageDate` on `ChatRecord`, indexed for fast sorting. This is populated from the `lastMessage.dateCreated` during sync and updated on each new message event. Sort consistency is ensured.

### Gap 6: Attachment MIME type handling
**Issue:** The mobile app has special handling for GIFs (checking for corrupted GIFs, "speedy GIFs"), HEIC conversion, and live photos.
**Resolution:** Web browsers natively handle GIFs and most image formats. For HEIC: the server's download endpoint likely converts to JPEG. For live photos: `GET /api/v1/attachment/{guid}/live` returns the video component. The web app should detect HEIC attachments and request the converted version. Added a note to the download service design.

### Gap 7: Service Worker for PWA offline shell
**Issue:** If the user loses internet, the entire app becomes blank.
**Resolution:** A service worker can cache the app shell (HTML, JS, CSS) so the UI loads even offline. IndexedDB data remains accessible. The app can show cached conversations with a "Reconnecting..." banner. Outgoing messages queue locally and send when reconnected. Added to Phase 4 PWA scope.

### Gap 8: Rate limiting and server overload protection
**Issue:** During full sync, rapid API calls could overwhelm the server (which is running on a personal Mac).
**Resolution:** Already addressed in sync design with batched requests and limited parallelism (5 concurrent chat syncs). Additional safeguard: implement a request semaphore in the HTTP service that limits to 10 concurrent API calls. Add configurable delay between sync batches (default 100ms).

### Gap 9: Contact display name resolution priority
**Issue:** The mobile app has a complex fallback chain: Contact.displayName → Handle.formattedAddress → Handle.address.
**Resolution:** The web app should replicate this chain. The `contactStore` should provide a `resolveDisplayName(handleAddress)` method that: (1) looks up Contact by matching phone/email, (2) falls back to Handle's formattedAddress, (3) falls back to raw address. Cache resolved names in memory for performance.

### Gap 10: Private API features
**Issue:** Many features depend on the server's "Private API" being enabled (typing indicators, read receipts, message editing). The web client needs to know what's available.
**Resolution:** On connect, check `serverInfo.privateAPI` flag from `/api/v1/server/info`. Store in `connectionStore`. Conditionally show/hide UI elements that require Private API (e.g., don't show "Edit message" if Private API is off). Added as a connection-time check.
