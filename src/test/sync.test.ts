// Sync engine tests: the guarantees that make chat open instant and gap-free.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { http } from '@/services/http';
import { ingestChats, ingestMessages } from '@/services/ingest';
import { catchUp, loadOlder, openChat, PAGE_SIZE, refreshChats, refreshTail, stopSync } from '@/services/sync';
import { handleNewMessage, handleUpdatedMessage } from '@/services/actionHandler';
import { useChatStore } from '@/stores/chatStore';
import { useMessageStore } from '@/stores/messageStore';
import { FakeServer } from '@/test/fakeServer';

const CHAT = 'iMessage;-;+15550001';
const OTHER_CHAT = 'iMessage;-;+15550002';

let server: FakeServer;

function slice(chatGuid = CHAT) {
  return useMessageStore.getState().slices[chatGuid];
}

function texts(chatGuid = CHAT) {
  return slice(chatGuid).messages.map((m) => m.text);
}

beforeEach(async () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  server = new FakeServer().install();
  stopSync();
  useMessageStore.getState().clear();
  useChatStore.setState({ chats: [], activeChatGuid: null });
  await Promise.all([db.messages.clear(), db.chats.clear(), db.handles.clear(), db.meta.clear()]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Catch-up ──────────────────────────────────────────

describe('catch-up', () => {
  it('starts from the newest message without replaying history', async () => {
    server.addMessages(CHAT, 30);

    await catchUp();

    expect(await db.getMeta('rowCursor')).toBe(30);
    expect(await db.messages.count()).toBe(0);
  });

  it('ingests everything stored since the cursor, across chats', async () => {
    server.addMessages(CHAT, 5);
    await catchUp();

    server.addMessages(CHAT, 3);
    server.addMessages(OTHER_CHAT, 2);
    await catchUp();

    expect(await db.messages.count()).toBe(5);
    expect(await db.getMeta('rowCursor')).toBe(10);

    // Nothing new: nothing changes
    await catchUp();
    expect(await db.messages.count()).toBe(5);
  });

  it('catches a message that arrives late with an old timestamp', async () => {
    const earlier = server.addMessages(CHAT, 5);
    await catchUp();

    // Delivered now, but dated before everything we have already seen
    server.addMessage(CHAT, { guid: 'late', dateCreated: earlier[0].dateCreated - 86_400_000 });
    await catchUp();

    expect(await db.messages.get('late')).toBeDefined();
  });

  it('pages through a backlog larger than one request', async () => {
    server.addMessage(CHAT);
    await catchUp();

    server.addMessages(CHAT, 450);
    await catchUp();

    expect(await db.messages.count()).toBe(450);
    expect(await db.getMeta('rowCursor')).toBe(451);
  });

  it('re-seeds instead of replaying when it has fallen too far behind', async () => {
    server.addMessages(CHAT, 60);
    await catchUp();
    await refreshTail(CHAT);
    expect((await db.chats.get(CHAT))?.syncedFrom).not.toBeNull();

    server.addMessages(CHAT, 4100);
    await catchUp();

    // Coverage is forgotten rather than trusted across a gap we chose not to fill
    expect((await db.chats.get(CHAT))?.syncedFrom).toBeNull();
    expect(await db.getMeta('rowCursor')).toBe(4160);
  });

  it('runs one catch-up at a time', async () => {
    server.addMessage(CHAT);
    await catchUp();
    server.addMessages(CHAT, 3);

    await Promise.all([catchUp(), catchUp(), catchUp()]);

    expect(server.calls.filter((c) => c === 'queryMessages')).toHaveLength(2);
  });
});

// ─── Opening a chat ────────────────────────────────────

describe('opening a chat', () => {
  it('seeds a chat it has never loaded from the server', async () => {
    server.addMessages(CHAT, 120);

    await openChat(CHAT);
    await refreshTail(CHAT);

    expect(slice().messages).toHaveLength(PAGE_SIZE);
    expect(texts().at(-1)).toBe('message 120');
    const chat = await db.chats.get(CHAT);
    expect(chat?.syncedFrom).toBe(slice().messages[0].dateCreated);
    expect(chat?.historyComplete).toBe(false);
  });

  it('shows local messages without waiting for the network', async () => {
    server.addMessages(CHAT, 20);
    await openChat(CHAT);
    await refreshTail(CHAT);
    useMessageStore.getState().clear();
    stopSync();

    // The server never answers
    vi.mocked(http.chatMessages).mockReturnValue(new Promise(() => {}));
    await openChat(CHAT);

    expect(slice().messages).toHaveLength(20);
    expect(texts().at(-1)).toBe('message 20');
  });

  it('leaves the rendered list untouched when the server has nothing new', async () => {
    server.addMessages(CHAT, 20);
    await openChat(CHAT);
    await refreshTail(CHAT);
    const before = slice().messages;

    await refreshTail(CHAT, { force: true });

    // Same array, same objects: nothing for React to re-render
    expect(slice().messages).toBe(before);
  });

  it('only replaces the message that changed when a status update arrives', async () => {
    const sent = server.addMessages(CHAT, 10, { isFromMe: true });
    await openChat(CHAT);
    await refreshTail(CHAT);
    const before = slice().messages;

    server.update(sent[9].guid, { dateDelivered: 123 });
    await refreshTail(CHAT, { force: true });

    const after = slice().messages;
    expect(after[9].dateDelivered).toBe(123);
    expect(after[9]).not.toBe(before[9]);
    for (let i = 0; i < 9; i++) expect(after[i]).toBe(before[i]);
  });

  it('adds messages that arrived while away below what was already shown', async () => {
    server.addMessages(CHAT, 20);
    await openChat(CHAT);
    await refreshTail(CHAT);
    const before = slice().messages;

    server.addMessages(CHAT, 3);
    await refreshTail(CHAT, { force: true });

    expect(slice().messages).toHaveLength(23);
    for (let i = 0; i < 20; i++) expect(slice().messages[i]).toBe(before[i]);
    expect((await db.chats.get(CHAT))?.syncedFrom).toBe(before[0].dateCreated);
  });

  it('does not trust local history across a gap it cannot account for', async () => {
    server.addMessages(CHAT, 30);
    await openChat(CHAT);
    await refreshTail(CHAT);

    // A whole page and more arrives without catch-up having run
    server.addMessages(CHAT, PAGE_SIZE + 20);
    await refreshTail(CHAT, { force: true });

    // Only the fetched page is shown; the older run is not stitched to it
    expect(slice().messages).toHaveLength(PAGE_SIZE);
    expect(texts()[0]).toBe('message 51');
    expect((await db.chats.get(CHAT))?.syncedFrom).toBe(slice().messages[0].dateCreated);

    // Paging back fills the gap from the server
    await loadOlder(CHAT);
    expect(texts()[0]).toBe('message 1');
    expect(slice().messages).toHaveLength(100);
  });

  it('keeps a stray old message out of a chat that has not been seeded', async () => {
    const history = server.addMessages(CHAT, 80);
    await catchUp();
    // Arrives through catch-up, but is dated before all of the chat's real history
    server.addMessage(CHAT, { guid: 'stray', text: 'stray', dateCreated: history[0].dateCreated - 1000 });
    server.addMessage(CHAT, { text: 'fresh' });
    await catchUp();

    await openChat(CHAT);
    await refreshTail(CHAT);

    expect(texts()).not.toContain('stray');
    expect(texts().at(-1)).toBe('fresh');
    expect(slice().messages).toHaveLength(PAGE_SIZE);
  });
});

// ─── History ───────────────────────────────────────────

describe('loading older messages', () => {
  it('pages back to the start of the chat', async () => {
    server.addMessages(CHAT, 130);
    await openChat(CHAT);
    await refreshTail(CHAT);

    await loadOlder(CHAT);
    expect(slice().messages).toHaveLength(100);
    expect(slice().historyComplete).toBe(false);

    await loadOlder(CHAT);
    expect(slice().messages).toHaveLength(130);
    expect(texts()[0]).toBe('message 1');

    // The page that comes back short marks the start
    await loadOlder(CHAT);
    expect(slice().historyComplete).toBe(true);
    expect((await db.chats.get(CHAT))?.historyComplete).toBe(true);
  });

  it('serves history from IndexedDB when it is already covered', async () => {
    server.addMessages(CHAT, 130);
    await openChat(CHAT);
    await refreshTail(CHAT);
    await loadOlder(CHAT);
    await loadOlder(CHAT);

    // Reopen: memory holds only the newest messages again
    useMessageStore.getState().clear();
    await openChat(CHAT);
    const loaded = slice().messages.length;
    expect(loaded).toBeLessThan(130);

    server.calls.length = 0;
    await loadOlder(CHAT);

    expect(slice().messages.length).toBeGreaterThan(loaded);
    expect(server.calls.filter((c) => c.includes('before'))).toHaveLength(0);
  });
});

// ─── Live events ───────────────────────────────────────

describe('live messages', () => {
  it('appends to an open chat and does not mark it unread', async () => {
    server.addMessages(CHAT, 5);
    await refreshChats();
    useChatStore.getState().setActiveChatGuid(CHAT);
    await openChat(CHAT);
    await refreshTail(CHAT);

    await handleNewMessage(server.addMessage(CHAT, { text: 'hello' }));

    expect(texts().at(-1)).toBe('hello');
    const chat = useChatStore.getState().chats.find((c) => c.guid === CHAT);
    expect(chat?.lastMessageText).toBe('hello');
    expect(chat?.hasUnreadMessage).toBe(false);
  });

  it('stores a message for a chat that is not open, and marks the chat unread', async () => {
    server.addMessages(CHAT, 5);
    await refreshChats();

    await handleNewMessage(server.addMessage(CHAT, { text: 'while away' }));

    expect(slice()).toBeUndefined();
    expect((await db.messages.where('chatGuid').equals(CHAT).toArray()).map((m) => m.text)).toEqual(['while away']);
    const stored = await db.chats.get(CHAT);
    expect(stored?.hasUnreadMessage).toBe(true);
    expect(stored?.lastMessageText).toBe('while away');
    // Unread survives a reload because it is persisted, not just held in memory
    expect(useChatStore.getState().chats[0].hasUnreadMessage).toBe(true);
  });

  it('does not mark a chat unread for my own messages or ones already read elsewhere', async () => {
    server.addMessages(CHAT, 2);
    await refreshChats();

    await handleNewMessage(server.addMessage(CHAT, { isFromMe: true }));
    await handleNewMessage(server.addMessage(CHAT, { dateRead: 1_700_000_999_000 }));

    expect((await db.chats.get(CHAT))?.hasUnreadMessage).toBe(false);
  });

  it('adds a conversation the app has never seen', async () => {
    const msg = server.addMessage(OTHER_CHAT, { text: 'new here', handle: '+15550002' });

    await handleNewMessage(msg);
    await vi.waitFor(async () => {
      expect((await db.chats.get(OTHER_CHAT))?.participantHandleAddresses).toEqual(['+15550001']);
    });

    const chat = useChatStore.getState().chats.find((c) => c.guid === OTHER_CHAT);
    expect(chat?.lastMessageText).toBe('new here');
    expect(server.calls).toContain(`singleChat ${OTHER_CHAT}`);
  });

  it('applies delivery and read updates to a loaded message', async () => {
    const sent = server.addMessage(CHAT, { isFromMe: true });
    await openChat(CHAT);
    await refreshTail(CHAT);

    await handleUpdatedMessage(server.update(sent.guid, { dateDelivered: 111, dateRead: 222 }));

    expect(slice().messages[0].dateDelivered).toBe(111);
    expect(slice().messages[0].dateRead).toBe(222);
    expect((await db.messages.get(sent.guid))?.dateRead).toBe(222);
  });

  it('shows a message as unsent when the server reports it retracted', async () => {
    const msg = server.addMessage(CHAT);
    await openChat(CHAT);
    await refreshTail(CHAT);

    await handleUpdatedMessage(server.update(msg.guid, { dateRetracted: 555, text: null }));

    expect(slice().messages[0].dateDeleted).toBe(555);
  });

  it('is not lost when it lands while the chat is being read from IndexedDB', async () => {
    server.addMessages(CHAT, 10);
    await refreshTail(CHAT);

    // Arrives mid-hydration: after the read began, before it reached the store
    const opening = openChat(CHAT);
    const arriving = ingestMessages([server.addMessage(CHAT, { text: 'mid-read' })], { live: true });
    await Promise.all([opening, arriving]);

    expect(texts()).toContain('mid-read');
  });
});

// ─── Ingest merge rules ────────────────────────────────

describe('ingest', () => {
  it('keeps attachments and rich content when a sparser payload arrives for the same message', async () => {
    const full = server.addMessage(CHAT, {
      attributedBody: { rich: true },
      attachments: [{ guid: 'att-1', mimeType: 'image/jpeg', width: 4000, height: 3000 }],
    });
    await ingestMessages([full]);

    // Push-style events omit rich bodies and attachment dimensions
    await ingestMessages([{ ...full, attributedBody: null, attachments: [{ guid: 'att-1', mimeType: 'image/jpeg' }] }]);

    const stored = await db.messages.get(full.guid);
    expect(stored?.attributedBody).toEqual({ rich: true });
    expect(stored?.attachments).toHaveLength(1);
    expect(stored?.attachments?.[0].width).toBe(4000);
  });

  it('stores attachments with their message, in one write', async () => {
    const msg = server.addMessage(CHAT, {
      text: '￼',
      attachments: [{ guid: 'att-2', mimeType: 'image/png', width: 100, height: 50, transferName: 'a.png' }],
    });
    await openChat(CHAT);
    await refreshTail(CHAT);

    const loaded = slice().messages.find((m) => m.guid === msg.guid);
    expect(loaded?.attachments?.[0].guid).toBe('att-2');
    // The placeholder character that stands in for an attachment is not text
    expect(loaded?.text).toBeNull();
    expect((await db.chats.get(CHAT))?.lastMessageText).toBe('Attachment');
  });

  it('keeps pins, unread state and coverage when the chat list is refreshed', async () => {
    server.addMessages(CHAT, 3);
    await refreshChats();
    await refreshTail(CHAT);
    useChatStore.getState().togglePin(CHAT);
    useChatStore.getState().markChatUnread(CHAT);
    await vi.waitFor(async () => expect((await db.chats.get(CHAT))?.isPinned).toBe(true));
    const syncedFrom = (await db.chats.get(CHAT))?.syncedFrom;

    await refreshChats();

    const stored = await db.chats.get(CHAT);
    expect(stored?.isPinned).toBe(true);
    expect(stored?.hasUnreadMessage).toBe(true);
    expect(stored?.syncedFrom).toBe(syncedFrom);
  });

  it('does not let an older chat payload roll the preview back', async () => {
    server.addMessages(CHAT, 2);
    await refreshChats();
    await handleNewMessage(server.addMessage(CHAT, { text: 'newest' }));

    // A list response generated before that message existed
    await ingestChats([{ guid: CHAT, participants: [], lastMessage: { guid: 'old', text: 'old', dateCreated: 5, chats: [{ guid: CHAT }] } }]);

    expect((await db.chats.get(CHAT))?.lastMessageText).toBe('newest');
  });
});
