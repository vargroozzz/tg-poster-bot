# Render Cron Job Setup

This bot uses Render Cron Jobs to publish scheduled posts at :00 and :30 each hour, instead of running a continuous background worker.

## Architecture

- **Web Service**: Handles Telegram webhooks (bot messages), can sleep between user interactions
- **Cron Job**: Runs at :00 and :30 every hour, calls `/process-posts` endpoint to publish scheduled posts

## Setup Instructions

### 1. Deploy Web Service (if not already done)

Your current Telegram bot deployment.

### 2. Add Environment Variable to Web Service

In your Web Service settings on Render:
- Add: `USE_CRON_JOB=true`
- This disables the continuous worker since cron job will handle it

### 3. Create Cron Job on Render

1. Go to Render Dashboard → **New** → **Cron Job**

2. **Basic Settings:**
   - **Name**: `tg-poster-cron`
   - **Region**: Same as your web service
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**:
     ```bash
     curl -X POST https://YOUR-WEB-SERVICE-URL.onrender.com/process-posts
     ```
     *(Replace YOUR-WEB-SERVICE-URL with your actual web service URL)*

3. **Schedule:**
   - **Schedule**: `0,30 * * * *`
   - This runs at minute 0 and 30 of every hour (e.g., 10:00, 10:30, 11:00, 11:30, etc.)

4. **Environment Variables:**
   - None needed (the curl command just triggers your web service)

5. Click **Create Cron Job**

### 4. Verify It Works

1. Schedule a test post through the bot
2. Wait for the next :00 or :30 time slot
3. Check:
   - Cron job logs on Render (should show successful curl)
   - Web service logs (should show "Processing scheduled posts via HTTP endpoint")
   - Your Telegram channel (post should appear)

## Benefits

✅ **No more sleep issues**: Cron job wakes the web service exactly when needed
✅ **Efficient**: Only runs at :00 and :30, not every 30 seconds
✅ **Free tier friendly**: Web service can sleep between bot interactions
✅ **Reliable**: Render's cron scheduler is more reliable than setInterval in sleeping containers

## Local Development

When running locally (without `USE_CRON_JOB=true`), the bot uses the continuous worker (checks every 30 seconds) for easier testing.

## Troubleshooting

**Posts not publishing:**
1. Check cron job logs - is it running at :00 and :30?
2. Check web service logs - is `/process-posts` being called?
3. Verify `USE_CRON_JOB=true` is set in web service env vars
4. Verify cron schedule is `0,30 * * * *`

**Cron job failing:**
- Ensure the web service URL is correct in the curl command
- Check that the web service is deployed and healthy
