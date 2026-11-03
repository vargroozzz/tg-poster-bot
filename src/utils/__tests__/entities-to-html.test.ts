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

  it('keeps a date_time entity as a tg-time tag, with and without a format', () => {
    const entities: MessageEntity[] = [
      { type: 'date_time', offset: 3, length: 5, unix_time: 1647531900, date_time_format: 'wDT' },
      { type: 'date_time', offset: 12, length: 5, unix_time: 1647531900, date_time_format: '' },
    ];
    expect(entitiesToHtml('at 22:45 or 22:45', entities)).toBe(
      'at <tg-time unix="1647531900" format="wDT">22:45</tg-time> or <tg-time unix="1647531900">22:45</tg-time>'
    );
  });
});
