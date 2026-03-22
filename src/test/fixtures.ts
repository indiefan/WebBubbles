// Shared test fixtures — mock server API responses

export function mockChatData(overrides: Record<string, any> = {}) {
  return {
    guid: 'iMessage;-;+11234567890',
    chatIdentifier: '+11234567890',
    displayName: 'Test Chat',
    isArchived: false,
    isPinned: false,
    pinIndex: 0,
    hasUnreadMessage: false,
    muteType: null,
    muteArgs: null,
    autoSendReadReceipts: null,
    autoSendTypingIndicators: null,
    title: null,
    style: 45,
    dateDeleted: null,
    customAvatarPath: null,
    participants: [
      { address: '+11234567890', service: 'iMessage' },
    ],
    lastMessage: {
      guid: 'msg-001',
      text: 'Hello world!',
      dateCreated: Date.now() - 60000,
      isFromMe: false,
    },
    ...overrides,
  };
}

export function mockMessageData(overrides: Record<string, any> = {}) {
  return {
    guid: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text: 'Test message',
    dateCreated: Date.now(),
    isFromMe: false,
    hasAttachments: false,
    hasReactions: false,
    isBookmarked: false,
    error: 0,
    itemType: null,
    handle: { address: '+11234567890', service: 'iMessage' },
    chats: [{ guid: 'iMessage;-;+11234567890' }],
    attachments: [],
    ...overrides,
  };
}

export function mockServerResponse(data: any, status = 200, message = 'Success') {
  return { status, message, data };
}

export function mockPingResponse() {
  return mockServerResponse('pong');
}

export function mockServerInfoResponse() {
  return mockServerResponse({
    os_version: '14.0',
    server_version: '1.9.0',
    private_api: true,
    proxy_service: 'ngrok',
    helper_connected: true,
    detected_icloud: 'test@icloud.com',
  });
}

export function mockChatCountResponse(total = 5) {
  return mockServerResponse({ total });
}

export function mockChatsQueryResponse(count = 3) {
  const chats = [];
  for (let i = 0; i < count; i++) {
    chats.push(
      mockChatData({
        guid: `iMessage;-;+1000000000${i}`,
        chatIdentifier: `+1000000000${i}`,
        displayName: `Chat ${i + 1}`,
        participants: [{ address: `+1000000000${i}`, service: 'iMessage' }],
        lastMessage: {
          guid: `msg-last-${i}`,
          text: `Last message in chat ${i + 1}`,
          dateCreated: Date.now() - i * 60000,
          isFromMe: i % 2 === 0,
        },
      }),
    );
  }
  return mockServerResponse(chats);
}

export function mockChatMessagesResponse(chatGuid: string, count = 10) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push(
      mockMessageData({
        guid: `msg-${chatGuid}-${i}`,
        text: `Message ${count - i} in this chat`,
        dateCreated: Date.now() - i * 30000,
        isFromMe: i % 3 === 0,
        chats: [{ guid: chatGuid }],
      }),
    );
  }
  return mockServerResponse(messages);
}

export function mockSendTextResponse(tempGuid: string) {
  return mockServerResponse({
    guid: `real-${tempGuid}`,
    text: 'Sent message',
    dateCreated: Date.now(),
    isFromMe: true,
    hasAttachments: false,
    error: 0,
    chats: [{ guid: 'iMessage;-;+11234567890' }],
  });
}
