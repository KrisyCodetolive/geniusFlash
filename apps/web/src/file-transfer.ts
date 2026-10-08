import { sha256 } from '@noble/hashes/sha2.js';

export const TRANSFER_ACK_WINDOW = 8;
export const TRANSFER_ACCEPT_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 ** 3;

export type TransferMessage =
  | {
      type: 'init';
      transferId: string;
      fileName: string;
      mimeType: string;
      acceptTimeoutMs: number;
      fileSize: number;
      totalChunks: number;
      hash: string;
    }
  | {
      type: 'chunk';
      transferId: string;
      chunkIndex: number;
      totalChunks: number;
      fileName: string;
      hash: string;
      data: number[];
    }
  | {
      type: 'chunk-header';
      transferId: string;
      chunkIndex: number;
      totalChunks: number;
      fileName: string;
      hash: string;
      byteLength: number;
    }
  | {
      type: 'end';
      transferId: string;
      fileName: string;
      hash: string;
      ok: boolean;
    }
  | {
      type: 'response';
      transferId: string;
      fileName: string;
      accepted: boolean;
    }
  | {
      type: 'cancel';
      transferId: string;
      fileName: string;
      reason?: 'cancelled' | 'expired';
    }
  | {
      type: 'chunk-ack';
      transferId: string;
      chunkIndex: number;
    };

export class FileTransferProtocol {
  // Des chunks binaires de 64 Ko réduisent le nombre de messages sans gonfler le JSON.
  private readonly chunkSize = 64 * 1024;

  public chunk(fileBuffer: ArrayBuffer, customChunkSize = this.chunkSize) {
    const view = new Uint8Array(fileBuffer);
    const chunks: ArrayBuffer[] = [];

    for (let offset = 0; offset < view.length; offset += customChunkSize) {
      const slice = view.slice(offset, offset + customChunkSize);
      chunks.push(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
    }

    return chunks;
  }

  public assemble(chunks: ArrayBuffer[]) {
    const totalLength = chunks.reduce((sum, current) => sum + current.byteLength, 0);
    const output = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      output.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    return output;
  }

  public async computeHash(fileBuffer: ArrayBuffer) {
    // Cette implémentation fonctionne aussi sur une adresse IP locale en HTTP.
    const hashArray = Array.from(sha256(new Uint8Array(fileBuffer)));
    return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  public serializeMessage(message: unknown) {
    return JSON.stringify(message);
  }

  public deserializeMessage(raw: string) {
    return JSON.parse(raw) as Record<string, unknown>;
  }
}
