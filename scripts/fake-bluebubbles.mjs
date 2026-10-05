#!/usr/bin/env node
// A stand-in BlueBubbles server for developing and testing WebBubbles without
// touching a real iMessage account. It speaks the parts of the REST API and
// socket protocol the app uses, over generated conversations.
//
//   node scripts/fake-bluebubbles.mjs            # http://localhost:4010, password "fake"
//
// Besides the BlueBubbles API it exposes /__control endpoints for scripting
// the situations that are hard to produce on demand:
//
//   POST /__control/incoming      { chatGuid?, text?, count?, silent? }
//        New incoming messages. `silent` stores them without a socket event,
//        which is what a client sees after sleeping through them.
//   POST /__control/status        { guid?, delivered?, read? }   mark an outgoing message
//   POST /__control/drop-sockets  disconnect every client
//   POST /__control/latency       { ms }                         delay every API response
//   POST /__control/helper        { connected }                  connect or drop the Private API helper
//   POST /__control/alert         { type?, message }             add a server alert
//   POST /__control/update        { version | null }             offer (or stop offering) a server update

import http from 'node:http';
import { Server as SocketServer } from 'socket.io';

const PORT = Number(process.env.FAKE_BB_PORT ?? 4010);
const SERVER_VERSION_START = '1.9.9';
const PASSWORD = process.env.FAKE_BB_PASSWORD ?? 'fake';
let latencyMs = Number(process.env.FAKE_BB_LATENCY_MS ?? 120);

// ─── Data ──────────────────────────────────────────────

const messages = [];
const chats = new Map();
let nextRowId = 1;
// History ends "now" so relative times in the sidebar look natural
let clock = Date.now() - 90 * 24 * 3600_000;

function addChat(guid, participants, displayName = '') {
  chats.set(guid, {
    originalROWID: chats.size + 1,
    guid,
    chatIdentifier: guid.split(';').pop(),
    displayName,
    isArchived: false,
    style: participants.length > 1 ? 43 : 45,
    participants: participants.map((address, i) => ({
      originalROWID: i + 1,
      address,
      service: 'iMessage',
      country: 'us',
    })),
  });
  return guid;
}

function addMessage(chatGuid, fields = {}) {
  const rowId = nextRowId++;
  const chat = chats.get(chatGuid);
  const isFromMe = fields.isFromMe ?? false;
  const msg = {
    originalROWID: rowId,
    guid: `fake-msg-${rowId}`,
    text: `Message ${rowId}`,
    subject: null,
    isFromMe,
    dateCreated: fields.dateCreated ?? (clock += 1000),
    dateRead: null,
    dateDelivered: isFromMe ? clock + 2000 : null,
    dateEdited: null,
    dateRetracted: null,
    error: 0,
    itemType: 0,
    groupTitle: null,
    groupActionType: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    threadOriginatorGuid: null,
    attributedBody: null,
    attachments: [],
    handle: isFromMe ? null : { address: fields.from ?? chat.participants[0].address, service: 'iMessage' },
    chats: [{ guid: chatGuid, style: chat.style, chatIdentifier: chat.chatIdentifier, displayName: chat.displayName }],
    ...fields,
  };
  delete msg.from;
  messages.push(msg);
  return msg;
}

function imageAttachment(rowId, width, height) {
  return {
    originalROWID: rowId,
    guid: `fake-att-${rowId}`,
    uti: 'public.png',
    mimeType: 'image/png',
    transferName: `IMG_${1000 + rowId}.png`,
    totalBytes: width * height,
    width,
    height,
    hasLivePhoto: false,
  };
}

const LINES = [
  'Sounds good!', 'On my way', 'Did you see this?', 'lol', 'What time works for you?',
  'I was thinking we could try the new place on 5th, heard the noodles are great. Want to go Thursday?',
  'Yes', 'Can you send me the address?', 'https://example.com/a/fairly/long/link?with=params',
  'Running about ten minutes late, sorry!\nSave me a seat.', 'Perfect 👍', 'Call you later',
];

function seed() {
  const a = addChat('iMessage;-;+15550100', ['+15550100']);
  const group = addChat('iMessage;+;chat900', ['+15550100', '+15550101', '+15550102'], 'Weekend Plans');
  const quiet = addChat('iMessage;-;+15550103', ['+15550103']);

  // A long 1:1 history with photos, replies and reactions
  for (let i = 0; i < 420; i++) {
    clock += 3600_000 * 4.9;
    const isFromMe = i % 3 === 0;
    const msg = addMessage(a, { text: `${LINES[i % LINES.length]} (#${i + 1})`, isFromMe });
    if (i % 17 === 5) {
      msg.text = '￼';
      msg.attachments = [imageAttachment(msg.originalROWID, i % 2 ? 3024 : 4032, i % 2 ? 4032 : 3024)];
    }
    if (i % 23 === 7) {
      addMessage(a, {
        text: `Loved “${msg.text}”`,
        isFromMe: !isFromMe,
        associatedMessageGuid: `p:0/${msg.guid}`,
        associatedMessageType: 'love',
      });
    }
    if (i % 31 === 11) {
      addMessage(a, { text: 'Replying to that', isFromMe: !isFromMe, threadOriginatorGuid: msg.guid });
    }
  }

  for (let i = 0; i < 90; i++) {
    clock += 3600_000;
    const who = ['+15550100', '+15550101', '+15550102'][i % 3];
    addMessage(group, { text: LINES[(i * 5) % LINES.length], isFromMe: i % 4 === 0, from: who });
  }
  addMessage(group, { text: null, itemType: 2, groupTitle: 'Weekend Plans', from: '+15550101' });

  addMessage(quiet, { text: 'Only message in this chat' });

  // Enough conversations to exercise the sidebar
  for (let i = 0; i < 600; i++) {
    const guid = addChat(`iMessage;-;+1555${String(2000 + i)}`, [`+1555${String(2000 + i)}`]);
    addMessage(guid, {
      text: LINES[i % LINES.length],
      isFromMe: i % 2 === 0,
      dateCreated: Date.now() - (i + 2) * 6 * 3600_000,
    });
  }

  // The seeded chats were written first; bring their latest activity to "now"
  clock = Date.now() - 5 * 60_000;
  addMessage(group, { text: 'Anyone free tonight?', from: '+15550102' });
  clock = Date.now() - 60_000;
  addMessage(a, { text: 'See you soon!' });
}

seed();

// ─── Server state ──────────────────────────────────────

const serverState = {
  version: SERVER_VERSION_START,
  helperConnected: true,
  updateVersion: null,
  /** While restarting, the server answers nothing. */
  downUntil: 0,
};
let nextAlertId = 1;
const alerts = [];
function addAlert(type, message, ageMs = 0) {
  alerts.unshift({ id: nextAlertId++, type, value: message, isRead: false, created: new Date(Date.now() - ageMs).toISOString() });
}
addAlert('error', '[UpdateService] Failed to fetch release information from GitHub! Error: getaddrinfo ENOTFOUND api.github.com', 30 * 86400_000);
addAlert('warn', 'Command failed: /usr/bin/sips --setProperty "format" "jpeg" "/Users/fake/Library/Messages/Attachments/22/02/IMG_1234.HEIC"', 3 * 86400_000);
addAlert('info', 'Private API Helper connected', 3600_000);

/** Simulate a restart: drop every connection and answer nothing for `ms`. */
function goDown(ms) {
  setTimeout(() => {
    serverState.downUntil = Date.now() + ms;
    io.disconnectSockets(true);
  }, 1000);
}

const isDown = () => Date.now() < serverState.downUntil;

/**
 * An uncompressed BMP: a gradient that reads as a photo, or (flat) one solid
 * colour like the letter tiles some contact sources generate.
 */
function bitmap(size, hue, flat = false) {
  const rowBytes = Math.ceil((size * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowBytes * size);
  buf.write('BM');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(size, 18);
  buf.writeInt32LE(size, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 54 + y * rowBytes + x * 3;
      buf[i] = flat ? hue : (x * 255) / size; // blue
      buf[i + 1] = flat ? 90 : (y * 255) / size; // green
      buf[i + 2] = flat ? 200 : (hue + x + y) % 256; // red
    }
  }
  return buf;
}

// One person appears in both sources, as on a real server: the Mac's Contacts
// ("api") and the server's own list ("db"), which also holds generated tiles
const CONTACTS = [
  { id: 'A1B2', sourceType: 'api', displayName: 'Ana Rivera', phoneNumbers: [{ address: '+1 (555) 501-00' }, { address: '+15550100' }], emails: [], avatar: bitmap(96, 40) },
  { id: 1, sourceType: 'db', displayName: 'Ana Rivera', phoneNumbers: [{ address: '+15550100' }], emails: [], avatar: bitmap(32, 40) },
  { id: 2, sourceType: 'db', displayName: 'Ben Okafor', phoneNumbers: [{ address: '+15550101' }], emails: [], avatar: bitmap(48, 120, true) },
  { id: 3, sourceType: 'db', displayName: 'Chloe Park', phoneNumbers: [{ address: '+15550102' }], emails: [], avatar: bitmap(64, 200) },
];
const GROUPS_WITH_PHOTO = new Set(['iMessage;+;chat900']);

// ─── Helpers ───────────────────────────────────────────

function lastMessage(chatGuid) {
  let last = null;
  for (const m of messages) {
    if (m.chats[0].guid === chatGuid && (!last || m.dateCreated >= last.dateCreated)) last = m;
  }
  return last;
}

function chatPayload(chat, withLast = true) {
  return withLast ? { ...chat, lastMessage: lastMessage(chat.guid) } : { ...chat };
}

function placeholderImage(att, width) {
  const w = width ? Math.min(width, att.width) : att.width;
  const h = Math.round((w / att.width) * att.height);
  const hue = (att.originalROWID * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="hsl(${hue} 55% 45%)"/>
  <text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="${Math.round(w / 12)}" text-anchor="middle">${att.transferName} · ${w}×${h}</text>
</svg>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ raw });
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── HTTP ──────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ok = (data, extra = {}) => send(200, { status: 200, message: 'Success', data, ...extra });

  // ── Test controls
  if (path.startsWith('/__control/')) {
    const body = await readBody(req);
    if (path === '/__control/helper') {
      serverState.helperConnected = !!body.connected;
      return ok(serverState.helperConnected);
    }
    if (path === '/__control/alert') {
      addAlert(body.type ?? 'error', body.message ?? 'Something went wrong');
      return ok(alerts[0].id);
    }
    if (path === '/__control/update') {
      serverState.updateVersion = body.version ?? null;
      return ok(serverState.updateVersion);
    }
    if (path === '/__control/incoming') {
      const chatGuid = body.chatGuid ?? 'iMessage;-;+15550100';
      const created = [];
      for (let i = 0; i < (body.count ?? 1); i++) {
        clock = Math.max(clock + 1000, Date.now());
        const msg = addMessage(chatGuid, { text: body.text ?? `Incoming ${nextRowId}`, dateCreated: clock });
        created.push(msg.guid);
        if (!body.silent) io.emit('new-message', msg);
      }
      return ok(created);
    }
    if (path === '/__control/status') {
      const msg = body.guid ? messages.find((m) => m.guid === body.guid) : messages.findLast((m) => m.isFromMe);
      if (!msg) return send(404, { status: 404 });
      if (body.delivered) msg.dateDelivered = Date.now();
      if (body.read) msg.dateRead = Date.now();
      io.emit('updated-message', msg);
      return ok(msg.guid);
    }
    if (path === '/__control/drop-sockets') {
      io.disconnectSockets(true);
      return ok('dropped');
    }
    if (path === '/__control/latency') {
      latencyMs = Number(body.ms ?? 0);
      return ok(latencyMs);
    }
    return send(404, { status: 404 });
  }

  if (!path.startsWith('/api/v1/')) return send(404, { status: 404, message: 'Not found' });
  // Mid-restart: nobody home
  if (isDown()) return req.socket.destroy();
  if (url.searchParams.get('guid') !== PASSWORD) {
    return send(401, { status: 401, message: 'You are not authorized to access this resource' });
  }
  await sleep(latencyMs);

  const route = path.slice('/api/v1'.length);
  const chatMatch = route.match(/^\/chat\/([^/]+)(\/.*)?$/);
  const chatGuid = chatMatch ? decodeURIComponent(chatMatch[1]) : null;
  const chatSub = chatMatch?.[2] ?? '';

  if (req.method === 'GET' && route === '/ping') return ok('pong');
  if (req.method === 'GET' && route === '/server/info') {
    return ok({
      computer_id: 'fake@fake-mac',
      os_version: '26.0.1',
      server_version: serverState.version,
      private_api: true,
      helper_connected: serverState.helperConnected,
      proxy_service: 'Dynamic DNS',
    });
  }
  if (req.method === 'GET' && route === '/server/alert') return ok(alerts.slice(0, 10));
  if (req.method === 'POST' && route === '/server/alert/read') {
    const body = await readBody(req);
    if (!body.ids?.length) return send(400, { status: 400, message: 'No alert IDs provided!' });
    for (const alert of alerts) if (body.ids.includes(alert.id)) alert.isRead = true;
    return ok(null);
  }
  if (req.method === 'GET' && route === '/server/update/check') {
    const available = !!serverState.updateVersion;
    return ok({
      available,
      current: serverState.version,
      metadata: available ? { version: serverState.updateVersion, release_name: `v${serverState.updateVersion}` } : null,
    });
  }
  if (req.method === 'POST' && route === '/server/update/install') {
    if (!serverState.updateVersion) {
      return send(400, { status: 400, message: 'No update available!', error: { type: 'Bad Request', message: 'No update available!' } });
    }
    // Download, then install and relaunch on the new version
    const next = serverState.updateVersion;
    setTimeout(() => {
      goDown(6000);
      setTimeout(() => {
        serverState.version = next;
        serverState.updateVersion = null;
      }, 3000);
    }, 3000);
    return ok(null, { message: 'Update has started downloading!' });
  }
  if (req.method === 'POST' && route === '/mac/imessage/restart') {
    // Messages takes a few seconds to come back, and the helper a little longer
    serverState.helperConnected = false;
    await sleep(3000);
    setTimeout(() => {
      serverState.helperConnected = true;
    }, 2000);
    return ok(null, { message: 'Successfully restart the Messages App!' });
  }
  if (req.method === 'GET' && route === '/server/restart/soft') {
    goDown(5000);
    setTimeout(() => {
      serverState.helperConnected = true;
    }, 5500);
    return ok(null, { message: 'Successfully kicked off services restart!' });
  }
  if (req.method === 'GET' && route === '/server/restart/hard') {
    goDown(12000);
    setTimeout(() => {
      serverState.helperConnected = true;
    }, 12500);
    return ok(null, { message: 'Successfully kicked off re-launch process!' });
  }
  if (req.method === 'GET' && route === '/contact') {
    const withAvatars = (url.searchParams.get('extraProperties') ?? '').includes('avatar');
    return ok(CONTACTS.map((c) => ({ ...c, avatar: withAvatars ? c.avatar.toString('base64') : '' })));
  }

  if (req.method === 'POST' && route === '/chat/query') {
    const body = await readBody(req);
    const all = [...chats.values()]
      .map((c) => chatPayload(c))
      .sort((x, y) => (y.lastMessage?.dateCreated ?? 0) - (x.lastMessage?.dateCreated ?? 0));
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 1000;
    return ok(all.slice(offset, offset + limit), { metadata: { total: all.length, offset, limit } });
  }

  if (req.method === 'POST' && route === '/message/query') {
    const body = await readBody(req);
    let rows = messages;
    for (const clause of body.where ?? []) {
      if (clause.statement === 'message.ROWID > :rowId') {
        rows = rows.filter((m) => m.originalROWID > clause.args.rowId);
      } else if (clause.statement.startsWith('message.text LIKE')) {
        const needle = String(Object.values(clause.args)[0]).replace(/%/g, '').toLowerCase();
        rows = rows.filter((m) => m.text?.toLowerCase().includes(needle));
      }
    }
    rows = [...rows].sort((x, y) =>
      body.sort === 'ASC' ? x.dateCreated - y.dateCreated : y.dateCreated - x.dateCreated,
    );
    const offset = body.offset ?? 0;
    const limit = body.limit ?? 100;
    const data = rows.slice(offset, offset + limit);
    return ok(data, { metadata: { offset, limit, total: rows.length, count: data.length } });
  }

  if (chatGuid && chats.has(chatGuid)) {
    if (req.method === 'GET' && chatSub === '') return ok(chatPayload(chats.get(chatGuid)));
    if (req.method === 'GET' && chatSub === '/message') {
      const before = Number(url.searchParams.get('before') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      let rows = messages.filter((m) => m.chats[0].guid === chatGuid);
      if (before) rows = rows.filter((m) => m.dateCreated <= before);
      rows.sort((x, y) => y.dateCreated - x.dateCreated);
      return ok(rows.slice(0, limit));
    }
    if (req.method === 'GET' && chatSub === '/icon') {
      if (!GROUPS_WITH_PHOTO.has(chatGuid)) return send(404, { status: 404 });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(bitmap(96, 170));
    }
    if (req.method === 'POST' && chatSub === '/read') {
      io.emit('chat-read-status-changed', { chatGuid, read: true });
      return ok(null);
    }
  }

  const attachmentMatch = route.match(/^\/attachment\/([^/]+)\/download$/);
  if (req.method === 'GET' && attachmentMatch) {
    const guid = decodeURIComponent(attachmentMatch[1]);
    const att = messages.flatMap((m) => m.attachments).find((x) => x.guid === guid);
    if (!att) return send(404, { status: 404 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(placeholderImage(att, Number(url.searchParams.get('width') ?? 0)));
  }

  if (req.method === 'POST' && route === '/message/text') {
    const body = await readBody(req);
    if (!serverState.helperConnected) {
      return send(500, { status: 500, message: 'Message Send Error', error: { type: 'iMessage Error', message: 'iMessage Private API Helper is not connected!' } });
    }
    if (!chats.has(body.chatGuid)) return send(404, { status: 404, message: 'Chat does not exist!' });
    clock = Math.max(clock + 1000, Date.now());
    const msg = addMessage(body.chatGuid, {
      text: body.message,
      isFromMe: true,
      dateCreated: clock,
      dateDelivered: null,
      threadOriginatorGuid: body.selectedMessageGuid ?? null,
    });
    const echoed = { ...msg, tempGuid: body.tempGuid };
    io.emit('new-message', echoed);
    return ok(echoed);
  }

  if (req.method === 'POST' && route === '/message/attachment') {
    // The multipart body isn't parsed; any upload becomes a generated image
    await readBody(req);
    const chatGuidField = [...chats.keys()][0];
    clock = Math.max(clock + 1000, Date.now());
    const msg = addMessage(chatGuidField, { text: '￼', isFromMe: true, dateCreated: clock, dateDelivered: null });
    msg.attachments = [imageAttachment(msg.originalROWID, 1200, 900)];
    io.emit('new-message', msg);
    return ok(msg);
  }

  if (req.method === 'POST' && route === '/message/react') {
    const body = await readBody(req);
    clock = Math.max(clock + 1000, Date.now());
    const msg = addMessage(body.chatGuid, {
      text: `Reacted to a message`,
      isFromMe: true,
      dateCreated: clock,
      associatedMessageGuid: `p:0/${body.selectedMessageGuid}`,
      associatedMessageType: body.reaction,
    });
    io.emit('new-message', msg);
    return ok(msg);
  }

  const messageAction = route.match(/^\/message\/([^/]+)\/(edit|unsend)$/);
  if (req.method === 'POST' && messageAction) {
    const body = await readBody(req);
    const msg = messages.find((m) => m.guid === decodeURIComponent(messageAction[1]));
    if (!msg) return send(404, { status: 404 });
    if (messageAction[2] === 'edit') {
      msg.text = body.editedMessage;
      msg.dateEdited = Date.now();
    } else {
      msg.text = null;
      msg.dateRetracted = Date.now();
    }
    io.emit('updated-message', msg);
    return ok(msg);
  }

  return send(404, { status: 404, message: `No fake route for ${req.method} ${route}` });
});

// ─── Socket ────────────────────────────────────────────

const io = new SocketServer(server, { cors: { origin: '*' } });
io.use((socket, next) => {
  if (isDown()) next(new Error('Server restarting'));
  else if (socket.handshake.query.guid === PASSWORD) next();
  else next(new Error('Unauthorized'));
});
io.on('connection', (socket) => {
  socket.on('started-typing', () => {});
  socket.on('stopped-typing', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fake BlueBubbles server on http://localhost:${PORT} (password: ${PASSWORD})`);
  console.log(`${chats.size} chats, ${messages.length} messages, ${latencyMs}ms latency`);
});
