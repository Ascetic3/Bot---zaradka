const { Keyboard, InlineKeyboard, InputFile } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { createParticipantsWorkbook, getExportFilename } = require("./excel-export");
const { createRateLimiter, allowRequest } = require("./request-limits");
const { clearMeetingBroadcastState } = require("./meeting-broadcasts");
const { ExpiringMap } = require("./expiring-map");
const pending = new ExpiringMap(30 * 60_000);
const participantViews = new ExpiringMap(30 * 60_000);
const exportConfirmations = new ExpiringMap(10 * 60_000);
// Храним короткий маркер, чтобы распознать сообщения со старой Excel-клавиатуры
// после истечения основного десятиминутного подтверждения.
const exportPrompts = new ExpiringMap(24 * 60 * 60_000);
const demoDeletionReviews = new ExpiringMap(10 * 60_000);
const usernameMiddlewareRegistered = new WeakSet();
const demoBanner = () => process.env.DEMO_MODE === "true" ? "🧪 Демонстрационный режим. Данные вымышленные\n\n" : "";
const ownerMenu = new Keyboard().text("🔎 Найти участника").row().text("👥 Все участники").row().text("📊 Статистика").row().text("📥 Скачать Excel").row().text("📋 Запросы участников").row().text("📅 Встречи и рассылки").row().text("⚙️ Управление администраторами").row().text("🏠 Главное меню").resized();
const adminMenu = new Keyboard().text("🔎 Найти участника").row().text("👥 Все участники").row().text("📊 Статистика").row().text("📥 Скачать Excel").row().text("📋 Запросы участников").row().text("📅 Встречи и рассылки").row().text("🏠 Главное меню").resized();
const managementMenu = new Keyboard().text("📋 Список администраторов").row().text("➕ Добавить администратора").row().text("➖ Удалить администратора").row().text("⬅️ В меню администратора").resized();
const privateChat = isPrivateChat;
const role = (ctx) => privateChat(ctx) ? db.getAdminRole(ctx.from.id) : null;
const replyAdminMenu = (ctx, text = `${demoBanner()}Административное меню:`) => {
  const currentRole = role(ctx);
  return ctx.reply(text, { reply_markup: currentRole === "owner" ? ownerMenu : adminMenu });
};
const showAdminMenu = (ctx) => {
  if (ctx.from) clearAdminFlow(String(ctx.from.id));
  return replyAdminMenu(ctx);
};
const clearAdminFlow = (id) => {
  clearMeetingBroadcastState(id);
  participantViews.delete(id);
  pending.delete(id);
  exportConfirmations.delete(id);
  exportPrompts.delete(id);
};
const setAdminFlow = (id, kind, state) => {
  clearAdminFlow(id);
  const target = { view: participantViews, pending, export: exportConfirmations }[kind];
  if (!target) throw new Error("Неизвестное административное состояние.");
  target.set(id, state);
};
const shortText = (value, max = 40) => String(value ?? "Не указано").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Не указано";
const fullParticipantText = (p) => {
  const value = (v, max = 150) => shortText(v, max);
  const date = p.registered_at && !Number.isNaN(new Date(p.registered_at).getTime()) ? new Date(p.registered_at).toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "Не указано";
  const demoTag = String(process.env.DEMO_MODE).toLowerCase() === "true" && db.isDemoTestParticipant(p.id) ? "🧪 ТЕСТОВАЯ АНКЕТА ДЕМОРЕЖИМА\n\n" : "";
  return `${demoTag}Анкета участника:\n\nИмя: ${value(p.first_name, 100)}\nФамилия: ${value(p.last_name, 100)}\nТелефон: ${value(p.phone, 32)}\nГород: ${value(p.city)}\nEmail: ${value(p.email)}\nПредпочтительный способ связи: ${value(p.preferred_contact, 80)}\nОткуда узнали о клубе: ${value(p.referral_source)}\nДата регистрации: ${date}`;
};
const participantButton = (p) => `${String(process.env.DEMO_MODE).toLowerCase() === "true" && db.isDemoTestParticipant(p.id) ? "🧪" : "👤"} ${p.id}: ${shortText(p.first_name, 20)} ${shortText(p.last_name, 20)}`;
const statisticsKeyboard = new Keyboard().text("🔄 Обновить статистику").row().text("⬅️ Админ-меню").resized();
function formatDistribution(rows) {
  // Категория может быть создана из пользовательского текста в SQLite.
  // Сокращаем только вывод: исходное значение в базе остаётся неизменным.
  return rows.map(({ category, count }) => `• ${shortText(category, 80)}: ${count}`).join("\n");
}
function registerAdminUsernameRefresh(bot) {
  if (usernameMiddlewareRegistered.has(bot)) return;
  usernameMiddlewareRegistered.add(bot);
  bot.use(async (ctx, next) => {
    if (ctx.from) db.updateAdminUsername(ctx.from.id, ctx.from.username ?? null);
    return next();
  });
}
function registerAdmin(bot, { rateLimiter = createRateLimiter(), demoProjectRoot } = {}) {
  let activeExports = 0;
  registerAdminUsernameRefresh(bot);
  // Любая команда завершает ожидавшийся административный ввод, прежде чем
  // управление перейдёт к обработчику команды (например, /start или /myid).
  bot.use(async (ctx, next) => {
    if (ctx.from && isPrivateChat(ctx) && /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(ctx.message?.text?.trim() || "")) {
      clearAdminFlow(String(ctx.from.id));
    }
    return next();
  });
  db.initializeOwner(process.env.OWNER_TELEGRAM_ID);
  bot.command("admin", async (ctx) => {
    if (ctx.from) clearAdminFlow(String(ctx.from.id));
    if (!privateChat(ctx)) return ctx.reply("Административная команда доступна только в личном чате с ботом.");
    if (!(await allowRequest(ctx, rateLimiter, "command_admin"))) return;
    const currentRole = role(ctx);
    if (!currentRole) return ctx.reply("У вас нет доступа к административному меню.");
    return showAdminMenu(ctx);
  });
  bot.hears("📅 Встречи и рассылки", async (ctx, next) => {
    if (!privateChat(ctx)) return ctx.reply("Административные функции доступны только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к административным функциям.");
    clearAdminFlow(String(ctx.from.id));
    return next();
  });
  bot.hears("🔎 Найти участника", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Поиск доступен только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к поиску участников.");
    const id = String(ctx.from.id); setAdminFlow(id, "view", { mode: "search" });
    return ctx.reply("Введите имя, фамилию или полный номер телефона:", { reply_markup: new Keyboard().text("Отмена").resized() });
  });
  const renderParticipantsPage = async (ctx, page) => {
    if (!privateChat(ctx)) return ctx.reply("Список доступен только в личном чате с ботом.");
    if (!role(ctx)) { clearAdminFlow(String(ctx.from.id)); return ctx.reply("У вас нет доступа к списку участников."); }
    if (!(await allowRequest(ctx, rateLimiter, "admin_page"))) return;
    const id = String(ctx.from.id), offset = page * 10;
    const rows = db.listParticipants(10, offset);
    setAdminFlow(id, "view", { mode: "page", page, selectable: new Map(rows.map((p) => [participantButton(p), p.id])) });
    if (!rows.length) return ctx.reply(page === 0 ? "Пока нет зарегистрированных участников." : "На этой странице участников нет.", { reply_markup: new Keyboard().text("⬅️ Назад").row().text("🏠 Админ-меню").resized() });
    const keyboard = new Keyboard();
    for (const p of rows) keyboard.text(participantButton(p)).row();
    if (page > 0) keyboard.text("⬅️ Назад");
    if (rows.length === 10) keyboard.text("➡️ Далее");
    keyboard.row().text("🏠 Админ-меню").resized();
    const body = rows.map((p) => `${shortText(p.first_name, 40)} ${shortText(p.last_name, 40)} · ${shortText(p.city || "город не указан", 40)} · ${new Date(p.registered_at).toLocaleDateString("ru-RU", { timeZone: "UTC" })}`).join("\n");
    return ctx.reply(`Участники, страница ${page + 1}:\n\n${body}\n\nВыберите участника кнопкой.`, { reply_markup: keyboard });
  };
  const renderSearchPage = async (ctx, query, page) => {
    if (!privateChat(ctx)) return ctx.reply("Поиск доступен только в личном чате с ботом.");
    if (!role(ctx)) { clearAdminFlow(String(ctx.from.id)); return ctx.reply("Доступ к поиску отозван."); }
    if (!(await allowRequest(ctx, rateLimiter, page === 0 ? "admin_search" : "admin_page"))) return;
    const id = String(ctx.from.id);
    const batch = db.searchParticipants(query, 11, page * 10);
    if (!batch.length) {
      setAdminFlow(id, "view", { mode: "search_results", query, page, selectable: new Map() });
      return ctx.reply("Ничего не найдено. Попробуйте другой запрос или нажмите «Отмена».", { reply_markup: new Keyboard().text("Отмена").resized() });
    }
    const rows = batch.slice(0, 10);
    const selectable = new Map(rows.map((p) => [participantButton(p), p.id]));
    setAdminFlow(id, "view", { mode: "search_results", query, page, selectable });
    const keyboard = new Keyboard();
    for (const label of selectable.keys()) keyboard.text(label).row();
    if (page > 0) keyboard.text("⬅️ Назад");
    if (batch.length > 10) keyboard.text("➡️ Далее");
    keyboard.row().text("Отмена").resized();
    const body = rows.map((p) => `${shortText(p.first_name, 40)} ${shortText(p.last_name, 40)} · ${shortText(p.phone, 24)}`).join("\n");
    return ctx.reply(`Результаты поиска, страница ${page + 1}:\n\n${body}\n\nВыберите участника кнопкой.`, { reply_markup: keyboard });
  };
  bot.hears("👥 Все участники", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Список доступен только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к списку участников.");
    clearAdminFlow(String(ctx.from.id));
    return renderParticipantsPage(ctx, 0);
  });
  const managementButton = "⚙️ Управление администраторами";
  bot.hears(managementButton, async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Управление доступно только в личном чате с ботом.");
    if (role(ctx) !== "owner") return ctx.reply("Только владелец может управлять администраторами.");
    clearAdminFlow(String(ctx.from.id));
    return ctx.reply("Управление администраторами:", { reply_markup: managementMenu });
  });
  bot.hears("📋 Список администраторов", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    clearAdminFlow(String(ctx.from.id));
    const list = db.listAdmins().map((a) => `${a.role === "owner" ? "👑 Владелец" : "🛡 Администратор"}\nID: ${a.telegram_id}\nTelegram: ${a.username ? `@${a.username.replace(/^@/, "")}` : "Ник не указан"}`).join("\n\n");
    return ctx.reply(list || "Список администраторов пуст.");
  });
  bot.hears("➕ Добавить администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    const id = String(ctx.from.id); setAdminFlow(id, "pending", "add");
    return ctx.reply("Отправьте Telegram ID нового администратора (только цифры). Для отмены напишите «Отмена».");
  });
  bot.hears("➖ Удалить администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    const id = String(ctx.from.id); setAdminFlow(id, "pending", "remove");
    return ctx.reply("Отправьте Telegram ID администратора для удаления. Владелец удалить себя не может. Для отмены напишите «Отмена».");
  });
  bot.hears("⬅️ В меню администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа.");
    return showAdminMenu(ctx);
  });
  bot.hears("🏠 Главное меню", async (ctx, next) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    // Сбросить любое ожидающее административное действие и передать кнопку
    // пользовательскому обработчику меню, зарегистрированному ниже.
    clearAdminFlow(String(ctx.from.id));
    return next();
  });
  bot.hears("🔗 Связанные аккаунты", async (ctx, next) => {
    if (!privateChat(ctx)) return next();
    clearAdminFlow(String(ctx.from.id));
    return next();
  });
  bot.hears("🔐 Мои данные", async (ctx, next) => {
    if (!privateChat(ctx)) return next();
    clearAdminFlow(String(ctx.from.id));
    return next();
  });
  const showStatistics = async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Статистика доступна только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к статистике.");
    if (!(await allowRequest(ctx, rateLimiter, "statistics"))) return;
    clearAdminFlow(String(ctx.from.id));
    const stats = db.getParticipantStatistics();
    const emptyNote = stats.total === 0 ? "Пока нет зарегистрированных участников. Все показатели равны нулю.\n\n" : "";
    const message = `${emptyNote}📊 Статистика клуба «Магия утра»\n\n` +
      `Всего участников: ${stats.total}\n` +
      `Регистраций за 7 дней: ${stats.last_7_days}\n` +
      `Регистраций за 30 дней: ${stats.last_30_days}\n\n` +
      `По городам:\n${formatDistribution(stats.cities)}\n\n` +
      `По источникам знакомства:\n${formatDistribution(stats.referral_sources)}\n\n` +
      `По способу связи:\n${formatDistribution(stats.preferred_contacts)}`;
    return ctx.reply(message, { reply_markup: statisticsKeyboard });
  };
  bot.hears("📊 Статистика", showStatistics);
  bot.hears("🔄 Обновить статистику", showStatistics);
  bot.hears("⬅️ Админ-меню", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Административные функции доступны только в личном чате.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к административному меню.");
    return showAdminMenu(ctx);
  });
  const renderParticipantDataRequestsPage = async (ctx, page = 0) => {
    if (!privateChat(ctx)) return ctx.reply("Запросы участников доступны только в личном чате с ботом.");
    if (!role(ctx)) { clearAdminFlow(String(ctx.from.id)); return ctx.reply("У вас нет доступа к запросам участников."); }
    if (!(await allowRequest(ctx, rateLimiter, "admin_page"))) return;
    const total = db.getParticipantDataRequestCount();
    const pageCount = Math.max(1, Math.ceil(total / 10));
    const currentPage = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pageCount - 1);
    const requests = db.listParticipantDataRequests(11, currentPage * 10);
    const visible = requests.slice(0, 10);
    setAdminFlow(String(ctx.from.id), "view", { mode: "data_requests", page: currentPage });
    const keyboard = new Keyboard();
    if (currentPage > 0) keyboard.text("⬅️ Предыдущие запросы");
    if (requests.length > 10) keyboard.text("➡️ Следующие запросы");
    if (currentPage > 0 || requests.length > 10) keyboard.row();
    keyboard.text("⬅️ Админ-меню").resized();
    if (!visible.length) {
      return ctx.reply("Запросов участников пока нет.", { reply_markup: keyboard });
    }
    const kind = (value) => value === "deletion" ? "Удаление анкеты" : "Отзыв согласия";
    const status = (value) => value === "pending_review" ? "ожидает рассмотрения" : value === "processed" ? "обработан" : "не применимо";
    const items = visible.map((request, index) => `${currentPage * 10 + index + 1}. ${kind(request.request_type)} · ${status(request.status)} · ${new Date(request.requested_at).toLocaleDateString("ru-RU", { timeZone: "UTC" })}`).join("\n");
    const demoRequests = String(process.env.DEMO_MODE).toLowerCase() === "true" ? db.listDemoTestDeletionRequests(10) : [];
    const mainMessage = await ctx.reply(`📋 Запросы участников · страница ${currentPage + 1} из ${pageCount}\n\n${items}\n\nЗдесь показаны только тип, статус и дата. Решение о сроках хранения и исполнении обычных запросов пока не настроено.${demoRequests.length ? "\n\n🧪 Тестовые анкеты деморежима можно удалить отдельно после подтверждения владельцем или администратором." : ""}`, { reply_markup: keyboard });
    if (!demoRequests.length) return mainMessage;
    const inline = new InlineKeyboard();
    for (const request of demoRequests) inline.text(`🧪 Рассмотреть тестовую анкету #${request.participant_id}`, `dtest:review:${request.participant_id}`).row();
    await ctx.reply("Запросы на удаление тестовых анкет:", { reply_markup: inline });
    return mainMessage;
  };
  bot.callbackQuery(/^dtest:review:(\d{1,12})$/, async (ctx) => {
    const id = String(ctx.from?.id ?? "");
    if (!privateChat(ctx) || !role(ctx) || String(ctx.chat?.id) !== id || String(process.env.DEMO_MODE).toLowerCase() !== "true") return ctx.answerCallbackQuery({ text: "Действие недоступно." });
    const participantId = Number(ctx.match[1]);
    const request = db.listDemoTestDeletionRequests(100).find((item) => item.participant_id === participantId);
    if (!request) return ctx.answerCallbackQuery({ text: "Запрос устарел или уже обработан." });
    demoDeletionReviews.set(id, { participantId, requestId: request.request_id });
    await ctx.answerCallbackQuery();
    return ctx.reply(`Подтвердите фактическое удаление специально помеченной тестовой анкеты #${participantId}. Исходные 150 записей генератора удалить нельзя.`, { reply_markup: new InlineKeyboard().text("🗑 Удалить тестовую анкету", `dtest:confirm:${participantId}`).row().text("Отмена", `dtest:cancel:${participantId}`) });
  });
  bot.callbackQuery(/^dtest:(confirm|cancel):(\d{1,12})$/, async (ctx) => {
    const actor = String(ctx.from?.id ?? "");
    if (!privateChat(ctx) || !role(ctx) || String(ctx.chat?.id) !== actor || String(process.env.DEMO_MODE).toLowerCase() !== "true") return ctx.answerCallbackQuery({ text: "Действие недоступно." });
    const pendingReview = demoDeletionReviews.get(actor);
    const participantId = Number(ctx.match[2]);
    if (!pendingReview || pendingReview.participantId !== participantId) return ctx.answerCallbackQuery({ text: "Подтверждение устарело." });
    await ctx.answerCallbackQuery();
    demoDeletionReviews.delete(actor);
    try {
      const finish = (text) => ctx.editMessageText(text, { reply_markup: { inline_keyboard: [] } });
      if (ctx.match[1] === "cancel") return finish("Удаление отменено. Тестовая анкета сохранена.");
      const request = db.listDemoTestDeletionRequests(100).find((item) => item.participant_id === participantId && item.request_id === pendingReview.requestId);
      if (!request) return finish("Запрос уже обработан или устарел. Ничего не удалено.");
      if (!role(ctx)) return finish("Административные права отозваны. Ничего не удалено.");
      const result = db.deleteDemoTestParticipantById(participantId, actor, demoProjectRoot ? { projectRoot: demoProjectRoot } : undefined);
      return finish(result.deleted ? "Тестовая анкета и связанные данные удалены из demo.sqlite." : "Анкета больше не найдена.");
    } catch { return ctx.editMessageText("Не удалось безопасно удалить тестовую анкету. Проверьте права и состояние демобазы.", { reply_markup: { inline_keyboard: [] } }); }
  });
  bot.hears("📋 Запросы участников", async (ctx) => renderParticipantDataRequestsPage(ctx, 0));
  bot.hears("📥 Скачать Excel", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Выгрузка доступна только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к выгрузке участников.");
    if (!(await allowRequest(ctx, rateLimiter, "excel"))) return;
    const id = String(ctx.from.id); clearAdminFlow(id);
    const count = db.getParticipantCount();
    if (count === 0) return ctx.reply("Пока нет участников для выгрузки.");
    setAdminFlow(id, "export", { count });
    exportPrompts.set(id, { status: "pending" });
    const participantWord = count % 10 === 1 && count % 100 !== 11 ? "участник" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? "участника" : "участников";
    const verb = participantWord === "участник" ? "войдёт" : "войдут";
    return ctx.reply(`В Excel-файл ${verb} ${count} ${participantWord}. Файл содержит персональные данные. Продолжить?`, {
      reply_markup: new Keyboard().text("✅ Подтвердить выгрузку").row().text("Отмена").resized()
    });
  });
  bot.hears("Отмена", async (ctx, next) => {
    if (!privateChat(ctx)) return next();
    const id = String(ctx.from.id);
    const currentRole = role(ctx);
    if (!exportConfirmations.has(id) && !participantViews.has(id) && !pending.has(id)) {
      const exportPrompt = exportPrompts.get(id);
      if (!exportPrompt) return next();
      if (!currentRole) { clearAdminFlow(id); return ctx.reply("Доступ отозван."); }
      exportConfirmations.delete(id);
      if (exportPrompt.status === "cancelled") return replyAdminMenu(ctx, "Выгрузка уже отменена.\n\nАдминистративное меню:");
      exportPrompts.set(id, { status: "expired" });
      return replyAdminMenu(ctx, "Срок подтверждения выгрузки истёк. Действие завершено.\n\nАдминистративное меню:");
    }
    if (!currentRole) { clearAdminFlow(id); return ctx.reply("Доступ отозван."); }

    // Handle cancellation directly before the generic text-state handler. This
    // works for search input, results, pages, and participant details alike.
    if (exportConfirmations.has(id)) {
      exportConfirmations.delete(id);
      exportPrompts.set(id, { status: "cancelled" });
      return replyAdminMenu(ctx, "Выгрузка отменена.\n\nАдминистративное меню:");
    }
    if (participantViews.has(id)) {
      participantViews.delete(id);
      return showAdminMenu(ctx);
    }
    pending.delete(id);
    return ctx.reply("Действие отменено.", { reply_markup: managementMenu });
  });
  bot.hears("✅ Подтвердить выгрузку", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Выгрузку можно подтвердить только в личном чате с ботом.");
    const id = String(ctx.from.id);
    const confirmation = exportConfirmations.get(id);
    if (!role(ctx)) { clearAdminFlow(id); return ctx.reply("У вас нет доступа к выгрузке участников."); }
    if (!confirmation) {
      const exportPrompt = exportPrompts.get(id);
      if (exportPrompt) {
        const message = exportPrompt.status === "cancelled"
          ? "Выгрузка была отменена. Файл не сформирован."
          : exportPrompt.status === "expired"
            ? "Подтверждение выгрузки истекло. Файл не сформирован."
            : "Подтверждение не найдено: оно истекло или уже использовано. Файл не сформирован.";
        clearAdminFlow(id);
        exportPrompts.set(id, { status: exportPrompt.status === "pending" ? "expired" : exportPrompt.status });
        return replyAdminMenu(ctx, `${message}\n\nАдминистративное меню:`);
      }
      clearAdminFlow(id);
      return replyAdminMenu(ctx, "Подтверждение не найдено. Файл не сформирован. Начните выгрузку заново через админ-меню.\n\nАдминистративное меню:");
    }
    if (!(await allowRequest(ctx, rateLimiter, "excel_confirm"))) return;
    if (activeExports > 0) return ctx.reply("Другая выгрузка уже выполняется. Попробуйте немного позже.");

    const participants = db.getParticipantsForExport();
    if (!participants.length) {
      clearAdminFlow(id);
      return replyAdminMenu(ctx, "Пока нет участников для выгрузки.\n\nАдминистративное меню:");
    }
    if (participants.length !== confirmation.count) {
      setAdminFlow(id, "export", { count: participants.length });
      exportPrompts.set(id, { status: "pending" });
      return ctx.reply(`Количество участников изменилось. Сейчас в файл войдут ${participants.length}. Подтвердите ещё раз.`, {
        reply_markup: new Keyboard().text("✅ Подтвердить выгрузку").row().text("Отмена").resized()
      });
    }

    // Удаляем состояние до отправки: повторное нажатие старой кнопки не создаст вторую выгрузку.
    exportConfirmations.delete(id);
    activeExports += 1;
    try {
      const buffer = await createParticipantsWorkbook(participants);
      // Отзыв согласия или изменение экспортируемых данных во время
      // формирования книги делает этот снимок устаревшим.
      const currentParticipants = db.getParticipantsForExport();
      if (JSON.stringify(currentParticipants) !== JSON.stringify(participants)) {
        clearAdminFlow(id);
        return replyAdminMenu(ctx, "Данные или согласия изменились во время формирования файла. Устаревший файл не отправлен. Начните выгрузку заново.\n\nАдминистративное меню:");
      }
      // Повторная проверка прав выполняется после async-генерации прямо перед
      // сетевой отправкой. Между этой проверкой и Telegram API остаётся
      // неизбежное короткое окно; SQLite-транзакцию на время сети не держим.
      if (!privateChat(ctx) || !role(ctx)) {
        clearAdminFlow(id);
        return ctx.reply("Доступ к выгрузке отозван. Файл не отправлен.");
      }
      const filename = getExportFilename();
      await ctx.replyWithDocument(new InputFile(buffer, filename), { caption: `Выгрузка участников: ${participants.length}. Храните файл осторожно — в нём есть персональные данные.` });
      clearAdminFlow(id);
      return replyAdminMenu(ctx, "Excel-файл отправлен.\n\nАдминистративное меню:");
    } catch {
      clearAdminFlow(id);
      return replyAdminMenu(ctx, "Не удалось сформировать или отправить Excel-файл. Попробуйте позже.\n\nАдминистративное меню:");
    } finally {
      activeExports -= 1;
    }
  });
  const placeholders = new Map([]);
  for (const [button, response] of placeholders) bot.hears(button, async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Административные функции доступны только в личном чате.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к административным функциям.");
    return ctx.reply(response);
  });
  bot.on("message:text", async (ctx, next) => {
    if (!privateChat(ctx)) return next();
    const id = String(ctx.from.id), view = participantViews.get(id);
    if (view) {
      if (!role(ctx)) { clearAdminFlow(id); return ctx.reply("Доступ отозван."); }
      const text = ctx.message.text.trim();
      if (text === "🏠 Админ-меню") {
        participantViews.delete(id);
        return showAdminMenu(ctx);
      }
      if (view.mode === "data_requests") {
        if (text === "⬅️ Админ-меню") return showAdminMenu(ctx);
        if (text === "⬅️ Предыдущие запросы") return renderParticipantDataRequestsPage(ctx, view.page - 1);
        if (text === "➡️ Следующие запросы") return renderParticipantDataRequestsPage(ctx, view.page + 1);
        return ctx.reply("Используйте кнопки перелистывания или вернитесь в админ-меню.");
      }
      if (view.mode === "search") {
        if (!text) return ctx.reply("Введите имя, фамилию или телефон для поиска.");
        return renderSearchPage(ctx, text, 0);
      }
      if (view.mode === "page" && (text === "⬅️ Назад" || text === "➡️ Далее")) return renderParticipantsPage(ctx, Math.max(0, view.page + (text === "➡️ Далее" ? 1 : -1)));
      if (view.mode === "search_results" && (text === "⬅️ Назад" || text === "➡️ Далее")) return renderSearchPage(ctx, view.query, Math.max(0, view.page + (text === "➡️ Далее" ? 1 : -1)));
      if ((view.mode === "results" || view.mode === "search_results" || view.mode === "page") && view.selectable?.has(text)) {
        if (!(await allowRequest(ctx, rateLimiter, "admin_page"))) return;
        const p = db.getParticipant(view.selectable.get(text));
        if (!p) return ctx.reply("Участник больше не найден.");
        setAdminFlow(id, "view", { ...view, mode: "details" });
        return ctx.reply(fullParticipantText(p), { reply_markup: new Keyboard().text("⬅️ К результатам").row().text("🏠 Админ-меню").resized() });
      }
      if (view.mode === "details" && text === "⬅️ К результатам") {
        if (view.query !== undefined) return renderSearchPage(ctx, view.query, view.page || 0);
        return renderParticipantsPage(ctx, view.page || 0);
      }
      return ctx.reply("Выберите участника кнопкой, перейдите по страницам или нажмите «Отмена».");
    }
    const action = pending.get(id);
    if (!action) return next();
    if (role(ctx) !== "owner") { clearAdminFlow(id); return ctx.reply("Доступ отозван: только владелец может управлять администраторами."); }
    const value = ctx.message.text.trim();
    if (!/^\d+$/.test(value)) return ctx.reply("Telegram ID должен состоять только из цифр. Попробуйте ещё раз или напишите «Отмена».");
    if (value === id) return ctx.reply("Нельзя назначить или удалить самого себя через это действие.");
    if (action === "add") {
      try { const added = db.addAdmin(value); pending.delete(id); return ctx.reply(added ? `Администратор ${value} добавлен.` : "Этот Telegram ID уже есть в списке."); }
      catch { return ctx.reply("Не удалось добавить администратора. Проверьте Telegram ID и попробуйте снова."); }
    }
    const removed = db.removeAdmin(value); pending.delete(id);
    return ctx.reply(removed ? `Администратор ${value} удалён.` : "Администратор не найден. Владелец не может быть удалён.");
  });
  return () => {
    pending.stop();
    participantViews.stop();
    exportConfirmations.stop();
    exportPrompts.stop();
    demoDeletionReviews.stop();
  };
}
module.exports = { registerAdmin, registerAdminUsernameRefresh, showAdminMenu };

