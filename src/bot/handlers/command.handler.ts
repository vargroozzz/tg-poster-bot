import { Context } from 'grammy';
import { channelListService } from '../../services/channel-list.service.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import {
  getActivePostingChannels,
  addPostingChannel,
  removePostingChannel,
} from '../../database/models/posting-channel.model.js';

const schedulerService = new SchedulerService(bot.api);

bot.command('start', async (ctx: Context) => {
  const postingChannels = await getActivePostingChannels();
  const setupMessage =
    postingChannels.length === 0
      ? '\n\n⚠️ No posting channels configured! Use /addchannel to add channels.'
      : '';

  await ctx.reply(
    `👋 Welcome to the Telegram Channel Poster Bot!

Forward me messages from channels or users, and I'll help you schedule them to your channels with proper attribution.

Commands:
/addchannel <channel_id> - Add a channel for posting
/listchannels - Show all posting channels
/removechannel <channel_id> - Remove a posting channel
/status - Show pending scheduled posts
/addgreen <channel_id> - Add channel to green list (auto-forward)
/addred <channel_id> - Add channel to red list (omit channel reference)
/help - Show this help message${setupMessage}`
  );
});

bot.command('help', async (ctx: Context) => {
  await ctx.reply(
    `📖 Bot Commands:

/addchannel <channel_id> - Add a channel where you want to post
/listchannels - Show all your posting channels
/removechannel <channel_id> - Remove a posting channel
/status - Show pending scheduled posts count and next 5 posts
/addgreen <channel_id> - Add channel to green list (forwards as-is automatically)
/addred <channel_id> - Add channel to red list (omits channel attribution)

💡 How it works:
1. Add channels with /addchannel (bot must be admin)
2. Forward a message to me
3. Select which channel to post to
4. If from a green-listed channel, it's auto-forwarded
5. Otherwise, choose "Transform & Schedule" or "Forward As-Is"
6. Posts are scheduled to the nearest hh:00:01 or hh:30:01 time slot

🕐 Timezone: Europe/Kyiv`
  );
});

bot.command('addchannel', async (ctx: Context) => {
  const channelId = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;

  if (!channelId) {
    await ctx.reply(
      'Usage: /addchannel <channel_id>\n\n' +
        'Example: /addchannel -1001234567890\n\n' +
        'To get your channel ID:\n' +
        '• Forward a message from the channel to @RawDataBot\n' +
        '• Or use @getidsbot'
    );
    return;
  }

  if (!channelId.match(/^-\d+$/)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return;
  }

  try {
    // Try to get chat info to verify the bot has access
    const chat = await ctx.api.getChat(channelId);

    if (chat.type !== 'channel' && chat.type !== 'supergroup') {
      await ctx.reply('❌ The provided ID is not a channel or supergroup.');
      return;
    }

    // Check if bot is an administrator
    const botMember = await ctx.api.getChatMember(channelId, ctx.me.id);
    if (botMember.status !== 'administrator' && botMember.status !== 'creator') {
      await ctx.reply(
        '❌ Bot is not an administrator in this channel. Please add the bot as admin first.'
      );
      return;
    }

    // Check if bot has permission to post
    if (
      botMember.status === 'administrator' &&
      'can_post_messages' in botMember &&
      !botMember.can_post_messages
    ) {
      await ctx.reply('❌ Bot does not have permission to post messages in this channel.');
      return;
    }

    const chatTitle = 'title' in chat ? chat.title : 'Unknown';
    const username = 'username' in chat && chat.username ? chat.username : undefined;

    await addPostingChannel(channelId, username, chatTitle);

    const usernameDisplay = username ? ` @${username}` : '';
    await ctx.reply(
      `✅ Channel added:\n${chatTitle}${usernameDisplay}\nID: ${channelId}\n\n` +
        `You can now select this channel when forwarding messages.`
    );

    logger.info(`Posting channel ${channelId} added by user ${ctx.from?.id}`);
  } catch (error) {
    logger.error('Error adding posting channel:', error);
    if (error && typeof error === 'object' && 'error_code' in error && error.error_code === 400) {
      await ctx.reply(
        '❌ Cannot access this channel. Make sure:\n' +
          '1. The bot is added to the channel\n' +
          '2. The bot is an administrator\n' +
          '3. The channel ID is correct'
      );
    } else {
      await ctx.reply('❌ Error adding channel. Please try again.');
    }
  }
});

bot.command('removechannel', async (ctx: Context) => {
  const channelId = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;

  if (!channelId) {
    await ctx.reply(
      'Usage: /removechannel <channel_id>\n' + 'Example: /removechannel -1001234567890'
    );
    return;
  }

  try {
    const removed = await removePostingChannel(channelId);
    if (removed) {
      await ctx.reply(`✅ Channel ${channelId} removed from posting channels.`);
    } else {
      await ctx.reply(`⚠️ Channel ${channelId} was not found in posting channels.`);
    }
  } catch (error) {
    logger.error('Error removing posting channel:', error);
    await ctx.reply('❌ Error removing channel. Please try again.');
  }
});

bot.command('listchannels', async (ctx: Context) => {
  try {
    // Get posting channels
    const postingChannels = await getActivePostingChannels();

    // Get green/red channels
    const channels = await channelListService.listChannels();
    const greenChannels = channels.filter((ch) => ch.listType === 'green');
    const redChannels = channels.filter((ch) => ch.listType === 'red');

    let message = '📋 Channel Lists:\n';

    if (postingChannels.length > 0) {
      message += '\n📍 Posting Channels (where bot can post):\n';
      postingChannels.forEach((ch) => {
        const username = ch.channelUsername ? ` @${ch.channelUsername}` : '';
        message += `  • ${ch.channelTitle ?? ch.channelId}${username}\n    ID: ${ch.channelId}\n`;
      });
    } else {
      message += '\n⚠️ No posting channels configured. Use /addchannel to add channels.\n';
    }

    if (greenChannels.length > 0) {
      message += '\n🟢 Green List (auto-forward):\n';
      greenChannels.forEach((ch) => {
        const title = ch.channelTitle ? ` (${ch.channelTitle})` : '';
        const username = ch.channelUsername ? ` @${ch.channelUsername}` : '';
        message += `  • ${ch.channelId}${username}${title}\n`;
      });
    }

    if (redChannels.length > 0) {
      message += '\n🔴 Red List (omit channel reference):\n';
      redChannels.forEach((ch) => {
        const title = ch.channelTitle ? ` (${ch.channelTitle})` : '';
        const username = ch.channelUsername ? ` @${ch.channelUsername}` : '';
        message += `  • ${ch.channelId}${username}${title}\n`;
      });
    }

    await ctx.reply(message);
  } catch (error) {
    logger.error('Error listing channels:', error);
    await ctx.reply('❌ Error fetching channel lists. Please try again.');
  }
});

bot.command('status', async (ctx: Context) => {
  try {
    const count = await schedulerService.getPendingPostsCount();
    const nextPosts = await schedulerService.getNextPendingPosts(5);

    let message = `📊 Pending posts: ${count}\n`;

    if (nextPosts.length > 0) {
      message += '\n📅 Next scheduled posts:\n';
      nextPosts.forEach((post, index) => {
        const time = formatSlotTime(post.scheduledTime);
        const contentType = post.content.type;
        const preview =
          post.content.text?.substring(0, 30) + (post.content.text && post.content.text.length > 30 ? '...' : '');
        message += `${index + 1}. ${time} - ${contentType}${preview ? `: ${preview}` : ''}\n`;
      });
    }

    await ctx.reply(message);
  } catch (error) {
    logger.error('Error in /status command:', error);
    await ctx.reply('❌ Error fetching status. Please try again.');
  }
});

bot.command('addgreen', async (ctx: Context) => {
  const channelId = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;

  if (!channelId) {
    await ctx.reply('Usage: /addgreen <channel_id>\nExample: /addgreen -1001234567890');
    return;
  }

  if (!channelId.match(/^-\d+$/)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return;
  }

  try {
    await channelListService.addChannel(channelId, 'green');
    await ctx.reply(`✅ Channel ${channelId} added to green list. Forwards from this channel will be auto-scheduled as-is.`);
  } catch (error) {
    logger.error('Error adding to green list:', error);
    await ctx.reply('❌ Error adding channel to green list. Please try again.');
  }
});

bot.command('addred', async (ctx: Context) => {
  const channelId = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;

  if (!channelId) {
    await ctx.reply('Usage: /addred <channel_id>\nExample: /addred -1001234567890');
    return;
  }

  if (!channelId.match(/^-\d+$/)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return;
  }

  try {
    await channelListService.addChannel(channelId, 'red');
    await ctx.reply(`✅ Channel ${channelId} added to red list. Channel attribution will be omitted when transforming.`);
  } catch (error) {
    logger.error('Error adding to red list:', error);
    await ctx.reply('❌ Error adding channel to red list. Please try again.');
  }
});

bot.command('remove', async (ctx: Context) => {
  const channelId = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;

  if (!channelId) {
    await ctx.reply('Usage: /remove <channel_id>\nExample: /remove -1001234567890');
    return;
  }

  try {
    const removed = await channelListService.removeChannel(channelId);
    if (removed) {
      await ctx.reply(`✅ Channel ${channelId} removed from lists.`);
    } else {
      await ctx.reply(`⚠️ Channel ${channelId} was not found in any list.`);
    }
  } catch (error) {
    logger.error('Error removing channel:', error);
    await ctx.reply('❌ Error removing channel. Please try again.');
  }
});

