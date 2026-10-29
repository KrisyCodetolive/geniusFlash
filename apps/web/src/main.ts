import './styles.css';
import { io, type Socket } from 'socket.io-client';
import { PeerConnectionManager } from './webrtc';

type Peer = {
  id: string;
  name: string;
  platform: string;
  status: string;
};

const app = document.querySelector('#app');

if (!app) {
  throw new Error('Root app element not found');
}

const platformLabel: Record<string, string> = {
  android: 'Android',
  ios: 'iPhone',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  unknown: 'Inconnu'
};

function detectPlatform(): Peer['platform'] {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform.toLowerCase();

  if (/iphone|ipad|ipod/.test(userAgent) || (platform.includes('mac') && 'ontouchend' in document)) {
    return 'ios';
  }

  if (userAgent.includes('android')) {
    return 'android';
  }

  if (userAgent.includes('windows')) {
    return 'windows';
  }

  if (userAgent.includes('mac os') || platform.includes('mac')) {
    return 'macos';
  }

  if (userAgent.includes('linux')) {
    return 'linux';
  }

  return 'unknown';
}

// Le nom choisi reste sur cet appareil pour éviter de le ressaisir à chaque visite.
const detectedPlatform = detectPlatform();
const savedDeviceName = localStorage.getItem('geniussend-device-name');
const defaultDeviceName = savedDeviceName || platformLabel[detectedPlatform] || 'Mon appareil';
const deviceIdStorageKey = 'geniussend-device-id';
function createDeviceId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const deviceId = localStorage.getItem(deviceIdStorageKey) || createDeviceId();
localStorage.setItem(deviceIdStorageKey, deviceId);

// Le navigateur joint le serveur sur la même origine que la page : /socket.io est relayé
// vers le serveur de signalisation par nginx en production et par Vite en développement.
const signalingUrl = window.location.origin;

const peerState = {
  id: '',
  peers: [] as Peer[],
  socket: null as Socket | null,
  selectedPeerId: '',
  manager: null as PeerConnectionManager | null,
  fileInput: null as HTMLInputElement | null,
  deviceName: defaultDeviceName,
  activeTransferPeerId: ''
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return entities[character];
  });
}

app.innerHTML = `
  <main class="shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">Transfert de fichiers en réseau local</p>
        <h1>GENIUSSEND</h1>
      </div>
      <div class="topbar-actions">
        <button class="secondary-button" id="install-button" type="button" hidden>Installer l’application</button>
        <button class="icon-button" id="profile-button" type="button" aria-label="Ouvrir le profil" title="Profil">👤</button>
        <button class="primary-button" id="refresh-btn" type="button">Actualiser</button>
      </div>
    </header>

    <section class="panel status-panel">
      <div>
        <span class="status-dot" id="connection-indicator"></span>
        <span id="connection-status">Connexion au serveur…</span>
      </div>
      <div class="transfer-status" id="transfer-status">Prêt pour un transfert</div>
      <div class="transfer-countdown" id="transfer-countdown" hidden></div>
      <div class="device-meta" id="device-meta">Appareil local</div>
    </section>

    <section class="panel profile-panel" id="profile-panel" hidden>
      <h2>Profil de l’appareil</h2>
      <div class="profile-fields">
        <label for="system-name">Nom du système</label>
        <input id="system-name" type="text" readonly />
        <p class="field-help">Le nom du système est détecté automatiquement et ne peut pas être modifié.</p>

        <label for="device-name">Nom de l’utilisateur</label>
        <div class="identity-form">
          <input id="device-name" type="text" maxlength="40" placeholder="Ex. iPhone de Marie" />
          <button class="secondary-button" id="save-device-name" type="button">Enregistrer</button>
        </div>
        <button class="secondary-button" id="push-button" type="button" disabled>Notifications indisponibles</button>
        <p class="field-help" id="push-status">Les notifications signalent les demandes quand cet appareil est hors ligne.</p>
      </div>
    </section>

    <section class="panel">
      <h2>Appareils disponibles</h2>
      <ul class="device-list" id="device-list"></ul>
    </section>

    <section class="panel" id="transfer-panel" hidden>
      <h2 id="transfer-title">Demande de transfert</h2>
      <p id="transfer-message">Aucun transfert en cours.</p>
      <p class="request-countdown" id="request-countdown" hidden></p>
      <div class="transfer-actions">
        <button class="primary-button" id="accept-transfer" type="button">Accepter</button>
        <button class="secondary-button" id="reject-transfer" type="button">Refuser</button>
      </div>
    </section>

    <section class="panel notification-panel" id="notification-panel" hidden>
      <h2 id="notification-title">Notification</h2>
      <p id="notification-message"></p>
      <button class="secondary-button" id="close-notification" type="button">Fermer</button>
    </section>

    <section class="panel" id="received-texts-panel" hidden>
      <h2>Textes reçus</h2>
      <ul class="text-list" id="received-texts"></ul>
    </section>

    <section class="panel progress-panel" id="progress-panel" hidden>
      <div class="progress-heading">
        <h2 id="progress-title">Transfert en cours</h2>
        <strong id="progress-percent">0 %</strong>
      </div>
      <progress id="transfer-progress" value="0" max="100"></progress>
      <p id="progress-details">Préparation du transfert…</p>
      <button class="secondary-button" id="cancel-transfer" type="button">Annuler le transfert</button>
    </section>

    <section class="panel">
      <h2 id="target-title">Sélectionnez un appareil</h2>
      <button class="secondary-button" id="file-button" type="button">Choisir un fichier</button>
      <input id="file-input" type="file" hidden />
      <div class="text-share">
        <label for="text-input">Ou envoyez un texte</label>
        <textarea id="text-input" rows="4" placeholder="Saisissez ou collez un texte, un lien, un code…"></textarea>
        <div class="text-actions">
          <button class="secondary-button" id="paste-text" type="button" hidden>Coller</button>
          <button class="primary-button" id="send-text" type="button">Envoyer le texte</button>
        </div>
      </div>
    </section>
  </main>
`;

const connectionIndicator = document.querySelector('#connection-indicator');
const connectionStatus = document.querySelector('#connection-status');
const transferStatus = document.querySelector('#transfer-status');
const transferCountdown = document.querySelector('#transfer-countdown') as HTMLDivElement | null;
const deviceMeta = document.querySelector('#device-meta');
const refreshBtn = document.querySelector('#refresh-btn');
const profileButton = document.querySelector('#profile-button') as HTMLButtonElement | null;
const installButton = document.querySelector('#install-button') as HTMLButtonElement | null;
const profilePanel = document.querySelector('#profile-panel') as HTMLDivElement | null;
const systemNameInput = document.querySelector('#system-name') as HTMLInputElement | null;
const deviceNameInput = document.querySelector('#device-name') as HTMLInputElement | null;
const saveDeviceNameBtn = document.querySelector('#save-device-name') as HTMLButtonElement | null;
const pushButton = document.querySelector('#push-button') as HTMLButtonElement | null;
const pushStatus = document.querySelector('#push-status') as HTMLParagraphElement | null;
const deviceList = document.querySelector('#device-list');
const targetTitle = document.querySelector('#target-title');
const fileButton = document.querySelector('#file-button');
const fileInput = document.querySelector('#file-input') as HTMLInputElement | null;
const textInput = document.querySelector('#text-input') as HTMLTextAreaElement | null;
const pasteTextBtn = document.querySelector('#paste-text') as HTMLButtonElement | null;
const sendTextBtn = document.querySelector('#send-text') as HTMLButtonElement | null;
const receivedTextsPanel = document.querySelector('#received-texts-panel') as HTMLElement | null;
const receivedTexts = document.querySelector('#received-texts') as HTMLUListElement | null;
const transferPanel = document.querySelector('#transfer-panel') as HTMLDivElement | null;
const transferTitle = document.querySelector('#transfer-title') as HTMLHeadingElement | null;
const transferMessage = document.querySelector('#transfer-message') as HTMLParagraphElement | null;
const requestCountdown = document.querySelector('#request-countdown') as HTMLParagraphElement | null;
const acceptTransferBtn = document.querySelector('#accept-transfer') as HTMLButtonElement | null;
const rejectTransferBtn = document.querySelector('#reject-transfer') as HTMLButtonElement | null;
const notificationPanel = document.querySelector('#notification-panel') as HTMLDivElement | null;
const notificationTitle = document.querySelector('#notification-title') as HTMLHeadingElement | null;
const notificationMessage = document.querySelector('#notification-message') as HTMLParagraphElement | null;
const closeNotificationBtn = document.querySelector('#close-notification') as HTMLButtonElement | null;
let transferStatusTimeout: number | undefined;
const progressState = {
  fileName: '',
  startedAt: 0
};
const progressPanel = document.querySelector('#progress-panel') as HTMLDivElement | null;
const progressTitle = document.querySelector('#progress-title') as HTMLHeadingElement | null;
const progressPercent = document.querySelector('#progress-percent') as HTMLElement | null;
const transferProgress = document.querySelector('#transfer-progress') as HTMLProgressElement | null;
const progressDetails = document.querySelector('#progress-details') as HTMLParagraphElement | null;
const cancelTransferBtn = document.querySelector('#cancel-transfer') as HTMLButtonElement | null;
type TransferRequestInfo = { transferId: string; fileName: string; fileSize: number; totalChunks: number; hash: string; expiresInMs: number; mimeType?: string; senderName?: string; expiresAt?: number };
type CountdownEntry = { peerId: string; fileName: string; expiresAt: number; role: 'sender' | 'recipient'; intervalId: number };
const transferCountdowns = new Map<string, CountdownEntry>();
const transferRequestQueue: Array<{ peerId: string; transfer: TransferRequestInfo; offline?: boolean }> = [];
let activeTransferRequest: { peerId: string; transfer: TransferRequestInfo; offline?: boolean } | null = null;
const offlineRequestWaiters = new Map<string, { peerId: string; resolve: (accepted: boolean) => void; timeoutId: number }>();
let vapidPublicKey: string | null = null;

peerState.fileInput = fileInput;

if (deviceNameInput) {
  deviceNameInput.value = peerState.deviceName;
}

if (systemNameInput) {
  systemNameInput.value = platformLabel[detectedPlatform] || 'Inconnu';
}

function updateServerStatus(status: string, connected: boolean) {
  if (connectionIndicator) {
    connectionIndicator.classList.toggle('connected', connected);
  }

  if (connectionStatus) {
    connectionStatus.textContent = status;
  }
}

function updateTransferStatus(status: string) {
  if (transferStatus) {
    transferStatus.textContent = status;
  }
}

function showTemporaryTransferStatus(status: string, durationInMilliseconds: number) {
  updateTransferStatus(status);

  if (transferStatusTimeout !== undefined) {
    window.clearTimeout(transferStatusTimeout);
  }

  transferStatusTimeout = window.setTimeout(() => {
    updateTransferStatus('Prêt pour un transfert');
    transferStatusTimeout = undefined;
  }, durationInMilliseconds);
}

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function renderTransferCountdowns() {
  const senderCountdowns = Array.from(transferCountdowns.values())
    .filter((entry) => entry.role === 'sender')
    .map((entry) => {
      const seconds = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
      return `${getPeerDisplayName(entry.peerId)} · ${formatCountdown(seconds)}`;
    });

  if (transferCountdown) {
    transferCountdown.hidden = senderCountdowns.length === 0;
    transferCountdown.textContent = senderCountdowns.length > 0
      ? `En attente d’acceptation : ${senderCountdowns.join(' | ')}`
      : '';
  }

  if (requestCountdown) {
    const active = activeTransferRequest
      ? transferCountdowns.get(activeTransferRequest.transfer.transferId)
      : undefined;
    if (active?.role === 'recipient') {
      const seconds = Math.max(0, Math.ceil((active.expiresAt - Date.now()) / 1000));
      requestCountdown.textContent = `Temps restant pour accepter : ${formatCountdown(seconds)}`;
      requestCountdown.hidden = false;
    } else {
      requestCountdown.hidden = true;
      requestCountdown.textContent = '';
    }
  }
}

function startTransferCountdown(peerId: string, transferId: string, fileName: string, expiresInMs: number, role: 'sender' | 'recipient') {
  clearTransferCountdown(transferId);
  const entry: CountdownEntry = {
    peerId,
    fileName,
    expiresAt: Date.now() + expiresInMs,
    role,
    intervalId: 0
  };
  entry.intervalId = window.setInterval(() => {
    renderTransferCountdowns();
    if (Date.now() >= entry.expiresAt) {
      window.clearInterval(entry.intervalId);
    }
  }, 250);
  transferCountdowns.set(transferId, entry);
  renderTransferCountdowns();
}

function clearTransferCountdown(transferId: string) {
  const entry = transferCountdowns.get(transferId);
  if (entry) {
    window.clearInterval(entry.intervalId);
    transferCountdowns.delete(transferId);
  }
  renderTransferCountdowns();
}

function expireTransferRequest(peerId: string, transferId: string) {
  clearTransferCountdown(transferId);
  const wasActive = activeTransferRequest?.transfer.transferId === transferId;
  for (let index = transferRequestQueue.length - 1; index >= 0; index -= 1) {
    if (transferRequestQueue[index].transfer.transferId === transferId) {
      transferRequestQueue.splice(index, 1);
    }
  }
  if (wasActive) {
    activeTransferRequest = null;
    renderNextTransferRequest();
  }
  if (peerState.activeTransferPeerId === peerId) {
    peerState.activeTransferPeerId = '';
  }
  showTemporaryTransferStatus('La demande de transfert a expiré', 5_000);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} o`;
  }

  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'terminé';
  }

  if (seconds < 60) {
    return `${Math.ceil(seconds)} s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `${minutes} min ${remainingSeconds} s`;
}

function updateTransferProgress(progress: { peerId: string; direction: 'sending' | 'receiving'; fileName: string; bytesTransferred: number; totalBytes: number }) {
  peerState.activeTransferPeerId = progress.peerId;
  if (progress.fileName !== progressState.fileName || progress.bytesTransferred === 0) {
    progressState.fileName = progress.fileName;
    progressState.startedAt = performance.now();
  }

  const percent = progress.totalBytes === 0 ? 100 : Math.round((progress.bytesTransferred / progress.totalBytes) * 100);
  const elapsedSeconds = Math.max((performance.now() - progressState.startedAt) / 1000, 0.001);
  const bytesPerSecond = progress.bytesTransferred / elapsedSeconds;
  const remainingBytes = Math.max(progress.totalBytes - progress.bytesTransferred, 0);
  const remainingSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Number.POSITIVE_INFINITY;

  if (progressPanel) {
    progressPanel.hidden = false;
  }

  if (cancelTransferBtn) {
    cancelTransferBtn.hidden = false;
  }

  if (progressTitle) {
    const peerName = getPeerDisplayName(progress.peerId);
    progressTitle.textContent = progress.direction === 'sending'
      ? `Envoi à ${peerName} : ${progress.fileName}`
      : `Réception de ${progress.fileName} de ${peerName}`;
  }

  if (progressPercent) {
    progressPercent.textContent = `${percent} %`;
  }

  if (transferProgress) {
    transferProgress.value = percent;
  }

  if (progressDetails) {
    progressDetails.textContent = `${formatBytes(progress.bytesTransferred)} sur ${formatBytes(progress.totalBytes)} · ${formatBytes(bytesPerSecond)}/s · ${formatDuration(remainingSeconds)}`;
  }

  // Le panneau disparaît dès que l’envoi ou la réception est terminé.
  if (progressPanel && percent >= 100) {
    progressPanel.hidden = true;
    peerState.activeTransferPeerId = '';
    if (cancelTransferBtn) {
      cancelTransferBtn.hidden = true;
    }
  }
}

function showNotification(title: string, message: string) {
  if (!notificationPanel || !notificationTitle || !notificationMessage) {
    return;
  }

  notificationTitle.textContent = title;
  notificationMessage.textContent = message;
  notificationPanel.hidden = false;
}

// L’API Clipboard n’existe qu’en HTTPS : en HTTP sur le réseau local, on passe par une sélection.
async function copyToClipboard(text: string) {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // On tente la méthode de secours ci-dessous.
    }
  }

  const helper = document.createElement('textarea');
  helper.value = text;
  helper.setAttribute('readonly', '');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.append(helper);
  helper.select();
  helper.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  helper.remove();
  return copied;
}

function addReceivedText(peerId: string, text: string) {
  if (!receivedTextsPanel || !receivedTexts) {
    return;
  }

  const item = document.createElement('li');
  const meta = document.createElement('div');
  meta.className = 'text-meta';
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${getPeerDisplayName(peerId)} · ${time}`;

  // textContent : le texte reçu n’est jamais interprété comme du HTML.
  const content = document.createElement('p');
  content.className = 'text-content';
  content.textContent = text;

  const copyButton = document.createElement('button');
  copyButton.className = 'secondary-button';
  copyButton.type = 'button';
  copyButton.textContent = 'Copier';
  copyButton.addEventListener('click', async () => {
    const copied = await copyToClipboard(text);
    copyButton.textContent = copied ? 'Copié ✓' : 'Copie impossible : sélectionnez le texte';
    window.setTimeout(() => {
      copyButton.textContent = 'Copier';
    }, 2_000);
  });

  item.append(meta, content, copyButton);
  receivedTexts.prepend(item);
  receivedTextsPanel.hidden = false;
}

function refreshTransferInterface(options: { keepProgress: boolean }) {
  // On rafraîchit uniquement les éléments nécessaires, sans recharger le document.
  renderPeers();

  if (transferPanel) {
    transferPanel.hidden = true;
  }

  if (progressPanel && !options.keepProgress) {
    progressPanel.hidden = true;
  }

  if (cancelTransferBtn) {
    cancelTransferBtn.hidden = true;
  }

  if (!options.keepProgress) {
    peerState.activeTransferPeerId = '';
  }
}

function getPeerDisplayName(peerId: string) {
  const peer = peerState.peers.find((entry) => entry.id === peerId);
  const name = peer?.name.trim();
  const reservedNames = ['geniussend', 'appareil local'];

  if (name && !reservedNames.includes(name.toLowerCase())) {
    return name;
  }

  return peer ? platformLabel[peer.platform] || 'Cet utilisateur' : 'Cet utilisateur';
}

function renderPeers() {
  if (!deviceList) {
    return;
  }

  const availablePeers = peerState.peers.filter((peer) => peer.id !== peerState.id);

  if (availablePeers.length === 0) {
    deviceList.innerHTML = '<li class="empty-state">Aucun appareil disponible pour le moment.</li>';
    return;
  }

  deviceList.innerHTML = availablePeers
    .map((peer) => {
      const icon = peer.platform === 'windows' ? '🖥️' : peer.platform === 'ios' ? '📱' : peer.platform === 'android' ? '📱' : peer.platform === 'macos' ? '💻' : '🖥️';
      const selectedClass = peer.id === peerState.selectedPeerId ? ' selected' : '';
      return `
        <li class="${selectedClass.trim()}" data-peer-id="${escapeHtml(peer.id)}" aria-selected="${peer.id === peerState.selectedPeerId}">
          <span>${icon}</span>
          <div class="peer-meta">
            <strong>${escapeHtml(peer.name)}</strong>
            <small>${platformLabel[peer.platform] || 'Inconnu'} · ${peer.status}</small>
          </div>
        </li>
      `;
    })
    .join('');

  deviceList.querySelectorAll('li[data-peer-id]').forEach((item) => {
    item.addEventListener('click', () => {
      const peerId = item.getAttribute('data-peer-id');
      if (!peerId) {
        return;
      }

      const peer = peerState.peers.find((entry) => entry.id === peerId);
      if (!peer) {
        return;
      }

      peerState.selectedPeerId = peerId;
      renderPeers();

      if (targetTitle) {
        targetTitle.textContent = `${peer.name} — ${platformLabel[peer.platform] || 'Inconnu'}`;
      }

      if (peerState.manager && peer.status === 'online') {
        void peerState.manager.initiate(peerId);
      }
    });
  });
}

function renderNextTransferRequest() {
  if (!transferPanel || !transferTitle || !transferMessage) {
    return;
  }

  activeTransferRequest ??= transferRequestQueue.shift() ?? null;
  if (!activeTransferRequest) {
    transferPanel.hidden = true;
    renderTransferCountdowns();
    return;
  }

  const { peerId, transfer } = activeTransferRequest;

  transferPanel.hidden = false;
  const senderName = activeTransferRequest.transfer.senderName || getPeerDisplayName(peerId);
  transferTitle.textContent = `${senderName} vous envoie un fichier`;
  transferMessage.textContent = `${transfer.fileName} · ${transfer.fileSize} octets · ${transfer.totalChunks} chunks`;
  renderTransferCountdowns();

  if (acceptTransferBtn) {
    acceptTransferBtn.onclick = () => {
      clearTransferCountdown(transfer.transferId);
      if (activeTransferRequest?.offline) {
        peerState.manager?.approveOfflineTransfer(peerId, transfer.transferId);
        peerState.socket?.emit('transfer:offline:decision', { transferId: transfer.transferId, accepted: true });
      } else if (peerState.manager) {
        peerState.manager.acceptTransfer(peerId, transfer.transferId);
      }
      activeTransferRequest = null;
      refreshTransferInterface({ keepProgress: true });
      renderNextTransferRequest();
    };
  }

  if (rejectTransferBtn) {
    rejectTransferBtn.onclick = () => {
      clearTransferCountdown(transfer.transferId);
      if (activeTransferRequest?.offline) {
        peerState.socket?.emit('transfer:offline:decision', { transferId: transfer.transferId, accepted: false });
      } else if (peerState.manager) {
        peerState.manager.rejectTransfer(peerId, transfer.transferId);
      }
      activeTransferRequest = null;
      refreshTransferInterface({ keepProgress: false });
      showTemporaryTransferStatus('Transfert refusé', 5_000);
      renderNextTransferRequest();
    };
  }
}

function showTransferRequest(peerId: string, transfer: TransferRequestInfo, offline = false) {
  if (activeTransferRequest?.transfer.transferId === transfer.transferId || transferRequestQueue.some((entry) => entry.transfer.transferId === transfer.transferId)) return;
  const expiresInMs = transfer.expiresAt ? Math.max(0, transfer.expiresAt - Date.now()) : transfer.expiresInMs;
  transferRequestQueue.push({ peerId, transfer, offline });
  startTransferCountdown(peerId, transfer.transferId, transfer.fileName, expiresInMs, 'recipient');
  renderNextTransferRequest();
}

function registerLocalPeer(socket: Socket) {
  // Le serveur diffuse cette identité à tous les appareils connectés.
  socket.emit('peer:register', {
    id: deviceId,
    name: peerState.deviceName,
    platform: detectedPlatform,
    status: 'online'
  });
}

function createClientSocket() {
  const socket = io(signalingUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    peerState.id = deviceId;
    updateServerStatus('Serveur connecté', true);

    if (deviceMeta) {
      deviceMeta.textContent = `${peerState.deviceName} · ${platformLabel[detectedPlatform]}`;
    }

    registerLocalPeer(socket);

    if (!peerState.manager) {
      peerState.manager = new PeerConnectionManager({
        localPeerId: peerState.id,
        sendSignal: (type, payload, to) => {
          socket.emit('signal:message', {
            type,
            payload,
            from: peerState.id,
            to
          });
        },
        onStatusChange: (status) => updateTransferStatus(status),
        onTransferRequest: (peerId, transfer) => showTransferRequest(peerId, transfer),
        onTransferPending: ({ peerId, transferId, fileName, expiresInMs }) => {
          startTransferCountdown(peerId, transferId, fileName, expiresInMs, 'sender');
          peerState.activeTransferPeerId = peerId;
          if (progressPanel) progressPanel.hidden = false;
          if (cancelTransferBtn) cancelTransferBtn.hidden = false;
          if (progressTitle) progressTitle.textContent = `En attente de ${getPeerDisplayName(peerId)} : ${fileName}`;
          if (progressDetails) progressDetails.textContent = 'Le fichier reste dans cette page pendant l’attente. Gardez GeniusSend ouvert.';
        },
        onTransferExpired: (peerId, transferId) => {
          expireTransferRequest(peerId, transferId);
        },
        onTransferProgress: updateTransferProgress,
        onTextReceived: (peerId, text) => {
          addReceivedText(peerId, text);
          showTemporaryTransferStatus(`Nouveau texte de ${getPeerDisplayName(peerId)}`, 5_000);
        },
        onTextDelivered: (peerId) => {
          showTemporaryTransferStatus(`Texte reçu par ${getPeerDisplayName(peerId)}`, 5_000);
        },
        onTransferCancelled: (peerId) => {
          if (peerState.activeTransferPeerId === peerId) {
            refreshTransferInterface({ keepProgress: false });
            showTemporaryTransferStatus('Transfert annulé', 5_000);
          }
        },
        requestOfflineTransfer: (request) => new Promise<boolean>((resolve) => {
          const timeoutId = window.setTimeout(() => {
            offlineRequestWaiters.delete(request.transferId);
            socket.emit('transfer:offline:cancel', { transferId: request.transferId });
            resolve(false);
          }, request.expiresInMs);
          offlineRequestWaiters.set(request.transferId, { peerId: request.to, resolve, timeoutId });
          socket.emit('transfer:offline:request', request);
        }),
        cancelOfflineTransfer: (peerId) => {
          for (const [transferId, waiter] of offlineRequestWaiters) {
            if (waiter.peerId !== peerId) continue;
            window.clearTimeout(waiter.timeoutId);
            offlineRequestWaiters.delete(transferId);
            socket.emit('transfer:offline:cancel', { transferId });
            waiter.resolve(false);
          }
        },
        getPeerName: getPeerDisplayName,
        onTransferDecision: ({ peerId, transferId, accepted }) => {
          clearTransferCountdown(transferId);
          if (!accepted) {
            const peerName = getPeerDisplayName(peerId);
            showNotification('Transfert refusé', `${peerName} a refusé le transfert.`);
            updateTransferStatus(`${peerName} a refusé le transfert`);
          }
        }
      });
    }
  });

  socket.on('disconnect', () => {
    updateServerStatus('Connexion perdue', false);
    for (const [transferId, waiter] of offlineRequestWaiters) {
      window.clearTimeout(waiter.timeoutId);
      offlineRequestWaiters.delete(transferId);
      clearTransferCountdown(transferId);
      waiter.resolve(false);
    }
  });

  socket.on('peers:list', (peers: Peer[]) => {
    peerState.peers = peers;
    renderPeers();
  });

  socket.on('signal:message', (payload) => {
    if (peerState.manager) {
      void peerState.manager.handleIncoming(payload);
    }
  });

  socket.on('push:config', ({ publicKey, configured }: { publicKey: string | null; configured: boolean }) => {
    vapidPublicKey = publicKey;
    if (pushButton) {
      pushButton.disabled = !configured || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window);
      pushButton.textContent = configured ? 'Activer les notifications' : 'Notifications non configurées';
    }
    if (pushStatus && !configured) pushStatus.textContent = 'Le serveur doit être configuré avec ses clés VAPID pour envoyer des notifications.';
  });

  socket.on('transfer:offline:request', (request: TransferRequestInfo & { from: string }) => {
    const expiresInMs = Math.max(0, (request.expiresAt ?? Date.now()) - Date.now());
    showTransferRequest(request.from, { ...request, expiresInMs }, true);
    if (expiresInMs === 0) socket.emit('transfer:offline:decision', { transferId: request.transferId, accepted: false });
  });

  socket.on('transfer:offline:decision', ({ transferId, accepted }: { transferId: string; accepted: boolean }) => {
    const waiter = offlineRequestWaiters.get(transferId);
    if (!waiter) return;
    window.clearTimeout(waiter.timeoutId);
    offlineRequestWaiters.delete(transferId);
    clearTransferCountdown(transferId);
    waiter.resolve(accepted);
  });

  socket.on('transfer:offline:queued', ({ pushSent }: { pushSent: boolean }) => {
    if (progressDetails) {
      progressDetails.textContent = pushSent
        ? 'Demande en attente. Une notification a été envoyée au destinataire.'
        : 'Demande en attente. Gardez cette page ouverte ; le destinataire la recevra à sa prochaine connexion.';
    }
  });

  socket.on('transfer:offline:expired', ({ transferId, reason }: { transferId: string; reason: string }) => {
    const waiter = offlineRequestWaiters.get(transferId);
    if (waiter) {
      window.clearTimeout(waiter.timeoutId);
      offlineRequestWaiters.delete(transferId);
      waiter.resolve(false);
    }
    const request = activeTransferRequest?.transfer.transferId === transferId ? activeTransferRequest : transferRequestQueue.find((entry) => entry.transfer.transferId === transferId);
    if (request) expireTransferRequest(request.peerId, transferId);
    if (reason === 'sender-disconnected') showTemporaryTransferStatus('L’expéditeur s’est déconnecté : demande annulée', 5_000);
  });

  socket.on('transfer:offline:cancelled', ({ transferId }: { transferId: string }) => {
    const request = activeTransferRequest?.transfer.transferId === transferId ? activeTransferRequest : transferRequestQueue.find((entry) => entry.transfer.transferId === transferId);
    if (request) expireTransferRequest(request.peerId, transferId);
  });

  socket.on('transfer:offline:error', ({ transferId, message }: { transferId: string; message: string }) => {
    const waiter = offlineRequestWaiters.get(transferId);
    if (!waiter) return;
    window.clearTimeout(waiter.timeoutId);
    offlineRequestWaiters.delete(transferId);
    waiter.resolve(false);
    showTemporaryTransferStatus(message, 5_000);
  });

  return socket;
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    if (peerState.socket) {
      peerState.socket.emit('peer:heartbeat');
    }
  });
}

function decodeVapidKey(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

if (pushButton) {
  pushButton.addEventListener('click', async () => {
    if (!vapidPublicKey || !peerState.socket?.connected) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        if (pushStatus) pushStatus.textContent = 'La permission de notification n’a pas été accordée.';
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(vapidPublicKey) });
      const result = new Promise<{ ok: boolean; message?: string }>((resolve) => peerState.socket?.once('push:subscription-result', resolve));
      peerState.socket.emit('push:subscribe', subscription.toJSON());
      const saved = await result;
      if (pushStatus) pushStatus.textContent = saved.ok ? 'Notifications activées sur cet appareil.' : saved.message || 'Impossible d’enregistrer les notifications.';
      if (saved.ok) pushButton.textContent = 'Notifications activées';
    } catch (error) {
      console.error('[GeniusSend] Push setup failed:', error);
      if (pushStatus) pushStatus.textContent = 'Activation impossible. Vérifiez HTTPS, la permission et les réglages du navigateur.';
    }
  });
}

if (profileButton && profilePanel) {
  profileButton.addEventListener('click', () => {
    profilePanel.hidden = !profilePanel.hidden;
  });
}

if (closeNotificationBtn && notificationPanel) {
  closeNotificationBtn.addEventListener('click', () => {
    notificationPanel.hidden = true;
  });
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};
let installPrompt: InstallPromptEvent | null = null;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[GeniusSend] Enregistrement du service worker impossible:', error);
    });
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
  if (installButton) {
    installButton.hidden = false;
    installButton.textContent = 'Installer l’application';
  }
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  if (installButton) installButton.hidden = true;
});

if (installButton) {
  const userAgent = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(userAgent)
    || (navigator.platform.toLowerCase().includes('mac') && 'ontouchend' in document);
  const isAndroid = /android/i.test(userAgent);
  const isMobile = isIos || isAndroid || /mobile/i.test(userAgent);
  const isInstalled = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

  if (isMobile && !isInstalled) {
    installButton.hidden = false;
    installButton.textContent = 'Installer l’application';
  } else if (isInstalled) {
    installButton.hidden = true;
  }

  installButton.addEventListener('click', async () => {
    if (installPrompt) {
      try {
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice.outcome === 'accepted') installButton.hidden = true;
      } catch (error) {
        console.warn('[GeniusSend] Invite d’installation indisponible:', error);
        showNotification('Installation de GeniusSend', getInstallInstructions());
      }
      installPrompt = null;
      return;
    }
    showNotification('Installer GeniusSend', getInstallInstructions());
  });
}

function getInstallInstructions() {
  if (!window.isSecureContext) {
    return 'Ouvrez GeniusSend avec une adresse HTTPS pour installer la PWA. Une adresse HTTP sur le réseau local ne suffit pas.';
  }
  if (isIosDevice()) {
    return 'Dans Safari, touchez Partager, puis « Sur l’écran d’accueil ». Ensuite, touchez Ajouter.';
  }
  return 'Ouvrez le menu de votre navigateur (⋮), puis choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ». '; 
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform.toLowerCase().includes('mac') && 'ontouchend' in document);
}

if (cancelTransferBtn) {
  cancelTransferBtn.addEventListener('click', () => {
    const peerId = peerState.activeTransferPeerId || peerState.selectedPeerId;
    if (peerId && peerState.manager) {
      peerState.manager.cancelTransfer(peerId);
    }

    refreshTransferInterface({ keepProgress: false });
    showTemporaryTransferStatus('Transfert annulé', 5_000);
  });
}

if (saveDeviceNameBtn && deviceNameInput) {
  saveDeviceNameBtn.addEventListener('click', () => {
    const name = deviceNameInput.value.trim();

    if (!name) {
      deviceNameInput.value = peerState.deviceName;
      return;
    }

    peerState.deviceName = name;
    localStorage.setItem('geniussend-device-name', name);

    if (deviceMeta) {
      deviceMeta.textContent = `${name} · ${platformLabel[detectedPlatform]}`;
    }

    if (peerState.socket?.connected) {
      registerLocalPeer(peerState.socket);
    }

    // Le panneau se referme après l’enregistrement pour confirmer la modification.
    if (profilePanel) {
      profilePanel.hidden = true;
    }
  });
}

if (fileButton && fileInput) {
  fileButton.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    const targetPeerId = peerState.selectedPeerId;

    if (!file) {
      updateTransferStatus('Aucun fichier sélectionné');
      return;
    }

    if (!targetPeerId) {
      updateTransferStatus('Sélectionnez un destinataire avant de choisir un fichier');
      return;
    }

    if (!peerState.manager) {
      updateTransferStatus('Connexion WebRTC indisponible');
      return;
    }

    updateTransferStatus(`Préparation de ${file.name}…`);
    try {
      // On envoie le fichier sélectionné uniquement si un pair cible a déjà été choisi.
      const isOffline = peerState.peers.find((peer) => peer.id === targetPeerId)?.status !== 'online';
      await peerState.manager.sendFile(targetPeerId, file, isOffline);
      updateTransferStatus(`Envoi de ${file.name}…`);
    } catch (error) {
      console.error('[GeniusSend] échec de l’envoi', error);
      updateTransferStatus(error instanceof Error ? error.message : 'Échec de l’envoi du fichier');
    }
  });
}

if (textInput && sendTextBtn) {
  const sendText = async () => {
    const text = textInput.value;
    const targetPeerId = peerState.selectedPeerId;

    if (!text.trim()) {
      updateTransferStatus('Saisissez un texte à envoyer');
      return;
    }

    if (!targetPeerId) {
      updateTransferStatus('Sélectionnez un destinataire avant d’envoyer un texte');
      return;
    }

    if (!peerState.manager) {
      updateTransferStatus('Connexion WebRTC indisponible');
      return;
    }

    sendTextBtn.disabled = true;
    try {
      await peerState.manager.sendText(targetPeerId, text);
      textInput.value = '';
    } catch (error) {
      console.error('[GeniusSend] échec de l’envoi du texte', error);
      updateTransferStatus(error instanceof Error ? error.message : 'Échec de l’envoi du texte');
    } finally {
      sendTextBtn.disabled = false;
    }
  };

  sendTextBtn.addEventListener('click', () => {
    void sendText();
  });

  // Ctrl+Entrée (ou Cmd+Entrée) envoie le texte sans quitter le clavier.
  textInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendText();
    }
  });
}

// La lecture du presse-papiers exige HTTPS ; sinon on garde le collage classique (Ctrl+V, appui long).
if (pasteTextBtn && textInput && window.isSecureContext && navigator.clipboard?.readText) {
  pasteTextBtn.hidden = false;
  pasteTextBtn.addEventListener('click', async () => {
    try {
      textInput.value = await navigator.clipboard.readText();
      textInput.focus();
    } catch {
      updateTransferStatus('Accès au presse-papiers refusé : collez avec Ctrl+V ou un appui long');
    }
  });
}

peerState.socket = createClientSocket();
renderPeers();
