const { Keyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { validateParticipantUpdate } = require("./participant-service");
const { isValidProfileEditDraft } = require("./profile-edit-snapshot");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { mainMenuKeyboard, mainMenuText } = require("./main-menu");
const fields = {
  "Имя": "first_name", "Фамилия": "last_name", "Город": "city",
  "Электронная почта": "email", "Предпочтительный способ связи": "preferred_contact",
  "Откуда узнали о клубе": "referral_source"
};
const contactOptions = ["Telegram", "MAX", "Телефонный звонок", "Электронная почта"];

function getProfileDraft(telegramId) {
  const row = db.db.prepare("SELECT * FROM registration_drafts WHERE platform='telegram' AND messenger_user_id=?").get(String(telegramId));
  if (!row) return undefined;
  try { return { ...row, answers: JSON.parse(row.answers_json) }; }
  catch { return { ...row, answers: null, invalidAnswers: true }; }
}

function formatDate(value) {
  if (!value) return "Не указано";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Не указано" : date.toLocaleDateString("ru-RU", { timeZone: "UTC" });
}

function registerProfile(bot, { rateLimiter = createRateLimiter() } = {}) {
  bot.hears("Моя анкета", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("🔒 Просмотр анкеты доступен только в личном чате с ботом.");
    const participant = db.findParticipantByTelegramId(ctx.from.id);
    if (!participant) {
      if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Просмотр анкеты временно ограничен. Обратитесь к организатору клуба.");
      return ctx.reply("Вы ещё не зарегистрированы в клубе „Магия утра“. ☀️\n\nДля создания анкеты нажмите „Зарегистрироваться“.");
    }
    const value = (field) => participant[field] || "Не указано";
    const demoTag = String(process.env.DEMO_MODE).toLowerCase() === "true" && db.isDemoTestParticipant(participant.id) ? "🧪 Тестовая анкета деморежима\n\n" : "";
    const summary = `${demoTag}Ваша анкета:\n\nИмя: ${value("first_name")}\nФамилия: ${value("last_name")}\nТелефон: ${value("phone")}\nГород проживания: ${value("city")}\nEmail: ${value("email")}\nПредпочтительный способ связи: ${value("preferred_contact")}\nОткуда узнали о клубе: ${value("referral_source")}\nДата регистрации: ${formatDate(participant.registered_at)}`;
    return ctx.reply(summary, { reply_markup: new Keyboard().text("✏️ Изменить данные").row().text("🔐 Мои данные").row().text("🔗 Связанные аккаунты").row().text("🏠 Главное меню").resized() });
  });
  bot.hears("🏠 Главное меню", (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Главное меню доступно только в личном чате с ботом.");
    const draft = getProfileDraft(ctx.from.id);
    if (draft?.current_step.startsWith("profile_edit")) db.deleteDraft("telegram", ctx.from.id);
    return ctx.reply(
      mainMenuText,
      { reply_markup: mainMenuKeyboard }
    );
  });
  bot.hears("✏️ Изменить данные", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Анкету можно изменять только в личном чате с ботом.");
    const ownParticipant = db.findParticipantByTelegramId(ctx.from.id);
    if (!ownParticipant) {
      if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Редактирование анкеты временно ограничено. Обратитесь к организатору клуба.");
      return ctx.reply("Анкета не найдена.");
    }
    if (String(process.env.DEMO_MODE).toLowerCase() === "true" && !db.isDemoTestParticipant(ownParticipant.id)) return ctx.reply("В деморежиме редактировать можно только специально созданную тестовую анкету.");
    if (!(await allowRequest(ctx, rateLimiter, "profile_edit"))) return;
    const keyboard = new Keyboard();
    for (const field of Object.keys(fields)) keyboard.text(field).row();
    keyboard.text("Телефон (изменение недоступно)").row().text("Отмена").resized();
    db.saveDraft("telegram", ctx.from.id, "profile_edit_select", {});
    return ctx.reply("Выберите, какое поле изменить. Изменение телефона пока недоступно.", { reply_markup: keyboard });
  });
  bot.hears("Отмена", async (ctx, next) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Редактирование доступно только в личном чате с ботом.");
    const draft = getProfileDraft(ctx.from.id);
    if (!draft?.current_step.startsWith("profile_edit")) return next();
    db.deleteDraft("telegram", ctx.from.id);
    return ctx.reply("Редактирование отменено.");
  });
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || !ctx.message.text) return next();
    const draft = getProfileDraft(ctx.from.id);
    if (!draft?.current_step.startsWith("profile_edit")) return next();
    if (!isPrivateChat(ctx)) return ctx.reply("Редактирование можно продолжить только в личном чате с ботом.");
    if (draft.invalidAnswers) {
      db.deleteDraft("telegram", ctx.from.id);
      return ctx.reply("Черновик редактирования повреждён и сброшен. Откройте изменение анкеты заново.");
    }
    const input = ctx.message.text.trim();
    if (input === "Отмена") { db.deleteDraft("telegram", ctx.from.id); return ctx.reply("Редактирование отменено."); }
    if (input === "🔗 Связанные аккаунты") { db.deleteDraft("telegram", ctx.from.id); return next(); }
    if (!(await allowRequest(ctx, rateLimiter, "profile_edit"))) return;
    const participant = db.findParticipantByTelegramId(ctx.from.id);
    if (!participant) {
      db.deleteDraft("telegram", ctx.from.id);
      if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Редактирование анкеты временно ограничено после изменения согласия.");
      return ctx.reply("Анкета не найдена.");
    }
    if (draft.current_step === "profile_edit_select") {
      if (input === "Телефон (изменение недоступно)") return ctx.reply("Изменение телефона пока недоступно: номер требует повторного подтверждения.");
      const field = fields[input];
      if (!field) return ctx.reply("Выберите поле кнопкой или нажмите «Отмена».");
      const started = db.beginProfileEditDraft(ctx.from.id, field);
      if (started.status !== "ready") {
        db.deleteDraft("telegram", ctx.from.id);
        return ctx.reply(started.status === "consent_withdrawn"
          ? "Редактирование закрыто: доступ к анкете ограничен после изменения согласия."
          : "Анкета не найдена или больше не доступна.");
      }
      if (String(process.env.DEMO_MODE).toLowerCase() === "true" && !db.isDemoTestParticipant(started.participant.id)) {
        db.deleteDraft("telegram", ctx.from.id);
        return ctx.reply("В деморежиме редактировать можно только специально созданную тестовую анкету.");
      }
      const keyboard = new Keyboard();
      if (["city", "email", "preferred_contact", "referral_source"].includes(field)) keyboard.text("Очистить поле").row();
      if (field === "preferred_contact") for (const option of contactOptions) keyboard.text(option).row();
      return ctx.reply(field === "preferred_contact" ? "Выберите новый способ связи:" : "Введите новое значение:", { reply_markup: keyboard.text("Отмена").resized() });
    }
    const field = draft.current_step.slice("profile_edit:".length);
    if (!Object.values(fields).includes(field)) { db.deleteDraft("telegram", ctx.from.id); return ctx.reply("Состояние редактирования сброшено. Откройте изменение анкеты заново."); }
    if (!isValidProfileEditDraft(draft.current_step, draft.answers, participant.id)) {
      db.deleteDraft("telegram", ctx.from.id);
      return ctx.reply("Снимок анкеты отсутствует или повреждён. Откройте изменение анкеты заново.");
    }
    let rawValue = input;
    if (input === "Очистить поле" && ["city", "email", "preferred_contact", "referral_source"].includes(field)) rawValue = null;
    else if (!input) return ctx.reply("Введите значение или нажмите «Очистить поле».");
    let result;
    try {
      result = db.updateParticipantIfUnchanged(participant.id, ctx.from.id, draft.answers.snapshot, { [field]: rawValue }, (current, key, value) => ({ [key]: validateParticipantUpdate(current, key, value) }));
    } catch (error) { return ctx.reply(error.message); }
    if (result.status === "conflict") {
      db.deleteDraft("telegram", ctx.from.id);
      const latest = db.findParticipantByTelegramId(ctx.from.id);
      if (!latest) return ctx.reply("Анкета изменилась в другом сеансе или стала недоступна. Откройте её заново перед повторным изменением.");
      const show = (v) => v || "Не указано";
      const demoTag = String(process.env.DEMO_MODE).toLowerCase() === "true" && db.isDemoTestParticipant(latest.id) ? "🧪 Тестовая анкета деморежима\n\n" : "";
      const summary = `${demoTag}Ваша анкета:\n\nИмя: ${show(latest.first_name)}\nФамилия: ${show(latest.last_name)}\nТелефон: ${show(latest.phone)}\nГород проживания: ${show(latest.city)}\nEmail: ${show(latest.email)}\nПредпочтительный способ связи: ${show(latest.preferred_contact)}\nОткуда узнали о клубе: ${show(latest.referral_source)}\nДата регистрации: ${formatDate(latest.registered_at)}`;
      return ctx.reply(`Анкета изменилась в другом сеансе. Данные обновлены; проверьте их и повторите изменение.\n\n${summary}`, { reply_markup: new Keyboard().text("✏️ Изменить данные").row().text("🔐 Мои данные").row().text("🔗 Связанные аккаунты").row().text("🏠 Главное меню").resized() });
    }
    if (result.status !== "updated") {
      db.deleteDraft("telegram", ctx.from.id);
      return ctx.reply(result.status === "consent_withdrawn" ? "Редактирование закрыто: доступ к анкете ограничен после изменения согласия." : "Анкета не найдена или больше не доступна.");
    }
    db.deleteDraft("telegram", ctx.from.id);
    const updated = result.participant;
    const show = (v) => v || "Не указано";
    const demoTag = String(process.env.DEMO_MODE).toLowerCase() === "true" && db.isDemoTestParticipant(updated.id) ? "🧪 Тестовая анкета деморежима\n\n" : "";
    const summary = `${demoTag}Ваша анкета:\n\nИмя: ${show(updated.first_name)}\nФамилия: ${show(updated.last_name)}\nТелефон: ${show(updated.phone)}\nГород проживания: ${show(updated.city)}\nEmail: ${show(updated.email)}\nПредпочтительный способ связи: ${show(updated.preferred_contact)}\nОткуда узнали о клубе: ${show(updated.referral_source)}\nДата регистрации: ${formatDate(updated.registered_at)}`;
    return ctx.reply(`Данные успешно изменены.\n\n${summary}`, { reply_markup: new Keyboard().text("✏️ Изменить данные").row().text("🔐 Мои данные").row().text("🔗 Связанные аккаунты").row().text("🏠 Главное меню").resized() });
  });
}

module.exports = { registerProfile };
