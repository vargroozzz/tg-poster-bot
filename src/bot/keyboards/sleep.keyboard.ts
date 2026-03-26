import { InlineKeyboard } from 'grammy';

export function createSleepStatusKeyboard(enabled: boolean): InlineKeyboard {
  if (enabled) {
    return new InlineKeyboard()
      .text('Change hours', 'sleep:change')
      .text('Disable', 'sleep:disable');
  }
  return new InlineKeyboard().text('Enable', 'sleep:enable');
}

export function createHourPickerKeyboard(phase: 'start'): InlineKeyboard;
export function createHourPickerKeyboard(phase: 'end', startHour: number): InlineKeyboard;
export function createHourPickerKeyboard(
  phase: 'start' | 'end',
  startHour?: number
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let h = 0; h < 24; h++) {
    const label = h.toString().padStart(2, '0');
    const data =
      phase === 'start' ? `sleep:start:${h}` : `sleep:end:${startHour}:${h}`;
    keyboard.text(label, data);
    if ((h + 1) % 6 === 0) keyboard.row();
  }
  return keyboard;
}

export function createSleepConfirmKeyboard(start: number, end: number): InlineKeyboard {
  return new InlineKeyboard()
    .text('Confirm', `sleep:confirm:${start}:${end}`)
    .text('Cancel', 'sleep:cancel');
}
