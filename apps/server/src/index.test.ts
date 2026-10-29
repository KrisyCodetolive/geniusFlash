import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSignalServer } from './index.js';

describe('signal server', () => {
  let server: ReturnType<typeof createSignalServer>;
  let clientA: Socket;
  let clientB: Socket;
  let dataDirectory: string;

  beforeAll(async () => {
    dataDirectory = mkdtempSync(join(tmpdir(), 'geniussend-test-'));
    server = createSignalServer(0, join(dataDirectory, 'peers.sqlite'));
    await server.start();

    clientA = createClient(`http://localhost:${(server.httpServer.address() as { port: number }).port}`, {
      transports: ['websocket']
    });

    clientB = createClient(`http://localhost:${(server.httpServer.address() as { port: number }).port}`, {
      transports: ['websocket']
    });

    await Promise.all([clientA, clientB].map((client) => new Promise<void>((resolve) => client.once('connect', resolve))));
    await Promise.all([
      new Promise<void>((resolve) => {
        clientA.once('peer:registered', () => resolve());
        clientA.emit('peer:register', { id: 'device-a', name: 'Android-A', platform: 'android' });
      }),
      new Promise<void>((resolve) => {
        clientB.once('peer:registered', () => resolve());
        clientB.emit('peer:register', { id: 'device-b', name: 'iPhone-B', platform: 'ios' });
      })
    ]);
  });

  afterAll(async () => {
    clientA.close();
    clientB.close();
    await server.close();
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it('registers peers and publishes the list', async () => {
    const peerListA = new Promise((resolve) => {
      clientA.once('peers:list', resolve);
    });

    clientA.emit('peer:register', {
      id: 'device-a',
      name: 'Android-A',
      platform: 'android'
    });

    const payload = (await peerListA) as Array<{ name: string; platform: string }>;
    expect(payload.some((peer) => peer.name === 'Android-A')).toBe(true);
  });

  it('forwards a signal message to the target socket', async () => {
    const received = new Promise((resolve) => {
      clientB.once('signal:message', resolve);
    });

    clientA.emit('signal:message', {
      type: 'offer',
      payload: { sdp: 'abc' },
      from: clientA.id,
      to: 'device-b'
    });

    const message = (await received) as { type: string; payload: { sdp: string } };
    expect(message.type).toBe('offer');
    expect(message.payload.sdp).toBe('abc');
  });

  it('hides disconnected devices while keeping them registered for queued requests', async () => {
    const peerList = new Promise<Array<{ id: string; status: string }>>((resolve) => {
      clientA.once('peers:list', resolve);
    });
    const disconnected = new Promise<void>((resolve) => clientB.once('disconnect', () => resolve()));
    clientB.disconnect();
    await disconnected;
    const payload = await peerList;
    expect(payload.some((peer) => peer.id === 'device-b')).toBe(false);

    const queued = new Promise<{ transferId: string; pushSent: boolean }>((resolve) => clientA.once('transfer:offline:queued', resolve));
    clientA.emit('transfer:offline:request', {
      transferId: 'offline-transfer-1',
      to: 'device-b',
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
      totalChunks: 1,
      hash: 'a'.repeat(64),
      expiresInMs: 60_000
    });
    expect((await queued).transferId).toBe('offline-transfer-1');

    const reconnected = new Promise<void>((resolve) => clientB.once('connect', resolve));
    clientB.connect();
    await reconnected;
    const incomingRequest = new Promise<{ transferId: string; from: string; fileName: string }>((resolve) => clientB.once('transfer:offline:request', resolve));
    clientB.emit('peer:register', { id: 'device-b', name: 'iPhone-B', platform: 'ios' });
    expect(await incomingRequest).toMatchObject({ transferId: 'offline-transfer-1', from: 'device-a', fileName: 'photo.jpg' });

    const decision = new Promise<{ transferId: string; accepted: boolean }>((resolve) => clientA.once('transfer:offline:decision', resolve));
    clientB.emit('transfer:offline:decision', { transferId: 'offline-transfer-1', accepted: true });
    expect(await decision).toMatchObject({ transferId: 'offline-transfer-1', accepted: true });
  });

  it('accepts offline requests without a hash, which is now computed while sending', async () => {
    const queued = new Promise<{ transferId: string }>((resolve) => clientA.once('transfer:offline:queued', resolve));
    clientA.emit('transfer:offline:request', {
      transferId: 'offline-transfer-2',
      to: 'device-b',
      fileName: 'notes.txt',
      fileSize: 10,
      mimeType: 'text/plain',
      totalChunks: 1,
      expiresInMs: 60_000
    });
    expect((await queued).transferId).toBe('offline-transfer-2');
    clientA.emit('transfer:offline:cancel', { transferId: 'offline-transfer-2' });
  });

  it('answers the health check used by Docker and Coolify', async () => {
    const port = (server.httpServer.address() as { port: number }).port;
    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('flags hidden devices so clients can leave them off the radar', async () => {
    const list = new Promise<Array<{ id: string; hidden: boolean }>>((resolve) => clientA.once('peers:list', resolve));
    clientB.emit('peer:register', { id: 'device-b', name: 'iPhone-B', platform: 'ios', hidden: true });
    expect((await list).find((peer) => peer.id === 'device-b')?.hidden).toBe(true);
  });

  it('warns a tab before another tab of the same device replaces it', async () => {
    const port = (server.httpServer.address() as { port: number }).port;
    const clientC = createClient(`http://localhost:${port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => clientC.once('connect', resolve));

    const replaced = new Promise<void>((resolve) => clientA.once('peer:replaced', () => resolve()));
    const disconnected = new Promise<string>((resolve) => clientA.once('disconnect', resolve));
    clientC.emit('peer:register', { id: 'device-a', name: 'Android-A', platform: 'android' });

    await replaced;
    expect(await disconnected).toBe('io server disconnect');
    clientC.close();
  });
});
