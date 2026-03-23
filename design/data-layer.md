# Data Layer

## IndexedDB Schema (Dexie.js)

All persistent client-side data lives in IndexedDB via Dexie.js. The database is named `WebBubbles`.

### Tables

| Table | Primary Key | Indexed Fields | Purpose |
|---|---|---|---|
| `chats` | `guid` | `lastMessageDate`, `chatIdentifier` | Chat metadata, participants, last message info |
| `messages` | `guid` | `chatGuid`, `dateCreated`, `[chatGuid+dateCreated]`, `associatedMessageGuid`, `threadOriginatorGuid` | All messages including reactions (stored as separate message records) |
| `handles` | `address` | `contactId` | Phone/email → service mapping |
| `attachments` | `guid` | `messageGuid` | Attachment metadata (not blob data) |
| `contacts` | `id` | `displayName`, `*phones`, `*emails` | Contact records from server |
| `chatParticipants` | `[chatGuid+handleAddress]` | `chatGuid`, `handleAddress` | Many-to-many chat↔handle join |
| `drafts` | `chatGuid` | — | Auto-saved message drafts |

### Key Design Decisions

- **Reactions are messages.** iMessage tapbacks are stored as `MessageRecord` entries where `associatedMessageGuid` points to the target message. They are filtered out of the message list and rendered as badges on the target bubble.
- **Compound index** `[chatGuid+dateCreated]` enables efficient range queries for loading a chat's messages in chronological order.
- **Multi-entry indexes** (`*phones`, `*emails`) on contacts enable phone/email → contact lookups for display name resolution.

## Attachment Blob Storage

Binary attachment data is stored in the **Cache API** (`caches.open('bb-attachments')`), not in IndexedDB. This avoids IndexedDB storage limits and enables efficient streaming.

```
getAttachmentUrl(guid)
  → check Cache API
  → on miss: GET /api/v1/attachment/{guid}/download → store in cache
  → return object URL
```

Blurhash placeholders are fetched from `/api/v1/attachment/{guid}/blurhash` and shown while the full attachment downloads.

## Live Queries

Dexie's `useLiveQuery()` provides reactive data binding — when IndexedDB data changes (e.g., from a socket event), any component subscribed via `useLiveQuery` automatically re-renders.
