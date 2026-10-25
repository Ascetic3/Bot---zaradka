const crypto = require("node:crypto");
const { Keyboard, InlineKeyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { getRegistrationPolicy, validateFieldValue, createRegisteredParticipant, registrationService } = require("./participant-service");
const { createOwnContactProof, createConsentReceipt } = require("./registration-adapters/telegram");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { mainMenuKeyboard, mainMenuText } = require("./main-menu");
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
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function createConsentDraftAnswers(previousAnswers, policy, resumeStep = null) {
  const answers = { ...previousAnswers, policy_url: policy.url, policy_version: policy.version, consent_nonce: crypto.randomBytes(16).toString("hex") };
  for (const key of ["consent_attestation", "consent_at", "consent_version", "consent_given_by", "personal_data_consent"]) delete answers[key];
  if (order.includes(resumeStep) || resumeStep === "confirm") answers.resume_after_consent = resumeStep;
  else delete answers.resume_after_consent;
  return answers;
}
function registerRegistration(bot, { rateLimiter = createRateLimiter() } = {}) {
  const replyStep = (ctx, step) => ctx.reply(prompts[step] || "Введите свой вариант:", { reply_markup: step === "preferred_contact" || step === "referral_source" ? choicesKeyboard(step) : menu(step) });
  const showSummary = (ctx, answers) => ctx.reply(`Проверьте ваши данные:\n\nИмя: ${answers.first_name}\nФамилия: ${answers.last_name}\nТелефон: ${answers.phone}\nГород: ${answers.city || "не указан"}\nEmail: ${answers.email || "не указан"}\nПредпочтительный способ связи: ${answers.preferred_contact}\nОткуда узнали о клубе: ${answers.referral_source || "не указано"}\n\nВсё верно?`, { reply_markup: new Keyboard().text("✅ Подтвердить регистрацию").row().text("✏️ Исправить данные").row().text("❌ Отмена").resized() });
  const renderConsent = (ctx, answers) => {
    const text = "<b>Согласие на обработку персональных данных</b>\n\n" +
      "Для регистрации в клубе „Магия утра“ нам потребуются ваши имя, фамилия, номер телефона и дополнительные сведения, которые вы решите указать.\n\n" +
      "Также Telegram ID используется, чтобы связать анкету с вашим аккаунтом и показывать её только вам.\n\n" +
      "Пожалуйста, ознакомьтесь с <a href=\"" + escapeHtml(answers.policy_url) + "\">Политикой обработки персональных данных</a>.\n\n" +
      "Нажимая «Принимаю», вы даёте согласие на обработку указанных данных для регистрации и связи по вопросам деятельности клуба.\n\n" +
      "Вы можете отозвать согласие в разделе «🔐 Мои данные».";
    const keyboard = new InlineKeyboard()
      .text("✅ Принимаю", "mconsent:a:" + answers.consent_nonce)
      .row()
      .text("❌ Отказываюсь", "mconsent:d:" + answers.consent_nonce);
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
  };
  const refreshConsent = (ctx, uid, answers, policy, resumeStep) => {
    const freshAnswers = createConsentDraftAnswers(answers, policy, resumeStep);
    db.saveDraft("telegram", uid, "consent", freshAnswers);
    return renderConsent(ctx, freshAnswers);
  };
  const removeConsentButtons = async (ctx) => {
    if (!ctx.callbackQuery?.message) return;
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { /* stale Telegram message: its callback remains harmless */ }
  };
  const refuseConsent = async (ctx, uid) => {
    db.deleteDraft("telegram", uid);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Отказ принят. Черновик регистрации удалён." });
      await removeConsentButtons(ctx);
    }
    return ctx.reply("Вы отказались от обработки данных для регистрации. Черновик удалён.\n\n" + mainMenuText, { reply_markup: mainMenuKeyboard });
  };
  const acceptConsent = async (ctx, uid, draft) => {
    if (!(await allowRequest(ctx, rateLimiter, "registration_continue"))) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Слишком много запросов. Попробуйте позже." });
      return;
    }
    if (String(process.env.DEMO_MODE).toLowerCase() === "true") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Реальная регистрация отключена в деморежиме." });
      return ctx.reply("Настоящая регистрация отключена в демонстрационном режиме. Черновик сохранён.");
    }
    const activePolicy = getRegistrationPolicy();
    if (!activePolicy) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Политика не опубликована или не настроена." });
      return ctx.reply("Регистрация временно недоступна: администратору нужно заполнить, утвердить и опубликовать политику, затем настроить PRIVACY_POLICY_URL, PRIVACY_POLICY_VERSION и PRIVACY_POLICY_PUBLISHED=true.");
    }
    if (draft.answers.policy_url !== activePolicy.url || draft.answers.policy_version !== activePolicy.version) {
      const resumeStep = draft.answers.resume_after_consent || (draft.current_step === "consent" ? null : draft.current_step);
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Версия политики изменилась. Проверьте актуальный текст." });
        await removeConsentButtons(ctx);
      }
      return refreshConsent(ctx, uid, draft.answers, activePolicy, resumeStep);
    }
    const answers = { ...draft.answers };
    try {
      answers.consent_attestation = createConsentReceipt({ telegramUserId: uid, policyUrl: activePolicy.url, policyVersion: activePolicy.version });
    } catch {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Не удалось зафиксировать согласие." });
      return ctx.reply("Не удалось безопасно зафиксировать согласие. Попробуйте позже или обратитесь к организатору клуба.");
    }
    answers.consent_at = answers.consent_attestation.accepted_at;
    answers.consent_version = activePolicy.version;
    answers.consent_given_by = String(uid);
    answers.personal_data_consent = true;
    const resumeStep = answers.resume_after_consent;
    delete answers.resume_after_consent;
    delete answers.consent_nonce;
    const nextStep = order.includes(resumeStep) ? resumeStep : "first_name";
    db.saveDraft("telegram", uid, nextStep, answers);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Согласие зафиксировано." });
      await removeConsentButtons(ctx);
    }
    return nextStep === "confirm" ? showSummary(ctx, answers) : replyStep(ctx, nextStep);
  };
  bot.callbackQuery(/^mconsent:([ad]):([a-f0-9]{32})$/, async (ctx) => {
    const uid = ctx.from?.id;
    if (!uid || !isPrivateChat(ctx) || String(ctx.chat?.id) !== String(uid)) {
      return ctx.answerCallbackQuery({ text: "Согласие доступно только в личном чате с ботом." });
    }
    const [, action, nonce] = ctx.match;
    const draft = db.getDraft("telegram", uid);
    if (!draft || draft.current_step !== "consent" || draft.answers.consent_nonce !== nonce) {
      return ctx.answerCallbackQuery({ text: "Кнопка устарела или уже обработана." });
    }
    if (action === "d") return refuseConsent(ctx, uid);
    return acceptConsent(ctx, uid, draft);
  });
  bot.hears("Зарегистрироваться", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("🔒 Регистрация доступна только в личном чате.\n\nОткройте @magia_utra_club_bot, чтобы зарегистрироваться.");
    if (!(await allowRequest(ctx, rateLimiter, "registration_start"))) return;
    if (String(process.env.DEMO_MODE).toLowerCase() === "true") return ctx.reply("Настоящая регистрация отключена в демонстрационном режиме. Используйте /preview_registration для просмотра анкеты.");
    if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Вы уже зарегистрированы в клубе.");
    const policy = getRegistrationPolicy();
    if (!policy) return ctx.reply("Регистрация временно недоступна: администратору нужно заполнить, утвердить и опубликовать политику, затем настроить PRIVACY_POLICY_URL, PRIVACY_POLICY_VERSION и PRIVACY_POLICY_PUBLISHED=true.");
    const draft = db.getDraft("telegram", ctx.from.id);
    if (!draft) {
      const answers = createConsentDraftAnswers({}, policy);
      db.saveDraft("telegram", ctx.from.id, "consent", answers);
      return renderConsent(ctx, answers);
    }
    if (draft.answers.policy_url !== policy.url || draft.answers.policy_version !== policy.version) {
      const resumeStep = draft.answers.resume_after_consent || (draft.current_step === "consent" ? null : draft.current_step);
      return refreshConsent(ctx, ctx.from.id, draft.answers, policy, resumeStep);
    }
    if (draft.current_step === "consent") {
      if (!/^[a-f0-9]{32}$/.test(String(draft.answers.consent_nonce ?? ""))) {
        const answers = createConsentDraftAnswers(draft.answers, policy, draft.answers.resume_after_consent);
        db.saveDraft("telegram", ctx.from.id, "consent", answers);
        return renderConsent(ctx, answers);
      }
      return renderConsent(ctx, draft.answers);
    }
    return draft.current_step === "confirm" ? showSummary(ctx, draft.answers) : replyStep(ctx, draft.current_step);
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
    if (step === "consent") return ctx.reply("Пожалуйста, используйте inline-кнопки «✅ Принимаю» или «❌ Отказываюсь» под сообщением о согласии.");
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
            const answers = createConsentDraftAnswers(a, activePolicy, "confirm");
            db.saveDraft("telegram", uid, "consent", answers);
            return renderConsent(ctx, answers);
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


