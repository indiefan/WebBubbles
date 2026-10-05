// An in-memory stand-in for the BlueBubbles server, covering the query
// semantics the sync engine depends on. Installed by spying on `http`.

import { vi } from 'vitest';
import { http } from '@/services/http';

export interface FakeMessageInput {
  guid?: string;
  text?: string | null;
  isFromMe?: boolean;
  dateCreated?: number;
  handle?: string;
  [key: string]: unknown;
}

export class FakeServer {
  private rows: any[] = [];
  private chats = new Map<string, any>();
  private nextRowId = 1;
  private clock = 1_700_000_000_000;
  /** Every request made, as "method arg" strings, for asserting on network use. */
  calls: string[] = [];

  addChat(guid: string, participants: string[] = ['+15550001'], displayName = '') {
    this.chats.set(guid, {
      guid,
      chatIdentifier: guid.split(';').pop(),
      displayName,
      isArchived: false,
      style: participants.length > 1 ? 43 : 45,
      participants: participants.map((address) => ({ address, service: 'iMessage' })),
    });
    return guid;
  }

  /** Store a message. ROWIDs follow insertion order; dates default to "one minute later". */
  addMessage(chatGuid: string, input: FakeMessageInput = {}) {
    if (!this.chats.has(chatGuid)) this.addChat(chatGuid);
    this.clock += 60_000;
    const rowId = this.nextRowId++;
    const { handle, ...rest } = input;
    const isFromMe = input.isFromMe ?? false;
    const msg = {
      originalROWID: rowId,
      guid: `msg-${rowId}`,
      text: `message ${rowId}`,
      isFromMe,
      dateCreated: this.clock,
      dateRead: null,
      dateDelivered: null,
      error: 0,
      attachments: [],
      handle: isFromMe ? null : { address: handle ?? '+15550001', service: 'iMessage' },
      chats: [{ guid: chatGuid }],
      ...rest,
    };
    this.rows.push(msg);
    return msg;
  }

  addMessages(chatGuid: string, count: number, input: FakeMessageInput = {}) {
    return Array.from({ length: count }, () => this.addMessage(chatGuid, input));
  }

  update(guid: string, changes: Record<string, unknown>) {
    const msg = this.rows.find((m) => m.guid === guid);
    Object.assign(msg, changes);
    return msg;
  }

  private lastMessage(chatGuid: string) {
    return this.rows
      .filter((m) => m.chats[0].guid === chatGuid)
      .sort((a, b) => b.dateCreated - a.dateCreated)[0];
  }

  private chatPayload(chat: any) {
    return { ...chat, lastMessage: this.lastMessage(chat.guid) ?? null };
  }

  install() {
    vi.spyOn(http, 'queryMessages').mockImplementation(async (opts: any = {}) => {
      this.calls.push('queryMessages');
      let rows = [...this.rows];
      for (const clause of opts.where ?? []) {
        if (clause.statement === 'message.ROWID > :rowId') {
          rows = rows.filter((m) => m.originalROWID > clause.args.rowId);
        }
      }
      rows.sort((a, b) => (opts.sort === 'ASC' ? a.dateCreated - b.dateCreated : b.dateCreated - a.dateCreated));
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 100;
      const data = rows.slice(offset, offset + limit).map((m) => ({ ...m }));
      return { status: 200, data, metadata: { offset, limit, total: rows.length, count: data.length } };
    });

    vi.spyOn(http, 'chatMessages').mockImplementation(async (guid: string, opts: any = {}) => {
      this.calls.push(`chatMessages ${guid}${opts.before ? ' before' : ''}`);
      let rows = this.rows.filter((m) => m.chats[0].guid === guid);
      // The server's date bounds are inclusive
      if (opts.before) rows = rows.filter((m) => m.dateCreated <= opts.before);
      rows.sort((a, b) => b.dateCreated - a.dateCreated);
      return { status: 200, data: rows.slice(0, opts.limit ?? 50).map((m) => ({ ...m })) };
    });

    vi.spyOn(http, 'queryChats').mockImplementation(async (opts: any = {}) => {
      this.calls.push('queryChats');
      const all = [...this.chats.values()]
        .map((c) => this.chatPayload(c))
        .sort((a, b) => (b.lastMessage?.dateCreated ?? 0) - (a.lastMessage?.dateCreated ?? 0));
      const offset = opts.offset ?? 0;
      return { status: 200, data: all.slice(offset, offset + (opts.limit ?? 100)) };
    });

    vi.spyOn(http, 'singleChat').mockImplementation(async (guid: string) => {
      this.calls.push(`singleChat ${guid}`);
      const chat = this.chats.get(guid);
      return { status: 200, data: chat ? this.chatPayload(chat) : null };
    });

    return this;
  }
}
