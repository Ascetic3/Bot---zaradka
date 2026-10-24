const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");

const ownerId = 61001001;
const userId = 61001002;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-reliability-"));
  process.env.DB_PATH = path.join(dir, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = String(ownerId);
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "test-policy-v1";
  for (const name of ["database", "registration", "admin", "myid"]) {
    const target = name === "database" ? "../src/database" : `../src/${name}`;
    delete require.cache[require.resolve(target)];
  }
  const db = require("../src/database");
  const bot = new Bot("123456:RELIABILITY_TEST_ONLY", {
    botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" }
  });
  bot.command("start", (ctx) => ctx.reply("Главное меню"));
  require("../src/myid").registerMyId(bot);
  require("../src/registration").registerRegistration(bot);
  require("../src/admin").registerAdmin(bot);
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected API method: ${method}`);
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text, id = userId, command = false) {
    const message = {
      message_id: ++updateId,
      date: 1,
      chat: { id, type: "private" },
      from: { id, is_bot: false, first_name: "Тест" },
      text
    };
    if (command) message.entities = [{ type: "bot_command", offset: 0, length: text.indexOf(" ") > 0 ? text.indexOf(" ") : text.length }];
    await bot.handleUpdate({ update_id: updateId, message });
    return sent.at(-1);
  }
  function startDraft(id = userId) {
    db.saveDraft("telegram", id, "first_name", {
      policy_url: "https://policy.invalid/test",
      policy_version: "test-policy-v1",
      consent_at: "2026-10-23T00:00:00.000Z",
      consent_version: "test-policy-v1",
      consent_given_by: String(id),
      personal_data_consent: true
    });
  }
  return {
    db, bot, sent, send, startDraft,
    close() {
      try { db.closeDatabase(); } catch {}
      fs.rmSync(dir, { recursive: true, force: true });
      for (const key of ["DB_PATH", "OWNER_TELEGRAM_ID", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "DEMO_MODE"]) delete process.env[key];
      for (const name of ["database", "registration", "admin", "myid"]) {
        const target = name === "database" ? "../src/database" : `../src/${name}`;
        delete require.cache[require.resolve(target)];
      }
    }
  };
}

test(".gitignore исключает секреты, SQLite, журналы и резервные копии, но не исходники и тесты", () => {
  const rules = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  for (const pattern of [".env", "*.db", "*.sqlite", "*.sqlite3", "*-wal", "*-shm", "*-journal", "*.db.backup", "*.db.bak", "*.sqlite.backup", "*.sqlite.bak", "*.sqlite3.backup", "*.sqlite3.bak"]) {
    assert.ok(rules.split(/\r?\n/).includes(pattern), `Отсутствует правило ${pattern}`);
  }
  assert.equal(rules.split(/\r?\n/).includes("src/"), false);
  assert.equal(rules.split(/\r?\n/).includes("tests/"), false);
});

for (const [command, expected] of [
  ["/admin", /Административное меню/],
  ["/myid", /Ваш Telegram ID/],
  ["/start", /Главное меню/]
]) {
  test(`${command} обрабатывается во время активной регистрации и сохраняет черновик`, async () => {
    const x = setup();
    try {
      const senderId = command === "/admin" ? ownerId : userId;
      x.startDraft(senderId);
      const before = x.db.getDraft("telegram", senderId);
      const response = await x.send(command, senderId, true);
      assert.match(response.text, expected);
      assert.deepEqual(x.db.getDraft("telegram", senderId), before);
    } finally { x.close(); }
  });
}

test("после возврата из меню регистрация продолжается с сохранённого вопроса", async () => {
  const x = setup();
  try {
    x.startDraft();
    await x.send("/start", userId, true);
    assert.equal(x.db.getDraft("telegram", userId).current_step, "first_name");
    const response = await x.send("Зарегистрироваться");
    assert.match(response.text, /Как вас зовут/);
    assert.equal(x.db.getDraft("telegram", userId).current_step, "first_name");
    const next = await x.send("Алексей");
    assert.match(next.text, /фамилию/i);
    assert.equal(x.db.getDraft("telegram", userId).answers.first_name, "Алексей");
  } finally { x.close(); }
});
