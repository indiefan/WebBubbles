import Dexie, { Table } from 'dexie';

// ─── Interfaces ────────────────────────────────────────────────
export interface ChatRecord {
  guid: string;
  chatIdentifier: string;
  displayName: string | null;
  isArchived: boolean;
  isPinned: boolean;
  pinIndex: number;
  hasUnreadMessage: boolean;
  muteType: string | null;
  muteArgs: string | null;
  autoSendReadReceipts: boolean | null;
  autoSendTypingIndicators: boolean | null;
  title: string | null;
  lastMessageGuid: string | null;
  lastMessageDate: number | null;
  lastMessageText: string | null;
  lastReadMessageGuid: string | null;
  dateDeleted: number | null;
  style: number | null;
  customAvatarPath: string | null;
  participantHandleAddresses: string[];
  // ─── Local-only state (never sent by the server, preserved across refreshes) ───
  /** Every message in this chat dated at or after this is in IndexedDB. Null until first loaded. */
  syncedFrom?: number | null;
  /** True once paging has reached the first message of the chat. */
  historyComplete?: boolean;
  /** When this client last showed the chat to the user. */
  lastReadAt?: number | null;
  /** When the server was last asked whether this group has a photo, and what it said. */
  iconCheckedAt?: number | null;
  hasIcon?: boolean;
}

export interface MessageRecord {
  guid: string;
  chatGuid: string;
  /** Server-side insertion order (chat.db ROWID). Drives the sync cursor. */
  rowId?: number | null;
  /** Set on a confirmed message that replaced an optimistic one, so its React key stays stable. */
  tempGuid?: string;
  handleAddress: string | null;
  text: string | null;
  subject: string | null;
  dateCreated: number;
  dateRead: number | null;
  dateDelivered: number | null;
  dateEdited: number | null;
  dateDeleted: number | null;
  isFromMe: boolean;
  hasAttachments: boolean;
  hasReactions: boolean;
  isBookmarked: boolean;
  associatedMessageGuid: string | null;
  associatedMessageType: string | null;
  associatedMessagePart: string | null;
  threadOriginatorGuid: string | null;
  threadOriginatorPart: string | null;
  expressiveSendStyleId: string | null;
  error: number;
  itemType: number | null;
  groupTitle: string | null;
  groupActionType: number | null;
  balloonBundleId: string | null;
  attributedBody: object | null;
  messageSummaryInfo: object | null;
  payloadData: object | null;
  metadata: object | null;
  /** Attachments travel with the message so rendering never needs a second lookup. */
  attachments?: AttachmentRecord[];
}

export interface HandleRecord {
  address: string;
  service: string;
  formattedAddress: string | null;
  country: string | null;
  color: string | null;
  contactId: string | null;
  originalROWID: number | null;
}

export interface AttachmentRecord {
  guid: string;
  messageGuid: string;
  uti: string | null;
  mimeType: string | null;
  transferName: string | null;
  totalBytes: number | null;
  height: number | null;
  width: number | null;
  hasLivePhoto: boolean;
  webUrl: string | null;
  metadata: object | null;
}

export interface ContactRecord {
  id: string;
  displayName: string;
  phones: string[];
  emails: string[];
  structuredName: object | null;
  avatarHash: string | null;
  /** The contact's photo as a data URL, when they have a real one. */
  avatar?: string | null;
}

export interface DraftRecord {
  chatGuid: string;
  text: string;
  attachmentPaths: string[];
  updatedAt: number;
}

export interface MetaRecord {
  key: string;
  value: unknown;
}

// ─── Database Class ────────────────────────────────────────────
export class BlueBubblesDB extends Dexie {
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  handles!: Table<HandleRecord, string>;
  contacts!: Table<ContactRecord, string>;
  drafts!: Table<DraftRecord, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name = 'WebBubbles') {
    super(name);
    this.version(1).stores({
      chats: 'guid, lastMessageDate, chatIdentifier',
      messages: 'guid, chatGuid, dateCreated, [chatGuid+dateCreated], associatedMessageGuid, threadOriginatorGuid',
      handles: 'address, contactId',
      attachments: 'guid, messageGuid',
      contacts: 'id, displayName, *phones, *emails',
      chatParticipants: '[chatGuid+handleAddress], chatGuid, handleAddress',
      drafts: 'chatGuid',
    });

    // v2: attachments are embedded in their message, and messages carry the
    // server ROWID. The message cache is rebuilt from the server rather than
    // migrated; chats, contacts and drafts are kept.
    this.version(2)
      .stores({
        attachments: null,
        chatParticipants: null,
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx.table('messages').clear();
        await tx.table('chats').toCollection().modify((chat) => {
          chat.syncedFrom = null;
          chat.historyComplete = false;
        });
      });
  }

  /** Read a value from the key/value meta table. */
  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.meta.get(key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.meta.put({ key, value });
  }
}

export const db = new BlueBubblesDB();
