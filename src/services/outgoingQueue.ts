// Outgoing message queue with temp GUID → real GUID resolution.
// Sequential per chat, optimistic UI updates.

import { db, MessageRecord } from '@/lib/db';
import { useMessageStore } from '@/stores/messageStore';
import { useChatStore } from '@/stores/chatStore';
import { http } from './http';
import { serverMessageToRecord } from './actionHandler';

export interface QueueItem {
  chatGuid: string;
  tempGuid: string;
  text: string;
  subject?: string;
  selectedMessageGuid?: string;
  partIndex?: number;
  effectId?: string;
}

class OutgoingQueue {
  private queue: QueueItem[] = [];
  private processing = false;

  async enqueue(item: QueueItem) {
    // Create optimistic message record
    const optimistic: MessageRecord = {
      guid: item.tempGuid,
      chatGuid: item.chatGuid,
      handleAddress: null,
      text: item.text,
      subject: item.subject ?? null,
      dateCreated: Date.now(),
      dateRead: null,
      dateDelivered: null,
      dateEdited: null,
      dateDeleted: null,
      isFromMe: true,
      hasAttachments: false,
      hasReactions: false,
      isBookmarked: false,
      associatedMessageGuid: null,
      associatedMessageType: null,
      associatedMessagePart: null,
      threadOriginatorGuid: item.selectedMessageGuid ?? null,
      threadOriginatorPart: null,
      expressiveSendStyleId: item.effectId ?? null,
      error: 0,
      itemType: null,
      groupTitle: null,
      groupActionType: null,
      balloonBundleId: null,
      attributedBody: null,
      messageSummaryInfo: null,
      payloadData: null,
      metadata: null,
    };

    // Add to DB and store optimistically
    await db.messages.put(optimistic);
    useMessageStore.getState().addMessage(optimistic);
    useChatStore.getState().updateChatLastMessage(
      item.chatGuid,
      item.text,
      optimistic.dateCreated,
      item.tempGuid,
    );

    this.queue.push(item);
    this.processNext();
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;
    try {
      const response = await http.sendText(item.chatGuid, item.tempGuid, item.text, {
        subject: item.subject,
        selectedMessageGuid: item.selectedMessageGuid,
        partIndex: item.partIndex,
        effectId: item.effectId,
      });

      const realMessage = response?.data;
      if (realMessage?.guid) {
        const record = serverMessageToRecord(realMessage);
        // Replace temp with real in DB
        await db.messages.delete(item.tempGuid);
        await db.messages.put(record);
        useMessageStore.getState().replaceTempGuid(item.tempGuid, record.guid, record);
      }
    } catch (err: any) {
      console.error('[OutgoingQueue] Send failed:', err);
      // Mark message as errored
      await db.messages.update(item.tempGuid, { error: 1 });
      useMessageStore.getState().updateMessage(item.tempGuid, { error: 1 });
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  generateTempGuid(): string {
    return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const outgoingQueue = new OutgoingQueue();
