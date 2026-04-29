// Provide minimal env vars required by config validation in tests
process.env.BOT_TOKEN = process.env.BOT_TOKEN ?? 'test-token';
process.env.MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost/test';
process.env.AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID ?? '123';
