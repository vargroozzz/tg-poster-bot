// src/bot/handlers/callbacks/sleep.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { BotSettings } from '../../../database/models/bot-settings.model.js';
import { getSleepWindow } from '../../../utils/sleep-window.js';
import {
  createSleepStatusKeyboard,
  createHourPickerKeyboard,
  createSleepConfirmKeyboard,
} from '../../keyboards/sleep.keyboard.js';

async function showSleepStatus(ctx: Context): Promise<void> {
  const sleepWindow = await getSleepWindow();
  const enabled = sleepWindow !== null;

  const text = enabled
    ? `Sleep hours: ${String(sleepWindow.startHour).padStart(2, '0')}:00 – ${String(sleepWindow.endHour).padStart(2, '0')}:00 ✅\nPosts scheduled during this window will be pushed to after ${String(sleepWindow.endHour).padStart(2, '0')}:00.`
    : 'Sleep hours: disabled';

  await ctx.editMessageText(text, { reply_markup: createSleepStatusKeyboard(enabled) });
}

async function saveSleepSettings(
  enabled: boolean,
  startHour?: number,
  endHour?: number
): Promise<void> {
  const baseOp = BotSettings.findOneAndUpdate(
    { key: 'sleep_enabled' },
    { key: 'sleep_enabled', value: String(enabled), updatedAt: new Date() },
    { upsert: true }
  );

  const ops =
    startHour !== undefined && endHour !== undefined
      ? [
          baseOp,
          BotSettings.findOneAndUpdate(
            { key: 'sleep_start' },
            { key: 'sleep_start', value: String(startHour), updatedAt: new Date() },
            { upsert: true }
          ),
          BotSettings.findOneAndUpdate(
            { key: 'sleep_end' },
            { key: 'sleep_end', value: String(endHour), updatedAt: new Date() },
            { upsert: true }
          ),
        ]
      : [baseOp];

  await Promise.all(ops);
}

export function registerSleep(): void {

bot.callbackQuery('sleep:enable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:enable callback');
  }
});

bot.callbackQuery('sleep:change', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('Select start hour:', {
      reply_markup: createHourPickerKeyboard('start'),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:change callback');
  }
});

bot.callbackQuery('sleep:disable', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await saveSleepSettings(false);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error disabling sleep hours. Please try again.', 'sleep:disable callback');
  }
});

bot.callbackQuery(/^sleep:start:(\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const startHour = parseInt((ctx.match as RegExpExecArray)[1], 10);
    await ctx.editMessageText('Select end hour:', {
      reply_markup: createHourPickerKeyboard('end', startHour),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing hour picker. Please try again.', 'sleep:start callback');
  }
});

bot.callbackQuery(/^sleep:end:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const startHour = parseInt(m[1], 10);
    const endHour = parseInt(m[2], 10);

    if (endHour <= startHour) {
      await ctx.answerCallbackQuery({ text: 'End hour must be after start hour', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(
      `Sleep hours: ${String(startHour).padStart(2, '0')}:00 – ${String(endHour).padStart(2, '0')}:00\n\nConfirm?`,
      { reply_markup: createSleepConfirmKeyboard(startHour, endHour) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error showing confirmation. Please try again.', 'sleep:end callback');
  }
});

bot.callbackQuery(/^sleep:confirm:(\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const startHour = parseInt(m[1], 10);
    const endHour = parseInt(m[2], 10);

    await ctx.answerCallbackQuery().catch(() => {});
    await saveSleepSettings(true, startHour, endHour);
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error saving sleep settings. Please try again.', 'sleep:confirm callback');
  }
});

bot.callbackQuery('sleep:cancel', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    await showSleepStatus(ctx);
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error cancelling. Please try again.', 'sleep:cancel callback');
  }
});

}
