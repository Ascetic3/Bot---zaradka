const { Keyboard } = require("grammy");
const { isPrivateChat } = require("./chat-guards");

const mainMenuKeyboard = new Keyboard()
  .text("Зарегистрироваться")
  .row()
  .text("Моя анкета")
  .resized();

function registerStart(bot) {
  bot.command("start", (ctx) => {
    if (!isPrivateChat(ctx)) {
      return ctx.reply(
        "☀️ Добро пожаловать в клуб „Магия утра“!\n\n" +
          "Регистрация и работа с анкетой доступны только в личных сообщениях с ботом.\n\n" +
          "Перейдите к @magia_utra_club_bot."
      );
    }
    return ctx.reply(
      "Добро пожаловать в клуб „Магия утра“! ☀️\n\n" +
        "Здесь вы можете зарегистрироваться в клубе и посмотреть свою анкету.\n\n" +
        "Выберите действие:",
      { reply_markup: mainMenuKeyboard }
    );
  });
}

module.exports = { registerStart };

