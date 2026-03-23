import { describe, it, expect } from 'vitest';
import { entitiesToHtml } from '../entities-to-html.js';
import type { MessageEntity } from 'grammy/types';

describe('entitiesToHtml', () => {
  it('returns escaped plain text when no entities', () => {
    expect(entitiesToHtml('hello <world>')).toBe('hello &lt;world&gt;');
  });

  it('wraps bold entity', () => {
    const entities: MessageEntity[] = [{ type: 'bold', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello world', entities)).toBe('<b>hello</b> world');
  });

  it('wraps blockquote entity', () => {
    const entities: MessageEntity[] = [{ type: 'blockquote', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello', entities)).toBe('<blockquote>hello</blockquote>');
  });

  it('wraps expandable_blockquote entity', () => {
    const entities: MessageEntity[] = [{ type: 'expandable_blockquote', offset: 0, length: 5 }];
    expect(entitiesToHtml('hello', entities)).toBe('<blockquote expandable>hello</blockquote>');
  });

  it('escapes HTML special chars inside entity spans', () => {
    const entities: MessageEntity[] = [{ type: 'bold', offset: 0, length: 7 }];
    expect(entitiesToHtml('a < b & c', entities)).toBe('<b>a &lt; b &amp;</b> c');
  });
});
