const crypto = require("node:crypto");
const { Keyboard, InlineKeyboard } = require("grammy");
const { isPrivateChat } = require("./chat-guards");
const { registrationFlow } = require("./registration");
const db = require("./database");
const { validateFieldValue } = require("./participant-service");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { ExpiringMap } = require("./expiring-map");
const { mainMenuKeyboard, mainMenuText } = require("./main-menu");

const TEST_PHONE = "+70000000000";
const CANCEL = "❌ Отмена";
const TEST_PHONE_BUTTON = "🧪 Использовать тестовый номер";
const states = new ExpiringMap(30 * 60_000);
const { prompts, order, optional, values, fieldNames } = registrationFlow;

async function clearRegistrationPreviewSession(userId, ctx) {
  const state = states.get(String(userId));
  if (state?.consentChatId && state?.consentMessageId) {
    try { await ctx.api.editMessageReplyMarkup({ chat_id: state.consentChatId, message_id: state.consentMessageId, reply_markup: { inline_keyboard: [] } }); } catch {}
  }
  return states.delete(String(userId));
}

function getPreviewPolicyUrl() {
  const raw = String(process.env.PREVIEW_POLICY_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function consentScreen(url, nonce) {
  const safeUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const text = "<b>Демонстрационный экран согласия</b>\n\n" +
    "Перед вопросами ознакомьтесь с <a href=\"" + safeUrl + "\">политикой обработки персональных данных</a>.\n\n" +
    "Это тестовый экран. Нажатие кнопки не фиксирует согласие и не сохраняет данные.";
  const keyboard = new InlineKeyboard()
    .text("✅ Принимаю", "mpreview:accept:" + nonce)
    .row()
    .text("❌ Отказываюсь", "mpreview:decline:" + nonce);
  return { text, keyboard };
}

function questionKeyboard(step) {
  const keyboard = new Keyboard();
  if (step === "phone") keyboard.text(TEST_PHONE_BUTTON).row();
  if (optional.has(step)) keyboard.text("Пропустить").row();
  if (order.indexOf(step) > 0) keyboard.text("⬅️ Назад").row();
  return keyboard.text(CANCEL).resized();
}

function choicesKeyboard(step) {
  const keyboard = new Keyboard();
  for (const option of values[step]) keyboard.text(option).row();
  if (order.indexOf(step) > 0) keyboard.text("⬅️ Назад").row();
  return keyboard.text(CANCEL).resized();
}

function summaryText(answers) {
  return `Предварительный просмотр анкеты:\n\nИмя: ${answers.first_name || "Не указано"}\nФамилия: ${answers.last_name || "Не указано"}\nТелефон: ${answers.phone || "Не указано"}\nГород: ${answers.city || "Не указано"}\nEmail: ${answers.email || "Не указано"}\nПредпочтительный способ связи: ${answers.preferred_contact || "Не указано"}\nОткуда узнали о клубе: ${answers.referral_source || "Не указано"}\n\nЭто предварительный просмотр. Анкета не будет сохранена.`;
}

function registerRegistrationPreview(bot, { database = db, getRole = (id) => database.getAdminRole(id), rateLimiter = createRateLimiter() } = {}) {
  const replyQuestion = (ctx, state) => {
    const step = state.step;
    const prompt = step === "preferred_contact" || step === "referral_source" ? choicesKeyboard(step) : questionKeyboard(step);
    return ctx.reply(prompts[step], { reply_markup: prompt });
  };
  const replySummary = (ctx, state) => ctx.reply(summaryText(state.answers), {
    reply_markup: new Keyboard().text("✅ Подтвердить регистрацию").row().text("✏️ Исправить данные").row().text(CANCEL).resized()
  });
  const authorized = (ctx) => isPrivateChat(ctx) && ctx.from && Boolean(getRole(ctx.from.id));
  const removeConsentButtons = async (ctx) => {
    try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch { /* stale messages are harmless after the in-memory nonce is consumed */ }
  };
  const removeStoredConsentButtons = async (ctx, state) => {
    if (!state?.consentChatId || !state?.consentMessageId) return;
    try {
      await ctx.api.editMessageReplyMarkup({
        chat_id: state.consentChatId,
        message_id: state.consentMessageId,
        reply_markup: { inline_keyboard: [] }
      });
    } catch { /* the message may already be gone or its buttons already removed */ }
  };

  bot.command("preview_registration", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Предварительный просмотр доступен только в личном чате с ботом.");
    if (!authorized(ctx)) {
      const previousState = ctx.from ? states.get(String(ctx.from.id)) : null;
      await removeStoredConsentButtons(ctx, previousState);
      if (ctx.from) states.delete(String(ctx.from.id));
      return ctx.reply("Предварительный просмотр доступен только владельцу или действующему администратору клуба.");
    }
    if (!(await allowRequest(ctx, rateLimiter, "preview"))) return;
    const policyUrl = getPreviewPolicyUrl();
    if (!policyUrl) return ctx.reply("Для тестового экрана согласия нужна отдельная настройка PREVIEW_POLICY_URL: опубликуйте файл public/demo-policy.html на своей публичной HTTPS-странице и укажите её фактический адрес. Файл пока не опубликован; произвольную ссылку бот не подставляет.");
    let state = states.get(String(ctx.from.id));
    if (!state) {
      state = { step: "consent", consentNonce: crypto.randomBytes(16).toString("hex"), consentUrl: policyUrl, answers: {}, editing: false, awaitingReferralDetail: false };
      states.set(String(ctx.from.id), state);
    }
    if (state.step === "consent") {
      if (state.consentUrl !== policyUrl) {
        state.consentNonce = crypto.randomBytes(16).toString("hex");
        state.consentUrl = policyUrl;
      }
      const screen = consentScreen(policyUrl, state.consentNonce);
      const message = await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
      state.consentChatId = message.chat.id;
      state.consentMessageId = message.message_id;
      return message;
    }
    return state.step === "confirm" ? replySummary(ctx, state) : replyQuestion(ctx, state);
  });

  bot.callbackQuery(/^mpreview:(accept|decline):([a-f0-9]{32})$/, async (ctx) => {
    if (!isPrivateChat(ctx) || !ctx.from || String(ctx.chat?.id) !== String(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Предварительный просмотр доступен только в личном чате с ботом." });
    }
    if (!authorized(ctx)) {
      const revokedState = states.get(String(ctx.from.id));
      await removeConsentButtons(ctx);
      await removeStoredConsentButtons(ctx, revokedState);
      states.delete(String(ctx.from.id));
      return ctx.answerCallbackQuery({ text: "Доступ к предварительному просмотру отозван." });
    }
    const [, action, nonce] = ctx.match;
    const key = String(ctx.from.id);
    const state = states.get(key);
    const activeUrl = getPreviewPolicyUrl();
    if (!state || state.step !== "consent" || state.consentNonce !== nonce || state.consentUrl !== activeUrl) {
      return ctx.answerCallbackQuery({ text: "Кнопка устарела или уже обработана." });
    }
    if (action === "decline") {
      states.delete(key);
      await ctx.answerCallbackQuery({ text: "Предварительный просмотр завершён." });
      await removeConsentButtons(ctx);
      return ctx.reply("Предварительный просмотр отменён. Данные не сохранялись.\n\n" + mainMenuText, { reply_markup: mainMenuKeyboard });
    }
    const policyUrl = getPreviewPolicyUrl();
    if (!policyUrl) {
      states.delete(key);
      await ctx.answerCallbackQuery({ text: "Тестовая ссылка не настроена." });
      await removeConsentButtons(ctx);
      return ctx.reply("Экран не может продолжиться: настройте PREVIEW_POLICY_URL после публикации демонстрационной страницы по HTTPS.", { reply_markup: mainMenuKeyboard });
    }
    state.step = "first_name";
    state.consentNonce = null;
    state.consentUrl = null;
    state.consentChatId = null;
    state.consentMessageId = null;
    await ctx.answerCallbackQuery({ text: "Переходим к демонстрационным вопросам." });
    await removeConsentButtons(ctx);
    return replyQuestion(ctx, state);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !states.has(String(ctx.from.id))) return next();
    const input = ctx.message.text.trim();
    if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(input)) {
      await removeStoredConsentButtons(ctx, states.get(String(ctx.from.id)));
      states.delete(String(ctx.from.id));
      return next();
    }
    if (/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(input)) return next();
    if (!isPrivateChat(ctx)) return ctx.reply("Предварительный просмотр доступен только в личном чате с ботом.");
    if (!authorized(ctx)) {
      await removeStoredConsentButtons(ctx, states.get(String(ctx.from.id)));
      states.delete(String(ctx.from.id));
      return ctx.reply("Доступ к предварительному просмотру отозван.");
    }

    const key = String(ctx.from.id);
    const state = states.get(key);
    if (input === "🏠 Главное меню") {
      await removeStoredConsentButtons(ctx, state);
      states.delete(key);
      return next();
    }
    if (state.step === "consent") return ctx.reply("Сначала выберите «✅ Принимаю» или «❌ Отказываюсь» под демонстрационным экраном.");
    if (input === "🔗 Связанные аккаунты") return next();
    if (input === CANCEL || input === "❌ Отменить регистрацию" || input === "Отмена") {
      await removeStoredConsentButtons(ctx, state);
      states.delete(key);
      return ctx.reply("Предварительный просмотр отменён. Данные не сохранены.\n\n" + mainMenuText, { reply_markup: mainMenuKeyboard });
    }
    if (!(await allowRequest(ctx, rateLimiter, "preview_continue"))) return;

    // Команды навигации разбираются до значения текущего вопроса, иначе
    // «Назад» на шаге телефона будет ошибочно восприниматься как номер.
    if (input === "⬅️ Назад") {
      if (state.awaitingReferralDetail) {
        state.awaitingReferralDetail = false;
        return replyQuestion(ctx, state);
      }
      if (state.awaitingFieldSelection || state.editing) {
        state.awaitingFieldSelection = false;
        state.editing = false;
        state.step = "confirm";
        return replySummary(ctx, state);
      }
      const index = order.indexOf(state.step);
      if (index <= 0) return replyQuestion(ctx, state);
      state.step = order[index - 1];
      return replyQuestion(ctx, state);
    }

    if (state.step === "confirm") {
      if (input === "✅ Подтвердить регистрацию") {
        states.delete(key);
        return ctx.reply("Демонстрация успешно завершена. Регистрация не выполнена. Данные не сохранены.");
      }
      if (input === "✏️ Исправить данные") {
        state.awaitingFieldSelection = true;
        const keyboard = new Keyboard();
        for (const field of Object.keys(fieldNames)) keyboard.text(fieldNames[field]).row();
        return ctx.reply("Какое поле исправить?", { reply_markup: keyboard.text(CANCEL).resized() });
      }
      const selectedField = Object.keys(fieldNames).find((field) => fieldNames[field] === input);
      if (selectedField && state.awaitingFieldSelection) {
        state.step = selectedField;
        state.editing = true;
        state.awaitingFieldSelection = false;
        return replyQuestion(ctx, state);
      }
      return ctx.reply("Выберите подтверждение, исправление или отмену.");
    }

    if (state.step === "phone") {
      if (input !== TEST_PHONE_BUTTON) return ctx.reply("В демонстрации нельзя вводить или отправлять реальный номер. Нажмите кнопку «🧪 Использовать тестовый номер».", { reply_markup: questionKeyboard("phone") });
      state.answers.phone = TEST_PHONE;
    } else if (input === "Пропустить" && optional.has(state.step)) {
      try { state.answers[state.step] = validateFieldValue(state.step, null, state.answers); }
      catch (error) { return ctx.reply(error.message); }
    } else if (state.awaitingReferralDetail) {
      try { state.answers.referral_source = validateFieldValue("referral_source", input, state.answers); }
      catch (error) { return ctx.reply(error.message); }
      state.awaitingReferralDetail = false;
    } else if (state.step === "first_name" || state.step === "last_name") {
      try { state.answers[state.step] = validateFieldValue(state.step, input, state.answers); }
      catch (error) { return ctx.reply(error.message); }
    } else if (state.step === "city") {
      if (!input) return ctx.reply("Введите город или нажмите «Пропустить».");
      try { state.answers.city = validateFieldValue("city", input, state.answers); }
      catch (error) { return ctx.reply(error.message); }
    } else if (state.step === "email") {
      if (!input) return ctx.reply("Введите корректный email или нажмите «Пропустить».");
      try { state.answers.email = validateFieldValue("email", input, state.answers); }
      catch (error) { return ctx.reply(error.message); }
    } else if (state.step === "preferred_contact") {
      if (!values.preferred_contact.includes(input)) return ctx.reply("Выберите способ кнопкой.", { reply_markup: choicesKeyboard(state.step) });
      try { state.answers.preferred_contact = validateFieldValue("preferred_contact", input, state.answers); }
      catch (error) { return ctx.reply(`${error.message} Выберите способ кнопкой.`, { reply_markup: choicesKeyboard(state.step) }); }
    } else if (state.step === "referral_source") {
      if (input === "Другое") {
        state.awaitingReferralDetail = true;
        return ctx.reply("Напишите, пожалуйста, свой вариант.", { reply_markup: questionKeyboard(state.step) });
      }
      if (!values.referral_source.includes(input)) return ctx.reply("Выберите вариант кнопкой или нажмите «Пропустить».", { reply_markup: choicesKeyboard(state.step) });
      state.answers.referral_source = input === "Пропустить" ? null : input;
    } else if (state.editing) {
      const field = state.step;
      if (optional.has(field) && input === "Пропустить") state.answers[field] = null;
      else if (["first_name", "last_name"].includes(field) && (!input || input.length > 100)) return ctx.reply("Поле обязательно и должно быть не длиннее 100 символов.");
      else if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) return ctx.reply("Введите корректный email.");
      else if (field === "preferred_contact" && (!values.preferred_contact.includes(input) || input === "Электронная почта" && !state.answers.email)) return ctx.reply("Выберите доступный способ связи кнопкой.", { reply_markup: choicesKeyboard(field) });
      else if (field === "referral_source" && !values.referral_source.includes(input)) return ctx.reply("Выберите вариант кнопкой или введите ответ после «Другое».", { reply_markup: choicesKeyboard(field) });
      else state.answers[field] = input;
      state.editing = false;
      state.step = "confirm";
      return replySummary(ctx, state);
    } else {
      return ctx.reply("Ответ не распознан. Используйте кнопки или введите ответ на вопрос.");
    }

    if (state.editing) {
      state.editing = false;
      state.step = "confirm";
      return replySummary(ctx, state);
    }
    const index = order.indexOf(state.step);
    state.step = index === order.length - 1 ? "confirm" : order[index + 1];
    return state.step === "confirm" ? replySummary(ctx, state) : replyQuestion(ctx, state);
  });
  return () => states.stop();
}

module.exports = { registerRegistrationPreview, clearRegistrationPreviewSession, previewTestPhone: TEST_PHONE, getPreviewPolicyUrl, previewConsentScreen: consentScreen };

