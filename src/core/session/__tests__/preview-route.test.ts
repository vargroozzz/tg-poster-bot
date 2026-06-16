import { describe, it, expect } from 'vitest';
import { classifyScheduleConfirm } from '../preview-route.js';
import type { ISession } from '../../../database/models/session.model.js';

// Only the fields the classifier reads; the rest of ISession is irrelevant here.
const session = (o: Partial<ISession>): ISession => o as ISession;

const completeEdit: Partial<ISession> = {
  editingPostId: 'post1',
  editingRawContent: { type: 'text', text: 'hi' } as ISession['editingRawContent'],
  editingOriginalForward: { messageId: 1, chatId: 1 } as ISession['editingOriginalForward'],
  editingOriginalScheduledTime: new Date(),
  editingOriginalChannelId: 'chA',
};

describe('classifyScheduleConfirm — edit sessions', () => {
  // Corruption is not a route — confirmEdit's guard owns that. A field-incomplete
  // edit still routes by channel; the downstream guard catches the missing fields.
  it('routes an incomplete edit by channel rather than flagging corruption', () => {
    expect(classifyScheduleConfirm(session({ editingPostId: 'post1', selectedChannel: 'chA' }))).toBe('edit-move-channel');
  });

  it('routes same-channel edits to edit-same-channel', () => {
    expect(classifyScheduleConfirm(session({ ...completeEdit, selectedChannel: 'chA' }))).toBe('edit-same-channel');
  });

  it('routes channel-change edits to edit-move-channel', () => {
    expect(classifyScheduleConfirm(session({ ...completeEdit, selectedChannel: 'chB' }))).toBe('edit-move-channel');
  });
});

describe('classifyScheduleConfirm — reply sessions', () => {
  it('routes together replies to reply-together', () => {
    expect(
      classifyScheduleConfirm(session({ isReply: true, replyParentPostId: 'p1', replyMode: 'together' }))
    ).toBe('reply-together');
  });

  it('routes separated (and unset-mode) replies to reply-separated', () => {
    expect(
      classifyScheduleConfirm(session({ isReply: true, replyParentPostId: 'p1', replyMode: 'separated' }))
    ).toBe('reply-separated');
    expect(
      classifyScheduleConfirm(session({ isReply: true, replyParentPostId: 'p1' }))
    ).toBe('reply-separated');
  });

  it('treats an incomplete reply session (no parent) as normal', () => {
    expect(classifyScheduleConfirm(session({ isReply: true }))).toBe('normal');
  });
});

describe('classifyScheduleConfirm — normal', () => {
  it('routes a plain scheduling confirm to normal', () => {
    expect(classifyScheduleConfirm(session({ selectedChannel: 'chA' }))).toBe('normal');
  });

  it('prefers the edit route over reply/normal when editingPostId is set', () => {
    expect(
      classifyScheduleConfirm(session({ ...completeEdit, selectedChannel: 'chA', isReply: true, replyParentPostId: 'p1' }))
    ).toBe('edit-same-channel');
  });
});
