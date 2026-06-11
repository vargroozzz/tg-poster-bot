import { describe, it, expect } from 'vitest';
import { preventEmptyTextContent } from '../text-transformer.js';

describe('preventEmptyTextContent', () => {
  it('falls back to the original text for a text-only message that would become empty', () => {
    const result = preventEmptyTextContent('text', 'Hello world', '');
    expect(result).toBe('Hello world');
  });

  it('keeps the transformed text when it is non-empty', () => {
    const result = preventEmptyTextContent('text', 'Hello world', '\n\nvia Someone');
    expect(result).toBe('\n\nvia Someone');
  });

  it('leaves an empty caption on media content untouched', () => {
    const result = preventEmptyTextContent('photo', 'Original caption', '');
    expect(result).toBe('');
  });

  it('does not fall back when the original text was already empty', () => {
    const result = preventEmptyTextContent('text', '', '');
    expect(result).toBe('');
  });
});
