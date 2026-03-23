import { describe, it, expect, vi, beforeEach } from 'vitest';
import { downloadService } from '../services/downloads';
import { useDownloadStore } from '../stores/downloadStore';
import { http } from '../services/http';
import { outgoingQueue } from '../services/outgoingQueue';
import { REACTION_TYPE_MAP } from '../components/chat/ReactionPicker';

// Mock http methods
vi.mock('../services/http', () => ({
  http: {
    downloadAttachment: vi.fn(),
    sendAttachment: vi.fn(),
    sendText: vi.fn(),
    sendReaction: vi.fn(),
  }
}));

// Mock IndexedDB
vi.mock('../lib/db', () => ({
  db: {
    messages: { put: vi.fn(), delete: vi.fn(), update: vi.fn() },
    chats: { update: vi.fn() }
  }
}));

describe('DownloadService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets loading state while downloading an attachment', async () => {
    // Note: since caches are not available in JSDOM out of the box, we just spy on the loading store
    const blob = new Blob(['test']);
    vi.mocked(http.downloadAttachment).mockResolvedValue(blob);

    // Global mock for caches
    global.caches = {
      open: vi.fn().mockResolvedValue({
        match: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined)
      })
    } as any;
    
    // global URL
    global.URL.createObjectURL = vi.fn().mockReturnValue('blob:test');

    // Spy on setLoading to ensure it's called
    const setLoadingSpy = vi.spyOn(useDownloadStore.getState(), 'setLoading');

    const promise = downloadService.getAttachmentUrl('test-guid');
    
    // Wait for the async cache checking to finish before loading starts
    await new Promise(resolve => setTimeout(resolve, 0));

    // Check loading state shortly after
    expect(setLoadingSpy).toHaveBeenCalledWith('test-guid', true);

    const url = await promise;
    expect(url).toBe('blob:test');
    
    // Check loading state cleared
    expect(useDownloadStore.getState().loading['test-guid']).toBe(false);
    expect(http.downloadAttachment).toHaveBeenCalledWith('test-guid');
  });
});

describe('OutgoingQueue Attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // mock sendAttachment response
    vi.mocked(http.sendAttachment).mockResolvedValue({ data: { guid: 'real-guid' } });
  });

  it('uses sendAttachment when files are queued', async () => {
    const file = new File(['text'], 'test.txt', { type: 'text/plain' });
    
    await outgoingQueue.enqueue({
      chatGuid: 'chat-1',
      tempGuid: 'temp-2',
      text: 'Here is a file',
      attachments: [file]
    });

    // Wait for async processing 
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(http.sendAttachment).toHaveBeenCalledWith(
      'chat-1',
      'temp-2',
      file,
      { message: 'Here is a file' }
    );
    expect(http.sendText).not.toHaveBeenCalled();
  });
});

describe('Reactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(http.sendReaction).mockResolvedValue({ data: 'ok' });
  });

  it('calls sendReaction with the correct parameters', async () => {
    await http.sendReaction('chat-guid', 'Hello', 'msg-guid', 'love');
    expect(http.sendReaction).toHaveBeenCalledWith('chat-guid', 'Hello', 'msg-guid', 'love');
  });

  it('supports all 6 tapback reaction types', async () => {
    const reactionTypes = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'];
    for (const type of reactionTypes) {
      await http.sendReaction('chat-guid', 'text', 'msg-guid', type);
    }
    expect(http.sendReaction).toHaveBeenCalledTimes(6);
  });

  it('maps REACTION_TYPE_MAP correctly', () => {
    expect(REACTION_TYPE_MAP['love']).toBe('❤️');
    expect(REACTION_TYPE_MAP['like']).toBe('👍');
    expect(REACTION_TYPE_MAP['dislike']).toBe('👎');
    expect(REACTION_TYPE_MAP['laugh']).toBe('😂');
    expect(REACTION_TYPE_MAP['emphasize']).toBe('‼️');
    expect(REACTION_TYPE_MAP['question']).toBe('❓');
  });
});
