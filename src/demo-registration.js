const crypto = require("node:crypto");
const { Keyboard, InlineKeyboard } = require("grammy");
const database = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { registrationFlow } = require("./registration");
const { validateFieldValue, validateParticipantFields } = require("./participant-service");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { ExpiringMap } = require("./expiring-map");
const { classifyDatabasePath } = require("./database/config");
const { mainMenuKeyboard, mainMenuText } = require("./main-menu");
const { clearRegistrationPreviewSession } = require("./registration-preview");

const { prompts, order, optional, values, fieldNames } = registrationFlow;
const CANCEL = "❌ Отменить тестовую регистрацию";
const PHONE_ACTION = "🧪 Ввести тестовый номер";
const TEST_CONSENT_VERSION = "DEMO_TEST_ONLY_V1";
const extraActions = new Set(["/start", "/admin", "/myid", "/preview_registration", "Моя анкета", "🔐 Мои данные", "🏠 Главное меню", "🔗 Связанные аккаунты"]);

function createDemoRegistrationService({ db = database, envProvider = () => process.env, projectRoot = require("node:path").resolve(__dirname, ".."), now = () => new Date() } = {}) {
  const assertDemo = (actor) => {
    const env = envProvider();
    if (String(env.DEMO_MODE).toLowerCase() !== "true") throw Object.assign(new Error("Тестовая регистрация доступна только в DEMO_MODE."), { code: "DEMO_MODE_REQUIRED" });
    let kind;
    try { kind = classifyDatabasePath(db.dbPath, { demoMode: env.DEMO_MODE, projectRoot }); }
    catch { throw Object.assign(new Error("Тестовая регистрация остановлена: подключение не указывает на demo.sqlite."), { code: "DEMO_DATABASE_MISMATCH" }); }
    if (kind !== "demo") throw Object.assign(new Error("Тестовая регистрация остановлена: подключение к демобазе не подтверждено."), { code: "DEMO_DATABASE_MISMATCH" });
    if (!actor || !new Set(["owner", "admin"]).has(db.getAdminRole(actor))) throw Object.assign(new Error("Тестовая регистрация доступна только действующему администратору."), { code: "DEMO_ADMIN_REQUIRED" });
  };
  return {
    assertAccess(actor) { assertDemo(String(actor ?? "")); },
    save(answers, actor) {
      const actorId = String(actor ?? "");
      assertDemo(actorId);
      const fields = validateParticipantFields(answers);
      const phone = db.normalizePhone(answers.phone);
      if (!/^\+7000000\d{4}$/.test(phone)) throw Object.assign(new Error("Разрешён только вымышленный тестовый номер формата +7000000XXXX."), { code: "DEMO_TEST_PHONE_INVALID" });
      return db.createDemoTestParticipant({ ...fields, phone, consent_at: now().toISOString(), consent_version: TEST_CONSENT_VERSION }, actorId, { projectRoot });
    }
  };
}

function registerDemoRegistration(bot, { db = database, service = createDemoRegistrationService({ db }), rateLimiter = createRateLimiter(), sessions = new ExpiringMap(30 * 60_000) } = {}) {
  const privateAdmin = (ctx) => isPrivateChat(ctx) && ctx.from && String(ctx.chat?.id) === String(ctx.from.id) && Boolean(db.getAdminRole(ctx.from.id));
  const keyOf = (ctx) => String(ctx.from.id);
  const cleanups = [];
  const keyboardFor = (step) => {
    const keyboard = new Keyboard();
    if (step === "phone") keyboard.text(PHONE_ACTION).row();
    if (optional.has(step)) keyboard.text("Пропустить").row();
    if (order.indexOf(step) > 0) keyboard.text("⬅️ Назад").row();
    return keyboard.text(CANCEL).resized();
  };
  const choices = (step) => {
    const keyboard = new Keyboard();
    for (const value of values[step]) keyboard.text(value).row();
    if (order.indexOf(step) > 0) keyboard.text("⬅️ Назад").row();
    return keyboard.text(CANCEL).resized();
  };
  const ask = (ctx, state) => {
    const keyboard = state.step === "preferred_contact" || state.step === "referral_source" ? choices(state.step) : keyboardFor(state.step);
    if (state.editing && optional.has(state.step)) keyboard.text("Очистить поле").row();
    const prompt = state.step === "phone" ? `${prompts.phone}\nВ деморежиме введите только вымышленный номер диапазона +7000000XXXX; не отправляйте настоящий контакт.` : prompts[state.step];
    return ctx.reply(prompt, { reply_markup: keyboard });
  };
  const summary = (answers) => `🧪 Тестовая анкета деморежима\n\nИмя: ${answers.first_name}\nФамилия: ${answers.last_name}\nТелефон: ${answers.phone}\nГород: ${answers.city || "Не указано"}\nEmail: ${answers.email || "Не указано"}\nПредпочтительный способ связи: ${answers.preferred_contact}\nОткуда узнали о клубе: ${answers.referral_source || "Не указано"}\n\nТестовые ответы сохранятся только в demo.sqlite.`;
  const showSummary = (ctx, state) => ctx.reply(summary(state.answers), { reply_markup: new Keyboard().text("✅ Подтвердить тестовую регистрацию").row().text("✏️ Исправить данные").row().text(CANCEL).resized() });
  const clearConsentKeyboard = async (ctx, state) => {
    try {
      if (state?.consentChatId && state?.consentMessageId) await ctx.api.editMessageReplyMarkup({ chat_id: state.consentChatId, message_id: state.consentMessageId, reply_markup: { inline_keyboard: [] } });
      else if (ctx.callbackQuery?.message) await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch { /* старое сообщение уже недоступно; состояние всё равно остаётся недействительным */ }
  };
  const answerToQuestion = (ctx, state, value) => {
    const field = state.step;
    if (field === "phone") {
      if (value === PHONE_ACTION) return ctx.reply("Введите вымышленный номер из диапазона +7000000XXXX, например +70000001234. Не вводите свой настоящий телефон.", { reply_markup: keyboardFor(field) });
      try {
        const phone = db.normalizePhone(value);
        if (!/^\+7000000\d{4}$/.test(phone)) throw new Error();
        state.answers.phone = phone;
      } catch { return ctx.reply("Нужен вымышленный тестовый номер вида +70000001234 (только диапазон +7000000XXXX).", { reply_markup: keyboardFor(field) }); }
    } else if (value === "Пропустить" && optional.has(field)) {
      try { state.answers[field] = validateFieldValue(field, null, state.answers); } catch (error) { return ctx.reply(error.message); }
    } else if (state.awaitingOther) {
      try { state.answers.referral_source = validateFieldValue("referral_source", value, state.answers); }
      catch (error) { return ctx.reply(error.message, { reply_markup: keyboardFor(field) }); }
      state.awaitingOther = false;
    } else if (field === "preferred_contact" || field === "referral_source") {
      if (field === "referral_source" && value === "Другое") { state.awaitingOther = true; return ctx.reply("Напишите свой вариант:", { reply_markup: keyboardFor(field) }); }
      if (!values[field].includes(value)) return ctx.reply("Выберите вариант кнопкой.", { reply_markup: choices(field) });
      try { state.answers[field] = field === "referral_source" && value === "Пропустить" ? null : validateFieldValue(field, value, state.answers); }
      catch (error) { return ctx.reply(error.message, { reply_markup: choices(field) }); }
    } else {
      const targetField = state.awaitingOther ? "referral_source" : field;
      try { state.answers[targetField] = validateFieldValue(targetField, value, state.answers); }
      catch (error) { return ctx.reply(error.message, { reply_markup: keyboardFor(field) }); }
      state.awaitingOther = false;
    }
    if (state.editing) { state.editing = false; state.step = "confirm"; return showSummary(ctx, state); }
    const index = order.indexOf(state.step);
    state.step = index === order.length - 1 ? "confirm" : order[index + 1];
    return state.step === "confirm" ? showSummary(ctx, state) : ask(ctx, state);
  };

  bot.command("demo_registration", async (ctx) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Тестовая регистрация доступна только в личном чате.");
    if (String(process.env.DEMO_MODE).toLowerCase() !== "true") return ctx.reply("Тестовая регистрация доступна только в демонстрационном режиме.");
    try { service.assertAccess(ctx.from.id); }
    catch (error) {
      if (error.code === "DEMO_ADMIN_REQUIRED") return ctx.reply("Команда доступна только владельцу и действующим администраторам.");
      return ctx.reply("Команда недоступна: подключение к demo.sqlite не подтверждено.");
    }
    if (!(await allowRequest(ctx, rateLimiter, "demo_registration_start"))) return;
    await clearRegistrationPreviewSession(ctx.from.id, ctx);
    if (db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id)) return ctx.reply("Этот Telegram-аккаунт уже связан с анкетой. Используйте «Моя анкета».");
    const id = keyOf(ctx);
    const state = { step: "consent", answers: {}, nonce: crypto.randomBytes(16).toString("hex") };
    sessions.set(id, state);
    const consentMessage = await ctx.reply("<b>🧪 Тестовое согласие в деморежиме</b>\n\nДля проверки интерфейса можно продолжить тестовую регистрацию. Данные и тестовое согласие сохранятся только в demo.sqlite и будут отмечены как тестовые. Это не настоящее юридическое согласие.\n\nВыберите действие:", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("✅ Принимаю", `dreg:accept:${state.nonce}`).row().text("❌ Отказываюсь", `dreg:decline:${state.nonce}`) });
    state.consentChatId = consentMessage.chat.id; state.consentMessageId = consentMessage.message_id;
    return consentMessage;
  });

  bot.command("preview_registration", async (ctx, next) => {
    if (isPrivateChat(ctx) && ctx.from) {
      const state = sessions.get(keyOf(ctx));
      await clearConsentKeyboard(ctx, state);
      sessions.delete(keyOf(ctx));
    }
    return next();
  });

  bot.callbackQuery(/^dreg:(accept|decline):([a-f0-9]{32})$/, async (ctx) => {
    const id = String(ctx.from?.id ?? "");
    if (!isPrivateChat(ctx) || String(ctx.chat?.id) !== id) return ctx.answerCallbackQuery({ text: "Доступно только в личном чате." });
    const state = sessions.get(id);
    try { service.assertAccess(id); } catch { await clearConsentKeyboard(ctx, state); sessions.delete(id); return ctx.answerCallbackQuery({ text: "Доступ к деморежиму закрыт." }); }
    if (!privateAdmin(ctx) || !state || state.step !== "consent" || state.nonce !== ctx.match[2]) return ctx.answerCallbackQuery({ text: "Доступ закрыт или кнопка устарела." });
    await ctx.answerCallbackQuery();
    await clearConsentKeyboard(ctx, state);
    if (ctx.match[1] === "decline") { sessions.delete(id); return ctx.reply("Тестовая регистрация отменена. Данные не сохранялись.\n\n" + mainMenuText, { reply_markup: mainMenuKeyboard }); }
    state.step = order[0]; state.nonce = null;
    return ask(ctx, state);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from) return next();
    const text = ctx.message.text.trim();
    const id = keyOf(ctx);
    const state = sessions.get(id);
    if (!state) return next();
    if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)) { await clearConsentKeyboard(ctx, state); sessions.delete(id); return next(); }
    if (/^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text)) return next();
    if (!isPrivateChat(ctx)) return ctx.reply("Тестовая регистрация доступна только в личном чате.");
    try { service.assertAccess(id); } catch { sessions.delete(id); return ctx.reply("Деморежим или доступ администратора завершён."); }
    if (!privateAdmin(ctx)) { sessions.delete(id); return ctx.reply("Доступ к тестовой регистрации отозван."); }
    if (extraActions.has(text)) { sessions.delete(id); return next(); }
    if (text === CANCEL || text === "Отмена") { await clearConsentKeyboard(ctx, state); sessions.delete(id); return ctx.reply("Тестовая регистрация отменена. Ответы не сохранены.\n\n" + mainMenuText, { reply_markup: mainMenuKeyboard }); }
    if (!(await allowRequest(ctx, rateLimiter, "demo_registration_continue"))) return;
    if (state.step === "consent") return ctx.reply("Используйте кнопки тестового согласия под сообщением.");
    if (text === "⬅️ Назад") {
      if (state.awaitingOther) { state.awaitingOther = false; return ask(ctx, state); }
      if (state.editing) { state.editing = false; state.awaitingField = false; state.step = "confirm"; return showSummary(ctx, state); }
      const index = order.indexOf(state.step);
      state.step = order[Math.max(0, index - 1)];
      return ask(ctx, state);
    }
    if (state.step === "confirm") {
      if (state.awaitingField) {
        const selected = Object.keys(fieldNames).find((field) => fieldNames[field] === text);
        if (!selected || selected === "phone") return ctx.reply("Выберите доступное поле кнопкой. Тестовый телефон можно изменить только до подтверждения.");
        state.step = selected; state.editing = true; state.awaitingField = false;
        return ask(ctx, state);
      }
      if (text === "✏️ Исправить данные") {
        const keyboard = new Keyboard();
        for (const field of Object.keys(fieldNames).filter((item) => item !== "phone")) keyboard.text(fieldNames[field]).row();
        return ctx.reply("Выберите поле для исправления:", { reply_markup: keyboard.text(CANCEL).resized() }).then(() => { state.awaitingField = true; });
      }
      if (text !== "✅ Подтвердить тестовую регистрацию") return ctx.reply("Выберите подтверждение, исправление или отмену.");
      try {
        const result = service.save(state.answers, id);
        sessions.delete(id);
        const message = result.status === "created" ? "✅ Тестовая регистрация сохранена только в demo.sqlite. Это тестовая анкета, не реальная регистрация." : result.status === "phone_already_registered" ? "Этот тестовый номер уже используется в демобазе. Анкета не создана." : "Этот Telegram-аккаунт уже связан с анкетой. Дубликат не создан.";
        return ctx.reply(message, { reply_markup: new Keyboard().text("Моя анкета").row().text("🔐 Мои данные").row().text("🏠 Главное меню").resized() });
      } catch (error) { sessions.delete(id); return ctx.reply(error.code === "DEMO_DATABASE_MISMATCH" ? "Запись остановлена: подключение к demo.sqlite не подтверждено." : "Не удалось сохранить тестовую анкету. Проверьте данные и попробуйте снова."); }
    }
    if (state.editing && state.step === "referral_source" && text === "Другое") {
      state.awaitingOther = true;
      return ctx.reply("Напишите свой вариант:", { reply_markup: keyboardFor(state.step) });
    }
    if (state.editing) {
      const field = state.step;
      const raw = text === "Очистить поле" && optional.has(field) ? null : text;
      try { state.answers[field] = validateFieldValue(field, raw, state.answers); }
      catch (error) { return ctx.reply(error.message, { reply_markup: keyboardFor(field) }); }
      state.awaitingOther = false; state.editing = false; state.step = "confirm"; return showSummary(ctx, state);
    }
    if (text === "Очистить поле" && optional.has(state.step)) return answerToQuestion(ctx, state, "Пропустить");
    return answerToQuestion(ctx, state, text);
  });

  return () => { sessions.stop(); for (const cleanup of cleanups) cleanup?.(); };
}

module.exports = { registerDemoRegistration, createDemoRegistrationService, TEST_CONSENT_VERSION };

