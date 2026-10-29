import './styles.css';
import qrcode from 'qrcode-generator';
import { io, type Socket } from 'socket.io-client';
import { icon, platformIcon } from './icons';
import { isIosDevice, setupInstall } from './install';
import { PeerConnectionManager, type TransferProgress, type TransferResult } from './webrtc';

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

  if (isIosDevice()) {
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

// Un nom unique par défaut évite d’avoir plusieurs appareils appelés simplement « Windows ».
function generateDeviceName() {
  const animals = ['Renard', 'Panda', 'Hibou', 'Loutre', 'Lynx', 'Koala', 'Dauphin', 'Faucon', 'Castor', 'Pingouin', 'Zèbre', 'Tigre'];
  const colors = ['orange', 'turquoise', 'corail', 'indigo', 'émeraude', 'cerise', 'lavande', 'ambre', 'saphir', 'olive', 'ivoire', 'prune'];
  const pick = (values: string[]) => values[Math.floor(Math.random() * values.length)];
  return `${pick(animals)} ${pick(colors)}`;
}

// Le nom choisi reste sur cet appareil pour éviter de le ressaisir à chaque visite.
const detectedPlatform = detectPlatform();
const deviceNameStorageKey = 'geniussend-device-name';
const defaultDeviceName = localStorage.getItem(deviceNameStorageKey) || generateDeviceName();
localStorage.setItem(deviceNameStorageKey, defaultDeviceName);
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
      <div class="brand">
        <img class="brand-logo" src="/icons/icon-192.png" alt="" width="44" height="44" />
        <div>
          <h1>GeniusSend</h1>
          <p class="tagline">Partage direct entre vos appareils, en local</p>
        </div>
      </div>
      <div class="topbar-actions">
        <button class="install-button" id="install-button" type="button" aria-label="Installer l’application GeniusSend" hidden>
          ${icon('download')}<span>Installer<span class="install-label-extra"> l’app</span></span>
        </button>
        <button class="icon-button" id="profile-button" type="button" aria-label="Profil de cet appareil" aria-expanded="false" aria-controls="profile-panel" title="Profil">${icon('user')}</button>
      </div>
    </header>

    <section class="panel status-panel">
      <div class="status-line">
        <span class="status-dot" id="connection-indicator" aria-hidden="true"></span>
        <span id="connection-status">Connexion au serveur…</span>
      </div>
      <div class="transfer-status" id="transfer-status" role="status" aria-live="polite">Prêt pour un transfert</div>
      <div class="transfer-countdown" id="transfer-countdown" hidden></div>
      <div class="device-meta" id="device-meta"></div>
    </section>

    <section class="panel profile-panel" id="profile-panel" hidden>
      <h2>Profil de l’appareil</h2>
      <div class="profile-fields">
        <label for="system-name">Système</label>
        <input id="system-name" type="text" readonly />
        <p class="field-help">Le système est détecté automatiquement.</p>

        <label for="device-name">Nom affiché sur les autres appareils</label>
        <div class="identity-form">
          <input id="device-name" type="text" maxlength="40" placeholder="Ex. iPhone de Marie" />
          <button class="secondary-button" id="save-device-name" type="button">Enregistrer</button>
        </div>
        <div id="push-section" hidden>
          <button class="secondary-button" id="push-button" type="button" disabled>Notifications indisponibles</button>
          <p class="field-help" id="push-status">Les notifications signalent les demandes quand cet appareil est hors ligne.</p>
        </div>
      </div>
    </section>

    <section class="panel request-panel" id="transfer-panel" hidden>
      <div class="request-heading">
        <span class="request-icon">${icon('file')}</span>
        <div>
          <h2 id="transfer-title">Demande de transfert</h2>
          <p id="transfer-message"></p>
        </div>
      </div>
      <p class="request-countdown" id="request-countdown" hidden></p>
      <div class="transfer-actions">
        <button class="primary-button" id="accept-transfer" type="button">${icon('check')}Accepter</button>
        <button class="secondary-button" id="reject-transfer" type="button">Refuser</button>
      </div>
    </section>

    <section class="panel progress-panel" id="progress-panel" data-state="active" hidden>
      <div class="progress-heading">
        <h2 id="progress-title">Transfert en cours</h2>
        <strong id="progress-percent">0 %</strong>
      </div>
      <progress id="transfer-progress" value="0" max="100" aria-label="Progression du transfert"></progress>
      <p id="progress-details">Préparation du transfert…</p>
      <div class="progress-actions">
        <button class="secondary-button" id="cancel-transfer" type="button">Annuler</button>
        <button class="secondary-button" id="close-progress" type="button" hidden>Fermer</button>
      </div>
    </section>

    <section class="panel notification-panel" id="notification-panel" data-tone="info" hidden>
      <h2 id="notification-title">Notification</h2>
      <p id="notification-message"></p>
      <div class="notification-actions">
        <button class="primary-button" id="notification-action" type="button" hidden></button>
        <button class="secondary-button" id="close-notification" type="button">Fermer</button>
      </div>
    </section>

    <section class="panel">
      <h2>Appareils à proximité</h2>
      <ul class="device-list" id="device-list"></ul>
      <div class="empty-state" id="empty-state" hidden>
        <div class="qr-code" id="qr-code"></div>
        <div class="empty-copy">
          <strong>Aucun autre appareil pour l’instant</strong>
          <p>Scannez ce code avec votre téléphone, ou ouvrez cette adresse sur un autre appareil connecté au même Wi-Fi :</p>
          <a class="share-url" id="share-url"></a>
          <p class="field-help" id="share-hint" hidden>Cette adresse « localhost » ne fonctionne que sur ce PC : sur les autres appareils, utilisez l’adresse IP de ce PC.</p>
        </div>
      </div>
    </section>

    <section class="panel send-panel" id="send-panel" hidden>
      <h2 id="target-title">Envoyer</h2>
      <button class="dropzone" id="dropzone" type="button">
        <span class="dropzone-icon">${icon('upload')}</span>
        <strong>Choisir des fichiers</strong>
        <span class="dropzone-hint">ou glissez-les ici · Ctrl+V pour coller une image</span>
      </button>
      <input id="file-input" type="file" multiple hidden />
      <div class="text-share">
        <label for="text-input">Ou envoyez un texte</label>
        <textarea id="text-input" rows="4" placeholder="Saisissez ou collez un texte, un lien, un code…"></textarea>
        <div class="text-actions">
          <span class="text-hint">Ctrl + Entrée pour envoyer</span>
          <button class="secondary-button" id="paste-text" type="button" hidden>${icon('clipboard')}Coller</button>
          <button class="primary-button" id="send-text" type="button">${icon('send')}Envoyer le texte</button>
        </div>
      </div>
    </section>

    <section class="panel" id="history-panel" hidden>
      <div class="panel-heading">
        <h2>Activité récente</h2>
        <button class="text-button" id="clear-history" type="button">Tout effacer</button>
      </div>
      <ul class="history-list" id="history-list"></ul>
    </section>
  </main>
`;

const connectionIndicator = document.querySelector('#connection-indicator');
const connectionStatus = document.querySelector('#connection-status');
const transferStatus = document.querySelector('#transfer-status');
const transferCountdown = document.querySelector('#transfer-countdown') as HTMLDivElement | null;
const deviceMeta = document.querySelector('#device-meta');
const profileButton = document.querySelector('#profile-button') as HTMLButtonElement | null;
const installButton = document.querySelector('#install-button') as HTMLButtonElement | null;
const profilePanel = document.querySelector('#profile-panel') as HTMLDivElement | null;
const systemNameInput = document.querySelector('#system-name') as HTMLInputElement | null;
const deviceNameInput = document.querySelector('#device-name') as HTMLInputElement | null;
const saveDeviceNameBtn = document.querySelector('#save-device-name') as HTMLButtonElement | null;
const pushSection = document.querySelector('#push-section') as HTMLDivElement | null;
const pushButton = document.querySelector('#push-button') as HTMLButtonElement | null;
const pushStatus = document.querySelector('#push-status') as HTMLParagraphElement | null;
const deviceList = document.querySelector('#device-list') as HTMLUListElement | null;
const emptyState = document.querySelector('#empty-state') as HTMLDivElement | null;
const qrCode = document.querySelector('#qr-code') as HTMLDivElement | null;
const shareUrl = document.querySelector('#share-url') as HTMLAnchorElement | null;
const shareHint = document.querySelector('#share-hint') as HTMLParagraphElement | null;
const sendPanel = document.querySelector('#send-panel') as HTMLElement | null;
const targetTitle = document.querySelector('#target-title');
const dropzone = document.querySelector('#dropzone') as HTMLButtonElement | null;
const fileInput = document.querySelector('#file-input') as HTMLInputElement | null;
const textInput = document.querySelector('#text-input') as HTMLTextAreaElement | null;
const pasteTextBtn = document.querySelector('#paste-text') as HTMLButtonElement | null;
const sendTextBtn = document.querySelector('#send-text') as HTMLButtonElement | null;
const historyPanel = document.querySelector('#history-panel') as HTMLElement | null;
const historyList = document.querySelector('#history-list') as HTMLUListElement | null;
const clearHistoryBtn = document.querySelector('#clear-history') as HTMLButtonElement | null;
const transferPanel = document.querySelector('#transfer-panel') as HTMLDivElement | null;
const transferTitle = document.querySelector('#transfer-title') as HTMLHeadingElement | null;
const transferMessage = document.querySelector('#transfer-message') as HTMLParagraphElement | null;
const requestCountdown = document.querySelector('#request-countdown') as HTMLParagraphElement | null;
const acceptTransferBtn = document.querySelector('#accept-transfer') as HTMLButtonElement | null;
const rejectTransferBtn = document.querySelector('#reject-transfer') as HTMLButtonElement | null;
const notificationPanel = document.querySelector('#notification-panel') as HTMLDivElement | null;
const notificationTitle = document.querySelector('#notification-title') as HTMLHeadingElement | null;
const notificationMessage = document.querySelector('#notification-message') as HTMLParagraphElement | null;
const notificationActionBtn = document.querySelector('#notification-action') as HTMLButtonElement | null;
const closeNotificationBtn = document.querySelector('#close-notification') as HTMLButtonElement | null;
const progressPanel = document.querySelector('#progress-panel') as HTMLDivElement | null;
const progressTitle = document.querySelector('#progress-title') as HTMLHeadingElement | null;
const progressPercent = document.querySelector('#progress-percent') as HTMLElement | null;
const transferProgress = document.querySelector('#transfer-progress') as HTMLProgressElement | null;
const progressDetails = document.querySelector('#progress-details') as HTMLParagraphElement | null;
const cancelTransferBtn = document.querySelector('#cancel-transfer') as HTMLButtonElement | null;
const closeProgressBtn = document.querySelector('#close-progress') as HTMLButtonElement | null;
let transferStatusTimeout: number | undefined;
const progressState = {
  fileName: '',
  startedAt: 0,
  lastRenderAt: 0,
  hideTimer: undefined as number | undefined,
  // Transfert sortant actuellement affiché : une confirmation tardive ne doit pas masquer le suivant.
  outgoingTransferId: ''
};
type TransferRequestInfo = { transferId: string; fileName: string; fileSize: number; expiresInMs: number; mimeType?: string; senderName?: string; expiresAt?: number };
type CountdownEntry = { peerId: string; fileName: string; expiresAt: number; role: 'sender' | 'recipient'; intervalId: number };
const transferCountdowns = new Map<string, CountdownEntry>();
const transferRequestQueue: Array<{ peerId: string; transfer: TransferRequestInfo; offline?: boolean }> = [];
let activeTransferRequest: { peerId: string; transfer: TransferRequestInfo; offline?: boolean } | null = null;
const offlineRequestWaiters = new Map<string, { peerId: string; resolve: (accepted: boolean) => void; timeoutId: number }>();
let vapidPublicKey: string | null = null;
let replacedByAnotherTab = false;

if (deviceNameInput) {
  deviceNameInput.value = peerState.deviceName;
}

if (systemNameInput) {
  systemNameInput.value = platformLabel[detectedPlatform] || 'Inconnu';
}

function renderDeviceMeta() {
  if (deviceMeta) {
    deviceMeta.textContent = `Cet appareil : ${peerState.deviceName} · ${platformLabel[detectedPlatform] || 'Inconnu'}`;
  }
}

renderDeviceMeta();

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
  if (progressState.outgoingTransferId === transferId) {
    hideProgressPanel();
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

function formatRemaining(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return 'estimation…';
  }

  if (seconds < 60) {
    return `${Math.max(1, Math.ceil(seconds))} s restantes`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `${minutes} min ${remainingSeconds} s restantes`;
}

function setProgressMode(mode: 'active' | 'done' | 'failed') {
  if (!progressPanel) {
    return;
  }

  progressPanel.dataset.state = mode;
  if (cancelTransferBtn) {
    cancelTransferBtn.hidden = mode !== 'active';
  }
  if (closeProgressBtn) {
    closeProgressBtn.hidden = mode === 'active';
  }
}

function hideProgressPanel() {
  window.clearTimeout(progressState.hideTimer);
  if (progressPanel) {
    progressPanel.hidden = true;
  }
  progressState.outgoingTransferId = '';
  peerState.activeTransferPeerId = '';
}

function updateTransferProgress(progress: TransferProgress) {
  peerState.activeTransferPeerId = progress.peerId;
  const now = performance.now();
  const isNewTransfer = progress.fileName !== progressState.fileName || progress.bytesTransferred === 0;
  const isFinal = progress.bytesTransferred >= progress.totalBytes;

  if (isNewTransfer) {
    progressState.fileName = progress.fileName;
    progressState.startedAt = now;
  }

  // Au plus une dizaine de rafraîchissements par seconde : l’affichage ne doit pas ralentir le transfert.
  if (!isNewTransfer && !isFinal && now - progressState.lastRenderAt < 100) {
    return;
  }
  progressState.lastRenderAt = now;
  window.clearTimeout(progressState.hideTimer);

  const percent = progress.totalBytes === 0 ? 100 : Math.round((progress.bytesTransferred / progress.totalBytes) * 100);
  const elapsedSeconds = Math.max((now - progressState.startedAt) / 1000, 0.001);
  const bytesPerSecond = progress.bytesTransferred / elapsedSeconds;
  const remainingBytes = Math.max(progress.totalBytes - progress.bytesTransferred, 0);
  const remainingSeconds = bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : Number.POSITIVE_INFINITY;
  const peerName = getPeerDisplayName(progress.peerId);

  setProgressMode('active');
  if (progressPanel) {
    progressPanel.hidden = false;
  }

  if (progressTitle) {
    progressTitle.textContent = progress.direction === 'sending'
      ? `Envoi à ${peerName} : ${progress.fileName}${queueLabel()}`
      : `Réception de ${progress.fileName} depuis ${peerName}`;
  }

  if (progressPercent) {
    progressPercent.textContent = `${percent} %`;
  }

  if (transferProgress) {
    transferProgress.value = percent;
  }

  if (progressDetails) {
    if (isFinal) {
      progressDetails.textContent = progress.direction === 'sending'
        ? `Vérification par ${peerName}…`
        : 'Vérification du fichier…';
    } else {
      progressDetails.textContent = `${formatBytes(progress.bytesTransferred)} sur ${formatBytes(progress.totalBytes)} · ${formatBytes(bytesPerSecond)}/s · ${formatRemaining(remainingSeconds)}`;
    }
  }
}

/** Affiche l’issue d’un transfert : le panneau reste visible quelques secondes pour confirmer. */
function showTransferOutcome(result: { direction: 'sending' | 'receiving'; peerId: string; fileName: string; ok: boolean; reason?: string }) {
  if (!progressPanel) {
    return;
  }

  const peerName = getPeerDisplayName(result.peerId);
  setProgressMode(result.ok ? 'done' : 'failed');
  progressPanel.hidden = false;
  peerState.activeTransferPeerId = '';

  if (progressTitle) {
    if (result.ok) {
      progressTitle.textContent = result.direction === 'sending'
        ? `${result.fileName} envoyé à ${peerName}`
        : `${result.fileName} reçu de ${peerName}`;
    } else {
      progressTitle.textContent = result.direction === 'sending'
        ? `Échec de l’envoi de ${result.fileName}`
        : `Échec de la réception de ${result.fileName}`;
    }
  }

  if (progressPercent) {
    progressPercent.textContent = result.ok ? '100 %' : '';
  }

  if (transferProgress) {
    transferProgress.value = result.ok ? 100 : 0;
  }

  if (progressDetails) {
    if (result.ok) {
      progressDetails.textContent = result.direction === 'sending'
        ? `${peerName} a bien reçu le fichier, intact.`
        : 'Fichier vérifié et enregistré dans vos téléchargements.';
    } else {
      progressDetails.textContent = result.reason ? `Raison : ${result.reason}.` : 'Le transfert a été interrompu.';
    }
  }

  window.clearTimeout(progressState.hideTimer);
  progressState.hideTimer = window.setTimeout(hideProgressPanel, result.ok ? 6_000 : 12_000);
}

function showNotification(title: string, message: string, tone: 'info' | 'success' | 'error' = 'info', action?: { label: string; onClick: () => void }) {
  if (!notificationPanel || !notificationTitle || !notificationMessage) {
    return;
  }

  notificationPanel.dataset.tone = tone;
  notificationTitle.textContent = title;
  notificationMessage.textContent = message;
  notificationPanel.hidden = false;

  if (notificationActionBtn) {
    notificationActionBtn.hidden = !action;
    notificationActionBtn.textContent = action?.label ?? '';
    notificationActionBtn.onclick = action
      ? () => {
          notificationPanel.hidden = true;
          action.onClick();
        }
      : null;
  }
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

/** Ajoute le texte en rendant cliquables les liens http(s) ; rien n’est jamais interprété comme du HTML. */
function appendLinkifiedText(container: HTMLElement, text: string) {
  const urlPattern = /\bhttps?:\/\/[^\s<>"']+/gi;
  let lastIndex = 0;

  for (const match of text.matchAll(urlPattern)) {
    const url = match[0].replace(/[),.;:!?]+$/, '');
    const start = match.index ?? 0;
    container.append(text.slice(lastIndex, start));
    const link = document.createElement('a');
    link.href = url;
    link.textContent = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    container.append(link);
    lastIndex = start + url.length;
  }

  container.append(text.slice(lastIndex));
}

type HistoryEntry = {
  id: string;
  kind: 'text' | 'file';
  direction: 'sent' | 'received';
  peerId: string;
  text?: string;
  fileName?: string;
  fileSize?: number;
  url?: string;
  mimeType?: string;
};

const historyEntries: HistoryEntry[] = [];

function createHistoryButton(label: string, iconName: 'copy' | 'download') {
  const button = document.createElement('button');
  button.className = 'secondary-button small-button';
  button.type = 'button';
  button.innerHTML = `${icon(iconName)}<span></span>`;
  (button.querySelector('span') as HTMLSpanElement).textContent = label;
  return button;
}

function addHistoryEntry(entry: HistoryEntry) {
  if (!historyPanel || !historyList) {
    return;
  }

  historyEntries.unshift(entry);
  const item = document.createElement('li');
  item.className = `history-item ${entry.direction}`;
  item.dataset.entryId = entry.id;

  const meta = document.createElement('div');
  meta.className = 'history-meta';
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const peerName = getPeerDisplayName(entry.peerId);
  meta.innerHTML = icon(entry.direction === 'sent' ? 'arrowOut' : 'arrowIn');
  const metaText = document.createElement('span');
  metaText.textContent = entry.direction === 'sent' ? `Vous → ${peerName} · ${time}` : `${peerName} → vous · ${time}`;
  meta.append(metaText);

  if (entry.kind === 'text' && entry.direction === 'sent') {
    const state = document.createElement('span');
    state.className = 'history-state';
    state.textContent = 'Envoyé';
    meta.append(state);
  }

  item.append(meta);

  if (entry.kind === 'text' && entry.text !== undefined) {
    const text = entry.text;
    const content = document.createElement('p');
    content.className = 'text-content';
    appendLinkifiedText(content, text);

    const copyButton = createHistoryButton('Copier', 'copy');
    copyButton.addEventListener('click', async () => {
      const label = copyButton.querySelector('span') as HTMLSpanElement;
      const copied = await copyToClipboard(text);
      label.textContent = copied ? 'Copié ✓' : 'Copie impossible : sélectionnez le texte';
      window.setTimeout(() => {
        label.textContent = 'Copier';
      }, 2_000);
    });

    item.append(content, copyButton);
  } else {
    const file = document.createElement('div');
    file.className = 'history-file';
    if (entry.url && entry.mimeType?.startsWith('image/')) {
      const preview = document.createElement('img');
      preview.src = entry.url;
      preview.alt = '';
      preview.className = 'history-preview';
      file.append(preview);
    } else {
      const fileIcon = document.createElement('span');
      fileIcon.className = 'history-file-icon';
      fileIcon.innerHTML = icon('file');
      file.append(fileIcon);
    }

    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = entry.fileName ?? '';
    const size = document.createElement('small');
    size.textContent = `${formatBytes(entry.fileSize ?? 0)}${entry.direction === 'sent' ? ' · bien reçu ✓' : ''}`;
    details.append(name, size);
    file.append(details);
    item.append(file);

    if (entry.url) {
      const saveButton = createHistoryButton('Enregistrer', 'download');
      saveButton.addEventListener('click', () => downloadUrl(entry.url as string, entry.fileName ?? 'fichier'));
      item.append(saveButton);
    }
  }

  historyList.prepend(item);
  historyPanel.hidden = false;
}

function markTextDelivered(messageId: string) {
  const state = historyList?.querySelector(`[data-entry-id="${CSS.escape(messageId)}"] .history-state`);
  if (state) {
    state.textContent = 'Remis ✓';
    state.classList.add('delivered');
  }
}

function clearHistory() {
  for (const entry of historyEntries) {
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
    }
  }
  historyEntries.length = 0;
  if (historyList) {
    historyList.innerHTML = '';
  }
  if (historyPanel) {
    historyPanel.hidden = true;
  }
}

function downloadUrl(url: string, fileName: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function handleTransferComplete(result: TransferResult) {
  if (result.direction === 'receiving') {
    if (result.ok && result.file) {
      // L’URL reste valide pour le bouton « Enregistrer » de l’historique, jusqu’à « Tout effacer ».
      const url = URL.createObjectURL(result.file);
      downloadUrl(url, result.fileName);
      addHistoryEntry({
        id: result.transferId,
        kind: 'file',
        direction: 'received',
        peerId: result.peerId,
        fileName: result.fileName,
        fileSize: result.file.size,
        url,
        mimeType: result.file.type
      });
    }
    showTransferOutcome(result);
    return;
  }

  const outgoingSize = sentFileSizes.get(result.transferId);
  sentFileSizes.delete(result.transferId);
  if (result.ok) {
    addHistoryEntry({
      id: result.transferId,
      kind: 'file',
      direction: 'sent',
      peerId: result.peerId,
      fileName: result.fileName,
      fileSize: outgoingSize ?? 0
    });
  }

  // Un autre fichier de la file est peut-être déjà en cours : on ne masque pas sa progression.
  if (progressState.outgoingTransferId === result.transferId) {
    showTransferOutcome(result);
  }
}

function refreshTransferInterface(options: { keepProgress: boolean }) {
  // On rafraîchit uniquement les éléments nécessaires, sans recharger le document.
  renderPeers();

  if (transferPanel) {
    transferPanel.hidden = true;
  }

  if (!options.keepProgress) {
    hideProgressPanel();
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

function peerConnectionState(peerId: string) {
  if (peerState.manager?.isReady(peerId)) return { key: 'ready', label: 'Connecté' };
  if (peerState.manager?.hasConnection(peerId)) return { key: 'connecting', label: 'Connexion…' };
  return { key: 'idle', label: 'Disponible' };
}

function renderShareQr() {
  if (!qrCode || !shareUrl) {
    return;
  }

  const url = `${window.location.origin}/`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (qr.isDark(row, column)) {
        path += `M${column} ${row}h1v1h-1z`;
      }
    }
  }

  // Fond blanc fixe : un QR code se lit mal en couleurs inversées.
  qrCode.innerHTML = `<svg viewBox="-2 -2 ${count + 4} ${count + 4}" role="img" aria-label="QR code de l’adresse GeniusSend" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${count + 4}" height="${count + 4}" fill="#ffffff"/><path d="${path}" fill="#0f172a"/></svg>`;
  shareUrl.href = url;
  shareUrl.textContent = url;
  if (shareHint) {
    shareHint.hidden = !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  }
}

function renderPeers() {
  if (!deviceList) {
    return;
  }

  const availablePeers = peerState.peers.filter((peer) => peer.id !== peerState.id);

  // L’appareil choisi a quitté GeniusSend : on referme le panneau d’envoi.
  if (peerState.selectedPeerId && !availablePeers.some((peer) => peer.id === peerState.selectedPeerId)) {
    peerState.selectedPeerId = '';
    if (sendPanel) {
      sendPanel.hidden = true;
    }
  }

  if (emptyState) {
    const wasHidden = emptyState.hidden;
    emptyState.hidden = availablePeers.length > 0;
    if (wasHidden && !emptyState.hidden) {
      renderShareQr();
    }
  }

  // Le rendu reconstruit la liste : on restitue le focus clavier à l’appareil qui l’avait.
  const focusedPeerId = (document.activeElement as HTMLElement | null)?.dataset?.peerId;

  deviceList.innerHTML = availablePeers
    .map((peer) => {
      const selected = peer.id === peerState.selectedPeerId;
      const state = peerConnectionState(peer.id);
      return `
        <li>
          <button class="device-card${selected ? ' selected' : ''}" type="button" data-peer-id="${escapeHtml(peer.id)}" aria-pressed="${selected}">
            <span class="device-icon">${platformIcon(peer.platform)}</span>
            <span class="peer-meta">
              <strong>${escapeHtml(peer.name)}</strong>
              <small>${platformLabel[peer.platform] || 'Inconnu'}</small>
            </span>
            <span class="peer-state ${state.key}">${state.label}</span>
          </button>
        </li>
      `;
    })
    .join('');

  deviceList.querySelectorAll<HTMLButtonElement>('button[data-peer-id]').forEach((button) => {
    const peerId = button.dataset.peerId ?? '';
    button.addEventListener('click', () => selectPeer(peerId));
    if (peerId === focusedPeerId) {
      button.focus();
    }
  });
}

function selectPeer(peerId: string) {
  const peer = peerState.peers.find((entry) => entry.id === peerId);
  if (!peer) {
    return;
  }

  peerState.selectedPeerId = peerId;
  renderPeers();

  if (targetTitle) {
    targetTitle.textContent = `Envoyer à ${getPeerDisplayName(peerId)}`;
  }

  if (sendPanel) {
    sendPanel.hidden = false;
    // Sur mobile, les actions d’envoi apparaissent juste sous la liste : on les amène à l’écran.
    sendPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  if (peerState.manager && peer.status === 'online') {
    void peerState.manager.initiate(peerId).catch((error) => {
      console.error('[GeniusSend] connexion impossible', error);
    });
  }
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
  transferTitle.textContent = `${senderName} veut vous envoyer un fichier`;
  transferMessage.textContent = `${transfer.fileName} · ${formatBytes(transfer.fileSize)}`;
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
      refreshTransferInterface({ keepProgress: true });
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

// File d’envoi : plusieurs fichiers partent l’un après l’autre vers l’appareil choisi.
const fileQueue: Array<{ peerId: string; file: File }> = [];
const sentFileSizes = new Map<string, number>();
const queueState = { running: false, total: 0, current: 0 };

function queueLabel() {
  return queueState.total > 1 ? ` (${queueState.current}/${queueState.total})` : '';
}

function enqueueFiles(files: File[]) {
  const targetPeerId = peerState.selectedPeerId;

  if (files.length === 0) {
    return;
  }

  if (!targetPeerId) {
    updateTransferStatus('Choisissez d’abord l’appareil destinataire');
    return;
  }

  if (!peerState.manager) {
    updateTransferStatus('Connexion au serveur en cours, réessayez dans un instant');
    return;
  }

  for (const file of files) {
    fileQueue.push({ peerId: targetPeerId, file });
  }
  queueState.total += files.length;
  void runFileQueue();
}

async function runFileQueue() {
  if (queueState.running) {
    return;
  }

  queueState.running = true;
  while (fileQueue.length > 0 && peerState.manager) {
    const { peerId, file } = fileQueue.shift() as { peerId: string; file: File };
    queueState.current += 1;
    try {
      const isOffline = !peerState.peers.some((peer) => peer.id === peerId && peer.status === 'online');
      await peerState.manager.sendFile(peerId, file, isOffline);
    } catch (error) {
      console.error('[GeniusSend] échec de l’envoi', error);
      const reason = error instanceof Error ? error.message : 'erreur inconnue';
      updateTransferStatus(reason);
      showTransferOutcome({ direction: 'sending', peerId, fileName: file.name, ok: false, reason: reason.replace(/\.$/, '') });
    }
  }
  queueState.running = false;
  queueState.total = 0;
  queueState.current = 0;
}

// Une capture d’écran collée s’appelle souvent « image.png » : on lui donne un nom daté.
function nameClipboardFile(file: File) {
  if (file.name && file.name !== 'image.png') {
    return file;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const extension = file.type.split('/')[1] || 'png';
  return new File([file], `capture-${stamp}.${extension}`, { type: file.type });
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
  // Reconnexion sans limite : un téléphone sorti de veille ou un serveur redémarré se reconnecte seul.
  const socket = io(signalingUrl, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
  });

  socket.on('connect', () => {
    peerState.id = deviceId;
    replacedByAnotherTab = false;
    updateServerStatus('Connecté au serveur', true);
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
        onPeerStateChange: () => renderPeers(),
        isPeerOnline: (peerId) => peerState.peers.some((peer) => peer.id === peerId),
        onTransferRequest: (peerId, transfer) => showTransferRequest(peerId, transfer),
        onTransferPending: ({ peerId, transferId, fileName, expiresInMs }) => {
          startTransferCountdown(peerId, transferId, fileName, expiresInMs, 'sender');
          peerState.activeTransferPeerId = peerId;
          progressState.outgoingTransferId = transferId;
          window.clearTimeout(progressState.hideTimer);
          setProgressMode('active');
          if (progressPanel) progressPanel.hidden = false;
          if (progressPercent) progressPercent.textContent = '';
          if (transferProgress) transferProgress.value = 0;
          if (progressTitle) progressTitle.textContent = `En attente de ${getPeerDisplayName(peerId)} : ${fileName}${queueLabel()}`;
          if (progressDetails) progressDetails.textContent = 'Le destinataire doit accepter le fichier. Gardez GeniusSend ouvert.';
        },
        onTransferExpired: (peerId, transferId) => {
          expireTransferRequest(peerId, transferId);
        },
        onTransferProgress: (progress) => {
          if (progress.direction === 'sending' && progress.bytesTransferred === 0 && progressState.outgoingTransferId) {
            sentFileSizes.set(progressState.outgoingTransferId, progress.totalBytes);
          }
          updateTransferProgress(progress);
        },
        onTransferComplete: handleTransferComplete,
        onTransferCancelled: (peerId) => {
          if (peerState.activeTransferPeerId === peerId) {
            refreshTransferInterface({ keepProgress: false });
            showTemporaryTransferStatus('Transfert annulé', 5_000);
          }
        },
        onTextReceived: (peerId, text) => {
          addHistoryEntry({ id: `text-${Date.now()}-${Math.random().toString(36).slice(2)}`, kind: 'text', direction: 'received', peerId, text });
          showTemporaryTransferStatus(`Nouveau texte de ${getPeerDisplayName(peerId)}`, 5_000);
        },
        onTextDelivered: (peerId, messageId) => {
          markTextDelivered(messageId);
          showTemporaryTransferStatus(`Texte reçu par ${getPeerDisplayName(peerId)}`, 5_000);
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
            if (progressState.outgoingTransferId === transferId) {
              hideProgressPanel();
            }
            showNotification('Transfert refusé', `${peerName} a refusé le fichier.`, 'error');
          }
        }
      });
    }
  });

  socket.on('disconnect', (reason) => {
    updateServerStatus(replacedByAnotherTab ? 'GeniusSend est ouvert ailleurs' : 'Connexion perdue, reconnexion…', false);
    for (const [transferId, waiter] of offlineRequestWaiters) {
      window.clearTimeout(waiter.timeoutId);
      offlineRequestWaiters.delete(transferId);
      clearTransferCountdown(transferId);
      waiter.resolve(false);
    }
    // Une déconnexion décidée par le serveur n’est pas relancée automatiquement par Socket.IO.
    if (reason === 'io server disconnect' && !replacedByAnotherTab) {
      socket.connect();
    }
  });

  // Le serveur ne garde qu’une connexion par appareil : un autre onglet a pris le relais.
  socket.on('peer:replaced', () => {
    replacedByAnotherTab = true;
    showNotification(
      'GeniusSend est ouvert ailleurs',
      'Cet appareil utilise GeniusSend dans un autre onglet ou une autre fenêtre. Un seul peut être actif à la fois.',
      'info',
      {
        label: 'Utiliser ici',
        onClick: () => {
          replacedByAnotherTab = false;
          socket.connect();
        }
      }
    );
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
    // Les notifications Push exigent HTTPS : en HTTP, la section reste masquée.
    if (pushSection) {
      pushSection.hidden = !window.isSecureContext;
    }
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

// Au retour de veille ou du réseau, on n’attend pas le prochain essai de reconnexion.
function reconnectIfNeeded() {
  if (!replacedByAnotherTab && peerState.socket && !peerState.socket.connected) {
    peerState.socket.connect();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    reconnectIfNeeded();
  }
});
window.addEventListener('online', reconnectIfNeeded);

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
    profileButton.setAttribute('aria-expanded', String(!profilePanel.hidden));
  });
}

if (closeNotificationBtn && notificationPanel) {
  closeNotificationBtn.addEventListener('click', () => {
    notificationPanel.hidden = true;
  });
}

// Le service worker (cache hors ligne, notifications) n’est autorisé qu’en HTTPS ou sur localhost.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[GeniusSend] Enregistrement du service worker impossible:', error);
    });
  });
}

if (installButton) {
  setupInstall(installButton, showNotification);
}

if (cancelTransferBtn) {
  cancelTransferBtn.addEventListener('click', () => {
    // Annuler arrête aussi les fichiers suivants de la file.
    fileQueue.length = 0;
    const peerId = peerState.activeTransferPeerId || peerState.selectedPeerId;
    if (peerId && peerState.manager) {
      peerState.manager.cancelTransfer(peerId);
    }

    refreshTransferInterface({ keepProgress: false });
    showTemporaryTransferStatus('Transfert annulé', 5_000);
  });
}

if (closeProgressBtn) {
  closeProgressBtn.addEventListener('click', hideProgressPanel);
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', clearHistory);
}

if (saveDeviceNameBtn && deviceNameInput) {
  saveDeviceNameBtn.addEventListener('click', () => {
    const name = deviceNameInput.value.trim();

    if (!name) {
      deviceNameInput.value = peerState.deviceName;
      return;
    }

    peerState.deviceName = name;
    localStorage.setItem(deviceNameStorageKey, name);
    renderDeviceMeta();

    if (peerState.socket?.connected) {
      registerLocalPeer(peerState.socket);
    }

    // Le panneau se referme après l’enregistrement pour confirmer la modification.
    if (profilePanel) {
      profilePanel.hidden = true;
      profileButton?.setAttribute('aria-expanded', 'false');
    }
    showTemporaryTransferStatus('Nom enregistré', 3_000);
  });
}

if (dropzone && fileInput) {
  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    // Remise à zéro : choisir à nouveau le même fichier doit relancer un envoi.
    fileInput.value = '';
    enqueueFiles(files);
  });
}

if (sendPanel && dropzone) {
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');

  for (const type of ['dragenter', 'dragover'] as const) {
    sendPanel.addEventListener(type, (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dropzone.classList.add('dragging');
    });
  }

  sendPanel.addEventListener('dragleave', (event) => {
    if (!sendPanel.contains(event.relatedTarget as Node | null)) {
      dropzone.classList.remove('dragging');
    }
  });

  sendPanel.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    enqueueFiles(Array.from(event.dataTransfer?.files ?? []));
  });
}

// Un fichier lâché à côté de la zone ne doit pas remplacer la page par son contenu.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      event.preventDefault();
    }
  });
}

// Coller une image (capture d’écran…) l’envoie comme fichier ; un collage de texte reste normal.
document.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  if (!peerState.selectedPeerId) {
    updateTransferStatus('Choisissez d’abord l’appareil qui doit recevoir l’image collée');
    return;
  }
  enqueueFiles(files.map(nameClipboardFile));
});

if (textInput && sendTextBtn) {
  const sendText = async () => {
    const text = textInput.value;
    const targetPeerId = peerState.selectedPeerId;

    if (!text.trim()) {
      updateTransferStatus('Saisissez un texte à envoyer');
      return;
    }

    if (!targetPeerId) {
      updateTransferStatus('Choisissez d’abord l’appareil destinataire');
      return;
    }

    if (!peerState.manager) {
      updateTransferStatus('Connexion au serveur en cours, réessayez dans un instant');
      return;
    }

    sendTextBtn.disabled = true;
    try {
      const messageId = await peerState.manager.sendText(targetPeerId, text);
      addHistoryEntry({ id: messageId, kind: 'text', direction: 'sent', peerId: targetPeerId, text });
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
