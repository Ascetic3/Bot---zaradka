const { Keyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const prompts = {
  first_name: "Как вас зовут? ☀️", last_name: "Введите вашу фамилию.",
  phone: "Поделитесь номером телефона, чтобы мы могли связаться с вами по вопросам клуба.",
  city: "В каком городе вы живёте?", email: "Укажите вашу электронную почту, если хотите получать информацию по email.",
  preferred_contact: "Как с вами удобнее всего связаться?",
  referral_source: "Откуда вы узнали о клубе „Магия утра“?"
};
const order = ["first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source"];
const optional = new Set(["city", "email", "referral_source"]);
const values = {
  preferred_contact: ["Telegram", "MAX", "Телефонный звонок", "Электронная почта"],
  referral_source: ["От друзей или знакомых", "Telegram", "MAX", "Другие социальные сети", "Реклама", "Мероприятие", "Другое", "Пропустить"]
};
const fieldNames = { first_name: "Имя", last_name: "Фамилия", phone: "Телефон", city: "Город", email: "Электронная почта", preferred_contact: "Способ связи", referral_source: "Источник" };
const otherMenuActions = new Set([
  "Моя анкета", "✏️ Изменить данные", "🏠 Главное меню",
  "🔎 Найти участника", "👥 Все участники", "📊 Статистика", "📥 Скачать Excel",
  "⚙️ Управление администраторами", "📋 Список администраторов", "➕ Добавить администратора",
  "➖ Удалить администратора", "⬅️ В меню администратора", "⬅️ Админ-меню", "Отмена",
  "🔄 Обновить статистику", "✅ Подтвердить выгрузку", "⬅️ Назад", "➡️ Далее", "🏠 Админ-меню"
]);
const menu = (step) => {
  const k = new Keyboard();
  if (step === "phone") k.requestContact("📱 Поделиться номером").row();
  if (optional.has(step)) k.text("Пропустить").row();
  if (order.indexOf(step) > 0) k.text("⬅️ Назад").row();
  return k.text("❌ Отменить регистрацию").resized();
};
const choicesKeyboard = (step) => { const k = new Keyboard(); for (const v of values[step]) k.text(v).row(); if (order.indexOf(step)>0) k.text("⬅️ Назад").row(); return k.text("❌ Отменить регистрацию").resized(); };
function registerRegistration(bot) {
  const replyStep = (ctx, step) => ctx.reply(prompts[step] || "Введите свой вариант:", { reply_markup: step === "preferred_contact" || step === "referral_source" ? choicesKeyboard(step) : menu(step) });
  const showSummary = (ctx, answers) => ctx.reply(`Проверьте ваши данные:\n\nИмя: ${answers.first_name}\nФамилия: ${answers.last_name}\nТелефон: ${answers.phone}\nГород: ${answers.city || "не указан"}\nEmail: ${answers.email || "не указан"}\nПредпочтительный способ связи: ${answers.preferred_contact}\nОткуда узнали о клубе: ${answers.referral_source || "не указано"}\n\nВсё верно?`, { reply_markup: new Keyboard().text("✅ Подтвердить регистрацию").row().text("✏️ Исправить данные").row().text("❌ Отмена").resized() });
  bot.hears("Зарегистрироваться", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("🔒 Регистрация доступна только в личном чате.\n\nОткройте @magia_utra_club_bot, чтобы зарегистрироваться.");
    if (db.findParticipantByTelegramId(ctx.from.id)) return ctx.reply("Вы уже зарегистрированы в клубе.");
    const policy = process.env.PRIVACY_POLICY_URL;
    if (!policy) return ctx.reply("Регистрация временно недоступна: администратору нужно настроить переменную PRIVACY_POLICY_URL со ссылкой на политику обработки персональных данных.");
    const draft = db.getDraft("telegram", ctx.from.id);
    if (draft) return draft.current_step === "confirm" ? showSummary(ctx, draft.answers) : replyStep(ctx, draft.current_step);
    db.saveDraft("telegram", ctx.from.id, "consent", { policy_url: policy });
    return ctx.reply(`Перед регистрацией ознакомьтесь с политикой: ${policy}\n\nНажмите «Согласен», чтобы продолжить, или «❌ Отменить регистрацию».`, { reply_markup: new Keyboard().text("Согласен").row().text("❌ Отменить регистрацию").resized() });
  });
  bot.on("message", async (ctx, next) => {
    if (!ctx.from || (!ctx.message.text && !ctx.message.contact)) return next();
    // Команды должны дойти до своих обработчиков, а не стать ответом на вопрос анкеты.
    if (ctx.message.text && /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(ctx.message.text.trim())) return next();
    const text = ctx.message.text?.trim();
    const uid = ctx.from.id;
    if (!isPrivateChat(ctx)) {
      if (otherMenuActions.has(text)) return next();
      if (ctx.message.contact || db.hasDraft("telegram", uid)) return ctx.reply("🔒 Регистрация доступна только в личном чате.\n\nОткройте @magia_utra_club_bot, чтобы зарегистрироваться.");
      return next();
    }
    // Обычную отмену обрабатывают админ-панель и редактирование профиля.
    if (text === "Отмена") return next();
    const draft = db.getDraft("telegram", uid);
    if (!draft) return next();
    if (draft.current_step.startsWith("profile_edit")) return next();
    let step = draft.current_step; const a = draft.answers; const input = ctx.message.text?.trim();
    if (input === "❌ Отменить регистрацию" || input === "❌ Отмена") { db.deleteDraft("telegram", uid); return ctx.reply("Регистрация отменена. Чтобы вернуться в меню, отправьте /start."); }
    if (step === "consent") {
      if (input !== "Согласен") return ctx.reply("Нужно согласиться с обработкой данных или отменить регистрацию.");
      a.consent_at = new Date().toISOString(); db.saveDraft("telegram", uid, "first_name", a); return replyStep(ctx, "first_name");
    }
    if (step === "confirm") {
      if (input === "✅ Подтвердить регистрацию") {
        try { db.addParticipant({ ...a, personal_data_consent: true }, { platform: "telegram", messenger_user_id: uid }); db.deleteDraft("telegram", uid); return ctx.reply("Регистрация завершена. Добро пожаловать в клуб!"); }
        catch (e) { if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") return ctx.reply("Этот номер или Telegram-аккаунт уже зарегистрирован."); throw e; }
      }
      if (input === "❌ Отмена") { db.deleteDraft("telegram", uid); return ctx.reply("Регистрация отменена. Отправьте /start, чтобы открыть меню."); }
      if (input === "✏️ Исправить данные") return ctx.reply("Какое поле исправить?", { reply_markup: new Keyboard().text("Имя").row().text("Фамилия").row().text("Телефон").row().text("Город").row().text("Электронная почта").row().text("Способ связи").row().text("Источник").row().text("⬅️ Назад").resized() });
      const keys = Object.keys(fieldNames); const selected = keys.find(k => fieldNames[k] === input);
      if (selected) { a.editing = selected; step = selected; db.saveDraft("telegram", uid, step, a); return replyStep(ctx, step); }
      return ctx.reply("Выберите подтверждение, исправление или отмену.");
    }
    if (input === "⬅️ Назад") {
      const idx = order.indexOf(step); if (idx <= 0) return replyStep(ctx, step);
      step = order[idx - 1]; db.saveDraft("telegram", uid, step, a); return replyStep(ctx, step);
    }
    if (step === "phone") {
      const c = ctx.message.contact;
      if (!c || c.user_id !== uid) return ctx.reply("Принимается только ваш контакт через кнопку «📱 Поделиться номером». Ручной ввод пока недоступен.", { reply_markup: menu(step) });
      try { a.phone = db.normalizePhone(c.phone_number); } catch { return ctx.reply("Не удалось распознать номер. Поделитесь контактом ещё раз.", { reply_markup: menu(step) }); }
      if (db.findParticipantByPhone(a.phone)) return ctx.reply("Этот номер уже зарегистрирован. Для защиты данных обратитесь к администратору.", { reply_markup: menu(step) });
      a.phone_confirmed_at = new Date().toISOString();
    } else if (input === "Пропустить" && optional.has(step)) a[step] = null;
    else if (step === "first_name" || step === "last_name") { if (!input || input.length > 100) return ctx.reply("Ответ обязателен и должен быть не длиннее 100 символов."); a[step] = input; }
    else if (step === "city") { if (!input || input.length > 100) return ctx.reply("Введите город или нажмите «Пропустить»."); a.city = input; }
    else if (step === "email") { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input || "")) return ctx.reply("Введите корректный email или нажмите «Пропустить»."); a.email = input; }
    else if (step === "preferred_contact") { if (!values.preferred_contact.includes(input) || input === "Электронная почта" && !a.email) return ctx.reply("Выберите способ кнопкой. Для электронной почты сначала укажите email.", { reply_markup: choicesKeyboard(step) }); a.preferred_contact = input; }
    else if (step === "referral_source") { if (input === "Другое") { a.awaiting_referral_detail = true; db.saveDraft("telegram", uid, step, a); return ctx.reply("Напишите, пожалуйста, свой вариант.", { reply_markup: menu(step) }); } if (a.awaiting_referral_detail) { if (!input || input.length > 120) return ctx.reply("Напишите короткий ответ до 120 символов."); a.referral_source = input; delete a.awaiting_referral_detail; } else { if (!values.referral_source.includes(input)) return ctx.reply("Выберите вариант кнопкой или нажмите «Пропустить».", { reply_markup: choicesKeyboard(step) }); a.referral_source = input === "Пропустить" ? null : input; } }
    if (a.editing) { delete a.editing; db.saveDraft("telegram", uid, "confirm", a); return showSummary(ctx, a); }
    const idx = order.indexOf(step); const nextStep = idx === order.length - 1 ? "confirm" : order[idx + 1]; db.saveDraft("telegram", uid, nextStep, a);
    return nextStep === "confirm" ? showSummary(ctx, a) : replyStep(ctx, nextStep);
  });
}
module.exports = { registerRegistration, registrationFlow: { prompts, order, optional, values, fieldNames } };


