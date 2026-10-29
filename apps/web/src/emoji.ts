// Sélection d’emojis courants, sans bibliothèque externe : le clavier du système reste disponible pour les autres.
export const EMOJI_CATEGORIES: Array<{ label: string; emojis: string[] }> = [
  {
    label: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😛', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😒', '😔', '😕', '🙁', '😣', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤯', '😳', '😱', '😨', '🤗', '🤔', '🤭', '🤫', '😶', '😐', '😬', '🙄', '😴', '🤤', '😵', '🤐', '🥴', '🤢', '🤧', '😷', '🤒', '🤕']
  },
  {
    label: 'Gestes',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🖐️', '👋', '🤝', '🙏', '👏', '🙌', '💪', '✍️']
  },
  {
    label: 'Cœurs et symboles',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💕', '💞', '💖', '💘', '✨', '⭐', '🔥', '💯', '✅', '❌', '❗', '❓', '💤']
  },
  {
    label: 'Objets',
    emojis: ['🎉', '🎊', '🎁', '🎂', '📷', '📸', '📱', '💻', '🖥️', '📁', '📎', '📌', '📝', '📅', '⏰', '🔒', '🔑', '💡', '🎵', '🎧', '🎮', '⚽', '🚗', '✈️', '🏠']
  },
  {
    label: 'Nourriture',
    emojis: ['🍕', '🍔', '🍟', '🌮', '🍣', '🍩', '🍪', '🍫', '🍿', '☕', '🍺', '🍷', '🥂', '🍾', '🍎', '🍉', '🍓', '🍌']
  },
  {
    label: 'Animaux et nature',
    emojis: ['🐶', '🐱', '🐭', '🐰', '🦊', '🐼', '🐨', '🦁', '🐯', '🐵', '🐧', '🐦', '🦋', '🐢', '🌸', '🌹', '🌻', '🌈', '☀️', '🌙', '⛄', '🌊']
  }
];

const RECENT_STORAGE_KEY = 'geniussend-recent-emojis';
const RECENT_LIMIT = 16;

export function loadRecentEmojis(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string) {
  const recent = [emoji, ...loadRecentEmojis().filter((value) => value !== emoji)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
  } catch {
    // Mémoriser les récents est un confort : sans stockage, le sélecteur fonctionne quand même.
  }
  return recent;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

/** Un message fait uniquement de 1 à 3 emojis s’affiche en grand, comme sur WhatsApp. */
export function isShortEmojiMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !EMOJI_ONLY.test(trimmed) || /^[\d#*\s]+$/.test(trimmed)) {
    return false;
  }
  const characters = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(trimmed.replace(/\s/g, '')))
    : Array.from(trimmed.replace(/\s/g, ''));
  return characters.length <= 3;
}
