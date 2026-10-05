// Outgoing message queue: optimistic bubbles, one send at a time, and
// reconciliation with the confirmed message whichever way it arrives first
// (the HTTP response or the socket event).

import { MessageRecord } from '@/lib/db';
import { useMessageStore } from '@/stores/messageStore';
import { useChatStore } from '@/stores/chatStore';
import { http } from './http';
import { ingestMessages } from './ingest';

export interface QueueItem {
  chatGuid: string;
  tempGuid: string;
  text: string;
  attachments?: File[];
  subject?: string;
  selectedMessageGuid?: string;
  partIndex?: number;
  effectId?: string;
}

/** One request to the server: a single attachment, or a text message. */
interface SendUnit {
  chatGuid: string;
  tempGuid: string;
  text: string;
  file?: File;
  subject?: string;
  selectedMessageGuid?: string;
  partIndex?: number;
  effectId?: string;
}

function optimisticMessage(unit: SendUnit): MessageRecord {
  return {
    guid: unit.tempGuid,
    chatGuid: unit.chatGuid,
    rowId: null,
    handleAddress: null,
    text: unit.file ? null : unit.text,
    subject: unit.subject ?? null,
    dateCreated: Date.now(),
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateDeleted: null,
    isFromMe: true,
    hasAttachments: !!unit.file,
    hasReactions: false,
    isBookmarked: false,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessagePart: null,
    threadOriginatorGuid: unit.selectedMessageGuid ?? null,
    threadOriginatorPart: null,
    expressiveSendStyleId: unit.effectId ?? null,
    error: 0,
    itemType: null,
    groupTitle: null,
    groupActionType: null,
    balloonBundleId: null,
    attributedBody: null,
    messageSummaryInfo: null,
    payloadData: null,
    metadata: null,
    attachments: unit.file
      ? [
          {
            guid: unit.tempGuid,
            messageGuid: unit.tempGuid,
            uti: null,
            mimeType: unit.file.type || null,
            transferName: unit.file.name,
            totalBytes: unit.file.size,
            height: null,
            width: null,
            hasLivePhoto: false,
            webUrl: null,
            metadata: null,
          },
        ]
      : [],
  };
}

class OutgoingQueue {
  private queue: SendUnit[] = [];
  private processing = false;
  /** Every unit that hasn't been confirmed yet, including failed ones awaiting retry. */
  private units = new Map<string, SendUnit>();
  /** Temp guids the socket confirmed before their HTTP request finished. */
  private confirmed = new Set<string>();

  enqueue(item: QueueItem) {
    // The server takes one attachment per request and no caption with it, so a
    // message with files becomes one send per file followed by the text.
    const units: SendUnit[] = (item.attachments ?? []).map((file) => ({
      chatGuid: item.chatGuid,
      tempGuid: this.generateTempGuid(),
      text: '',
      file,
    }));
    if (item.text || units.length === 0) {
      units.push({
        chatGuid: item.chatGuid,
        tempGuid: item.tempGuid,
        text: item.text,
        subject: item.subject,
        partIndex: item.partIndex,
        effectId: item.effectId,
      });
    }
    // A reply threads from the first thing sent
    units[0].selectedMessageGuid = item.selectedMessageGuid;

    for (const unit of units) {
      const optimistic = optimisticMessage(unit);
      this.units.set(unit.tempGuid, unit);
      useMessageStore.getState().addPending(unit.chatGuid, optimistic);
      useChatStore
        .getState()
        .updateChatLastMessage(unit.chatGuid, unit.file ? 'Attachment' : unit.text, optimistic.dateCreated, unit.tempGuid);
      this.queue.push(unit);
    }
    void this.processNext();
  }

  /** The local file behind an optimistic attachment, for previewing before it has uploaded. */
  localFile(tempGuid: string): File | undefined {
    return this.units.get(tempGuid)?.file;
  }

  /** The server has stored the message sent as `tempGuid` (reported by the socket). */
  confirm(tempGuid: string) {
    const unit = this.units.get(tempGuid);
    if (!unit) return;
    this.confirmed.add(tempGuid);
    this.units.delete(tempGuid);
    useMessageStore.getState().resolvePending(unit.chatGuid, tempGuid);
  }

  /** Send a failed message again. */
  retry(tempGuid: string) {
    const unit = this.units.get(tempGuid);
    if (!unit || this.queue.includes(unit)) return;
    useMessageStore.getState().updateMessage(unit.chatGuid, tempGuid, { error: 0, dateCreated: Date.now() });
    this.queue.push(unit);
    void this.processNext();
  }

  /** Give up on a failed message and remove its bubble. */
  discard(tempGuid: string) {
    const unit = this.units.get(tempGuid);
    if (!unit) return;
    this.units.delete(tempGuid);
    this.queue = this.queue.filter((u) => u !== unit);
    useMessageStore.getState().resolvePending(unit.chatGuid, tempGuid);
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const unit = this.queue.shift()!;
    try {
      const response = unit.file
        ? await http.sendAttachment(unit.chatGuid, unit.tempGuid, unit.file, {
            selectedMessageGuid: unit.selectedMessageGuid,
          })
        : await http.sendText(unit.chatGuid, unit.tempGuid, unit.text, {
            subject: unit.subject,
            selectedMessageGuid: unit.selectedMessageGuid,
            partIndex: unit.partIndex,
            effectId: unit.effectId,
          });

      const sent = response?.data;
      if (sent?.guid) {
        await ingestMessages([{ ...sent, tempGuid: unit.tempGuid }], { chatGuid: unit.chatGuid });
      }
      this.units.delete(unit.tempGuid);
      useMessageStore.getState().resolvePending(unit.chatGuid, unit.tempGuid);
    } catch (err) {
      // A request can time out after the server has already sent the message;
      // the socket's confirmation settles it either way.
      if (!this.confirmed.has(unit.tempGuid)) {
        console.error('[OutgoingQueue] Send failed:', err);
        useMessageStore.getState().updateMessage(unit.chatGuid, unit.tempGuid, { error: 1 });
      }
    } finally {
      this.confirmed.delete(unit.tempGuid);
      this.processing = false;
      void this.processNext();
    }
  }

  generateTempGuid(): string {
    return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const outgoingQueue = new OutgoingQueue();
