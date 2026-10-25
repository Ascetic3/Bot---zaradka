const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Bot } = require("grammy");
const { createRateLimiter, DEFAULT_LIMITS, readRateLimitsFromEnvironment } = require("../src/request-limits");
const { ExpiringMap } = require("../src/expiring-map");

test("rate limits are isolated by Telegram ID and expire after the configured window", () => {
  let timestamp = 100;
  const limiter = createRateLimiter({ limits: { search: { limit: 2, windowMs: 1_000 } }, now: () => timestamp, cleanupIntervalMs: 0 });
  try {
    assert.equal(limiter.consume(10, "search").allowed, true);
    assert.equal(limiter.consume(10, "search").allowed, true);
    assert.deepEqual(limiter.consume(10, "search"), { allowed: false, retryAfterSeconds: 1 });
    assert.equal(limiter.consume(11, "search").allowed, true);
    timestamp += 1_001;
    assert.equal(limiter.consume(10, "search").allowed, true);
    assert.equal(limiter.size, 2);
  } finally { limiter.stop(); }
});

test("rate-limit entries are cleaned up from memory", () => {
  let timestamp = 0;
  const limiter = createRateLimiter({ limits: { cleanup_test: { limit: 1, windowMs: 10 } }, now: () => timestamp, cleanupIntervalMs: 0 });
  try {
    limiter.consume(123, "cleanup_test");
    assert.equal(limiter.size, 1);
    timestamp = 11;
    limiter.cleanup();
    assert.equal(limiter.size, 0);
  } finally { limiter.stop(); }
});

test("temporary user-flow state expires and can be stopped", () => {
  let timestamp = 0;
  const state = new ExpiringMap(100, { now: () => timestamp, cleanupIntervalMs: 0 });
  state.set("temporary", { step: "search" });
  timestamp = 101;
  assert.equal(state.get("temporary"), undefined);
  state.set("again", 1);
  state.stop();
  assert.equal(state.size, 0);
});

test("cancel bypasses a full answer limit and removes only the current user's registration draft", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-limit-registration-"));
  process.env.DB_PATH = path.join(directory, "test.sqlite");
  process.env.PRIVACY_POLICY_URL = "https://policy.invalid/test";
  process.env.PRIVACY_POLICY_VERSION = "test-v1";
  process.env.PRIVACY_POLICY_PUBLISHED = "true";
  for (const name of ["../src/database", "../src/registration"]) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const sent = [];
  const bot = new Bot("123456:RATE_LIMIT_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const limiter = createRateLimiter({ limits: { registration_continue: { limit: 1, windowMs: 60_000 } }, cleanupIntervalMs: 0 });
  require("../src/registration").registerRegistration(bot, { rateLimiter: limiter });
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
  });
  const id = 744001;
  db.saveDraft("telegram", id, "first_name", {
    policy_url: "https://policy.invalid/test", policy_version: "test-v1", personal_data_consent: true,
    consent_at: "2026-10-20T00:00:00.000Z", consent_version: "test-v1", consent_given_by: String(id)
  });
  let updateId = 0;
  const send = async (text) => {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1,
      chat: { id, type: "private" }, from: { id, is_bot: false, first_name: "Synthetic" }, text } });
    return sent.at(-1);
  };
  try {
    assert.match((await send("ВымышленноеИмя")).text, /фамилию/i);
    assert.equal(db.getDraft("telegram", id).answers.first_name, "ВымышленноеИмя");
    assert.match((await send("❌ Отменить регистрацию")).text, /Регистрация отменена/);
    assert.equal(db.getDraft("telegram", id), undefined);
  } finally {
    limiter.stop();
    db.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
    for (const key of ["DB_PATH", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PRIVACY_POLICY_PUBLISHED"]) delete process.env[key];
    for (const name of ["../src/database", "../src/registration"]) delete require.cache[require.resolve(name)];
  }
});

test("default per-operation limits leave room for the complete normal registration", () => {
  assert.ok(DEFAULT_LIMITS.registration_continue.limit >= 7);
  assert.ok(DEFAULT_LIMITS.registration_continue.windowMs >= 60_000);
  assert.notEqual(DEFAULT_LIMITS.excel, DEFAULT_LIMITS.statistics);
});

test("лимиты можно безопасно настроить переменными окружения, ошибочные значения игнорируются", () => {
  const limits = readRateLimitsFromEnvironment({
    BOT_LIMIT_REGISTRATION_ANSWERS_PER_MINUTE: "45",
    BOT_LIMIT_EXCEL_PER_5_MINUTES: "0",
    BOT_LIMIT_STATISTICS_PER_MINUTE: "many"
  });
  assert.equal(limits.registration_continue.limit, 45);
  assert.equal(limits.excel.limit, DEFAULT_LIMITS.excel.limit);
  assert.equal(limits.statistics.limit, DEFAULT_LIMITS.statistics.limit);
});

test("административный поиск ограничен отдельно для каждого Telegram ID, а отмена всегда доступна", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "magic-limit-admin-"));
  process.env.DB_PATH = path.join(directory, "test.sqlite");
  process.env.OWNER_TELEGRAM_ID = "744101";
  for (const name of ["../src/database", "../src/admin"]) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  const bot = new Bot("123456:ADMIN_LIMIT_TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const limiter = createRateLimiter({ limits: { admin_search: { limit: 1, windowMs: 60_000 } }, cleanupIntervalMs: 0 });
  require("../src/admin").registerAdmin(bot, { rateLimiter: limiter });
  db.addAdmin("744102");
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push(payload);
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
  });
  let updateId = 0;
  async function send(text, id) {
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1,
      chat: { id, type: "private" }, from: { id, is_bot: false, first_name: "Admin" }, text } });
    return sent.at(-1);
  }
  try {
    assert.match((await send("🔎 Найти участника", 744101)).text, /Введите имя/);
    assert.match((await send("выдуманный запрос", 744101)).text, /Ничего не найдено/);
    assert.match((await send("🔎 Найти участника", 744101)).text, /Введите имя/);
    assert.match((await send("второй запрос", 744101)).text, /Слишком много запросов/);
    assert.match((await send("🔎 Найти участника", 744102)).text, /Введите имя/);
    assert.match((await send("отдельный запрос", 744102)).text, /Ничего не найдено/);
    const cancelled = await send("Отмена", 744101);
    assert.match(cancelled.text, /Административное меню/);
    const keyboard = cancelled.reply_markup.keyboard.flat().map((button) => button.text);
    assert.ok(keyboard.includes("📊 Статистика"));
    assert.equal(keyboard.includes("Отмена"), false);
    assert.match((await send("📊 Статистика", 744101)).text, /Статистика клуба/);
  } finally {
    limiter.stop();
    db.closeDatabase();
    fs.rmSync(directory, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.OWNER_TELEGRAM_ID;
    for (const name of ["../src/database", "../src/admin"]) delete require.cache[require.resolve(name)];
  }
});

