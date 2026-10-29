import { sha256 } from '@noble/hashes/sha2.js';

// Des chunks binaires de 64 Ko réduisent le nombre de messages et passent sur les data channels mobiles.
export const CHUNK_SIZE_BYTES = 64 * 1024;
export const TRANSFER_ACK_WINDOW = 8;
export const TRANSFER_ACCEPT_TIMEOUT_MS = 3 * 60 * 1000;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 ** 3;
// Un texte part en un seul message : on reste sous la taille maximale des messages WebRTC mobiles.
export const MAX_TEXT_BYTES = 60 * 1024;

export type TransferMessage =
  | {
      type: 'init';
      transferId: string;
      fileName: string;
      mimeType: string;
      acceptTimeoutMs: number;
      fileSize: number;
      totalChunks: number;
    }
  | {
      type: 'chunk-header';
      transferId: string;
      chunkIndex: number;
      byteLength: number;
    }
  | {
      // Le hash est calculé pendant l’envoi : il n’est connu qu’à la fin du transfert.
      type: 'end';
      transferId: string;
      fileName: string;
      hash: string;
    }
  | {
      type: 'complete';
      transferId: string;
      fileName: string;
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
    }
  | {
      // Demande préalable : le contenu du texte ne part qu’après acceptation.
      type: 'text-offer';
      messageId: string;
      length: number;
    }
  | {
      type: 'text-response';
      messageId: string;
      accepted: boolean;
    }
  | {
      type: 'text';
      messageId: string;
      text: string;
    }
  | {
      type: 'text-ack';
      messageId: string;
    };

export function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Hash SHA-256 incrémental : le fichier n’a jamais besoin d’être entièrement en mémoire. */
export function createFileHasher() {
  return sha256.create();
}

export class FileTransferProtocol {
  private readonly chunkSize = CHUNK_SIZE_BYTES;

  public countChunks(fileSize: number) {
    return Math.ceil(fileSize / this.chunkSize);
  }

  /** Lit un seul chunk du fichier, au moment où il doit partir. */
  public async readChunk(file: Blob, chunkIndex: number) {
    const start = chunkIndex * this.chunkSize;
    return file.slice(start, start + this.chunkSize).arrayBuffer();
  }

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
    return toHex(sha256(new Uint8Array(fileBuffer)));
  }

  public serializeMessage(message: unknown) {
    return JSON.stringify(message);
  }

  public deserializeMessage(raw: string) {
    return JSON.parse(raw) as Record<string, unknown>;
  }
}
