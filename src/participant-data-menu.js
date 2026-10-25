const { InlineKeyboard, Keyboard } = require("grammy");
const database = require("./database");
const { createParticipantDataService } = require("./participant-data");
const { isPrivateChat } = require("./chat-guards");
const { createRateLimiter, allowRequest } = require("./request-limits");

const dataMenuKeyboard = new Keyboard()
  .text("Моя анкета").row()
  .text("🗑 Запросить удаление анкеты").row()
  .text("🚫 Отозвать согласие").row()
  .text("📄 Статус моих запросов").row()
  .text("🏠 Главное меню").resized();

function registerParticipantDataMenu(bot, { db = database, service = createParticipantDataService({ db }), rateLimiter = createRateLimiter(), demoMode = () => process.env.DEMO_MODE === "true" } = {}) {
  const actorId = (ctx) => String(ctx.from?.id ?? "");
  const privateOnly = (ctx) => isPrivateChat(ctx) && /^\d+$/.test(actorId(ctx));
  const statusLine = (label, value, requestedAt) => {
    if (!value) return `${label}: запросов нет`;
    const date = requestedAt && !Number.isNaN(new Date(requestedAt).getTime())
      ? new Date(requestedAt).toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "дата не указана";
    const state = value === "pending_review" ? "ожидает рассмотрения" : value === "processed" ? "обработан" : "не применимо";
    return `${label}: ${state} (${date})`;
  };
  const renderMenu = async (ctx, note = "") => {
    if (!privateOnly(ctx)) return ctx.reply("Раздел доступен только в личном чате с ботом.");
    const state = db.getParticipantDataRequestsForTelegram(actorId(ctx));
    if (!state) return ctx.reply("Анкета участника не найдена. Запросы можно посмотреть только для своего Telegram-аккаунта.", { reply_markup: dataMenuKeyboard });
    const consentActive = state.personal_data_consent === 1 && Boolean(state.consent_at && state.consent_version) && !state.consent_withdrawn_at;
    const guidance = consentActive
      ? "Согласие на обработку данных действует. Ваша анкета доступна по кнопке «Моя анкета»."
      : "Обработка анкеты по согласию приостановлена. Повторное согласие автоматически не создаётся.";
    return ctx.reply(`${note ? `${note}\n\n` : ""}🔐 Мои данные\n\n${guidance}\n\n${statusLine("Удаление анкеты", state.deletion_request_status, state.deletion_requested_at)}\n${statusLine("Отзыв согласия", state.consent_request_status, state.consent_requested_at)}`, { reply_markup: dataMenuKeyboard });
  };
  const removeInlineKeyboard = async (ctx) => {
    try { await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }); } catch {}
  };

  bot.hears("🔐 Мои данные", async (ctx) => {
    if (!privateOnly(ctx)) return ctx.reply("🔒 Управление персональными данными доступно только в личном чате с ботом.");
    if (!(await allowRequest(ctx, rateLimiter, "participant_data"))) return;
    return renderMenu(ctx);
  });

  bot.hears("🗑 Запросить удаление анкеты", async (ctx) => {
    if (!privateOnly(ctx)) return ctx.reply("Запрос удаления доступен только в личном чате с ботом.");
    if (!(await allowRequest(ctx, rateLimiter, "participant_data"))) return;
    if (demoMode() && !db.isDemoTestParticipantForTelegram(actorId(ctx))) return renderMenu(ctx, "В демонстрационном режиме запросы доступны только для специально созданных тестовых анкет.");
    const prepared = service.prepareOwnDeletionRequest(actorId(ctx));
    if (prepared.status === "not_found") return renderMenu(ctx, "Связанная с вашим Telegram аккаунтом анкета не найдена.");
    if (prepared.status === "already_requested") return renderMenu(ctx, "Запрос удаления уже получен и ожидает рассмотрения.");
    const keyboard = new InlineKeyboard()
      .text("Подтвердить запрос удаления", `pdata:delete:confirm:${prepared.confirmation_token}`)
      .row().text("Отмена", `pdata:cancel:${prepared.confirmation_token}`);
    return ctx.reply("Запрос удаления передаст обращение на рассмотрение оператору. Нажатие кнопки не удалит анкету немедленно. Правила сроков хранения и исполнения должны быть утверждены оператором. Подтвердить отправку запроса?", { reply_markup: keyboard });
  });

  bot.hears("🚫 Отозвать согласие", async (ctx) => {
    if (!privateOnly(ctx)) return ctx.reply("Отзыв согласия доступен только в личном чате с ботом.");
    if (!(await allowRequest(ctx, rateLimiter, "participant_data"))) return;
    if (demoMode() && !db.isDemoTestParticipantForTelegram(actorId(ctx))) return renderMenu(ctx, "В демонстрационном режиме отзыв доступен только для специально созданных тестовых анкет.");
    const prepared = service.prepareOwnConsentWithdrawal(actorId(ctx));
    if (prepared.status === "not_found") return renderMenu(ctx, "Связанная с вашим Telegram аккаунтом анкета не найдена.");
    if (prepared.status === "already_requested") return renderMenu(ctx, "Согласие уже отозвано. Обычная обработка анкеты ограничена.");
    if (prepared.status === "no_active_consent") return renderMenu(ctx, "Действующего согласия нет.");
    const keyboard = new InlineKeyboard()
      .text("Подтвердить отзыв согласия", `pdata:consent:confirm:${prepared.confirmation_token}`)
      .row().text("Отмена", `pdata:cancel:${prepared.confirmation_token}`);
    return ctx.reply("После подтверждения обычный доступ к анкете будет ограничен для всех связанных аккаунтов. Состояние запроса останется доступно в разделе «Мои данные». Подтвердить отзыв согласия?", { reply_markup: keyboard });
  });

  bot.hears("📄 Статус моих запросов", async (ctx) => {
    if (!privateOnly(ctx)) return ctx.reply("Статус запросов доступен только в личном чате с ботом.");
    if (!(await allowRequest(ctx, rateLimiter, "participant_data"))) return;
    const state = db.getParticipantDataRequestsForTelegram(actorId(ctx));
    if (!state) return renderMenu(ctx, "Анкета не найдена.");
    return renderMenu(ctx, "Текущий статус запросов отображён ниже.");
  });

  bot.callbackQuery(/^pdata:(?:delete:confirm|consent:confirm|cancel):([A-Za-z0-9_-]{20,64})$/, async (ctx) => {
    const token = ctx.match[1];
    const data = ctx.callbackQuery.data;
    const actor = String(ctx.callbackQuery.from?.id ?? "");
    if (!privateOnly(ctx) || actor !== actorId(ctx)) {
      await ctx.answerCallbackQuery({ text: "Действие доступно только владельцу запроса в личном чате." });
      return;
    }
    const confirmationStatus = service.getConfirmationStatus(actor, token);
    if (confirmationStatus === "other_user") {
      await ctx.answerCallbackQuery({ text: "Это подтверждение недоступно для вашего аккаунта." });
      return;
    }
    await ctx.answerCallbackQuery();
    if (data.startsWith("pdata:cancel:")) {
      service.cancelConfirmation(actor, token);
      await removeInlineKeyboard(ctx);
      return renderMenu(ctx, "Действие отменено. Никакие данные не изменены.");
    }
    if (!(await allowRequest(ctx, rateLimiter, "participant_data"))) {
      await removeInlineKeyboard(ctx);
      return renderMenu(ctx, "Слишком много запросов. Попробуйте немного позже.");
    }
    if (demoMode() && !db.isDemoTestParticipantForTelegram(actor)) {
      service.cancelConfirmation(actor, token);
      await removeInlineKeyboard(ctx);
      return renderMenu(ctx, "В демонстрационном режиме изменения синтетических анкет отключены.");
    }
    const result = data.startsWith("pdata:delete:confirm:")
      ? service.confirmOwnDeletionRequest(actor, token)
      : service.confirmOwnConsentWithdrawal(actor, token);
    await removeInlineKeyboard(ctx);
    const message = result.status === "received"
      ? data.startsWith("pdata:delete:") ? "Запрос удаления получен и будет рассмотрен оператором. Анкета не удалена автоматически." : "Согласие отозвано. Обычная обработка анкеты ограничена."
      : result.status === "already_requested" ? "Запрос уже существует. Повторно он не создан."
        : result.status === "stale_confirmation" ? "Состояние согласия изменилось. Откройте раздел «Мои данные» и проверьте статус."
          : "Подтверждение устарело или уже использовано. Операция не выполнена.";
    return renderMenu(ctx, message);
  });

  return () => service.stop();
}

module.exports = { registerParticipantDataMenu, dataMenuKeyboard };

