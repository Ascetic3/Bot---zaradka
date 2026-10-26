const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
const { createRateLimiter } = require("../src/request-limits");

const isolatedModules = [
  "../src/database", "../src/bot-handlers", "../src/admin", "../src/main-menu", "../src/myid",
  "../src/registration-preview", "../src/registration", "../src/profile", "../src/participant-service",
  "../src/chat-guards", "../src/account-links", "../src/participant-data", "../src/participant-data-menu"
];

function setup({ demoMode = "false" } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-data-menu-"));
  const envNames = ["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION"];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.DB_PATH = path.join(directory, "temporary.sqlite");
  process.env.OWNER_TELEGRAM_ID = "70001";
  process.env.DEMO_MODE = demoMode;
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "synthetic-v1";
  const sent = [];
  let database, bot, cleanups, rateLimiter, updateId = 0;
  function init() {
    for (const name of isolatedModules) delete require.cache[require.resolve(name)];
    database = require("../src/database");
    const { registerBotHandlers } = require("../src/bot-handlers");
    bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Synthetic", username: "synthetic_bot" } });
    rateLimiter = createRateLimiter({ cleanupIntervalMs: 0 });
    cleanups = registerBotHandlers(bot, { rateLimiter });
    bot.api.config.use(async (_previous, method, payload) => {
      sent.push({ method, payload });
      if (method === "answerCallbackQuery" || method === "editMessageReplyMarkup") return { ok: true, result: true };
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id ?? payload.chat_id, type: "private" }, text: payload.text ?? "" } };
    });
  }
  function stop() {
    for (const cleanup of cleanups ?? []) if (typeof cleanup === "function") cleanup();
    rateLimiter?.stop();
    try { database?.closeDatabase(); } catch {}
  }
  init();
  function participant(telegramId, suffix = 1, extra = {}) {
    return database.addParticipant({
      first_name: "ВымышленноеИмя", last_name: "ТестоваяФамилия", phone: `+999700000${String(suffix).padStart(2, "0")}`,
      phone_confirmed_at: "2026-10-20T09:00:00.000Z", personal_data_consent: true,
      consent_at: "2026-10-20T09:01:00.000Z", consent_version: "synthetic-v1", preferred_contact: "Telegram", ...extra
    }, { platform: "telegram", messenger_user_id: String(telegramId) });
  }
  async function send(text, id = 70001, chatType = "private") {
    updateId += 1;
    const before = sent.length;
    await bot.handleUpdate({ update_id: updateId, message: {
      message_id: updateId, date: 1, chat: { id, type: chatType }, from: { id, is_bot: false, first_name: "Synthetic" },
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/, 1)[0].length }] } : {}), text
    } });
    return sent.slice(before).find((entry) => entry.method === "sendMessage") ?? null;
  }
  async function callback(data, id = 70001, chatType = "private") {
    updateId += 1;
    const before = sent.length;
    await bot.handleUpdate({ update_id: updateId, callback_query: {
      id: `callback-${updateId}`, from: { id, is_bot: false, first_name: "Synthetic" }, data,
      message: { message_id: updateId, date: 1, chat: { id, type: chatType }, text: "synthetic prompt" }
    } });
    return sent.slice(before);
  }
  return {
    directory, sent, participant, send, callback, get database() { return database; },
    restart() { stop(); init(); },
    close() {
      stop();
      fs.rmSync(directory, { recursive: true, force: true });
      for (const [name, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[name] : process.env[name] = value;
      for (const name of isolatedModules) delete require.cache[require.resolve(name)];
    }
  };
}

const keyboardTexts = (message) => message?.payload?.reply_markup?.keyboard?.flat().map((button) => button.text) ?? [];
const confirmationData = (message) => message.payload.reply_markup.inline_keyboard[0][0].callback_data;

test("раздел «Мои данные» доступен в личном чате, содержит свою анкету и не показывает чужую", async () => {
  const x = setup();
  try {
    x.participant("70001", 1);
    x.participant("70002", 2);
    const menu = await x.send("🔐 Мои данные");
    assert.match(menu.payload.text, /согласие на обработку данных действует/i);
    assert.deepEqual(keyboardTexts(menu), ["Моя анкета", "🗑 Запросить удаление анкеты", "🚫 Отозвать согласие", "📄 Статус моих запросов", "🏠 Главное меню"]);
    const own = await x.send("Моя анкета");
    assert.match(own.payload.text, /ВымышленноеИмя/);
    assert.doesNotMatch(own.payload.text, /\+99970000002|70002/);
  } finally { x.close(); }
});

test("устаревшая кнопка отдельного Zoom-разрешения не меняет данные и удаляет клавиатуру", async () => {
  const x = setup();
  try {
    x.participant("70001", 1);
    const before = x.sent.length;
    const actions = await x.callback("mnotify:enable:" + "a".repeat(32));
    assert.ok(actions.some((entry) => entry.method === "answerCallbackQuery"));
    assert.ok(actions.some((entry) => entry.method === "editMessageReplyMarkup"));
    const response = actions.find((entry) => entry.method === "sendMessage");
    assert.match(response.payload.text, /организационными уведомлениями/i);
    assert.equal(x.sent.length, before + actions.length);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='meeting_notification_consents'").get().count, 0);
  } finally { x.close(); }
});

test("запрос удаления требует отдельного подтверждения, остаётся на рассмотрении и не удаляет анкету", async () => {
  const x = setup();
  try {
    const p = x.participant("70001", 1);
    await x.send("🔐 Мои данные");
    const prompt = await x.send("🗑 Запросить удаление анкеты");
    assert.match(prompt.payload.text, /не удалит анкету немедленно/i);
    const confirm = confirmationData(prompt);
    assert.match(confirm, /^pdata:delete:confirm:/);
    const token = confirm.split(":").at(-1);
    const forged = await x.callback(confirm, 70002);
    assert.equal(x.database.getParticipant(p.id).id, p.id);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 0);
    assert.ok(forged.some((entry) => entry.method === "answerCallbackQuery"));
    const accepted = await x.callback(confirm);
    const finalMessage = accepted.find((entry) => entry.method === "sendMessage");
    assert.match(finalMessage.payload.text, /получен и будет рассмотрен оператором/i);
    assert.equal(x.database.getParticipant(p.id).id, p.id);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 1);
    assert.ok(accepted.some((entry) => entry.method === "editMessageReplyMarkup"));
    const stale = await x.callback(confirm);
    assert.match(stale.find((entry) => entry.method === "sendMessage").payload.text, /уже использовано/i);
    const repeated = await x.send("🗑 Запросить удаление анкеты");
    assert.match(repeated.payload.text, /уже получен/i);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 1);
  } finally { x.close(); }
});

test("отмена удаления не создаёт запрос и очищает старую inline-клавиатуру", async () => {
  const x = setup();
  try {
    x.participant("70001");
    await x.send("🗑 Запросить удаление анкеты");
    const prompt = x.sent.findLast((entry) => entry.method === "sendMessage");
    const cancel = prompt.payload.reply_markup.inline_keyboard[1][0].callback_data;
    const actions = await x.callback(cancel);
    const menu = actions.find((entry) => entry.method === "sendMessage");
    assert.match(menu.payload.text, /Действие отменено/);
    assert.ok(keyboardTexts(menu).includes("🚫 Отозвать согласие"));
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 0);
    assert.ok(actions.some((entry) => entry.method === "editMessageReplyMarkup"));
  } finally { x.close(); }
});

test("отзыв согласия сразу скрывает анкету из пользовательских функций, но сохраняет статус запроса", async () => {
  const x = setup();
  try {
    const p = x.participant("70001");
    x.database.linkAccount(p.id, "max", "synthetic-max-account");
    await x.send("🚫 Отозвать согласие");
    const prompt = x.sent.findLast((entry) => entry.method === "sendMessage");
    const confirm = confirmationData(prompt);
    const result = await x.callback(confirm);
    assert.match(result.find((entry) => entry.method === "sendMessage").payload.text, /согласие отозвано/i);
    assert.equal(x.database.findParticipantByTelegramId("70001"), undefined);
    assert.equal(x.database.searchParticipants("ВымышленноеИмя").length, 0);
    assert.equal(x.database.getParticipantStatistics().total, 0);
    assert.equal(x.database.getParticipantsForExport().length, 0);
    assert.equal(x.database.getParticipantDataRequestsForTelegram("70001").consent_request_status, "pending_review");
    const unavailable = await x.send("Моя анкета");
    assert.doesNotMatch(unavailable.payload.text, /ВымышленноеИмя|\+999700000/);
    const repeat = await x.send("🚫 Отозвать согласие");
    assert.match(repeat.payload.text, /уже отозвано/i);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests WHERE participant_id=?").get(p.id).count, 1);
    assert.throws(() => x.database.linkAccount(p.id, "max", "another-synthetic-max"), /Анкета недоступна/);
  } finally { x.close(); }
});

test("отзыв согласия во время редактирования закрывает черновик и не применяет поздний ответ", async () => {
  const x = setup();
  try {
    const p = x.participant("70001");
    await x.send("✏️ Изменить данные");
    await x.send("Имя");
    assert.equal(x.database.getDraft("telegram", "70001").current_step, "profile_edit:first_name");
    await x.send("🚫 Отозвать согласие");
    const prompt = x.sent.findLast((entry) => entry.method === "sendMessage");
    await x.callback(confirmationData(prompt));
    const late = await x.send("Поддельно новое имя");
    assert.doesNotMatch(late?.payload?.text ?? "", /успешно изменены/);
    assert.equal(x.database.getParticipantIncludingWithdrawn(p.id).first_name, "ВымышленноеИмя");
    assert.equal(x.database.getDraft("telegram", "70001"), undefined);
  } finally { x.close(); }
});

test("статусы пользовательских запросов сохраняются после перезапуска подключения и бота", async () => {
  const x = setup();
  try {
    x.participant("70001");
    await x.send("🗑 Запросить удаление анкеты");
    const prompt = x.sent.findLast((entry) => entry.method === "sendMessage");
    await x.callback(confirmationData(prompt));
    x.restart();
    const status = await x.send("📄 Статус моих запросов");
    assert.match(status.payload.text, /Удаление анкеты: ожидает рассмотрения/);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participants").get().count, 1);
  } finally { x.close(); }
});

test("деморежим не позволяет подавать запросы, отзывать согласие или менять синтетические анкеты", async () => {
  const x = setup({ demoMode: "true" });
  try {
    const p = x.participant("70001");
    const deletion = await x.send("🗑 Запросить удаление анкеты");
    assert.match(deletion.payload.text, /демонстрационном режиме/i);
    const withdrawal = await x.send("🚫 Отозвать согласие");
    assert.match(withdrawal.payload.text, /демонстрационном режиме/i);
    assert.equal(x.database.getParticipant(p.id).id, p.id);
    assert.equal(x.database.getParticipantConsentState(p.id).active, true);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 0);
    assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM consent_withdrawal_requests").get().count, 0);
    assert.throws(() => x.database.deleteParticipantById(p.id), (error) => error.code === "DEMO_MODE_DELETE_DISABLED");
  } finally { x.close(); }
});

test("администраторы видят только минимальный статус запросов, обычные пользователи не имеют доступа", async () => {
  const x = setup();
  try {
    const p = x.participant("70002");
    x.database.db.prepare("INSERT INTO admins(telegram_id,role) VALUES('70003','admin')").run();
    assert.equal(x.database.getAdminRole("70003"), "admin");
    const prepared = require("../src/participant-data").createParticipantDataService({ db: x.database });
    const prompt = prepared.prepareOwnDeletionRequest("70002");
    prepared.confirmOwnDeletionRequest("70002", prompt.confirmation_token);
    prepared.stop();
    await x.send("📋 Запросы участников", 70004);
    assert.match(x.sent.findLast((entry) => entry.method === "sendMessage").payload.text, /нет доступа/);
    const panel = await x.send("/admin", 70001);
    assert.ok(keyboardTexts(panel).includes("📋 Запросы участников"), JSON.stringify({ panel, sent: x.sent.slice(-5) }));
    const list = await x.send("📋 Запросы участников", 70001);
    assert.match(list.payload.text, /Удаление анкеты/);
    assert.match(list.payload.text, /ожидает рассмотрения/);
    assert.doesNotMatch(list.payload.text, /ВымышленноеИмя|\+999700000|70002/);
    assert.equal(x.database.getParticipant(p.id).id, p.id);
  } finally { x.close(); }
});

test("пользовательские действия DATA-001 запрещены в группах", async () => {
  for (const chatType of ["group", "supergroup"]) {
    const x = setup();
    try {
      const p = x.participant("70001");
      await x.send("🔐 Мои данные", 70001, chatType);
      await x.send("🗑 Запросить удаление анкеты", 70001, chatType);
      await x.send("🚫 Отозвать согласие", 70001, chatType);
      assert.equal(x.database.getParticipant(p.id).id, p.id);
      assert.equal(x.database.db.prepare("SELECT COUNT(*) AS count FROM participant_deletion_requests").get().count, 0);
      assert.equal(x.database.getParticipantConsentState(p.id).active, true);
    } finally { x.close(); }
  }
});
test("административные запросы персональных данных перелистываются SQL-страницами по 10 и не показывают ID участников", async () => {
  const x = setup();
  try {
    const insert = x.database.db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at,status) VALUES(?,?,?,'pending_review')");
    for (let index = 1; index <= 23; index += 1) {
      const participant = x.participant(String(71000 + index), index);
      const requestId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      insert.run(requestId, participant.id, `2026-10-${String(index).padStart(2, "0")}T10:00:00.000Z`);
    }

    const first = await x.send("📋 Запросы участников");
    assert.match(first.payload.text, /страница 1 из 3/);
    assert.equal((first.payload.text.match(/Удаление анкеты/g) || []).length, 10);
    assert.deepEqual(keyboardTexts(first), ["➡️ Следующие запросы", "⬅️ Админ-меню"]);
    assert.doesNotMatch(first.payload.text, /7100[1-9]|7101\d|\+999700000/);

    const second = await x.send("➡️ Следующие запросы");
    assert.match(second.payload.text, /страница 2 из 3/);
    assert.equal((second.payload.text.match(/Удаление анкеты/g) || []).length, 10);
    assert.deepEqual(keyboardTexts(second), ["⬅️ Предыдущие запросы", "➡️ Следующие запросы", "⬅️ Админ-меню"]);

    const third = await x.send("➡️ Следующие запросы");
    assert.match(third.payload.text, /страница 3 из 3/);
    assert.equal((third.payload.text.match(/Удаление анкеты/g) || []).length, 3);
    assert.deepEqual(keyboardTexts(third), ["⬅️ Предыдущие запросы", "⬅️ Админ-меню"]);

    const back = await x.send("⬅️ Предыдущие запросы");
    assert.match(back.payload.text, /страница 2 из 3/);
    assert.equal(x.database.getParticipantDataRequestCount(), 23);
  } finally { x.close(); }
});

test("права администратора повторно проверяются при перелистывании запросов участников", async () => {
  const x = setup();
  try {
    x.database.addAdmin("70002");
    const participant = x.participant("71001", 1);
    x.database.db.prepare("INSERT INTO participant_deletion_requests(request_id,participant_id,requested_at,status) VALUES(?,?,?,'pending_review')")
      .run("00000000-0000-4000-8000-000000000001", participant.id, "2026-10-01T10:00:00.000Z");
    const first = await x.send("📋 Запросы участников", 70002);
    assert.match(first.payload.text, /Удаление анкеты/);
    x.database.removeAdmin("70002");
    const denied = await x.send("➡️ Следующие запросы", 70002);
    assert.match(denied.payload.text, /(нет доступа к запросам участников|доступ отозван)/i);
    assert.doesNotMatch(denied.payload.text, /Удаление анкеты/);
  } finally { x.close(); }
});

