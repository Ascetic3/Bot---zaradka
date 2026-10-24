const { InlineKeyboard } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { registrationService } = require("./participant-service");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { mainMenuKeyboard, mainMenuText } = require("./main-menu");

const REQUEST_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const platformNames = Object.freeze({ telegram: "Telegram", max: "MAX" });
const statusNames = Object.freeze({
  pending: "Ожидает вашего решения",
  approved: "Вы одобрили запрос; ожидается подтверждение нового аккаунта",
  consumed: "Связывание завершено",
  rejected: "Вы отклонили запрос",
  cancelled: "Запрос отменён",
  expired: "Срок действия истёк"
});

function dateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Не указано" : date.toLocaleString("ru-RU", { timeZone: "UTC" });
}

function registerAccountLinks(bot, { rateLimiter = createRateLimiter() } = {}) {
  const assertPrivate = (ctx) => isPrivateChat(ctx) && Boolean(ctx.from?.id);

  async function render(ctx, notice = "", { edit = false, demoPreview = false } = {}) {
    if (!assertPrivate(ctx)) {
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: "Откройте личный чат с ботом." });
      return ctx.reply("Связанные аккаунты доступны только в личном чате с ботом.");
    }
    if (!(await allowRequest(ctx, rateLimiter, "account_links"))) return;
    const demoMode = String(process.env.DEMO_MODE).toLowerCase() === "true";
    if (demoMode) {
      const lines = demoPreview
        ? ["🔗 Безопасный пример связанных аккаунтов", "", "Только демонстрационные данные — база не меняется.", "Участник: DEMO-001", "Telegram: привязан (вымышленный пример)", "MAX: не привязан", "Запросы на связывание: нет"]
        : ["🔗 Связанные аккаунты", "", "Демонстрационный бот не связывает ваш личный Telegram-аккаунт с синтетическими анкетами.", "Это намеренная защита: реальные ID не записываются в вымышленные данные.", "Действия по связыванию отключены в демонстрационном режиме.", "Для проверки интерфейса можно открыть безопасный пример."];
      const keyboard = new InlineKeyboard()
        .text(demoPreview ? "↩️ Назад" : "🧪 Показать безопасный пример", demoPreview ? "link:list" : "link:demo-preview")
        .row().text("🏠 Главное меню", "link:menu");
      const text = `${notice ? `${notice}\n\n` : ""}${lines.join("\n")}`;
      if (edit) return ctx.editMessageText(text, { reply_markup: keyboard });
      return ctx.reply(text, { reply_markup: keyboard });
    }
    const participant = db.findParticipantByTelegramId(ctx.from.id);
    if (!participant) {
      const withdrawn = db.findParticipantByTelegramIdIncludingWithdrawn(ctx.from.id);
      const text = withdrawn
        ? "Доступ к анкете участника ограничен после отзыва согласия. Просмотр и новые действия по связыванию недоступны."
        : "Анкета участника не найдена: к этому Telegram-аккаунту не привязана анкета. Для защиты данные других участников не отображаются.";
      if (edit) return ctx.editMessageText(text);
      return ctx.reply(text);
    }

    const platforms = db.listLinkedPlatformsForTelegram(ctx.from.id)
      .map((platform) => platformNames[platform] || "Неизвестная платформа");
    const requests = db.listAccountLinkRequestsForTelegram(ctx.from.id, 10);
    const lines = [
      "🔗 Связанные аккаунты",
      `Подключены: ${platforms.length ? platforms.join(", ") : "Не указано"}`
    ];
    const keyboard = new InlineKeyboard();
    let actionable = 0;

    if (!requests.length) {
      lines.push("\nОжидающих запросов на привязку нет.");
    } else {
      lines.push("\nЗапросы на привязку:");
      for (const request of requests) {
        const platform = platformNames[request.target_platform];
        const expired = Date.parse(request.expires_at) <= Date.now();
        const state = expired && ["pending", "approved"].includes(request.state) ? "expired" : request.state;
        lines.push(`\n• Платформа: ${platform || "неизвестная"}`);
        lines.push(`  Статус: ${statusNames[state] || "Неизвестное состояние"}`);
        lines.push(`  Срок действия: ${dateTime(request.expires_at)}`);
        if (state === "approved" && request.target_platform === "max") {
          lines.push("  Окончательная привязка ожидает независимого подтверждения MAX; адаптер пока не подключён.");
        }
        if (state === "pending" && platform) {
          if (demoMode) {
            lines.push("  Решения по привязке выключены в демонстрационном режиме.");
          } else {
            keyboard.text(`✅ Подтвердить · ${actionable + 1}`, `link:prepare:approve:${request.request_id}`)
              .text(`❌ Отклонить · ${actionable + 1}`, `link:prepare:reject:${request.request_id}`).row();
            actionable += 1;
          }
        }
      }
      if (requests.length === 10) lines.push("\nПоказаны последние 10 запросов.");
    }
    if (actionable) keyboard.row();
    keyboard.text("🔄 Обновить", "link:list").text("🏠 Главное меню", "link:menu");
    const text = `${notice ? `${notice}\n\n` : ""}${lines.join("\n")}`;
    if (edit) return ctx.editMessageText(text, { reply_markup: keyboard });
    return ctx.reply(text, { reply_markup: keyboard });
  }

  bot.hears("🔗 Связанные аккаунты", async (ctx) => render(ctx));

  bot.callbackQuery(/^link:/, async (ctx) => {
    if (!assertPrivate(ctx)) {
      return ctx.answerCallbackQuery({ text: "Действие доступно только в личном чате с ботом." });
    }
    const data = ctx.callbackQuery.data;
    const valid = new RegExp(`^link:(?:list|menu|demo-preview|prepare:(?:approve|reject):${REQUEST_ID}|(?:approve|reject|cancel):${REQUEST_ID})$`, "i");
    if (!valid.test(data)) {
      await ctx.answerCallbackQuery({ text: "Кнопка недействительна. Обновите экран связанных аккаунтов." });
      return render(ctx, "Эта кнопка устарела или недействительна.", { edit: true });
    }
    await ctx.answerCallbackQuery();

    if (data === "link:menu") {
      await ctx.editMessageText("Вы вернулись в главное меню.", { reply_markup: { inline_keyboard: [] } });
      return ctx.reply(mainMenuText, { reply_markup: mainMenuKeyboard });
    }
    if (data === "link:list") return render(ctx, "", { edit: true });
    if (data === "link:demo-preview") return render(ctx, "", { edit: true, demoPreview: true });

    const parts = data.split(":");
    const action = parts.at(-2);
    const requestId = parts.at(-1);
    const request = db.getAccountLinkRequestForTelegram(requestId, ctx.from.id);
    if (!request) return render(ctx, "Запрос не найден, уже закрыт или не относится к вашему аккаунту.", { edit: true });
    if (!platformNames[request.target_platform]) {
      return render(ctx, "Платформа запроса не распознана. Подтверждать или отклонять его нельзя.", { edit: true });
    }

    if (parts[1] === "prepare") {
      if (request.state !== "pending" || Date.parse(request.expires_at) <= Date.now()) {
        return render(ctx, "Запрос уже завершён или срок его действия истёк.", { edit: true });
      }
      if (!db.findParticipantByTelegramId(ctx.from.id)) {
        return render(ctx, "Связанный Telegram-аккаунт больше не владеет действующей анкетой.", { edit: true });
      }
      const operation = parts[2];
      const title = operation === "approve" ? "подтвердить" : "отклонить";
      const keyboard = new InlineKeyboard()
        .text(operation === "approve" ? "✅ Да, подтвердить" : "❌ Да, отклонить", `link:${operation}:${requestId}`)
        .row().text("↩️ Вернуться", `link:cancel:${requestId}`);
      return ctx.editMessageText(
        `Подтвердите, что хотите ${title} запрос для платформы ${platformNames[request.target_platform]}.\n\n` +
        "Это действие будет записано и не сможет быть отменено.",
        { reply_markup: keyboard }
      );
    }

    if (action === "cancel") return render(ctx, "Операция отменена. Сам запрос не изменён.", { edit: true });

    if (!(await allowRequest(ctx, rateLimiter, "account_link_decision"))) return;
    try {
      // The service validates callback identity, private chat, ownership of the
      // existing Telegram account, request state, expiry and current consent.
      const result = action === "approve"
        ? registrationService.approveAccountLinkRequestFromTelegram(ctx, requestId)
        : registrationService.rejectAccountLinkRequestFromTelegram(ctx, requestId);
      const notices = {
        approved: "Запрос одобрен. Это ещё не привязало новый аккаунт: для этого требуется отдельное доверенное подтверждение.",
        rejected: "Запрос отклонён.",
        expired: "Срок действия запроса истёк. Он не был одобрен.",
        cancelled: "Запрос закрыт: согласие на обработку данных сейчас неактивно.",
        stale: "Анкета изменилась после создания запроса. Запрос закрыт.",
        pending: "Запрос уже ожидает решения.",
        not_found: "Запрос не найден или уже закрыт.",
        consumed: "Запрос уже использован.",
        already_consumed: "Запрос уже использован."
      };
      return render(ctx, notices[result.status] || "Состояние запроса изменилось. Обновите экран.", { edit: true });
    } catch (error) {
      const message = error.code === "DEMO_MODE_LINK_DISABLED"
        ? "В демонстрационном режиме решения по связыванию отключены."
        : error.code === "ACCOUNT_LINK_APPROVAL_INVALID"
          ? "Подтвердить этот запрос может только владелец анкеты через свой связанный Telegram-аккаунт."
          : "Не удалось обработать запрос. Обновите экран связанных аккаунтов.";
      return render(ctx, message, { edit: true });
    }
  });

  return () => rateLimiter.stop?.();
}

module.exports = { registerAccountLinks };
