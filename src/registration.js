const { Keyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { getRegistrationPolicy, validateFieldValue, createRegisteredParticipant, registrationService } = require("./participant-service");
const { createOwnContactProof, createConsentReceipt } = require("./registration-adapters/telegram");
const { createRateLimiter, allowRequest } = require("./request-limits");
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
  "Моя анкета", "✏️ Изменить данные", "🏠 Главное меню", "🔗 Связанные аккаунты",
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
function registerRegistration(bot, { rateLimiter = createRateLimiter() } = {}) {
  const replyStep = (ctx, step) => ctx.reply(prompts[step] || "Введите свой вариант:", { reply_markup: step === "preferred_contact" || step === "referral_source" ? choicesKeyboard(step) : menu(step) });
  const showSummary = (ctx, answers) => ctx.reply(`Проверьте ваши данные:\n\nИмя: ${answers.first_name}\nФамилия: ${answers.last_name}\nТелефон: ${answers.phone}\nГород: ${answers.city || "не указан"}\nEmail: ${answers.email || "не указан"}\nПредпочтительный способ связи: ${answers.preferred_contact}\nОткуда узнали о клубе: ${answers.referral_source || "не указано"}\n\nВсё верно?`, { reply_markup: new Keyboard().text("✅ Подтвердить регистрацию").row().text("✏️ Исправить данные").row().text("❌ Отмена").resized() });
  bot.hears("Зарегистрироваться", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("🔒 Регистрация доступна только в личном чате.\n\nОткройте @magia_utra_club_bot, чтобы зарегистрироваться.");
    if (!(await allowRequest(ctx, rateLimiter, "registration_start"))) return;
    if (String(process.env.DEMO_MODE).toLowerCase() === "true") return ctx.reply("Настоящая регистрация отключена в демонстрационном режиме. Используйте /preview_registration для просмотра анкеты.");
    if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Вы уже зарегистрированы в клубе.");
    const policy = getRegistrationPolicy();
    if (!policy) return ctx.reply("Регистрация временно недоступна: администратору нужно настроить PRIVACY_POLICY_URL и PRIVACY_POLICY_VERSION.");
    const draft = db.getDraft("telegram", ctx.from.id);
    if (draft) {
      if (draft.answers.policy_url !== policy.url || draft.answers.policy_version !== policy.version) return ctx.reply("Версия политики изменилась. Начните регистрацию заново, чтобы дать согласие на актуальные условия.");
      return draft.current_step === "confirm" ? showSummary(ctx, draft.answers) : replyStep(ctx, draft.current_step);
    }
    db.saveDraft("telegram", ctx.from.id, "consent", { policy_url: policy.url, policy_version: policy.version });
    return ctx.reply(`Перед регистрацией ознакомьтесь с политикой: ${policy.url}\n\nНажмите «Согласен», чтобы продолжить, или «❌ Отменить регистрацию».`, { reply_markup: new Keyboard().text("Согласен").row().text("❌ Отменить регистрацию").resized() });
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
    if (text === "🔗 Связанные аккаунты") return next();
    const draft = db.getDraft("telegram", uid);
    if (!draft) return next();
    // Эта кнопка принадлежит обработчику пользовательского меню ниже. Она
    // завершает редактирование профиля, но сохраняет черновик регистрации.
    if (text === "🏠 Главное меню") return next();
    if (draft.current_step.startsWith("profile_edit")) return next();
    let step = draft.current_step; const a = draft.answers; const input = ctx.message.text?.trim();
    if (input === "❌ Отменить регистрацию" || input === "❌ Отмена") {
      if (String(process.env.DEMO_MODE).toLowerCase() === "true") return ctx.reply("Настоящая регистрация отключена в демонстрационном режиме. Черновик не изменён.");
      db.deleteDraft("telegram", uid); return ctx.reply("Регистрация отменена. Чтобы вернуться в меню, отправьте /start.");
    }
    if (!(await allowRequest(ctx, rateLimiter, "registration_continue"))) return;
    if (String(process.env.DEMO_MODE).toLowerCase() === "true") return ctx.reply("Настоящая регистрация отключена в демонстрационном режиме. Черновик сохранён.");
    const activePolicy = getRegistrationPolicy();
    if (!activePolicy) return ctx.reply("Продолжение регистрации временно недоступно: администратору нужно настроить PRIVACY_POLICY_URL и PRIVACY_POLICY_VERSION. Черновик сохранён.");
    if (a.policy_url !== activePolicy.url || a.policy_version !== activePolicy.version) return ctx.reply("Версия политики изменилась. Анкета не сохранена. Начните регистрацию заново после согласия с актуальными условиями.");
    if (step === "consent") {
      if (input !== "Согласен") return ctx.reply("Нужно согласиться с обработкой данных или отменить регистрацию.");
      try {
        a.consent_attestation = createConsentReceipt({ telegramUserId: uid, policyUrl: activePolicy.url, policyVersion: activePolicy.version });
      } catch {
        return ctx.reply("Не удалось безопасно зафиксировать согласие. Попробуйте позже или обратитесь к организатору клуба.");
      }
      a.consent_at = a.consent_attestation.accepted_at; a.consent_version = activePolicy.version; a.consent_given_by = String(uid); a.personal_data_consent = true;
      if (a.resume_after_consent === "confirm") {
        delete a.resume_after_consent;
        db.saveDraft("telegram", uid, "confirm", a);
        return showSummary(ctx, a);
      }
      db.saveDraft("telegram", uid, "first_name", a); return replyStep(ctx, "first_name");
    }
    if (step === "confirm") {
      if (input === "⬅️ Назад") return showSummary(ctx, a);
      if (input === "✅ Подтвердить регистрацию") {
        if (!(await allowRequest(ctx, rateLimiter, "registration_save"))) return;
        try {
          createRegisteredParticipant(a, { platform: "telegram", messenger_user_id: uid });
          db.deleteDraft("telegram", uid);
          return ctx.reply("Регистрация завершена. Добро пожаловать в клуб!");
        } catch (e) {
          if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || e.code === "PHONE_ALREADY_REGISTERED") {
            return ctx.reply("Не удалось завершить регистрацию по этому номеру. Для защиты анкеты автоматическая привязка не выполняется; обратитесь к организатору клуба.");
          }
          if (e.code === "CONSENT_WITHDRAWN") return ctx.reply("Не удалось завершить регистрацию по этому номеру. Обратитесь к организатору клуба для безопасной проверки.");
          if (e.code === "PHONE_PROOF_INVALID") {
            delete a.phone_verification; delete a.phone_confirmed_at; delete a.phone_confirmed_by; delete a.phone;
            db.saveDraft("telegram", uid, "phone", a);
            return ctx.reply("Подтверждение телефона отсутствует или устарело. Поделитесь собственным контактом ещё раз.", { reply_markup: menu("phone") });
          }
          if (e.code === "CONSENT_ATTESTATION_INVALID") {
            delete a.consent_attestation; a.personal_data_consent = false; a.consent_at = null; a.consent_version = null; a.consent_given_by = null; a.resume_after_consent = "confirm";
            db.saveDraft("telegram", uid, "consent", a);
            return ctx.reply(`Пожалуйста, подтвердите согласие с действующей политикой: ${activePolicy.url}\n\nНажмите «Согласен», чтобы вернуться к проверке анкеты, или «❌ Отменить регистрацию».`, { reply_markup: new Keyboard().text("Согласен").row().text("❌ Отменить регистрацию").resized() });
          }
          throw e;
        }
      }
      if (input === "❌ Отмена") { db.deleteDraft("telegram", uid); return ctx.reply("Регистрация отменена. Отправьте /start, чтобы открыть меню."); }
      if (input === "✏️ Исправить данные") return ctx.reply("Какое поле исправить?", { reply_markup: new Keyboard().text("Имя").row().text("Фамилия").row().text("Телефон").row().text("Город").row().text("Электронная почта").row().text("Способ связи").row().text("Источник").row().text("⬅️ Назад").resized() });
      const keys = Object.keys(fieldNames); const selected = keys.find(k => fieldNames[k] === input);
      if (selected) { a.editing = selected; step = selected; db.saveDraft("telegram", uid, step, a); return replyStep(ctx, step); }
      return ctx.reply("Выберите подтверждение, исправление или отмену.");
    }
    if (input === "⬅️ Назад") {
      if (a.awaiting_referral_detail) {
        delete a.awaiting_referral_detail;
        db.saveDraft("telegram", uid, step, a);
        return replyStep(ctx, step);
      }
      if (a.editing) {
        delete a.editing;
        db.saveDraft("telegram", uid, "confirm", a);
        return showSummary(ctx, a);
      }
      const idx = order.indexOf(step); if (idx <= 0) return replyStep(ctx, step);
      step = order[idx - 1]; db.saveDraft("telegram", uid, step, a); return replyStep(ctx, step);
    }
    if (step === "phone") {
      const c = ctx.message.contact;
      if (!c || c.user_id !== uid) return ctx.reply("Принимается только ваш контакт через кнопку «📱 Поделиться номером». Ручной ввод пока недоступен.", { reply_markup: menu(step) });
      try {
        a.phone_verification = createOwnContactProof({ contact: c, telegramUserId: uid, normalizePhone: db.normalizePhone });
        a.phone = a.phone_verification.phone;
      } catch { return ctx.reply("Принимается только ваш номер через кнопку «📱 Поделиться номером». Поделитесь контактом ещё раз.", { reply_markup: menu(step) }); }
      let phoneCheck;
      try { phoneCheck = registrationService.inspectVerifiedPhone({ platform: "telegram", messenger_user_id: uid }, a.phone_verification); }
      catch { return ctx.reply("Не удалось безопасно проверить номер. Поделитесь контактом ещё раз.", { reply_markup: menu(step) }); }
      if (phoneCheck.status !== "new_participant") return ctx.reply("Этот номер уже зарегистрирован. Для защиты данных обратитесь к администратору.", { reply_markup: menu(step) });
      a.phone_confirmed_at = a.phone_verification.confirmed_at; a.phone_confirmed_by = String(uid);
    } else if (input === "Пропустить" && optional.has(step)) {
      try { a[step] = validateFieldValue(step, null, a); }
      catch (error) { return ctx.reply(error.message); }
    }
    else if (step === "first_name" || step === "last_name") {
      try { a[step] = validateFieldValue(step, input, a); }
      catch (error) { return ctx.reply(error.message); }
    }
    else if (step === "city") {
      if (!input) return ctx.reply("Введите город или нажмите «Пропустить».");
      try { a.city = validateFieldValue("city", input, a); }
      catch (error) { return ctx.reply(error.message); }
    }
    else if (step === "email") {
      if (!input) return ctx.reply("Введите корректный email или нажмите «Пропустить».");
      try { a.email = validateFieldValue("email", input, a); }
      catch (error) { return ctx.reply(error.message); }
    }
    else if (step === "preferred_contact") {
      if (!values.preferred_contact.includes(input)) return ctx.reply("Выберите способ кнопкой.", { reply_markup: choicesKeyboard(step) });
      try { a.preferred_contact = validateFieldValue("preferred_contact", input, a); }
      catch (error) { return ctx.reply(`${error.message} Выберите способ кнопкой.`, { reply_markup: choicesKeyboard(step) }); }
    }
    else if (step === "referral_source") {
      if (input === "Другое" && !a.awaiting_referral_detail) { a.awaiting_referral_detail = true; db.saveDraft("telegram", uid, step, a); return ctx.reply("Напишите, пожалуйста, свой вариант.", { reply_markup: menu(step) }); }
      if (a.awaiting_referral_detail) {
        try { a.referral_source = validateFieldValue("referral_source", input, a); }
        catch (error) { return ctx.reply(error.message); }
        delete a.awaiting_referral_detail;
      } else {
        if (!values.referral_source.includes(input)) return ctx.reply("Выберите вариант кнопкой или нажмите «Пропустить».", { reply_markup: choicesKeyboard(step) });
        a.referral_source = input === "Пропустить" ? null : validateFieldValue("referral_source", input, a);
      }
    }
    if (a.editing) { delete a.editing; db.saveDraft("telegram", uid, "confirm", a); return showSummary(ctx, a); }
    const idx = order.indexOf(step); const nextStep = idx === order.length - 1 ? "confirm" : order[idx + 1]; db.saveDraft("telegram", uid, nextStep, a);
    return nextStep === "confirm" ? showSummary(ctx, a) : replyStep(ctx, nextStep);
  });
}
module.exports = { registerRegistration, registrationFlow: { prompts, order, optional, values, fieldNames } };

