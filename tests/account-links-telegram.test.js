const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Bot } = require("grammy");

const moduleIds = [
  "../src/database", "../src/participant-service", "../src/account-links", "../src/admin",
  "../src/registration", "../src/registration-preview", "../src/profile", "../src/myid",
  "../src/main-menu", "../src/chat-guards", "../src/bot-handlers", "../src/participant-data", "../src/participant-data-menu"
];

function setup({ demo = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-account-links-ui-"));
  const oldEnv = Object.fromEntries(["DB_PATH", "OWNER_TELEGRAM_ID", "DEMO_MODE", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION"]
    .map((key) => [key, process.env[key]]));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "72001";
  process.env.DEMO_MODE = String(demo);
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "synthetic-v1";
  let db;
  let bot;
  let cleanups = [];
  let updateId = 0;
  const sent = [];

  function attachApi(targetBot) {
    targetBot.api.config.use(async (_previous, method, payload) => {
      sent.push({ method, payload });
      if (method === "answerCallbackQuery") return { ok: true, result: true };
      const chatId = payload.chat_id ?? payload.chatId ?? 72001;
      return { ok: true, result: {
        message_id: payload.message_id ?? sent.length, date: 1,
        chat: { id: chatId, type: "private" }, text: payload.text || "",
        reply_markup: payload.reply_markup
      } };
    });
  }
  function startBot() {
    for (const id of moduleIds) delete require.cache[require.resolve(id)];
    db = require("../src/database");
    bot = new Bot("123456:LINK_UI_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
    cleanups = require("../src/bot-handlers").registerBotHandlers(bot);
    attachApi(bot);
  }
  startBot();

  async function send(text, id = 72001, chatType = "private") {
    const current = ++updateId;
    const chat = { id: chatType === "private" ? id : -777, type: chatType };
    await bot.handleUpdate({ update_id: current, message: {
      message_id: current, date: 1, chat,
      from: { id, is_bot: false, first_name: "Synthetic" }, text,
      entities: /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text) ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined
    } });
    return sent.at(-1);
  }
  async function callback(data, id = 72001, chatType = "private") {
    const current = ++updateId;
    const chat = { id: chatType === "private" ? id : -777, type: chatType };
    await bot.handleUpdate({ update_id: current, callback_query: {
      id: `synthetic-callback-${current}`,
      from: { id, is_bot: false, first_name: "Synthetic" },
      chat_instance: "synthetic-chat", data,
      message: { message_id: current, date: 1, chat, text: "Связанные аккаунты" }
    } });
    return sent.at(-1);
  }
  function createRequest({ targetPlatform = "max", targetId = "MAX-SYNTHETIC-001", ownerId = "72001" } = {}) {
    const now = new Date();
    const timestamp = now.toISOString();
    const participant = db.addParticipant({
      first_name: "СинтетическоеИмя", last_name: "ТестоваяФамилия", phone: "+79991112233",
      phone_confirmed_at: timestamp, personal_data_consent: true, consent_at: timestamp,
      consent_version: "synthetic-v1"
    }, { platform: "telegram", messenger_user_id: ownerId });
    const request = db.createAccountLinkRequest({
      requestId: crypto.randomUUID(), participantId: participant.id,
      targetPlatform, targetAccountId: targetId, verifiedPhone: "+79991112233",
      proofMethod: "synthetic_fixture", verifiedAt: timestamp,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(), now: timestamp
    });
    return { participant, request };
  }
  function inlineButtons(entry) {
    return entry?.payload?.reply_markup?.inline_keyboard?.flat() ?? [];
  }
  function requestState(id) {
    return db.db.prepare("SELECT state FROM account_link_requests WHERE request_id=?").get(id)?.state;
  }
  function restart() {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    db.closeDatabase();
    startBot();
  }
  function close() {
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    try { db.closeDatabase(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(oldEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
    for (const id of moduleIds) delete require.cache[require.resolve(id)];
  }
  return { get db() { return db; }, get bot() { return bot; }, sent, send, callback, createRequest, inlineButtons, requestState, restart, close };
}

test("пользователь без запросов видит привязанный Telegram и понятный пустой экран", async () => {
  const x = setup();
  try {
    x.db.addParticipant({ first_name: "СинтетическоеИмя", phone: "+79991112233", personal_data_consent: true, consent_at: new Date().toISOString(), consent_version: "synthetic-v1" }, { platform: "telegram", messenger_user_id: "72001" });
    const msg = await x.send("🔗 Связанные аккаунты");
    assert.match(msg.payload.text, /Подключены: Telegram/);
    assert.match(msg.payload.text, /Ожидающих запросов на привязку нет/);
    assert.ok(x.inlineButtons(msg).some((button) => button.callback_data === "link:menu"));
  } finally { x.close(); }
});

test("один запрос показывается без телефона и идентификатора нового аккаунта", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    const msg = await x.send("🔗 Связанные аккаунты");
    assert.match(msg.payload.text, /Платформа: MAX/);
    assert.match(msg.payload.text, /Ожидает вашего решения/);
    assert.doesNotMatch(msg.payload.text, /\+79991112233|MAX-SYNTHETIC-001|request\.request_id/);
    assert.ok(x.inlineButtons(msg).some((button) => button.callback_data === `link:prepare:approve:${request.request_id}`));
    assert.ok(x.inlineButtons(msg).some((button) => button.callback_data === `link:prepare:reject:${request.request_id}`));
  } finally { x.close(); }
});

test("неизвестная платформа отображается без кнопок решения и не принимается из поддельного callback", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    x.db.db.pragma("ignore_check_constraints = ON");
    x.db.db.prepare("UPDATE account_link_requests SET target_platform='future-platform' WHERE request_id=?").run(request.request_id);
    x.db.db.pragma("ignore_check_constraints = OFF");
    const screen = await x.send("🔗 Связанные аккаунты");
    assert.match(screen.payload.text, /Платформа: неизвестная/);
    assert.ok(x.inlineButtons(screen).every((button) => !button.callback_data.includes(request.request_id)));
    const forged = await x.callback(`link:prepare:approve:${request.request_id}`);
    assert.match(forged.payload.text, /Платформа запроса не распознана/);
    assert.equal(x.requestState(request.request_id), "pending");
  } finally { x.close(); }
});

test("одобрение требует второго явного нажатия и само по себе не привязывает MAX", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    const prepare = await x.callback(`link:prepare:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "pending");
    assert.match(prepare.payload.text, /Подтвердите, что хотите подтвердить/);
    assert.ok(x.inlineButtons(prepare).some((button) => button.callback_data === `link:approve:${request.request_id}`));

    const approved = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "approved");
    assert.match(approved.payload.text, /ещё не привязало новый аккаунт/);
    assert.match(approved.payload.text, /адаптер пока не подключён/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);

    const replay = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "approved");
    assert.match(replay.payload.text, /одобрили запрос/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("отклонение требует подтверждения, переводит запрос в terminal state и безопасно повторяется", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    await x.callback(`link:prepare:reject:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "pending");
    const rejected = await x.callback(`link:reject:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "rejected");
    assert.match(rejected.payload.text, /Запрос отклонён/);
    const replay = await x.callback(`link:reject:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "rejected");
    assert.match(replay.payload.text, /отклонили запрос/);
  } finally { x.close(); }
});

test("истёкший запрос и его устаревшая кнопка не могут быть одобрены", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    x.db.db.prepare("UPDATE account_link_requests SET expires_at=? WHERE request_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), request.request_id);
    const stale = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "expired");
    assert.match(stale.payload.text, /истёк/);
    assert.ok(x.inlineButtons(stale).every((button) => button.callback_data === "link:list" || button.callback_data === "link:menu"));
  } finally { x.close(); }
});

test("чужой Telegram ID и поддельный callback не меняют запрос", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    const outsider = await x.callback(`link:approve:${request.request_id}`, 72002);
    assert.equal(x.requestState(request.request_id), "pending");
    assert.match(outsider.payload.text, /не найдена|не относится к вашему аккаунту/);
    const forged = await x.callback("link:approve:not-a-uuid");
    assert.equal(x.requestState(request.request_id), "pending");
    assert.match(forged.payload.text, /устарела или недействительна/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("групповой callback и повтор после отзыв согласия не связывают аккаунт", async () => {
  const x = setup();
  try {
    const { participant, request } = x.createRequest();
    await x.callback(`link:approve:${request.request_id}`, 72001, "group");
    assert.equal(x.requestState(request.request_id), "pending");
    x.db.db.prepare("UPDATE participants SET personal_data_consent=0 WHERE id=?").run(participant.id);
    const result = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "cancelled");
    assert.match(result.payload.text, /согласие на обработку данных сейчас неактивно/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("удалённая анкета делает старую кнопку недействительной", async () => {
  const x = setup();
  try {
    const { participant, request } = x.createRequest();
    x.db.deleteParticipantById(participant.id);
    const stale = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), undefined);
    assert.match(stale.payload.text, /Анкета участника не найдена|Запрос не найден/);
  } finally { x.close(); }
});

test("запрос сохраняется после перезапуска и может быть одобрен тем же владельцем", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    x.restart();
    const screen = await x.send("🔗 Связанные аккаунты");
    assert.ok(x.inlineButtons(screen).some((button) => button.callback_data === `link:prepare:approve:${request.request_id}`));
    await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "approved");
  } finally { x.close(); }
});

test("двойное конкурентное одобрение оставляет одну конечную запись и не создаёт MAX-аккаунт", async () => {
  const x = setup();
  try {
    const { request } = x.createRequest();
    await x.callback(`link:prepare:approve:${request.request_id}`);
    const first = x.callback(`link:approve:${request.request_id}`);
    const second = x.callback(`link:approve:${request.request_id}`);
    await Promise.all([first, second]);
    assert.equal(x.requestState(request.request_id), "approved");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("деморежим не показывает действия и не может выполнить поддельное одобрение", async () => {
  const x = setup({ demo: true });
  try {
    const { request } = x.createRequest();
    const screen = await x.send("🔗 Связанные аккаунты");
    assert.match(screen.payload.text, /(выключены|отключены) в демонстрационном режиме/);
    assert.ok(x.inlineButtons(screen).every((button) => !/link:(prepare|approve|reject):/.test(button.callback_data)));
    const forged = await x.callback(`link:approve:${request.request_id}`);
    assert.equal(x.requestState(request.request_id), "pending");
    assert.match(forged.payload.text, /демонстрационном режиме/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE platform='max'").get().n, 0);
  } finally { x.close(); }
});

test("возврат в главное меню убирает inline-кнопки и показывает пользовательскую клавиатуру", async () => {
  const x = setup();
  try {
    x.db.addParticipant({ first_name: "СинтетическоеИмя", phone: "+79991112233", personal_data_consent: true, consent_at: new Date().toISOString(), consent_version: "synthetic-v1" }, { platform: "telegram", messenger_user_id: "72001" });
    await x.send("🔗 Связанные аккаунты");
    await x.callback("link:menu");
    const menu = x.sent.at(-1);
    assert.equal(menu.method, "sendMessage");
    assert.ok(menu.payload.reply_markup.keyboard.flat().some((button) => button.text === "Зарегистрироваться"));
    assert.ok(menu.payload.reply_markup.keyboard.flat().some((button) => button.text === "🔗 Связанные аккаунты"));
    const edit = x.sent.findLast((entry) => entry.method === "editMessageText");
    assert.deepEqual(edit.payload.reply_markup.inline_keyboard, []);
  } finally { x.close(); }
});

test("обычный участник без анкеты не получает экран привязок", async () => {
  const x = setup();
  try {
    const response = await x.send("🔗 Связанные аккаунты", 72002);
    assert.match(response.payload.text, /Анкета участника не найдена/);
    assert.equal(response.payload.reply_markup, undefined);
  } finally { x.close(); }
});

test("кнопка связанных аккаунтов не становится ответом незавершённой регистрации или админ-ввода", async () => {
  const x = setup();
  try {
    x.db.saveDraft("telegram", "72001", "first_name", { policy_url: process.env.PRIVACY_POLICY_URL, policy_version: process.env.PRIVACY_POLICY_VERSION });
    const linkScreen = await x.send("🔗 Связанные аккаунты");
    assert.match(linkScreen.payload.text, /Анкета участника не найдена/);
    assert.equal(x.db.getDraft("telegram", "72001").current_step, "first_name");

    await x.send("/admin");
    await x.send("⚙️ Управление администраторами");
    await x.send("➕ Добавить администратора");
    const secondLinkScreen = await x.send("🔗 Связанные аккаунты");
    assert.doesNotMatch(secondLinkScreen.payload.text, /Telegram ID должен состоять/);
    assert.equal(x.db.getAdminRole("72003"), null);
  } finally { x.close(); }
});
test("деморежим объясняет, почему аккаунт владельца не связан с синтетическими анкетами и даёт безопасный пример без записей", async () => {
  const x = setup({ demo: true });
  try {
    const before = {
      participants: x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n,
      accounts: x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n,
      admins: x.db.db.prepare("SELECT COUNT(*) AS n FROM admins").get().n
    };
    x.db.findParticipantByTelegramId = () => { throw new Error("demo screen must not look up synthetic participant by real Telegram ID"); };
    x.db.findParticipantByTelegramIdIncludingWithdrawn = () => { throw new Error("demo screen must not inspect participant consent"); };
    x.db.listLinkedPlatformsForTelegram = () => { throw new Error("demo screen must not inspect real account links"); };
    x.db.listAccountLinkRequestsForTelegram = () => { throw new Error("demo screen must not inspect link requests"); };
    const screen = await x.send("🔗 Связанные аккаунты");
    assert.match(screen.payload.text, /демонстрационный бот не связывает ваш личный Telegram-аккаунт/i);
    assert.match(screen.payload.text, /намеренная защита/i);
    assert.ok(x.inlineButtons(screen).some((button) => button.callback_data === "link:demo-preview"));
    assert.doesNotMatch(screen.payload.text, /Анкета участника не найдена/i);

    await x.callback("link:demo-preview");
    const preview = x.sent.at(-1);
    assert.match(preview.payload.text, /DEMO-001/);
    assert.match(preview.payload.text, /Только демонстрационные данные/);
    assert.ok(x.inlineButtons(preview).some((button) => button.callback_data === "link:list"));
    assert.deepEqual({
      participants: x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n,
      accounts: x.db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n,
      admins: x.db.db.prepare("SELECT COUNT(*) AS n FROM admins").get().n
    }, before);
  } finally { x.close(); }
});

test("экран связанных аккаунтов различает отсутствие анкеты и отзыв согласия, не раскрывая данные", async () => {
  const x = setup();
  try {
    const missing = await x.send("🔗 Связанные аккаунты", 72002);
    assert.match(missing.payload.text, /(не найдена|не привязана анкета)/i);
    const participant = x.db.addParticipant({
      first_name: "СинтетическоеИмя", phone: "+79991112233", personal_data_consent: true,
      consent_at: new Date().toISOString(), consent_version: "synthetic-v1"
    }, { platform: "telegram", messenger_user_id: "72001" });
    x.db.recordConsentWithdrawalRequest(participant.id, new Date().toISOString(), participant.consent_at);
    const restricted = await x.send("🔗 Связанные аккаунты");
    assert.match(restricted.payload.text, /доступ(?: к анкете участника)? ограничен после отзыва согласия/i);
    assert.doesNotMatch(restricted.payload.text, /СинтетическоеИмя|\+79991112233/);
  } finally { x.close(); }
});
