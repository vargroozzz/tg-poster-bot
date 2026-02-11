import { Context } from 'grammy';
import { logger } from '../../utils/logger.js';

/**
 * Centralized error messages for consistent user feedback
 * Reduces code duplication and ensures consistent error handling
 */
export class ErrorMessages {
  /**
   * Show error when session has expired
   */
  static async sessionExpired(ctx: Context): Promise<void> {
    await ctx.editMessageText('❌ Session expired. Please forward the message again.');
  }

  /**
   * Show error when original message cannot be found
   */
  static async originalMessageNotFound(ctx: Context): Promise<void> {
    await ctx.editMessageText('❌ Original message not found. Please forward again.');
  }

  /**
   * Show error when no channel was selected
   */
  static async channelSelectionRequired(ctx: Context): Promise<void> {
    await ctx.editMessageText('❌ No channel selected. Please forward the message again.');
  }

  /**
   * Show generic invalid selection error
   */
  static async invalidSelection(ctx: Context, type: string): Promise<void> {
    await ctx.editMessageText(`❌ Invalid ${type} selection.`);
  }

  /**
   * Show error for unsupported message type
   */
  static async unsupportedMessageType(ctx: Context): Promise<void> {
    await ctx.editMessageText('❌ Unsupported message type.');
  }

  /**
   * Catch-all error handler that logs and replies to user
   * Attempts editMessageText first, falls back to reply if edit fails
   */
  static async catchAndReply(
    ctx: Context,
    error: unknown,
    userMessage: string,
    logMessage?: string
  ): Promise<void> {
    const logMsg = logMessage ?? userMessage;
    logger.error(logMsg, error);

    try {
      await ctx.editMessageText(`❌ ${userMessage}`);
    } catch {
      // If edit fails, send a new message
      await ctx.reply(`❌ ${userMessage}`);
    }
  }

  /**
   * Show error when processing fails
   */
  static async processingError(ctx: Context, action: string): Promise<void> {
    await ErrorMessages.catchAndReply(
      ctx,
      new Error(`${action} failed`),
      `Error ${action}. Please try again.`,
      `Error in ${action} callback`
    );
  }
}
