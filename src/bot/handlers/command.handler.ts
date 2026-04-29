import { Context } from 'grammy';
import { ChannelListRepository } from '../../database/repositories/channel-list.repository.js';
import { SchedulerService } from '../../services/scheduler.service.js';
import { formatSlotTime } from '../../utils/time-slots.js';
import { logger } from '../../utils/logger.js';
import { bot } from '../bot.js';
import {
  getActivePostingChannels,
  addPostingChannel,
  removePostingChannel,
} from '../../database/models/posting-channel.model.js';
import {
  setUserNickname,
  removeUserNickname,
  listUserNicknames,
} from '../../database/models/user-nickname.model.js';
import {
  addCustomTextPreset,
  listCustomTextPresets,
  removeCustomTextPreset,
} from '../../database/models/custom-text-preset.model.js';
import { parseForwardInfo } from '../../utils/message-parser.js';
import { createQueueChannelSelectKeyboard } from '../keyboards/queue-channel-select.keyboard.js';
import { getSleepWindow } from '../../utils/sleep-window.js';
import { createSleepStatusKeyboard } from '../keyboards/sleep.keyboard.js';
import { getPostInterval } from '../../utils/post-interval.js';
import { createIntervalKeyboard } from '../keyboards/interval.keyboard.js';

const schedulerService = new SchedulerService(bot.api);
const channelListRepo = new ChannelListRepository();

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
/addnickname <user_id> <nickname> - Set custom nickname for a user
/listnicknames - Show all user nicknames
/help - Show this help message${setupMessage}`
  );
});

bot.command('help', async (ctx: Context) => {
  await ctx.reply(
    `📖 Bot Commands:

📢 Channel Management:
/addchannel <channel_id> - Add a channel where you want to post
/listchannels - Show all your posting channels
/removechannel <channel_id> - Remove a posting channel

📊 Status:
/status - Show pending scheduled posts count and next 5 posts

🎨 Attribution Control:
/addgreen <channel_id> - Add channel to green list (forwards as-is automatically)
/addred <channel_id> - Add channel to red list (omits channel attribution)
/addnickname <user_id> <nickname> - Set custom nickname for a user
/removenickname <user_id> - Remove user nickname
/listnicknames - Show all user nicknames

💡 How it works:
1. Add channels with /addchannel (bot must be admin)
2. Forward a message to me
3. Select which channel to post to
4. Choose text handling (keep/remove/quote) if message has text
5. Choose "Transform & Schedule" or "Forward As-Is"
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

    const [greenChannels, redChannels] = await Promise.all([
      channelListRepo.getGreenList(),
      channelListRepo.getRedList(),
    ]);

    const postingSection = postingChannels.length > 0
      ? '\n📍 Posting Channels (where bot can post):\n' + postingChannels.map((ch) => {
          const username = ch.channelUsername ? ` @${ch.channelUsername}` : '';
          return `  • ${ch.channelTitle ?? ch.channelId}${username}\n    ID: ${ch.channelId}\n`;
        }).join('')
      : '\n⚠️ No posting channels configured. Use /addchannel to add channels.\n';

    const formatListChannel = (ch: { channelId: string; channelUsername?: string | null; channelTitle?: string | null }) => {
      const title = ch.channelTitle ? ` (${ch.channelTitle})` : '';
      const username = ch.channelUsername ? ` @${ch.channelUsername}` : '';
      return `  • ${ch.channelId}${username}${title}\n`;
    };

    const greenSection = greenChannels.length > 0
      ? '\n🟢 Green List (auto-forward):\n' + greenChannels.map(formatListChannel).join('')
      : '';

    const redSection = redChannels.length > 0
      ? '\n🔴 Red List (omit channel reference):\n' + redChannels.map(formatListChannel).join('')
      : '';

    await ctx.reply(`📋 Channel Lists:\n${postingSection}${greenSection}${redSection}`);
  } catch (error) {
    logger.error('Error listing channels:', error);
    await ctx.reply('❌ Error fetching channel lists. Please try again.');
  }
});

bot.command('status', async (ctx: Context) => {
  try {
    const count = await schedulerService.getPendingPostsCount();
    const nextPosts = await schedulerService.getNextPendingPosts(5);

    const postsSection = nextPosts.length > 0
      ? '\n📅 Next scheduled posts:\n' + nextPosts.map((post, index) => {
          const preview = post.content.text
            ? post.content.text.substring(0, 30) + (post.content.text.length > 30 ? '...' : '')
            : '';
          return `${index + 1}. ${formatSlotTime(post.scheduledTime)} - ${post.content.type}${preview ? `: ${preview}` : ''}\n`;
        }).join('')
      : '';

    await ctx.reply(`📊 Pending posts: ${count}\n${postsSection}`);
  } catch (error) {
    logger.error('Error in /status command:', error);
    await ctx.reply('❌ Error fetching status. Please try again.');
  }
});

async function resolveChannelId(ctx: Context, usageText: string): Promise<string | null> {
  const directArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  if (directArg) return directArg;

  const replyToMessage = ctx.message?.reply_to_message;
  if (replyToMessage) {
    const forwardInfo = parseForwardInfo(replyToMessage);
    if (forwardInfo?.fromChannelId) return String(forwardInfo.fromChannelId);
    await ctx.reply('❌ The replied message must be forwarded from a channel (not a user).');
    return null;
  }

  await ctx.reply(usageText);
  return null;
}

bot.command('addgreen', async (ctx: Context) => {
  const channelId = await resolveChannelId(
    ctx,
    'Usage: /addgreen <channel_id>\nExample: /addgreen -1001234567890\n\n💡 Or reply to a forwarded message with /addgreen'
  );
  if (!channelId) return;

  if (!channelId.match(/^-\d+$/)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return;
  }

  try {
    await channelListRepo.addToList(channelId, 'green');
    await ctx.reply(`✅ Channel ${channelId} added to green list. Forwards from this channel will be auto-scheduled as-is.`);
  } catch (error) {
    logger.error('Error adding to green list:', error);
    await ctx.reply('❌ Error adding channel to green list. Please try again.');
  }
});

bot.command('addred', async (ctx: Context) => {
  const channelId = await resolveChannelId(
    ctx,
    'Usage: /addred <channel_id>\nExample: /addred -1001234567890\n\n💡 Or reply to a forwarded message with /addred'
  );
  if (!channelId) return;

  if (!channelId.match(/^-\d+$/)) {
    await ctx.reply('❌ Invalid channel ID format. It should start with - and be numeric.');
    return;
  }

  try {
    await channelListRepo.addToList(channelId, 'red');
    await ctx.reply(
      `✅ Channel ${channelId} added to red list. Channel attribution will be omitted when transforming.`
    );
  } catch (error) {
    logger.error('Error adding to red list:', error);
    await ctx.reply('❌ Error adding channel to red list. Please try again.');
  }
});

bot.command('remove', async (ctx: Context) => {
  const channelId = await resolveChannelId(
    ctx,
    'Usage: /remove <channel_id>\nExample: /remove -1001234567890\n\n💡 Or reply to a forwarded message with /remove'
  );
  if (!channelId) return;

  try {
    const removed = (await channelListRepo.removeFromAllLists(channelId)) > 0;
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

// User nickname commands
bot.command('addnickname', async (ctx: Context) => {
  const args = typeof ctx.match === 'string' ? ctx.match.trim().split(/\s+/) : [];

  // Check if replying to a forwarded message
  const replyToMessage = ctx.message?.reply_to_message;
  let userId: number | undefined;
  let nickname: string;

  if (replyToMessage) {
    // Extract user ID from replied message
    const forwardInfo = parseForwardInfo(replyToMessage);

    if (forwardInfo?.fromUserId) {
      userId = forwardInfo.fromUserId;
      nickname = args.join(' ');

      if (!nickname) {
        await ctx.reply('❌ Please provide a nickname.\n\nUsage: Reply to a forwarded message with /addnickname <nickname>');
        return;
      }
    } else {
      await ctx.reply('❌ The replied message must be forwarded from a user (not a channel).');
      return;
    }
  } else {
    // Traditional usage with user ID
    if (args.length < 2) {
      await ctx.reply(
        'Usage: /addnickname <user_id> <nickname>\n\n' +
          'Example: /addnickname 123456789 My Best Friend\n\n' +
          '💡 Or reply to a forwarded message with /addnickname <nickname>'
      );
      return;
    }

    userId = parseInt(args[0], 10);
    nickname = args.slice(1).join(' ');

    if (isNaN(userId)) {
      await ctx.reply('❌ Invalid user ID. Must be a number.');
      return;
    }
  }

  try {
    await setUserNickname(userId, nickname);
    await ctx.reply(`✅ Nickname set for user ${userId}: "${nickname}"`);
    logger.info(`Nickname set for user ${userId}: ${nickname}`);
  } catch (error) {
    logger.error('Error setting nickname:', error);
    await ctx.reply('❌ Error setting nickname. Please try again.');
  }
});

bot.command('removenickname', async (ctx: Context) => {
  const userIdStr = typeof ctx.match === 'string' ? ctx.match.trim() : undefined;
  let userId: number | undefined;

  // Check if replying to a forwarded message
  const replyToMessage = ctx.message?.reply_to_message;
  if (!userIdStr && replyToMessage) {
    const forwardInfo = parseForwardInfo(replyToMessage);
    if (forwardInfo?.fromUserId) {
      userId = forwardInfo.fromUserId;
    } else {
      await ctx.reply('❌ The replied message must be forwarded from a user (not a channel).');
      return;
    }
  } else if (userIdStr) {
    userId = parseInt(userIdStr, 10);
  }

  if (!userId) {
    await ctx.reply(
      'Usage: /removenickname <user_id>\n' +
        'Example: /removenickname 123456789\n\n' +
        '💡 Or reply to a forwarded message with /removenickname'
    );
    return;
  }

  if (isNaN(userId)) {
    await ctx.reply('❌ Invalid user ID. Must be a number.');
    return;
  }

  try {
    const removed = await removeUserNickname(userId);
    if (removed) {
      await ctx.reply(`✅ Nickname removed for user ${userId}`);
    } else {
      await ctx.reply(`⚠️ No nickname found for user ${userId}`);
    }
  } catch (error) {
    logger.error('Error removing nickname:', error);
    await ctx.reply('❌ Error removing nickname. Please try again.');
  }
});

bot.command('listnicknames', async (ctx: Context) => {
  try {
    const nicknames = await listUserNicknames();

    if (nicknames.length === 0) {
      await ctx.reply('📝 No user nicknames configured.\n\nUse /addnickname to add one.');
      return;
    }

    const nicknameList = nicknames
      .map((nick) => `• ${nick.userId}: "${nick.nickname}"${nick.notes ? ` (${nick.notes})` : ''}`)
      .join('\n');

    await ctx.reply(`📝 User Nicknames:\n\n${nicknameList}`);
  } catch (error) {
    logger.error('Error listing nicknames:', error);
    await ctx.reply('❌ Error fetching nicknames. Please try again.');
  }
});

bot.command('queue', async (ctx: Context) => {
  try {
    const channels = await getActivePostingChannels();

    if (channels.length === 0) {
      await ctx.reply('⚠️ No posting channels configured. Use /addchannel first.');
      return;
    }

    const keyboard = createQueueChannelSelectKeyboard(channels);
    await ctx.reply('📋 Select a channel to view its queue:', { reply_markup: keyboard });
  } catch (error) {
    logger.error('Error in /queue command:', error);
    await ctx.reply('❌ Error loading queue. Please try again.');
  }
});

bot.command('sleep', async (ctx: Context) => {
  try {
    const sleepWindow = await getSleepWindow();
    const enabled = sleepWindow !== null;

    let text: string;
    if (enabled) {
      const startStr = sleepWindow.startHour.toString().padStart(2, '0');
      const endStr = sleepWindow.endHour.toString().padStart(2, '0');
      text = `Sleep hours: ${startStr}:00 – ${endStr}:00 ✅\nPosts scheduled during this window will be pushed to after ${endStr}:00.`;
    } else {
      text = 'Sleep hours: disabled';
    }

    await ctx.reply(text, { reply_markup: createSleepStatusKeyboard(enabled) });
  } catch (error) {
    logger.error('Error in /sleep command:', error);
    await ctx.reply('Error loading sleep settings. Please try again.');
  }
});

// Custom text preset commands
bot.command('addpreset', async (ctx: Context) => {
  try {
    const args = ctx.message?.text?.split(' ').slice(1) ?? [];
    if (args.length < 2) {
      await ctx.reply(
        '❌ Usage: /addpreset <label> | <text>\n\nExample: /addpreset 🔥 Breaking | 🔥 Breaking news!'
      );
      return;
    }

    const raw = args.join(' ');
    const separatorIndex = raw.indexOf('|');
    if (separatorIndex === -1) {
      await ctx.reply('❌ Separator "|" not found.\n\nUsage: /addpreset <label> | <text>');
      return;
    }

    const label = raw.slice(0, separatorIndex).trim();
    const text = raw.slice(separatorIndex + 1).trim();

    if (!label || !text) {
      await ctx.reply('❌ Both label and text are required.\n\nUsage: /addpreset <label> | <text>');
      return;
    }

    await addCustomTextPreset(label, text);
    await ctx.reply(`✅ Preset added:\nLabel: "${label}"\nText: "${text}"`);
    logger.info(`Custom text preset added: "${label}"`);
  } catch (error) {
    logger.error('Error adding preset:', error);
    await ctx.reply('❌ Error adding preset. Please try again.');
  }
});

bot.command('listpresets', async (ctx: Context) => {
  try {
    const presets = await listCustomTextPresets();

    if (presets.length === 0) {
      await ctx.reply('📝 No text presets configured.\n\nUse /addpreset to add one.');
      return;
    }

    const list = presets
      .map((p, i) => `${i + 1}. [${p._id}]\n   Label: "${p.label}"\n   Text: "${p.text}"`)
      .join('\n\n');

    await ctx.reply(`📝 Text Presets:\n\n${list}`);
  } catch (error) {
    logger.error('Error listing presets:', error);
    await ctx.reply('❌ Error fetching presets. Please try again.');
  }
});

bot.command('removepreset', async (ctx: Context) => {
  try {
    const id = ctx.message?.text?.split(' ')[1];

    if (!id) {
      await ctx.reply('❌ Usage: /removepreset <id>\n\nUse /listpresets to see IDs.');
      return;
    }

    const removed = await removeCustomTextPreset(id);
    if (removed) {
      await ctx.reply(`✅ Preset removed.`);
    } else {
      await ctx.reply('❌ Preset not found.');
    }
  } catch (error) {
    logger.error('Error removing preset:', error);
    await ctx.reply('❌ Error removing preset. Please try again.');
  }
});

bot.command('interval', async (ctx: Context) => {
  try {
    const current = await getPostInterval();
    await ctx.reply(
      `Post interval: every ${current} minutes\n\nSelect a new interval:`,
      { reply_markup: createIntervalKeyboard(current) }
    );
  } catch (error) {
    logger.error('Error in /interval command:', error);
    await ctx.reply('Error loading interval settings. Please try again.');
  }
});

