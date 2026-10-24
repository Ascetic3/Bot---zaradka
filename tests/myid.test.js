const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Bot } = require("grammy");
const { registerMyId } = require("../src/myid");
function createBot() {
  const bot = new Bot("123456:MYID_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    assert.equal(method, "sendMessage"); sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
  });
  registerMyId(bot);
  let updateId = 0;
  return { sent, async send(id, chatType="private") {
    const chatId = chatType === "private" ? id : -12345;
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type: chatType }, from: { id, is_bot: false, first_name: "Test" }, text: "/myid", entities: [{ type: "bot_command", offset: 0, length: 5 }] } });
    return sent.at(-1);
  } };
}
test("/myid показывает Telegram ID отправителя в личном чате", async () => {
  const bot = createBot(); const response = await bot.send(7654321);
  assert.equal(response.text, "🆔 Ваш Telegram ID: 7654321\n\nЭтот идентификатор используется для настройки доступа к административной панели.");
});
test("/myid работает для незарегистрированного пользователя и не сохраняет ID", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-myid-")); process.env.DB_PATH = path.join(dir, "empty.sqlite");
  delete require.cache[require.resolve("../src/database")]; const db = require("../src/database");
  try { const bot = createBot(); const response = await bot.send(7654322); assert.match(response.text, /7654322/); assert.equal(db.getParticipantCount(), 0); assert.equal(db.getAdminRole(7654322), null); assert.equal(db.getDraft("telegram", 7654322), undefined); }
  finally { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; }
});
test("/myid в группе не раскрывает идентификатор", async () => {
  const bot = createBot(); const response = await bot.send(7654323, "group");
  assert.equal(response.text, "Команда /myid доступна только в личном чате с ботом.");
  assert.doesNotMatch(response.text, /7654323/);
});

