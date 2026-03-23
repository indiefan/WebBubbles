# Messaging

## Message Send Lifecycle

```
User types → ComposeArea
  ↓
Generate tempGuid ("temp-{timestamp}-{random}")
  ↓
Optimistic insert: message added to IndexedDB + messageStore with tempGuid, isFromMe=true
  ↓
Chat.lastMessage updated immediately for sort order
  ↓
OutgoingQueue.enqueue() → HTTP POST /api/v1/message/text (or /attachment)
  ↓
On success: delete temp record, insert real message with server GUID
On error: set message.error = 1, show "Failed to send" in UI
```

## Message Receive Lifecycle

```
Socket "new-message" event → ActionHandler.handleNewMessage()
  ↓
Duplicate check (Set of 200 recent GUIDs)
  ↓
Convert server payload → MessageRecord
  ↓
Upsert to IndexedDB + messageStore
  ↓
Update chat.lastMessage + hasUnreadMessage (if not active chat)
  ↓
Upsert handle + attachments if present
```

## Reactions (Tapbacks)

iMessage reactions are stored as separate `MessageRecord` entries:

- `associatedMessageGuid` → points to the original message (may have `p:N/` prefix)
- `associatedMessageType` → numeric code:
  - `2000-2005` = add reaction (love, like, dislike, laugh, emphasize, question)
  - `3000-3005` = remove reaction (same order)

### Display

`MessageBubble` queries the `associatedMessageGuid` index for each visible message, groups by emoji type respecting add/remove semantics, and renders as small badges at the bottom of the bubble.

### Sending

`ReactionPicker` (6-emoji popup, triggered by double-click or right-click) calls `http.sendReaction(chatGuid, messageText, messageGuid, type)` where type is one of: `love`, `like`, `dislike`, `laugh`, `emphasize`, `question`.

### Filtering

Reaction messages are filtered out of the main message list in the conversation view (`associatedMessageGuid != null`), so they only appear as badges.

## Attachments

### Sending
Files selected via file picker or drag-and-drop are previewed in `AttachmentPreview`, then sent via `http.sendAttachment()` as FormData.

### Receiving/Display
`MessageAttachment` component auto-downloads via `downloadService.getAttachmentUrl()`. Renders inline based on MIME type:
- Images → `<img>` (max 240×240)
- Video → `<video>` with controls
- Audio → `<audio>` with controls
- Other → file icon + name

Blurhash placeholders show during download via `react-blurhash`.
