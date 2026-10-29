import {
  FileTransferProtocol,
  MAX_FILE_SIZE_BYTES,
  TRANSFER_ACK_WINDOW,
  TRANSFER_ACCEPT_TIMEOUT_MS,
  createFileHasher,
  toHex,
  type TransferMessage
} from './file-transfer';

export type Peer = {
  id: string;
  name: string;
  platform: string;
  status: string;
};

export type SignalPayload = {
  type: 'offer' | 'answer' | 'candidate';
  payload: Record<string, unknown>;
  from?: string;
  to?: string;
};

export type TransferProgress = {
  peerId: string;
  transferId: string;
  direction: 'sending' | 'receiving';
  fileName: string;
  bytesTransferred: number;
  totalBytes: number;
};

export type TransferRequest = {
  transferId: string;
  fileName: string;
  fileSize: number;
  expiresInMs: number;
};

export type TransferResult = {
  peerId: string;
  transferId: string;
  fileName: string;
  direction: 'sending' | 'receiving';
  ok: boolean;
  file?: Blob;
  reason?: string;
};

export type OfflineTransferRequest = {
  transferId: string;
  to: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  totalChunks: number;
  expiresInMs: number;
};

type IncomingTransfer = {
  peerId: string;
  transferId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  totalChunks: number;
  accepted: boolean;
  nextChunkIndex: number;
  bytesReceived: number;
  hasher: ReturnType<typeof createFileHasher>;
  pendingParts: ArrayBuffer[];
  pendingBytes: number;
  blobs: Blob[];
};

type OutgoingTransfer = {
  peerId: string;
  fileName: string;
  resolve: (accepted: boolean) => void;
  cancelled: boolean;
  timeoutId: number;
};

type ManagerOptions = {
  localPeerId: string;
  sendSignal: (type: 'offer' | 'answer' | 'candidate', payload: Record<string, unknown>, to: string) => void;
  onStatusChange: (status: string, connected: boolean) => void;
  onPeerStateChange?: (peerId: string) => void;
  onTransferRequest?: (peerId: string, transfer: TransferRequest) => void;
  onTransferProgress?: (progress: TransferProgress) => void;
  onTransferDecision?: (decision: { peerId: string; transferId: string; fileName: string; accepted: boolean }) => void;
  onTransferCancelled?: (peerId: string, transferId?: string) => void;
  onTransferPending?: (pending: { peerId: string; transferId: string; fileName: string; expiresInMs: number }) => void;
  onTransferExpired?: (peerId: string, transferId: string) => void;
  onTransferComplete?: (result: TransferResult) => void;
  getPeerName?: (peerId: string) => string;
  isPeerOnline?: (peerId: string) => boolean;
  requestOfflineTransfer?: (request: OfflineTransferRequest) => Promise<boolean>;
  cancelOfflineTransfer?: (peerId: string) => void;
};

// Au-delà de ce volume, les chunks reçus sont regroupés dans un Blob que le navigateur peut garder sur disque.
const BLOB_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const BUFFER_LOW_THRESHOLD_BYTES = 1024 * 1024;
const MAX_RECONNECT_ATTEMPTS = 5;

export class PeerConnectionManager {
  private readonly peerConnections = new Map<string, RTCPeerConnection>();
  private readonly dataChannels = new Map<string, RTCDataChannel>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, number>();
  private readonly dataChannelQueues = new Map<string, Promise<void>>();
  private readonly pendingChunkAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly pendingChunkHeaders = new Map<string, Array<Extract<TransferMessage, { type: 'chunk-header' }>>>();
  private readonly approvedOfflineTransfers = new Set<string>();
  private readonly incomingTransfers = new Map<string, IncomingTransfer>();
  // Une seule demande sortante est active par pair : les fichiers multiples sont envoyés l’un après l’autre.
  private readonly outgoingTransfers = new Map<string, OutgoingTransfer>();
  private readonly fileTransferProtocol = new FileTransferProtocol();
  private readonly options: ManagerOptions;
  private readonly localPeerId: string;

  constructor(options: ManagerOptions) {
    this.options = options;
    this.localPeerId = options.localPeerId;
  }

  public hasConnection(peerId: string) {
    return this.peerConnections.has(peerId);
  }

  /** Le canal direct est ouvert : un envoi peut partir immédiatement. */
  public isReady(peerId: string) {
    return this.dataChannels.get(peerId)?.readyState === 'open';
  }

  public acceptTransfer(peerId: string, transferId: string) {
    const transfer = this.incomingTransfers.get(this.transferKey(peerId, transferId));
    if (!transfer) {
      return;
    }

    transfer.accepted = true;
    // La réponse est envoyée avant que l’émetteur puisse commencer les chunks.
    this.sendMessage(peerId, { type: 'response', transferId, fileName: transfer.fileName, accepted: true });
    this.emitProgress(peerId, transferId, 'receiving', transfer.fileName, 0, transfer.fileSize);
    this.status(`Réception de ${transfer.fileName}…`, true);
  }

  public rejectTransfer(peerId: string, transferId: string) {
    const key = this.transferKey(peerId, transferId);
    const transfer = this.incomingTransfers.get(key);
    if (!transfer) {
      return;
    }

    this.incomingTransfers.delete(key);
    // Le refus est également transmis afin que l’émetteur arrête proprement son envoi.
    this.sendMessage(peerId, { type: 'response', transferId, fileName: transfer.fileName, accepted: false });
    this.status(`Vous avez refusé ${transfer.fileName}`, false);
  }

  /** Annule le transfert indiqué, ou à défaut le transfert en cours avec ce pair. */
  public cancelTransfer(peerId: string, transferId?: string) {
    this.options.cancelOfflineTransfer?.(peerId);
    const outgoingEntry = Array.from(this.outgoingTransfers.entries())
      .find(([id, transfer]) => transfer.peerId === peerId && (!transferId || id === transferId));
    const incoming = Array.from(this.incomingTransfers.values())
      .find((transfer) => transfer.peerId === peerId && transfer.accepted && (!transferId || transfer.transferId === transferId));

    if (outgoingEntry) {
      const [transferId, outgoing] = outgoingEntry;
      outgoing.cancelled = true;
      this.outgoingTransfers.delete(transferId);
      window.clearTimeout(outgoing.timeoutId);
      outgoing.resolve(false);
      this.resolvePendingChunkAcks(transferId);
      this.sendMessage(peerId, { type: 'cancel', transferId, fileName: outgoing.fileName });
    } else if (incoming) {
      this.incomingTransfers.delete(this.transferKey(peerId, incoming.transferId));
      this.sendMessage(peerId, { type: 'cancel', transferId: incoming.transferId, fileName: incoming.fileName });
    }

    this.options.onTransferCancelled?.(peerId, outgoingEntry?.[0] ?? incoming?.transferId ?? transferId);
    this.status('Transfert annulé', false);
  }

  public async initiate(peerId: string) {
    if (peerId === this.localPeerId || this.peerConnections.has(peerId)) {
      return;
    }

    // On crée la connexion WebRTC et on envoie immédiatement une offer SDP.
    const connection = this.create(peerId, true);
    this.peerConnections.set(peerId, connection);
    this.options.onPeerStateChange?.(peerId);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    this.options.sendSignal('offer', { sdp: offer.sdp }, peerId);
  }

  /**
   * Envoie un fichier en le lisant chunk par chunk : la mémoire utilisée reste constante,
   * quelle que soit la taille du fichier. Renvoie false si le transfert n’a pas eu lieu.
   */
  public async sendFile(peerId: string, file: File, forceOfflineRequest = false) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('La taille maximale autorisée est de 10 Go.');
    }

    const peerName = this.peerDisplayName(peerId);
    const transferId = this.createTransferId();
    const totalChunks = this.fileTransferProtocol.countChunks(file.size);
    const mimeType = file.type || 'application/octet-stream';
    let channel = forceOfflineRequest ? null : await this.connect(peerId);
    let acceptedOffline = false;

    if (!channel && this.options.requestOfflineTransfer) {
      this.options.onTransferPending?.({ peerId, transferId, fileName: file.name, expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS });
      acceptedOffline = await this.options.requestOfflineTransfer({
        transferId,
        to: peerId,
        fileName: file.name,
        fileSize: file.size,
        mimeType,
        totalChunks,
        expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS
      });
      if (!acceptedOffline) {
        this.status('Demande refusée, annulée ou expirée', false);
        return false;
      }
      channel = await this.connect(peerId);
    }

    if (!channel) {
      this.status(`${peerName} est injoignable. Vérifiez que GeniusSend est ouvert sur cet appareil.`, false);
      return false;
    }

    this.sendOn(channel, {
      type: 'init',
      transferId,
      fileName: file.name,
      mimeType,
      acceptTimeoutMs: TRANSFER_ACCEPT_TIMEOUT_MS,
      fileSize: file.size,
      totalChunks
    });

    // On attend l’autorisation explicite du destinataire avant d’envoyer des données.
    const accepted = acceptedOffline || await this.waitForAcceptance(peerId, transferId, file.name, channel);
    if (!accepted) {
      this.outgoingTransfers.delete(transferId);
      return false;
    }

    if (acceptedOffline) {
      this.outgoingTransfers.set(transferId, { peerId, fileName: file.name, resolve: () => undefined, cancelled: false, timeoutId: 0 });
    }

    this.emitProgress(peerId, transferId, 'sending', file.name, 0, file.size);
    this.status(`Envoi de ${file.name} à ${peerName}…`, true);
    const hasher = createFileHasher();
    let bytesSent = 0;

    try {
      for (let index = 0; index < totalChunks; index += 1) {
        if (this.outgoingTransfers.get(transferId)?.cancelled !== false) {
          return false;
        }

        const chunk = await this.fileTransferProtocol.readChunk(file, index);
        hasher.update(new Uint8Array(chunk));

        // L’en-tête reste en JSON, mais le contenu du fichier passe en binaire natif.
        await this.waitForBuffer(channel);
        this.sendOn(channel, { type: 'chunk-header', transferId, chunkIndex: index, byteLength: chunk.byteLength });
        const isWindowEnd = (index + 1) % TRANSFER_ACK_WINDOW === 0 || index === totalChunks - 1;
        const acknowledgement = isWindowEnd ? this.waitForChunkAcknowledgement(transferId, index) : null;
        // Si l’envoi échoue avant l’attente, ce rejet ne doit pas remonter comme erreur non gérée.
        acknowledgement?.catch(() => undefined);
        channel.send(chunk);
        bytesSent += chunk.byteLength;

        if (acknowledgement) {
          await acknowledgement;
          if (!this.outgoingTransfers.has(transferId)) {
            return false;
          }
          this.emitProgress(peerId, transferId, 'sending', file.name, bytesSent, file.size);
        }
      }

      if (totalChunks === 0) {
        this.emitProgress(peerId, transferId, 'sending', file.name, 0, 0);
      }

      // Fin de transfert : le destinataire compare ce hash avec celui qu’il a calculé en recevant.
      await this.waitForBuffer(channel);
      this.sendOn(channel, { type: 'end', transferId, fileName: file.name, hash: toHex(hasher.digest()) });
      this.status(`${file.name} envoyé, vérification par ${peerName}…`, true);
      return true;
    } finally {
      this.outgoingTransfers.delete(transferId);
    }
  }

  public async handleIncoming(message: SignalPayload) {
    if (!message.from || message.from === this.localPeerId) {
      return;
    }

    const fromPeer = message.from;
    let connection = this.peerConnections.get(fromPeer);

    // Une nouvelle offre alors qu’une session existe déjà : l’autre appareil a redémarré la connexion.
    if (message.type === 'offer' && connection?.remoteDescription) {
      this.discardConnection(fromPeer);
      connection = undefined;
    }

    if (!connection) {
      connection = this.create(fromPeer, false);
      this.peerConnections.set(fromPeer, connection);
      this.options.onPeerStateChange?.(fromPeer);
    }

    try {
      if (message.type === 'offer' && typeof message.payload.sdp === 'string') {
        await connection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.payload.sdp }));
        await this.flushIceCandidates(fromPeer, connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        this.options.sendSignal('answer', { sdp: answer.sdp }, fromPeer);
        return;
      }

      if (message.type === 'answer' && typeof message.payload.sdp === 'string') {
        await connection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: message.payload.sdp }));
        await this.flushIceCandidates(fromPeer, connection);
        return;
      }

      if (message.type === 'candidate' && message.payload.candidate) {
        const candidate = message.payload.candidate as RTCIceCandidateInit;

        if (!connection.remoteDescription) {
          const queuedCandidates = this.pendingIceCandidates.get(fromPeer) ?? [];
          queuedCandidates.push(candidate);
          this.pendingIceCandidates.set(fromPeer, queuedCandidates);
          return;
        }

        await connection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      console.error('[GeniusSend] signal WebRTC non traité', error);
      this.status(`Connexion impossible avec ${this.peerDisplayName(fromPeer)}`, false);
    }
  }

  public approveOfflineTransfer(peerId: string, transferId: string) {
    this.approvedOfflineTransfers.add(this.transferKey(peerId, transferId));
  }

  private create(peerId: string, isInitiator: boolean) {
    if (!window.RTCPeerConnection) {
      throw new Error('Ce navigateur ne permet pas les connexions directes (WebRTC).');
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    console.info('[GeniusSend] RTCPeerConnection créée', { peerId, isInitiator });

    // Seul l’initiateur crée le canal ; le destinataire recevra le canal distant.
    if (isInitiator) {
      this.configureChannel(peerId, connection.createDataChannel('geniussend'));
    }

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.options.sendSignal('candidate', { candidate: event.candidate.toJSON() }, peerId);
      }
    };

    connection.ondatachannel = (event) => {
      if (this.peerConnections.get(peerId) === connection) {
        this.configureChannel(peerId, event.channel);
      }
    };

    connection.onconnectionstatechange = () => {
      // Une connexion remplacée ne doit plus influencer l’état du pair.
      if (this.peerConnections.get(peerId) !== connection) {
        return;
      }

      console.info('[GeniusSend] état WebRTC', { peerId, state: connection.connectionState });
      if (connection.connectionState === 'connected') {
        this.reconnectAttempts.delete(peerId);
        this.options.onPeerStateChange?.(peerId);
      }

      // « disconnected » se rétablit souvent seul : on ne coupe qu’après quelques secondes.
      if (connection.connectionState === 'disconnected') {
        window.setTimeout(() => {
          if (this.peerConnections.get(peerId) === connection && connection.connectionState === 'disconnected') {
            this.handleConnectionLost(peerId);
          }
        }, 5_000);
      }

      if (connection.connectionState === 'failed') {
        this.handleConnectionLost(peerId);
      }
    };

    connection.oniceconnectionstatechange = () => {
      if (this.peerConnections.get(peerId) === connection && connection.iceConnectionState === 'failed') {
        this.status(`Impossible de joindre ${this.peerDisplayName(peerId)}. Vérifiez que les deux appareils sont sur le même réseau.`, false);
      }
    };

    return connection;
  }

  private configureChannel(peerId: string, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      if (this.dataChannels.get(peerId) !== channel) {
        return;
      }
      console.info('[GeniusSend] RTCDataChannel ouvert', { peerId });
      this.options.onPeerStateChange?.(peerId);
    };

    channel.onclose = () => {
      if (this.dataChannels.get(peerId) === channel) {
        console.info('[GeniusSend] RTCDataChannel fermé', { peerId });
        this.handleConnectionLost(peerId);
      }
    };

    channel.onerror = (event) => {
      console.warn('[GeniusSend] canal interrompu (appareil parti ou réseau coupé)', { peerId, event });
    };

    channel.onmessage = (event) => {
      const previous = this.dataChannelQueues.get(peerId) ?? Promise.resolve();
      const current = previous
        .catch(() => undefined)
        .then(() => this.handleDataChannelMessage(peerId, event.data));
      this.dataChannelQueues.set(peerId, current);
    };

    this.dataChannels.set(peerId, channel);
  }

  /** Ouvre (ou réutilise) le canal direct vers un pair. */
  private async connect(peerId: string) {
    if (!this.isReady(peerId)) {
      this.status(`Connexion à ${this.peerDisplayName(peerId)}…`, true);
    }
    await this.initiate(peerId);
    return this.waitForOpenChannel(peerId);
  }

  private discardConnection(peerId: string) {
    const connection = this.peerConnections.get(peerId);
    const channel = this.dataChannels.get(peerId);
    this.peerConnections.delete(peerId);
    this.dataChannels.delete(peerId);
    this.pendingIceCandidates.delete(peerId);
    this.pendingChunkHeaders.delete(peerId);
    channel?.close();
    connection?.close();
    this.options.onPeerStateChange?.(peerId);
  }

  private handleConnectionLost(peerId: string) {
    if (!this.peerConnections.has(peerId)) {
      return;
    }

    const peerName = this.peerDisplayName(peerId);
    const lostError = new Error(`Connexion perdue avec ${peerName} : transfert interrompu.`);
    let interrupted = false;

    for (const transfer of Array.from(this.incomingTransfers.values())) {
      if (transfer.peerId !== peerId) continue;
      if (transfer.accepted) {
        this.failIncomingTransfer(transfer, 'la connexion a été perdue');
      } else {
        this.incomingTransfers.delete(this.transferKey(peerId, transfer.transferId));
        this.options.onTransferExpired?.(peerId, transfer.transferId);
      }
    }

    for (const [transferId, outgoing] of this.outgoingTransfers) {
      if (outgoing.peerId !== peerId) continue;
      interrupted = true;
      window.clearTimeout(outgoing.timeoutId);
      outgoing.resolve(false);
      this.rejectPendingChunkAcks(transferId, lostError);
    }

    this.discardConnection(peerId);
    if (interrupted) {
      this.status(lostError.message, false);
    }

    // Les deux appareils détectent la coupure : seul celui au plus petit identifiant relance, pour éviter deux offres croisées.
    if (this.localPeerId < peerId) {
      this.scheduleReconnect(peerId);
    }
  }

  private async flushIceCandidates(peerId: string, connection: RTCPeerConnection) {
    const queuedCandidates = this.pendingIceCandidates.get(peerId) ?? [];
    this.pendingIceCandidates.delete(peerId);

    for (const candidate of queuedCandidates) {
      await connection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private async waitForOpenChannel(peerId: string) {
    const timeoutAt = Date.now() + 15_000;

    while (Date.now() < timeoutAt) {
      const channel = this.dataChannels.get(peerId);
      if (channel?.readyState === 'open') {
        return channel;
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 100);
      });
    }

    return null;
  }

  private scheduleReconnect(peerId: string) {
    if (this.reconnectTimers.has(peerId) || !(this.options.isPeerOnline?.(peerId) ?? true)) {
      return;
    }

    const attempt = (this.reconnectAttempts.get(peerId) ?? 0) + 1;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      // La connexion sera recréée à la demande lors du prochain envoi.
      this.reconnectAttempts.delete(peerId);
      return;
    }

    this.reconnectAttempts.set(peerId, attempt);
    const timer = window.setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      if (this.peerConnections.has(peerId) || !(this.options.isPeerOnline?.(peerId) ?? true)) {
        return;
      }
      void this.initiate(peerId).catch((error) => {
        console.error('[GeniusSend] échec de reconnexion WebRTC', { peerId, error });
        this.scheduleReconnect(peerId);
      });
    }, 1_000 * attempt);

    this.reconnectTimers.set(peerId, timer);
  }

  private async handleDataChannelMessage(peerId: string, payload: Blob | ArrayBuffer | string) {
    if (typeof payload !== 'string') {
      const binaryPayload = payload instanceof ArrayBuffer ? payload : await new Response(payload).arrayBuffer();
      const headers = this.pendingChunkHeaders.get(peerId) ?? [];
      const header = headers.shift();

      if (!header) {
        console.warn('[GeniusSend] chunk binaire reçu sans en-tête', { peerId });
        return;
      }

      if (headers.length === 0) {
        this.pendingChunkHeaders.delete(peerId);
      } else {
        this.pendingChunkHeaders.set(peerId, headers);
      }
      this.handleChunkData(peerId, header, binaryPayload);
      return;
    }

    let message: TransferMessage;

    try {
      message = this.fileTransferProtocol.deserializeMessage(payload) as TransferMessage;
    } catch (error) {
      console.error('[GeniusSend] message de transfert invalide', error);
      return;
    }

    const peerName = this.peerDisplayName(peerId);

    // Une demande de transfert commence par un message d'initialisation.
    if (message.type === 'init') {
      if (!Number.isSafeInteger(message.fileSize) || message.fileSize < 0 || message.fileSize > MAX_FILE_SIZE_BYTES) {
        this.sendMessage(peerId, { type: 'response', transferId: message.transferId, fileName: message.fileName, accepted: false });
        this.status('Fichier refusé : la taille maximale est de 10 Go', false);
        return;
      }

      const transferKey = this.transferKey(peerId, message.transferId);
      const preapproved = this.approvedOfflineTransfers.delete(transferKey);
      this.incomingTransfers.set(transferKey, {
        peerId,
        transferId: message.transferId,
        fileName: message.fileName,
        mimeType: message.mimeType || 'application/octet-stream',
        fileSize: message.fileSize,
        totalChunks: message.totalChunks,
        accepted: preapproved,
        nextChunkIndex: 0,
        bytesReceived: 0,
        hasher: createFileHasher(),
        pendingParts: [],
        pendingBytes: 0,
        blobs: []
      });

      if (preapproved) {
        this.sendMessage(peerId, { type: 'response', transferId: message.transferId, fileName: message.fileName, accepted: true });
        this.emitProgress(peerId, message.transferId, 'receiving', message.fileName, 0, message.fileSize);
        this.status(`Réception de ${message.fileName}…`, true);
        return;
      }

      this.options.onTransferRequest?.(peerId, {
        transferId: message.transferId,
        fileName: message.fileName,
        fileSize: message.fileSize,
        expiresInMs: message.acceptTimeoutMs || TRANSFER_ACCEPT_TIMEOUT_MS
      });
      this.status(`${peerName} veut vous envoyer ${message.fileName}`, true);
      return;
    }

    // Cette réponse débloque l’envoi côté émetteur.
    if (message.type === 'response') {
      const outgoing = this.outgoingTransfers.get(message.transferId);
      if (outgoing) {
        // L’interface de l’expéditeur est informée dès l’arrivée de la décision.
        this.options.onTransferDecision?.({ peerId, transferId: message.transferId, fileName: message.fileName, accepted: message.accepted });
        this.status(message.accepted ? `${peerName} a accepté ${message.fileName}` : `${peerName} a refusé ${message.fileName}`, message.accepted);

        if (!message.accepted) {
          this.outgoingTransfers.delete(message.transferId);
        }

        window.clearTimeout(outgoing.timeoutId);
        outgoing.resolve(message.accepted);
      }
      return;
    }

    if (message.type === 'chunk-ack') {
      const key = this.chunkAckKey(message.transferId, message.chunkIndex);
      const acknowledgement = this.pendingChunkAcks.get(key);
      if (acknowledgement) {
        this.pendingChunkAcks.delete(key);
        acknowledgement.resolve();
      }
      return;
    }

    if (message.type === 'cancel') {
      this.incomingTransfers.delete(this.transferKey(peerId, message.transferId));
      const headers = this.pendingChunkHeaders.get(peerId)?.filter((header) => header.transferId !== message.transferId) ?? [];
      if (headers.length > 0) {
        this.pendingChunkHeaders.set(peerId, headers);
      } else {
        this.pendingChunkHeaders.delete(peerId);
      }

      const outgoing = this.outgoingTransfers.get(message.transferId);
      if (outgoing) {
        outgoing.cancelled = true;
        this.outgoingTransfers.delete(message.transferId);
        window.clearTimeout(outgoing.timeoutId);
        outgoing.resolve(false);
        this.resolvePendingChunkAcks(message.transferId);
      }

      if (message.reason === 'expired') {
        this.options.onTransferExpired?.(peerId, message.transferId);
        this.status('La demande de transfert a expiré', false);
      } else {
        this.options.onTransferCancelled?.(peerId, message.transferId);
        this.status(`${peerName} a annulé le transfert`, false);
      }
      return;
    }

    if (message.type === 'chunk-header') {
      const headers = this.pendingChunkHeaders.get(peerId) ?? [];
      headers.push(message);
      this.pendingChunkHeaders.set(peerId, headers);
      return;
    }

    if (message.type === 'end') {
      const transfer = this.incomingTransfers.get(this.transferKey(peerId, message.transferId));
      if (transfer?.accepted) {
        this.finalizeTransfer(transfer, message.hash);
      }
      return;
    }

    // Confirmation finale du destinataire : le fichier est arrivé intact (ou non).
    if (message.type === 'complete') {
      this.options.onTransferComplete?.({
        peerId,
        transferId: message.transferId,
        fileName: message.fileName,
        direction: 'sending',
        ok: message.ok,
        reason: message.ok ? undefined : 'le fichier est arrivé incomplet ou corrompu'
      });
      this.status(message.ok ? `${message.fileName} bien reçu par ${peerName}` : `${peerName} a reçu un fichier incomplet`, message.ok);
    }
  }

  private handleChunkData(peerId: string, header: Extract<TransferMessage, { type: 'chunk-header' }>, chunk: ArrayBuffer) {
    // Les transferts sont indexés par pair ET transfert : ne jamais chercher avec peerId seul.
    const transfer = this.incomingTransfers.get(this.transferKey(peerId, header.transferId));
    if (!transfer || !transfer.accepted) {
      return;
    }

    // Un chunk déjà reçu ne doit pas être compté deux fois dans la progression.
    if (header.chunkIndex < transfer.nextChunkIndex) {
      return;
    }

    // Le canal est ordonné : un trou dans la séquence signifie que des données ont été perdues.
    if (header.chunkIndex !== transfer.nextChunkIndex || transfer.bytesReceived + chunk.byteLength > transfer.fileSize) {
      this.failIncomingTransfer(transfer, 'des morceaux du fichier manquent');
      return;
    }

    transfer.hasher.update(new Uint8Array(chunk));
    transfer.pendingParts.push(chunk);
    transfer.pendingBytes += chunk.byteLength;
    transfer.bytesReceived += chunk.byteLength;
    transfer.nextChunkIndex += 1;

    if (transfer.pendingBytes >= BLOB_BATCH_BYTES) {
      transfer.blobs.push(new Blob(transfer.pendingParts));
      transfer.pendingParts = [];
      transfer.pendingBytes = 0;
    }

    this.emitProgress(peerId, transfer.transferId, 'receiving', transfer.fileName, transfer.bytesReceived, transfer.fileSize);
    const windowComplete = (header.chunkIndex + 1) % TRANSFER_ACK_WINDOW === 0;
    const transferComplete = header.chunkIndex === transfer.totalChunks - 1;
    if (windowComplete || transferComplete) {
      this.sendMessage(peerId, { type: 'chunk-ack', transferId: transfer.transferId, chunkIndex: header.chunkIndex });
    }
  }

  private finalizeTransfer(transfer: IncomingTransfer, expectedHash: string) {
    if (transfer.nextChunkIndex !== transfer.totalChunks || transfer.bytesReceived !== transfer.fileSize) {
      this.failIncomingTransfer(transfer, 'le fichier est incomplet');
      return;
    }

    if (toHex(transfer.hasher.digest()) !== expectedHash) {
      this.failIncomingTransfer(transfer, 'le fichier est corrompu');
      return;
    }

    const file = new Blob([...transfer.blobs, ...transfer.pendingParts], { type: transfer.mimeType });
    this.incomingTransfers.delete(this.transferKey(transfer.peerId, transfer.transferId));
    this.sendMessage(transfer.peerId, { type: 'complete', transferId: transfer.transferId, fileName: transfer.fileName, ok: true });
    this.emitProgress(transfer.peerId, transfer.transferId, 'receiving', transfer.fileName, transfer.fileSize, transfer.fileSize);
    this.options.onTransferComplete?.({
      peerId: transfer.peerId,
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      direction: 'receiving',
      ok: true,
      file
    });
    this.status(`${transfer.fileName} reçu de ${this.peerDisplayName(transfer.peerId)}`, true);
  }

  private failIncomingTransfer(transfer: IncomingTransfer, reason: string) {
    this.incomingTransfers.delete(this.transferKey(transfer.peerId, transfer.transferId));
    this.sendMessage(transfer.peerId, { type: 'complete', transferId: transfer.transferId, fileName: transfer.fileName, ok: false });
    this.options.onTransferComplete?.({
      peerId: transfer.peerId,
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      direction: 'receiving',
      ok: false,
      reason
    });
    this.status(`Réception de ${transfer.fileName} échouée : ${reason}`, false);
  }

  private waitForAcceptance(peerId: string, transferId: string, fileName: string, channel: RTCDataChannel) {
    return new Promise<boolean>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        if (this.outgoingTransfers.get(transferId)?.resolve !== resolve) {
          return;
        }
        this.outgoingTransfers.delete(transferId);
        if (channel.readyState === 'open') {
          this.sendOn(channel, { type: 'cancel', transferId, fileName, reason: 'expired' });
        }
        this.options.onTransferExpired?.(peerId, transferId);
        this.status(`${this.peerDisplayName(peerId)} n’a pas répondu à temps`, false);
        resolve(false);
      }, TRANSFER_ACCEPT_TIMEOUT_MS);

      this.outgoingTransfers.set(transferId, { peerId, fileName, resolve, cancelled: false, timeoutId });
      this.options.onTransferPending?.({ peerId, transferId, fileName, expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS });
      this.status(`En attente de la réponse de ${this.peerDisplayName(peerId)}…`, true);
    });
  }

  /**
   * Évite de remplir la mémoire du navigateur lorsque le réseau est plus lent
   * que la lecture du fichier : on attend que le canal signale un tampon presque vide.
   */
  private waitForBuffer(channel: RTCDataChannel) {
    if (channel.readyState !== 'open') {
      return Promise.reject(new Error('La connexion a été coupée pendant le transfert.'));
    }
    if (channel.bufferedAmount <= MAX_BUFFERED_BYTES) {
      return Promise.resolve();
    }

    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD_BYTES;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
      };
      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('La connexion a été coupée pendant le transfert.'));
      };
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Le réseau ne répond plus : transfert interrompu.'));
      }, 30_000);

      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
    });
  }

  private emitProgress(peerId: string, transferId: string, direction: 'sending' | 'receiving', fileName: string, bytesTransferred: number, totalBytes: number) {
    this.options.onTransferProgress?.({
      peerId,
      transferId,
      direction,
      fileName,
      bytesTransferred: Math.min(totalBytes, bytesTransferred),
      totalBytes
    });
  }

  private sendMessage(peerId: string, message: TransferMessage) {
    const channel = this.dataChannels.get(peerId);
    if (channel?.readyState === 'open') {
      this.sendOn(channel, message);
    }
  }

  private sendOn(channel: RTCDataChannel, message: TransferMessage) {
    channel.send(this.fileTransferProtocol.serializeMessage(message));
  }

  private status(message: string, connected: boolean) {
    this.options.onStatusChange(message, connected);
  }

  private transferKey(peerId: string, transferId: string) {
    return `${peerId}:${transferId}`;
  }

  private peerDisplayName(peerId: string) {
    return this.options.getPeerName?.(peerId) || 'l’appareil distant';
  }

  private chunkAckKey(transferId: string, chunkIndex: number) {
    return `${transferId}:${chunkIndex}`;
  }

  private resolvePendingChunkAcks(transferId: string) {
    for (const [key, acknowledgement] of this.pendingChunkAcks) {
      if (key.startsWith(`${transferId}:`)) {
        this.pendingChunkAcks.delete(key);
        acknowledgement.resolve();
      }
    }
  }

  private rejectPendingChunkAcks(transferId: string, error: Error) {
    for (const [key, acknowledgement] of this.pendingChunkAcks) {
      if (key.startsWith(`${transferId}:`)) {
        this.pendingChunkAcks.delete(key);
        acknowledgement.reject(error);
      }
    }
  }

  private waitForChunkAcknowledgement(transferId: string, chunkIndex: number) {
    return new Promise<void>((resolve, reject) => {
      const key = this.chunkAckKey(transferId, chunkIndex);
      const timeout = window.setTimeout(() => {
        this.pendingChunkAcks.delete(key);
        reject(new Error('Le destinataire ne répond plus : transfert interrompu.'));
      }, 30_000);

      this.pendingChunkAcks.set(key, {
        resolve: () => {
          window.clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private createTransferId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    const randomPart = Math.random().toString(36).slice(2);
    return `transfer-${Date.now().toString(36)}-${randomPart}`;
  }
}
