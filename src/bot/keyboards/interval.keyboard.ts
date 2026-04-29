import { InlineKeyboard } from 'grammy';
import { VALID_INTERVALS } from '../../utils/post-interval.js';

export function createIntervalKeyboard(currentInterval: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const minutes of VALID_INTERVALS) {
    const label = currentInterval === minutes ? `✓ ${minutes} min` : `${minutes} min`;
    keyboard.text(label, `interval:set:${minutes}`);
  }
  return keyboard;
}
