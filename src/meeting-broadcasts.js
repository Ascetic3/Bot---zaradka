const crypto = require("node:crypto");
const fs = require("node:fs");
const { Keyboard } = require("grammy");
const { ExpiringMap } = require("./expiring-map");
const database = require("./database");
const { isPrivateChat } = require("./chat-guards");
const { createMeetingBroadcastStore, MINIMUM_SEND_DELAY_MS } = require("./meeting-broadcast-store");
const { validateClubTimeZone, toUtcFromClubLocal, validateZoomUrl, validateMeetingInput, parseMeetingInstant } = require("./meeting-broadcast-service");

const MENU = "📅 Встречи и рассылки";
const CANCEL = "Отмена";
const states = new ExpiringMap(30 * 60_000);
const loadedSourceSha256 = (() => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"); }
  catch { return "unavailable"; }
})();
function clearMeetingBroadcastState(userId) { return states.delete(String(userId)); }
function adminMenu(ctx) { return require("./admin").showAdminMenu(ctx); }
const hubKeyboard = new Keyboard().text("➕ Создать встречу").row().text("📜 История и статистика").row().text("⬅️ Админ-меню").resized();
const cancelKeyboard = new Keyboard().text(CANCEL).resized();
const listKeyboard = (items) => {
  const keyboard = new Keyboard();
  for (const item of items) keyboard.text(`#${item.id} ${truncate(item.title, 28)} · ${item.status}`).row();
  keyboard.text("⬅️ К меню встреч").row().text("⬅️ Админ-меню").row().text(CANCEL).resized();
  return keyboard;
};
const truncate = (value, max) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Без названия";
const asDate = (value, timeZone) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Не указано";
  try { return `${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date)} (${timeZone})`; }
  catch { return `${date.toISOString()} (${timeZone})`; }
};
const displayStatus = { draft: "черновик", scheduled: "запланирована", soon: "скоро начнётся", sending: "отправляется", completed: "завершена", cancelled: "отменена", failed: "требует внимания" };
const statsText = (summary) => {
  const d = summary.deliveries;
  const total = Object.values(d).reduce((sum, count) => sum + count, 0);
  return `\n\nСтатистика рассылки\n• Статус: ${displayStatus[summary.status] || summary.status}\n• Всего получателей: ${total}\n• Успешно отправлено: ${d.sent || 0}\n• Ожидают отправки: ${d.pending || 0}\n• Пропущено: ${d.unavailable || 0}\n• Ошибки, ожидают повтора: ${d.temporary_error || 0}\n• Неопределённые доставки: ${d.uncertain || 0}\n• Выполняются сейчас: ${d.sending || 0}`;
};

function registerMeetingBroadcasts(bot, { db = database, env = process.env, now = () => new Date(), store = createMeetingBroadcastStore(db.db), logger = console } = {}) {
  function role(ctx) { return isPrivateChat(ctx) && ctx.from ? db.getAdminRole(ctx.from.id) : null; }
  async function allow(ctx) {
    if (!isPrivateChat(ctx)) { await ctx.reply("Раздел встреч доступен только в личном чате с ботом."); return false; }
    if (!role(ctx)) { await ctx.reply("У вас нет доступа к управлению встречами."); return false; }
    return true;
  }
  const clock = () => (now() instanceof Date ? now() : new Date(now()));
  const nowIso = () => clock().toISOString();
  const actorKey = (ctx) => String(ctx.from.id);
  function logScheduleRejection(state, { scheduledAt = null, reason }) {
    const timezone = state?.values?.timezone || env.CLUB_TIMEZONE || "unknown";
    let meetingAt = null;
    try {
      if (state?.values?.startsAt) meetingAt = parseMeetingInstant(state.values.startsAt, timezone);
    } catch { /* Keep diagnostics safe and report only normalized values. */ }
    const scheduledTimestamp = scheduledAt ? Date.parse(scheduledAt) : NaN;
    const meetingTimestamp = meetingAt ? Date.parse(meetingAt) : NaN;
    const entry = {
      event: "zoom_schedule_time_rejected",
      stage: "wizard.scheduledAt",
      meeting_utc: Number.isFinite(meetingTimestamp) ? new Date(meetingTimestamp).toISOString() : null,
      scheduled_utc: Number.isFinite(scheduledTimestamp) ? new Date(scheduledTimestamp).toISOString() : null,
      difference_minutes: Number.isFinite(meetingTimestamp) && Number.isFinite(scheduledTimestamp)
        ? Number(((meetingTimestamp - scheduledTimestamp) / 60_000).toFixed(3))
        : null,
      timezone: String(timezone),
      meeting_source: state?.meetingTimeSource === "sqlite" ? "sqlite" : "wizard_memory",
      reason,
      process_id: process.pid,
      loaded_module_sha256: loadedSourceSha256
    };
    try { logger?.warn?.(`[zoom-time-diagnostic] ${JSON.stringify(entry)}`); }
    catch { /* Diagnostic logging must not change the user's validation result. */ }
  }
  const deliveryContext = () => ({ demoMode: String(env.DEMO_MODE).toLowerCase() === "true", demoAdminIds: demoIds(env.DEMO_BROADCAST_TELEGRAM_IDS) });
  const recipientCount = () => store.countEligibleRecipients(deliveryContext());
  function applyMinimumDelay(values) {
    const minimum = clock().getTime() + MINIMUM_SEND_DELAY_MS;
    if (Date.parse(values.scheduledAt) >= minimum) return { values, notice: "" };
    if (minimum >= Date.parse(values.startsAt)) throw new Error("До начала встречи меньше минуты. Перенесите начало встречи или выберите более раннее время отправки.");
    const adjusted = { ...values, scheduledAt: new Date(minimum).toISOString() };
    return { values: adjusted, notice: `\n\n⚠️ До указанного времени меньше минуты. Предложено перенести отправку на ${asDate(adjusted.scheduledAt, values.timezone)}. Проверьте новое время и подтвердите его.` };
  }
  const showHub = (ctx, text = "Выберите действие с встречами:") => ctx.reply(text, { reply_markup: hubKeyboard });
  const editKeyboard = (state) => {
    const keyboard = new Keyboard();
    if (state.editing) keyboard.text("Оставить").row();
    if (state.field === "note") keyboard.text(state.editing ? "Очистить текст" : "Пропустить текст").row();
    if (state.index > 0) keyboard.text("⬅️ Назад").row();
    return keyboard.text(CANCEL).resized();
  };
  const prompts = {
    title: "Введите название встречи (до 200 символов):",
    startsAt: (tz) => `Введите дату и время встречи в часовом поясе ${tz}: ГГГГ-ММ-ДД ЧЧ:ММ`,
    scheduledAt: (tz) => `Введите дату и время отправки приглашения в часовом поясе ${tz}: ГГГГ-ММ-ДД ЧЧ:ММ`,
    zoomUrl: "Вставьте HTTPS-ссылку Zoom с домена zoom.us или zoom.com:",
    note: "Введите короткий текст к приглашению (до 500 символов) или пропустите его:"
  };
  const fields = ["title", "startsAt", "scheduledAt", "zoomUrl", "note"];
  function localFieldValue(value, field, timezone) {
    if (["startsAt", "scheduledAt"].includes(field) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return toLocalInput(value, timezone);
    return String(value ?? "");
  }
  function askField(ctx, state) {
    state.field = fields[state.index];
    states.set(actorKey(ctx), state);
    const prompt = typeof prompts[state.field] === "function" ? prompts[state.field](state.values.timezone) : prompts[state.field];
    const existingValue = state.values[state.field];
    const current = existingValue !== undefined && existingValue !== null && String(existingValue) !== ""
      ? `\nТекущее значение: ${truncate(localFieldValue(existingValue, state.field, state.values.timezone), 100)}` : "";
    return ctx.reply(`${prompt}${current}`, { reply_markup: editKeyboard(state) });
  }
  function valuesFromItem(item, timezone = item.timezone) {
    return {
      title: item.title,
      startsAt: toLocalInput(item.starts_at, timezone),
      scheduledAt: toLocalInput(item.scheduled_at, timezone),
      zoomUrl: item.zoom_url,
      note: item.note || "",
      timezone
    };
  }
  function startWizard(ctx, editing = null) {
    let timezone;
    try { timezone = validateClubTimeZone(env.CLUB_TIMEZONE); }
    catch (error) { states.delete(actorKey(ctx)); return showHub(ctx, `${error.message}\nНастройте часовой пояс, чтобы создавать встречи.`); }
    if (String(env.DEMO_MODE).toLowerCase() === "true" && !demoIds(env.DEMO_BROADCAST_TELEGRAM_IDS).length) {
      return showHub(ctx, "В деморежиме рассылка заблокирована: укажите DEMO_BROADCAST_TELEGRAM_IDS в .env. Получателями могут быть только явно указанные администраторы демобота.");
    }
    const values = editing ? (editing.values || valuesFromItem(editing.item, timezone)) : { timezone };
    const state = { mode: "wizard", index: 0, values, meetingTimeSource: editing ? "sqlite" : "wizard_memory", editing: editing ? { id: editing.item.id, status: editing.item.status } : null, createdDraft: Boolean(editing?.createdDraft) };
    return askField(ctx, state);
  }
  function toLocalInput(iso, timezone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  function previewText(item, status = "черновик", timingNotice = "") {
    return `Предварительный просмотр приглашения\n\n📅 ${truncate(item.title, 200)}\nВстреча: ${asDate(item.starts_at, item.timezone)}\nОтправка: ${asDate(item.scheduled_at, item.timezone)}\n${item.zoom_url}${item.note ? `\n\n${truncate(item.note, 500)}` : ""}${timingNotice}\n\nСтатус: ${displayStatus[status] || status}. Сообщение будет отправлено отдельно каждому подходящему получателю.`;
  }
  function previewKeyboard(state) {
    const keyboard = new Keyboard();
    if (state.editing) keyboard.text("💾 Сохранить изменения").row();
    else keyboard.text("✅ Подтвердить рассылку").row();
    keyboard.text("✏️ Изменить").row().text("⬅️ Назад").row().text(CANCEL).resized();
    return keyboard;
  }
  function recipientPreviewText() {
    const preview = store.previewRecipients(deliveryContext());
    if (String(env.DEMO_MODE).toLowerCase() === "true") {
      return `\n\nДемо-режим: тестовых администраторов, допущенных к отправке: ${preview.eligible}. Исходные синтетические участники получателями не являются.${preview.excluded ? `\nНе прошли допуск: ${preview.excluded}.` : ""}`;
    }
    const reasons = preview.reasons.slice(0, 8).map((row) => `• ${row.reason}: ${row.count}`).join("\n");
    return `\n\nЗарегистрировано: ${preview.total}\nМогут получить приглашение: ${preview.eligible}\nНедоступны для отправки: ${preview.excluded}${reasons ? `\nПричины исключения:\n${reasons}` : ""}`;
  }
  async function showPreview(ctx, item, state) {
    states.set(actorKey(ctx), { mode: "preview", id: item.id, editing: state.editing, values: state.values, timingNotice: state.timingNotice || "", createdDraft: state.createdDraft ?? !state.editing });
    return ctx.reply(previewText(item, item.status, state.timingNotice) + recipientPreviewText() + "\n\nПодтвердить рассылку?", { reply_markup: previewKeyboard(state) });
  }
  async function showBroadcastList(ctx) {
    const items = store.list(actorKey(ctx), 20);
    if (!items.length) return showHub(ctx, "История пока пуста. Создайте встречу, чтобы запланировать рассылку.");
    const labels = new Map(items.map((item) => [`#${item.id} ${truncate(item.title, 28)} · ${item.status}`, item.id]));
    states.set(actorKey(ctx), { mode: "list", labels });
    const lines = items.map((item) => `#${item.id} · ${truncate(item.title, 120)} — ${displayStatus[item.status] || item.status}\nОтправка: ${asDate(item.scheduled_at, item.timezone)}`).join("\n\n");
    return ctx.reply(`Встречи и рассылки (последние ${items.length}):\n\n${lines}`, { reply_markup: listKeyboard(items) });
  }
  async function showDetails(ctx, id, notice = "") {
    if (!(await allow(ctx))) return;
    const summary = store.summary(id, actorKey(ctx));
    if (!summary) { states.delete(actorKey(ctx)); return showHub(ctx, "Эта рассылка не найдена или недоступна."); }
    const keyboard = new Keyboard();
    if (summary.status === "draft") keyboard.text("✅ Подтвердить рассылку").row().text("✏️ Изменить").row().text("❌ Отменить рассылку").row();
    if (summary.status === "scheduled") keyboard.text("✏️ Изменить").row().text("🚀 Отправить сейчас").row().text("⛔ Отменить рассылку").row();
    if (summary.status === "sending") keyboard.text("⛔ Остановить рассылку").row();
    if (["scheduled", "sending", "completed", "cancelled", "failed"].includes(summary.status)) keyboard.text("🔄 Обновить статистику").row();
    if (summary.status === "failed" && summary.last_error_code === "STALE_INVITATION_REQUIRES_REVIEW") keyboard.text("🔎 Проверить и отправить сейчас").row();
    keyboard.text("⬅️ К списку встреч").row().text("⬅️ Админ-меню").resized();
    states.set(actorKey(ctx), { mode: "details", id: summary.id });
    const scheduledRemaining = Date.parse(summary.scheduled_at) - clock().getTime();
    const shownStatus = summary.status === "scheduled" && scheduledRemaining <= MINIMUM_SEND_DELAY_MS ? "soon" : summary.status;
    const stageNotice = summary.status === "scheduled"
      ? `\n\nОжидание: отмену можно выполнить без отправки. До начала: ${Math.max(0, Math.ceil(scheduledRemaining / 1000))} секунд.`
      : summary.status === "sending"
        ? "\n\nРассылка отправляется. Каждая зарезервированная доставка уже считается начатой и может завершиться. Можно остановить отправку оставшимся получателям."
        : "";
    const reviewNotice = summary.last_error_code === "ADMIN_STOPPED"
      ? `\n\n⛔ Рассылка остановлена. Уже отправленные сообщения отозвать нельзя.${summary.deliveries.sending || summary.deliveries.sent || summary.deliveries.uncertain ? " Зарезервированные операции могут завершиться; незарезервированные получатели не будут отправлены." : " Ни одно приглашение не отправлено."} Итоговая статистика показана выше.`
      : summary.last_error_code === "DELIVERY_RESULT_REQUIRES_REVIEW"
      ? "\n\n⚠️ Telegram не подтвердил результат одной из отправок. Автоповтора не будет; проверьте ситуацию вручную."
      : summary.last_error_code === "MEETING_STARTED_REQUIRES_REVIEW"
        ? "\n\n⚠️ Встреча уже началась. Оставшиеся приглашения остановлены."
        : "";
    return ctx.reply(`${notice}${previewText(summary, shownStatus)}${statsText(summary)}${stageNotice}${reviewNotice}`, { reply_markup: keyboard });
  }
  function showNearTimeOptions(ctx, state) {
    const key = actorKey(ctx);
    const item = store.get(state.id);
    if (!item || item.status !== "draft") { states.delete(key); return showHub(ctx, "Черновик уже изменён или обработан. Откройте актуальную запись в истории."); }
    states.set(key, { mode: "near_time_confirm", id: state.id, values: valuesFromItem(item) });
    return ctx.reply("⚠️ До запланированного времени меньше 60 секунд. Обязательная задержка перед началом отправки — 60 секунд. Выберите: начать отсчёт заново после подтверждения или указать другое время.", {
      reply_markup: new Keyboard().text("✅ Отправить через 60 секунд").row().text("📅 Выбрать другое время").row().text("⬅️ Назад").resized()
    });
  }
  function showMeetingTimeBlocked(ctx, state) {
    const key = actorKey(ctx);
    const item = store.get(state.id);
    if (!item || item.status !== "draft") { states.delete(key); return showHub(ctx, "Черновик уже изменён или обработан. Откройте актуальную запись в истории."); }
    states.set(key, { mode: "meeting_time_blocked", id: state.id, values: valuesFromItem(item) });
    return ctx.reply("До начала встречи меньше времени, чем требуется для 60-секундной задержки. Измените время встречи или отмените создание рассылки.", {
      reply_markup: new Keyboard().text("✏️ Изменить время встречи").row().text("❌ Отменить создание").row().text("⬅️ Назад").resized()
    });
  }

  bot.hears(MENU, async (ctx) => {
    if (!(await allow(ctx))) return;
    states.delete(actorKey(ctx));
    return showHub(ctx);
  });
  bot.hears("➕ Создать встречу", async (ctx) => { if (!(await allow(ctx))) return; return startWizard(ctx); });
  bot.hears("⬅️ Назад", async (ctx, next) => {
    if (!isPrivateChat(ctx)) return ctx.reply("Раздел встреч доступен только в личном чате с ботом.");
    const state = states.get(actorKey(ctx));
    if (!state || !["wizard", "preview", "near_time_confirm", "meeting_time_blocked"].includes(state.mode)) return next();
    if (!(await allow(ctx))) return;
    if (state.mode === "wizard") {
      if (state.index <= 0) return ctx.reply("Это первый шаг мастера.");
      state.index -= 1;
      return askField(ctx, state);
    }
    if (state.mode === "preview") {
      const item = store.get(state.id);
      if (!item || item.status !== "draft") { states.delete(actorKey(ctx)); return showHub(ctx, "Черновик больше недоступен. Изменения не внесены."); }
      state.editing = state.editing || { id: item.id, status: "draft" };
      state.mode = "wizard";
      state.index = fields.length - 1;
      return askField(ctx, state);
    }
    const item = store.get(state.id);
    if (!item || item.status !== "draft") { states.delete(actorKey(ctx)); return showHub(ctx, "Черновик больше недоступен. Изменения не внесены."); }
    return showPreview(ctx, item, { editing: null, values: valuesFromItem(item) });
  });
  bot.hears("📜 История и статистика", async (ctx) => { if (!(await allow(ctx))) return; return showBroadcastList(ctx); });
  bot.hears("🔄 Обновить статистику", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "details" || !state.id) return showHub(ctx, "Откройте запись рассылки из истории, чтобы обновить статистику.");
    return showDetails(ctx, state.id);
  });
  bot.hears("⬅️ Админ-меню", async (ctx) => { if (!(await allow(ctx))) return; states.delete(actorKey(ctx)); return adminMenu(ctx); });
  bot.hears("⬅️ К меню встреч", async (ctx) => { if (!(await allow(ctx))) return; states.delete(actorKey(ctx)); return showHub(ctx); });
  bot.hears("⬅️ К списку встреч", async (ctx) => { if (!(await allow(ctx))) return; return showBroadcastList(ctx); });
  bot.hears("⛔ Остановить рассылку", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state?.id || state.mode !== "details") { states.delete(actorKey(ctx)); return showHub(ctx, "Действие устарело. Откройте активную рассылку из истории."); }
    const item = store.get(state.id);
    if (!item || item.status !== "sending") { return showDetails(ctx, state.id, "Остановка недоступна: рассылка уже завершилась или была остановлена.\n\n"); }
    states.set(actorKey(ctx), { mode: "stop_confirm", id: item.id });
    return ctx.reply("⚠️ Остановить рассылку?\n\nНовые отправки больше не будут начинаться. Сообщения, отправка которых уже начата или зарезервирована, ещё могут быть доставлены.\n\nУже отправленные приглашения отозвать нельзя.", {
      reply_markup: new Keyboard().text("⛔ Подтвердить остановку").row().text(CANCEL).resized()
    });
  });
  bot.hears("⛔ Подтвердить остановку", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state?.id || state.mode !== "stop_confirm") { states.delete(actorKey(ctx)); return showHub(ctx, "Подтверждение устарело. Ничего не остановлено."); }
    if (!role(ctx)) { states.delete(actorKey(ctx)); return ctx.reply("Административные права отозваны. Остановка не выполнена."); }
    const result = store.requestStop(state.id, nowIso());
    states.delete(actorKey(ctx));
    if (result === "not_active") return showDetails(ctx, state.id, "Остановить не удалось: рассылка уже не выполняется.\n\n");
    const notice = result === "already_stopped" ? "Остановка уже была запрошена.\n\n" : "Запрос остановки записан.\n\n";
    return showDetails(ctx, state.id, notice);
  });
  bot.hears(CANCEL, async (ctx, next) => {
    const state = states.get(actorKey(ctx));
    if (!state) return next();
    if (!(await allow(ctx))) { states.delete(actorKey(ctx)); return; }
    states.delete(actorKey(ctx));
    if (state.id && (state.mode === "near_time_confirm" || state.mode === "meeting_time_blocked" || state.returnToPreviewAfterField)
        && store.get(state.id)?.status === "draft") store.cancel(state.id, actorKey(ctx), nowIso());
    if (state.id && (state.mode === "details" || state.createdDraft || (state.mode === "preview" && !state.editing))) {
      const item = store.get(state.id);
      if (item && ["draft", "scheduled"].includes(item.status)) store.cancel(state.id, actorKey(ctx), nowIso());
    }
    return adminMenu(ctx);
  });
  bot.hears("✅ Подтвердить рассылку", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (state?.mode === "near_time_confirm") return showNearTimeOptions(ctx, state);
    if (state?.mode === "meeting_time_blocked") return showMeetingTimeBlocked(ctx, state);
    if (!state || !["preview", "details"].includes(state.mode)) { states.delete(actorKey(ctx)); return showHub(ctx, "Подтверждение устарело. Рассылка не создана. Откройте историю и выберите актуальное действие."); }
    const item = store.get(state.id);
    if (!item || item.status !== "draft") { states.delete(actorKey(ctx)); return showHub(ctx, "Черновик уже изменён или обработан. Рассылка не запущена."); }
    const result = store.confirmDraft(state.id, actorKey(ctx), nowIso(), { deferPast: true });
    if (result === "too_soon") return showNearTimeOptions(ctx, state);
    if (result === "meeting_too_soon") return showMeetingTimeBlocked(ctx, state);
    if (result !== true) return showHub(ctx, "Не удалось подтвердить черновик. Проверьте его состояние в истории.");
    states.delete(actorKey(ctx));
    return showHub(ctx, "Рассылка запланирована. Состояние и историю можно посмотреть в разделе встреч.");
  });
  bot.hears("✅ Отправить через 60 секунд", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "near_time_confirm") { states.delete(actorKey(ctx)); return showHub(ctx, "Это подтверждение устарело. Откройте черновик рассылки заново."); }
    if (store.get(state.id)?.status !== "draft") { states.delete(actorKey(ctx)); return showHub(ctx, "Черновик уже изменён или обработан. Новая отправка не создана."); }
    if (!store.sendNow(state.id, actorKey(ctx), nowIso(), { draftOnly: true })) {
      if (store.get(state.id)?.status !== "draft") {
        states.delete(actorKey(ctx));
        return showHub(ctx, "Это подтверждение уже обработано. Откройте актуальную запись в истории.");
      }
      return showMeetingTimeBlocked(ctx, state);
    }
    const current = store.get(state.id);
    const remaining = Math.max(0, Math.ceil((Date.parse(current.scheduled_at) - clock().getTime()) / 1000));
    return showDetails(ctx, state.id, `Рассылка подготовлена.\nФактическое время начала: ${asDate(current.scheduled_at, current.timezone)}.\nОжидание: ${remaining} секунд. До начала отправки рассылку можно отменить.\n\n`);
  });
  bot.hears("📅 Выбрать другое время", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "near_time_confirm" || store.get(state.id)?.status !== "draft") return showHub(ctx, "Это действие устарело. Откройте черновик рассылки заново.");
    state.mode = "wizard";
    state.index = 2;
    state.returnToPreviewAfterField = "scheduledAt";
    return askField(ctx, state);
  });
  bot.hears("✏️ Изменить время встречи", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "meeting_time_blocked" || store.get(state.id)?.status !== "draft") return showHub(ctx, "Это действие устарело. Откройте черновик рассылки заново.");
    state.mode = "wizard";
    state.index = 1;
    state.returnToPreviewAfterField = "startsAt";
    return askField(ctx, state);
  });
  bot.hears("❌ Отменить создание", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "meeting_time_blocked" || !store.cancel(state.id, actorKey(ctx), nowIso())) {
      states.delete(actorKey(ctx));
      return showHub(ctx, "Черновик уже обработан. Новых данных не сохранено.");
    }
    states.delete(actorKey(ctx));
    return showHub(ctx, "Создание рассылки отменено.");
  });
  bot.hears("💾 Сохранить изменения", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || state.mode !== "preview" || !state.editing) { states.delete(actorKey(ctx)); return showHub(ctx, "Изменение устарело. Откройте рассылку заново из истории."); }
    const item = store.get(state.id);
    let values;
    try { values = validateMeetingInput(state.values, { timeZone: state.values.timezone, now: clock() }); }
    catch (error) { return ctx.reply(`${error.message}\nИзменения не сохранены.`); }
    let timingNotice = "";
    try { ({ values, notice: timingNotice } = applyMinimumDelay(values)); }
    catch (error) { return ctx.reply(`${error.message}\nИзменения не сохранены.`); }
    const saved = state.editing.status === "draft"
      ? store.updateDraft(state.id, actorKey(ctx), values, nowIso())
      : store.updateScheduled(state.id, actorKey(ctx), values, nowIso());
    if (!saved) { states.delete(actorKey(ctx)); return showHub(ctx, "Рассылку уже нельзя изменить. Проверьте её состояние в истории."); }
    if (state.editing.status === "scheduled") return showDetails(ctx, state.id, timingNotice);
    return showPreview(ctx, store.get(state.id), { editing: null, values, timingNotice });
  });
  bot.hears("✏️ Изменить", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    const item = state?.id ? store.get(state.id) : null;
    if (!item || !["draft", "scheduled"].includes(item.status)) { states.delete(actorKey(ctx)); return showHub(ctx, "Рассылку уже нельзя изменить. Откройте актуальную запись из истории."); }
    const values = state?.mode === "preview" ? state.values : null;
    return startWizard(ctx, { item, values, createdDraft: state?.createdDraft });
  });
  bot.hears(["❌ Отменить рассылку", "⛔ Отменить рассылку"], async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state?.id || !store.cancel(state.id, actorKey(ctx), nowIso())) { states.delete(actorKey(ctx)); return showHub(ctx, "Эту рассылку нельзя отменить: она уже началась или завершена."); }
    const summary = store.summary(state.id, actorKey(ctx));
    const deliveries = summary?.deliveries || {};
    const alreadyStarted = Boolean(deliveries.sent || deliveries.sending || deliveries.uncertain);
    states.delete(actorKey(ctx));
    return showHub(ctx, alreadyStarted
      ? "Рассылка отменена. Уже отправленные или начатые операции сохраняют свой результат; остальные приглашения не будут отправлены."
      : "Рассылка отменена. Ни одно приглашение не отправлено.");
  });
  bot.hears("🚀 Отправить сейчас", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state?.id || store.get(state.id)?.status !== "scheduled") { states.delete(actorKey(ctx)); return showHub(ctx, "Эта рассылка уже не ожидает отправки."); }
    states.set(actorKey(ctx), { mode: "send_now_confirm", id: state.id });
    const count = recipientCount();
    return ctx.reply(`Подтвердите подготовку рассылки.\n\nПосле подтверждения начнётся ожидание 60 секунд. Получатели сейчас: ${count}. За это время рассылку можно отменить без отправки сообщений.`, { reply_markup: new Keyboard().text("🚀 Подтвердить отправку").row().text(CANCEL).resized() });
  });
  bot.hears("🔎 Проверить и отправить сейчас", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state?.id) return showHub(ctx, "Устаревшая кнопка. Откройте актуальную запись в истории.");
    const item = store.get(state.id);
    if (item?.status !== "failed" || item.last_error_code !== "STALE_INVITATION_REQUIRES_REVIEW") return showHub(ctx, "Приглашение больше не требует этой проверки.");
    states.set(actorKey(ctx), { mode: "review_send_confirm", id: item.id });
    return ctx.reply("Планировщик остановил устаревшую рассылку. Подтвердите, что встреча ещё актуальна, чтобы поставить её на немедленную отправку.", { reply_markup: new Keyboard().text("🚀 Подтвердить отправку").row().text(CANCEL).resized() });
  });
  bot.hears("🚀 Подтвердить отправку", async (ctx) => {
    if (!(await allow(ctx))) return;
    const state = states.get(actorKey(ctx));
    if (!state || !["send_now_confirm", "review_send_confirm"].includes(state.mode)) { states.delete(actorKey(ctx)); return showHub(ctx, "Подтверждение устарело. Ничего не отправлено."); }
    const item = store.get(state.id);
    if (!item || !["scheduled", "failed"].includes(item.status)) { states.delete(actorKey(ctx)); return showHub(ctx, "Рассылка уже изменилась. Ничего не отправлено."); }
    if (!store.sendNow(state.id, actorKey(ctx), nowIso())) { states.delete(actorKey(ctx)); return showHub(ctx, "Не удалось поставить отправку. Проверьте запись в истории."); }
    const count = recipientCount();
    const remaining = Math.max(0, Math.ceil((Date.parse(store.get(state.id).scheduled_at) - clock().getTime()) / 1000));
    return showDetails(ctx, state.id, `Рассылка подготовлена.\nДо начала отправки: ${remaining} секунд.\nПолучатели: ${count}.\nПока ожидание не завершилось, отмена не отправит сообщений.\n\n`);
  });
  bot.on("message:text", async (ctx, next) => {
    if (!isPrivateChat(ctx)) return next();
    const key = actorKey(ctx), state = states.get(key);
    if (!state) return next();
    if (!role(ctx)) { states.delete(key); return ctx.reply("Доступ к встречам отозван. Черновик встречи не изменён."); }
    const text = String(ctx.message.text ?? "").trim();
    if (state.mode === "list") {
      if (state.labels.has(text)) return showDetails(ctx, state.labels.get(text));
      return ctx.reply("Выберите встречу кнопкой или вернитесь в меню.");
    }
    if (state.mode === "details") return ctx.reply("Используйте кнопки этой рассылки.");
    if (state.mode === "send_now_confirm" || state.mode === "review_send_confirm") return ctx.reply("Подтвердите действие кнопкой или отмените его.");
    if (state.mode !== "wizard") return next();
    let value = text;
    const field = fields[state.index];
    if (value === "Оставить" && state.editing) value = localFieldValue(state.values[field], field, state.values.timezone);
    else if (field === "note" && (value === "Пропустить текст" || value === "Очистить текст")) value = "";
    try {
      if (field === "title") {
        if (!value || value.length > 200) throw new Error("Название должно содержать от 1 до 200 символов.");
        state.values.title = value;
      } else if (field === "startsAt") {
        // Keep wizard state in canonical UTC instants after accepting local
        // club time. Later steps can then compare the same representation and
        // never interpret an already-converted value as local time again.
        state.values.startsAt = toUtcFromClubLocal(value, state.values.timezone);
        state.meetingTimeSource = "wizard_memory";
      } else if (field === "scheduledAt") {
        const scheduledAt = toUtcFromClubLocal(value, state.values.timezone);
        const scheduled = Date.parse(scheduledAt);
        const meeting = Date.parse(parseMeetingInstant(state.values.startsAt, state.values.timezone));
        if (scheduled <= clock().getTime()) {
          logScheduleRejection(state, { scheduledAt, reason: "send_time_not_future" });
          throw new Error("Время отправки должно быть в будущем.");
        }
        if (scheduled >= meeting) {
          logScheduleRejection(state, { scheduledAt, reason: "send_time_not_before_meeting" });
          throw new Error("Приглашение нужно отправить до начала встречи.");
        }
        state.values.scheduledAt = scheduledAt;
      } else if (field === "zoomUrl") state.values.zoomUrl = validateZoomUrl(value);
      else {
        if (value.length > 500) throw new Error("Текст должен содержать не более 500 символов.");
        state.values.note = value;
      }
    } catch (error) { return ctx.reply(`${error.message}\nПопробуйте ещё раз.`, { reply_markup: editKeyboard(state) }); }
    state.index += 1;
    if (state.returnToPreviewAfterField === field
        || (state.returnToPreviewAfterField === "startsAt" && field === "scheduledAt")) {
      let values;
      try { values = validateMeetingInput(state.values, { timeZone: state.values.timezone, now: clock() }); }
      catch (error) { state.index = /отправки|Приглашение/.test(error.message) ? 2 : field === "startsAt" ? 1 : 2; return ctx.reply(`${error.message}\nИсправьте время.`, { reply_markup: editKeyboard(state) }).then(() => askField(ctx, state)); }
      if (!store.updateDraft(state.id, key, values, nowIso())) { states.delete(key); return showHub(ctx, "Черновик больше недоступен. Изменения не сохранены."); }
      return showPreview(ctx, store.get(state.id), { editing: null, values });
    }
    if (state.index < fields.length) return askField(ctx, state);
    let values;
    try { values = validateMeetingInput(state.values, { timeZone: state.values.timezone, now: clock() }); }
    catch (error) { state.index = error.message.includes("встречи") ? 1 : error.message.includes("отправки") || error.message.includes("Приглашение") ? 2 : 0; return ctx.reply(`${error.message}\nИсправьте соответствующий ответ.`, { reply_markup: editKeyboard(state) }).then(() => askField(ctx, state)); }
    let timingNotice = "";
    if (state.editing) {
      try { ({ values, notice: timingNotice } = applyMinimumDelay(values)); }
      catch (error) { state.index = 2; return ctx.reply(`${error.message}\nИсправьте время отправки или встречи.`, { reply_markup: editKeyboard(state) }).then(() => askField(ctx, state)); }
    }
    state.values = values;
    if (state.editing) {
      if (state.editing.status === "draft") {
        states.set(key, { mode: "preview", id: state.editing.id, editing: state.editing, values, timingNotice, createdDraft: state.createdDraft });
        return ctx.reply(previewText({ ...values, starts_at: values.startsAt, scheduled_at: values.scheduledAt, status: "draft" }, "draft", timingNotice), { reply_markup: previewKeyboard(state) });
      }
      states.set(key, { mode: "preview", id: state.editing.id, editing: state.editing, values, timingNotice, createdDraft: state.createdDraft });
      return ctx.reply(previewText({ ...values, starts_at: values.startsAt, scheduled_at: values.scheduledAt, status: "scheduled" }, "scheduled", timingNotice), { reply_markup: previewKeyboard(state) });
    }
    try {
      const id = store.createDraft({ ...values, createdBy: key, now: nowIso() });
      const item = store.get(id);
      return showPreview(ctx, item, { editing: null, values, timingNotice });
    } catch { states.delete(key); return showHub(ctx, "Не удалось сохранить черновик встречи. Повторите попытку позже."); }
  });

  return () => states.stop();
}

function demoIds(raw) { return [...new Set(String(raw ?? "").split(",").map((value) => value.trim()).filter((value) => /^\d{1,20}$/.test(value)))]; }

module.exports = { registerMeetingBroadcasts, MENU, demoIds, clearMeetingBroadcastState };

