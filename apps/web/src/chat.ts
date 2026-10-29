import type { Socket } from 'socket.io-client';
import { appendLinkifiedText, formatBytes, formatTime } from './format';
import { icon } from './icons';

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  kind: 'text' | 'file';
  text?: string;
  file?: { id: string; name: string; size: number; mimeType: string };
  createdAt: number;
};

type Notify = (options: { title?: string; message: string; tone?: 'info' | 'success' | 'error' }) => void;

type ChatOptions = {
  panel: HTMLElement;
  button: HTMLButtonElement;
  badge: HTMLElement;
  deviceId: string;
  getSocket: () => Socket | null;
  notify: Notify;
  onOpenChange: (open: boolean) => void;
};

// Limites alignées sur le serveur.
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4000;
// Ces formats s’affichent en aperçu ; les autres fichiers se téléchargent.
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const AUTHOR_COLORS = ['#38bdf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c'];
// Deux messages du même auteur à moins de 5 minutes d’écart forment un seul groupe.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

function authorColor(authorId: string) {
  let hash = 0;
  for (const character of authorId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length];
}

function dayLabel(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (date.toDateString() === today.toDateString()) return 'Aujourd’hui';
  if (date.toDateString() === yesterday.toDateString()) return 'Hier';
  return date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Petit « ding » discret, sans fichier audio. */
function playNotificationSound() {
  try {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const now = context.currentTime;
    [880, 1320].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.08, now + index * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.09 + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + index * 0.09);
      oscillator.stop(now + index * 0.09 + 0.2);
    });
    window.setTimeout(() => void context.close(), 600);
  } catch {
    // Le son est un bonus : sans autorisation audio du navigateur, on s’en passe.
  }
}

export function createChat({ panel, button, badge, deviceId, getSocket, notify, onOpenChange }: ChatOptions) {
  panel.innerHTML = `
    <div class="chat-header">
      <span class="chat-header-icon">${icon('chat')}</span>
      <div class="chat-title">
        <h2>Chat</h2>
        <p class="chat-presence" id="chat-presence">Tous les appareils connectés</p>
      </div>
      <button class="icon-button small" type="button" data-chat-close aria-label="Fermer le chat">${icon('close')}</button>
    </div>
    <div class="chat-messages" id="chat-messages" role="log" aria-live="polite" aria-label="Messages du chat">
      <p class="chat-empty" id="chat-empty">Aucun message pour l’instant.<br />Dites bonjour 👋</p>
    </div>
    <ul class="chat-uploads" id="chat-uploads" aria-label="Fichiers en cours d’envoi"></ul>
    <form class="chat-composer" id="chat-composer">
      <button class="icon-button small chat-attach" id="chat-attach" type="button" aria-label="Joindre des fichiers" title="Joindre des fichiers">${icon('paperclip')}</button>
      <input id="chat-file-input" type="file" multiple hidden />
      <textarea id="chat-input" rows="1" maxlength="${MAX_TEXT_LENGTH}" placeholder="Écrire un message…" aria-label="Message"></textarea>
      <button class="chat-send" id="chat-send" type="submit" aria-label="Envoyer" disabled>${icon('send')}</button>
    </form>
  `;

  const messagesBox = panel.querySelector('#chat-messages') as HTMLDivElement;
  const emptyState = panel.querySelector('#chat-empty') as HTMLParagraphElement;
  const presence = panel.querySelector('#chat-presence') as HTMLParagraphElement;
  const uploadsList = panel.querySelector('#chat-uploads') as HTMLUListElement;
  const composer = panel.querySelector('#chat-composer') as HTMLFormElement;
  const input = panel.querySelector('#chat-input') as HTMLTextAreaElement;
  const sendButton = panel.querySelector('#chat-send') as HTMLButtonElement;
  const attachButton = panel.querySelector('#chat-attach') as HTMLButtonElement;
  const fileInput = panel.querySelector('#chat-file-input') as HTMLInputElement;

  const messageIds = new Set<string>();
  let lastMessage: ChatMessage | null = null;
  let unread = 0;
  let open = false;

  function isNearBottom() {
    return messagesBox.scrollHeight - messagesBox.scrollTop - messagesBox.clientHeight < 120;
  }

  function scrollToBottom() {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }

  function renderBadge() {
    badge.hidden = unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    button.setAttribute('aria-label', unread > 0 ? `Ouvrir le chat (${unread} non lu${unread > 1 ? 's' : ''})` : 'Ouvrir le chat');
  }

  function renderFile(file: NonNullable<ChatMessage['file']>) {
    const url = `/chat/files/${file.id}`;
    const block = document.createElement('div');
    block.className = 'chat-file';

    if (PREVIEW_TYPES.has(file.mimeType)) {
      const link = document.createElement('a');
      link.className = 'chat-image';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener';
      const image = document.createElement('img');
      image.src = url;
      image.alt = file.name;
      image.loading = 'lazy';
      // L’image modifie la hauteur du fil : on reste en bas si on y était.
      image.addEventListener('load', () => {
        if (isNearBottom()) scrollToBottom();
      }, { once: true });
      link.append(image);
      block.append(link);
    }

    const row = document.createElement('div');
    row.className = 'chat-file-row';
    const fileIcon = document.createElement('span');
    fileIcon.className = 'chat-file-icon';
    fileIcon.innerHTML = icon('file');
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = file.name;
    const size = document.createElement('small');
    size.textContent = formatBytes(file.size);
    details.append(name, size);
    const download = document.createElement('a');
    download.className = 'icon-button small chat-download';
    download.href = `${url}?download=1`;
    download.download = file.name;
    download.setAttribute('aria-label', `Télécharger ${file.name}`);
    download.title = 'Télécharger';
    download.innerHTML = icon('download');
    row.append(fileIcon, details, download);
    block.append(row);
    return block;
  }

  function appendMessage(message: ChatMessage) {
    if (messageIds.has(message.id)) return;
    messageIds.add(message.id);
    emptyState.hidden = true;

    const previous = lastMessage;
    if (!previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString()) {
      const separator = document.createElement('div');
      separator.className = 'chat-day';
      separator.textContent = dayLabel(message.createdAt);
      messagesBox.append(separator);
    }

    const mine = message.authorId === deviceId;
    const startsGroup = !previous || previous.authorId !== message.authorId || message.createdAt - previous.createdAt > GROUP_WINDOW_MS;
    const row = document.createElement('div');
    row.className = `chat-row ${mine ? 'mine' : 'theirs'}${startsGroup ? ' group-start' : ''}`;
    row.dataset.messageId = message.id;

    const bubble = document.createElement('div');
    bubble.className = `chat-bubble${message.kind === 'file' ? ' has-file' : ''}`;

    if (!mine && startsGroup) {
      const author = document.createElement('span');
      author.className = 'chat-author';
      author.style.color = authorColor(message.authorId);
      author.textContent = message.authorName;
      bubble.append(author);
    }

    if (message.kind === 'file' && message.file) {
      bubble.append(renderFile(message.file));
    } else {
      const text = document.createElement('p');
      text.className = 'chat-text';
      appendLinkifiedText(text, message.text ?? '');
      bubble.append(text);
    }

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = formatTime(new Date(message.createdAt));
    bubble.append(time);
    row.append(bubble);

    const stickToBottom = mine || isNearBottom();
    messagesBox.append(row);
    lastMessage = message;
    if (stickToBottom) scrollToBottom();
  }

  function receive(message: ChatMessage) {
    const isNew = !messageIds.has(message.id);
    appendMessage(message);
    if (!isNew || message.authorId === deviceId) return;

    // Un message arrive alors que le chat est fermé ou l’onglet caché : badge, son et aperçu.
    if (!open || document.hidden) {
      unread += 1;
      renderBadge();
      playNotificationSound();
    }
    if (!open) {
      notify({
        title: message.authorName,
        message: message.kind === 'file' ? `📎 ${message.file?.name ?? 'Fichier'}` : (message.text ?? '').slice(0, 120),
        tone: 'info'
      });
    }
  }

  function setHistory(history: ChatMessage[]) {
    // Après une reconnexion, seuls les messages encore inconnus sont ajoutés.
    for (const message of history) appendMessage(message);
    scrollToBottom();
  }

  function updateSendState() {
    sendButton.disabled = !input.value.trim();
    // Le champ grandit avec le texte, jusqu’à cinq lignes environ.
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
  }

  function sendText() {
    const text = input.value.trim();
    if (!text) return;
    const socket = getSocket();
    if (!socket?.connected) {
      notify({ message: 'Connexion au serveur en cours : le message n’est pas parti', tone: 'error' });
      return;
    }
    socket.emit('chat:send', { text });
    input.value = '';
    updateSendState();
    input.focus();
  }

  function uploadFile(file: File) {
    if (file.size === 0) {
      notify({ message: `${file.name} est vide`, tone: 'error' });
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      notify({ title: `${file.name} est trop lourd`, message: 'Le chat accepte les fichiers jusqu’à 100 Mo. Utilisez le radar pour les plus gros.', tone: 'error' });
      return;
    }

    const item = document.createElement('li');
    item.innerHTML = `<span class="chat-file-icon">${icon('upload')}</span><div><strong></strong><progress max="100" value="0"></progress></div>`;
    (item.querySelector('strong') as HTMLElement).textContent = file.name;
    const bar = item.querySelector('progress') as HTMLProgressElement;
    const request = new XMLHttpRequest();
    const cancel = document.createElement('button');
    cancel.className = 'icon-button small';
    cancel.type = 'button';
    cancel.setAttribute('aria-label', `Annuler l’envoi de ${file.name}`);
    cancel.innerHTML = icon('close');
    cancel.addEventListener('click', () => request.abort());
    item.append(cancel);
    uploadsList.append(item);

    request.open('POST', '/chat/files');
    request.setRequestHeader('X-Device-Id', deviceId);
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) bar.value = (event.loaded / event.total) * 100;
    });
    request.addEventListener('loadend', () => {
      item.remove();
      if (request.status === 201) {
        // Le message est aussi diffusé par le serveur ; la réponse permet de l’afficher sans attendre.
        try {
          appendMessage(JSON.parse(request.responseText) as ChatMessage);
        } catch {
          // Le message arrivera de toute façon par le serveur.
        }
        return;
      }
      if (request.status === 0) return;
      notify({ title: `Échec de l’envoi de ${file.name}`, message: request.status === 413 ? 'Fichier trop lourd (100 Mo maximum).' : 'Réessayez dans un instant.', tone: 'error' });
    });
    request.send(file);
  }

  function uploadFiles(files: File[]) {
    for (const file of files) uploadFile(file);
  }

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    panel.dataset.open = String(next);
    button.setAttribute('aria-pressed', String(next));
    if (next) {
      unread = 0;
      renderBadge();
      scrollToBottom();
      // Sur ordinateur, on peut écrire tout de suite ; sur téléphone, le clavier n’apparaît qu’à la demande.
      if (!window.matchMedia('(pointer: coarse)').matches) input.focus();
    }
    onOpenChange(next);
  }

  button.addEventListener('click', () => setOpen(!open));
  panel.querySelector('[data-chat-close]')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && open && !document.querySelector('dialog[open]')) setOpen(false);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && open) {
      unread = 0;
      renderBadge();
    }
  });

  input.addEventListener('input', updateSendState);
  // Entrée envoie, Maj+Entrée va à la ligne ; sur écran tactile, Entrée va toujours à la ligne.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !window.matchMedia('(pointer: coarse)').matches) {
      event.preventDefault();
      sendText();
    }
  });
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendText();
  });
  attachButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    uploadFiles(files);
  });

  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  for (const type of ['dragenter', 'dragover'] as const) {
    panel.addEventListener(type, (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      panel.classList.add('dragging');
    });
  }
  panel.addEventListener('dragleave', (event) => {
    if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove('dragging');
  });
  panel.addEventListener('drop', (event) => {
    event.preventDefault();
    panel.classList.remove('dragging');
    uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  });

  return {
    attach(socket: Socket) {
      socket.on('chat:history', setHistory);
      socket.on('chat:message', receive);
      socket.on('chat:error', ({ message }: { message: string }) => notify({ message, tone: 'error' }));
    },
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    uploadFiles,
    setPresence(count: number) {
      presence.textContent = `${count} appareil${count > 1 ? 's' : ''} en ligne`;
    }
  };
}
