// Upgrading a browser that already holds a version-1 database must work
// in place: a failed upgrade would leave the app unable to open its storage.

import { describe, it, expect, afterEach } from 'vitest';
import Dexie from 'dexie';
import { BlueBubblesDB } from '@/lib/db';

const NAME = 'migration-test';

afterEach(async () => {
  await Dexie.delete(NAME);
});

describe('database upgrade from version 1', () => {
  it('keeps chats, drafts and contacts, and rebuilds the message cache', async () => {
    // The schema as shipped up to 0.0.20
    const v1 = new Dexie(NAME);
    v1.version(1).stores({
      chats: 'guid, lastMessageDate, chatIdentifier',
      messages: 'guid, chatGuid, dateCreated, [chatGuid+dateCreated], associatedMessageGuid, threadOriginatorGuid',
      handles: 'address, contactId',
      attachments: 'guid, messageGuid',
      contacts: 'id, displayName, *phones, *emails',
      chatParticipants: '[chatGuid+handleAddress], chatGuid, handleAddress',
      drafts: 'chatGuid',
    });
    await v1.open();
    await v1.table('chats').put({ guid: 'chat-1', lastMessageDate: 5, isPinned: true, pinIndex: 2, participantHandleAddresses: ['+1'] });
    await v1.table('messages').bulkPut([
      { guid: 'm1', chatGuid: 'chat-1', dateCreated: 1, text: 'old cache' },
      { guid: 'temp-123', chatGuid: 'chat-1', dateCreated: 2, text: 'stuck sending' },
    ]);
    await v1.table('attachments').put({ guid: 'a1', messageGuid: 'm1' });
    await v1.table('chatParticipants').put({ chatGuid: 'chat-1', handleAddress: '+1' });
    await v1.table('drafts').put({ chatGuid: 'chat-1', text: 'half-typed', attachmentPaths: [], updatedAt: 1 });
    await v1.table('contacts').put({ id: 'c1', displayName: 'Ana', phones: ['+1'], emails: [] });
    v1.close();

    const db = new BlueBubblesDB(NAME);
    await db.open();

    expect(db.verno).toBe(2);
    // Messages are re-fetched in the new shape; leftover optimistic rows go with them
    expect(await db.messages.count()).toBe(0);

    const chat = await db.chats.get('chat-1');
    expect(chat?.isPinned).toBe(true);
    expect(chat?.pinIndex).toBe(2);
    expect(chat?.syncedFrom).toBeNull();
    expect(chat?.historyComplete).toBe(false);

    expect((await db.drafts.get('chat-1'))?.text).toBe('half-typed');
    expect(await db.contacts.count()).toBe(1);
    expect(db.tables.map((t) => t.name).sort()).toEqual(['chats', 'contacts', 'drafts', 'handles', 'messages', 'meta']);

    await db.setMeta('rowCursor', 42);
    expect(await db.getMeta('rowCursor')).toBe(42);
    db.close();
  });
});
