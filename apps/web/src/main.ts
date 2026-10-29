import './styles.css';
import qrcode from 'qrcode-generator';
import { io, type Socket } from 'socket.io-client';
import { createChat } from './chat';
import { formatBytes, formatTime } from './format';
import { icon, platformIcon } from './icons';
import { isIosDevice, setupInstall } from './install';
import { PeerConnectionManager, type TransferProgress, type TransferResult } from './webrtc';

type Peer = {
  id: string;
  name: string;
  platform: string;
  status: string;
  hidden?: boolean;
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
const isPhone = detectedPlatform === 'android' || detectedPlatform === 'ios';
const deviceNameStorageKey = 'geniussend-device-name';
// L’option « Masquer cet appareil » a été retirée : un appareil masqué auparavant redevient visible.
localStorage.removeItem('geniussend-hidden');
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
  deviceName: defaultDeviceName
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
  <header class="topbar">
    <div class="brand">
      <img class="brand-logo" src="/icons/icon-192.png" alt="" width="40" height="40" />
      <div>
        <h1>GeniusSend</h1>
        <p class="tagline">Transfert en réseau local</p>
      </div>
    </div>
    <div class="topbar-actions">
      <span class="pill server-pill" id="server-pill" data-state="connecting" title="État du serveur">
        <span class="status-dot" aria-hidden="true"></span><span class="pill-label" id="server-status">Connexion…</span>
      </span>
      <span class="pill device-pill" title="Cet appareil">${platformIcon(detectedPlatform)}<span id="device-pill-label"></span></span>
      <button class="icon-button" id="qr-button" type="button" aria-label="Afficher le QR code pour connecter un appareil" title="QR code">${icon('qr')}</button>
      <button class="icon-button install-button" id="install-button" type="button" aria-label="Installer l’application GeniusSend" title="Installer l’application" hidden>${icon('download')}</button>
      <button class="icon-button" id="profile-button" type="button" aria-label="Profil de cet appareil" title="Profil">${icon('user')}</button>
    </div>
  </header>

  <main class="layout">
    <section class="panel radar-panel" aria-labelledby="radar-title">
      <div class="radar-head">
        <div>
          <h2 id="radar-title">Appareils à proximité</h2>
          <p class="radar-status" id="transfer-status" role="status" aria-live="polite">Prêt pour un transfert</p>
        </div>
        <span class="mono peer-count" id="peer-count">Recherche…</span>
      </div>
      <div class="radar" id="radar">
        <div class="radar-ring ring-1" aria-hidden="true"></div>
        <div class="radar-ring ring-2" aria-hidden="true"></div>
        <div class="radar-ring ring-3" aria-hidden="true"></div>
        <div class="radar-sweep" aria-hidden="true"></div>
        <div class="radar-node self">
          <span class="node-circle">${platformIcon(detectedPlatform)}<span class="self-label">${isPhone ? 'Ce téléphone' : 'Ce PC'}</span></span>
          <span class="node-status" id="self-name"></span>
        </div>
        <div class="radar-node searching" id="radar-searching" aria-hidden="true">
          <span class="node-circle">···</span>
          <span class="node-status">Recherche…</span>
        </div>
      </div>
      <div class="radar-hint" id="radar-hint" hidden>
        <p>Aucun autre appareil pour l’instant.</p>
        <button class="secondary-button small-button" id="radar-qr-button" type="button">${icon('qr')}Afficher le QR code</button>
      </div>
    </section>

    <aside class="side-column">
      <div class="sheet-backdrop" id="sheet-backdrop" hidden></div>
      <section class="panel sheet" id="send-sheet" data-open="false" aria-labelledby="sheet-title">
        <div class="sheet-handle" id="sheet-handle" aria-hidden="true"></div>
        <div class="sheet-header">
          <span class="sheet-device-icon" id="sheet-device-icon"></span>
          <div class="sheet-title">
            <p class="eyebrow">Envoyer vers</p>
            <h2 id="sheet-title"></h2>
          </div>
          <span class="mono sheet-platform" id="sheet-platform"></span>
          <button class="icon-button small" id="close-sheet" type="button" aria-label="Fermer">${icon('close')}</button>
        </div>
        <div class="sheet-files">
          <button class="dropzone" id="dropzone" type="button">
            <span class="dropzone-icon">${icon('upload')}</span>
            <strong>Glissez vos fichiers ici</strong>
            <span class="dropzone-hint">ou cliquez pour parcourir</span>
          </button>
          <input id="file-input" type="file" multiple hidden />
          <ul class="selected-files" id="selected-files"></ul>
        </div>
        <button class="primary-button send-button" id="send-button" type="button" disabled>${icon('send')}<span id="send-label">Envoyer</span></button>
      </section>

      <section class="panel recent-panel" id="recent-panel" aria-labelledby="recent-title" hidden>
        <div class="panel-heading">
          <h2 id="recent-title">Transferts récents</h2>
          <button class="text-button" id="clear-history" type="button" hidden>Tout effacer</button>
        </div>
        <ul class="recent-list" id="recent-list"></ul>
      </section>

      <section class="panel chat-panel" id="chat-panel" data-open="false" aria-label="Chat"></section>
    </aside>
  </main>

  <dialog class="modal request-dialog" id="request-dialog" aria-labelledby="request-title">
    <div class="request-hero">
      <span class="request-icon">${icon('download')}</span>
      <div>
        <p class="eyebrow" id="request-kind">Fichier entrant</p>
        <h2 id="request-title"></h2>
      </div>
    </div>
    <div class="request-file">
      <span class="request-file-icon" id="request-file-icon">${icon('file')}</span>
      <div>
        <strong id="request-file-name"></strong>
        <small id="request-file-size"></small>
      </div>
    </div>
    <p class="request-countdown" id="request-countdown"></p>
    <p class="field-help" id="request-queue" hidden></p>
    <div class="dialog-actions">
      <button class="secondary-button" id="reject-transfer" type="button">Refuser</button>
      <button class="primary-button" id="accept-transfer" type="button">${icon('check')}Accepter</button>
    </div>
  </dialog>

  <dialog class="modal profile-dialog" id="profile-dialog" aria-labelledby="profile-title">
    <div class="modal-head">
      <h2 id="profile-title">Profil de l’appareil</h2>
      <button class="icon-button small" type="button" aria-label="Fermer" data-close>${icon('close')}</button>
    </div>
    <div class="profile-fields">
      <label for="device-name">Nom affiché sur les autres appareils</label>
      <input id="device-name" type="text" maxlength="40" placeholder="Ex. iPhone de Marie" />
      <label for="system-name">Système</label>
      <input id="system-name" type="text" readonly />
      <div id="push-section" hidden>
        <button class="secondary-button" id="push-button" type="button" disabled>Notifications indisponibles</button>
        <p class="field-help" id="push-status">Les notifications signalent les demandes quand cet appareil est hors ligne.</p>
      </div>
    </div>
    <div class="dialog-actions">
      <button class="primary-button" id="save-profile" type="button">Enregistrer</button>
    </div>
  </dialog>

  <dialog class="modal qr-dialog" id="qr-dialog" aria-labelledby="qr-title">
    <div class="modal-head">
      <h2 id="qr-title">Connecter un appareil</h2>
      <button class="icon-button small" type="button" aria-label="Fermer" data-close>${icon('close')}</button>
    </div>
    <div class="qr-code" id="qr-code"></div>
    <p class="qr-caption">Scannez ce code avec un appareil connecté au même Wi-Fi, ou ouvrez cette adresse :</p>
    <a class="share-url" id="share-url"></a>
    <p class="field-help qr-caption" id="share-hint" hidden>« localhost » ne fonctionne que sur ce PC : sur les autres appareils, utilisez son adresse IP.</p>
  </dialog>

  <button class="chat-fab" id="chat-button" type="button" aria-label="Ouvrir le chat" aria-pressed="false" title="Chat">${icon('chat')}<span class="chat-badge" id="chat-badge" hidden></span></button>

  <div class="toasts" id="toasts"></div>
`;

const serverPill = document.querySelector('#server-pill') as HTMLSpanElement;
const serverStatus = document.querySelector('#server-status') as HTMLSpanElement;
const devicePillLabel = document.querySelector('#device-pill-label') as HTMLSpanElement;
const installButton = document.querySelector('#install-button') as HTMLButtonElement;
const profileButton = document.querySelector('#profile-button') as HTMLButtonElement;
const transferStatus = document.querySelector('#transfer-status') as HTMLParagraphElement;
const peerCount = document.querySelector('#peer-count') as HTMLSpanElement;
const radar = document.querySelector('#radar') as HTMLDivElement;
const selfName = document.querySelector('#self-name') as HTMLSpanElement;
const radarSearching = document.querySelector('#radar-searching') as HTMLDivElement;
const radarHint = document.querySelector('#radar-hint') as HTMLDivElement;
const qrButton = document.querySelector('#qr-button') as HTMLButtonElement;
const radarQrButton = document.querySelector('#radar-qr-button') as HTMLButtonElement;
const qrDialog = document.querySelector('#qr-dialog') as HTMLDialogElement;
const qrCode = document.querySelector('#qr-code') as HTMLDivElement;
const shareUrl = document.querySelector('#share-url') as HTMLAnchorElement;
const shareHint = document.querySelector('#share-hint') as HTMLParagraphElement;
const sheetBackdrop = document.querySelector('#sheet-backdrop') as HTMLDivElement;
const sendSheet = document.querySelector('#send-sheet') as HTMLElement;
const sheetHandle = document.querySelector('#sheet-handle') as HTMLDivElement;
const sheetDeviceIcon = document.querySelector('#sheet-device-icon') as HTMLSpanElement;
const sheetTitle = document.querySelector('#sheet-title') as HTMLHeadingElement;
const sheetPlatform = document.querySelector('#sheet-platform') as HTMLSpanElement;
const closeSheetBtn = document.querySelector('#close-sheet') as HTMLButtonElement;
const dropzone = document.querySelector('#dropzone') as HTMLButtonElement;
const fileInput = document.querySelector('#file-input') as HTMLInputElement;
const selectedFilesList = document.querySelector('#selected-files') as HTMLUListElement;
const sendButton = document.querySelector('#send-button') as HTMLButtonElement;
const sendLabel = document.querySelector('#send-label') as HTMLSpanElement;
const recentList = document.querySelector('#recent-list') as HTMLUListElement;
const recentPanel = document.querySelector('#recent-panel') as HTMLElement;
const clearHistoryBtn = document.querySelector('#clear-history') as HTMLButtonElement;
const requestDialog = document.querySelector('#request-dialog') as HTMLDialogElement;
const requestTitle = document.querySelector('#request-title') as HTMLHeadingElement;
const requestFileName = document.querySelector('#request-file-name') as HTMLElement;
const requestFileSize = document.querySelector('#request-file-size') as HTMLElement;
const requestCountdown = document.querySelector('#request-countdown') as HTMLParagraphElement;
const requestQueueInfo = document.querySelector('#request-queue') as HTMLParagraphElement;
const acceptTransferBtn = document.querySelector('#accept-transfer') as HTMLButtonElement;
const rejectTransferBtn = document.querySelector('#reject-transfer') as HTMLButtonElement;
const profileDialog = document.querySelector('#profile-dialog') as HTMLDialogElement;
const deviceNameInput = document.querySelector('#device-name') as HTMLInputElement;
const systemNameInput = document.querySelector('#system-name') as HTMLInputElement;
const saveProfileBtn = document.querySelector('#save-profile') as HTMLButtonElement;
const pushSection = document.querySelector('#push-section') as HTMLDivElement;
const pushButton = document.querySelector('#push-button') as HTMLButtonElement;
const pushStatus = document.querySelector('#push-status') as HTMLParagraphElement;
const toasts = document.querySelector('#toasts') as HTMLDivElement;
const layout = document.querySelector('.layout') as HTMLElement;
const chatPanel = document.querySelector('#chat-panel') as HTMLElement;
const chatButton = document.querySelector('#chat-button') as HTMLButtonElement;
const chatBadge = document.querySelector('#chat-badge') as HTMLSpanElement;

const mobileLayout = window.matchMedia('(max-width: 899px)');
let transferStatusTimeout: number | undefined;
let vapidPublicKey: string | null = null;
let replacedByAnotherTab = false;
const offlineRequestWaiters = new Map<string, { peerId: string; resolve: (accepted: boolean) => void; timeoutId: number }>();

/* ---------- Formatage ---------- */

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

function formatCountdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
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

/* ---------- États et notifications ---------- */

function updateServerStatus(status: string, state: 'connected' | 'connecting' | 'offline') {
  serverPill.dataset.state = state;
  serverStatus.textContent = status;
}

function updateTransferStatus(status: string) {
  transferStatus.textContent = status;
}

function showTemporaryTransferStatus(status: string, durationInMilliseconds: number) {
  updateTransferStatus(status);
  window.clearTimeout(transferStatusTimeout);
  transferStatusTimeout = window.setTimeout(() => {
    updateTransferStatus('Prêt pour un transfert');
  }, durationInMilliseconds);
}

type ToastOptions = { title?: string; message: string; tone?: 'info' | 'success' | 'error'; action?: { label: string; onClick: () => void } };

/** Message passager en bas de l’écran ; il reste affiché tant qu’une action est proposée. */
function showToast({ title, message, tone = 'info', action }: ToastOptions) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.tone = tone;
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const body = document.createElement('div');
  body.className = 'toast-body';
  if (title) {
    const strong = document.createElement('strong');
    strong.textContent = title;
    body.append(strong);
  }
  const text = document.createElement('span');
  text.textContent = message;
  body.append(text);
  toast.append(body);

  const dismiss = () => {
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), 200);
  };

  if (action) {
    const actionButton = document.createElement('button');
    actionButton.className = 'primary-button small-button';
    actionButton.type = 'button';
    actionButton.textContent = action.label;
    actionButton.addEventListener('click', () => {
      dismiss();
      action.onClick();
    });
    toast.append(actionButton);
  }

  const closeButton = document.createElement('button');
  closeButton.className = 'toast-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Fermer');
  closeButton.innerHTML = icon('close');
  closeButton.addEventListener('click', dismiss);
  toast.append(closeButton);

  toasts.append(toast);
  if (!action) {
    window.setTimeout(dismiss, tone === 'error' ? 8_000 : 5_000);
  }
}

function renderDeviceIdentity() {
  devicePillLabel.textContent = `${peerState.deviceName} · ${platformLabel[detectedPlatform] || 'Inconnu'}`;
  selfName.textContent = peerState.deviceName;
}

/* ---------- Téléchargements ---------- */

function downloadUrl(url: string, fileName: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
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

/* ---------- Transferts récents ---------- */

type EntryState = 'waiting' | 'active' | 'verifying' | 'done' | 'failed' | 'refused' | 'expired' | 'cancelled';

type TransferEntry = {
  id: string;
  kind: 'file';
  direction: 'sent' | 'received';
  peerId: string;
  state: EntryState;
  time: Date;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  url?: string;
  bytes: number;
  startedAt: number;
  lastRenderAt: number;
  expiresAt?: number;
  reason?: string;
};

const entries = new Map<string, TransferEntry>();
const entryElements = new Map<string, { item: HTMLLIElement; bar?: HTMLProgressElement; side?: HTMLElement; sub?: HTMLElement }>();
const finishedStates: EntryState[] = ['done', 'failed', 'refused', 'expired', 'cancelled'];

function upsertEntry(entry: Partial<TransferEntry> & Pick<TransferEntry, 'id' | 'kind' | 'direction' | 'peerId'>) {
  const existing = entries.get(entry.id);
  const merged: TransferEntry = existing
    ? { ...existing, ...entry }
    : { state: 'waiting', time: new Date(), bytes: 0, startedAt: performance.now(), lastRenderAt: 0, ...entry };
  entries.set(entry.id, merged);
  renderEntry(merged);
  return merged;
}

function updateEntry(id: string, patch: Partial<TransferEntry>) {
  const entry = entries.get(id);
  if (!entry) {
    return undefined;
  }
  Object.assign(entry, patch);
  renderEntry(entry);
  return entry;
}

function entrySideLabel(entry: TransferEntry) {
  switch (entry.state) {
    case 'waiting':
      return 'En attente';
    case 'active':
      return `${entry.fileSize ? Math.round((entry.bytes / entry.fileSize) * 100) : 100} %`;
    case 'verifying':
      return 'Vérification…';
    case 'done':
      return 'Terminé';
    case 'failed':
      return 'Échec';
    case 'refused':
      return 'Refusé';
    case 'expired':
      return 'Expiré';
    default:
      return 'Annulé';
  }
}

function entrySubLabel(entry: TransferEntry) {
  const peerName = getPeerDisplayName(entry.peerId);
  const route = entry.direction === 'sent' ? `Vers ${peerName}` : `De ${peerName}`;

  switch (entry.state) {
    case 'waiting':
      return entry.expiresAt
        ? `${route} · réponse attendue ${formatCountdown(entry.expiresAt - Date.now())}`
        : `${route} · connexion…`;
    case 'active': {
      const elapsedSeconds = Math.max((performance.now() - entry.startedAt) / 1000, 0.001);
      const speed = entry.bytes / elapsedSeconds;
      const remaining = speed > 0 ? Math.max((entry.fileSize ?? 0) - entry.bytes, 0) / speed : Number.POSITIVE_INFINITY;
      return `${route} · ${formatBytes(speed)}/s · ${formatRemaining(remaining)}`;
    }
    case 'verifying':
      return `${route} · contrôle d’intégrité`;
    case 'done':
      return `${route} · ${formatBytes(entry.fileSize ?? 0)} · ${formatTime(entry.time)}`;
    default:
      return entry.reason ? `${route} · ${entry.reason}` : route;
  }
}

function createIconButton(label: string, iconName: 'download' | 'close') {
  const button = document.createElement('button');
  button.className = 'icon-button small';
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon(iconName);
  return button;
}

function renderEntry(entry: TransferEntry) {
  const refs = entryElements.get(entry.id);

  // Chemin rapide : seule la progression change pendant un transfert.
  if (refs?.bar && entry.state === 'active' && refs.item.dataset.state === 'active') {
    refs.bar.value = entry.fileSize ? (entry.bytes / entry.fileSize) * 100 : 100;
    if (refs.side) refs.side.textContent = entrySideLabel(entry);
    if (refs.sub) refs.sub.textContent = entrySubLabel(entry);
    return;
  }

  const item = document.createElement('li');
  item.className = `recent-item ${entry.direction}`;
  item.dataset.state = entry.state;
  item.dataset.entryId = entry.id;

  const visual = document.createElement('span');
  visual.className = 'recent-icon';
  if (entry.url && entry.mimeType?.startsWith('image/')) {
    const preview = document.createElement('img');
    preview.src = entry.url;
    preview.alt = '';
    visual.append(preview);
    visual.classList.add('preview');
  } else if (entry.state === 'done') {
    visual.innerHTML = icon('check');
  } else if (['failed', 'refused', 'expired', 'cancelled'].includes(entry.state)) {
    visual.innerHTML = icon('close');
  } else {
    visual.innerHTML = icon('file');
  }

  const main = document.createElement('div');
  main.className = 'recent-main';
  const top = document.createElement('div');
  top.className = 'recent-top';
  const name = document.createElement('strong');
  name.className = 'recent-name';
  name.textContent = entry.fileName ?? '';
  const side = document.createElement('span');
  side.className = 'recent-side';
  side.textContent = entrySideLabel(entry);
  top.append(name, side);
  main.append(top);

  let bar: HTMLProgressElement | undefined;
  if (entry.state === 'active' || entry.state === 'verifying') {
    bar = document.createElement('progress');
    bar.max = 100;
    bar.value = entry.state === 'verifying' ? 100 : entry.fileSize ? (entry.bytes / entry.fileSize) * 100 : 100;
    bar.setAttribute('aria-label', `Progression de ${entry.fileName ?? 'transfert'}`);
    main.append(bar);
  }

  const sub = document.createElement('p');
  sub.className = 'recent-sub';
  sub.textContent = entrySubLabel(entry);
  main.append(sub);

  const actions = document.createElement('div');
  actions.className = 'recent-actions';

  if ((entry.state === 'waiting' || entry.state === 'active') && !entry.url) {
    const cancelButton = createIconButton('Annuler ce transfert', 'close');
    cancelButton.addEventListener('click', () => cancelEntry(entry));
    actions.append(cancelButton);
  } else if (entry.url) {
    const url = entry.url;
    const saveButton = createIconButton('Enregistrer le fichier', 'download');
    saveButton.addEventListener('click', () => downloadUrl(url, entry.fileName ?? 'fichier'));
    actions.append(saveButton);
  }

  item.append(visual, main, actions);

  if (refs) {
    refs.item.replaceWith(item);
  } else {
    recentList.prepend(item);
  }
  entryElements.set(entry.id, { item, bar, side, sub });
  refreshRecentChrome();
}

function refreshRecentChrome() {
  // Le panneau n’apparaît qu’à partir du premier transfert.
  recentPanel.hidden = entries.size === 0;
  clearHistoryBtn.hidden = !Array.from(entries.values()).some((entry) => finishedStates.includes(entry.state));
}

function clearHistory() {
  for (const entry of Array.from(entries.values())) {
    // Les transferts encore en cours restent visibles.
    if (!finishedStates.includes(entry.state)) continue;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entryElements.get(entry.id)?.item.remove();
    entryElements.delete(entry.id);
    entries.delete(entry.id);
  }
  refreshRecentChrome();
}

function cancelEntry(entry: TransferEntry) {
  // Un fichier encore dans la file n’est pas parti : on le retire simplement.
  const queuedIndex = fileQueue.findIndex((queued) => queued.entryId === entry.id);
  if (queuedIndex >= 0) {
    fileQueue.splice(queuedIndex, 1);
    updateEntry(entry.id, { state: 'cancelled', reason: 'retiré de la file' });
    return;
  }
  peerState.manager?.cancelTransfer(entry.peerId, entry.id);
  updateEntry(entry.id, { state: 'cancelled', reason: undefined });
}

// Les comptes à rebours des demandes en attente se mettent à jour chaque seconde.
window.setInterval(() => {
  for (const entry of entries.values()) {
    if (entry.state === 'waiting' && entry.expiresAt) {
      const refs = entryElements.get(entry.id);
      if (refs?.sub) refs.sub.textContent = entrySubLabel(entry);
    }
  }
  renderRequestCountdown();
}, 1_000);

/* ---------- Radar ---------- */

const nodeElements = new Map<string, HTMLButtonElement>();
// Rayons des orbites, en fraction de la largeur du radar (le centre est à 0,5).
const INNER_ORBIT = 0.3;
const OUTER_ORBIT = 0.44;
const INNER_CAPACITY = 6;

/** Positions des appareils : l’orbite intérieure d’abord, puis l’orbite extérieure. */
function orbitPositions(count: number) {
  const positions: Array<{ x: number; y: number }> = [];
  const innerCount = Math.min(count, INNER_CAPACITY);
  const outerCount = count - innerCount;
  const place = (index: number, total: number, radius: number, offsetDegrees: number) => {
    const angle = ((offsetDegrees + (index * 360) / total) * Math.PI) / 180;
    positions.push({ x: 50 + radius * 100 * Math.cos(angle), y: 50 + radius * 100 * Math.sin(angle) });
  };

  for (let index = 0; index < innerCount; index += 1) place(index, innerCount, INNER_ORBIT, -55);
  for (let index = 0; index < outerCount; index += 1) place(index, outerCount, OUTER_ORBIT, -20);
  return positions;
}

function visiblePeers() {
  return peerState.peers
    .filter((peer) => peer.id !== peerState.id && !peer.hidden)
    .sort((first, second) => first.id.localeCompare(second.id));
}

function peerConnectionState(peerId: string) {
  if (peerState.manager?.isReady(peerId)) return { key: 'ready', label: 'Connecté' };
  if (peerState.manager?.hasConnection(peerId)) return { key: 'connecting', label: 'Connexion…' };
  return { key: 'idle', label: 'En ligne' };
}

function renderShareQr() {
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
  shareHint.hidden = !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

function createPeerNode(peerId: string) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'radar-node peer entering';
  node.dataset.peerId = peerId;
  node.innerHTML = '<span class="node-circle"></span><span class="node-label"></span><span class="node-status"></span>';
  node.addEventListener('click', () => selectPeer(peerId));
  node.addEventListener('animationend', () => node.classList.remove('entering'), { once: true });
  radar.append(node);
  nodeElements.set(peerId, node);
  return node;
}

function renderRadar() {
  const peers = visiblePeers();
  const positions = orbitPositions(peers.length);
  const visibleIds = new Set(peers.map((peer) => peer.id));

  // L’appareil choisi a quitté GeniusSend (ou s’est masqué) : on referme le volet d’envoi.
  if (peerState.selectedPeerId && !visibleIds.has(peerState.selectedPeerId)) {
    const name = sheetTitle.textContent;
    closeSheet();
    showToast({ message: `${name} s’est déconnecté`, tone: 'info' });
  }

  for (const [peerId, node] of nodeElements) {
    if (!visibleIds.has(peerId)) {
      node.remove();
      nodeElements.delete(peerId);
    }
  }

  peers.forEach((peer, index) => {
    const node = nodeElements.get(peer.id) ?? createPeerNode(peer.id);
    const selected = peer.id === peerState.selectedPeerId;
    const state = peerConnectionState(peer.id);
    node.style.setProperty('--x', `${positions[index].x}%`);
    node.style.setProperty('--y', `${positions[index].y}%`);
    node.classList.toggle('selected', selected);
    node.setAttribute('aria-pressed', String(selected));
    node.setAttribute('aria-label', `${peer.name}, ${platformLabel[peer.platform] || 'appareil'} — ${selected ? 'sélectionné' : state.label}`);
    (node.querySelector('.node-circle') as HTMLSpanElement).innerHTML = platformIcon(peer.platform);
    (node.querySelector('.node-label') as HTMLSpanElement).textContent = peer.name;
    const status = node.querySelector('.node-status') as HTMLSpanElement;
    status.textContent = selected ? 'Sélectionné' : state.label;
    status.dataset.state = selected ? 'selected' : state.key;
  });

  // La bulle « Recherche… » occupe une place libre de l’orbite extérieure.
  radarSearching.hidden = peers.length > INNER_CAPACITY;
  peerCount.textContent = peers.length === 0
    ? 'Recherche d’appareils…'
    : `${peers.length} appareil${peers.length > 1 ? 's' : ''} connecté${peers.length > 1 ? 's' : ''}`;
  chat.setPresence(peers.length + 1);

  // Le QR code n’apparaît que sur demande : le radar vide propose seulement de l’afficher.
  radarHint.hidden = peers.length > 0;

  if (peerState.selectedPeerId) {
    renderSheetHeader();
  }
}

/* ---------- Volet « Envoyer vers » ---------- */

const selectedFiles: File[] = [];
let sheetCloseTimer: number | undefined;

function renderSheetHeader() {
  const peer = peerState.peers.find((entry) => entry.id === peerState.selectedPeerId);
  if (!peer) return;
  sheetDeviceIcon.innerHTML = platformIcon(peer.platform);
  sheetTitle.textContent = getPeerDisplayName(peer.id);
  sheetPlatform.textContent = platformLabel[peer.platform] || 'Inconnu';
}

function openSheet() {
  window.clearTimeout(sheetCloseTimer);
  const wasOpen = sendSheet.dataset.open === 'true';
  sendSheet.dataset.open = 'true';
  sheetBackdrop.hidden = !mobileLayout.matches;
  document.body.classList.toggle('sheet-locked', mobileLayout.matches);
  if (wasOpen) {
    // Changement de destinataire : un léger rebond le signale.
    sendSheet.classList.remove('bump');
    void sendSheet.offsetWidth;
    sendSheet.classList.add('bump');
  }
}

function closeSheet() {
  if (sendSheet.dataset.open !== 'true') {
    peerState.selectedPeerId = '';
    return;
  }
  peerState.selectedPeerId = '';
  sendSheet.dataset.open = 'closing';
  sheetBackdrop.hidden = true;
  document.body.classList.remove('sheet-locked');
  sheetCloseTimer = window.setTimeout(() => {
    sendSheet.dataset.open = 'false';
  }, 220);
  renderRadar();
}

function selectPeer(peerId: string) {
  const peer = peerState.peers.find((entry) => entry.id === peerId);
  if (!peer) {
    return;
  }

  peerState.selectedPeerId = peerId;
  // Le volet d’envoi et le chat occupent la même colonne : le chat se referme.
  chat.close();
  renderSheetHeader();
  openSheet();
  renderRadar();

  if (peerState.manager && peer.status === 'online') {
    void peerState.manager.initiate(peerId).catch((error) => {
      console.error('[GeniusSend] connexion impossible', error);
    });
  }
}

function renderSelectedFiles() {
  selectedFilesList.innerHTML = '';
  selectedFiles.forEach((file, index) => {
    const item = document.createElement('li');
    const fileIcon = document.createElement('span');
    fileIcon.className = 'selected-file-icon';
    fileIcon.innerHTML = icon('file');
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = file.name;
    const size = document.createElement('small');
    size.textContent = formatBytes(file.size);
    details.append(name, size);
    const remove = createIconButton(`Retirer ${file.name}`, 'close');
    remove.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderSelectedFiles();
    });
    item.append(fileIcon, details, remove);
    selectedFilesList.append(item);
  });
  updateSendButton();
}

function addSelectedFiles(files: File[]) {
  if (files.length === 0) return;
  selectedFiles.push(...files);
  renderSelectedFiles();
}

function updateSendButton() {
  const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  sendButton.disabled = selectedFiles.length === 0;
  sendLabel.textContent = selectedFiles.length === 0
    ? 'Envoyer'
    : `Envoyer ${selectedFiles.length} fichier${selectedFiles.length > 1 ? 's' : ''} · ${formatBytes(total)}`;
}

/* ---------- File d’envoi ---------- */

// Plusieurs fichiers partent l’un après l’autre vers l’appareil choisi.
const fileQueue: Array<{ peerId: string; file: File; entryId: string }> = [];
const queueState = { running: false, current: null as { peerId: string; file: File; entryId: string } | null };

function enqueueFiles(peerId: string, files: File[]) {
  for (const file of files) {
    const entryId = `queued-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    fileQueue.push({ peerId, file, entryId });
    upsertEntry({ id: entryId, kind: 'file', direction: 'sent', peerId, fileName: file.name, fileSize: file.size, state: 'waiting' });
  }
  void runFileQueue();
}

async function runFileQueue() {
  if (queueState.running) {
    return;
  }

  queueState.running = true;
  while (fileQueue.length > 0 && peerState.manager) {
    const job = fileQueue.shift() as { peerId: string; file: File; entryId: string };
    queueState.current = job;
    try {
      const isOffline = !peerState.peers.some((peer) => peer.id === job.peerId);
      const sent = await peerState.manager.sendFile(job.peerId, job.file, isOffline);
      const entry = entries.get(job.entryId);
      // Envoi abandonné sans autre explication : demande hors ligne refusée/expirée, ou appareil injoignable.
      if (!sent && entry?.state === 'waiting') {
        updateEntry(job.entryId, entry.expiresAt
          ? { state: 'expired', reason: 'demande refusée ou restée sans réponse' }
          : { state: 'failed', reason: 'appareil injoignable' });
      }
    } catch (error) {
      console.error('[GeniusSend] échec de l’envoi', error);
      const reason = error instanceof Error ? error.message.replace(/\.$/, '') : 'erreur inconnue';
      updateEntry(job.entryId, { state: 'failed', reason });
      showToast({ title: `Échec de l’envoi de ${job.file.name}`, message: reason, tone: 'error' });
    }
  }
  queueState.current = null;
  queueState.running = false;
}

/** Le gestionnaire WebRTC attribue son propre identifiant : la ligne de la file l’adopte. */
function adoptTransferId(transferId: string) {
  const job = queueState.current;
  if (!job || job.entryId === transferId) return;
  const entry = entries.get(job.entryId);
  const refs = entryElements.get(job.entryId);
  if (entry) {
    entries.delete(job.entryId);
    entry.id = transferId;
    entries.set(transferId, entry);
  }
  if (refs) {
    entryElements.delete(job.entryId);
    refs.item.dataset.entryId = transferId;
    entryElements.set(transferId, refs);
  }
  job.entryId = transferId;
}

/* ---------- Demandes reçues ---------- */

type TransferRequestInfo = { transferId: string; fileName: string; fileSize: number; expiresInMs: number; mimeType?: string; senderName?: string; expiresAt?: number };
type PendingRequest = { peerId: string; transfer: TransferRequestInfo; offline: boolean; expiresAt: number };
const requestQueue: PendingRequest[] = [];
let activeRequest: PendingRequest | null = null;

function renderRequestCountdown() {
  if (activeRequest) {
    requestCountdown.textContent = `Temps restant pour répondre : ${formatCountdown(activeRequest.expiresAt - Date.now())}`;
  }
}

function renderNextTransferRequest() {
  activeRequest ??= requestQueue.shift() ?? null;
  if (!activeRequest) {
    if (requestDialog.open) requestDialog.close();
    return;
  }

  const { peerId, transfer } = activeRequest;
  requestTitle.textContent = `${transfer.senderName || getPeerDisplayName(peerId)} veut vous envoyer un fichier`;
  requestFileName.textContent = transfer.fileName;
  requestFileSize.textContent = formatBytes(transfer.fileSize);
  requestQueueInfo.hidden = requestQueue.length === 0;
  requestQueueInfo.textContent = `${requestQueue.length} autre${requestQueue.length > 1 ? 's' : ''} demande${requestQueue.length > 1 ? 's' : ''} en attente`;
  renderRequestCountdown();
  if (!requestDialog.open) requestDialog.showModal();
}

function showTransferRequest(peerId: string, transfer: TransferRequestInfo, offline = false) {
  if (activeRequest?.transfer.transferId === transfer.transferId || requestQueue.some((entry) => entry.transfer.transferId === transfer.transferId)) return;
  const expiresAt = transfer.expiresAt ?? Date.now() + transfer.expiresInMs;
  requestQueue.push({ peerId, transfer, offline, expiresAt });
  renderNextTransferRequest();
}

function removeTransferRequest(transferId: string) {
  const index = requestQueue.findIndex((entry) => entry.transfer.transferId === transferId);
  if (index >= 0) requestQueue.splice(index, 1);
  const wasActive = activeRequest?.transfer.transferId === transferId;
  if (wasActive) {
    activeRequest = null;
    renderNextTransferRequest();
  }
  return wasActive || index >= 0;
}

function answerRequest(accepted: boolean) {
  const request = activeRequest;
  if (!request) return;
  const { peerId, transfer, offline } = request;
  activeRequest = null;

  if (accepted) {
    // La ligne existe avant le premier événement de progression.
    upsertEntry({ id: transfer.transferId, kind: 'file', direction: 'received', peerId, fileName: transfer.fileName, fileSize: transfer.fileSize, state: offline ? 'waiting' : 'active' });
  }

  if (offline) {
    if (accepted) peerState.manager?.approveOfflineTransfer(peerId, transfer.transferId);
    peerState.socket?.emit('transfer:offline:decision', { transferId: transfer.transferId, accepted });
  } else if (accepted) {
    peerState.manager?.acceptTransfer(peerId, transfer.transferId);
  } else {
    peerState.manager?.rejectTransfer(peerId, transfer.transferId);
  }

  if (!accepted) showTemporaryTransferStatus('Transfert refusé', 5_000);
  renderNextTransferRequest();
}

/* ---------- Événements du gestionnaire WebRTC ---------- */

function handleTransferProgress(progress: TransferProgress) {
  const direction = progress.direction === 'sending' ? 'sent' : 'received';
  const entry = entries.get(progress.transferId)
    ?? upsertEntry({ id: progress.transferId, kind: 'file', direction, peerId: progress.peerId, fileName: progress.fileName, fileSize: progress.totalBytes, state: 'active' });

  const now = performance.now();
  const isFinal = progress.bytesTransferred >= progress.totalBytes;
  if (progress.bytesTransferred === 0 || entry.state === 'waiting') {
    entry.startedAt = now;
  }

  // Au plus une dizaine de rafraîchissements par seconde : l’affichage ne doit pas ralentir le transfert.
  if (!isFinal && entry.state === 'active' && now - entry.lastRenderAt < 100) {
    entry.bytes = progress.bytesTransferred;
    return;
  }
  entry.lastRenderAt = now;
  updateEntry(entry.id, {
    bytes: progress.bytesTransferred,
    fileSize: progress.totalBytes,
    expiresAt: undefined,
    state: isFinal && progress.totalBytes > 0 ? 'verifying' : 'active'
  });
}

function handleTransferComplete(result: TransferResult) {
  if (result.direction === 'receiving' && result.ok && result.file) {
    // L’URL reste valide pour le bouton « Enregistrer », jusqu’à « Tout effacer ».
    const url = URL.createObjectURL(result.file);
    downloadUrl(url, result.fileName);
    upsertEntry({
      id: result.transferId,
      kind: 'file',
      direction: 'received',
      peerId: result.peerId,
      fileName: result.fileName,
      fileSize: result.file.size,
      mimeType: result.file.type,
      url,
      state: 'done',
      time: new Date()
    });
    showToast({ message: `${result.fileName} reçu de ${getPeerDisplayName(result.peerId)}`, tone: 'success' });
    return;
  }

  upsertEntry({
    id: result.transferId,
    kind: 'file',
    direction: result.direction === 'sending' ? 'sent' : 'received',
    peerId: result.peerId,
    fileName: result.fileName,
    state: result.ok ? 'done' : 'failed',
    reason: result.reason,
    time: new Date()
  });

  if (!result.ok) {
    showToast({ title: `Échec : ${result.fileName}`, message: result.reason ?? 'le transfert a été interrompu', tone: 'error' });
  }
}

function createManager(socket: Socket) {
  return new PeerConnectionManager({
    localPeerId: peerState.id,
    sendSignal: (type, payload, to) => {
      socket.emit('signal:message', { type, payload, from: peerState.id, to });
    },
    onStatusChange: (status) => updateTransferStatus(status),
    onPeerStateChange: () => renderRadar(),
    isPeerOnline: (peerId) => peerState.peers.some((peer) => peer.id === peerId),
    onTransferRequest: (peerId, transfer) => showTransferRequest(peerId, transfer),
    onTransferPending: ({ peerId, transferId, expiresInMs }) => {
      adoptTransferId(transferId);
      const job = queueState.current;
      upsertEntry({
        id: transferId,
        kind: 'file',
        direction: 'sent',
        peerId,
        fileName: job?.file.name,
        fileSize: job?.file.size,
        state: 'waiting',
        expiresAt: Date.now() + expiresInMs
      });
    },
    onTransferExpired: (peerId, transferId) => {
      if (removeTransferRequest(transferId)) {
        showTemporaryTransferStatus('Une demande de transfert a expiré', 5_000);
      }
      updateEntry(transferId, { state: 'expired', reason: 'pas de réponse à temps' });
    },
    onTransferProgress: handleTransferProgress,
    onTransferComplete: handleTransferComplete,
    onTransferCancelled: (peerId, transferId) => {
      if (transferId) {
        removeTransferRequest(transferId);
        updateEntry(transferId, { state: 'cancelled' });
      }
      showTemporaryTransferStatus('Transfert annulé', 5_000);
    },
    onTransferDecision: ({ peerId, transferId, accepted }) => {
      if (!accepted) {
        updateEntry(transferId, { state: 'refused', reason: undefined });
        showToast({ message: `${getPeerDisplayName(peerId)} a refusé le fichier`, tone: 'error' });
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
    getPeerName: getPeerDisplayName
  });
}

/* ---------- Connexion au serveur ---------- */

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
  chat.attach(socket);

  socket.on('connect', () => {
    peerState.id = deviceId;
    replacedByAnotherTab = false;
    updateServerStatus('Serveur connecté', 'connected');
    registerLocalPeer(socket);
    peerState.manager ??= createManager(socket);
  });

  socket.on('disconnect', (reason) => {
    updateServerStatus(replacedByAnotherTab ? 'Ouvert ailleurs' : 'Reconnexion…', 'offline');
    for (const [transferId, waiter] of offlineRequestWaiters) {
      window.clearTimeout(waiter.timeoutId);
      offlineRequestWaiters.delete(transferId);
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
    showToast({
      title: 'GeniusSend est ouvert ailleurs',
      message: 'Cet appareil utilise GeniusSend dans un autre onglet ou une autre fenêtre.',
      action: {
        label: 'Utiliser ici',
        onClick: () => {
          replacedByAnotherTab = false;
          socket.connect();
        }
      }
    });
  });

  socket.on('peers:list', (peers: Peer[]) => {
    peerState.peers = peers;
    renderRadar();
  });

  socket.on('signal:message', (payload) => {
    if (peerState.manager) {
      void peerState.manager.handleIncoming(payload);
    }
  });

  socket.on('push:config', ({ publicKey, configured }: { publicKey: string | null; configured: boolean }) => {
    vapidPublicKey = publicKey;
    // Les notifications Push exigent HTTPS : en HTTP, la section reste masquée.
    pushSection.hidden = !window.isSecureContext;
    pushButton.disabled = !configured || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window);
    pushButton.textContent = configured ? 'Activer les notifications' : 'Notifications non configurées';
    if (!configured) pushStatus.textContent = 'Le serveur doit être configuré avec ses clés VAPID pour envoyer des notifications.';
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
    waiter.resolve(accepted);
  });

  socket.on('transfer:offline:queued', ({ transferId, pushSent }: { transferId: string; pushSent: boolean }) => {
    updateEntry(transferId, { reason: pushSent ? 'notification envoyée' : undefined });
  });

  socket.on('transfer:offline:expired', ({ transferId, reason }: { transferId: string; reason: string }) => {
    const waiter = offlineRequestWaiters.get(transferId);
    if (waiter) {
      window.clearTimeout(waiter.timeoutId);
      offlineRequestWaiters.delete(transferId);
      waiter.resolve(false);
    }
    removeTransferRequest(transferId);
    if (reason === 'sender-disconnected') showTemporaryTransferStatus('L’expéditeur s’est déconnecté : demande annulée', 5_000);
  });

  socket.on('transfer:offline:cancelled', ({ transferId }: { transferId: string }) => {
    removeTransferRequest(transferId);
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

/* ---------- Envoi ---------- */

function sendSelection() {
  const targetPeerId = peerState.selectedPeerId;
  if (!targetPeerId) return;

  if (!peerState.manager) {
    showToast({ message: 'Connexion au serveur en cours, réessayez dans un instant', tone: 'error' });
    return;
  }

  if (selectedFiles.length === 0) return;
  enqueueFiles(targetPeerId, selectedFiles.splice(0));
  renderSelectedFiles();
  // Sur téléphone, on referme le volet pour laisser voir la progression.
  if (mobileLayout.matches) closeSheet();
}

/* ---------- Écouteurs d’interface ---------- */

sendButton.addEventListener('click', sendSelection);
closeSheetBtn.addEventListener('click', closeSheet);
sheetBackdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sendSheet.dataset.open === 'true' && !requestDialog.open && !profileDialog.open && !qrDialog.open) {
    closeSheet();
  }
});

// Sur téléphone, glisser la poignée vers le bas referme le volet.
let dragStartY: number | null = null;
sheetHandle.addEventListener('pointerdown', (event) => {
  dragStartY = event.clientY;
  sheetHandle.setPointerCapture(event.pointerId);
});
sheetHandle.addEventListener('pointermove', (event) => {
  if (dragStartY === null) return;
  const offset = Math.max(0, event.clientY - dragStartY);
  sendSheet.style.transform = `translateY(${offset}px)`;
});
sheetHandle.addEventListener('pointerup', (event) => {
  if (dragStartY === null) return;
  const offset = event.clientY - dragStartY;
  dragStartY = null;
  sendSheet.style.transform = '';
  if (offset > 80) closeSheet();
});

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  // Remise à zéro : choisir à nouveau le même fichier doit fonctionner.
  fileInput.value = '';
  addSelectedFiles(files);
});

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
for (const type of ['dragenter', 'dragover'] as const) {
  sendSheet.addEventListener(type, (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dropzone.classList.add('dragging');
  });
}
sendSheet.addEventListener('dragleave', (event) => {
  if (!sendSheet.contains(event.relatedTarget as Node | null)) {
    dropzone.classList.remove('dragging');
  }
});
sendSheet.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  addSelectedFiles(Array.from(event.dataTransfer?.files ?? []));
});

// Un fichier lâché à côté de la zone ne doit pas remplacer la page par son contenu.
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
      event.preventDefault();
    }
  });
}

// Coller une image (capture d’écran…) : dans le chat s’il est ouvert, sinon vers l’appareil choisi.
document.addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files ?? []).map(nameClipboardFile);
  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  if (chat.isOpen()) {
    chat.uploadFiles(files);
    return;
  }
  if (!peerState.selectedPeerId) {
    showToast({ message: 'Ouvrez le chat ou choisissez un appareil sur le radar', tone: 'info' });
    return;
  }
  addSelectedFiles(files);
});

clearHistoryBtn.addEventListener('click', clearHistory);
acceptTransferBtn.addEventListener('click', () => answerRequest(true));
rejectTransferBtn.addEventListener('click', () => answerRequest(false));
// Échap ne doit pas faire disparaître une demande sans réponse.
requestDialog.addEventListener('cancel', (event) => event.preventDefault());

/* ---------- Profil ---------- */

function openProfile() {
  deviceNameInput.value = peerState.deviceName;
  systemNameInput.value = platformLabel[detectedPlatform] || 'Inconnu';
  profileDialog.showModal();
}

profileButton.addEventListener('click', openProfile);

function openQrDialog() {
  renderShareQr();
  qrDialog.showModal();
}

qrButton.addEventListener('click', openQrDialog);
radarQrButton.addEventListener('click', openQrDialog);

// Un clic sur le fond ou sur ✕ ferme le profil et la fenêtre du QR code.
for (const dialog of [profileDialog, qrDialog]) {
  dialog.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target === dialog || target.closest('[data-close]')) {
      dialog.close();
    }
  });
}

saveProfileBtn.addEventListener('click', () => {
  const name = deviceNameInput.value.trim() || peerState.deviceName;
  peerState.deviceName = name;
  localStorage.setItem(deviceNameStorageKey, name);
  renderDeviceIdentity();
  if (peerState.socket?.connected) {
    registerLocalPeer(peerState.socket);
  }
  profileDialog.close();
  showToast({ message: 'Profil enregistré', tone: 'success' });
});

function decodeVapidKey(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

pushButton.addEventListener('click', async () => {
  if (!vapidPublicKey || !peerState.socket?.connected) return;
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      pushStatus.textContent = 'La permission de notification n’a pas été accordée.';
      return;
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(vapidPublicKey) });
    const result = new Promise<{ ok: boolean; message?: string }>((resolve) => peerState.socket?.once('push:subscription-result', resolve));
    peerState.socket.emit('push:subscribe', subscription.toJSON());
    const saved = await result;
    pushStatus.textContent = saved.ok ? 'Notifications activées sur cet appareil.' : saved.message || 'Impossible d’enregistrer les notifications.';
    if (saved.ok) pushButton.textContent = 'Notifications activées';
  } catch (error) {
    console.error('[GeniusSend] Push setup failed:', error);
    pushStatus.textContent = 'Activation impossible. Vérifiez HTTPS, la permission et les réglages du navigateur.';
  }
});

/* ---------- Démarrage ---------- */

// Le service worker (cache hors ligne, notifications) n’est autorisé qu’en HTTPS ou sur localhost.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('[GeniusSend] Enregistrement du service worker impossible:', error);
    });
  });
}

setupInstall(installButton, (title, message, tone) => showToast({ title, message, tone }));

// Le chat occupe la colonne de droite sur ordinateur, et tout l’écran sur téléphone.
const chat = createChat({
  panel: chatPanel,
  button: chatButton,
  badge: chatBadge,
  deviceId,
  getSocket: () => peerState.socket,
  notify: showToast,
  onOpenChange: (open) => {
    if (open) closeSheet();
    layout.classList.toggle('chat-open', open);
    document.body.classList.toggle('chat-locked', open && mobileLayout.matches);
  }
});

// Passage ordinateur ↔ téléphone (rotation, redimensionnement) : le volet et le chat changent de forme.
mobileLayout.addEventListener('change', () => {
  const open = sendSheet.dataset.open === 'true';
  sheetBackdrop.hidden = !(open && mobileLayout.matches);
  document.body.classList.toggle('sheet-locked', open && mobileLayout.matches);
  document.body.classList.toggle('chat-locked', chat.isOpen() && mobileLayout.matches);
});

renderDeviceIdentity();
peerState.socket = createClientSocket();
renderRadar();
