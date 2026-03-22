// ActionHandler — central event router for incoming server events.
// Processes new/updated messages, typing indicators, and chat events,
// updating both IndexedDB and Zustand stores.

import { db, MessageRecord, ChatRecord } from '@/lib/db';
import { useChatStore } from '@/stores/chatStore';
import { useMessageStore } from '@/stores/messageStore';
import { socketService } from './socket';

// Duplicate detection: keep track of recently processed GUIDs
const recentGuids = new Set<string>();
const MAX_RECENT = 200;

function trackGuid(guid: string) {
  recentGuids.add(guid);
  if (recentGuids.size > MAX_RECENT) {
    const first = recentGuids.values().next().value;
    if (first) recentGuids.delete(first);
  }
}

// ─── Converters ────────────────────────────────────────

export function serverMessageToRecord(data: any): MessageRecord {
  return {
    guid: data.guid,
    chatGuid: data.chats?.[0]?.guid ?? data.chatGuid ?? '',
    handleAddress: data.handle?.address ?? data.handleId ?? null,
    text: data.text ?? null,
    subject: data.subject ?? null,
    dateCreated: data.dateCreated ?? Date.now(),
    dateRead: data.dateRead ?? null,
    dateDelivered: data.dateDelivered ?? null,
    dateEdited: data.dateEdited ?? null,
    dateDeleted: data.dateDeleted ?? null,
    isFromMe: data.isFromMe ?? false,
    hasAttachments: !!(data.attachments?.length) || data.hasAttachments || false,
    hasReactions: data.hasReactions ?? false,
    isBookmarked: data.isBookmarked ?? false,
    associatedMessageGuid: data.associatedMessageGuid ?? null,
    associatedMessageType: data.associatedMessageType ?? null,
    associatedMessagePart: data.associatedMessagePart ?? null,
    threadOriginatorGuid: data.threadOriginatorGuid ?? null,
    threadOriginatorPart: data.threadOriginatorPart ?? null,
    expressiveSendStyleId: data.expressiveSendStyleId ?? null,
    error: data.error ?? 0,
    itemType: data.itemType ?? null,
    groupTitle: data.groupTitle ?? null,
    groupActionType: data.groupActionType ?? null,
    balloonBundleId: data.balloonBundleId ?? null,
    attributedBody: data.attributedBody ?? null,
    messageSummaryInfo: data.messageSummaryInfo ?? null,
    payloadData: data.payloadData ?? null,
    metadata: data.metadata ?? null,
  };
}

export function serverChatToRecord(data: any): ChatRecord {
  return {
    guid: data.guid,
    chatIdentifier: data.chatIdentifier ?? '',
    displayName: data.displayName ?? null,
    isArchived: data.isArchived ?? false,
    isPinned: data.isPinned ?? false,
    pinIndex: data.pinIndex ?? 0,
    hasUnreadMessage: data.hasUnreadMessage ?? false,
    muteType: data.muteType ?? null,
    muteArgs: data.muteArgs ?? null,
    autoSendReadReceipts: data.autoSendReadReceipts ?? null,
    autoSendTypingIndicators: data.autoSendTypingIndicators ?? null,
    title: data.title ?? null,
    lastMessageGuid: data.lastMessage?.guid ?? null,
    lastMessageDate: data.lastMessage?.dateCreated ?? null,
    lastMessageText: data.lastMessage?.text ?? null,
    lastReadMessageGuid: data.lastReadMessageGuid ?? null,
    dateDeleted: data.dateDeleted ?? null,
    style: data.style ?? null,
    customAvatarPath: data.customAvatarPath ?? null,
    participantHandleAddresses: data.participants?.map((p: any) => p.address) ?? [],
  };
}

// ─── Handlers ──────────────────────────────────────────

async function handleNewMessage(rawData: any) {
  const data = rawData?.data ?? rawData;
  if (!data?.guid) return;
  if (recentGuids.has(data.guid)) return;
  trackGuid(data.guid);

  const msg = serverMessageToRecord(data);

  // Upsert to IndexedDB
  await db.messages.put(msg);

  // Update store (if this is the active chat)
  useMessageStore.getState().addMessage(msg);

  // Update chat's lastMessage
  if (msg.chatGuid) {
    useChatStore.getState().updateChatLastMessage(
      msg.chatGuid,
      msg.text,
      msg.dateCreated,
      msg.guid,
    );

    // Mark unread if not from me and not the active chat
    const activeChat = useChatStore.getState().activeChatGuid;
    if (!msg.isFromMe && msg.chatGuid !== activeChat) {
      useChatStore.getState().markChatUnread(msg.chatGuid);
    }
  }

  // Upsert handles and attachments if present
  if (data.handle) {
    await db.handles.put({
      address: data.handle.address,
      service: data.handle.service ?? 'iMessage',
      formattedAddress: data.handle.formattedAddress ?? null,
      country: data.handle.country ?? null,
      color: data.handle.color ?? null,
      contactId: data.handle.contactId ?? null,
      originalROWID: data.handle.originalROWID ?? null,
    });
  }

  if (data.attachments?.length) {
    for (const att of data.attachments) {
      await db.attachments.put({
        guid: att.guid,
        messageGuid: msg.guid,
        uti: att.uti ?? null,
        mimeType: att.mimeType ?? null,
        transferName: att.transferName ?? null,
        totalBytes: att.totalBytes ?? null,
        height: att.height ?? null,
        width: att.width ?? null,
        hasLivePhoto: att.hasLivePhoto ?? false,
        webUrl: att.webUrl ?? null,
        metadata: att.metadata ?? null,
      });
    }
  }
}

async function handleUpdatedMessage(rawData: any) {
  const data = rawData?.data ?? rawData;
  if (!data?.guid) return;

  const msg = serverMessageToRecord(data);
  await db.messages.put(msg);
  useMessageStore.getState().updateMessage(msg.guid, msg);
}

function handleTypingIndicator(data: any) {
  // For Phase 1 we just log; Phase 2 will add the typing store
  console.log('[ActionHandler] Typing indicator:', data);
}

function handleChatReadStatus(data: any) {
  const chatGuid = data?.chatGuid ?? data?.guid;
  if (!chatGuid) return;
  useChatStore.getState().markChatRead(chatGuid);
}

// ─── Registration ──────────────────────────────────────

export function registerActionHandlers() {
  socketService.on('new-message', handleNewMessage);
  socketService.on('updated-message', handleUpdatedMessage);
  socketService.on('typing-indicator', handleTypingIndicator);
  socketService.on('chat-read-status-changed', handleChatReadStatus);

  socketService.on('group-name-change', async (data: any) => {
    const chatGuid = data?.chatGuid ?? data?.guid;
    if (!chatGuid) return;
    const displayName = data?.displayName ?? data?.newChatName;
    if (displayName !== undefined) {
      await db.chats.update(chatGuid, { displayName });
      const chat = await db.chats.get(chatGuid);
      if (chat) {
        useChatStore.getState().upsertChat(chat);
      }
    }
  });

  console.log('[ActionHandler] All handlers registered');
}

export { handleNewMessage, handleUpdatedMessage };
