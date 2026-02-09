# Quick Start Guide

## Prerequisites Checklist

Before starting, make sure you have:

- [ ] **Node.js 20+** installed (`node --version`)
- [ ] **MongoDB Atlas** account (free tier works) at https://www.mongodb.com/cloud/atlas
- [ ] **Telegram Bot Token** from @BotFather
- [ ] **Your Telegram User ID**
- [ ] **A Telegram channel** where you want to post (bot must be admin)

## Step 1: Get Your Telegram Bot Token

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Choose a name for your bot (e.g., "My Poster Bot")
4. Choose a username (must end in "bot", e.g., "my_poster_bot")
5. Copy the token (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

## Step 2: Get Your User ID

Message [@userinfobot](https://t.me/userinfobot) on Telegram and copy your ID.

## Step 3: Set Up MongoDB Atlas (5 minutes)

1. Go to https://www.mongodb.com/cloud/atlas
2. Sign up for free account
3. Create a free cluster (M0 Sandbox)
4. Click "Connect" → "Connect your application"
5. Copy the connection string (looks like: `mongodb+srv://username:password@cluster.mongodb.net/`)
6. Replace `<password>` with your actual database password

## Step 4: Configure Environment Variables

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your values:
   ```env
   BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/tg_poster_bot
   AUTHORIZED_USER_ID=123456789
   NODE_ENV=development
   TZ=Europe/Kiev
   # TARGET_CHANNEL_ID is optional - you'll set it via /setchannel command
   ```

## Step 5: Install Dependencies

```bash
npm install
```

## Step 6: Start the Bot

**Development mode (with hot reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

## Step 7: Set Your Target Channel

1. **Add your bot to your channel as an administrator** with permission to post messages

2. **Get your channel ID:**
   - Forward a message from your channel to [@RawDataBot](https://t.me/RawDataBot) or [@getidsbot](https://t.me/getidsbot)
   - Copy the channel ID (looks like `-1001234567890`)

3. **Set the target channel:**
   ```
   /setchannel -1001234567890
   ```

   The bot will verify it has admin access and confirm the setup.

## Step 8: Test the Bot

1. **Send `/start` to your bot** - You should see a welcome message

2. **Verify target channel is set:**
   - Send `/setchannel` (without arguments)
   - You should see your configured channel

3. **Test basic scheduling:**
   - Forward any message from a channel to your bot
   - Click "Transform & Schedule" or "Forward As-Is"
   - You should see a confirmation with the scheduled time

4. **Check status:**
   - Send `/status` to see pending scheduled posts

5. **Verify in Telegram:**
   - Go to your target channel
   - Open "..." menu → "Scheduled Messages"
   - Your post should appear there

## Step 9: Configure Channel Lists (Optional)

**Add a channel to the green list (auto-forward):**
```
/addgreen -1001234567890
```

**Add a channel to the red list (omit channel attribution):**
```
/addred -1001234567890
```

**List all channels:**
```
/listchannels
```

**Remove a channel:**
```
/remove -1001234567890
```

## Troubleshooting

### Bot doesn't respond
- Check that BOT_TOKEN is correct
- Make sure you're using the authorized user account
- Check logs in `logs/combined.log`

### "MongoDB connection failed"
- Verify MONGODB_URI is correct
- Check that your MongoDB Atlas cluster is running
- Make sure your IP is whitelisted in MongoDB Atlas (or use 0.0.0.0/0 for development)

### "Not authorized to use this bot"
- Double-check AUTHORIZED_USER_ID matches your Telegram user ID
- Make sure you're messaging the bot with the correct account

### "No target channel configured"
- Use `/setchannel` to view current channel or set a new one
- Make sure the bot is added as an admin to the channel
- Verify the channel ID is correct (use @RawDataBot or @getidsbot to get it)

### Posts not appearing in channel
- Check `/setchannel` shows the correct channel
- Make sure the bot is added as an admin to the target channel
- Verify the bot has permission to post messages

### "Could not parse forward information"
- Make sure you're forwarding messages (not just sending text)
- The message must have forward_origin data from Telegram

## Command Reference

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and help |
| `/setchannel [id]` | Set or view target channel for posting |
| `/help` | Usage instructions |
| `/status` | Show pending posts count and next 5 scheduled |
| `/addgreen <id>` | Add channel to green list (auto-forward) |
| `/addred <id>` | Add channel to red list (omit channel reference) |
| `/listchannels` | Show all channels in green/red lists |
| `/remove <id>` | Remove channel from both lists |

## How It Works

1. **Set your target channel** with `/setchannel <channel_id>`
2. **Forward a message** to the bot from any source
3. **Green-listed channels** are automatically scheduled as-is
4. **Other messages** show inline buttons:
   - **Transform & Schedule**: Adds attribution (via @username or via [Channel](link))
   - **Forward As-Is**: Posts exactly as received
5. Bot schedules to the **next available time slot** (hh:00:01 or hh:30:01 in Europe/Kyiv)
6. **Telegram automatically posts** at the scheduled time (bot doesn't need to be running)

## Attribution Rules

### Transform & Schedule
- **From channel (not red-listed)**: Adds `via [Channel Name](link)`
- **From channel (red-listed)**: Omits channel, adds `via @username` if forwarded by a user
- **From user**: Adds `via @username`

### Forward As-Is
- Posts the message exactly as received with no modifications

### Green List (Auto-Forward)
- Messages from green-listed channels are automatically scheduled as-is
- No button prompt shown
- Useful for trusted sources

## Development

**Run linter:**
```bash
npm run lint
```

**Format code:**
```bash
npm run format
```

**Build TypeScript:**
```bash
npm run build
```

## Logs

Logs are stored in the `logs/` directory:
- `combined.log` - All logs
- `error.log` - Errors only

Check logs if something isn't working:
```bash
tail -f logs/combined.log
```

## Need Help?

Check the `README.md` for more detailed information about the bot's architecture and features.
