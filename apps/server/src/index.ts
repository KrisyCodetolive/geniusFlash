import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const webpush = require('web-push') as typeof import('web-push');

export const peerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platform: z.enum(['android', 'ios', 'windows', 'macos', 'linux', 'unknown']),
  status: z.enum(['online', 'offline']).optional(),
  // A hidden device (for example the machine hosting the server) stays reachable but is not shown on the radar.
  hidden: z.boolean().optional()
});

export const signalSchema = z.object({
  type: z.enum(['offer', 'answer', 'candidate', 'request', 'accept', 'reject', 'presence', 'heartbeat']),
  payload: z.any(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
});

const offlineTransferSchema = z.object({
  transferId: z.string().min(1).max(100),
  to: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().nonnegative().max(10 * 1024 ** 3),
  mimeType: z.string().max(200),
  totalChunks: z.number().int().nonnegative(),
  // Le hash est désormais calculé pendant l’envoi : les clients récents ne l’envoient plus ici.
  hash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  expiresInMs: z.number().int().positive().max(3 * 60 * 1000)
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) })
});

export type Peer = z.infer<typeof peerSchema>;
export type SignalMessage = z.infer<typeof signalSchema>;

// Live chat shared by every connected device: messages and files are kept for 24 hours.
export const CHAT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const CHAT_HISTORY_LIMIT = 200;
export const CHAT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const CHAT_MAX_TEXT_LENGTH = 4000;
// Only these formats are shown inline; anything else is downloaded so an uploaded page can never run in the app.
const CHAT_INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const chatTextSchema = z.object({ text: z.string().trim().min(1).max(CHAT_MAX_TEXT_LENGTH) });

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  kind: 'text' | 'file';
  text?: string;
  file?: { id: string; name: string; size: number; mimeType: string };
  createdAt: number;
};

type ChatRow = {
  id: string;
  author_id: string;
  author_name: string;
  kind: 'text' | 'file';
  text: string | null;
  file_id: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  created_at: number;
};

function chatRowToMessage(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    kind: row.kind,
    text: row.text ?? undefined,
    file: row.file_id
      ? { id: row.file_id, name: row.file_name ?? 'fichier', size: row.file_size ?? 0, mimeType: row.mime_type ?? 'application/octet-stream' }
      : undefined,
    createdAt: row.created_at
  };
}

/** Keeps a readable file name without path separators or control characters. */
function sanitizeFileName(value: string) {
  const name = value.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || 'fichier';
}

export function createSignalServer(port = 3001, databasePath = process.env.GENIUSSEND_DB_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), '../data/geniussend.sqlite')) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  // Older GeniusSend versions used a different offline_transfers schema. Those
  // queued requests cannot be resumed by this version, so remove only that
  // obsolete table before creating the current schema. Device and Push data stay intact.
  const existingOfflineTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'offline_transfers'").get();
  if (existingOfflineTable) {
    const columns = database.prepare('PRAGMA table_info(offline_transfers)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['transfer_id', 'sender_id', 'recipient_id', 'payload_json', 'expires_at'];
    if (requiredColumns.some((column) => !columnNames.has(column))) {
      database.exec('DROP TABLE offline_transfers');
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      subscription_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_subscriptions_device_id ON push_subscriptions(device_id);
    CREATE TABLE IF NOT EXISTS offline_transfers (
      transfer_id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS offline_transfers_recipient ON offline_transfers(recipient_id, expires_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      file_id TEXT,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_created_at ON chat_messages(created_at);
    CREATE INDEX IF NOT EXISTS chat_messages_file_id ON chat_messages(file_id);
  `);
  // Chat attachments live next to the database, in the persistent Docker volume.
  const chatFilesDirectory = join(dirname(databasePath), 'chat-files');
  mkdirSync(chatFilesDirectory, { recursive: true });
  // The sender keeps file bytes only in its open tab. Pending requests cannot survive a server restart.
  database.prepare('DELETE FROM offline_transfers').run();
  // Devices unseen for 30 days are forgotten so the table does not grow forever.
  database.prepare('DELETE FROM peers WHERE last_seen < ?').run(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY ?? '';
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY ?? '';
  const vapidSubject = process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com';
  let pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);
  if (pushConfigured) {
    try {
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    } catch (error) {
      pushConfigured = false;
      console.error('[GeniusSend] Invalid VAPID configuration:', error);
    }
  }
  // Socket.IO handles its own path; the other routes are the health check and the chat attachments.
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (url.pathname === '/chat/files' && request.method === 'POST') {
      void handleChatUpload(request, response);
      return;
    }
    const download = /^\/chat\/files\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (download && request.method === 'GET') {
      handleChatDownload(download[1], url.searchParams.has('download'), response);
      return;
    }
    response.writeHead(404).end();
  });
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  const onlineSockets = new Map<string, string>();
  const hiddenPeers = new Set<string>();
  const offlineTransferTimers = new Map<string, NodeJS.Timeout>();

  function chatHistory(): ChatMessage[] {
    const rows = database.prepare('SELECT * FROM chat_messages WHERE created_at > ? ORDER BY created_at DESC LIMIT ?')
      .all(Date.now() - CHAT_RETENTION_MS, CHAT_HISTORY_LIMIT) as ChatRow[];
    return rows.reverse().map(chatRowToMessage);
  }

  function publishChatMessage(message: ChatMessage) {
    database.prepare(`INSERT INTO chat_messages (id, author_id, author_name, kind, text, file_id, file_name, file_size, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(message.id, message.authorId, message.authorName, message.kind, message.text ?? null, message.file?.id ?? null,
        message.file?.name ?? null, message.file?.size ?? null, message.file?.mimeType ?? null, message.createdAt);
    io.emit('chat:message', message);
  }

  /** Deletes messages older than 24 hours, together with their attachments. */
  function purgeChat() {
    const cutoff = Date.now() - CHAT_RETENTION_MS;
    const expiredFiles = database.prepare('SELECT file_id FROM chat_messages WHERE created_at <= ? AND file_id IS NOT NULL').all(cutoff) as Array<{ file_id: string }>;
    for (const { file_id: fileId } of expiredFiles) {
      rmSync(join(chatFilesDirectory, fileId), { force: true });
    }
    database.prepare('DELETE FROM chat_messages WHERE created_at <= ?').run(cutoff);
  }

  /** The uploader must be a device currently connected to the chat. */
  function onlinePeer(deviceId: string) {
    const socketId = onlineSockets.get(deviceId);
    return socketId ? (io.sockets.sockets.get(socketId)?.data.peer as Peer | undefined) : undefined;
  }

  function sendJson(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  // The file body is streamed straight to disk, so large attachments never sit in memory.
  async function handleChatUpload(request: IncomingMessage, response: ServerResponse) {
    const author = onlinePeer(String(request.headers['x-device-id'] ?? ''));
    if (!author) {
      request.resume();
      sendJson(response, 403, { error: 'Open GeniusSend on this device before sharing files in the chat' });
      return;
    }
    if (Number(request.headers['content-length'] ?? 0) > CHAT_MAX_FILE_BYTES) {
      request.resume();
      sendJson(response, 413, { error: 'File too large' });
      return;
    }

    let fileName = 'fichier';
    try {
      fileName = sanitizeFileName(decodeURIComponent(String(request.headers['x-file-name'] ?? '')));
    } catch {
      fileName = 'fichier';
    }
    const mimeType = String(request.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim().slice(0, 100) || 'application/octet-stream';
    const fileId = randomUUID();
    const filePath = join(chatFilesDirectory, fileId);
    let size = 0;

    try {
      await pipeline(
        request,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > CHAT_MAX_FILE_BYTES) throw new Error('too-large');
            yield chunk;
          }
        },
        createWriteStream(filePath)
      );
    } catch (error) {
      rmSync(filePath, { force: true });
      if (!response.headersSent) {
        const tooLarge = (error as Error).message === 'too-large';
        sendJson(response, tooLarge ? 413 : 400, { error: tooLarge ? 'File too large' : 'Upload interrupted' });
      }
      return;
    }

    if (size === 0) {
      rmSync(filePath, { force: true });
      sendJson(response, 400, { error: 'Empty file' });
      return;
    }

    const message: ChatMessage = {
      id: randomUUID(),
      authorId: author.id,
      authorName: author.name,
      kind: 'file',
      file: { id: fileId, name: fileName, size, mimeType },
      createdAt: Date.now()
    };
    publishChatMessage(message);
    sendJson(response, 201, message);
  }

  function handleChatDownload(fileId: string, forceDownload: boolean, response: ServerResponse) {
    const row = database.prepare('SELECT * FROM chat_messages WHERE file_id = ? AND created_at > ?').get(fileId, Date.now() - CHAT_RETENTION_MS) as ChatRow | undefined;
    const filePath = join(chatFilesDirectory, fileId);
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      size = -1;
    }
    if (!row || size < 0) {
      response.writeHead(404).end();
      return;
    }

    const mimeType = row.mime_type ?? 'application/octet-stream';
    const inline = !forceDownload && CHAT_INLINE_IMAGE_TYPES.has(mimeType);
    const name = row.file_name ?? 'fichier';
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    response.writeHead(200, {
      'Content-Type': inline ? mimeType : 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400'
    });
    createReadStream(filePath).pipe(response);
  }

  purgeChat();
  const chatPurgeTimer = setInterval(purgeChat, 10 * 60 * 1000);

  function peerList(): Peer[] {
    const rows = database.prepare('SELECT id, name, platform FROM peers ORDER BY name COLLATE NOCASE').all() as Array<{ id: string; name: string; platform: Peer['platform'] }>;
    return rows
      .filter((peer) => onlineSockets.has(peer.id))
      .map((peer) => ({ ...peer, status: 'online', hidden: hiddenPeers.has(peer.id) }));
  }

  function sanitizePeer(value: unknown): Peer | null {
    const parsed = peerSchema.safeParse(value);
    if (!parsed.success) {
      return null;
    }

    const peer = parsed.data;
    return {
      id: peer.id,
      name: peer.name,
      platform: peer.platform,
      status: peer.status ?? 'online',
      hidden: peer.hidden ?? false
    };
  }

  function emitPeerList(targetSocketId?: string) {
    const list = peerList();

    if (targetSocketId) {
      io.to(targetSocketId).emit('peers:list', list);
      return;
    }

    io.emit('peers:list', list);
  }

  function sendPendingTransfers(deviceId: string, socketId: string) {
    const rows = database.prepare('SELECT payload_json, sender_id, expires_at FROM offline_transfers WHERE recipient_id = ? AND expires_at > ? ORDER BY expires_at').all(deviceId, Date.now()) as Array<{ payload_json: string; sender_id: string; expires_at: number }>;
    for (const row of rows) {
      io.to(socketId).emit('transfer:offline:request', { ...JSON.parse(row.payload_json), from: row.sender_id, expiresAt: row.expires_at });
    }
  }

  function notifyTransferCancelled(transferId: string, senderId: string, recipientId: string, reason: string) {
    const payload = { transferId, reason };
    const recipientSocket = onlineSockets.get(recipientId);
    const senderSocket = onlineSockets.get(senderId);
    if (recipientSocket) io.to(recipientSocket).emit('transfer:offline:cancelled', payload);
    if (senderSocket) io.to(senderSocket).emit('transfer:offline:expired', payload);
  }

  function cancelSenderRequests(senderId: string, reason: string) {
    const requests = database.prepare('SELECT transfer_id, sender_id, recipient_id FROM offline_transfers WHERE sender_id = ?').all(senderId) as Array<{ transfer_id: string; sender_id: string; recipient_id: string }>;
    for (const request of requests) {
      database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(request.transfer_id);
      clearTimeout(offlineTransferTimers.get(request.transfer_id));
      offlineTransferTimers.delete(request.transfer_id);
      notifyTransferCancelled(request.transfer_id, request.sender_id, request.recipient_id, reason);
    }
  }

  async function sendPushToDevice(deviceId: string, payload: Record<string, unknown>) {
    if (!pushConfigured) return false;
    const rows = database.prepare('SELECT endpoint, subscription_json FROM push_subscriptions WHERE device_id = ?').all(deviceId) as Array<{ endpoint: string; subscription_json: string }>;
    let delivered = false;
    await Promise.all(rows.map(async (row) => {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription_json), JSON.stringify(payload), { TTL: 180 });
        delivered = true;
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
        else console.error('[GeniusSend] Push delivery failed:', error);
      }
    }));
    return delivered;
  }

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on('peer:register', (value) => {
      const peer = sanitizePeer(value);

      if (!peer) {
        socket.emit('peer:error', { message: 'Invalid peer payload' });
        return;
      }

      const safePeer: Peer = { ...peer, status: 'online' };
      database.prepare(`INSERT INTO peers (id, name, platform, last_seen) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen`)
        .run(safePeer.id, safePeer.name, safePeer.platform, new Date().toISOString());
      const previousSocket = onlineSockets.get(safePeer.id);
      if (previousSocket && previousSocket !== socket.id) {
        // Tell the replaced tab why it is disconnected so it does not reconnect in a loop.
        io.to(previousSocket).emit('peer:replaced');
        // Without closing the transport, the disconnect packet is queued after the message above.
        io.to(previousSocket).disconnectSockets(false);
      }
      onlineSockets.set(safePeer.id, socket.id);
      if (safePeer.hidden) hiddenPeers.add(safePeer.id);
      else hiddenPeers.delete(safePeer.id);
      socket.data.peer = safePeer;
      emitPeerList();
      socket.emit('peer:registered', { id: safePeer.id, peer: safePeer });
      socket.emit('push:config', { publicKey: vapidPublicKey || null, configured: pushConfigured });
      socket.emit('chat:history', chatHistory());
      sendPendingTransfers(safePeer.id, socket.id);
    });

    socket.on('chat:send', (value) => {
      const author = socket.data.peer as Peer | undefined;
      const parsed = chatTextSchema.safeParse(value);
      if (!author || !parsed.success) {
        socket.emit('chat:error', { message: 'Message invalide' });
        return;
      }
      publishChatMessage({ id: randomUUID(), authorId: author.id, authorName: author.name, kind: 'text', text: parsed.data.text, createdAt: Date.now() });
    });

    socket.on('push:subscribe', (value) => {
      const peer = socket.data.peer as Peer | undefined;
      const parsed = pushSubscriptionSchema.safeParse(value);
      if (!peer || !parsed.success || !pushConfigured) {
        socket.emit('push:subscription-result', { ok: false, message: !pushConfigured ? 'Push is not configured on this server' : 'Invalid push subscription' });
        return;
      }
      database.prepare(`INSERT INTO push_subscriptions (endpoint, device_id, subscription_json) VALUES (?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, subscription_json = excluded.subscription_json`)
        .run(parsed.data.endpoint, peer.id, JSON.stringify(parsed.data));
      socket.emit('push:subscription-result', { ok: true });
    });

    socket.on('push:unsubscribe', (value) => {
      const peer = socket.data.peer as Peer | undefined;
      const endpoint = z.string().url().safeParse(value?.endpoint);
      if (peer && endpoint.success) database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?').run(endpoint.data, peer.id);
    });

    socket.on('transfer:offline:request', async (value) => {
      const sender = socket.data.peer as Peer | undefined;
      const parsed = offlineTransferSchema.safeParse(value);
      if (!sender || !parsed.success || sender.id === parsed.data.to) {
        socket.emit('transfer:offline:error', { transferId: value?.transferId, message: 'Invalid offline transfer request' });
        return;
      }
      database.prepare('DELETE FROM offline_transfers WHERE expires_at <= ?').run(Date.now());
      const recipientRow = database.prepare('SELECT id FROM peers WHERE id = ?').get(parsed.data.to) as { id: string } | undefined;
      if (!recipientRow) {
        socket.emit('transfer:offline:error', { transferId: parsed.data.transferId, message: 'Target device is not registered' });
        return;
      }
      const expiresAt = Date.now() + parsed.data.expiresInMs;
      const payload = { ...parsed.data, to: undefined, from: sender.id, senderName: sender.name, expiresAt };
      database.prepare('INSERT OR REPLACE INTO offline_transfers (transfer_id, sender_id, recipient_id, payload_json, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(parsed.data.transferId, sender.id, parsed.data.to, JSON.stringify(payload), expiresAt);
      clearTimeout(offlineTransferTimers.get(parsed.data.transferId));
      offlineTransferTimers.set(parsed.data.transferId, setTimeout(() => {
        const current = database.prepare('SELECT sender_id, recipient_id FROM offline_transfers WHERE transfer_id = ?').get(parsed.data.transferId) as { sender_id: string; recipient_id: string } | undefined;
        if (!current) return;
        database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(parsed.data.transferId);
        offlineTransferTimers.delete(parsed.data.transferId);
        notifyTransferCancelled(parsed.data.transferId, current.sender_id, current.recipient_id, 'expired');
      }, parsed.data.expiresInMs));
      const recipientSocket = onlineSockets.get(parsed.data.to);
      let pushSent = false;
      if (recipientSocket) {
        io.to(recipientSocket).emit('transfer:offline:request', { ...parsed.data, from: sender.id, senderName: sender.name, expiresAt });
      } else {
        pushSent = await sendPushToDevice(parsed.data.to, { type: 'transfer-request', transferId: parsed.data.transferId, senderName: sender.name, fileName: parsed.data.fileName });
      }
      socket.emit('transfer:offline:queued', { transferId: parsed.data.transferId, expiresAt, pushSent });
    });

    socket.on('transfer:offline:decision', (value) => {
      const recipient = socket.data.peer as Peer | undefined;
      const parsed = z.object({ transferId: z.string().min(1), accepted: z.boolean() }).safeParse(value);
      if (!recipient || !parsed.success) return;
      const row = database.prepare('SELECT sender_id, recipient_id, expires_at FROM offline_transfers WHERE transfer_id = ?').get(parsed.data.transferId) as { sender_id: string; recipient_id: string; expires_at: number } | undefined;
      if (!row || row.recipient_id !== recipient.id) return;
      if (row.expires_at <= Date.now()) {
        database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(parsed.data.transferId);
        clearTimeout(offlineTransferTimers.get(parsed.data.transferId));
        offlineTransferTimers.delete(parsed.data.transferId);
        notifyTransferCancelled(parsed.data.transferId, row.sender_id, row.recipient_id, 'expired');
        return;
      }
      const senderSocket = onlineSockets.get(row.sender_id);
      if (!senderSocket) {
        database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(parsed.data.transferId);
        socket.emit('transfer:offline:cancelled', { transferId: parsed.data.transferId, reason: 'sender-offline' });
        return;
      }
      database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(parsed.data.transferId);
      clearTimeout(offlineTransferTimers.get(parsed.data.transferId));
      offlineTransferTimers.delete(parsed.data.transferId);
      io.to(senderSocket).emit('transfer:offline:decision', { transferId: parsed.data.transferId, from: recipient.id, accepted: parsed.data.accepted });
    });

    socket.on('transfer:offline:cancel', (value) => {
      const sender = socket.data.peer as Peer | undefined;
      const transferId = z.string().min(1).safeParse(value?.transferId);
      if (!sender || !transferId.success) return;
      const row = database.prepare('SELECT sender_id, recipient_id FROM offline_transfers WHERE transfer_id = ?').get(transferId.data) as { sender_id: string; recipient_id: string } | undefined;
      if (row?.sender_id === sender.id) {
        database.prepare('DELETE FROM offline_transfers WHERE transfer_id = ?').run(transferId.data);
        clearTimeout(offlineTransferTimers.get(transferId.data));
        offlineTransferTimers.delete(transferId.data);
        notifyTransferCancelled(transferId.data, sender.id, row.recipient_id, 'cancelled');
      }
    });

    socket.on('peer:heartbeat', () => {
      const current = socket.data.peer as Peer | undefined;
      if (current) {
        database.prepare('UPDATE peers SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), current.id);
        emitPeerList();
      }
    });

    socket.on('peer:unregister', () => {
      const current = socket.data.peer as Peer | undefined;
      if (current && onlineSockets.get(current.id) === socket.id) {
        onlineSockets.delete(current.id);
        hiddenPeers.delete(current.id);
        cancelSenderRequests(current.id, 'sender-disconnected');
        emitPeerList();
      }
      socket.emit('peer:unregistered', { id: current?.id });
    });

    socket.on('signal:message', (value) => {
      const parsed = signalSchema.safeParse(value);
      if (!parsed.success) {
        socket.emit('signal:error', { message: 'Invalid signal payload' });
        return;
      }

      const message = parsed.data;
      const sender = socket.data.peer as Peer | undefined;
      if (!sender) {
        socket.emit('signal:error', { message: 'Register this device before signaling' });
        return;
      }

      const recipient = message.to ? onlineSockets.get(message.to) : undefined;

      if (message.to) {
        if (!recipient) {
          socket.emit('signal:error', { message: 'Target device is offline' });
          return;
        }
        io.to(recipient).emit('signal:message', {
          ...message,
          from: sender.id
        });
        return;
      }

      socket.broadcast.emit('signal:message', {
        ...message,
        from: sender.id
      });
    });

    socket.on('disconnect', () => {
      const current = socket.data.peer as Peer | undefined;
      if (current && onlineSockets.get(current.id) === socket.id) {
        onlineSockets.delete(current.id);
        hiddenPeers.delete(current.id);
        cancelSenderRequests(current.id, 'sender-disconnected');
        emitPeerList();
      }
    });
  });

  return {
    httpServer,
    io,
    start: () =>
      new Promise<void>((resolve) => {
        httpServer.listen(port, () => {
          console.log(`GeniusSend signaling server listening on http://localhost:${port}`);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        const finalize = (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        };

        httpServer.close((error) => {
          if (error) {
            if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
              finalize();
              return;
            }

            finalize(error);
            return;
          }

          io.close(() => {
            clearInterval(chatPurgeTimer);
            for (const timer of offlineTransferTimers.values()) clearTimeout(timer);
            offlineTransferTimers.clear();
            database.close();
            finalize();
          });
        });
      })
  };
}

if (
  process.argv[1]?.includes('index.ts') ||
  process.argv[1]?.includes('index.js') ||
  process.argv[1]?.includes('dist/index.js')
) {
  const PORT = Number(process.env.PORT || 3001);
  const { start } = createSignalServer(PORT);
  start();
}
