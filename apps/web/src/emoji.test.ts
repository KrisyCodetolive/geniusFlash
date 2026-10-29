import { describe, expect, it } from 'vitest';
import { EMOJI_CATEGORIES, isShortEmojiMessage } from './emoji';

describe('chat emojis', () => {
  it('should show one to three emojis alone in large size', () => {
    expect(isShortEmojiMessage('😂')).toBe(true);
    expect(isShortEmojiMessage(' 👍 🔥 ')).toBe(true);
    expect(isShortEmojiMessage('❤️👨‍👩‍👧')).toBe(true);
  });

  it('should keep ordinary messages, digits and longer emoji runs at normal size', () => {
    expect(isShortEmojiMessage('Bonjour 😊')).toBe(false);
    expect(isShortEmojiMessage('123')).toBe(false);
    expect(isShortEmojiMessage('😀😃😄😁')).toBe(false);
    expect(isShortEmojiMessage('')).toBe(false);
  });

  it('should offer each emoji only once per category', () => {
    for (const category of EMOJI_CATEGORIES) {
      expect(new Set(category.emojis).size).toBe(category.emojis.length);
    }
  });
});
