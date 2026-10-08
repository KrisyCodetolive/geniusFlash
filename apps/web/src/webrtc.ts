import { FileTransferProtocol, MAX_FILE_SIZE_BYTES, TRANSFER_ACK_WINDOW, TRANSFER_ACCEPT_TIMEOUT_MS, type TransferMessage } from './file-transfer';

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

export class PeerConnectionManager {
  private readonly peerConnections = new Map<string, RTCPeerConnection>();
  private readonly dataChannels = new Map<string, RTCDataChannel>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, number>();
  private readonly dataChannelQueues = new Map<string, Promise<void>>();
  private readonly pendingChunkAcks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private readonly pendingChunkHeaders = new Map<string, Array<Extract<TransferMessage, { type: 'chunk-header' }>>>();
  private readonly onStatusChange: (status: string, connected: boolean) => void;
  private readonly onPeerReady?: (peerId: string) => void;
  private readonly onTransferRequest?: (peerId: string, transfer: { transferId: string; fileName: string; fileSize: number; totalChunks: number; hash: string; expiresInMs: number }) => void;
  private readonly onTransferProgress?: (progress: { peerId: string; direction: 'sending' | 'receiving'; fileName: string; bytesTransferred: number; totalBytes: number }) => void;
  private readonly onTransferDecision?: (decision: { peerId: string; transferId: string; fileName: string; accepted: boolean }) => void;
  private readonly onTransferCancelled?: (peerId: string) => void;
  private readonly onTransferPending?: (pending: { peerId: string; transferId: string; fileName: string; expiresInMs: number }) => void;
  private readonly onTransferExpired?: (peerId: string, transferId: string) => void;
  private readonly getPeerName?: (peerId: string) => string;
  private readonly sendSignal: (type: 'offer' | 'answer' | 'candidate', payload: Record<string, unknown>, to: string) => void;
  private readonly localPeerId: string;
  private readonly requestOfflineTransfer?: (request: { transferId: string; to: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number; hash: string; expiresInMs: number }) => Promise<boolean>;
  private readonly cancelOfflineTransfer?: (peerId: string) => void;
  private readonly approvedOfflineTransfers = new Set<string>();
  private readonly pendingTransfers = new Map<string, { fileName: string; mimeType: string; totalChunks: number; chunks: Map<number, Uint8Array>; hash: string; bytesReceived: number; fileSize: number; accepted: boolean; peerId: string; transferId: string }>();
  private readonly fileTransferProtocol = new FileTransferProtocol();
  // Une seule demande sortante est conservée par pair dans cette première version.
  private readonly outgoingTransfers = new Map<string, { peerId: string; fileName: string; resolve: (accepted: boolean) => void; cancelled: boolean; timeoutId: number }>();

  constructor(options: {
    localPeerId: string;
    sendSignal: (type: 'offer' | 'answer' | 'candidate', payload: Record<string, unknown>, to: string) => void;
    onStatusChange: (status: string, connected: boolean) => void;
    onPeerReady?: (peerId: string) => void;
    onTransferRequest?: (peerId: string, transfer: { transferId: string; fileName: string; fileSize: number; totalChunks: number; hash: string; expiresInMs: number }) => void;
    onTransferProgress?: (progress: { peerId: string; direction: 'sending' | 'receiving'; fileName: string; bytesTransferred: number; totalBytes: number }) => void;
    onTransferDecision?: (decision: { peerId: string; transferId: string; fileName: string; accepted: boolean }) => void;
    onTransferCancelled?: (peerId: string) => void;
    onTransferPending?: (pending: { peerId: string; transferId: string; fileName: string; expiresInMs: number }) => void;
    onTransferExpired?: (peerId: string, transferId: string) => void;
    getPeerName?: (peerId: string) => string;
    requestOfflineTransfer?: (request: { transferId: string; to: string; fileName: string; fileSize: number; mimeType: string; totalChunks: number; hash: string; expiresInMs: number }) => Promise<boolean>;
    cancelOfflineTransfer?: (peerId: string) => void;
  }) {
    this.localPeerId = options.localPeerId;
    this.sendSignal = options.sendSignal;
    this.onStatusChange = options.onStatusChange;
    this.onPeerReady = options.onPeerReady;
    this.onTransferRequest = options.onTransferRequest;
    this.onTransferProgress = options.onTransferProgress;
    this.onTransferDecision = options.onTransferDecision;
    this.onTransferCancelled = options.onTransferCancelled;
    this.onTransferPending = options.onTransferPending;
    this.onTransferExpired = options.onTransferExpired;
    this.getPeerName = options.getPeerName;
    this.requestOfflineTransfer = options.requestOfflineTransfer;
    this.cancelOfflineTransfer = options.cancelOfflineTransfer;
  }

  public hasConnection(peerId: string) {
    return this.peerConnections.has(peerId);
  }

  public acceptTransfer(peerId: string, transferId: string) {
    const key = this.transferKey(peerId, transferId);
    const transfer = this.pendingTransfers.get(key);
    if (!transfer) {
      return;
    }

    transfer.accepted = true;
    // La réponse est envoyée avant que l’émetteur puisse commencer les chunks.
    this.sendTransferResponse(peerId, transfer.transferId, transfer.fileName, true);
    this.onTransferProgress?.({
      peerId,
      direction: 'receiving',
      fileName: transfer.fileName,
      bytesTransferred: 0,
      totalBytes: transfer.fileSize
    });
    this.onStatusChange(`Transfert accepté : ${transfer.fileName}`, true);
  }

  public rejectTransfer(peerId: string, transferId: string) {
    const key = this.transferKey(peerId, transferId);
    const transfer = this.pendingTransfers.get(key);
    if (!transfer) {
      return;
    }

    this.pendingTransfers.delete(key);
    // Le refus est également transmis afin que l’émetteur arrête proprement son envoi.
    this.sendTransferResponse(peerId, transfer.transferId, transfer.fileName, false);
    this.onStatusChange(`Transfert refusé : ${transfer.fileName}`, false);
  }

  public cancelTransfer(peerId: string) {
    this.cancelOfflineTransfer?.(peerId);
    const channel = this.dataChannels.get(peerId);
    const outgoingEntry = Array.from(this.outgoingTransfers.entries()).find(([, transfer]) => transfer.peerId === peerId);
    const outgoing = outgoingEntry?.[1];
    const incomingEntry = Array.from(this.pendingTransfers.entries()).find(([, transfer]) => transfer.peerId === peerId && transfer.accepted);

    if (outgoing) {
      outgoing.cancelled = true;
      this.outgoingTransfers.delete(outgoingEntry[0]);
      window.clearTimeout(outgoing.timeoutId);
      outgoing.resolve(false);
      this.resolvePendingChunkAcks(outgoingEntry[0]);

      if (channel?.readyState === 'open') {
        const message: TransferMessage = {
          type: 'cancel',
          transferId: outgoingEntry[0],
          fileName: outgoing.fileName
        };
        channel.send(this.fileTransferProtocol.serializeMessage(message));
      }
    } else if (incomingEntry) {
      const [key, incoming] = incomingEntry;
      this.pendingTransfers.delete(key);

      if (channel?.readyState === 'open') {
        const message: TransferMessage = {
          type: 'cancel',
          transferId: incoming.transferId,
          fileName: incoming.fileName
        };
        channel.send(this.fileTransferProtocol.serializeMessage(message));
      }
    }

    this.onTransferCancelled?.(peerId);
    this.onStatusChange('Transfert annulé', false);
  }

  public async initiate(peerId: string) {
    if (peerId === this.localPeerId || this.peerConnections.has(peerId)) {
      return;
    }

    // On crée la connexion WebRTC et on envoie immédiatement une offer SDP.
    const connection = this.create(peerId, true);
    this.peerConnections.set(peerId, connection);

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    this.sendSignal('offer', { sdp: offer.sdp }, peerId);
    this.onStatusChange(`Négociation WebRTC en cours avec ${this.peerDisplayName(peerId)}`, true);
  }

  public async sendFile(peerId: string, file: File, forceOfflineRequest = false) {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('La taille maximale autorisée est de 10 Go.');
    }
    this.onStatusChange('Connexion au destinataire…', true);
    const fileBuffer = await file.arrayBuffer();
    const fileHash = await this.fileTransferProtocol.computeHash(fileBuffer);
    const chunks = this.fileTransferProtocol.chunk(fileBuffer);
    const transferId = this.createTransferId();
    let channel = forceOfflineRequest ? null : await this.waitForOpenChannel(peerId);
    let acceptedOffline = false;

    if (!channel && this.requestOfflineTransfer) {
      this.onTransferPending?.({ peerId, transferId, fileName: file.name, expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS });
      acceptedOffline = await this.requestOfflineTransfer({
        transferId,
        to: peerId,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: chunks.length,
        hash: fileHash,
        expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS
      });
      if (!acceptedOffline) {
        this.onStatusChange('Demande refusée, annulée ou expirée', false);
        return;
      }
      await this.initiate(peerId);
      channel = await this.waitForOpenChannel(peerId);
    }

    if (!channel) {
      this.onStatusChange('Le canal de transfert n’est pas disponible', false);
      return;
    }

    // Metadata initiale : nom du fichier, taille, nombre de chunks et hash final.
    const initMessage: TransferMessage = {
      type: 'init',
      transferId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      acceptTimeoutMs: TRANSFER_ACCEPT_TIMEOUT_MS,
      fileSize: file.size,
      totalChunks: chunks.length,
      hash: fileHash
    };

    channel.send(this.fileTransferProtocol.serializeMessage(initMessage));
    const recipientName = this.getPeerName?.(peerId) || 'le destinataire';
    this.onStatusChange(`Demande envoyée à ${recipientName} : ${file.name}`, true);

    // On attend l’autorisation explicite du destinataire avant d’envoyer des données.
    const accepted = acceptedOffline || await new Promise<boolean>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        if (this.outgoingTransfers.get(transferId)?.resolve === resolve) {
          this.outgoingTransfers.delete(transferId);
          const cancelMessage: TransferMessage = {
            type: 'cancel',
            transferId,
            fileName: file.name,
            reason: 'expired'
          };
          if (channel.readyState === 'open') {
            channel.send(this.fileTransferProtocol.serializeMessage(cancelMessage));
          }
          this.onTransferExpired?.(peerId, transferId);
          resolve(false);
        }
      }, TRANSFER_ACCEPT_TIMEOUT_MS);

      this.outgoingTransfers.set(transferId, { peerId, fileName: file.name, resolve, cancelled: false, timeoutId });
      this.onTransferPending?.({ peerId, transferId, fileName: file.name, expiresInMs: TRANSFER_ACCEPT_TIMEOUT_MS });
    });

    if (!accepted) {
      this.onStatusChange('Transfert refusé ou délai dépassé', false);
      return;
    }

    if (acceptedOffline) {
      this.outgoingTransfers.set(transferId, { peerId, fileName: file.name, resolve: () => undefined, cancelled: false, timeoutId: 0 });
    }

    this.onTransferProgress?.({
      peerId,
      direction: 'sending',
      fileName: file.name,
      bytesTransferred: 0,
      totalBytes: file.size
    });

    let bytesQueued = 0;
    let bytesConfirmed = 0;

    for (let index = 0; index < chunks.length; index += 1) {
      const outgoing = this.outgoingTransfers.get(transferId);
      if (!outgoing || outgoing.cancelled) {
        this.outgoingTransfers.delete(transferId);
        return;
      }

      const chunk = chunks[index];
      const header: TransferMessage = {
        type: 'chunk-header',
        transferId,
        chunkIndex: index,
        totalChunks: chunks.length,
        fileName: file.name,
        hash: fileHash,
        byteLength: chunk.byteLength
      };

      // L’en-tête reste en JSON, mais le contenu du fichier passe en binaire natif.
      await this.waitForBuffer(channel);
      channel.send(this.fileTransferProtocol.serializeMessage(header));
      await this.waitForBuffer(channel);
      const isWindowEnd = (index + 1) % TRANSFER_ACK_WINDOW === 0 || index === chunks.length - 1;
      const acknowledgement = isWindowEnd ? this.waitForChunkAcknowledgement(transferId, index) : null;
      channel.send(chunk);
      bytesQueued += chunk.byteLength;
      if (acknowledgement) {
        await acknowledgement;
        if (!this.outgoingTransfers.has(transferId)) {
          return;
        }
        bytesConfirmed = bytesQueued;
        this.onTransferProgress?.({
          peerId,
          direction: 'sending',
          fileName: file.name,
          bytesTransferred: Math.min(file.size, bytesConfirmed),
          totalBytes: file.size
        });
        this.onStatusChange(`Transfert confirmé : chunk ${index + 1}/${chunks.length}`, true);
      }
    }

    if (chunks.length === 0) {
      this.onTransferProgress?.({
        peerId,
        direction: 'sending',
        fileName: file.name,
        bytesTransferred: 0,
        totalBytes: 0
      });
    }

    // Fin de transfert : le destinataire peut reconstruire et vérifier le hash final.
    const endMessage: TransferMessage = {
      type: 'end',
      transferId,
      fileName: file.name,
      hash: fileHash,
      ok: true
    };

    await this.waitForBuffer(channel);
    channel.send(this.fileTransferProtocol.serializeMessage(endMessage));
    this.outgoingTransfers.delete(transferId);
  }

  public async handleIncoming(message: SignalPayload) {
    if (!message.from || message.from === this.localPeerId) {
      return;
    }

    const fromPeer = message.from;

    if (!this.peerConnections.has(fromPeer)) {
      const connection = this.create(fromPeer, false);
      this.peerConnections.set(fromPeer, connection);
    }

    const connection = this.peerConnections.get(fromPeer);
    if (!connection) {
      return;
    }

    try {
      if (message.type === 'offer' && typeof message.payload.sdp === 'string') {
        await connection.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: message.payload.sdp }));
        await this.flushIceCandidates(fromPeer, connection);
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        this.sendSignal('answer', { sdp: answer.sdp }, fromPeer);
        this.onStatusChange(`Réponse WebRTC envoyée à ${fromPeer}`, true);
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
      console.error('Unable to process incoming WebRTC signal:', error);
      this.onStatusChange('Échec de la connexion WebRTC', false);
    }
  }

  private create(peerId: string, isInitiator: boolean) {
    if (!window.RTCPeerConnection) {
      throw new Error('WebRTC non supporté par ce navigateur');
    }

    const connection = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    console.info('[GeniusSend] RTCPeerConnection créée', { peerId, isInitiator });

    // Seul l’initiateur crée le canal ; le destinataire recevra le canal distant.
    if (isInitiator) {
      const channel = connection.createDataChannel('geniussend');
      this.configureChannel(peerId, channel);
    }

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        console.debug('[GeniusSend] ICE candidate envoyé', { peerId, candidate: event.candidate.candidate });
        this.sendSignal('candidate', { candidate: event.candidate.toJSON() }, peerId);
      }
    };

    connection.ondatachannel = (event) => {
      this.configureChannel(peerId, event.channel);
    };

    connection.onconnectionstatechange = () => {
      console.info('[GeniusSend] état WebRTC', { peerId, state: connection.connectionState });
      if (connection.connectionState === 'connected') {
        this.reconnectAttempts.delete(peerId);
        this.onStatusChange(`Connexion WebRTC active avec ${this.peerDisplayName(peerId)}`, true);
        this.onPeerReady?.(peerId);
      }

      if (connection.connectionState === 'disconnected') {
        this.onStatusChange('Connexion WebRTC interrompue, reconnexion…', false);
        this.scheduleReconnect(peerId, connection);
      }

      if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
        this.onStatusChange('Connexion WebRTC échouée', false);
        this.scheduleReconnect(peerId, connection);
      }
    };

    connection.oniceconnectionstatechange = () => {
      console.info('[GeniusSend] état ICE', { peerId, state: connection.iceConnectionState });
      if (connection.iceConnectionState === 'failed') {
        this.onStatusChange('ICE échoué : réseau ou pare-feu', false);
      }
    };

    connection.onicegatheringstatechange = () => {
      console.debug('[GeniusSend] collecte ICE', { peerId, state: connection.iceGatheringState });
    };

    return connection;
  }

  private configureChannel(peerId: string, channel: RTCDataChannel) {
    channel.binaryType = 'arraybuffer';
    console.info('[GeniusSend] RTCDataChannel configuré', { peerId, label: channel.label });

    channel.onopen = () => {
      console.info('[GeniusSend] RTCDataChannel ouvert', { peerId });
      this.onStatusChange(`Connexion WebRTC active avec ${this.peerDisplayName(peerId)}`, true);
      this.onPeerReady?.(peerId);
    };

    channel.onclose = () => {
      console.info('[GeniusSend] RTCDataChannel fermé', { peerId });
      this.onStatusChange('Connexion WebRTC fermée', false);
      const connection = this.peerConnections.get(peerId);
      if (connection) {
        this.scheduleReconnect(peerId, connection);
      }
    };

    channel.onerror = (event) => {
      console.error('[GeniusSend] erreur RTCDataChannel', { peerId, event });
      this.onStatusChange('Erreur WebRTC', false);
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

  private scheduleReconnect(peerId: string, connection: RTCPeerConnection) {
    if (this.reconnectTimers.has(peerId)) {
      return;
    }

    const attempt = (this.reconnectAttempts.get(peerId) ?? 0) + 1;
    if (attempt > 5) {
      this.onStatusChange('Reconnexion WebRTC impossible', false);
      return;
    }

    this.reconnectAttempts.set(peerId, attempt);
    connection.close();
    this.peerConnections.delete(peerId);
    this.dataChannels.delete(peerId);

    const timer = window.setTimeout(() => {
      this.reconnectTimers.delete(peerId);
      void this.initiate(peerId).catch((error) => {
        console.error('[GeniusSend] échec de reconnexion WebRTC', { peerId, error });
        this.scheduleReconnect(peerId, connection);
      });
    }, 1_000 * attempt);

    this.reconnectTimers.set(peerId, timer);
  }

  private async handleDataChannelMessage(peerId: string, payload: Blob | ArrayBuffer | string) {
    if (typeof payload !== 'string') {
      const binaryPayload = await new Response(payload).arrayBuffer();
      const headers = this.pendingChunkHeaders.get(peerId) ?? [];
      const header = headers.shift();

      if (!header) {
        this.onStatusChange('Chunk binaire reçu sans en-tête', false);
        return;
      }

      if (headers.length === 0) {
        this.pendingChunkHeaders.delete(peerId);
      } else {
        this.pendingChunkHeaders.set(peerId, headers);
      }
      await this.handleChunkData(peerId, header, new Uint8Array(binaryPayload));
      return;
    }

    let message: TransferMessage;

    try {
      // On lit le message comme du JSON texte pour garder un format portable entre navigateurs.
      const rawMessage = typeof payload === 'string' ? payload : await new Response(payload).text();
      message = this.fileTransferProtocol.deserializeMessage(rawMessage) as TransferMessage;
    } catch (error) {
      console.error('Message de transfert invalide reçu :', error);
      this.onStatusChange('Message de transfert invalide', false);
      return;
    }

    // Une demande de transfert commence par un message d'initialisation.
    if (message.type === 'init') {
      if (!Number.isSafeInteger(message.fileSize) || message.fileSize < 0 || message.fileSize > MAX_FILE_SIZE_BYTES) {
        this.sendTransferResponse(peerId, message.transferId, message.fileName, false);
        this.onStatusChange('Fichier refusé : la taille maximale est de 10 Go', false);
        return;
      }
      const transferKey = this.transferKey(peerId, message.transferId);
      const preapproved = this.approvedOfflineTransfers.delete(transferKey);
      const pending = {
        fileName: message.fileName,
        mimeType: message.mimeType || 'application/octet-stream',
        totalChunks: message.totalChunks,
        chunks: new Map<number, Uint8Array>(),
        hash: message.hash,
        bytesReceived: 0,
        fileSize: message.fileSize,
        accepted: preapproved,
        peerId,
        transferId: message.transferId
      };
        mimeType: message.mimeType,

      this.pendingTransfers.set(this.transferKey(peerId, message.transferId), pending);
      if (preapproved) {
        this.sendTransferResponse(peerId, message.transferId, message.fileName, true);
        this.onTransferProgress?.({ peerId, direction: 'receiving', fileName: message.fileName, bytesTransferred: 0, totalBytes: message.fileSize });
        this.onStatusChange(`Transfert accepté : ${message.fileName}`, true);
        return;
      }
      this.onTransferRequest?.(peerId, {
        transferId: message.transferId,
        fileName: message.fileName,
        fileSize: message.fileSize,
        totalChunks: message.totalChunks,
        hash: message.hash,
        expiresInMs: message.acceptTimeoutMs || TRANSFER_ACCEPT_TIMEOUT_MS
      });
      const senderName = this.getPeerName?.(peerId) || 'Un appareil';
      this.onStatusChange(`${senderName} demande le transfert de ${message.fileName}`, true);
      return;
    }

    // Cette réponse débloque l’envoi côté émetteur.
    if (message.type === 'response') {
      const outgoing = this.outgoingTransfers.get(message.transferId);
      if (outgoing && outgoing) {
        // L’interface de l’expéditeur est informée dès l’arrivée de la décision.
        this.onTransferDecision?.({ peerId, transferId: message.transferId, fileName: message.fileName, accepted: message.accepted });
        this.onStatusChange(message.accepted ? `Transfert accepté : ${message.fileName}` : `Transfert refusé : ${message.fileName}`, message.accepted);

        if (!message.accepted) {
          this.outgoingTransfers.delete(message.transferId);
        }

        window.clearTimeout(outgoing.timeoutId);

        outgoing.resolve(message.accepted);
      }
      return;
    }

    if (message.type === 'chunk-ack') {
      const acknowledgement = this.pendingChunkAcks.get(this.chunkAckKey(message.transferId, message.chunkIndex));
      if (acknowledgement) {
        this.pendingChunkAcks.delete(this.chunkAckKey(message.transferId, message.chunkIndex));
        acknowledgement.resolve();
      }
      return;
    }

    if (message.type === 'cancel') {
      this.pendingTransfers.delete(this.transferKey(peerId, message.transferId));
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
        this.onTransferExpired?.(peerId, message.transferId);
        this.onStatusChange('La demande de transfert a expiré', false);
      } else {
        this.onTransferCancelled?.(peerId);
        this.onStatusChange('Transfert annulé par l’expéditeur', false);
      }
      return;
    }

    if (message.type === 'chunk-header') {
      const headers = this.pendingChunkHeaders.get(peerId) ?? [];
      headers.push(message);
      this.pendingChunkHeaders.set(peerId, headers);
      return;
    }

    // Les chunks ne sont stockés que si l'utilisateur a accepté le transfert.
    if (message.type === 'chunk') {
      await this.handleChunkData(peerId, message, Uint8Array.from(message.data));
      return;
    }

    if (message.type === 'end') {
      const transfer = this.pendingTransfers.get(this.transferKey(peerId, message.transferId));
      if (transfer && transfer.accepted) {
        await this.finalizeTransfer(peerId, transfer);
      }
    }
  }

  public approveOfflineTransfer(peerId: string, transferId: string) {
    this.approvedOfflineTransfers.add(this.transferKey(peerId, transferId));
  }

  private async handleChunkData(
    peerId: string,
    message: Extract<TransferMessage, { type: 'chunk-header' | 'chunk' }> ,
    byteArray: Uint8Array
  ) {
    // Les transferts sont indexés par pair ET transfert : ne jamais chercher avec peerId seul.
    const transfer = this.pendingTransfers.get(this.transferKey(peerId, message.transferId));
    if (!transfer || !transfer.accepted) {
      return;
    }

    // Un chunk déjà reçu ne doit pas être compté deux fois dans la progression.
    if (!transfer.chunks.has(message.chunkIndex)) {
      transfer.chunks.set(message.chunkIndex, byteArray);
      transfer.bytesReceived += byteArray.byteLength;
    }

      console.debug('[GeniusSend] chunk reçu', {
        peerId,
        transferId: transfer.transferId,
        chunkIndex: message.chunkIndex,
        chunkBytes: byteArray.byteLength,
        receivedChunks: transfer.chunks.size,
        totalChunks: transfer.totalChunks
      });

    this.onTransferProgress?.({
      peerId,
      direction: 'receiving',
      fileName: transfer.fileName,
      bytesTransferred: Math.min(transfer.fileSize, transfer.bytesReceived),
      totalBytes: transfer.fileSize
    });
    this.onStatusChange(`Réception : ${transfer.bytesReceived}/${transfer.fileSize} octets`, true);
    const windowComplete = (message.chunkIndex + 1) % TRANSFER_ACK_WINDOW === 0;
    const transferComplete = message.chunkIndex === transfer.totalChunks - 1;
    if (windowComplete || transferComplete) {
      this.sendChunkAcknowledgement(peerId, transfer.transferId, message.chunkIndex);
    }
  }

  private async finalizeTransfer(peerId: string, transfer: { fileName: string; mimeType: string; totalChunks: number; chunks: Map<number, Uint8Array>; hash: string; bytesReceived: number; fileSize: number; accepted: boolean; transferId: string }) {
    const missingChunks = Array.from({ length: transfer.totalChunks }, (_, index) => index)
      .filter((index) => !transfer.chunks.has(index));

    if (missingChunks.length > 0 || transfer.bytesReceived !== transfer.fileSize) {
      console.error('[GeniusSend] réception incomplète', {
        transferId: transfer.transferId,
        receivedBytes: transfer.bytesReceived,
        expectedBytes: transfer.fileSize,
        missingChunks
      });
      this.onStatusChange(`Réception incomplète : ${missingChunks.length} chunk(s) manquant(s)`, false);
      return;
    }

    // Reconstitution du fichier final à partir des morceaux reçus.
    const assembledChunks: ArrayBuffer[] = Array.from({ length: transfer.totalChunks }, (_, index) => {
      const chunk = transfer.chunks.get(index);
      if (!chunk) {
        return new ArrayBuffer(0);
      }

      return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
    });

    const rebuilt = this.fileTransferProtocol.assemble(assembledChunks);
    const computedHash = await this.fileTransferProtocol.computeHash(rebuilt.buffer);

    console.debug('[GeniusSend] hash vérifié', {
      transferId: transfer.transferId,
      expectedHash: transfer.hash,
      receivedHash: computedHash,
      bytes: rebuilt.byteLength
    });

    if (computedHash !== transfer.hash) {
      this.onStatusChange('Fichier corrompu : hash invalide', false);
      this.pendingTransfers.delete(peerId);
      return;
    }

    // Téléchargement automatique du fichier une fois vérifié.
    const file = new Blob([rebuilt], { type: transfer.mimeType });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = transfer.fileName;
    anchor.style.display = 'none';
    document.body.append(anchor);
    anchor.click();

    // Les navigateurs mobiles peuvent démarrer la lecture du Blob après click().
    // Révoquer l’URL dans le même tour de boucle annulait parfois le téléchargement.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      anchor.remove();
    }, 60_000);

    this.onTransferProgress?.({
      peerId,
      direction: 'receiving',
      fileName: transfer.fileName,
      bytesTransferred: transfer.fileSize,
      totalBytes: transfer.fileSize
    });

    this.onStatusChange(`Transfert terminé : ${transfer.fileName}`, true);
    this.pendingTransfers.delete(this.transferKey(peerId, transfer.transferId));
  }

  /** Envoie la décision du destinataire sur le canal déjà établi. */
  private sendTransferResponse(peerId: string, transferId: string, fileName: string, accepted: boolean) {
    const channel = this.dataChannels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      return;
    }

    const response: TransferMessage = {
      type: 'response',
      transferId,
      fileName,
      accepted
    };
    channel.send(this.fileTransferProtocol.serializeMessage(response));
  }

  /**
   * Évite de remplir la mémoire du navigateur lorsque le réseau est plus lent
   * que la boucle JavaScript qui prépare les chunks.
   */
  private waitForBuffer(channel: RTCDataChannel) {
    const maxBufferedAmount = 4 * 1024 * 1024;

    return new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000;
      const checkBuffer = () => {
        if (channel.readyState !== 'open') {
          reject(new Error('Le canal WebRTC a été fermé pendant le transfert'));
          return;
        }

        if (channel.bufferedAmount <= maxBufferedAmount) {
          resolve();
          return;
        }

        if (Date.now() >= deadline) {
          reject(new Error('Le buffer WebRTC est resté plein trop longtemps'));
          return;
        }

        window.setTimeout(checkBuffer, 50);
      };

      checkBuffer();
    });
  }

  private transferKey(peerId: string, transferId: string) {
    return `${peerId}:${transferId}`;
  }

  private peerDisplayName(peerId: string) {
    return this.getPeerName?.(peerId) || 'l’appareil distant';
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

  private waitForChunkAcknowledgement(transferId: string, chunkIndex: number) {
    return new Promise<void>((resolve, reject) => {
      const key = this.chunkAckKey(transferId, chunkIndex);
      const timeout = window.setTimeout(() => {
        this.pendingChunkAcks.delete(key);
        reject(new Error(`Le chunk ${chunkIndex} n’a pas été confirmé`));
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

  private sendChunkAcknowledgement(peerId: string, transferId: string, chunkIndex: number) {
    const channel = this.dataChannels.get(peerId);
    if (!channel || channel.readyState !== 'open') {
      return;
    }

    const acknowledgement: TransferMessage = {
      type: 'chunk-ack',
      transferId,
      chunkIndex
    };
    channel.send(this.fileTransferProtocol.serializeMessage(acknowledgement));
  }

  private createTransferId() {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    const randomPart = Math.random().toString(36).slice(2);
    return `transfer-${Date.now().toString(36)}-${randomPart}`;
  }
}
