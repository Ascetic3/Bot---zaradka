const { Keyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");

const menuKeyboard = new Keyboard()
  .text("Зарегистрироваться")
  .row()
  .text("Моя анкета")
  .resized();
const fields = {
  "Имя": "first_name", "Фамилия": "last_name", "Город": "city",
  "Электронная почта": "email", "Предпочтительный способ связи": "preferred_contact",
  "Откуда узнали о клубе": "referral_source"
};
const contactOptions = ["Telegram", "MAX", "Телефонный звонок", "Электронная почта"];

function formatDate(value) {
  if (!value) return "Не указано";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Не указано" : date.toLocaleDateString("ru-RU", { timeZone: "UTC" });
}

function registerProfile(bot) {
  bot.hears("Моя анкета", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("🔒 Просмотр анкеты доступен только в личном чате с ботом.");
    const participant = db.findParticipantByTelegramId(ctx.from.id);
    if (!participant) {
      return ctx.reply("Вы ещё не зарегистрированы в клубе „Магия утра“. ☀️\n\nДля создания анкеты нажмите „Зарегистрироваться“.");
    }
    const value = (field) => participant[field] || "Не указано";
    const summary = `Ваша анкета:\n\nИмя: ${value("first_name")}\nФамилия: ${value("last_name")}\nТелефон: ${value("phone")}\nГород проживания: ${value("city")}\nEmail: ${value("email")}\nПредпочтительный способ связи: ${value("preferred_contact")}\nОткуда узнали о клубе: ${value("referral_source")}\nДата регистрации: ${formatDate(participant.registered_at)}`;
    return ctx.reply(summary, { reply_markup: new Keyboard().text("✏️ Изменить данные").row().text("🏠 Главное меню").resized() });
  });
  bot.hears("🏠 Главное меню", (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Главное меню доступно только в личном чате с ботом.");
    return ctx.reply(
      "Добро пожаловать в клуб „Магия утра“! ☀️\n\nЗдесь вы можете зарегистрироваться в клубе и посмотреть свою анкету.\n\nВыберите действие:",
      { reply_markup: menuKeyboard }
    );
  });
  bot.hears("✏️ Изменить данные", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Анкету можно изменять только в личном чате с ботом.");
    if (!db.findParticipantByTelegramId(ctx.from.id)) return ctx.reply("Анкета не найдена.");
    const keyboard = new Keyboard();
    for (const field of Object.keys(fields)) keyboard.text(field).row();
    keyboard.text("Телефон (изменение недоступно)").row().text("Отмена").resized();
    db.saveDraft("telegram", ctx.from.id, "profile_edit_select", {});
    return ctx.reply("Выберите, какое поле изменить. Изменение телефона пока недоступно.", { reply_markup: keyboard });
  });
  bot.hears("Отмена", async (ctx, next) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Редактирование доступно только в личном чате с ботом.");
    const draft = db.getDraft("telegram", ctx.from.id);
    if (!draft?.current_step.startsWith("profile_edit")) return next();
    db.deleteDraft("telegram", ctx.from.id);
    return ctx.reply("Редактирование отменено.");
  });
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || !ctx.message.text) return next();
    const draft = db.getDraft("telegram", ctx.from.id);
    if (!draft?.current_step.startsWith("profile_edit")) return next();
    if (!isPrivateChat(ctx)) return ctx.reply("Редактирование можно продолжить только в личном чате с ботом.");
    const input = ctx.message.text.trim();
    if (input === "Отмена") { db.deleteDraft("telegram", ctx.from.id); return ctx.reply("Редактирование отменено."); }
    const participant = db.findParticipantByTelegramId(ctx.from.id);
    if (!participant) { db.deleteDraft("telegram", ctx.from.id); return ctx.reply("Анкета не найдена."); }
    if (draft.current_step === "profile_edit_select") {
      if (input === "Телефон (изменение недоступно)") return ctx.reply("Изменение телефона пока недоступно: номер требует повторного подтверждения.");
      const field = fields[input];
      if (!field) return ctx.reply("Выберите поле кнопкой или нажмите «Отмена».");
      db.saveDraft("telegram", ctx.from.id, `profile_edit:${field}`, {});
      const keyboard = new Keyboard();
      if (["city", "email", "preferred_contact", "referral_source"].includes(field)) keyboard.text("Очистить поле").row();
      if (field === "preferred_contact") for (const option of contactOptions) keyboard.text(option).row();
      return ctx.reply(field === "preferred_contact" ? "Выберите новый способ связи:" : "Введите новое значение:", { reply_markup: keyboard.text("Отмена").resized() });
    }
    const field = draft.current_step.slice("profile_edit:".length);
    if (!Object.values(fields).includes(field)) { db.deleteDraft("telegram", ctx.from.id); return ctx.reply("Состояние редактирования сброшено. Откройте изменение анкеты заново."); }
    let value = input;
    if (input === "Очистить поле" && ["city", "email", "preferred_contact", "referral_source"].includes(field)) value = null;
    else if (["first_name", "last_name"].includes(field) && (!value || value.length > 100)) return ctx.reply("Поле обязательно. Введите непустое значение длиной до 100 символов.");
    else if (["city", "email", "referral_source"].includes(field) && !value) return ctx.reply("Введите значение или нажмите «Очистить поле».");
    else if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return ctx.reply("Введите корректный email или нажмите «Очистить поле».");
    else if (field === "preferred_contact" && !contactOptions.includes(value)) return ctx.reply("Выберите способ связи кнопкой.");
    if (field === "preferred_contact" && value === "Электронная почта" && !participant.email) return ctx.reply("Сначала добавьте электронную почту, затем выберите её способом связи.");
    db.updateParticipant(participant.id, { [field]: value });
    db.deleteDraft("telegram", ctx.from.id);
    const updated = db.findParticipantByTelegramId(ctx.from.id);
    const show = (v) => v || "Не указано";
    const summary = `Ваша анкета:\n\nИмя: ${show(updated.first_name)}\nФамилия: ${show(updated.last_name)}\nТелефон: ${show(updated.phone)}\nГород проживания: ${show(updated.city)}\nEmail: ${show(updated.email)}\nПредпочтительный способ связи: ${show(updated.preferred_contact)}\nОткуда узнали о клубе: ${show(updated.referral_source)}\nДата регистрации: ${formatDate(updated.registered_at)}`;
    return ctx.reply(`Данные успешно изменены.\n\n${summary}`, { reply_markup: new Keyboard().text("✏️ Изменить данные").row().text("🏠 Главное меню").resized() });
  });
}

module.exports = { registerProfile };

