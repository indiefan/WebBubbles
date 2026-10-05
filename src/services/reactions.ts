// Tapback handling: turning reaction messages into the badges shown on the
// message they target.

import { MessageRecord } from '@/lib/db';

// iMessage associatedMessageType values → emoji.
// The server may send EITHER numeric codes OR string names.
// Numeric: 2000-range adds a reaction, 3000-range removes it
// String:  "love", "like", ... with a "-" prefix for removal
const REACTION_EMOJI: Record<string, string> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓',
};
const REACTION_NAMES = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];

export interface ReactionGroup {
  emoji: string;
  count: number;
  isFromMe: boolean;
}

export const NO_REACTIONS: ReactionGroup[] = [];

interface ParsedReaction {
  /** Identifies the reaction slot a sender fills: adding and removing use the same base. */
  base: string;
  emoji: string;
  isRemoval: boolean;
}

export function parseReaction(msg: MessageRecord): ParsedReaction | null {
  const raw = msg.associatedMessageType;
  if (raw == null) return null;

  const num = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!isNaN(num)) {
    const isRemoval = num >= 3000;
    const offset = num - (isRemoval ? 3000 : 2000);
    const name = REACTION_NAMES[offset];
    if (name) return { base: name, emoji: REACTION_EMOJI[name], isRemoval };
    // 2006: any-emoji tapback. The emoji itself only appears in the message text.
    if (offset === 6) {
      const emoji = msg.text?.match(/^(?:Reacted|Removed)\s+(\S+)/)?.[1];
      return emoji ? { base: `emoji:${emoji}`, emoji, isRemoval } : null;
    }
    return null;
  }

  const str = String(raw).toLowerCase();
  const isRemoval = str.startsWith('-');
  const name = isRemoval ? str.slice(1) : str;
  return REACTION_EMOJI[name] ? { base: name, emoji: REACTION_EMOJI[name], isRemoval } : null;
}

/** associatedMessageGuid is either "GUID", "p:N/GUID" or "bp:GUID". */
export function reactionTarget(associatedMessageGuid: string): string {
  return associatedMessageGuid.replace(/^(p:\d+\/|bp:)/, '');
}

function groupReactions(reactionMessages: MessageRecord[]): ReactionGroup[] {
  // Net reactions per sender: a later removal cancels an earlier add
  const active = new Map<string, { emoji: string; isFromMe: boolean }>();
  for (const msg of reactionMessages) {
    const parsed = parseReaction(msg);
    if (!parsed) continue;
    const sender = msg.handleAddress || (msg.isFromMe ? '__me__' : '__unknown__');
    const key = `${sender}|${parsed.base}`;
    if (parsed.isRemoval) active.delete(key);
    else active.set(key, { emoji: parsed.emoji, isFromMe: msg.isFromMe });
  }

  const grouped = new Map<string, ReactionGroup>();
  for (const { emoji, isFromMe } of active.values()) {
    const existing = grouped.get(emoji);
    if (existing) {
      existing.count++;
      existing.isFromMe ||= isFromMe;
    } else {
      grouped.set(emoji, { emoji, count: 1, isFromMe });
    }
  }
  return [...grouped.values()];
}

function sameGroups(a: ReactionGroup[], b: ReactionGroup[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].emoji !== b[i].emoji || a[i].count !== b[i].count || a[i].isFromMe !== b[i].isFromMe) return false;
  }
  return true;
}

/**
 * Build the badge list for every message that has reactions.
 *
 * @param messages a chat's messages, oldest first
 * @param prev the previous index; unchanged badge lists are reused from it so
 *   memoized bubbles don't re-render
 */
export function buildReactionIndex(
  messages: MessageRecord[],
  prev?: Map<string, ReactionGroup[]>,
): Map<string, ReactionGroup[]> {
  const byTarget = new Map<string, MessageRecord[]>();
  for (const msg of messages) {
    if (!msg.associatedMessageGuid) continue;
    const target = reactionTarget(msg.associatedMessageGuid);
    const list = byTarget.get(target);
    if (list) list.push(msg);
    else byTarget.set(target, [msg]);
  }

  const index = new Map<string, ReactionGroup[]>();
  for (const [target, reactionMessages] of byTarget) {
    const groups = groupReactions(reactionMessages);
    if (groups.length === 0) continue;
    const before = prev?.get(target);
    index.set(target, before && sameGroups(before, groups) ? before : groups);
  }
  return index;
}
