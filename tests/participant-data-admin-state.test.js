const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-data-admin-state-"));
  const envNames = ["DB_PATH", "OWNER_TELEGRAM_ID", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "DEMO_MODE"];
  const previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  process.env.DB_PATH = path.join(directory, "synthetic.sqlite");
  process.env.OWNER_TELEGRAM_ID = "71001";
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "synthetic-v1";
  delete process.env.DEMO_MODE;
  const modules = [
    "../src/database", "../src/admin", "../src/registration", "../src/registration-preview",
    "../src/profile", "../src/myid", "../src/main-menu", "../src/chat-guards",
    "../src/bot-handlers", "../src/participant-data", "../src/participant-data-menu",
    "../src/account-links", "../src/request-limits", "../src/participant-service"
  ];
  for (const name of modules) delete require.cache[require.resolve(name)];
  const database = require("../src/database");
  const participant = database.addParticipant({
    first_name: "ВымышленноеИмя", last_name: "ТестоваяФамилия", phone: "+99970000001",
    phone_confirmed_at: "2026-10-20T10:00:00.000Z", personal_data_consent: true,
    consent_at: "2026-10-20T10:01:00.000Z", consent_version: "synthetic-v1"
  }, { platform: "telegram", messenger_user_id: "71001" });
  database.saveDraft("telegram", "71001", "first_name", { synthetic_answer: "kept" });
  const bot = new Bot("123456:INTEGRATION_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const cleanups = require("../src/bot-handlers").registerBotHandlers(bot);
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, payload });
    const chatId = payload.chat_id ?? payload.chatId;
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: chatId, type: "private" }, text: payload.text ?? "", reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text) {
    const id = ++updateId;
    const before = sent.length;
    await bot.handleUpdate({ update_id: id, message: {
      message_id: id, date: 1, chat: { id: 71001, type: "private" },
      from: { id: 71001, is_bot: false, first_name: "Synthetic" }, text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/, 1)[0].length }] } : {})
    } });
    return sent.slice(before).filter((entry) => entry.method === "sendMessage").map((entry) => entry.payload);
  }
  return {
    database, participant, send,
    close() {
      for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      try { database.closeDatabase(); } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) value === undefined ? delete process.env[key] : process.env[key] = value;
      for (const name of modules) delete require.cache[require.resolve(name)];
    }
  };
}

test("«Мои данные» закрывает поиск, показывает пользовательскую клавиатуру и сохраняет черновик регистрации", async () => {
  const x = setup();
  try {
    await x.send("/admin");
    await x.send("🔎 Найти участника");
    const draftBefore = x.database.getDraft("telegram", "71001");
    const [dataMenu] = await x.send("🔐 Мои данные");
    assert.match(dataMenu.text, /🔐 Мои данные/);
    assert.ok(dataMenu.reply_markup.keyboard.flat().some((button) => button.text === "📄 Статус моих запросов"));
    assert.deepEqual(x.database.getDraft("telegram", "71001"), draftBefore);

    const [mainMenu] = await x.send("🏠 Главное меню");
    assert.match(mainMenu.text, /Добро пожаловать/);
    const [reopened] = await x.send("🔐 Мои данные");
    assert.match(reopened.text, /🔐 Мои данные/);
    assert.deepEqual(x.database.getDraft("telegram", "71001"), draftBefore);
  } finally { x.close(); }
});

test("«Мои данные» закрывает активное управление администраторами и не принимает старый ввод ID", async () => {
  const x = setup();
  try {
    await x.send("/admin");
    await x.send("⚙️ Управление администраторами");
    await x.send("➕ Добавить администратора");
    const [dataMenu] = await x.send("🔐 Мои данные");
    assert.match(dataMenu.text, /🔐 Мои данные/);

    const replies = await x.send("72002");
    assert.equal(x.database.getAdminRole("72002"), null);
    assert.equal(replies.some((payload) => /Telegram ID должен состоять/.test(payload.text)), false);
    assert.equal(x.database.getDraft("telegram", "71001").answers.synthetic_answer, "kept");
    assert.equal(x.participant.first_name, "ВымышленноеИмя");
  } finally { x.close(); }
});

