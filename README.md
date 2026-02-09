# Telegram Channel Poster Bot

A Telegram bot that helps schedule channel posts with automatic attribution. Forward messages from any source, and the bot will schedule them to your channel at the next available time slot (hh:00:01 or hh:30:01 in Europe/Kyiv timezone).

## Features

- 📅 **Automatic Scheduling** - Posts are scheduled to the nearest available hh:00:01 or hh:30:01 time slot
- 📍 **Per-Message Channel Selection** - Choose destination channel for each post via inline buttons
- 📢 **Multi-Channel Support** - Manage multiple posting channels, select target for each message
- ✨ **Smart Attribution** - Automatically adds "via @username" or "via [Channel](link)" to transformed posts
- 🟢 **Green List** - Auto-forward posts from trusted channels without prompting
- 🔴 **Red List** - Omit channel attribution when transforming posts from specific channels
- 🔒 **Single User** - Authorized for one user only (secure and private)
- 📦 **Supports Multiple Media Types** - Text, photos, videos, documents, and animations

## How It Works

1. Add your posting channels with `/addchannel <channel_id>` (bot must be admin)
2. Forward a message to the bot
3. **Select which channel** to post to from your configured channels
4. If from a green-listed source → automatically posts as-is
5. Otherwise → choose "Transform & Schedule" or "Forward As-Is"
6. Bot schedules the post using Telegram's native scheduling (no cron jobs needed!)
7. Telegram automatically posts at the scheduled time

## Setup

### Prerequisites

- Node.js 20+ and npm
- MongoDB Atlas account (or local MongoDB)
- Telegram Bot Token (from @BotFather)
- Your Telegram user ID

### Installation

1. Clone the repository:
```bash
cd tg_poster_bot
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`:
```env
BOT_TOKEN=your_bot_token_from_botfather
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/tg_poster_bot
AUTHORIZED_USER_ID=123456789
NODE_ENV=development
TZ=Europe/Kiev
# TARGET_CHANNEL_ID=-1001234567890  # Optional - can use /setchannel instead
```

### Getting Your IDs

**Bot Token:**
1. Message @BotFather on Telegram
2. Create a new bot with `/newbot`
3. Copy the token

**User ID:**
1. Message @userinfobot on Telegram
2. Copy your user ID

**Adding Posting Channels:**
After starting the bot:
1. Add your bot as an administrator to your channel(s) with permission to post messages
2. Use `/addchannel <channel_id>` to register each channel
3. Bot will verify it has admin access before adding

### Running

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Commands

- `/start` - Welcome message and help
- `/addchannel <channel_id>` - Add a channel where you want to post (bot must be admin)
- `/removechannel <channel_id>` - Remove a posting channel
- `/listchannels` - Show all posting channels and green/red lists
- `/status` - Show pending scheduled posts (count and next 5)
- `/addgreen <channel_id>` - Add source channel to green list (auto-forward)
- `/addred <channel_id>` - Add source channel to red list (omit channel reference)
- `/remove <channel_id>` - Remove channel from green/red lists
- `/help` - Usage instructions

## Attribution Rules

### Green List
If a channel is green-listed, all forwards from it are automatically scheduled as-is with no transformation.

### Transform Action
- **From channel (not red-listed):** Adds `via [Channel Name](link)`
- **From channel (red-listed):** Omits channel reference, adds `via @username` if forwarded by a user
- **From user:** Adds `via @username`

### Forward As-Is Action
Posts the message exactly as received with no modifications.

## Architecture

- **Grammy** - Modern Telegram bot framework
- **MongoDB + Mongoose** - Cloud persistence with schema validation
- **date-fns-tz** - Timezone-aware scheduling (Europe/Kyiv)
- **Winston** - Structured logging
- **Zod** - Configuration validation

## Project Structure

```
src/
├── index.ts                    # Entry point
├── config/                     # Configuration and validation
├── bot/
│   ├── bot.ts                 # Grammy bot instance
│   ├── handlers/              # Message and callback handlers
│   └── keyboards/             # Inline keyboards
├── services/
│   ├── scheduler.service.ts   # Post scheduling via Telegram API
│   ├── transformer.service.ts # Message transformation with attribution
│   └── channel-list.service.ts # Green/red list management
├── database/
│   ├── connection.ts          # MongoDB connection
│   └── models/                # Mongoose schemas
├── types/                     # TypeScript type definitions
└── utils/
    ├── logger.ts              # Winston logger
    ├── time-slots.ts          # Time slot calculation
    └── message-parser.ts      # Forward info extraction
```

## License

ISC
