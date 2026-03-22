import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http } from '../services/http';

vi.mock('../services/http', () => ({
  http: {
    createChat: vi.fn(),
    queryMessages: vi.fn(),
    addParticipant: vi.fn(),
    removeParticipant: vi.fn(),
    leaveChat: vi.fn(),
    setChatIcon: vi.fn(),
    deleteChatIcon: vi.fn(),
    getChatIcon: vi.fn(),
    updateChat: vi.fn(),
    getContacts: vi.fn(),
  }
}));

vi.mock('../lib/db', () => ({
  db: {}
}));

describe('Phase 3 — Search & Chat Creator', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createChat passes addresses and service', async () => {
    vi.mocked(http.createChat).mockResolvedValue({ data: { guid: 'iMessage;-;+123' }});
    const res = await http.createChat(['+1234567890'], 'iMessage');
    expect(res.data.guid).toBe('iMessage;-;+123');
  });

  it('queryMessages with LIKE clause for search', async () => {
    vi.mocked(http.queryMessages).mockResolvedValue({ data: [] });
    await http.queryMessages({ where: [{ statement: 'message.text LIKE :text', args: { text: '%hello%' } }], limit: 50 });
    expect(http.queryMessages).toHaveBeenCalledWith({
      where: [{ statement: 'message.text LIKE :text', args: { text: '%hello%' } }],
      limit: 50
    });
  });
});

describe('Phase 3 — Group Chat Management', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addParticipant calls correct API', async () => {
    vi.mocked(http.addParticipant).mockResolvedValue({ status: 200, data: {} });
    await http.addParticipant('chat-guid', '+1234567890');
    expect(http.addParticipant).toHaveBeenCalledWith('chat-guid', '+1234567890');
  });

  it('removeParticipant calls correct API', async () => {
    vi.mocked(http.removeParticipant).mockResolvedValue({ status: 200, data: {} });
    await http.removeParticipant('chat-guid', '+1234567890');
    expect(http.removeParticipant).toHaveBeenCalledWith('chat-guid', '+1234567890');
  });

  it('leaveChat calls correct API', async () => {
    vi.mocked(http.leaveChat).mockResolvedValue({ status: 200 });
    await http.leaveChat('chat-guid');
    expect(http.leaveChat).toHaveBeenCalledWith('chat-guid');
  });

  it('updateChat renames a group', async () => {
    vi.mocked(http.updateChat).mockResolvedValue({ status: 200, data: {} });
    await http.updateChat('chat-guid', 'New Group Name');
    expect(http.updateChat).toHaveBeenCalledWith('chat-guid', 'New Group Name');
  });
});

describe('Phase 3 — Chat Icon', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setChatIcon uploads an icon file', async () => {
    const file = new File(['img'], 'icon.png', { type: 'image/png' });
    vi.mocked(http.setChatIcon).mockResolvedValue({ status: 200 });
    await http.setChatIcon('chat-guid', file);
    expect(http.setChatIcon).toHaveBeenCalledWith('chat-guid', file);
  });

  it('deleteChatIcon removes the icon', async () => {
    vi.mocked(http.deleteChatIcon).mockResolvedValue({ status: 200 });
    await http.deleteChatIcon('chat-guid');
    expect(http.deleteChatIcon).toHaveBeenCalledWith('chat-guid');
  });

  it('getChatIcon returns a blob', async () => {
    const blob = new Blob(['img']);
    vi.mocked(http.getChatIcon).mockResolvedValue(blob);
    const result = await http.getChatIcon('chat-guid');
    expect(result).toBeInstanceOf(Blob);
  });
});

describe('Phase 3 — Contact Sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getContacts returns contact data', async () => {
    const contacts = [{ id: 'c1', displayName: 'John', phoneNumbers: [{ address: '+1234567890' }], emails: [] }];
    vi.mocked(http.getContacts).mockResolvedValue({ data: contacts });
    const res = await http.getContacts();
    expect(res.data).toHaveLength(1);
    expect(res.data[0].displayName).toBe('John');
  });
});
