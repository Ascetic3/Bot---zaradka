const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-export-flow-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "71001";
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "test-v1";
  const modules = [
    "../src/database", "../src/admin", "../src/registration", "../src/registration-preview",
    "../src/profile", "../src/myid", "../src/main-menu", "../src/chat-guards", "../src/bot-handlers", "../src/participant-data", "../src/participant-data-menu"
  ];
  for (const id of modules) delete require.cache[require.resolve(id)];
  const db = require("../src/database");
  const bot = new Bot("123456:INTEGRATION_TEST_ONLY", {
    botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" }
  });
  const cleanups = require("../src/bot-handlers").registerBotHandlers(bot);
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, payload });
    const chatId = payload.chat_id ?? payload.chatId;
    return { ok: true, result: {
      message_id: sent.length, date: 1,
      chat: { id: chatId, type: "private" }, text: payload.text || "Документ отправлен",
      reply_markup: payload.reply_markup
    } };
  });
  let updateId = 0;
  async function send(text, id = 71001) {
    const current = ++updateId;
    await bot.handleUpdate({ update_id: current, message: {
      message_id: current, date: 1, chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Test" }, text,
      entities: /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text) ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined
    } });
    return sent.at(-1)?.payload;
  }
  const buttons = (payload) => payload?.reply_markup?.keyboard?.flat().map((button) => button.text) ?? [];
  const assertAdminMenu = (payload) => {
    assert.match(payload.text, /Административное меню/);
    for (const label of ["🔎 Найти участника", "👥 Все участники", "📊 Статистика", "📥 Скачать Excel", "🏠 Главное меню"])
      assert.ok(buttons(payload).includes(label), `В админ-меню отсутствует «${label}»`);
    assert.equal(buttons(payload).includes("Отмена"), false);
    assert.equal(buttons(payload).includes("✅ Подтвердить выгрузку"), false);
  };
  return {
    db, bot, sent, send, buttons, assertAdminMenu,
    addParticipant() {
      const participant = db.addParticipant({ first_name: "Вымышленное", last_name: "Имя", phone: "+79990001122" });
      db.linkAccount(participant.id, "telegram", "71001");
    },
    close() {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      try { db.closeDatabase(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      for (const key of ["DB_PATH", "OWNER_TELEGRAM_ID", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION"])
        delete process.env[key];
      for (const id of modules) delete require.cache[require.resolve(id)];
    }
  };
}

test("канонический порядок обработчиков: отмена Excel завершает состояние и заменяет клавиатуру админ-меню", async () => {
  const x = setup();
  try {
    x.addParticipant();
    const prompt = await x.send("📥 Скачать Excel");
    assert.ok(x.buttons(prompt).includes("✅ Подтвердить выгрузку"));
    assert.ok(x.buttons(prompt).includes("Отмена"));

    const cancelled = await x.send("Отмена");
    assert.match(cancelled.text, /Выгрузка отменена/);
    x.assertAdminMenu(cancelled);
    assert.equal(x.sent.some(({ method }) => method === "sendDocument"), false);

    const repeatedCancel = await x.send("Отмена");
    x.assertAdminMenu(repeatedCancel);
    assert.equal(x.sent.some(({ method }) => method === "sendDocument"), false);

    const staleConfirm = await x.send("✅ Подтвердить выгрузку");
    assert.match(staleConfirm.text, /была отменена/);
    x.assertAdminMenu(staleConfirm);
    assert.equal(x.sent.some(({ method }) => method === "sendDocument"), false);
  } finally { x.close(); }
});

test("устаревшие Excel-кнопки после истечения срока восстанавливают меню и не запускают файл", async () => {
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  const x = setup();
  try {
    x.addParticipant();
    const prompt = await x.send("📥 Скачать Excel");
    assert.ok(x.buttons(prompt).includes("Отмена"));
    fakeNow += 10 * 60_000 + 1;

    const expiredCancel = await x.send("Отмена");
    assert.match(expiredCancel.text, /Срок подтверждения выгрузки истёк/);
    x.assertAdminMenu(expiredCancel);
    const expiredConfirm = await x.send("✅ Подтвердить выгрузку");
    assert.match(expiredConfirm.text, /Подтверждение выгрузки истекло/);
    x.assertAdminMenu(expiredConfirm);
    assert.equal(x.sent.some(({ method }) => method === "sendDocument"), false);
  } finally {
    x.close();
    Date.now = realNow;
  }
});

test("после просроченного Excel-подтверждения администратор может начать другое действие", async () => {
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  const x = setup();
  try {
    x.addParticipant();
    await x.send("📥 Скачать Excel");
    fakeNow += 10 * 60_000 + 1;
    x.assertAdminMenu(await x.send("Отмена"));
    const stats = await x.send("📊 Статистика");
    assert.match(stats.text, /Статистика клуба/);
    assert.ok(x.buttons(stats).includes("🔄 Обновить статистику"));
  } finally {
    x.close();
    Date.now = realNow;
  }
});

test("общий порядок обработчиков сохраняет команды и пользовательский профиль", async () => {
  const x = setup();
  try {
    const start = await x.send("/start", 71002);
    assert.match(start.text, /Добро пожаловать в клуб/);
    assert.ok(x.buttons(start).includes("Зарегистрироваться"));
    x.addParticipant();
    const profile = await x.send("Моя анкета");
    assert.match(profile.text, /Ваша анкета/);
    assert.ok(x.buttons(profile).includes("✏️ Изменить данные"));
  } finally { x.close(); }
});

