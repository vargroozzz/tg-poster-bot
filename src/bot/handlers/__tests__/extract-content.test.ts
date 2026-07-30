import { describe, it, expect } from 'vitest';
import type { Message } from 'grammy/types';
import { extractMessageContent } from '../forward.handler.js';

const msg = (fields: Record<string, unknown>): Message =>
  ({ message_id: 1, ...fields }) as unknown as Message;

describe('extractMessageContent', () => {
  it('extracts a voice message with its caption', () => {
    expect(extractMessageContent(msg({ voice: { file_id: 'v1' }, caption: 'listen' }))).toEqual({
      type: 'voice',
      fileId: 'v1',
      text: 'listen',
    });
  });

  it.each([
    ['audio', { audio: { file_id: 'a1' } }, { type: 'audio', fileId: 'a1', text: undefined }],
    ['video_note', { video_note: { file_id: 'n1' } }, { type: 'video_note', fileId: 'n1' }],
    ['sticker', { sticker: { file_id: 's1' } }, { type: 'sticker', fileId: 's1' }],
    ['dice', { dice: { emoji: '🎲', value: 4 } }, { type: 'dice', emoji: '🎲' }],
    [
      'contact',
      { contact: { phone_number: '+123', first_name: 'Ann' } },
      { type: 'contact', phoneNumber: '+123', firstName: 'Ann', lastName: undefined, vcard: undefined },
    ],
    [
      'location',
      { location: { latitude: 50.4, longitude: 30.5 } },
      { type: 'location', latitude: 50.4, longitude: 30.5 },
    ],
  ])('extracts %s', (_name, fields, expected) => {
    expect(extractMessageContent(msg(fields))).toEqual(expected);
  });

  // Telegram messages overlap: these would be mis-typed if the checks ran in the wrong order.
  it('prefers animation over the document it also carries', () => {
    const message = msg({ animation: { file_id: 'gif' }, document: { file_id: 'doc' } });
    expect(extractMessageContent(message)).toMatchObject({ type: 'animation', fileId: 'gif' });
  });

  it('prefers venue over the location it also carries', () => {
    const message = msg({
      location: { latitude: 1, longitude: 2 },
      venue: { location: { latitude: 1, longitude: 2 }, title: 'Bar', address: 'Main st' },
    });
    expect(extractMessageContent(message)).toMatchObject({ type: 'venue', title: 'Bar', address: 'Main st' });
  });

  it('builds a media group from a document album', () => {
    const album = [msg({ document: { file_id: 'd1' }, caption: 'files' }), msg({ document: { file_id: 'd2' } })];
    expect(extractMessageContent(album[0], album)).toEqual({
      type: 'media_group',
      mediaGroup: [
        { type: 'document', fileId: 'd1' },
        { type: 'document', fileId: 'd2' },
      ],
      text: 'files',
    });
  });

  it('returns null for a message with no supported content', () => {
    expect(extractMessageContent(msg({}))).toBeNull();
  });
});
