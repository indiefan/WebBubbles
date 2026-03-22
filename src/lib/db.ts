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
}

export interface MessageRecord {
  guid: string;
  chatGuid: string;
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
}

export interface ChatParticipantRecord {
  chatGuid: string;
  handleAddress: string;
}

export interface DraftRecord {
  chatGuid: string;
  text: string;
  attachmentPaths: string[];
  updatedAt: number;
}

// ─── Database Class ────────────────────────────────────────────
export class BlueBubblesDB extends Dexie {
  chats!: Table<ChatRecord, string>;
  messages!: Table<MessageRecord, string>;
  handles!: Table<HandleRecord, string>;
  attachments!: Table<AttachmentRecord, string>;
  contacts!: Table<ContactRecord, string>;
  chatParticipants!: Table<ChatParticipantRecord>;
  drafts!: Table<DraftRecord, string>;

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
  }
}

export const db = new BlueBubblesDB();
