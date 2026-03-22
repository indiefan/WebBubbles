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

export const useContactStore = create<ContactState>((set, get) => ({
  contacts: new Map(),
  handleContactMap: new Map(),
  handles: new Map(),
  loaded: false,

  loadContacts: async () => {
    try {
      // Load all contacts
      const allContacts = await db.contacts.toArray();
      const contactsMap = new Map<string, ContactRecord>();
      for (const c of allContacts) {
        contactsMap.set(c.id, c);
      }

      // Load all handles
      const allHandles = await db.handles.toArray();
      const handlesMap = new Map<string, HandleRecord>();
      const handleContactMap = new Map<string, string>();

      for (const h of allHandles) {
        handlesMap.set(h.address, h);
        if (h.contactId) {
          handleContactMap.set(h.address, h.contactId);
        }
      }

      // Also build reverse lookup from contact phones/emails → contact ID
      // so we can resolve handles that weren't linked during sync
      for (const contact of allContacts) {
        for (const phone of contact.phones) {
          // Check if any handle address matches this phone (normalized)
          const normalized = normalizePhone(phone);
          for (const handle of allHandles) {
            const handleNorm = normalizePhone(handle.address);
            if (handleNorm === normalized || handle.address.toLowerCase() === phone.toLowerCase()) {
              if (!handleContactMap.has(handle.address)) {
                handleContactMap.set(handle.address, contact.id);
              }
            }
          }
        }
        for (const email of contact.emails) {
          for (const handle of allHandles) {
            if (handle.address.toLowerCase() === email.toLowerCase()) {
              if (!handleContactMap.has(handle.address)) {
                handleContactMap.set(handle.address, contact.id);
              }
            }
          }
        }
      }

      set({ contacts: contactsMap, handles: handlesMap, handleContactMap, loaded: true });
      console.log(`[ContactStore] Loaded ${contactsMap.size} contacts, ${handlesMap.size} handles, ${handleContactMap.size} mappings`);
    } catch (err) {
      console.error('[ContactStore] Failed to load contacts:', err);
    }
  },

  resolveDisplayName: (handleAddress) => {
    if (!handleAddress) return 'Unknown';

    const { contacts, handleContactMap, handles } = get();

    // 1. Try to find a linked contact
    const contactId = handleContactMap.get(handleAddress);
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
