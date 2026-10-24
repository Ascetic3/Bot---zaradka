const { Keyboard, InputFile } = require("grammy");
const db = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { createParticipantsWorkbook, getExportFilename } = require("./excel-export");
const pending = new Map();
const participantViews = new Map();
const exportConfirmations = new Map();
const usernameMiddlewareRegistered = new WeakSet();
const demoBanner = () => process.env.DEMO_MODE === "true" ? "🧪 Демонстрационный режим. Данные вымышленные\n\n" : "";
const ownerMenu = new Keyboard().text("🔎 Найти участника").row().text("👥 Все участники").row().text("📊 Статистика").row().text("📥 Скачать Excel").row().text("⚙️ Управление администраторами").row().text("🏠 Главное меню").resized();
const adminMenu = new Keyboard().text("🔎 Найти участника").row().text("👥 Все участники").row().text("📊 Статистика").row().text("📥 Скачать Excel").row().text("🏠 Главное меню").resized();
const managementMenu = new Keyboard().text("📋 Список администраторов").row().text("➕ Добавить администратора").row().text("➖ Удалить администратора").row().text("⬅️ В меню администратора").resized();
const privateChat = isPrivateChat;
const role = (ctx) => privateChat(ctx) ? db.getAdminRole(ctx.from.id) : null;
const showAdminMenu = (ctx) => {
  const currentRole = role(ctx);
  return ctx.reply(`${demoBanner()}Административное меню:`, { reply_markup: currentRole === "owner" ? ownerMenu : adminMenu });
};
const clearAdminFlow = (id) => {
  participantViews.delete(id);
  pending.delete(id);
  exportConfirmations.delete(id);
};
const shortText = (value, max = 40) => String(value ?? "Не указано").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Не указано";
const fullParticipantText = (p) => {
  const value = (v, max = 150) => shortText(v, max);
  const date = p.registered_at && !Number.isNaN(new Date(p.registered_at).getTime()) ? new Date(p.registered_at).toLocaleDateString("ru-RU", { timeZone: "UTC" }) : "Не указано";
  return `Анкета участника:\n\nИмя: ${value(p.first_name, 100)}\nФамилия: ${value(p.last_name, 100)}\nТелефон: ${value(p.phone, 32)}\nГород: ${value(p.city)}\nEmail: ${value(p.email)}\nПредпочтительный способ связи: ${value(p.preferred_contact, 80)}\nОткуда узнали о клубе: ${value(p.referral_source)}\nДата регистрации: ${date}`;
};
const participantButton = (p) => `👤 ${p.id}: ${shortText(p.first_name, 20)} ${shortText(p.last_name, 20)}`;
const statisticsKeyboard = new Keyboard().text("🔄 Обновить статистику").row().text("⬅️ Админ-меню").resized();
function formatDistribution(rows) {
  return rows.map(({ category, count }) => `• ${category}: ${count}`).join("\n");
}
function registerAdminUsernameRefresh(bot) {
  if (usernameMiddlewareRegistered.has(bot)) return;
  usernameMiddlewareRegistered.add(bot);
  bot.use(async (ctx, next) => {
    if (ctx.from) db.updateAdminUsername(ctx.from.id, ctx.from.username ?? null);
    return next();
  });
}
function registerAdmin(bot) {
  registerAdminUsernameRefresh(bot);
  db.initializeOwner(process.env.OWNER_TELEGRAM_ID);
  bot.command("admin", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Административная команда доступна только в личном чате с ботом.");
    const currentRole = role(ctx);
    if (!currentRole) return ctx.reply("У вас нет доступа к административному меню.");
    return showAdminMenu(ctx);
  });
  bot.hears("🔎 Найти участника", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Поиск доступен только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к поиску участников.");
    participantViews.set(String(ctx.from.id), { mode: "search" });
    return ctx.reply("Введите имя, фамилию или полный номер телефона:", { reply_markup: new Keyboard().text("Отмена").resized() });
  });
  const renderParticipantsPage = async (ctx, page) => {
    if (!privateChat(ctx)) return ctx.reply("Список доступен только в личном чате с ботом.");
    if (!role(ctx)) { participantViews.delete(String(ctx.from.id)); return ctx.reply("У вас нет доступа к списку участников."); }
    const id = String(ctx.from.id), offset = page * 10;
    const rows = db.listParticipants(10, offset);
    participantViews.set(id, { mode: "page", page, selectable: new Map(rows.map((p) => [participantButton(p), p.id])) });
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
    if (!role(ctx)) { participantViews.delete(String(ctx.from.id)); return ctx.reply("Доступ к поиску отозван."); }
    const id = String(ctx.from.id);
    const batch = db.searchParticipants(query, 11, page * 10);
    if (!batch.length) {
      participantViews.set(id, { mode: "search_results", query, page, selectable: new Map() });
      return ctx.reply("Ничего не найдено. Попробуйте другой запрос или нажмите «Отмена».", { reply_markup: new Keyboard().text("Отмена").resized() });
    }
    const rows = batch.slice(0, 10);
    const selectable = new Map(rows.map((p) => [participantButton(p), p.id]));
    participantViews.set(id, { mode: "search_results", query, page, selectable });
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
    return renderParticipantsPage(ctx, 0);
  });
  const managementButton = "⚙️ Управление администраторами";
  bot.hears(managementButton, async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Управление доступно только в личном чате с ботом.");
    if (role(ctx) !== "owner") return ctx.reply("Только владелец может управлять администраторами.");
    return ctx.reply("Управление администраторами:", { reply_markup: managementMenu });
  });
  bot.hears("📋 Список администраторов", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    const list = db.listAdmins().map((a) => `${a.role === "owner" ? "👑 Владелец" : "🛡 Администратор"}\nID: ${a.telegram_id}\nTelegram: ${a.username ? `@${a.username.replace(/^@/, "")}` : "Ник не указан"}`).join("\n\n");
    return ctx.reply(list || "Список администраторов пуст.");
  });
  bot.hears("➕ Добавить администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    pending.set(String(ctx.from.id), "add");
    return ctx.reply("Отправьте Telegram ID нового администратора (только цифры). Для отмены напишите «Отмена».");
  });
  bot.hears("➖ Удалить администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (role(ctx) !== "owner") return ctx.reply("Недостаточно прав.");
    pending.set(String(ctx.from.id), "remove");
    return ctx.reply("Отправьте Telegram ID администратора для удаления. Владелец удалить себя не может. Для отмены напишите «Отмена».");
  });
  bot.hears("⬅️ В меню администратора", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа.");
    return showAdminMenu(ctx);
  });
  bot.hears("🏠 Главное меню", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Действие доступно только в личном чате.");
    pending.delete(String(ctx.from.id));
    return ctx.reply("Главное меню открыто. Отправьте /start.");
  });
  const showStatistics = async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Статистика доступна только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к статистике.");
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
  bot.hears("📥 Скачать Excel", async (ctx) => {
    if (!privateChat(ctx)) return ctx.reply("Выгрузка доступна только в личном чате с ботом.");
    if (!role(ctx)) return ctx.reply("У вас нет доступа к выгрузке участников.");
    const count = db.getParticipantCount();
    if (count === 0) { exportConfirmations.delete(String(ctx.from.id)); return ctx.reply("Пока нет участников для выгрузки."); }
    exportConfirmations.set(String(ctx.from.id), { count });
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
    if (!exportConfirmations.has(id) && !participantViews.has(id) && !pending.has(id)) return next();
    if (!currentRole) { clearAdminFlow(id); return ctx.reply("Доступ отозван."); }

    // Handle cancellation directly before the generic text-state handler. This
    // works for search input, results, pages, and participant details alike.
    if (exportConfirmations.has(id)) {
      exportConfirmations.delete(id);
      return ctx.reply("Выгрузка отменена.", { reply_markup: currentRole === "owner" ? ownerMenu : adminMenu });
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
    if (!role(ctx)) { exportConfirmations.delete(id); return ctx.reply("У вас нет доступа к выгрузке участников."); }
    if (!confirmation) return ctx.reply("Подтверждение не найдено. Начните выгрузку заново через админ-меню.");

    const participants = db.getParticipantsForExport();
    if (!participants.length) { exportConfirmations.delete(id); return ctx.reply("Пока нет участников для выгрузки."); }
    if (participants.length !== confirmation.count) {
      exportConfirmations.set(id, { count: participants.length });
      return ctx.reply(`Количество участников изменилось. Сейчас в файл войдут ${participants.length}. Подтвердите ещё раз.`, {
        reply_markup: new Keyboard().text("✅ Подтвердить выгрузку").row().text("Отмена").resized()
      });
    }

    // Удаляем состояние до отправки: повторное нажатие старой кнопки не создаст вторую выгрузку.
    exportConfirmations.delete(id);
    try {
      const buffer = await createParticipantsWorkbook(participants);
      if (!privateChat(ctx) || !role(ctx)) return ctx.reply("Доступ к выгрузке отозван. Файл не отправлен.");
      const filename = getExportFilename();
      await ctx.replyWithDocument(new InputFile(buffer, filename), { caption: `Выгрузка участников: ${participants.length}. Храните файл осторожно — в нём есть персональные данные.` });
      return ctx.reply("Excel-файл отправлен.");
    } catch {
      return ctx.reply("Не удалось сформировать или отправить Excel-файл. Попробуйте позже.");
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
      if (!role(ctx)) { participantViews.delete(id); return ctx.reply("Доступ отозван."); }
      const text = ctx.message.text.trim();
      if (text === "🏠 Админ-меню") {
        participantViews.delete(id);
        return showAdminMenu(ctx);
      }
      if (view.mode === "search") {
        if (!text) return ctx.reply("Введите имя, фамилию или телефон для поиска.");
        return renderSearchPage(ctx, text, 0);
      }
      if (view.mode === "page" && (text === "⬅️ Назад" || text === "➡️ Далее")) return renderParticipantsPage(ctx, Math.max(0, view.page + (text === "➡️ Далее" ? 1 : -1)));
      if (view.mode === "search_results" && (text === "⬅️ Назад" || text === "➡️ Далее")) return renderSearchPage(ctx, view.query, Math.max(0, view.page + (text === "➡️ Далее" ? 1 : -1)));
      if ((view.mode === "results" || view.mode === "search_results" || view.mode === "page") && view.selectable?.has(text)) {
        const p = db.getParticipant(view.selectable.get(text));
        if (!p) return ctx.reply("Участник больше не найден.");
        participantViews.set(id, { ...view, mode: "details" });
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
    if (role(ctx) !== "owner") { pending.delete(id); return ctx.reply("Доступ отозван: только владелец может управлять администраторами."); }
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
}
module.exports = { registerAdmin, registerAdminUsernameRefresh };

