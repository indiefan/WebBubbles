import { describe, it, expect } from 'vitest';
import { MessageRecord } from '@/lib/db';
import { buildReactionIndex, parseReaction, reactionTarget } from '@/services/reactions';
import { describeGroupEvent } from '@/components/chat/MessageBubble';

let clock = 1000;
function reaction(target: string, type: string | number, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    guid: `r-${clock}`,
    chatGuid: 'chat',
    dateCreated: clock++,
    isFromMe: false,
    handleAddress: '+15550001',
    associatedMessageGuid: target,
    associatedMessageType: type as string,
    text: null,
    error: 0,
    ...overrides,
  } as MessageRecord;
}

describe('reactions', () => {
  it('reads the target out of every form the server uses', () => {
    expect(reactionTarget('ABC')).toBe('ABC');
    expect(reactionTarget('p:0/ABC')).toBe('ABC');
    expect(reactionTarget('bp:ABC')).toBe('ABC');
  });

  it('understands numeric and named reaction types', () => {
    expect(parseReaction(reaction('m', 2000))).toMatchObject({ emoji: '❤️', isRemoval: false });
    expect(parseReaction(reaction('m', '3001'))).toMatchObject({ emoji: '👍', isRemoval: true });
    expect(parseReaction(reaction('m', 'laugh'))).toMatchObject({ emoji: '😂', isRemoval: false });
    expect(parseReaction(reaction('m', '-question'))).toMatchObject({ emoji: '❓', isRemoval: true });
    expect(parseReaction(reaction('m', 2006, { text: 'Reacted 🎉 to “hi”' }))).toMatchObject({ emoji: '🎉' });
    // The same tapback also arrives without the verb, the emoji wrapped in zero-width spaces
    expect(parseReaction(reaction('m', '2006', { text: '\u200B👍\u200B to “hi”' }))).toMatchObject({ emoji: '👍', isRemoval: false });
    expect(parseReaction(reaction('m', 2006, { text: 'Reacted ☺️ to an image' }))).toMatchObject({ emoji: '☺️' });
    expect(parseReaction(reaction('m', 3006, { text: 'Removed 🎉 from “hi”' }))).toMatchObject({ emoji: '🎉', isRemoval: true });
    expect(parseReaction(reaction('m', 1000))).toBeNull();
  });

  it('groups reactions per message and lets a removal cancel an earlier add', () => {
    const index = buildReactionIndex([
      reaction('p:0/msg-1', 'love'),
      reaction('p:0/msg-1', 'love', { handleAddress: '+15550002' }),
      reaction('msg-1', 'like', { isFromMe: true, handleAddress: null }),
      reaction('p:0/msg-2', 'laugh'),
      reaction('p:0/msg-2', '-laugh'),
    ]);

    expect(index.get('msg-1')).toEqual([
      { emoji: '❤️', count: 2, isFromMe: false },
      { emoji: '👍', count: 1, isFromMe: true },
    ]);
    // Added then removed: no badge at all
    expect(index.has('msg-2')).toBe(false);
  });

  it('reuses unchanged badge lists so bubbles are not re-rendered', () => {
    const messages = [reaction('msg-1', 'love'), reaction('msg-2', 'like')];
    const first = buildReactionIndex(messages);
    const second = buildReactionIndex([...messages, reaction('msg-2', 'laugh')], first);

    expect(second.get('msg-1')).toBe(first.get('msg-1'));
    expect(second.get('msg-2')).not.toBe(first.get('msg-2'));
  });
});

describe('group events', () => {
  const event = (fields: Partial<MessageRecord>) => ({ itemType: 0, ...fields }) as MessageRecord;

  it('describes renames, membership changes and photo changes', () => {
    expect(describeGroupEvent(event({ itemType: 2, groupTitle: 'Trip' }), 'Ana')).toBe('Ana named the conversation “Trip”');
    expect(describeGroupEvent(event({ itemType: 1, groupActionType: 0 }), 'You')).toBe('You added someone to the conversation');
    expect(describeGroupEvent(event({ itemType: 3, groupActionType: 0 }), 'Ana')).toBe('Ana left the conversation');
    expect(describeGroupEvent(event({ itemType: 3, groupActionType: 1 }), 'Ana')).toBe('Ana changed the group photo');
  });

  it('leaves ordinary messages alone', () => {
    expect(describeGroupEvent(event({ text: 'hi' }), 'Ana')).toBeNull();
  });
});
