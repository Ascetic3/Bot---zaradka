const { isPrivateChat } = require("./chat-guards");

function registerMyId(bot) {
  bot.command("myid", async (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply("Команда /myid доступна только в личном чате с ботом.");
    }
    return ctx.reply(`🆔 Ваш Telegram ID: ${ctx.from.id}\n\nЭтот идентификатор используется для настройки доступа к административной панели.`);
  });
}
module.exports = { registerMyId };

