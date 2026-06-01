// src/bot/handlers/callbacks/interval.ts
import { Context } from 'grammy';
import { bot } from '../../bot.js';
import { ErrorMessages } from '../../../shared/constants/error-messages.js';
import { PostingChannel, getActivePostingChannels } from '../../../database/models/posting-channel.model.js';
import { getPostInterval, setChannelInterval, VALID_INTERVALS, type PostInterval } from '../../../utils/post-interval.js';
import {
  createChannelIntervalListKeyboard,
  createChannelIntervalPickerKeyboard,
} from '../../keyboards/interval.keyboard.js';
import { QueueRepackService } from '../../../core/queue/queue-repack.service.js';

// interval:ch:<channelId> — show picker for a single channel
bot.callbackQuery(/^interval:ch:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channelId = (ctx.match as RegExpExecArray)[1];
    const [channel, currentInterval] = await Promise.all([
      PostingChannel.findOne({ channelId }),
      getPostInterval(channelId),
    ]);
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${currentInterval} min\n\nSelect a new interval:`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error loading channel interval. Please try again.', 'interval:ch callback');
  }
});

// interval:set:<channelId>:<minutes> — save interval for a channel
bot.callbackQuery(/^interval:set:(-?\d+):(\d+)$/, async (ctx: Context) => {
  try {
    const m = ctx.match as RegExpExecArray;
    const channelId = m[1];
    const minutes = parseInt(m[2], 10);

    if (!VALID_INTERVALS.includes(minutes as PostInterval)) {
      await ctx.answerCallbackQuery('Invalid interval.');
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
    await setChannelInterval(channelId, minutes as PostInterval);

    const channel = await PostingChannel.findOne({ channelId });
    const title = channel?.channelTitle ?? channelId;
    await ctx.editMessageText(
      `Post interval for ${title}: ${minutes} min ✅`,
      { reply_markup: createChannelIntervalPickerKeyboard(channelId, minutes as PostInterval) }
    );
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error saving interval. Please try again.', 'interval:set callback');
  }
});

// interval:repack:<channelId> — repack queue for a channel
bot.callbackQuery(/^interval:repack:(-?\d+)$/, async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channelId = (ctx.match as RegExpExecArray)[1];
    const repackService = new QueueRepackService();
    const [count, currentInterval, channel] = await Promise.all([
      repackService.repackChannel(channelId),
      getPostInterval(channelId),
      PostingChannel.findOne({ channelId }),
    ]);
    const title = channel?.channelTitle ?? channelId;
    const text =
      count === 0
        ? `No pending posts to reschedule for ${title}.`
        : `Queue repacked ✅\n${count} post${count === 1 ? '' : 's'} for ${title} rescheduled to ${currentInterval}-min intervals.`;
    await ctx.editMessageText(text, {
      reply_markup: createChannelIntervalPickerKeyboard(channelId, currentInterval),
    });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error repacking queue. Please try again.', 'interval:repack callback');
  }
});

// interval:back — return to channel list
bot.callbackQuery('interval:back', async (ctx: Context) => {
  try {
    await ctx.answerCallbackQuery().catch(() => {});
    const channels = await getActivePostingChannels();

    const rows = await Promise.all(
      channels.map(async (ch) => ({ ch, interval: await getPostInterval(ch.channelId) }))
    );
    const lines = rows
      .map(({ ch, interval }) => `• ${ch.channelTitle ?? ch.channelId} — ${interval} min`)
      .join('\n');

    const text = channels.length === 0 ? 'No posting channels configured.' : `Post intervals:\n${lines}`;
    await ctx.editMessageText(text, { reply_markup: createChannelIntervalListKeyboard(channels) });
  } catch (error) {
    await ErrorMessages.catchAndReply(ctx, error, 'Error loading intervals. Please try again.', 'interval:back callback');
  }
});
