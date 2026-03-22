// Sync service — full sync (initial) and incremental sync (ongoing).

import { db } from '@/lib/db';
import { http } from './http';
import { useSyncStore } from '@/stores/syncStore';
import { useChatStore } from '@/stores/chatStore';
import { serverChatToRecord, serverMessageToRecord } from './actionHandler';

// ─── Full Sync ─────────────────────────────────────────

export async function runFullSync() {
  const syncStore = useSyncStore.getState();
  syncStore.setStatus('syncing');
  syncStore.setProgress(0, 'Counting chats...');

  try {
    // 1. Get chat count
    const countRes = await http.chatCount();
    const totalChats = countRes?.data?.total ?? 0;
    let processedChats = 0;

    // 2. Fetch chats in pages
    const PAGE_SIZE = 200;
    for (let offset = 0; offset < totalChats || offset === 0; offset += PAGE_SIZE) {
      const chatRes = await http.queryChats({
        withQuery: ['lastmessage', 'participants'],
        sort: 'lastmessage',
        offset,
        limit: PAGE_SIZE,
      });

      const chats = chatRes?.data ?? [];
      if (chats.length === 0) break;

      // Convert and bulk-upsert chats
      const chatRecords = chats.map(serverChatToRecord);
      await db.chats.bulkPut(chatRecords);

      // Upsert participants and handles
      for (const chat of chats) {
        if (chat.participants?.length) {
          for (const p of chat.participants) {
            await db.chatParticipants.put({
              chatGuid: chat.guid,
              handleAddress: p.address,
            });
            await db.handles.put({
              address: p.address,
              service: p.service ?? 'iMessage',
              formattedAddress: p.formattedAddress ?? null,
              country: p.country ?? null,
              color: p.color ?? null,
              contactId: p.contactId ?? null,
              originalROWID: p.originalROWID ?? null,
            });
          }
        }
      }

      processedChats += chats.length;
      const pct = Math.min(50, Math.round((processedChats / Math.max(totalChats, 1)) * 50));
      syncStore.setProgress(pct, `Syncing chats (${processedChats}/${totalChats})...`);
    }

    // Update chat store
    const allChats = await db.chats.orderBy('lastMessageDate').reverse().toArray();
    useChatStore.getState().setChats(allChats);

    // 3. Fetch messages for each chat (recent 25 per chat)
    const chatsToSync = allChats.slice(0, 50); // only recent 50 chats for speed
    let syncedChatMessages = 0;

    for (const chat of chatsToSync) {
      try {
        const msgRes = await http.chatMessages(chat.guid, {
          limit: 25,
          withQuery: 'attachment,handle,message.attributedBody,message.messageSummaryInfo,message.payloadData',
        });

        const messages = msgRes?.data ?? [];
        if (messages.length > 0) {
          const msgRecords = messages.map(serverMessageToRecord);
          await db.messages.bulkPut(msgRecords);

          // Upsert attachments
          for (const msg of messages) {
            if (msg.attachments?.length) {
              for (const att of msg.attachments) {
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
        }
      } catch (err) {
        console.error(`[Sync] Failed to sync messages for ${chat.guid}:`, err);
      }

      syncedChatMessages++;
      const pct = 50 + Math.round((syncedChatMessages / chatsToSync.length) * 50);
      syncStore.setProgress(pct, `Syncing messages (${syncedChatMessages}/${chatsToSync.length} chats)...`);
    }

    // Record sync state
    const now = Date.now();
    syncStore.setLastFullSync(now);
    syncStore.setLastIncrementalSync(now);
    syncStore.setStatus('complete');
    syncStore.setProgress(100, 'Sync complete');

    console.log('[Sync] Full sync complete');
  } catch (err: any) {
    console.error('[Sync] Full sync failed:', err);
    syncStore.setStatus('error');
    syncStore.setProgress(0, `Sync failed: ${err.message}`);
  }
}

// ─── Incremental Sync ──────────────────────────────────

export async function runIncrementalSync() {
  const syncStore = useSyncStore.getState();
  const lastSync = syncStore.lastIncrementalSync;
  if (!lastSync) {
    // Need full sync first
    return runFullSync();
  }

  try {
    const now = Date.now();
    const msgRes = await http.queryMessages({
      withQuery: ['chats', 'chats.participants', 'attachments', 'attributedBody', 'messageSummaryInfo', 'payloadData'],
      sort: 'DESC',
      after: lastSync,
      before: now,
      limit: 1000,
    });

    const messages = msgRes?.data ?? [];
    if (messages.length > 0) {
      const msgRecords = messages.map(serverMessageToRecord);
      await db.messages.bulkPut(msgRecords);

      // Update chats from message data
      const chatGuids = new Set<string>();
      for (const msg of messages) {
        if (msg.chats?.length) {
          for (const chat of msg.chats) {
            if (!chatGuids.has(chat.guid)) {
              chatGuids.add(chat.guid);
              const chatRecord = serverChatToRecord(chat);
              await db.chats.put(chatRecord);
            }
          }
        }
      }

      // Refresh chat store
      const allChats = await db.chats.orderBy('lastMessageDate').reverse().toArray();
      useChatStore.getState().setChats(allChats);
    }

    syncStore.setLastIncrementalSync(now);
    console.log(`[Sync] Incremental sync complete: ${messages.length} messages`);
  } catch (err) {
    console.error('[Sync] Incremental sync failed:', err);
  }
}
