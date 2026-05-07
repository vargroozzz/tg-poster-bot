import { describe, it, expect } from 'vitest';
import {
  createEditChannelSelectKeyboard,
  createEditForwardActionKeyboard,
  createEditTextHandlingKeyboard,
} from '../edit-keyboards.js';

const SID = 'aaaaaaaaaaaaaaaaaaaaaaaa'; // 24-char session ID

describe('createEditChannelSelectKeyboard', () => {
  it('embeds sessionId in callback data', () => {
    const kb = createEditChannelSelectKeyboard(
      [{ channelId: '-100123', channelTitle: 'My Channel' }],
      SID
    );
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    expect(rows[0][0].callback_data).toBe(`queue:edit:ch:${SID}:-100123`);
  });
});

describe('createEditForwardActionKeyboard', () => {
  it('embeds sessionId in all buttons', () => {
    const kb = createEditForwardActionKeyboard(SID);
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    const allData = rows.flat().map((b) => b.callback_data);
    expect(allData).toContain(`queue:edit:action:${SID}:quick`);
    expect(allData).toContain(`queue:edit:action:${SID}:transform`);
    expect(allData).toContain(`queue:edit:action:${SID}:forward`);
  });
});

describe('createEditTextHandlingKeyboard', () => {
  it('embeds sessionId in all buttons', () => {
    const kb = createEditTextHandlingKeyboard(SID);
    const rows = (kb as any).inline_keyboard as Array<Array<{ callback_data: string }>>;
    const allData = rows.flat().map((b) => b.callback_data);
    expect(allData).toContain(`queue:edit:text:${SID}:keep`);
    expect(allData).toContain(`queue:edit:text:${SID}:remove`);
    expect(allData).toContain(`queue:edit:text:${SID}:quote`);
  });
});
