Warning: truncated output (original token count: 31167)
Total output lines: 1867

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { Bot } = require("grammy");
const { migrateDatabase } = require("../src/database/migrations");
const { createMeetingBroadcastStore } = require("../src/meeting-broadcast-store");
const { createMeetingBroadcastScheduler: createScheduler, validateMeetingInput, toUtcFromClubLocal, validateZoomUrl, classifyTelegramError } = require("../src/meeting-broadcast-service");
const { createMeetingBroadcastRuntime } = require("../src/meeting-broadcast-runtime");

// Existing tests use fixed clocks and no-op sleeps. Keep their focus on the
// scenario under test; rate-limit tests below opt in to an explicit interval.
function createMeetingBroadcastScheduler(options) {
  return createScheduler({ minSendIntervalMs: 0, ...options });
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meetings-"));
  const file = path.join(dir, "test.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys=ON");
  migrateDatabase(db);
  const store = createMeetingBroadcastStore(db);
  function admin(id = "880001", role = "owner") { db.prepare("INSERT OR REPLACE INTO admins(telegram_id,role) VALUES(?,?)").run(String(id), role); }
  function recipient({ id = "880101", preferred = "Telegram", consent = true } = {}) {
    const result = db.prepare(`INSERT INTO participants(first_name,last_name,phone,preferred_contact,phone_confirmed_at,personal_data_consent,consent_at,consent_version)
      VALUES('Тест','Участник',? ,?, ?, ?, ?, ?)`)
      .run(`+7999000${String(id).slice(-4)}`, preferred, "2026-01-01T00:00:00.000Z", consent ? 1 : 0, consent ? "2026-01-01T00:00:00.000Z" : null, consent ? "policy-test" : null);
    db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,'telegram',?)").run(result.lastInsertRowid, String(id));
    db.prepare("INSERT INTO telegram_private_chats(telegram_id,first_seen_at,last_seen_at) VALUES(?,?,?)").run(String(id), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    return Number(result.lastInsertRowid);
  }
  function draft({ actor = "880001", scheduledAt = new Date(Date.now() + 60_000).toISOString(), startsAt = new Date(Date.now() + 3_600_000).toISOString(), title = "Встреча клуба", zoomUrl = "https://zoom.us/j/123456789", note = null } = {}) {
    const id = store.createDraft({ title, startsAt, scheduledAt, zoomUrl, note, timezone: "Etc/UTC", createdBy: actor, now: new Date().toISOString() });
    assert.equal(store.confirmDraft(id, actor, new Date().toISOString()), true);
    return id;
  }
  return { dir, file, db, store, admin, recipient, draft, close() { try { db.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } } };
}

function fakeTelegram() {
  const sent = [];
  const api = { async sendMessage(chatId, text) { sent.push({ chatId: String(chatId), text }); return { message_id: sent.length }; } };
  return { api, sent };
}

test("близкое время предлагает новый 60-секундный отсчёт и не повторно переносит задание", async () => {
  const x = fixture();
  const envKeys = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const dbModule = require.resolve("../src/database");
  const meetingModule = require.resolve("../src/meeting-broadcasts");
  try {
    x.recipient({ id: "880102" });
    process.env.DB_PATH = path.join(x.dir, "bot.sqlite");
    process.env.OWNER_TELEGRAM_ID = "880001";
    process.env.DEMO_MODE = "false";
    process.env.CLUB_TIMEZONE = "Etc/UTC";
    process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
    delete require.cache[dbModule];
    delete require.cache[meetingModule];
    const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
    let currentTime = new Date("2030-06-01T09:59:30.000Z");
    const { registerMeetingBroadcasts, clearMeetingBroadcastState } = require("../src/meeting-broadcasts");
    registerMeetingBroadcasts(bot, {
      db: { getAdminRole: () => "owner" }, store: x.store, now: () => currentTime,
      env: { CLUB_TIMEZONE: "Etc/UTC", DEMO_MODE: "false", DEMO_BROADCAST_TELEGRAM_IDS: "" }
    });
    const sent = [];
    bot.api.config.use(async (_previous, _method, payload) => {
      sent.push(payload);
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
    });
    let updateId = 0;
    async function send(text) {
      await bot.handleUpdate({ update_id: ++updateId, message: {
        message_id: updateId, date: 1, chat: { id: 880001, type: "private" },
        from: { id: 880001, is_bot: false, first_name: "Test" }, text
      } });
      return sent.at(-1);
    }

    await send("➕ Создать встречу");
    await send("Тест близкого времени");
    await send("2030-06-01 10:10");
    await send("2030-06-01 10:00");
    await send("https://zoom.us/j/123");
    const preview = await send("Пропустить текст");
    assert.equal(x.store.get(1).scheduled_at, "2030-06-01T10:00:00.000Z");
    assert.equal(x.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "draft");
    assert.ok(preview.reply_markup.keyboard.flat().some((button) => button.text === "✅ Подтвердить рассылку"));
    const tooSoon = await send("✅ Подтвердить рассылку");
    assert.match(tooSoon.text, /обязательная задержка.*60 секунд/i);
    assert.deepEqual(tooSoon.reply_markup.keyboard.flat().map((button) => button.text), ["✅ Отправить через 60 секунд", "📅 Выбрать другое время", "⬅️ Назад"]);
    assert.equal(x.store.get(1).scheduled_at, "2030-06-01T10:00:00.000Z", "предложение не должно само сдвигать срок");

    currentTime = new Date("2030-06-01T09:59:35.000Z");
    const accepted = await send("✅ Отправить через 60 секунд");
    assert.match(accepted.text, /Фактическое время начала: 1 июн\. 2030 г\., 10:00 \(Etc\/UTC\)/);
    assert.equal(x.store.get(1).status, "scheduled");
    assert.equal(x.store.get(1).scheduled_at, "2030-06-01T10:00:35.000Z");
    assert.ok(accepted.reply_markup.keyboard.flat().some((button) => button.text === "⛔ Отменить рассылку"));
    const duplicate = await send("✅ Отправить через 60 секунд");
    assert.match(duplicate.text, /подтверждение уже обработано|устарело/i);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_broadcasts").get().n, 1);
    assert.equal(x.store.get(1).scheduled_at, "2030-06-01T10:00:35.000Z", "повторная кнопка не должна переносить уже созданное задание");
    const restartedDb = new Database(x.file);
    try {
      const restartedStore = createMeetingBroadcastStore(restartedDb);
      assert.equal(restartedStore.get(1).status, "scheduled");
      assert.equal(restartedStore.get(1).scheduled_at, "2030-06-01T10:00:35.000Z", "отсчёт сохраняется в SQLite после повторного открытия базы");
    } finally { restartedDb.close(); }

    currentTime = new Date("2030-06-01T10:00:30.000Z");
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => currentTime, sleep: async () => {} });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    await send("📅 Встречи и рассылки");
    await send("📜 История и статистика");
    const scheduledRow = sent.at(-1).reply_markup.keyboard.flat().find((button) => button.text.startsWith("#1 "));
    assert.ok(scheduledRow, "ожидающая запись должна оставаться доступной в истории после старой кнопки");
    await send(scheduledRow.text);
    const cancelled = await send("⛔ Отменить рассылку");
    assert.match(cancelled.text, /ни одно приглашение не отправлено/i);
    currentTime = new Date("2030-06-01T10:00:35.000Z");
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_broadcasts").get().n, 1);
    const stale = await send("✅ Подтвердить рассылку");
    assert.match(stale.text, /устарело/i);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_broadcasts").get().n, 1, "устаревшее подтверждение не создаёт дубликат");

    await send("➕ Создать встречу");
    await send("Встреча с другим временем");
    await send("2030-06-01 10:20");
    await send("2030-06-01 10:01");
    await send("https://zoom.us/j/123");
    await send("Пропустить текст");
    await send("✅ Подтвердить рассылку");
    const timePrompt = await send("📅 Выбрать другое время");
    assert.match(timePrompt.text, /дату и время отправки/i);
    const revisedPreview = await send("2030-06-01 10:05");
    assert.ok(/Предварительный просмотр приглашения/.test(revisedPreview.text), `timePrompt=${timePrompt.text}; reply=${revisedPreview.text}`);
    assert.equal(x.db.prepare("SELECT scheduled_at FROM meeting_broadcasts WHERE id=2").get().scheduled_at, "2030-06-01T10:05:00.000Z");
    await send("Отмена");

    await send("➕ Создать встречу");
    await send("Встреча начинается слишком рано");
    await send("2030-06-01 10:02");
    await send("2030-06-01 10:01");
    await send("https://zoom.us/j/123");
    await send("Пропустить текст");
    currentTime = new Date("2030-06-01T10:01:30.000Z");
    const tooCloseToMeeting = await send("✅ Подтвердить рассылку");
    assert.match(tooCloseToMeeting.text, /до начала встречи меньше времени/i);
    assert.deepEqual(tooCloseToMeeting.reply_markup.keyboard.flat().map((button) => button.text), ["✏️ Изменить время встречи", "❌ Отменить создание", "⬅️ Назад"]);
    const meetingPrompt = await send("✏️ Изменить время встречи");
    assert.match(meetingPrompt.text, /дату и время встречи/i);
    const changedMeetingTime = await send("2030-06-01 10:10");
    assert.match(changedMeetingTime.text, /в будущем|дату и время отправки/i, "если старое время отправки уже прошло, бот должен запросить новое");
    const replacementSchedule = await send("2030-06-01 10:05");
    assert.match(replacementSchedule.text, /Предварительный просмотр приглашения/);
    assert.match(sent.at(-1).text, /Предварительный просмотр приглашения/);
    assert.equal(x.db.prepare("SELECT starts_at FROM meetings WHERE title='Встреча начинается слишком рано'").get().starts_at, "2030-06-01T10:10:00.000Z");
    assert.equal(x.db.prepare("SELECT scheduled_at FROM meeting_broadcasts WHERE id=3").get().scheduled_at, "2030-06-01T10:05:00.000Z");
    await send("Отмена");
    assert.equal(x.store.get(3).status, "cancelled");

    await send("➕ Создать встречу");
    await send("Встреча для отмены из предупреждения");
    await send("2030-06-01 10:04");
    await send("2030-06-01 10:02");
    await send("https://zoom.us/j/123");
    await send("Пропустить текст");
    currentTime = new Date("2030-06-01T10:03:30.000Z");
    const blockedForCancel = await send("✅ Подтвердить рассылку");
    assert.match(blockedForCancel.text, /до начала встречи меньше времени/i);
    const cancelCreate = await send("❌ Отменить создание");
    assert.match(cancelCreate.text, /создание рассылки отменено/i);
    assert.equal(x.store.get(4).status, "cancelled");

    // Reopening a draft from SQLite has no in-memory form values. Both time
    // choices must restore them before asking for another answer.
    const reopenedId = x.store.createDraft({
      title: "Черновик из истории", startsAt: "2030-06-01T10:20:00.000Z",
      scheduledAt: "2030-06-01T10:04:00.000Z", zoomUrl: "https://zoom.us/j/123",
      timezone: "Etc/UTC", createdBy: "880001", now: currentTime.toISOString()
    });
    clearMeetingBroadcastState("880001");
    await send("📜 История и статистика");
    const reopenedLabel = sent.at(-1).reply_markup.keyboard.flat().find((button) => button.text.startsWith(`#${reopenedId} `));
    await send(reopenedLabel.text);
    await send("✅ Подтвердить рассылку");
    const reopenedPrompt = await send("📅 Выбрать другое время");
    assert.match(reopenedPrompt.text, /дату и время отправки/i);
    const reopenedPreview = await send("2030-06-01 10:10");
    assert.match(reopenedPreview.text, /Предварительный просмотр приглашения/);
    assert.equal(x.store.get(reopenedId).scheduled_at, "2030-06-01T10:10:00.000Z");

    const blockedId = x.store.createDraft({
      title: "Раннее начало из истории", startsAt: "2030-06-01T10:04:00.000Z",
      scheduledAt: "2030-06-01T10:03:45.000Z", zoomUrl: "https://zoom.us/j/123",
      timezone: "Etc/UTC", createdBy: "880001", now: currentTime.toISOString()
    });
    clearMeetingBroadcastState("880001");
    await send("📜 История и статистика");
    const blockedLabel = sent.at(-1).reply_markup.keyboard.flat().find((button) => button.text.startsWith(`#${blockedId} `));
    await send(blockedLabel.text);
    await send("✅ Подтвердить рассылку");
    const blockedPrompt = await send("✏️ Изменить время встречи");
    assert.match(blockedPrompt.text, /дату и время встречи/i);
    clearMeetingBroadcastState("880001");
  } finally {
    try { require("../src/database").closeDatabase(); } catch {}
    delete require.cache[meetingModule];
    delete require.cache[dbModule];
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    x.close();
  }
});

test("часовой пояс и Zoom URL проверяются, локальное время преобразуется однозначно", () => {
  assert.equal(toUtcFromClubLocal("2030-06-01 12:30", "Etc/UTC"), "2030-06-01T12:30:00.000Z");
  assert.throws(() => toUtcFromClubLocal("2030-06-01 12:30", "Not/AZone"), /часовым поясом/);
  assert.throws(() => toUtcFromClubLocal("2030-02-30 12:30", "Etc/UTC"), /некорректно/);
  assert.equal(validateZoomUrl("https://meetings.zoom.us/j/123"), "https://meetings.zoom.us/j/123");
  for (const url of ["http://zoom.us/j/1", "https://zoom.us.evil.example/j/1", "https://user@zoom.us/j/1", "https://example.com/zoom"]) assert.throws(() => validateZoomUrl(url), /HTTPS-ссылки/);
  assert.throws(() => validateMeetingInput({ title: "x", startsAt: "2030-06-02 12:00", scheduledAt: "2030-06-03 12:00", zoomUrl: "https://zoom.us/j/1" }, { timeZone: "Etc/UTC", now: new Date("2030-01-01") }), /до начала/);
});

test("Asia/Yekaterinburg: приглашение за 10 минут до встречи проходит, равное или более позднее время отклоняется", () => {
  const timeZone = "Asia/Yekaterinburg";
  const now = new Date("2026-10-25T00:00:00.000Z");
  const input = (scheduledAt, startsAt = "2026-11-05 19:30") => ({
    title: "Тест времени",
    startsAt,
    scheduledAt,
    zoomUrl: "https://zoom.us/j/123"
  });

  const accepted = validateMeetingInput(input("2026-11-05 19:20"), { timeZone, now });
  assert.equal(accepted.startsAt, "2026-11-05T14:30:00.000Z");
  assert.equal(accepted.scheduledAt, "2026-11-05T14:20:00.000Z");
  assert.throws(() => validateMeetingInput(input("2026-11-05 19:30"), { timeZone, now }), /до начала встречи/);
  assert.throws(() => validateMeetingInput(input("2026-11-05 19:40"), { timeZone, now }), /до начала встречи/);

  const earlier = validateMeetingInput(input("2026-11-05 19:00"), { timeZone, now });
  assert.equal(earlier.scheduledAt, "2026-11-05T14:00:00.000Z");

  const acrossMidnight = validateMeetingInput(input("2026-11-05 23:50", "2026-11-06 00:30"), { timeZone, now });
  assert.equal(acrossMidnight.scheduledAt, "2026-11-05T18:50:00.000Z");
  assert.equal(acrossMidnight.startsAt, "2026-11-05T19:30:00.000Z");
});

test("полный порядок обработчиков диагностирует сравнение и принимает 19:20 перед 19:30 в Екатеринбурге", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meeting-yekaterinburg-ui-"));
  const dbPath = path.join(dir, "ui.sqlite");
  const envKeys = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS", "TZ"];
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const modules = ["../src/database", "../src/admin", "../src/bot-handlers", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker", "../src/registration", "../src/profile", "../src/participant-service", "../src/registration-preview", "../src/demo-registration", "../src/myid", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/main-menu", "../src/request-limits", "../src/expiring-map"];
  for (const item of modules) delete require.cache[require.resolve(item)];
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T00:00:00.000Z") });
  process.env.DB_PATH = dbPath;
  process.env.OWNER_TELEGRAM_ID = "889301";
  process.env.DEMO_MODE = "false";
  process.env.CLUB_TIMEZONE = "Asia/Yekaterinburg";
  process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
  process.env.TZ = "Etc/UTC";
  const db = require("../src/database");
  const { registerBotHandlers } = require("../src/bot-handlers");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const cleanups = registerBotHandlers(bot);
  const sent = [];
  const diagnostics = [];
  const originalWarn = console.warn;
  console.warn = (line) => diagnostics.push(String(line));
  bot.api.config.use(async (_prev, _method, payload) => {
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let update = 0;
  async function send(text) {
    update += 1;
    await bot.handleUpdate({ update_id: update, message: { message_id: update, date: 1, chat: { id: 889301, type: "private" }, from: { id: 889301, is_bot: false, first_name: "Test" }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined } });
    return sent.at(-1);
  }

  try {
    assert.equal(db.getAdminRole("889301"), "owner");
    assert.notEqual(Intl.DateTimeFormat().resolvedOptions().timeZone, process.env.CLUB_TIMEZONE, "часовой пояс сервера отличается от часового пояса клуба");
    const adminMenu = await send("/admin");
    assert.match(adminMenu.text, /Административное меню/i);
    await send("📅 Встречи и рассылки");
    const titlePrompt = await send("➕ Создать встречу");
    assert.match(titlePrompt.text, /название встречи/i);
    const startPrompt = await send("Встреча для проверки времени");
    assert.match(startPrompt.text, /дату и время встречи/i);
    const invalidMeetingDate = await send("2026-11-31 19:30");
    assert.match(invalidMeetingDate.text, /некорректно/i);
    await send("2026-11-05 19:30");
    const invalidLaterTime = await send("2026-11-05 19:40");
    assert.match(invalidLaterTime.text, /Приглашение нужно отправить до начала встречи/);
    const invalidEqualTime = await send("2026-11-05 19:30");
    assert.match(invalidEqualTime.text, /Приглашение нужно отправить до начала встречи/);
    const schedulePrompt = await send("2026-11-05 19:20");
    assert.match(schedulePrompt.text, /ссылку Zoom/i, "после повторного ввода время рассылки за 10 минут принимается");

    const records = diagnostics.filter((line) => line.startsWith("[zoom-time-diagnostic] "))
      .map((line) => JSON.parse(line.slice("[zoom-time-diagnostic] ".length)));
    assert.equal(records.length, 2, "логируются только два отказа сравнения, а не персональные данные");
    assert.deepEqual(records.map(({ meeting_utc, scheduled_utc, difference_minutes, timezone, meeting_source, reason }) => ({ meeting_utc, scheduled_utc, difference_minutes, timezone, meeting_source, reason })), [
      { meeting_utc: "2026-11-05T14:30:00.000Z", scheduled_utc: "2026-11-05T14:40:00.000Z", difference_minutes: -10, timezone: "Asia/Yekaterinburg", meeting_source: "wizard_memory", reason: "send_time_not_before_meeting" },
      { meeting_utc: "2026-11-05T14:30:00.000Z", scheduled_utc: "2026-11-05T14:30:00.000Z", difference_minutes: 0, timezone: "Asia/Yekaterinburg", meeting_source: "wizard_memory", reason: "send_time_not_before_meeting" }
    ]);
    assert.equal(records[0].loaded_module_sha256, crypto.createHash("sha256").update(fs.readFileSync(require.resolve("../src/meeting-broadcasts"))).digest("hex"));
    assert.equal(records[0].process_id, process.pid);
    assert.doesNotMatch(diagnostics.join(" "), /zoom\.us|889301|Встреча для проверки времени|TEST_ONLY/i);

    await send("https://zoom.us/j/123456789");
    const preview = await send("Пропустить текст");
    assert.match(preview.text, /Предварительный просмотр приглашения/);

    const saved = db.db.prepare(`SELECT m.starts_at,b.scheduled_at,b.timezone FROM meetings m
      JOIN meeting_broadcasts b ON b.meeting_id=m.id`).get();
    assert.deepEqual(saved, {
      starts_at: "2026-11-05T14:30:00.000Z",
      scheduled_at: "2026-11-05T14:20:00.000Z",
      timezone: "Asia/Yekaterinburg"
    });
    await send("✅ Подтвердить рассылку");
    assert.equal(db.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "scheduled");

    await send("📅 Встречи и рассылки");
    await send("➕ Создать встречу");
    await send("Черновик, отменённый до сохранения");
    await send("2026-11-06 19:30");
    const cancel = await send("Отмена");
    assert.match(cancel.text, /Административное меню/i);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1, "отмена незавершённого мастера не создаёт запись встречи");

    await send("📅 Встречи и рассылки");
    await send("➕ Создать встречу");
    await send("Новая встреча после отмены");
    await send("2026-11-06 19:30");
    const secondSchedule = await send("2026-11-06 19:20");
    assert.match(secondSchedule.text, /ссылку Zoom/i);
    await send("https://zoom.us/j/123456789");
    await send("Пропустить текст");
    const secondSaved = db.db.prepare(`SELECT m.starts_at,b.scheduled_at FROM meetings m JOIN meeting_broadcasts b ON b.meeting_id=m.id WHERE m.title=?`).get("Новая встреча после отмены");
    assert.deepEqual(secondSaved, { starts_at: "2026-11-06T14:30:00.000Z", scheduled_at: "2026-11-06T14:20:00.000Z" });

    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    db.closeDatabase();
    const reopened = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const afterRestart = reopened.prepare(`SELECT m.starts_at,b.scheduled_at,b.timezone FROM meetings m
        JOIN meeting_broadcasts b ON b.meeting_id=m.id`).get();
      assert.deepEqual(afterRestart, saved, "повторное открытие SQLite не сдвигает сохранённые даты");
      assert.equal(reopened.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(reopened.pragma("foreign_key_check"), []);
    } finally { reopened.close(); }
  } finally {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.warn = originalWarn;
    for (const item of modules) delete require.cache[require.resolve(item)];
    t.mock.timers.reset();
  }
});

test("кнопка Назад проходит все шаги мастера, сохраняет введённое и отменяет созданный черновик", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meeting-back-ui-"));
  const envKeys = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS"];
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const modules = ["../src/database", "../src/admin", "../src/bot-handlers", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker", "../src/registration", "../src/profile", "../src/participant-service", "../src/registration-preview", "../src/demo-registration", "../src/myid", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/main-menu", "../src/request-limits", "../src/expiring-map"];
  for (const item of modules) delete require.cache[require.resolve(item)];
  process.env.DB_PATH = path.join(dir, "wizard.sqlite");
  process.env.OWNER_TELEGRAM_ID = "889311";
  process.env.DEMO_MODE = "false";
  process.env.CLUB_TIMEZONE = "Asia/Yekaterinburg";
  process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
  const db = require("../src/database");
  const { registerBotHandlers } = require("../src/bot-handlers");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const cleanups = registerBotHandlers(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, ...payload });
    if (method !== "sendMessage") return { ok: true, result: true };
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text) {
    const id = ++updateId;
    await bot.handleUpdate({ update_id: id, message: { message_id: id, date: 1, chat: { id: 889311, type: "private" }, from: { id: 889311, is_bot: false, first_name: "Test" }, text } });
    return sent.filter((item) => item.method === "sendMessage").at(-1);
  }
  try {
    await send("/admin");
    await send("📅 Встречи и рассылки");
    await send("➕ Создать встречу");
    await send("Навигация по мастеру");
    await send("⬅️ Назад");
    assert.match(sent.at(-1).text, /название встречи[\s\S]*Текущее значение: Навигация по мастеру/i);
    await send("Навигация по мастеру");
    await send("2026-11-05 19:30");
    const startPrompt = await send("⬅️ Назад");
    assert.match(startPrompt.text, /дату и время встречи[\s\S]*Текущее значение: 2026-11-05 19:30/i);
    const scheduleAgain = await send("2026-11-06 19:30");
    assert.match(scheduleAgain.text, /дату и время отправки/i);
    const revisedStartPrompt = await send("⬅️ Назад");
    assert.match(revisedStartPrompt.text, /Текущее значение: 2026-11-06 19:30/i);
    const revisedSchedulePrompt = await send("2026-11-06 19:30");
    assert.match(revisedSchedulePrompt.text, /дату и время отправки/i);
    const zoomPromptInitial = await send("2026-11-06 19:20");
    assert.match(zoomPromptInitial.text, /ссылку Zoom/i);
    const backToSchedule = await send("⬅️ Назад");
    assert.match(backToSchedule.text, /дату и время отправки[\s\S]*Текущее значение: 2026-11-06 19:20/i);
    const scheduleAgainFromBack = await send("2026-11-06 19:20");
    assert.match(scheduleAgainFromBack.text, /ссылку Zoom/i);
    const zoomPrompt = await send("https://zoom.us/j/123456789");
    assert.match(zoomPrompt.text, /короткий текст/i);
    const backToZoom = await send("⬅️ Назад");
    assert.match(backToZoom.text, /ссылку Zoom[\s\S]*Текущее значение: https:\/\/zoom\.us\/j\/123456789/i);
    await send("https://zoom.us/j/123456789");
    const preview = await send("Пропустить текст");
    assert.match(preview.text, /Предварительный просмотр приглашения/);
    const meetingCount = db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n;
    const backFromPreview = await send("⬅️ Назад");
    assert.match(backFromPreview.text, /короткий текст/i);
    const preservedZoom = await send("⬅️ Назад");
    assert.match(preservedZoom.text, /ссылку Zoom[\s\S]*Текущее значение: https:\/\/zoom\.us\/j\/123456789/i);
    await send("⬅️ Назад");
    const canceled = await send("Отмена");
    assert.match(canceled.text, /Административное меню/i);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, meetingCount, "повторные переходы назад не создают дубль встречи");
    const cancelledDraft = db.db.prepare("SELECT status FROM meeting_broadcasts").get();
    assert.equal(cancelledDraft.status, "cancelled", "отмена после возврата из preview завершает новый черновик");
    assert.ok(backFromPreview.reply_markup.keyboard.some((row) => row.some((button) => button.text === "⬅️ Назад")));
  } finally {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const item of modules) delete require.cache[require.resolve(item)];
  }
});

test("частично заполненный мастер не переносит старое время через перезапуск процесса", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meeting-restart-ui-"));
  const dbPath = path.join(dir, "ui.sqlite");
  const envKeys = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS", "TZ"];
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const modules = ["../src/database", "../src/admin", "../src/bot-handlers", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker", "../src/registration", "../src/profile", "../src/participant-service", "../src/registration-preview", "../src/demo-registration", "../src/myid", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/main-menu", "../src/request-limits", "../src/expiring-map"];
  for (const item of modules) delete require.cache[require.resolve(item)];
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T00:00:00.000Z") });
  process.env.DB_PATH = dbPath;
  process.env.OWNER_TELEGRAM_ID = "889302";
  process.env.DEMO_MODE = "false";
  process.env.CLUB_TIMEZONE = "Asia/Yekaterinburg";
  process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
  process.env.TZ = "Etc/UTC";

  function startIsolatedBot() {
    for (const item of modules) delete require.cache[require.resolve(item)];
    const db = require("../src/database");
    const { registerBotHandlers } = require("../src/bot-handlers");
    const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
    const cleanups = registerBotHandlers(bot);
    const sent = [];
    bot.api.config.use(async (_prev, _method, payload) => {
      sent.push(payload);
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
    });
    let update = 0;
    async function send(text) {
      update += 1;
      await bot.handleUpdate({ update_id: update, message: { message_id: update, date: 1, chat: { id: 889302, type: "private" }, from: { id: 889302, is_bot: false, first_name: "Test" }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined } });
      return sent.at(-1);
    }
    return { db, cleanups, send };
  }

  let harness = startIsolatedBot();
  try {
    await harness.send("/admin");
    await harness.send("📅 Встречи и рассылки");
    await harness.send("➕ Создать встречу");
    await harness.send("Незавершённая встреча до перезапуска");
    await harness.send("2026-11-05 19:30");
    assert.equal(harness.db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 0, "пока мастер не завершён, его данные находятся в оперативной памяти");
    for (const cleanup of harness.cleanups) if (typeof cleanup === "function") cleanup();
    harness.db.closeDatabase();

    harness = startIsolatedBot();
    await harness.send("/admin");
    await harness.send("📅 Встречи и рассылки");
    const freshPrompt = await harness.send("➕ Создать встречу");
    assert.match(freshPrompt.text, /название встречи/i);
    const meetingPrompt = await harness.send("Новая встреча после перезапуска");
    assert.match(meetingPrompt.text, /дату и время встречи/i);
    const datePrompt = await harness.send("2026-11-06 19:30");
    assert.match(datePrompt.text, /дату и время отправки/i);
    const nextPrompt = await harness.send("2026-11-06 19:20");
    assert.match(nextPrompt.text, /ссылку Zoom/i);
    await harness.send("https://zoom.us/j/123456789");
    await harness.send("Пропустить текст");
    const saved = harness.db.db.prepare(`SELECT m.starts_at,b.scheduled_at FROM meetings m JOIN meeting_broadcasts b ON b.meeting_id=m.id WHERE m.title=?`).get("Новая встреча после перезапуска");
    assert.deepEqual(saved, { starts_at: "2026-11-06T14:30:00.000Z", scheduled_at: "2026-11-06T14:20:00.000Z" });
    assert.equal(harness.db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1, "в памяти старого мастера не осталось предыдущей встречи");
  } finally {
    for (const cleanup of harness.cleanups) if (typeof cleanup === "function") cleanup();
    try { harness.db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const item of modules) delete require.cache[require.resolve(item)];
    t.mock.timers.reset();
  }
});

test("создание и отмена рассылки сохраняются в SQLite", () => {
  const x = fixture();
  try {
    const id = x.draft();
    assert.equal(x.store.get(id).status, "scheduled");
    assert.equal(x.store.cancel(id, "880001", new Date().toISOString()), true);
    assert.equal(x.store.claimNext(new Date(Date.now() + 90_000).toISOString(), "worker", 1000), null);
    assert.equal(x.store.summary(id, "880001").status, "cancelled");
  } finally { x.close(); }
});

test("запланированное время можно изменить, а повторный запуск видит запись", () => {
  const x = fixture();
  try {
    const id = x.draft();
    const updated = { title: "Обновлённая встреча", startsAt: "2030-01-02T12:00:00.000Z", scheduledAt: "2030-01-02T10:00:00.000Z", zoomUrl: "https://zoom.us/j/123", note: "Тест", timezone: "Etc/UTC" };
    assert.equal(x.store.updateScheduled(id, "880001", updated, new Date().toISOString()), true);
    assert.equal(x.store.get(id).title, updated.title);
    assert.equal(x.store.get(id).scheduled_at, updated.scheduledAt);
  } finally { x.close(); }
});

test("планировщик отправляет только подходящему активному Telegram-получателю и не отправляет повторно", async () => {
  const x = fixture();
  try {
    const participant = x.recipient();
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {}, workerId: "worker-1" });
    const first = await scheduler.tick();
    assert.deepEqual(first.map((item) => item.status), ["sent"]);
    assert.equal(telegram.sent.length, 1);
    assert.equal(x.store.summary(id, "880001").deliveries.sent, 1);
    await scheduler.tick();
    assert.equal(telegram.sent.length, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_deliveries WHERE participant_id=?").get(participant).n, 1);
  } finally { x.close(); }
});

test("организационные приглашения не зависят от preferred_contact, а общее согласие, телефон и личный чат обязательны", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880201", preferred: "Telegram" });
    const phonePreferred = x.recipient({ id: "880202", preferred: "Телефон" });
    const emailPreferred = x.recipient({ id: "880203", preferred: "Электронная почта" });
    x.recipient({ id: "880204", preferred: "Telegram", consent: false });
    const unconfirmed = x.recipient({ id: "880205" });
    x.db.prepare("UPDATE participants SET phone_confirmed_at=NULL WHERE id=?").run(unconfirmed);
    x.recipient({ id: "880206" });
    x.db.prepare("DELETE FROM telegram_private_chats WHERE telegram_id='880206'").run();

    const preview = x.store.previewRecipients();
    assert.equal(preview.eligible, 3, "Telegram, телефон и электронная почта одинаково допускаются к организационным уведомлениям Telegram");
    assert.equal(preview.total, 6);
    assert.equal(preview.excluded, 3);
    assert.ok(preview.reasons.some(({ reason }) => reason === "Нет действующего согласия на обработку"));
    assert.ok(preview.reasons.some(({ reason }) => reason === "Телефон не подтверждён"));
    assert.ok(preview.reasons.some(({ reason }) => reason === "Личный чат с ботом не открыт"));

    const broadcastId = x.draft();
    const beforeCount = x.store.previewRecipients().eligible;
    const sendTime = new Date(Date.now() + 61_000).toISOString();
    const sending = x.store.claimNext(sendTime, "worker-test", 60_000);
    assert.ok(sending);
    assert.equal(x.store.ensureRecipients(broadcastId), beforeCount);
    const deliveryIds = x.store.nextDeliveries(broadcastId, sendTime);
    assert.equal(deliveryIds.length, beforeCount);
    const telegramIds = deliveryIds.map((id) => x.store.getDelivery(id).messenger_user_id);
    assert.equal(new Set(telegramIds).size, telegramIds.length, "каждый Telegram ID появляется в очереди один раз");
    const deliveredIds = deliveryIds.map((id) => x.store.getDelivery(id).messenger_user_id).sort();
    assert.deepEqual(deliveredIds, ["880201", "880202", "880203"]);

    const phoneAccount = x.db.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=?").get(phonePreferred).messenger_user_id;
    const emailAccount = x.db.prepare("SELECT messenger_user_id FROM accounts WHERE participant_id=?").get(emailPreferred).messenger_user_id;
    const phoneDelivery = deliveryIds.map((id) => x.store.getDelivery(id)).find((row) => row.messenger_user_id === phoneAccount);
    const emailDelivery = deliveryIds.map((id) => x.store.getDelivery(id)).find((row) => row.messenger_user_id === emailAccount);
    x.db.prepare("UPDATE participants SET consent_withdrawn_at=? WHERE id=?").run(sendTime, phonePreferred);
    assert.equal(x.store.reserveDeliverySend(phoneDelivery.id, sendTime, 60_000, broadcastId, "worker-test").status, "unavailable", "отзыв общего согласия после выборки блокирует отправку");
    assert.equal(x.store.reserveDeliverySend(emailDelivery.id, sendTime, 60_000, broadcastId, "worker-test").status, "reserved");
  } finally { x.close(); }
});

test("Отправить сейчас выдерживает 60 секунд, а отмена на 40-й секунде предотвращает отправку", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880109" });
    const base = new Date("2030-06-01T10:00:00.000Z");
    const id = x.draft({ scheduledAt: "2030-06-01T11:00:00.000Z", startsAt: "2030-06-01T11:30:00.000Z" });
    assert.equal(x.store.sendNow(id, "880001", base.toISOString()), true);
    assert.equal(x.store.get(id).scheduled_at, "2030-06-01T10:01:00.000Z");
    let time = new Date(base.getTime() + 30_000);
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => time, sleep: async () => {} });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    time = new Date(base.getTime() + 40_000);
    assert.equal(x.store.cancel(id, "880001", time.toISOString()), true);
    time = new Date(base.getTime() + 60_000);
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.store.get(id).status, "cancelled");
  } finally { x.close(); }
});

test("рассылка без отмены начинает отправку не раньше 60-й секунды", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880110" });
    const base = new Date("2030-06-01T10:00:00.000Z");
    const id = x.draft({ scheduledAt: "2030-06-01T11:00:00.000Z", startsAt: "2030-06-01T11:30:00.000Z" });
    x.store.sendNow(id, "880001", base.toISOString());
    let time = new Date(base.getTime() + 59_999);
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => time, sleep: async () => {} });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    time = new Date(base.getTime() + 60_000);
    assert.deepEqual((await scheduler.tick()).map((item) => item.status), ["sent"]);
    assert.equal(telegram.sent.length, 1);
    assert.equal(x.store.summary(id).deliveries.sent, 1);
  } finally { x.close(); }
});

test("запланированная рассылка начинает отправку только в сохранённое время", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880108" });
    const id = x.draft({ scheduledAt: "2030-06-01T10:30:00.000Z", startsAt: "2030-06-01T11:00:00.000Z" });
    const telegram = fakeTelegram();
    let time = new Date("2030-06-01T10:29:59.999Z");
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => time, sleep: async () => {} });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.store.get(id).scheduled_at, "2030-06-01T10:30:00.000Z");
    time = new Date("2030-06-01T10:30:00.000Z");
    assert.deepEqual((await scheduler.tick()).map((item) => item.status), ["sent"]);
    assert.equal(telegram.sent.length, 1);
  } finally { x.close(); }
});

test("подтверждения через 5, 15, 30, 45 и 60 секунд не переносят срок по кругу", () => {
  const x = fixture();
  try {
    const created = new Date("2030-06-01T10:00:00.000Z");
    const id = x.store.createDraft({
      title: "Отложенная встреча", startsAt: "2030-06-01T10:05:00.000Z", scheduledAt: "2030-06-01T10:00:30.000Z",
      zoomUrl: "https://zoom.us/j/123", timezone: "Etc/UTC", createdBy: "880001", now: created.toISOString()
    });
    for (const seconds of [5, 15, 30, 45, 60]) {
      assert.equal(x.store.confirmDraft(id, "880001", new Date(created.getTime() + seconds * 1000).toISOString(), { deferPast: true }), "too_soon");
      assert.equal(x.store.get(id).scheduled_at, "2030-06-01T10:00:30.000Z", `срок не должен сдвигаться после ${seconds} секунд`);
      assert.equal(x.store.get(id).status, "draft");
    }
    assert.equal(x.store.sendNow(id, "880001", "2030-06-01T10:01:00.000Z"), true);
    assert.equal(x.store.get(id).status, "scheduled");
    assert.equal(x.store.get(id).scheduled_at, "2030-06-01T10:02:00.000Z");
  } finally { x.close(); }
});

test("ожидание рассылки переживает создание нового подключения и двух планировщиков", async () => {
  const x = fixture();
  const second = new Database(x.file, { timeout: 5000 });
  try {
    x.recipient({ id: "880111" });
    const base = new Date("2030-06-01T10:00:00.000Z");
    const id = x.draft({ scheduledAt: "2030-06-01T11:00:00.000Z", startsAt: "2030-06-01T11:30:00.000Z" });
    x.store.sendNow(id, "880001", base.toISOString());
    const store2 = createMeetingBroadcastStore(second);
    const telegram = fakeTelegram();
    let time = new Date(base.getTime() + 30_000);
    const options = { adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => time, sleep: async () => {} };
    const firstPlanner = createMeetingBroadcastScheduler({ ...options, store: x.store, workerId: "delay-planner-a" });
    const restartedPlanner = createMeetingBroadcastScheduler({ ...options, store: store2, workerId: "delay-planner-b" });
    assert.deepEqual(await restartedPlanner.tick(), []);
    assert.equal(telegram.sent.length, 0);
    time = new Date(base.getTime() + 60_000);
    const result = await Promise.all([firstPlanner.tick(), restartedPlanner.tick()]);
    assert.equal(telegram.sent.length, 1);
    assert.equal(result.flat().filter((item) => item.status === "sent").length, 1);
    assert.equal(x.store.get(id).status, "completed");
  } finally { try { second.close(); } catch {} x.close(); }
});

test("экстренная остановка до первой отправки сохраняется и не возобновляется после перезапуска", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880111" });
    x.recipient({ id: "880112" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const active = x.store.claimNext(new Date().toISOString(), "worker-stop-before", 60_000);
    assert.equal(active.id, id);
    assert.equal(x.store.ensureRecipients(id), 2);
    assert.equal(x.store.requestStop(id, new Date().toISOString()), "stopped");
    assert.equal(x.store.requestStop(id, new Date().toISOString()), "already_stopped");

    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {}, workerId: "restart-after-stop" });
    assert.deepEqual(await scheduler.tick(), []);
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.store.summary(id, "880001").status, "cancelled");
    assert.equal(x.store.summary(id, "880001").deliveries.pending, 2);
  } finally { x.close(); }
});

test("остановка после первой успешной доставки оставляет остальные неотправленными", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880121" });
    x.recipient({ id: "880122" });
    x.recipient({ id: "880123" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    let stopped = false;
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), workerId: "stop-after-first",
      minSendIntervalMs: 50,
      sleep: async () => { if (!stopped) { stopped = true; assert.equal(x.store.requestStop(id, new Date().toISOString()), "stopped"); } }
    });
    const result = await scheduler.tick();
    assert.deepEqual(result.map((item) => item.status), ["sent"]);
    assert.equal(telegram.sent.length, 1);
    const summary = x.store.summary(id, "880001");
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.deliveries.sent, 1);
    assert.equal(summary.deliveries.pending, 2);
    assert.equal(summary.deliveries.sending || 0, 0);
  } finally { x.close(); }
});

test("остановка во время вызова Telegram ждёт только этот вызов и сохраняет sent", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880131" });
    x.recipient({ id: "880132" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    let entered;
    const apiEntered = new Promise((resolve) => { entered = resolve; });
    let finishApi;
    const apiGate = new Promise((resolve) => { finishApi = resolve; });
    const telegram = { sent: [], async sendMessage(chatId, text) { this.sent.push({ chatId, text }); entered(); await apiGate; } };
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {}, workerId: "in-flight-stop" });
    const ticking = scheduler.tick();
    await apiEntered;
    assert.equal(x.store.requestStop(id, new Date().toISOString()), "stopped");
    finishApi();
    const result = await ticking;
    assert.deepEqual(result.map((item) => item.status), ["sent"]);
    assert.equal(telegram.sent.length, 1);
    const summary = x.store.summary(id, "880001");
    assert.equal(summary.deliveries.sent, 1);
    assert.equal(summary.deliveries.pending, 1);
    assert.equal(summary.status, "cancelled");
  } finally { x.close(); }
});

test("неопределённый ответ текущего вызова остаётся uncertain после остановки", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880141" });
    x.recipient({ id: "880142" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    let entered;
    const apiEntered = new Promise((resolve) => { entered = resolve; });
    let rejectApi;
    const apiGate = new Promise((_resolve, reject) => { rejectApi = reject; });
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store,
      adapters: { telegram: { async sendMessage() { entered(); await apiGate; } } },
      getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {}, workerId: "uncertain-stop"
    });
    const ticking = scheduler.tick();
    await apiEntered;
    assert.equal(x.store.requestStop(id, new Date().toISOString()), "stopped");
    rejectApi(new Error("simulated timeout"));
    await ticking;
    const summary = x.store.summary(id, "880001");
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.deliveries.uncertain, 1);
    assert.equal(summary.deliveries.pending, 1);
  } finally { x.close(); }
});

test("остановленная отправка живого владельца не перехватывается после истечения аренды", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880145" });
    x.recipient({ id: "880146" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const now = new Date();
    const leaseMs = 1000;
    assert.equal(x.store.claimNext(now.toISOString(), "crashed-worker", leaseMs).id, id);
    x.store.ensureRecipients(id);
    const deliveryId = x.store.nextDeliveries(id, now.toISOString())[0];
    const reservation = x.store.reserveDeliverySend(deliveryId, now.toISOString(), leaseMs, id, "crashed-worker");
    assert.equal(reservation.status, "reserved");
    assert.equal(x.store.requestStop(id, now.toISOString()), "stopped");

    const telegram = fakeTelegram();
    const restarted = createMeetingBroadcastScheduler({
      store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner",
      now: () => new Date(now.getTime() + leaseMs + 1), sleep: async () => {}, workerId: "restarted-worker"
    });
    assert.deepEqual(await restarted.tick(), []);
    const summary = x.store.summary(id, "880001");
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.deliveries.sending, 1);
    assert.equal(summary.deliveries.pending, 1);
    assert.equal(telegram.sent.length, 0);
    assert.ok(x.store.getSenderState().sender_token);
  } finally { x.close(); }
});

test("два планировщика не начинают новую отправку после stop, записанного вторым SQLite-подключением", async () => {
  const x = fixture();
  const secondDb = new Database(x.file);
  secondDb.pragma("foreign_keys=ON");
  try {
    x.recipient({ id: "880151" });
    x.recipient({ id: "880152" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const store2 = createMeetingBroadcastStore(secondDb);
    let entered;
    const apiEntered = new Promise((resolve) => { entered = resolve; });
    let finishApi;
    const apiGate = new Promise((resolve) => { finishApi = resolve; });
    const telegram = { sends: 0, async sendMessage() { this.sends += 1; entered(); await apiGate; } };
    const options = { adapters: { telegram }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} };
    const first = createMeetingBroadcastScheduler({ ...options, store: x.store, workerId: "two-schedulers-a" });
    const second = createMeetingBroadcastScheduler({ ...options, store: store2, workerId: "two-schedulers-b" });
    const ticking = first.tick();
    await apiEntered;
    await second.tick();
    assert.equal(telegram.sends, 1, "вторая аренда не должна начать параллельную отправку");
    assert.equal(store2.requestStop(id, new Date().toISOString()), "stopped");
    finishApi();
    await ticking;
    await second.tick();
    assert.equal(telegram.sends, 1);
    assert.equal(store2.summary(id, "880001").status, "cancelled");
    assert.equal(store2.summary(id, "880001").deliveries.sent, 1);
    assert.equal(store2.summary(id, "880001").deliveries.pending, 1);
  } finally { secondDb.close(); x.close(); }
});

test("конфигурация планировщика из точки входа вызывает Telegram API через adapters.telegram", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880102" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    // Тот же composition helper используется src/bot.js; вместо реального bot.api
    // передаём подмену, поэтому тест не обращается к Telegram.
    const scheduler = createMeetingBroadcastRuntime({
      database: { db: x.db, getAdminRole: () => "owner" },
      telegramApi: telegram.api,
      demoMode: false,
      demoAdminIds: [],
      now: () => new Date(),
      sleep: async () => {}
    });
    await scheduler.tick();
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, "880102");
    assert.equal(x.store.get(id).status, "completed");
  } finally { x.close(); }
});

test("планировщик отказывается запускать рассылки без Telegram-адаптера",…1167 tokens truncated…PrivateChat = x.recipient({ id: "880114" });
    x.db.prepare("DELETE FROM telegram_private_chats WHERE telegram_id=?").run("880114");
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    const recipients = x.db.prepare("SELECT participant_id,messenger_user_id FROM meeting_deliveries WHERE broadcast_id=?").all(id);
    assert.deepEqual(recipients.map((row) => row.participant_id), [good, otherChannel]);
    assert.equal(recipients.some((row) => [noConsent, noPrivateChat].includes(row.participant_id)), false);
    assert.equal(telegram.sent.length, 2);
  } finally { x.close(); }
});

test("получатель, утративший подтверждение телефона перед атомарным резервированием, не получает приглашение", async () => {
  const x = fixture();
  const secondDb = new Database(x.file, { timeout: 5000 });
  try {
    const participant = x.recipient({ id: "880115" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const originalReserve = x.store.reserveDeliverySend;
    x.store.reserveDeliverySend = (...args) => {
      // Simulate another process revoking verification after recipient
      // selection but before the final reservation transaction.
      secondDb.prepare("UPDATE participants SET phone_confirmed_at=NULL WHERE id=?").run(participant);
      return originalReserve(...args);
    };
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.store.summary(id, "880001").deliveries.unavailable, 1);
    assert.equal(x.db.prepare("SELECT last_error_code FROM meeting_deliveries WHERE broadcast_id=?").get(id).last_error_code, "RECIPIENT_NOT_ELIGIBLE");
    assert.equal(x.db.prepare("SELECT phone_confirmed_at FROM participants WHERE id=?").get(participant).phone_confirmed_at, null);
  } finally { secondDb.close(); x.close(); }
});

test("отзыв согласия или удаление анкеты после резервирования блокирует вызов Telegram API", async () => {
  for (const change of ["withdraw_consent", "delete_participant"]) {
    const x = fixture();
    const secondDb = new Database(x.file, { timeout: 5000 });
    try {
      const participant = x.recipient({ id: change === "withdraw_consent" ? "880116" : "880120" });
      const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
      const reserve = x.store.reserveDeliverySend;
      x.store.reserveDeliverySend = (...args) => {
        const result = reserve(...args);
        assert.equal(result.status, "reserved");
        if (change === "withdraw_consent") {
          secondDb.prepare("UPDATE participants SET personal_data_consent=0,consent_withdrawn_at=? WHERE id=?")
            .run(new Date().toISOString(), participant);
        } else {
          secondDb.prepare("DELETE FROM participants WHERE id=?").run(participant);
        }
        return result;
      };
      const telegram = fakeTelegram();
      const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
      await scheduler.tick();
      assert.equal(telegram.sent.length, 0, `${change}: API не должен вызываться`);
      assert.equal(x.store.summary(id).deliveries.unavailable, 1, `${change}: доставка фиксируется как недоступная`);
      assert.equal(x.db.prepare("SELECT last_error_code FROM meeting_deliveries WHERE broadcast_id=?").get(id).last_error_code, "RECIPIENT_NOT_ELIGIBLE");
      assert.equal(x.store.getSenderState().sender_token, null, "эксклюзивное право освобождается после пропуска");
      assert.equal(x.db.prepare("SELECT next_allowed_at FROM meeting_send_rate_limit_state WHERE singleton_id=1").get().next_allowed_at, null,
        "пропущенный получатель не расходует интервал отправки");
      if (change === "withdraw_consent") {
        assert.ok(x.db.prepare("SELECT consent_withdrawn_at FROM participants WHERE id=?").get(participant).consent_withdrawn_at);
      } else {
        assert.equal(x.db.prepare("SELECT 1 FROM participants WHERE id=?").get(participant), undefined);
      }
    } finally { secondDb.close(); x.close(); }
  }
});

test("остановка, записанная до резервирования, запрещает вызов Telegram API", async () => {
  const x = fixture();
  const secondDb = new Database(x.file, { timeout: 5000 });
  try {
    x.recipient({ id: "880117" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const secondStore = createMeetingBroadcastStore(secondDb);
    const reserve = x.store.reserveDeliverySend;
    let didStop = false;
    x.store.reserveDeliverySend = (...args) => {
      if (!didStop) {
        didStop = true;
        assert.equal(secondStore.requestStop(id, new Date().toISOString()), "stopped");
      }
      return reserve(...args);
    };
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    assert.equal(telegram.sent.length, 0);
    assert.equal(x.store.summary(id).status, "cancelled");
    assert.equal(x.store.summary(id).deliveries.pending, 1);
  } finally { secondDb.close(); x.close(); }
});

test("остановка после фиксации резервации не теряет результат уже зарезервированной доставки", async () => {
  const x = fixture();
  const secondDb = new Database(x.file, { timeout: 5000 });
  try {
    x.recipient({ id: "880118" });
    x.recipient({ id: "880119" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const secondStore = createMeetingBroadcastStore(secondDb);
    const reserve = x.store.reserveDeliverySend;
    let didStop = false;
    x.store.reserveDeliverySend = (...args) => {
      const result = reserve(...args);
      if (result.status === "reserved" && !didStop) {
        didStop = true;
        assert.equal(secondStore.requestStop(id, new Date().toISOString()), "stopped");
      }
      return result;
    };
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    const summary = x.store.summary(id);
    assert.equal(telegram.sent.length, 1);
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.deliveries.sent, 1);
    assert.equal(summary.deliveries.pending, 1);
  } finally { secondDb.close(); x.close(); }
});

test("удалённый участник и отозванное согласие повторно проверяются перед API", async () => {
  for (const scenario of ["withdrawn", "deleted"]) {
    const x = fixture();
    try {
      const participant = x.recipient({ id: scenario === "withdrawn" ? "880121" : "880122" });
      const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
      if (scenario === "withdrawn") x.db.prepare("UPDATE participants SET consent_withdrawn_at=? WHERE id=?").run(new Date().toISOString(), participant);
      else x.db.prepare("DELETE FROM participants WHERE id=?").run(participant);
      const telegram = fakeTelegram();
      const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
      await scheduler.tick();
      assert.equal(telegram.sent.length, 0, scenario);
      assert.equal(x.store.get(id).status, "failed");
    } finally { x.close(); }
  }
});

test("два связанных мессенджера не создают дубли: используется Telegram только при выборе Telegram", async () => {
  const x = fixture();
  try {
    const participant = x.recipient({ id: "880131", preferred: "Telegram" });
    x.db.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,'max','MAX-TEST-131')").run(participant);
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    assert.equal(telegram.sent.length, 1);
    assert.deepEqual(x.db.prepare("SELECT platform,messenger_user_id FROM meeting_deliveries WHERE broadcast_id=?").all(id), [{ platform: "telegram", messenger_user_id: "880131" }]);
  } finally { x.close(); }
});

test("Telegram 429 учитывает retry_after и временная ошибка повторяется без повтора успешных", async () => {
  const x = fixture();
  try {
    const participant = x.recipient({ id: "880141" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    let time = new Date();
    let calls = 0;
    const api = { async sendMessage() { calls += 1; if (calls === 1) { const error = new Error("payload intentionally ignored"); error.error_code = 429; error.parameters = { retry_after: 9 }; throw error; } return { message_id: 1 }; } };
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time, sleep: async () => {} });
    await scheduler.tick();
    assert.equal(x.store.summary(id, "880001").deliveries.temporary_error, 1);
    assert.equal(x.db.prepare("SELECT last_error_code FROM meeting_deliveries WHERE broadcast_id=?").get(id).last_error_code, "TELEGRAM_RATE_LIMIT");
    time = new Date(time.getTime() + 10_000);
    await scheduler.tick();
    assert.equal(calls, 2);
    assert.equal(x.store.summary(id, "880001").deliveries.sent, 1);
    assert.equal(x.db.prepare("SELECT messenger_user_id FROM meeting_deliveries WHERE participant_id=?").get(participant).messenger_user_id, "880141");
  } finally { x.close(); }
});

test("ошибка API с неопределённым результатом не запускает слепой повтор", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880142" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    let calls = 0;
    const time = new Date();
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store,
      adapters: { telegram: { sendMessage: async () => { calls += 1; throw new Error("network timeout"); } } },
      getAdminRole: () => "owner", now: () => time, sleep: async () => {}, leaseMs: 1000
    });
    await scheduler.tick();
    assert.equal(calls, 1);
    assert.equal(x.store.get(id).status, "failed");
    assert.equal(x.store.get(id).last_error_code, "DELIVERY_RESULT_REQUIRES_REVIEW");
    assert.equal(x.store.summary(id, "880001").deliveries.uncertain, 1);
    assert.ok(x.db.prepare("SELECT next_allowed_at FROM meeting_send_rate_limit_state WHERE singleton_id=1").get().next_allowed_at,
      "неопределённая сетевая попытка тоже проходит через общий лимитер");
    await scheduler.tick();
    assert.equal(calls, 1);
  } finally { x.close(); }
});

test("ошибка записи неопределённого результата удерживает право отправки до подтверждённого восстановления", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880146" });
    x.recipient({ id: "880147" });
    let time = new Date();
    const id = x.draft({ scheduledAt: new Date(time.getTime() - 1000).toISOString(), startsAt: new Date(time.getTime() + 3_600_000).toISOString() });
    let calls = 0;
    const originalComplete = x.store.completeDeliverySend;
    x.store.completeDeliverySend = () => { const error = new Error("synthetic lock"); error.code = "SQLITE_BUSY"; throw error; };
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store,
      adapters: { telegram: { async sendMessage() { calls += 1; throw new Error("network timeout"); } } },
      getAdminRole: () => "owner", now: () => time, sleep: async () => {}, leaseMs: 1000
    });
    await assert.rejects(scheduler.tick(), /synthetic lock/);
    assert.equal(x.db.prepare("SELECT status FROM meeting_deliveries WHERE broadcast_id=? ORDER BY id LIMIT 1").get(id).status, "sending");
    const owner = x.store.getSenderState();
    assert.ok(owner.sender_token);
    assert.throws(() => x.store.recoverAbandonedSender(owner.sender_token, time.toISOString()), /ещё работает/);
    x.store.completeDeliverySend = originalComplete;
    time = new Date(time.getTime() + 2000);
    const recovered = await scheduler.tick();
    assert.deepEqual(recovered, []);
    assert.equal(calls, 1);
    assert.equal(x.store.get(id).status, "sending");
    assert.equal(x.store.summary(id, "880001").deliveries.sending, 1);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_deliveries WHERE broadcast_id=? AND status='pending'").get(id).n, 1);
    assert.equal(x.store.getSenderState().sender_token, owner.sender_token, "TTL задания не передаёт право отправки");
  } finally { x.close(); }
});

test("SQLITE_BUSY после успешного sendMessage удерживает право и не повторяет отправку", async () => {
  const x = fixture();
  const blocker = new Database(x.file, { timeout: 0 });
  try {
    x.db.pragma("busy_timeout=0");
    x.recipient({ id: "880143" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    let time = new Date();
    let calls = 0;
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store,
      adapters: { telegram: { sendMessage: async () => { calls += 1; blocker.exec("BEGIN IMMEDIATE"); return { message_id: 1 }; } } },
      getAdminRole: () => "owner", now: () => time, sleep: async () => {}, leaseMs: 1000
    });
    await assert.rejects(scheduler.tick(), (error) => error.code === "SQLITE_BUSY");
    blocker.exec("ROLLBACK");
    const owner = x.store.getSenderState();
    assert.ok(owner.sender_token);
    time = new Date(time.getTime() + 2000);
    await scheduler.tick();
    assert.equal(calls, 1);
    assert.equal(x.store.get(id).status, "sending");
    assert.equal(x.store.summary(id, "880001").deliveries.sending, 1);
    assert.equal(x.store.getSenderState().sender_token, owner.sender_token);
    assert.throws(() => x.store.recoverAbandonedSender(owner.sender_token, time.toISOString()), /ещё работает/);
    await scheduler.tick();
    assert.equal(calls, 1);
  } finally { try { blocker.close(); } catch {} x.close(); }
});

test("начало встречи посреди рассылки останавливает оставшиеся сообщения и сохраняет уже отправленные", async () => {
  const x = fixture();
  try {
    const firstParticipant = x.recipient({ id: "880144" });
    const secondParticipant = x.recipient({ id: "880145" });
    let time = new Date("2030-06-01T10:00:00.000Z");
    const id = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T10:01:00.000Z" });
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({
      store: x.store,
      adapters: { telegram: { async sendMessage(chatId, text) { telegram.sent.push({ chatId: String(chatId), text }); return { message_id: telegram.sent.length }; } } },
      getAdminRole: () => "owner", now: () => time,
      sleep: async () => { time = new Date("2030-06-01T10:02:00.000Z"); },
      minSendIntervalMs: 1
    });
    const result = await scheduler.tick();
    assert.equal(telegram.sent.length, 1);
    assert.deepEqual(result.map((item) => item.status), ["sent", "stopped_for_review"]);
    assert.equal(x.store.get(id).status, "failed");
    assert.equal(x.store.get(id).last_error_code, "MEETING_STARTED_REQUIRES_REVIEW");
    const deliveries = x.db.prepare("SELECT participant_id,status,sent_at FROM meeting_deliveries WHERE broadcast_id=? ORDER BY id").all(id);
    assert.equal(deliveries.find((row) => row.participant_id === firstParticipant).status, "sent");
    assert.ok(deliveries.find((row) => row.participant_id === firstParticipant).sent_at);
    assert.equal(deliveries.find((row) => row.participant_id === secondParticipant).status, "pending");
  } finally { x.close(); }
});

test("недоступный пользователь отмечается отдельно, а ошибки логируются без текста API", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880151" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const error = new Error("sensitive body should never be logged"); error.error_code = 403;
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: { sendMessage: async () => { throw error; } } }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    assert.equal(x.store.summary(id, "880001").deliveries.unavailable, 1);
    assert.equal(classifyTelegramError(error).code, "CHAT_UNAVAILABLE");
  } finally { x.close(); }
});

test("общий лимитер выдерживает 500 последовательных ответов 403 и 400", async (t) => {
  for (const [label, code, description] of [
    ["403", 403, "Forbidden"],
    ["400", 400, "Bad Request: chat not found"]
  ]) await t.test(label, async () => {
    const x = fixture();
    try {
      for (let index = 0; index < 500; index += 1) x.recipient({ id: String(900000 + index) });
      const id = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T11:00:00.000Z" });
      let time = new Date("2030-06-01T10:00:00.000Z");
      const startedAt = [];
      const error = { error_code: code, description };
      const scheduler = createScheduler({
        store: x.store,
        adapters: { telegram: { async sendMessage() { startedAt.push(time.getTime()); throw error; } } },
        getAdminRole: () => "owner", now: () => time,
        sleep: async (ms) => { time = new Date(time.getTime() + ms); },
        minSendIntervalMs: 50
      });
      const result = await scheduler.tick();
      assert.equal(startedAt.length, 500);
      assert.ok(startedAt.slice(1).every((value, index) => value - startedAt[index] >= 50));
      assert.equal(result.filter((item) => item.status === "unavailable").length, 500);
      assert.equal(x.store.summary(id, "880001").deliveries.unavailable, 500);
      assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_send_rate_limit_state WHERE next_allowed_at IS NOT NULL").get().n, 1);
    } finally { x.close(); }
  });
});

test("смешанные успешные и ошибочные ответы занимают общий интервал каждый раз", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880159" });
    x.recipient({ id: "880158" });
    x.recipient({ id: "880157" });
    const id = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T11:00:00.000Z" });
    let time = new Date("2030-06-01T10:00:00.000Z");
    const starts = [];
    const api = { async sendMessage(chatId) {
      starts.push(time.getTime());
      if (String(chatId) === "880159") throw { error_code: 403, description: "Forbidden" };
      if (String(chatId) === "880158") throw { error_code: 400, description: "Bad Request: chat not found" };
    } };
    const scheduler = createScheduler({ store: x.store, adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time,
      sleep: async (ms) => { time = new Date(time.getTime() + ms); }, minSendIntervalMs: 50 });
    const result = await scheduler.tick();
    assert.equal(starts.length, 3);
    assert.ok(starts.slice(1).every((value, index) => value - starts[index] >= 50));
    assert.equal(result.filter((item) => item.status === "unavailable").length, 2);
    assert.equal(x.store.summary(id, "880001").deliveries.sent, 1);
  } finally { x.close(); }
});

test("ограничение скорости общее для двух SQLite-планировщиков и разных рассылок; 429 задаёт общую паузу", async () => {
  const x = fixture();
  const secondDb = new Database(x.file);
  secondDb.pragma("foreign_keys=ON");
  try {
    x.recipient({ id: "880161" });
    const firstId = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    const store2 = createMeetingBroadcastStore(secondDb);
    let time = new Date("2030-06-01T10:00:00.000Z");
    const starts = [];
    let rejectFirst = true;
    const telegram = { async sendMessage(chatId) {
      starts.push({ chatId: String(chatId), at: time.getTime() });
      if (rejectFirst) { rejectFirst = false; throw { error_code: 429, description: "Too Many Requests", parameters: { retry_after: 9 } }; }
    } };
    const sleep = async (ms) => { time = new Date(time.getTime() + ms); };
    const options = { adapters: { telegram }, getAdminRole: () => "owner", now: () => time, sleep, minSendIntervalMs: 50 };
    const schedulerA = createScheduler({ ...options, store: x.store, workerId: "limiter-a" });
    const schedulerB = createScheduler({ ...options, store: store2, workerId: "limiter-b" });
    const first = await schedulerA.tick();
    assert.ok(first.some((item) => item.status === "retry"));
    const blockedAt = time.getTime() + 9000;
    x.db.prepare("UPDATE meeting_broadcasts SET next_attempt_at='2030-06-01T10:00:30.000Z' WHERE id=?").run(firstId);
    const secondId = x.draft({ scheduledAt: "2030-06-01T09:59:01.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    await schedulerB.tick();
    assert.equal(starts.length, 2);
    assert.ok(starts[1].at >= blockedAt, "другой процесс должен соблюдать retry_after общего лимитера");
    assert.equal(x.store.get(firstId).status, "sending");
    assert.equal(store2.get(secondId).status, "completed");
  } finally { secondDb.close(); x.close(); }
});

test("два планировщика одновременно сериализуют отправки через общий слот SQLite", async () => {
  const x = fixture();
  const secondDb = new Database(x.file);
  secondDb.pragma("foreign_keys=ON");
  try {
    x.recipient({ id: "880163" });
    x.recipient({ id: "880164" });
    const firstId = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    const secondId = x.draft({ scheduledAt: "2030-06-01T09:59:01.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    const store2 = createMeetingBroadcastStore(secondDb);
    let time = new Date("2030-06-01T10:00:00.000Z");
    const starts = [];
    const api = { async sendMessage(chatId) { starts.push({ chatId: String(chatId), at: time.getTime() }); } };
    const options = { adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time,
      sleep: async (ms) => { time = new Date(time.getTime() + ms); }, minSendIntervalMs: 50 };
    const a = createScheduler({ ...options, store: x.store, workerId: "parallel-limiter-a" });
    const b = createScheduler({ ...options, store: store2, workerId: "parallel-limiter-b" });
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(starts.length, 4, "каждая из двух рассылок охватывает обоих участников");
    assert.ok(starts.slice(1).every((value, index) => value.at - starts[index].at >= 50));
    assert.equal(x.store.get(firstId).status, "completed");
    assert.equal(store2.get(secondId).status, "completed");
  } finally { secondDb.close(); x.close(); }
});

test("остановка рассылки во время ожидания общего слота не начинает новую отправку", async () => {
  const x = fixture();
  try {
    const firstParticipant = x.recipient({ id: "880171" });
    const secondParticipant = x.recipient({ id: "880172" });
    const id = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    let time = new Date("2030-06-01T10:00:00.000Z");
    const starts = [];
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    let releaseWait;
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    let waitCalls = 0;
    const scheduler = createScheduler({
      store: x.store,
      adapters: { telegram: { async sendMessage(chatId) { starts.push(String(chatId)); } } },
      getAdminRole: () => "owner", now: () => time, minSendIntervalMs: 50,
      sleep: async (ms) => {
        waitCalls += 1;
        if (waitCalls === 1) { enteredWait(); await gate; }
        time = new Date(time.getTime() + ms);
      }
    });
    const ticking = scheduler.tick();
    await waiting;
    assert.equal(starts.length, 1);
    assert.equal(x.store.requestStop(id, "2030-06-01T10:00:00.000Z"), "stopped");
    releaseWait();
    await ticking;
    assert.equal(starts.length, 1, "после запроса остановки ожидающий вызов не запускается");
    const summary = x.store.summary(id, "880001");
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.deliveries.pending, 1);
    assert.equal(summary.deliveries.sent, 1);
    assert.equal(summary.deliveries.sending || 0, 0);
    assert.equal(x.db.prepare("SELECT status FROM meeting_deliveries WHERE participant_id=?").get(firstParticipant).status, "sent");
  } finally { x.close(); }
});

test("актуальное согласие перепроверяется после ожидания общего слота", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880173" });
    const withdrawnParticipant = x.recipient({ id: "880174" });
    const id = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    let time = new Date("2030-06-01T10:00:00.000Z");
    const starts = [];
    let enteredWait;
    const waiting = new Promise((resolve) => { enteredWait = resolve; });
    let releaseWait;
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    let waitCalls = 0;
    const scheduler = createScheduler({
      store: x.store,
      adapters: { telegram: { async sendMessage(chatId) { starts.push(String(chatId)); } } },
      getAdminRole: () => "owner", now: () => time, minSendIntervalMs: 50,
      sleep: async (ms) => {
        waitCalls += 1;
        if (waitCalls === 1) { enteredWait(); await gate; }
        time = new Date(time.getTime() + ms);
      }
    });
    const ticking = scheduler.tick();
    await waiting;
    assert.equal(starts.length, 1);
    x.db.prepare("UPDATE participants SET personal_data_consent=0,consent_withdrawn_at='2030-06-01T10:00:00.000Z' WHERE id=?").run(withdrawnParticipant);
    releaseWait();
    await ticking;
    assert.deepEqual(starts, ["880173"]);
    assert.equal(x.store.summary(id, "880001").deliveries.unavailable, 1);
    assert.equal(x.store.summary(id, "880001").deliveries.sent, 1);
  } finally { x.close(); }
});

test("общий интервал сохраняется после повторного открытия SQLite, а успешная доставка не отправляется повторно", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880181" });
    const firstId = x.draft({ scheduledAt: "2030-06-01T09:59:00.000Z", startsAt: "2030-06-01T12:00:00.000Z" });
    let time = new Date("2030-06-01T10:00:00.000Z");
    const calls = [];
    const api = { async sendMessage(chatId) { calls.push({ chatId: String(chatId), at: time.getTime() }); } };
    await createScheduler({ store: x.store, adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time, minSendIntervalMs: 50 }).tick();
    assert.equal(x.store.summary(firstId, "880001").deliveries.sent, 1);
    x.db.close();

    const reopened = new Database(x.file);
    reopened.pragma("foreign_keys=ON");
    try {
      const store = createMeetingBroadcastStore(reopened);
      const participant = reopened.prepare(`INSERT INTO participants(first_name,last_name,phone,preferred_contact,phone_confirmed_at,personal_data_consent,consent_at,consent_version)
        VALUES('Тест','Перезапуск','+79990008882','Telegram','2030-01-01T00:00:00.000Z',1,'2030-01-01T00:00:00.000Z','policy-test')`).run().lastInsertRowid;
      reopened.prepare("INSERT INTO accounts(participant_id,platform,messenger_user_id) VALUES(?,'telegram','880182')").run(participant);
      reopened.prepare("INSERT INTO telegram_private_chats(telegram_id,first_seen_at,last_seen_at) VALUES('880182','2030-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z')").run();
      time = new Date("2030-06-01T10:00:00.020Z");
      const secondId = store.createDraft({ title: "После перезапуска", startsAt: "2030-06-01T12:00:00.000Z", scheduledAt: "2030-06-01T09:59:00.000Z", zoomUrl: "https://zoom.us/j/123456789", timezone: "Etc/UTC", createdBy: "880001", now: time.toISOString() });
      store.confirmDraft(secondId, "880001", time.toISOString());
      const scheduler = createScheduler({ store, adapters: { telegram: api }, getAdminRole: () => "owner", now: () => time, minSendIntervalMs: 50,
        sleep: async (ms) => { time = new Date(time.getTime() + ms); } });
      await scheduler.tick();
      assert.equal(calls.length, 3);
      assert.ok(calls.slice(1).every((call, index) => call.at - calls[index].at >= 50));
      const originalDelivery = reopened.prepare("SELECT status,attempt_count FROM meeting_deliveries WHERE broadcast_id=?").get(firstId);
      assert.deepEqual(originalDelivery, { status: "sent", attempt_count: 1 }, "перезапуск не повторяет уже успешную доставку исходной рассылки");
      assert.equal(store.summary(secondId, "880001").deliveries.sent, 2);
      assert.equal(store.summary(firstId, "880001").deliveries.sent, 1);
    } finally { reopened.close(); }
  } finally { x.close(); }
});

test("реальный планировщик выдерживает интервал перед следующей отправкой", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880191" });
    x.recipient({ id: "880192" });
    x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const startedAt = [];
    const scheduler = createScheduler({ store: x.store, adapters: { telegram: { async sendMessage() { startedAt.push(Date.now()); } } }, getAdminRole: () => "owner" });
    await scheduler.tick();
    assert.equal(startedAt.length, 2);
    assert.ok(startedAt[1] - startedAt[0] >= 45, "реальная пауза не должна быть только симуляцией тестового clock");
  } finally { x.close(); }
});

test("Telegram-ошибки различаются по подтверждённости отказа", () => {
  const apiError = (code, description) => ({ error_code: code, description });
  assert.equal(classifyTelegramError(apiError(403, "Forbidden")).kind, "unavailable");
  assert.equal(classifyTelegramError(apiError(400, "Bad Request: chat not found")).kind, "unavailable");
  assert.equal(classifyTelegramError(apiError(400, "Bad Request: message is too long")).kind, "uncertain");
  for (const code of [500, 502, 503]) assert.equal(classifyTelegramError(apiError(code, "Internal Server Error")).kind, "uncertain");
  assert.equal(classifyTelegramError(new Error("socket timed out")).kind, "uncertain");
});

test("Telegram 4xx/5xx обрабатываются без автоматического повтора неопределённой доставки", async () => {
  for (const scenario of [
    { code: 400, description: "Bad Request: chat not found", status: "unavailable" },
    { code: 400, description: "Bad Request: message is too long", status: "uncertain" },
    { code: 403, description: "Forbidden: bot was blocked by the user", status: "unavailable" },
    { code: 500, description: "Internal Server Error", status: "uncertain" },
    { code: 502, description: "Bad Gateway", status: "uncertain" },
    { code: 503, description: "Service Unavailable", status: "uncertain" }
  ]) {
    const x = fixture();
    try {
      x.recipient({ id: String(881000 + scenario.code) });
      const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
      let calls = 0;
      const error = Object.assign(new Error(scenario.description), { error_code: scenario.code, description: scenario.description });
      const scheduler = createMeetingBroadcastScheduler({
        store: x.store,
        adapters: { telegram: { async sendMessage() { calls += 1; throw error; } } },
        getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {}
      });
      await scheduler.tick();
      assert.equal(x.store.summary(id).deliveries[scenario.status], 1, `${scenario.code}: ${scenario.description}`);
      await scheduler.tick();
      assert.equal(calls, 1, `${scenario.code} must not be blindly retried`);
    } finally { x.close(); }
  }
});

test("два планировщика не отправляют одно задание одновременно", async () => {
  const x = fixture();
  const second = new Database(x.file, { timeout: 5000 });
  try {
    x.recipient({ id: "880161" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const store2 = createMeetingBroadcastStore(second);
    let resolveSend;
    const gate = new Promise((resolve) => { resolveSend = resolve; });
    const telegram = fakeTelegram();
    const api = { async sendMessage(chatId, text) { telegram.sent.push({ chatId: String(chatId), text }); await gate; return { message_id: 1 }; } };
    const options = { adapters: { telegram: api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} };
    const a = createMeetingBroadcastScheduler({ ...options, store: x.store, workerId: "worker-a" });
    const b = createMeetingBroadcastScheduler({ ...options, store: store2, workerId: "worker-b" });
    const first = a.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await b.tick();
    assert.equal(telegram.sent.length, 1);
    resolveSend();
    await first;
    assert.equal(x.store.get(id).status, "completed");
    assert.equal(telegram.sent.length, 1);
  } finally { try { second.close(); } catch {} x.close(); }
});

test("после долгого простоя приглашение блокируется до проверки администратором", () => {
  const x = fixture();
  try {
    const now = new Date("2030-06-03T00:00:00.000Z");
    const id = x.draft({ scheduledAt: "2030-06-01T00:00:00.000Z", startsAt: "2030-06-04T00:00:00.000Z" });
    const claimed = x.store.claimNext(now.toISOString(), "worker", 1000);
    assert.equal(claimed.stale, true);
    assert.equal(x.store.get(id).status, "failed");
    assert.equal(x.store.get(id).last_error_code, "STALE_INVITATION_REQUIRES_REVIEW");
    assert.equal(x.store.sendNow(id, "880001", now.toISOString()), true, "администратор явно подтвердил актуальность");
    assert.equal(x.store.get(id).status, "scheduled");
  } finally { x.close(); }
});

test("деморассылка не видит тестовые анкеты и отправляется только allowlist-администратору", async () => {
  const x = fixture();
  try {
    x.admin("880001", "owner");
    x.recipient({ id: "880171" });
    const seeded = x.db.prepare(`INSERT INTO participants(first_name,last_name,phone,personal_data_consent) VALUES('Синтетический','Набор','+99970000001',0)`).run();
    x.db.prepare("INSERT INTO demo_test_participants(participant_id) VALUES(?)").run(seeded.lastInsertRowid);
    x.db.prepare("INSERT INTO telegram_private_chats(telegram_id,first_seen_at,last_seen_at) VALUES('880001',?,?)").run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    const telegram = fakeTelegram();
    const scheduler = createMeetingBroadcastScheduler({ store: x.store, adapters: { telegram: telegram.api }, getAdminRole: (user) => user === "880001" ? "owner" : null, demoMode: true, demoAdminIds: ["880001"], now: () => new Date(), sleep: async () => {} });
    await scheduler.tick();
    assert.deepEqual(telegram.sent.map((item) => item.chatId), ["880001"]);
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM meeting_deliveries WHERE broadcast_id=? AND participant_id IS NOT NULL").get(id).n, 0);
  } finally { x.close(); }
});

test("перезапуск с новым подключением продолжает сохранённое задание", async () => {
  const x = fixture();
  try {
    x.recipient({ id: "880181" });
    const id = x.draft({ scheduledAt: new Date(Date.now() - 1000).toISOString(), startsAt: new Date(Date.now() + 3_600_000).toISOString() });
    x.db.close();
    const reopened = new Database(x.file);
    try {
      const store = createMeetingBroadcastStore(reopened);
      const telegram = fakeTelegram();
      const scheduler = createMeetingBroadcastScheduler({ store, adapters: { telegram: telegram.api }, getAdminRole: () => "owner", now: () => new Date(), sleep: async () => {} });
      await scheduler.tick();
      assert.equal(telegram.sent.length, 1);
      assert.equal(store.get(id).status, "completed");
    } finally { reopened.close(); }
  } finally { try { x.close(); } catch {} }
});

test("Telegram-чат фиксируется только при входящем личном обновлении", async () => {
  const x = fixture();
  try {
    const { registerPrivateChatTracker } = require("../src/private-chat-tracker");
    const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
    registerPrivateChatTracker(bot, { db: { recordTelegramPrivateChat: (id, at) => x.db.prepare(`INSERT INTO telegram_private_chats(telegram_id,first_seen_at,last_seen_at) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(String(id), at, at) }, now: () => new Date("2030-01-01T00:00:00.000Z") });
    bot.api.config.use(async (_previous, method, payload) => ({ ok: true, result: { message_id: 1, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } }));
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 880191, type: "private" }, from: { id: 880191, is_bot: false, first_name: "Test" }, text: "/start" } });
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM telegram_private_chats WHERE telegram_id='880191'").get().n, 1);
    await bot.handleUpdate({ update_id: 2, message: { message_id: 2, date: 1, chat: { id: -100, type: "supergroup" }, from: { id: 880192, is_bot: false, first_name: "Test" }, text: "hi" } });
    assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM telegram_private_chats WHERE telegram_id='880192'").get().n, 0);
  } finally { x.close(); }
});

test("интеграция админ-меню: мастер создания, предпросмотр, подтверждение, история и отмена", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meeting-ui-"));
  const original = Object.fromEntries(["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS"].map((key) => [key, process.env[key]]));
  process.env.DB_PATH = path.join(dir, "ui.sqlite");
  process.env.OWNER_TELEGRAM_ID = "889001";
  process.env.DEMO_MODE = "false";
  process.env.CLUB_TIMEZONE = "Etc/UTC";
  process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
  const modules = ["../src/database", "../src/admin", "../src/bot-handlers", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker", "../src/registration", "../src/profile", "../src/participant-service", "../src/registration-preview", "../src/demo-registration", "../src/myid", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/main-menu", "../src/request-limits", "../src/expiring-map"];
  for (const item of modules) delete require.cache[require.resolve(item)];
  const db = require("../src/database");
  const { registerBotHandlers } = require("../src/bot-handlers");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const cleanups = registerBotHandlers(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => { sent.push({ method, payload }); return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } }; });
  let update = 0;
  async function send(text, id = 889001, type = "private") {
    update += 1;
    const chatId = type === "private" ? id : -100123;
    await bot.handleUpdate({ update_id: update, message: { message_id: update, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Test" }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] : undefined } });
    return sent.at(-1)?.payload;
  }
  const keyboard = (payload) => payload?.reply_markup?.keyboard?.flat().map((button) => button.text) || [];
  try {
    await t.test("админский мастер и выходы работают только в личном чате", async () => {
      const group = await send("📅 Встречи и рассылки", 889001, "group");
      assert.match(group.text, /только в личном чате/);
      const menu = await send("📅 Встречи и рассылки");
      assert.match(menu.text, /Выберите действие с встречами/);
      assert.ok(keyboard(sent.at(-1).payload).includes("➕ Создать встречу"));
    });
    await t.test("создание, проверка, сохранение, история и отмена", async () => {
      await send("➕ Создать встречу");
      await send("Встреча для теста");
      const start = new Date(Date.now() + 3 * 86_400_000);
      const invite = new Date(Date.now() + 86_400_000);
      const local = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
      await send(local(start));
      await send(local(invite));
      await send("https://zoom.us/j/123456789");
      const preview = await send("Пропустить текст");
      assert.match(preview.text, /Предварительный просмотр приглашения/);
      assert.match(preview.text, /Встреча для теста/);
      assert.ok(keyboard(preview).includes("✅ Подтвердить рассылку"));
      await send("✅ Подтвердить рассылку");
      assert.match(sent.at(-1).payload.text, /Рассылка запланирована/);
      assert.equal(db.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "scheduled");
      await send("📜 История и статистика");
      const label = keyboard(sent.at(-1).payload).find((button) => button.startsWith("#1 "));
      assert.ok(label);
      await send(label);
      assert.match(sent.at(-1).payload.text, /Статистика рассылки/);
      await send("✏️ Изменить");
      await send("Обновлённая тестовая встреча");
      await send("Оставить");
      await send("Оставить");
      await send("Оставить");
      await send("Оставить");
      assert.match(sent.at(-1).payload.text, /Обновлённая тестовая встреча/);
      const savedReply = await send("💾 Сохранить изменения");
      assert.match(savedReply.text, /Предварительный просмотр приглашения/);
      assert.equal(db.db.prepare("SELECT title FROM meetings").get().title, "Обновлённая тестовая встреча");
      await send("🚀 Отправить сейчас");
      assert.ok(keyboard(sent.at(-1).payload).includes("🚀 Подтвердить отправку"));
      await send("🚀 Подтвердить отправку");
      assert.match(sent.at(-1).payload.text, /Рассылка подготовлена[\s\S]*60 секунд/);
      assert.ok(keyboard(sent.at(-1).payload).includes("⛔ Отменить рассылку"));
      assert.equal(db.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "scheduled");
      await send("📜 История и статистика");
      await send(keyboard(sent.at(-1).payload).find((button) => button.startsWith("#1 ")));
      await send("⛔ Отменить рассылку");
      assert.equal(db.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "cancelled");
      assert.ok(keyboard(sent.at(-1).payload).includes("➕ Создать встречу"));
      await send("✅ Подтвердить рассылку");
      assert.match(sent.at(-1).payload.text, /устарело/);
      assert.equal(db.db.prepare("SELECT status FROM meeting_broadcasts").get().status, "cancelled");
    });
    await t.test("обычный пользователь и отозванный администратор не могут продолжить", async () => {
      db.addAdmin("889002");
      const prompt = await send("➕ Создать встречу", 889002);
      assert.match(prompt.text, /название/);
      db.removeAdmin("889002");
      const response = await send("Не должно сохраниться", 889002);
      assert.match(response.text, /доступ.*отозван/i);
      const denied = await send("➕ Создать встречу", 889003);
      assert.match(denied.text, /нет доступа/);
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1);
    });
    await t.test("обычный участник отменяет редактирование профиля через канонический порядок обработчиков", async () => {
      db.addParticipant({
        first_name: "ВымышленнаяАнкета", last_name: "Тест", phone: "+79990008893",
        personal_data_consent: true, consent_at: "2030-01-01T00:00:00.000Z", consent_version: "test-policy-v1"
      }, { platform: "telegram", messenger_user_id: "889003" });
      await send("Моя анкета", 889003);
      await send("✏️ Изменить данные", 889003);
      assert.equal(db.getDraft("telegram", "889003").current_step, "profile_edit_select");
      const cancelled = await send("Отмена", 889003);
      assert.match(cancelled.text, /Редактирование отменено/);
      assert.doesNotMatch(cancelled.text, /нет доступа к управлению встречами/i);
      assert.equal(db.getDraft("telegram", "889003"), undefined);
    });
    await t.test("владелец отменяет активный мастер Zoom; последующая отмена профиля не путается с ним", async () => {
      const prompt = await send("➕ Создать встречу", 889001);
      assert.match(prompt.text, /название/);
      const cancelledMeeting = await send("Отмена", 889001);
      assert.match(cancelledMeeting.text, /административн/i);
      assert.ok(keyboard(sent.at(-1).payload).includes("🔎 Найти участника"));
      assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM meetings").get().n, 1, "отмена мастера до сохранения не создаёт запись");

      db.addParticipant({
        first_name: "ВымышленныйВладелец", last_name: "Тест", phone: "+79990008891",
        personal_data_consent: true, consent_at: "2030-01-01T00:00:00.000Z", consent_version: "test-policy-v1"
      }, { platform: "telegram", messenger_user_id: "889001" });
      await send("Моя анкета", 889001);
      await send("✏️ Изменить данные", 889001);
      assert.equal(db.getDraft("telegram", "889001").current_step, "profile_edit_select");
      const cancelledProfile = await send("Отмена", 889001);
      assert.match(cancelledProfile.text, /Редактирование отменено/);
      assert.doesNotMatch(cancelledProfile.text, /нет доступа к управлению встречами/i);
      assert.equal(db.getDraft("telegram", "889001"), undefined);
    });
  } finally {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    db.closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const item of modules) delete require.cache[require.resolve(item)];
  }
});

test("интеграция экстренной остановки: подтверждение, права, клавиатура и итоговая статистика", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-meeting-stop-ui-"));
  const envKeys = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "CLUB_TIMEZONE", "DEMO_BROADCAST_TELEGRAM_IDS"];
  const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DB_PATH = path.join(dir, "ui.sqlite");
  process.env.OWNER_TELEGRAM_ID = "889101";
  process.env.DEMO_MODE = "false";
  process.env.CLUB_TIMEZONE = "Etc/UTC";
  process.env.DEMO_BROADCAST_TELEGRAM_IDS = "";
  const modules = ["../src/database", "../src/admin", "../src/bot-handlers", "../src/meeting-broadcasts", "../src/meeting-broadcast-store", "../src/meeting-broadcast-service", "../src/private-chat-tracker", "../src/registration", "../src/profile", "../src/participant-service", "../src/registration-preview", "../src/demo-registration", "../src/myid", "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu", "../src/main-menu", "../src/request-limits", "../src/expiring-map"];
  for (const item of modules) delete require.cache[require.resolve(item)];
  const db = require("../src/database");
  const { registerBotHandlers } = require("../src/bot-handlers");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const cleanups = registerBotHandlers(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => { sent.push({ method, payload }); return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } }; });
  let update = 0;
  async function send(text, id = 889101) {
    update += 1;
    await bot.handleUpdate({ update_id: update, message: { message_id: update, date: 1, chat: { id, type: "private" }, from: { id, is_bot: false, first_name: "Test" }, text } });
    return sent.at(-1)?.payload;
  }
  const keyboard = (payload) => payload?.reply_markup?.keyboard?.flat().map((button) => button.text) || [];
  try {
    const store = createMeetingBroadcastStore(db.db);
    const now = new Date();
    function activeBroadcast(actor) {
      const id = store.createDraft({
        title: "Тест остановки", startsAt: new Date(now.getTime() + 3_600_000).toISOString(),
        scheduledAt: new Date(now.getTime() - 1000).toISOString(), zoomUrl: "https://zoom.us/j/123456789",
        note: null, timezone: "Etc/UTC", createdBy: actor, now: now.toISOString()
      });
      store.confirmDraft(id, actor, now.toISOString());
      assert.equal(store.claimNext(now.toISOString(), `ui-worker-${id}`, 60_000).id, id);
      return id;
    }
    const id = activeBroadcast("889101");
    const insertDelivery = db.db.prepare(`INSERT INTO meeting_deliveries(broadcast_id,platform,messenger_user_id,status)
      VALUES(?,'telegram',?,?)`);
    insertDelivery.run(id, "synthetic-sent", "sent");
    insertDelivery.run(id, "synthetic-pending", "pending");
    insertDelivery.run(id, "synthetic-error", "unavailable");
    insertDelivery.run(id, "synthetic-uncertain", "uncertain");
    await send("📅 Встречи и рассылки");
    await send("📜 История и статистика");
    const label = keyboard(sent.at(-1).payload).find((value) => value.includes(`· sending`) && value.includes("Тест остановки"));
    assert.ok(label);
    await send(label);
    assert.ok(keyboard(sent.at(-1).payload).includes("⛔ Остановить рассылку"));
    const prompt = await send("⛔ Остановить рассылку");
    assert.match(prompt.text, /новые отправки больше не будут начинаться/i);
    assert.match(prompt.text, /уже начата или зарезервирована.*ещё могут быть доставлены/i);
    assert.match(prompt.text, /уже отправленные приглашения отозвать нельзя/i);
    assert.ok(keyboard(prompt).includes("⛔ Подтвердить остановку"));

    const denied = await send("⛔ Подтвердить остановку", 889199);
    assert.match(denied.text, /нет доступа/i);
    assert.equal(store.get(id).status, "sending", "неавторизованный пользователь не меняет рассылку");

    const stopped = await send("⛔ Подтвердить остановку");
    assert.equal(store.get(id).status, "cancelled");
    assert.match(stopped.text, /запрос остановки записан/i);
    assert.match(stopped.text, /Успешно отправлено: 1/);
    assert.match(stopped.text, /Ожидают отправки: 1/);
    assert.match(stopped.text, /Пропущено: 1/);
    assert.match(stopped.text, /Ошибки, ожидают повтора: 0/);
    assert.match(stopped.text, /Неопределённые доставки: 1/);
    assert.ok(!keyboard(stopped).includes("⛔ Остановить рассылку"));
    const repeated = await send("⛔ Подтвердить остановку");
    assert.match(repeated.text, /подтверждение устарело/i);
    assert.equal(store.get(id).status, "cancelled");

    db.addAdmin("889102");
    const secondId = activeBroadcast("889102");
    await send("📅 Встречи и рассылки", 889102);
    await send("📜 История и статистика", 889102);
    const secondLabel = keyboard(sent.at(-1).payload).find((value) => value.includes(`· sending`) && value.includes("Тест остановки"));
    await send(secondLabel, 889102);
    await send("⛔ Остановить рассылку", 889102);
    db.removeAdmin("889102");
    const revoked = await send("⛔ Подтвердить остановку", 889102);
    assert.match(revoked.text, /нет доступа/i);
    assert.equal(store.get(secondId).status, "sending", "роль перепроверяется непосредственно перед записью решения");

    await send("📅 Встречи и рассылки");
    await send("📜 История и статистика");
    const activeLabel = keyboard(sent.at(-1).payload).find((value) => value.startsWith(`#${secondId} `));
    await send(activeLabel);
    await send("⛔ Остановить рассылку");
    const dismissed = await send("Отмена");
    assert.ok(keyboard(dismissed).includes("🔎 Найти участника"), "отмена подтверждения возвращает в меню и не оставляет клавиатуру остановки");
    assert.equal(store.get(secondId).status, "sending", "обычная кнопка Отмена не останавливает активную рассылку без подтверждения");
  } finally {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    db.closeDatabase();
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    for (const item of modules) delete require.cache[require.resolve(item)];
  }
});

