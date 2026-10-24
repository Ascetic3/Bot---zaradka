const { Keyboard } = require("grammy");
const { isPrivateChat } = require("./chat-guards");
const { registrationFlow } = require("./registration");
const db = require("./database");
const { validateFieldValue } = require("./participant-service");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { ExpiringMap } = require("./expiring-map");

const TEST_PHONE = "+70000000000";
const CANCEL = "❌ Отмена";
const TEST_PHONE_BUTTON = "🧪 Использовать тестовый номер";
const states = new ExpiringMap(30 * 60_000);
const { prompts, order, optional, values, fieldNames } = registrationFlow;

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
  const authorized = (ctx) => isPrivateChat(ctx) && ctx.from && getRole(ctx.from.id) === "owner";

  bot.command("preview_registration", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Предварительный просмотр доступен только в личном чате с ботом.");
    if (!ctx.from || getRole(ctx.from.id) !== "owner") return ctx.reply("Предварительный просмотр доступен только владельцу клуба.");
    if (!(await allowRequest(ctx, rateLimiter, "preview"))) return;
    let state = states.get(String(ctx.from.id));
    if (!state) {
      state = { step: "first_name", answers: {}, editing: false, awaitingReferralDetail: false };
      states.set(String(ctx.from.id), state);
      await ctx.reply("Запущен демонстрационный режим. Ответы не сохраняются в базе данных.");
    }
    return state.step === "confirm" ? replySummary(ctx, state) : replyQuestion(ctx, state);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || !states.has(String(ctx.from.id))) return next();
    const input = ctx.message.text.trim();
    if (/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(input)) return next();
    if (!isPrivateChat(ctx)) return ctx.reply("Предварительный просмотр доступен только в личном чате с ботом.");
    if (getRole(ctx.from.id) !== "owner") {
      states.delete(String(ctx.from.id));
      return ctx.reply("Доступ к предварительному просмотру отозван.");
    }

    const key = String(ctx.from.id);
    const state = states.get(key);
    if (input === "🏠 Главное меню") {
      states.delete(key);
      return next();
    }
    if (input === "🔗 Связанные аккаунты") return next();
    if (input === CANCEL || input === "❌ Отменить регистрацию" || input === "Отмена") {
      states.delete(key);
      return ctx.reply("Предварительный просмотр отменён. Данные не сохранены.");
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

module.exports = { registerRegistrationPreview, previewTestPhone: TEST_PHONE };
