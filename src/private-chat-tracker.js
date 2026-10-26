function registerPrivateChatTracker(bot, { db = require("./database"), now = () => new Date() } = {}) {
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private" && ctx.from?.id !== undefined) {
      try {
        const at = now() instanceof Date ? now().toISOString() : new Date(now()).toISOString();
        db.recordTelegramPrivateChat(ctx.from.id, at);
      } catch {
        // Failing to record a recipient chat must not be treated as permission to send.
      }
    }
    return next();
  });
}

module.exports = { registerPrivateChatTracker };

