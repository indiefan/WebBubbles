// Tests for contact sync and display name resolution (Phase 1.5).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlueBubblesDB, ContactRecord, HandleRecord, ChatRecord } from '@/lib/db';
import { mockContactData, mockContactsResponse } from '@/test/fixtures';

// We test the contactStore logic by directly exercising the DB + resolution logic,
// since the Zustand store reads from IndexedDB and builds in-memory maps.

describe('Contact Sync & Display Name Resolution', () => {
  let db: BlueBubblesDB;

  beforeEach(async () => {
    db = new BlueBubblesDB(`test-contacts-${Date.now()}`);
    await db.open();
  });

  afterEach(async () => {
    await db.delete();
  });

  // ─── Contact Storage ──────────────────────────────────

  it('can store and retrieve contacts', async () => {
    const contact: ContactRecord = {
      id: 'contact-001',
      displayName: 'Alice Smith',
      phones: ['+11234567890'],
      emails: ['alice@example.com'],
      structuredName: null,
      avatarHash: null,
    };
    await db.contacts.put(contact);

    const retrieved = await db.contacts.get('contact-001');
    expect(retrieved).toBeDefined();
    expect(retrieved!.displayName).toBe('Alice Smith');
    expect(retrieved!.phones).toEqual(['+11234567890']);
    expect(retrieved!.emails).toEqual(['alice@example.com']);
  });

  it('can query contacts by multi-entry phone index', async () => {
    await db.contacts.put({
      id: 'c1',
      displayName: 'Alice',
      phones: ['+11234567890', '+10001112222'],
      emails: [],
      structuredName: null,
      avatarHash: null,
    });

    // Multi-entry index allows querying by any phone in the array
    const byPhone1 = await db.contacts.where('phones').equals('+11234567890').toArray();
    expect(byPhone1).toHaveLength(1);
    expect(byPhone1[0].displayName).toBe('Alice');

    const byPhone2 = await db.contacts.where('phones').equals('+10001112222').toArray();
    expect(byPhone2).toHaveLength(1);
    expect(byPhone2[0].displayName).toBe('Alice');
  });

  it('can query contacts by multi-entry email index', async () => {
    await db.contacts.put({
      id: 'c2',
      displayName: 'Bob',
      phones: [],
      emails: ['bob@example.com', 'bob@work.com'],
      structuredName: null,
      avatarHash: null,
    });

    const byEmail = await db.contacts.where('emails').equals('bob@example.com').toArray();
    expect(byEmail).toHaveLength(1);
    expect(byEmail[0].displayName).toBe('Bob');
  });

  it('can bulk-upsert contacts', async () => {
    const contacts: ContactRecord[] = Array.from({ length: 20 }, (_, i) => ({
      id: `contact-${i}`,
      displayName: `Contact ${i}`,
      phones: [`+1000000000${i}`],
      emails: [`contact${i}@test.com`],
      structuredName: null,
      avatarHash: null,
    }));
    await db.contacts.bulkPut(contacts);
    const count = await db.contacts.count();
    expect(count).toBe(20);
  });

  // ─── Handle-Contact Linking ───────────────────────────

  it('links handles to contacts via contactId', async () => {
    await db.contacts.put({
      id: 'c1',
      displayName: 'Alice Smith',
      phones: ['+11234567890'],
      emails: [],
      structuredName: null,
      avatarHash: null,
    });

    const handle: HandleRecord = {
      address: '+11234567890',
      service: 'iMessage',
      formattedAddress: '(123) 456-7890',
      country: 'US',
      color: null,
      contactId: 'c1', // linked
      originalROWID: null,
    };
    await db.handles.put(handle);

    const h = await db.handles.get('+11234567890');
    expect(h!.contactId).toBe('c1');

    const contact = await db.contacts.get(h!.contactId!);
    expect(contact!.displayName).toBe('Alice Smith');
  });

  // ─── Display Name Resolution Logic ────────────────────

  describe('resolveDisplayName (logic)', () => {
    // Inline the resolution chain to test it directly without Zustand
    function resolveDisplayName(
      address: string | null,
      contacts: Map<string, ContactRecord>,
      handleContactMap: Map<string, string>,
      handles: Map<string, HandleRecord>,
    ): string {
      if (!address) return 'Unknown';
      const contactId = handleContactMap.get(address);
      if (contactId) {
        const contact = contacts.get(contactId);
        if (contact?.displayName) return contact.displayName;
      }
      const handle = handles.get(address);
      if (handle?.formattedAddress) return handle.formattedAddress;
      return address;
    }

    it('returns contact displayName when contact is linked', () => {
      const contacts = new Map([['c1', { id: 'c1', displayName: 'Alice Smith', phones: [], emails: [], structuredName: null, avatarHash: null }]]);
      const handleContactMap = new Map([['+11234567890', 'c1']]);
      const handles = new Map<string, HandleRecord>();

      expect(resolveDisplayName('+11234567890', contacts, handleContactMap, handles)).toBe('Alice Smith');
    });

    it('falls back to formattedAddress when no contact', () => {
      const contacts = new Map<string, ContactRecord>();
      const handleContactMap = new Map<string, string>();
      const handles = new Map<string, HandleRecord>([
        ['+11234567890', { address: '+11234567890', service: 'iMessage', formattedAddress: '(123) 456-7890', country: null, color: null, contactId: null, originalROWID: null }],
      ]);

      expect(resolveDisplayName('+11234567890', contacts, handleContactMap, handles)).toBe('(123) 456-7890');
    });

    it('falls back to raw address when no contact and no formatted address', () => {
      const contacts = new Map<string, ContactRecord>();
      const handleContactMap = new Map<string, string>();
      const handles = new Map<string, HandleRecord>();

      expect(resolveDisplayName('+11234567890', contacts, handleContactMap, handles)).toBe('+11234567890');
    });

    it('returns "Unknown" for null address', () => {
      const contacts = new Map<string, ContactRecord>();
      const handleContactMap = new Map<string, string>();
      const handles = new Map<string, HandleRecord>();

      expect(resolveDisplayName(null, contacts, handleContactMap, handles)).toBe('Unknown');
    });
  });

  // ─── Chat Display Name Resolution ─────────────────────

  describe('resolveChatDisplayName (logic)', () => {
    function resolveDisplayName(
      address: string | null,
      contacts: Map<string, ContactRecord>,
      handleContactMap: Map<string, string>,
    ): string {
      if (!address) return 'Unknown';
      const contactId = handleContactMap.get(address);
      if (contactId) {
        const contact = contacts.get(contactId);
        if (contact?.displayName) return contact.displayName;
      }
      return address;
    }

    function resolveChatDisplayName(
      chat: Partial<ChatRecord>,
      contacts: Map<string, ContactRecord>,
      handleContactMap: Map<string, string>,
    ): string {
      if (chat.displayName) return chat.displayName;
      const participants = (chat as any).participantHandleAddresses ?? [];
      if (participants.length === 0) return chat.chatIdentifier ?? '';
      if (participants.length === 1) return resolveDisplayName(participants[0], contacts, handleContactMap);
      const names = participants.map((a: string) => resolveDisplayName(a, contacts, handleContactMap));
      if (names.length <= 4) return names.join(', ');
      return `${names.slice(0, 3).join(', ')} & ${names.length - 3} more`;
    }

    const contacts = new Map<string, ContactRecord>([
      ['c1', { id: 'c1', displayName: 'Alice', phones: [], emails: [], structuredName: null, avatarHash: null }],
      ['c2', { id: 'c2', displayName: 'Bob', phones: [], emails: [], structuredName: null, avatarHash: null }],
      ['c3', { id: 'c3', displayName: 'Charlie', phones: [], emails: [], structuredName: null, avatarHash: null }],
    ]);
    const handleContactMap = new Map([
      ['+1111', 'c1'],
      ['+2222', 'c2'],
      ['+3333', 'c3'],
    ]);

    it('returns displayName for group chats with a name', () => {
      expect(resolveChatDisplayName(
        { displayName: 'Family Group', participantHandleAddresses: ['+1111', '+2222'] },
        contacts, handleContactMap,
      )).toBe('Family Group');
    });

    it('returns resolved contact name for 1:1 chats', () => {
      expect(resolveChatDisplayName(
        { displayName: null, participantHandleAddresses: ['+1111'] },
        contacts, handleContactMap,
      )).toBe('Alice');
    });

    it('joins resolved names for unnamed group chats', () => {
      expect(resolveChatDisplayName(
        { displayName: null, participantHandleAddresses: ['+1111', '+2222', '+3333'] },
        contacts, handleContactMap,
      )).toBe('Alice, Bob, Charlie');
    });

    it('truncates long participant lists', () => {
      const manyHandles = ['+1111', '+2222', '+3333', '+4444', '+5555'];
      const result = resolveChatDisplayName(
        { displayName: null, participantHandleAddresses: manyHandles },
        contacts, handleContactMap,
      );
      expect(result).toContain('& 2 more');
      expect(result).toContain('Alice');
    });

    it('falls back to chatIdentifier when no participants', () => {
      expect(resolveChatDisplayName(
        { displayName: null, chatIdentifier: '+11234567890', participantHandleAddresses: [] },
        contacts, handleContactMap,
      )).toBe('+11234567890');
    });
  });

  // ─── Contact Data Conversion ──────────────────────────

  it('mockContactData produces correct shape', () => {
    const data = mockContactData();
    expect(data.id).toBe('contact-001');
    expect(data.displayName).toBe('Alice Smith');
    expect(data.phoneNumbers).toHaveLength(1);
    expect(data.emails).toHaveLength(1);
  });

  it('mockContactsResponse returns server-shaped response', () => {
    const res = mockContactsResponse();
    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(2);
    expect(res.data[0].displayName).toBe('Alice Smith');
    expect(res.data[1].displayName).toBe('Bob Jones');
  });
});
