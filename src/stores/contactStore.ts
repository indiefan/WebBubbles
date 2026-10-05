// Contact store — provides display name resolution for handles and chats.
// Implements the fallback chain: Contact.displayName → Handle.formattedAddress → raw address.

import { create } from 'zustand';
import { db, ContactRecord, HandleRecord, ChatRecord } from '@/lib/db';

interface ContactState {
  /** All contacts keyed by contact ID */
  contacts: Map<string, ContactRecord>;
  /** Handle address → contact ID lookup */
  handleContactMap: Map<string, string>;
  /** Handle address → HandleRecord lookup */
  handles: Map<string, HandleRecord>;
  /** Normalized phone/email → contact ID, for addresses we hold no handle for */
  addressIndex: Map<string, string>;
  /** Whether contacts have been loaded */
  loaded: boolean;

  /** Load contacts and handles from IndexedDB into memory */
  loadContacts: () => Promise<void>;

  /**
   * Resolve a handle address to a display name.
   * Fallback chain: Contact.displayName → Handle.formattedAddress → raw address
   */
  resolveDisplayName: (handleAddress: string | null) => string;

  /**
   * Resolve the display name for a chat.
   * - Group chats with displayName → use it
   * - 1:1 chats → resolve the single participant
   * - Group chats without displayName → join resolved participant names
   */
  resolveChatDisplayName: (chat: ChatRecord) => string;
}

/**
 * Normalize a phone number to digits-only for comparison.
 */
function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

/**
 * The forms a phone number is indexed under: as written, digits only, and its
 * last ten digits (so "+1 234 567 8901" matches a contact saved without the
 * country code).
 */
function phoneKeys(phone: string): string[] {
  const digits = normalizePhone(phone);
  const keys = [phone.toLowerCase()];
  if (digits) keys.push(digits);
  if (digits.length > 10) keys.push(digits.slice(-10));
  return keys;
}

function lookupAddress(index: Map<string, string>, address: string): string | undefined {
  const exact = index.get(address.toLowerCase());
  if (exact) return exact;
  if (address.includes('@')) return undefined;
  const digits = normalizePhone(address);
  if (!digits) return undefined;
  return index.get(digits) ?? (digits.length >= 10 ? index.get(digits.slice(-10)) : undefined);
}

export const useContactStore = create<ContactState>((set, get) => ({
  contacts: new Map(),
  handleContactMap: new Map(),
  handles: new Map(),
  addressIndex: new Map(),
  loaded: false,

  loadContacts: async () => {
    try {
      const [allContacts, allHandles] = await Promise.all([db.contacts.toArray(), db.handles.toArray()]);

      const contactsMap = new Map<string, ContactRecord>();
      const addressIndex = new Map<string, string>();
      for (const contact of allContacts) {
        contactsMap.set(contact.id, contact);
        for (const phone of contact.phones) {
          for (const key of phoneKeys(phone)) {
            if (!addressIndex.has(key)) addressIndex.set(key, contact.id);
          }
        }
        for (const email of contact.emails) {
          addressIndex.set(email.toLowerCase(), contact.id);
        }
      }

      const handlesMap = new Map<string, HandleRecord>();
      const handleContactMap = new Map<string, string>();
      for (const handle of allHandles) {
        handlesMap.set(handle.address, handle);
        const contactId =
          (handle.contactId && contactsMap.has(handle.contactId) ? handle.contactId : undefined) ??
          lookupAddress(addressIndex, handle.address);
        if (contactId) handleContactMap.set(handle.address, contactId);
      }

      set({ contacts: contactsMap, handles: handlesMap, handleContactMap, addressIndex, loaded: true });
    } catch (err) {
      console.error('[ContactStore] Failed to load contacts:', err);
    }
  },

  resolveDisplayName: (handleAddress) => {
    if (!handleAddress) return 'Unknown';

    const { contacts, handleContactMap, handles, addressIndex } = get();

    // 1. Try to find a linked contact
    const contactId = handleContactMap.get(handleAddress) ?? lookupAddress(addressIndex, handleAddress);
    if (contactId) {
      const contact = contacts.get(contactId);
      if (contact?.displayName) return contact.displayName;
    }

    // 2. Fall back to handle's formattedAddress
    const handle = handles.get(handleAddress);
    if (handle?.formattedAddress) return handle.formattedAddress;

    // 3. Fall back to raw address
    return handleAddress;
  },

  resolveChatDisplayName: (chat) => {
    // If chat has an explicit display name (group name), use it
    if (chat.displayName) return chat.displayName;

    const { resolveDisplayName } = get();
    const participants = chat.participantHandleAddresses ?? [];

    if (participants.length === 0) {
      // No participants — use chatIdentifier
      return chat.chatIdentifier || chat.guid;
    }

    if (participants.length === 1) {
      // 1:1 chat — resolve the single participant
      return resolveDisplayName(participants[0]);
    }

    // Group chat without a name — join resolved participant names
    const names = participants.map((addr) => resolveDisplayName(addr));
    // Limit to first 4 names + "and X more" for long groups
    if (names.length <= 4) {
      return names.join(', ');
    }
    return `${names.slice(0, 3).join(', ')} & ${names.length - 3} more`;
  },
}));
