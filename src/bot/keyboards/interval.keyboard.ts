import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS, type PostInterval } from '../../utils/post-interval.js';

export function createIntervalKeyboard(
  currentInterval: PostInterval,
  showRepack = false
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${minutes}`);
  }
  if (showRepack) {
    keyboard.row().text(
      `Reschedule queue to ${currentInterval} min intervals`,
      'interval:repack'
    );
  }
  return keyboard;
}
