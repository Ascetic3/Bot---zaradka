function isPrivateChat(ctx) {
  return ctx.chat?.type === "private";
}

function registerPrivateCallbackGuard(bot) {
  bot.on("callback_query:data", async (ctx, next) => {
    if (ctx.callbackQuery.message?.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Откройте личный чат с ботом, чтобы продолжить." });
      return;
    }
    return next();
  });
}

module.exports = { isPrivateChat, registerPrivateCallbackGuard };

