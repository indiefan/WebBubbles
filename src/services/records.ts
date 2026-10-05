// Converters between BlueBubbles server payloads and local records, and the
// merge rules for combining a fresh payload with what is already stored.

import { AttachmentRecord, ChatRecord, HandleRecord, MessageRecord } from '@/lib/db';

// Attachment-only messages carry U+FFFC (object replacement) as their text
const OBJECT_REPLACEMENT = /￼/g;

function cleanText(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(OBJECT_REPLACEMENT, '').trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function serverAttachmentToRecord(att: any, messageGuid: string): AttachmentRecord {
  return {
    guid: att.guid,
    messageGuid,
    uti: att.uti ?? null,
    mimeType: att.mimeType ?? null,
    transferName: att.transferName ?? null,
    totalBytes: att.totalBytes ?? null,
    height: att.height || null,
    width: att.width || null,
    hasLivePhoto: att.hasLivePhoto ?? false,
    webUrl: null,
    metadata: null,
  };
}

/**
 * @param chatGuidHint the chat the payload was fetched for, used when the
 *   payload itself doesn't say which chat it belongs to
 */
export function serverMessageToRecord(data: any, chatGuidHint?: string): MessageRecord {
  const attachments: AttachmentRecord[] = (data.attachments ?? [])
    .filter((a: any) => a?.guid)
    .map((a: any) => serverAttachmentToRecord(a, data.guid));

  return {
    guid: data.guid,
    chatGuid: data.chats?.[0]?.guid ?? data.chatGuid ?? chatGuidHint ?? '',
    rowId: data.originalROWID ?? null,
    handleAddress: data.handle?.address ?? null,
    text: cleanText(data.text),
    subject: data.subject ?? null,
    dateCreated: data.dateCreated ?? Date.now(),
    dateRead: data.dateRead ?? null,
    dateDelivered: data.dateDelivered ?? null,
    dateEdited: data.dateEdited ?? null,
    // The server calls an unsent message "retracted"
    dateDeleted: data.dateRetracted ?? data.dateDeleted ?? null,
    isFromMe: data.isFromMe ?? false,
    hasAttachments: attachments.length > 0 || !!data.hasAttachments,
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
    attachments,
  };
}

/**
 * Combine a stored message with a newer payload for the same guid.
 *
 * Payloads vary in how complete they are (push-style socket events omit rich
 * bodies and attachment dimensions), so a field the new payload lacks must not
 * erase one we already have. Status fields always come from the new payload.
 */
export function mergeMessageRecord(existing: MessageRecord | undefined, incoming: MessageRecord): MessageRecord {
  if (!existing) return incoming;

  const incomingAttachments = incoming.attachments ?? [];
  const existingAttachments = existing.attachments ?? [];
  const existingByGuid = new Map(existingAttachments.map((a) => [a.guid, a]));
  const attachments =
    incomingAttachments.length === 0
      ? existingAttachments
      : incomingAttachments.map((a) => {
          const prev = existingByGuid.get(a.guid);
          if (!prev) return a;
          return { ...a, height: a.height ?? prev.height, width: a.width ?? prev.width };
        });

  return {
    ...incoming,
    chatGuid: incoming.chatGuid || existing.chatGuid,
    rowId: incoming.rowId ?? existing.rowId ?? null,
    tempGuid: incoming.tempGuid ?? existing.tempGuid,
    handleAddress: incoming.handleAddress ?? existing.handleAddress,
    threadOriginatorPart: incoming.threadOriginatorPart ?? existing.threadOriginatorPart,
    attributedBody: incoming.attributedBody ?? existing.attributedBody,
    messageSummaryInfo: incoming.messageSummaryInfo ?? existing.messageSummaryInfo,
    payloadData: incoming.payloadData ?? existing.payloadData,
    hasAttachments: incoming.hasAttachments || existing.hasAttachments,
    attachments,
  };
}

/** True when nothing a message bubble renders differs between the two records. */
export function sameRenderedMessage(a: MessageRecord, b: MessageRecord): boolean {
  return (
    a.guid === b.guid &&
    a.text === b.text &&
    a.subject === b.subject &&
    a.dateCreated === b.dateCreated &&
    a.dateRead === b.dateRead &&
    a.dateDelivered === b.dateDelivered &&
    a.dateEdited === b.dateEdited &&
    a.dateDeleted === b.dateDeleted &&
    a.error === b.error &&
    a.associatedMessageType === b.associatedMessageType &&
    a.tempGuid === b.tempGuid &&
    sameAttachments(a.attachments ?? [], b.attachments ?? [])
  );
}

function sameAttachments(a: AttachmentRecord[], b: AttachmentRecord[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].guid !== b[i].guid || a[i].width !== b[i].width || a[i].height !== b[i].height) return false;
  }
  return true;
}

/** Messages render oldest-first; ties fall back to server insertion order. */
export function compareMessages(a: MessageRecord, b: MessageRecord): number {
  if (a.dateCreated !== b.dateCreated) return a.dateCreated - b.dateCreated;
  const ar = a.rowId ?? 0;
  const br = b.rowId ?? 0;
  if (ar !== br) return ar - br;
  return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
}

/** Tapbacks and other messages that decorate another message instead of standing alone. */
export function isReaction(msg: MessageRecord): boolean {
  return !!msg.associatedMessageGuid;
}

export function serverHandleToRecord(handle: any): HandleRecord {
  return {
    address: handle.address,
    service: handle.service ?? 'iMessage',
    formattedAddress: handle.formattedAddress ?? null,
    country: handle.country ?? null,
    color: handle.color ?? null,
    contactId: handle.contactId ?? null,
    originalROWID: handle.originalROWID ?? null,
  };
}

/** What the chat list shows under the chat name for a given message. */
export function previewText(msg: Pick<MessageRecord, 'text' | 'hasAttachments' | 'itemType' | 'groupTitle'>): string | null {
  if (msg.text) return msg.text;
  if (msg.hasAttachments) return 'Attachment';
  // Group events carry no text of their own
  if (msg.itemType === 2) return msg.groupTitle ? `Named the conversation “${msg.groupTitle}”` : 'Conversation name removed';
  if (msg.itemType) return 'Group updated';
  return null;
}

export function serverChatToRecord(data: any): ChatRecord {
  const lastMessage = data.lastMessage ? serverMessageToRecord(data.lastMessage, data.guid) : null;
  return {
    guid: data.guid,
    chatIdentifier: data.chatIdentifier ?? '',
    displayName: data.displayName || null,
    isArchived: data.isArchived ?? false,
    isPinned: data.isPinned ?? false,
    pinIndex: data.pinIndex ?? 0,
    hasUnreadMessage: data.hasUnreadMessage ?? false,
    muteType: data.muteType ?? null,
    muteArgs: data.muteArgs ?? null,
    autoSendReadReceipts: data.autoSendReadReceipts ?? null,
    autoSendTypingIndicators: data.autoSendTypingIndicators ?? null,
    title: data.title ?? null,
    lastMessageGuid: lastMessage?.guid ?? null,
    lastMessageDate: lastMessage?.dateCreated ?? null,
    lastMessageText: lastMessage ? previewText(lastMessage) : null,
    lastReadMessageGuid: data.lastReadMessageGuid ?? null,
    dateDeleted: data.dateDeleted ?? null,
    style: data.style ?? null,
    customAvatarPath: data.customAvatarPath ?? null,
    participantHandleAddresses: data.participants?.map((p: any) => p.address) ?? [],
    syncedFrom: null,
    historyComplete: false,
    lastReadAt: null,
  };
}

/**
 * Combine a stored chat with a fresh server payload. The server knows nothing
 * about pins, unread state or our sync bookkeeping, so those always survive.
 */
export function mergeChatRecord(existing: ChatRecord | undefined, incoming: ChatRecord, raw: any): ChatRecord {
  if (!existing) return incoming;

  const merged: ChatRecord = {
    ...existing,
    chatIdentifier: incoming.chatIdentifier || existing.chatIdentifier,
    displayName: incoming.displayName,
    isArchived: incoming.isArchived,
    style: incoming.style ?? existing.style,
  };

  // Payloads that omit participants or the last message say nothing about them
  if (Array.isArray(raw?.participants) && raw.participants.length > 0) {
    merged.participantHandleAddresses = incoming.participantHandleAddresses;
  }
  if (incoming.lastMessageDate !== null && incoming.lastMessageDate >= (existing.lastMessageDate ?? 0)) {
    merged.lastMessageGuid = incoming.lastMessageGuid;
    merged.lastMessageDate = incoming.lastMessageDate;
    merged.lastMessageText = incoming.lastMessageText;
  }
  return merged;
}
