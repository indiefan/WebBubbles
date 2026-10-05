import { describe, it, expect } from 'vitest';
import { ChatRecord } from '@/lib/db';
import { orderForRail } from '@/components/chat/ChatRail';

function chat(guid: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return { guid, isPinned: false, pinIndex: 0, lastMessageDate: 0, participantHandleAddresses: [], ...overrides } as ChatRecord;
}

describe('collapsed sidebar order', () => {
  it('puts pinned chats first, in the order they were pinned', () => {
    // As the chat store hands them over: most recent first
    const chats = [
      chat('recent'),
      chat('pinned-second', { isPinned: true, pinIndex: 1 }),
      chat('older'),
      chat('pinned-first', { isPinned: true, pinIndex: 0 }),
      chat('oldest'),
    ];

    const { ordered, pinnedCount } = orderForRail(chats);

    expect(ordered.map((c) => c.guid)).toEqual(['pinned-first', 'pinned-second', 'recent', 'older', 'oldest']);
    expect(pinnedCount).toBe(2);
  });

  it('keeps the given order when nothing is pinned', () => {
    const chats = [chat('a'), chat('b'), chat('c')];
    const { ordered, pinnedCount } = orderForRail(chats);
    expect(ordered.map((c) => c.guid)).toEqual(['a', 'b', 'c']);
    expect(pinnedCount).toBe(0);
  });

  it('leaves the list it was given untouched', () => {
    const chats = [chat('a'), chat('b', { isPinned: true })];
    orderForRail(chats);
    expect(chats.map((c) => c.guid)).toEqual(['a', 'b']);
  });
});
