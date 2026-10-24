const { isPrivateChat } = require("./chat-guards");
const { createRateLimiter, allowRequest } = require("./request-limits");

function registerMyId(bot, { rateLimiter = createRateLimiter() } = {}) {
  bot.command("myid", async (ctx) => {
    if (!(await allowRequest(ctx, rateLimiter, "command_myid"))) return;
    if (!isPrivateChat(ctx)) {
      return ctx.reply("Команда /myid доступна только в личном чате с ботом.");
    }
    return ctx.reply(`🆔 Ваш Telegram ID: ${ctx.from.id}\n\nЭтот идентификатор используется для настройки доступа к административной панели.`);
  });
}
module.exports = { registerMyId };
