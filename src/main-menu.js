const { Keyboard } = require("grammy");
const { isPrivateChat } = require("./chat-guards");
const { createRateLimiter, allowRequest } = require("./request-limits");

const mainMenuKeyboard = new Keyboard()
  .text("Зарегистрироваться")
  .row()
  .text("Моя анкета")
  .row()
  .text("🔐 Мои данные")
  .row()
  .text("🔗 Связанные аккаунты")
  .resized();
const mainMenuText = "Добро пожаловать в клуб „Магия утра“! ☀️\n\nЗдесь вы можете зарегистрироваться в клубе и посмотреть свою анкету.\n\nВыберите действие:";

function registerStart(bot, { rateLimiter = createRateLimiter() } = {}) {
  bot.command("start", async (ctx) => {
    if (!(await allowRequest(ctx, rateLimiter, "command_start"))) return;
    if (!isPrivateChat(ctx)) {
      return ctx.reply(
        "☀️ Добро пожаловать в клуб „Магия утра“!\n\n" +
          "Регистрация и работа с анкетой доступны только в личных сообщениях с ботом.\n\n" +
          "Перейдите к @magia_utra_club_bot."
      );
    }
    return ctx.reply(mainMenuText, { reply_markup: mainMenuKeyboard });
  });
}

module.exports = { registerStart, mainMenuKeyboard, mainMenuText };

