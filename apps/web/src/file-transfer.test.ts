import { describe, expect, it } from 'vitest';
import { FileTransferProtocol, MAX_TEXT_BYTES, TRANSFER_ACK_WINDOW, TRANSFER_ACCEPT_TIMEOUT_MS } from './file-transfer';

describe('file transfer protocol', () => {
  it('should split a payload into chunks and verify its hash', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const protocol = new FileTransferProtocol();

    const chunks = protocol.chunk(payload.buffer, 4);

    expect(chunks.length).toBe(3);
    expect(chunks[0].byteLength).toBe(4);
    expect(chunks[2].byteLength).toBe(2);

    const merged = protocol.assemble(chunks);
    expect(merged).toEqual(payload);

    const hash = await protocol.computeHash(payload.buffer);
    expect(hash).toMatch(/^[a-f0-9]{64}$/i);
  });

  it('should encode and decode a file transfer message round trip', () => {
    const protocol = new FileTransferProtocol();
    const payload = { type: 'init', fileName: 'demo.txt', fileSize: 42, totalChunks: 2, hash: 'abc' };

    const message = protocol.serializeMessage(payload);
    const decoded = protocol.deserializeMessage(message);

    expect(decoded).toEqual(payload);
  });

  it('should keep default chunks small enough for mobile data channels', () => {
    const protocol = new FileTransferProtocol();
    const payload = new Uint8Array(64 * 1024 + 1);

    const chunks = protocol.chunk(payload.buffer);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].byteLength).toBe(64 * 1024);
    expect(chunks[1].byteLength).toBe(1);
  });

  it('should preserve transfer decisions and cancellation messages', () => {
    const protocol = new FileTransferProtocol();
    const messages = [
      { type: 'response', fileName: 'photo.jpg', accepted: true },
      { type: 'response', fileName: 'photo.jpg', accepted: false },
      { type: 'cancel', fileName: 'photo.jpg' }
    ];

    for (const message of messages) {
      expect(protocol.deserializeMessage(protocol.serializeMessage(message))).toEqual(message);
    }
  });

  it('should preserve transferId on binary chunk headers and acknowledgements', () => {
    const protocol = new FileTransferProtocol();
    const transferId = 'transfer-test-1';
    const messages = [
      { type: 'chunk-header', transferId, chunkIndex: 0, totalChunks: 1, fileName: 'demo.bin', hash: 'abc', byteLength: 4 },
      { type: 'chunk-ack', transferId, chunkIndex: 0 }
    ];

    for (const message of messages) {
      expect(protocol.deserializeMessage(protocol.serializeMessage(message))).toEqual(message);
    }
  });

  it('should acknowledge chunks in windows instead of one round trip per chunk', () => {
    expect(TRANSFER_ACK_WINDOW).toBe(8);
  });

  it('should allow three minutes for the recipient to accept a transfer', () => {
    expect(TRANSFER_ACCEPT_TIMEOUT_MS).toBe(180_000);
  });

  it('should preserve shared text exactly, including line breaks and accents', () => {
    const protocol = new FileTransferProtocol();
    const messages = [
      { type: 'text', messageId: 'text-1', text: 'Bonjour 👋\nLigne 2 : « éàç » <b>pas du HTML</b>' },
      { type: 'text-ack', messageId: 'text-1' }
    ];

    for (const message of messages) {
      expect(protocol.deserializeMessage(protocol.serializeMessage(message))).toEqual(message);
    }
  });

  it('should keep shared text small enough to fit in a single data channel message', () => {
    const protocol = new FileTransferProtocol();
    const message = protocol.serializeMessage({ type: 'text', messageId: 'text-2', text: 'é'.repeat(MAX_TEXT_BYTES / 2) });

    expect(new TextEncoder().encode(message).byteLength).toBeLessThan(256 * 1024);
  });
});
