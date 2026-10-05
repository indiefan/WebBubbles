// ActionHandler — routes incoming socket events to the ingest path and stores.

import { useChatStore } from '@/stores/chatStore';
import { useTypingStore } from '@/stores/typingStore';
import { socketService } from './socket';
import { ingestMessages, refreshChat } from './ingest';
import { chatIconCache } from './chatIconCache';
import { outgoingQueue } from './outgoingQueue';

export { serverMessageToRecord, serverChatToRecord } from './records';

/** Socket payloads arrive either bare or wrapped in `{ data }`. */
function unwrap(rawData: any) {
  return rawData?.data ?? rawData;
}

// ─── Handlers ──────────────────────────────────────────

async function handleNewMessage(rawData: any) {
  const data = unwrap(rawData);
  if (!data?.guid) return;

  const { messages } = await ingestMessages([data], { live: true });
  const msg = messages[0];
  if (!msg) return;

  if (data.tempGuid) outgoingQueue.confirm(data.tempGuid);
  // Whoever was typing has now sent
  if (!msg.isFromMe) useTypingStore.getState().clearTyping(msg.chatGuid);
}

async function handleUpdatedMessage(rawData: any) {
  const data = unwrap(rawData);
  if (!data?.guid) return;
  await ingestMessages([data]);
}

async function handleSendError(rawData: any) {
  const data = unwrap(rawData);
  if (!data?.guid) return;
  await ingestMessages([data]);
  if (data.tempGuid) outgoingQueue.confirm(data.tempGuid);
}

function handleTypingIndicator(rawData: any) {
  const payload = unwrap(rawData);
  const chatGuid = payload?.guid ?? payload?.chatGuid;
  if (!chatGuid) return;

  // The server only reports typing for 1:1 chats and doesn't name the sender
  if (payload?.display ?? true) {
    useTypingStore.getState().setTyping(chatGuid, payload?.handle ?? payload?.senderAddress ?? '');
  } else {
    useTypingStore.getState().clearTyping(chatGuid);
  }
}

function handleChatReadStatus(rawData: any) {
  const payload = unwrap(rawData);
  const chatGuid = payload?.chatGuid ?? payload?.guid;
  if (!chatGuid) return;
  if (payload?.read === false) useChatStore.getState().markChatUnread(chatGuid);
  else useChatStore.getState().markChatRead(chatGuid);
}

/**
 * Renames, membership changes and icon changes arrive as the message that
 * records them. Keep the message for the timeline and re-read the chat itself.
 */
async function handleGroupEvent(rawData: any) {
  const data = unwrap(rawData);
  const chatGuid = data?.chats?.[0]?.guid ?? data?.chatGuid;
  if (data?.guid) await ingestMessages([data], { live: true });
  if (chatGuid) {
    chatIconCache.invalidate(chatGuid);
    await refreshChat(chatGuid);
  }
}

// ─── Registration ──────────────────────────────────────

let registered = false;

export function registerActionHandlers() {
  if (registered) return;
  registered = true;

  socketService.on('new-message', handleNewMessage);
  socketService.on('updated-message', handleUpdatedMessage);
  socketService.on('message-send-error', handleSendError);
  socketService.on('typing-indicator', handleTypingIndicator);
  socketService.on('chat-read-status-changed', handleChatReadStatus);

  for (const event of [
    'group-name-change',
    'group-icon-changed',
    'group-icon-removed',
    'participant-added',
    'participant-removed',
    'participant-left',
  ]) {
    socketService.on(event, handleGroupEvent);
  }
}

export { handleNewMessage, handleUpdatedMessage };
