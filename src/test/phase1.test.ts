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

// ─── Database Tests ────────────────────────────────────

describe('BlueBubblesDB', () => {
  let db: BlueBubblesDB;

  beforeEach(async () => {
    db = new BlueBubblesDB(`test-${Date.now()}`);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  it('creates all tables', () => {
    expect(db.chats).toBeDefined();
    expect(db.messages).toBeDefined();
    expect(db.handles).toBeDefined();
    expect(db.attachments).toBeDefined();
    expect(db.contacts).toBeDefined();
    expect(db.chatParticipants).toBeDefined();
    expect(db.drafts).toBeDefined();
  });

  it('can CRUD chat records', async () => {
    const chat = serverChatToRecord(mockChatData());
    await db.chats.put(chat);

    const retrieved = await db.chats.get(chat.guid);
    expect(retrieved).toBeDefined();
    expect(retrieved!.displayName).toBe('Test Chat');

    await db.chats.update(chat.guid, { displayName: 'Updated' });
    const updated = await db.chats.get(chat.guid);
    expect(updated!.displayName).toBe('Updated');

    await db.chats.delete(chat.guid);
    const deleted = await db.chats.get(chat.guid);
    expect(deleted).toBeUndefined();
  });

  it('can CRUD message records', async () => {
    const msg = serverMessageToRecord(mockMessageData({ guid: 'test-msg-1' }));
    await db.messages.put(msg);

    const retrieved = await db.messages.get('test-msg-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.text).toBe('Test message');
  });

  it('can query messages by compound index [chatGuid+dateCreated]', async () => {
    const chatGuid = 'iMessage;-;+11234567890';
    for (let i = 0; i < 5; i++) {
      const msg = serverMessageToRecord(
        mockMessageData({
          guid: `msg-q-${i}`,
          dateCreated: Date.now() - i * 1000,
          chats: [{ guid: chatGuid }],
        }),
      );
      await db.messages.put(msg);
    }

    const results = await db.messages
      .where('[chatGuid+dateCreated]')
      .between([chatGuid, -Infinity], [chatGuid, Infinity])
      .reverse()
      .toArray();

    expect(results).toHaveLength(5);
    // Should be sorted by dateCreated DESC
    expect(results[0].dateCreated).toBeGreaterThanOrEqual(results[1].dateCreated);
  });

  it('can bulkPut records', async () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      serverMessageToRecord(mockMessageData({ guid: `bulk-${i}` })),
    );
    await db.messages.bulkPut(messages);
    const count = await db.messages.count();
    expect(count).toBe(50);
  });
});

// ─── HTTP Service Tests ────────────────────────────────

describe('HttpService', () => {
  let httpService: HttpService;
  let mockServer: MockServer;

  beforeEach(() => {
    httpService = new HttpService();
    httpService.configure('http://localhost:1234', 'test-password');
    mockServer = new MockServer();
  });

  afterEach(() => {
    mockServer.restore();
  });

  it('ping returns pong', async () => {
    mockServer.get('/ping', () => mockPingResponse());
    mockServer.install();

    const result = await httpService.ping();
    expect(result.data).toBe('pong');
  });

  it('serverInfo returns server metadata', async () => {
    mockServer.get('/server/info', () => mockServerInfoResponse());
    mockServer.install();

    const result = await httpService.serverInfo();
    expect(result.data.server_version).toBe('1.9.0');
    expect(result.data.private_api).toBe(true);
  });

  it('queryChats returns chat list', async () => {
    mockServer.post('/chat/query', () => mockChatsQueryResponse(3));
    mockServer.install();

    const result = await httpService.queryChats();
    expect(result.data).toHaveLength(3);
    expect(result.data[0].displayName).toBe('Chat 1');
  });

  it('chatMessages returns messages for a chat', async () => {
    const chatGuid = 'iMessage;-;+10000000000';
    mockServer.get('/message', () => mockChatMessagesResponse(chatGuid, 10));
    mockServer.install();

    const result = await httpService.chatMessages(chatGuid, { limit: 10 });
    expect(result.data).toHaveLength(10);
  });

  it('chatCount returns total count', async () => {
    mockServer.get('/chat/count', () => mockChatCountResponse(42));
    mockServer.install();

    const result = await httpService.chatCount();
    expect(result.data.total).toBe(42);
  });

  it('sendText sends a message and returns response', async () => {
    mockServer.post('/message/text', (_url, body) => mockSendTextResponse(body?.tempGuid ?? 'temp-1'));
    mockServer.install();

    const result = await httpService.sendText('iMessage;-;+11234567890', 'temp-1', 'Hello!');
    expect(result.data.guid).toBe('real-temp-1');
    expect(result.data.isFromMe).toBe(true);
  });

  it('handles 404 errors', async () => {
    mockServer.install(); // no routes → everything 404s

    await expect(httpService.ping()).rejects.toThrow('HTTP 404');
  });

  it('passes guid query parameter', async () => {
    let capturedUrl: string = '';
    mockServer.get('/ping', (url) => {
      capturedUrl = url.toString();
      return mockPingResponse();
    });
    mockServer.install();

    await httpService.ping();
    expect(capturedUrl).toContain('guid=test-password');
  });
});

// ─── Data Converter Tests ──────────────────────────────

describe('Data Converters', () => {
  it('serverMessageToRecord converts API response correctly', () => {
    const raw = mockMessageData({
      guid: 'test-conv-1',
      text: 'Hello',
      isFromMe: true,
      dateCreated: 1000,
    });
    const record = serverMessageToRecord(raw);

    expect(record.guid).toBe('test-conv-1');
    expect(record.text).toBe('Hello');
    expect(record.isFromMe).toBe(true);
    expect(record.dateCreated).toBe(1000);
    expect(record.chatGuid).toBe('iMessage;-;+11234567890');
    expect(record.handleAddress).toBe('+11234567890');
  });

  it('serverChatToRecord converts API response correctly', () => {
    const raw = mockChatData({ displayName: 'My Chat' });
    const record = serverChatToRecord(raw);

    expect(record.guid).toBe('iMessage;-;+11234567890');
    expect(record.displayName).toBe('My Chat');
    expect(record.participantHandleAddresses).toEqual(['+11234567890']);
    expect(record.lastMessageText).toBe('Hello world!');
  });

  it('handles missing fields gracefully', () => {
    const record = serverMessageToRecord({ guid: 'minimal' });
    expect(record.guid).toBe('minimal');
    expect(record.text).toBeNull();
    expect(record.isFromMe).toBe(false);
    expect(record.chatGuid).toBe('');
    expect(record.error).toBe(0);
  });
});
