// E2E-style integration tests that exercise the full stack:
// Mock server → HTTP service → Sync → IndexedDB → Zustand stores → ActionHandler

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlueBubblesDB } from '@/lib/db';
import { HttpService } from '@/services/http';
import { serverMessageToRecord, serverChatToRecord } from '@/services/actionHandler';
import { MockServer } from '@/test/mockServer';
import {
  mockPingResponse,
  mockServerInfoResponse,
  mockChatCountResponse,
  mockChatsQueryResponse,
  mockChatMessagesResponse,
  mockSendTextResponse,
  mockMessageData,
  mockChatData,
} from '@/test/fixtures';

describe('Full Sync Integration', () => {
  let db: BlueBubblesDB;
  let httpService: HttpService;
  let mockServer: MockServer;

  beforeEach(async () => {
    db = new BlueBubblesDB(`test-sync-${Date.now()}`);
    await db.open();
    httpService = new HttpService();
    httpService.configure('http://localhost:1234', 'test-pw');
    mockServer = new MockServer();
  });

  afterEach(async () => {
    mockServer.restore();
    await db.delete();
  });

  it('full sync: fetches chats and messages, stores in IndexedDB', async () => {
    // Set up mock server
    mockServer
      .get('/chat/count', () => mockChatCountResponse(3))
      .post('/chat/query', () => mockChatsQueryResponse(3))
      .get('/message', (url) => {
        // Extract chat guid from URL path
        const pathMatch = url.pathname.match(/\/chat\/([^/]+)\/message/);
        const chatGuid = pathMatch ? decodeURIComponent(pathMatch[1]) : 'unknown';
        return mockChatMessagesResponse(chatGuid, 5);
      });
    mockServer.install();

    // Step 1: Fetch chat count
    const countRes = await httpService.chatCount();
    expect(countRes.data.total).toBe(3);

    // Step 2: Fetch chats
    const chatsRes = await httpService.queryChats({ limit: 200 });
    const chats = chatsRes.data;
    expect(chats).toHaveLength(3);

    // Step 3: Store chats in IndexedDB
    const chatRecords = chats.map(serverChatToRecord);
    await db.chats.bulkPut(chatRecords);

    const storedChats = await db.chats.orderBy('lastMessageDate').reverse().toArray();
    expect(storedChats).toHaveLength(3);
    expect(storedChats[0].displayName).toBe('Chat 1'); // most recent

    // Step 4: Fetch messages for each chat
    for (const chat of chatRecords) {
      const msgRes = await httpService.chatMessages(chat.guid, { limit: 5 });
      const messages = (msgRes.data || []).map(serverMessageToRecord);
      await db.messages.bulkPut(messages);
    }

    // Verify total messages stored
    const totalMessages = await db.messages.count();
    expect(totalMessages).toBe(15); // 3 chats × 5 messages

    // Verify we can query messages by chat
    const chat1Messages = await db.messages
      .where('[chatGuid+dateCreated]')
      .between([chatRecords[0].guid, -Infinity], [chatRecords[0].guid, Infinity])
      .toArray();
    expect(chat1Messages).toHaveLength(5);
  });

  it('new message event: updates IndexedDB and can be queried', async () => {
    // Simulate a chat already in DB
    const chatRecord = serverChatToRecord(mockChatData());
    await db.chats.put(chatRecord);

    // Simulate incoming new message event
    const newMsgData = mockMessageData({
      guid: 'new-msg-001',
      text: 'Hey there!',
      isFromMe: false,
      dateCreated: Date.now(),
    });
    const msgRecord = serverMessageToRecord(newMsgData);
    await db.messages.put(msgRecord);

    // Verify it's in the DB
    const stored = await db.messages.get('new-msg-001');
    expect(stored).toBeDefined();
    expect(stored!.text).toBe('Hey there!');
    expect(stored!.chatGuid).toBe('iMessage;-;+11234567890');
  });

  it('outgoing message: temp GUID → real GUID lifecycle', async () => {
    mockServer.post('/message/text', (_url, body) => mockSendTextResponse(body.tempGuid));
    mockServer.install();

    const tempGuid = `temp-${Date.now()}-abc123`;

    // Step 1: Optimistic insert with temp GUID
    const optimistic = serverMessageToRecord(
      mockMessageData({
        guid: tempGuid,
        text: 'Sending...',
        isFromMe: true,
      }),
    );
    await db.messages.put(optimistic);

    // Verify temp message exists
    const tempMsg = await db.messages.get(tempGuid);
    expect(tempMsg).toBeDefined();
    expect(tempMsg!.text).toBe('Sending...');

    // Step 2: Send via API
    const response = await httpService.sendText(
      'iMessage;-;+11234567890',
      tempGuid,
      'Sending...',
    );
    const realGuid = response.data.guid;
    expect(realGuid).toBe(`real-${tempGuid}`);

    // Step 3: Replace temp with real
    await db.messages.delete(tempGuid);
    const realRecord = serverMessageToRecord(response.data);
    await db.messages.put(realRecord);

    // Verify temp is gone, real exists
    const deletedTemp = await db.messages.get(tempGuid);
    expect(deletedTemp).toBeUndefined();

    const realMsg = await db.messages.get(realGuid);
    expect(realMsg).toBeDefined();
  });

  it('incremental sync: fetches only new messages after timestamp', async () => {
    const now = Date.now();
    const lastSync = now - 60000; // 1 minute ago

    mockServer.post('/message/query', (_url, body) => {
      // Verify the after parameter is passed
      expect(body.after).toBe(lastSync);
      return {
        status: 200,
        message: 'Success',
        data: [
          mockMessageData({ guid: 'inc-1', text: 'New msg 1', dateCreated: now - 30000 }),
          mockMessageData({ guid: 'inc-2', text: 'New msg 2', dateCreated: now - 15000 }),
        ],
      };
    });
    mockServer.install();

    const result = await httpService.queryMessages({ after: lastSync, before: now });
    expect(result.data).toHaveLength(2);

    // Store in DB
    const records = result.data.map(serverMessageToRecord);
    await db.messages.bulkPut(records);

    const stored = await db.messages.count();
    expect(stored).toBe(2);
  });

  it('draft persistence: saves and retrieves drafts', async () => {
    await db.drafts.put({
      chatGuid: 'iMessage;-;+11234567890',
      text: 'Half-finished message',
      attachmentPaths: [],
      updatedAt: Date.now(),
    });

    const draft = await db.drafts.get('iMessage;-;+11234567890');
    expect(draft).toBeDefined();
    expect(draft!.text).toBe('Half-finished message');

    // Update draft
    await db.drafts.put({
      chatGuid: 'iMessage;-;+11234567890',
      text: 'Updated draft',
      attachmentPaths: [],
      updatedAt: Date.now(),
    });

    const updated = await db.drafts.get('iMessage;-;+11234567890');
    expect(updated!.text).toBe('Updated draft');

    // Clear draft after send
    await db.drafts.delete('iMessage;-;+11234567890');
    const deleted = await db.drafts.get('iMessage;-;+11234567890');
    expect(deleted).toBeUndefined();
  });

  it('chat list sorting: chats sorted by lastMessageDate DESC', async () => {
    const now = Date.now();
    const chats = [
      serverChatToRecord(mockChatData({ guid: 'old', displayName: 'Old Chat', lastMessage: { guid: 'x', text: 'old', dateCreated: now - 86400000, isFromMe: false } })),
      serverChatToRecord(mockChatData({ guid: 'new', displayName: 'New Chat', lastMessage: { guid: 'y', text: 'new', dateCreated: now, isFromMe: false } })),
      serverChatToRecord(mockChatData({ guid: 'mid', displayName: 'Mid Chat', lastMessage: { guid: 'z', text: 'mid', dateCreated: now - 3600000, isFromMe: false } })),
    ];
    await db.chats.bulkPut(chats);

    const sorted = await db.chats.orderBy('lastMessageDate').reverse().toArray();
    expect(sorted[0].displayName).toBe('New Chat');
    expect(sorted[1].displayName).toBe('Mid Chat');
    expect(sorted[2].displayName).toBe('Old Chat');
  });

  it('handles special characters in chat GUIDs', async () => {
    const weirdGuid = 'iMessage;-;chat908452923751193088;+11234567890';
    const chat = serverChatToRecord(mockChatData({ guid: weirdGuid, displayName: 'Group Chat' }));
    await db.chats.put(chat);

    const retrieved = await db.chats.get(weirdGuid);
    expect(retrieved).toBeDefined();
    expect(retrieved!.displayName).toBe('Group Chat');

    // Verify URL encoding works
    const encoded = encodeURIComponent(weirdGuid);
    const decoded = decodeURIComponent(encoded);
    expect(decoded).toBe(weirdGuid);
  });

  it('handles concurrent message inserts without data loss', async () => {
    // Simulate rapid message inserts like during sync
    const promises = Array.from({ length: 100 }, (_, i) =>
      db.messages.put(
        serverMessageToRecord(
          mockMessageData({
            guid: `concurrent-${i}`,
            text: `Message ${i}`,
            dateCreated: Date.now() - i * 100,
          }),
        ),
      ),
    );

    await Promise.all(promises);
    const count = await db.messages.count();
    expect(count).toBe(100);
  });
});
