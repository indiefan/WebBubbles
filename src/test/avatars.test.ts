// Contact photos: which pictures count as photos, and which one a person gets.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { http } from '@/services/http';
import { dominantColorShare, prepareAvatar, sniffImageType } from '@/services/avatars';
import { syncContacts } from '@/services/sync';
import { useContactStore } from '@/stores/contactStore';

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];

/** Base64 of a JPEG-looking payload of the given size (never decoded in these tests). */
function fakeJpeg(bytes: number): string {
  const data = new Uint8Array(bytes);
  data.set(JPEG_HEADER);
  return btoa(String.fromCharCode(...data));
}

function pixels(colors: [number, number, number][]): Uint8ClampedArray {
  return new Uint8ClampedArray(colors.flatMap(([r, g, b]) => [r, g, b, 255]));
}

describe('recognising pictures', () => {
  it('identifies the image formats servers send', () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const jpeg = new Uint8Array([...JPEG_HEADER, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffImageType(webp)).toBe('image/webp');
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(new Uint8Array(12))).toBeNull();
  });

  it('measures how much of a picture is one flat colour', () => {
    const tile = pixels([...Array(9).fill([200, 60, 60]), [255, 255, 255]]);
    const photo = pixels([[10, 20, 30], [200, 180, 90], [60, 120, 240], [90, 90, 90]]);
    expect(dominantColorShare(tile)).toBe(0.9);
    expect(dominantColorShare(photo)).toBe(0.25);
    // Compression noise within one shade still counts as the same colour
    expect(dominantColorShare(pixels([[200, 60, 60], [203, 58, 62]]))).toBe(1);
  });

  it('without image decoding, drops tiny pictures as generated tiles and keeps the rest', async () => {
    expect(await prepareAvatar(fakeJpeg(900))).toBeNull();
    expect(await prepareAvatar(fakeJpeg(9000))).toMatch(/^data:image\/jpeg;base64,/);
    // Pictures the user chose themselves are kept whatever they look like
    expect(await prepareAvatar(fakeJpeg(900), true)).toMatch(/^data:image\/jpeg;base64,/);
    expect(await prepareAvatar('')).toBeNull();
    expect(await prepareAvatar(btoa('not an image at all'))).toBeNull();
  });
});

describe('contact photo sync', () => {
  const small = fakeJpeg(3000);
  const large = fakeJpeg(9000);
  const contacts = (withAvatars: boolean) => [
    { id: 'UUID-1', sourceType: 'api', displayName: 'Ana Rivera', phoneNumbers: [{ address: '+1 (555) 010-0100' }], avatar: withAvatars ? large : '' },
    { id: 1, sourceType: 'db', displayName: 'Ana Rivera', phoneNumbers: [{ address: '+15550100100' }], avatar: withAvatars ? small : '' },
    { id: 2, sourceType: 'db', displayName: 'Ben Okafor', phoneNumbers: [{ address: '+15550100101' }], avatar: withAvatars ? fakeJpeg(700) : '' },
  ];

  beforeEach(async () => {
    await Promise.all([db.contacts.clear(), db.handles.clear(), db.meta.clear()]);
    vi.spyOn(http, 'getContacts').mockImplementation(async (opts = {}) => ({ data: contacts(!!opts.withAvatars) }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stores photos and gives each person the most detailed one', async () => {
    await syncContacts();
    await useContactStore.getState().loadContacts();
    const { resolveAvatar } = useContactStore.getState();

    // Listed twice (Mac contacts and server list): the larger photo wins
    expect(resolveAvatar('+15550100100')).toBe(`data:image/jpeg;base64,${large}`);
    // A generated tile is not a photo
    expect(resolveAvatar('+15550100101')).toBeNull();
    expect(resolveAvatar('+15559999999')).toBeNull();
    expect(resolveAvatar(null)).toBeNull();
  });

  it('keeps contacts from different sources apart even when their ids collide', async () => {
    await syncContacts();
    expect((await db.contacts.toArray()).map((c) => c.id).sort()).toEqual(['api:UUID-1', 'db:1', 'db:2']);
  });

  it('only downloads photos once a day, keeping them in between', async () => {
    await syncContacts();
    expect(http.getContacts).toHaveBeenLastCalledWith({ withAvatars: true });

    await syncContacts();
    expect(http.getContacts).toHaveBeenLastCalledWith({ withAvatars: false });
    expect((await db.contacts.get('api:UUID-1'))?.avatar).toBe(`data:image/jpeg;base64,${large}`);

    vi.useFakeTimers({ now: Date.now() + 25 * 3600_000, toFake: ['Date'] });
    await syncContacts();
    expect(http.getContacts).toHaveBeenLastCalledWith({ withAvatars: true });
  });

  it('removes contacts that no longer exist on the server', async () => {
    await syncContacts();
    vi.mocked(http.getContacts).mockResolvedValue({ data: contacts(false).slice(0, 2) });

    await syncContacts();

    expect(await db.contacts.get('db:2')).toBeUndefined();
    expect(await db.contacts.count()).toBe(2);
  });
});
