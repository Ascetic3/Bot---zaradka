const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const ExcelJS = require("exceljs");
const { seedDemoDatabase, verifyDemoDatabase } = require("../src/demo/seed");
const { createDemoRecords, firstNames, lastNames, cityNames, contactOptions } = require("../src/demo/data");

const ownerId = "987654321";
const anchor = new Date("2026-10-24T12:00:00.000Z");

async function withDemo(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-demo-suite-"));
  const demoPath = path.join(dir, "data", "demo.sqlite");
  const productionPath = path.join(dir, "data", "club.sqlite");
  const prior = { DB_PATH: process.env.DB_PATH, OWNER_TELEGRAM_ID: process.env.OWNER_TELEGRAM_ID, DEMO_MODE: process.env.DEMO_MODE, BACKUP_AUTO_ENABLED: process.env.BACKUP_AUTO_ENABLED, BACKUP_DIR: process.env.BACKUP_DIR };
  fs.mkdirSync(path.dirname(demoPath), { recursive: true });
  try {
    process.env.DB_PATH = productionPath;
    process.env.OWNER_TELEGRAM_ID = ownerId;
    const options = { databasePath: demoPath, configuredDatabasePath: productionPath, productionDatabasePath: productionPath, ownerTelegramId: ownerId, now: anchor };
    const firstSeed = seedDemoDatabase(options);
    const repeatSeed = seedDemoDatabase(options);
    process.env.DB_PATH = demoPath;
    delete require.cache[require.resolve("../src/database")];
    const db = require("../src/database");
    return await run({ dir, demoPath, productionPath, db, firstSeed, repeatSeed });
  } finally {
    try { require("../src/database"); } catch {}
    const dbPath = require.resolve("../src/database");
    if (require.cache[dbPath]?.exports?.db?.open) require.cache[dbPath].exports.closeDatabase();
    delete require.cache[dbPath];
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("создаёт 150 разнообразных синтетических участников и штатно назначает владельца", () => withDemo(({ db, firstSeed, repeatSeed }) => {
  assert.equal(firstSeed.inserted, 150);
  assert.equal(repeatSeed.inserted, 0);
  assert.equal(repeatSeed.alreadySeeded, true);
  assert.equal(db.getParticipantCount(), 150);
  assert.equal(db.getAdminRole(ownerId), "owner");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role='owner'").get().n, 1);
  const people = db.db.prepare("SELECT * FROM participants").all();
  assert.equal(new Set(people.map((person) => person.phone)).size, 150);
  assert.ok(new Set(people.map((person) => person.first_name)).size >= 20);
  assert.ok(new Set(people.map((person) => person.last_name)).size >= 20);
  assert.ok(new Set(people.map((person) => `${person.first_name} ${person.last_name}`)).size >= 100);
  assert.ok(new Set(people.map((person) => person.city).filter(Boolean)).size >= 10);
  assert.equal(new Set(people.map((person) => person.preferred_contact)).size, 4);
  assert.ok(people.some((person) => person.city === null));
  assert.ok(people.some((person) => person.email === null));
  assert.ok(people.some((person) => person.referral_source === null));
  assert.ok(people.every((person) => person.phone_confirmed_at === null && person.personal_data_consent === 0 && person.consent_at === null));
}));

test("синтетические телефоны, email и аккаунты имеют явные демонстрационные значения", () => {
  const records = createDemoRecords(anchor);
  assert.ok(records.every((person) => /^\+999\d{9}$/.test(person.phone)));
  assert.ok(records.every((person) => person.email === null || /^[^@]+@[^@]+\.example$/.test(person.email)));
  assert.ok(records.flatMap((person) => person.accounts).every((account) => /^DEMO-(TG|MAX)-\d{3}$/.test(account.messenger_user_id)));
  assert.ok(records.some((person) => person.accounts.some((account) => account.platform === "telegram") && person.accounts.some((account) => account.platform === "max")));
  assert.ok(records.every((person) => firstNames.includes(person.first_name) && lastNames.includes(person.last_name)));
  assert.ok(cityNames.length >= 10 && contactOptions.length === 4);
});

test("даты распределены от текущей даты до 120 дней и дают разные окна статистики", () => withDemo(({ db }) => {
  const dates = db.db.prepare("SELECT registered_at FROM participants").all().map((row) => new Date(row.registered_at));
  const oldest = Math.min(...dates.map((date) => date.getTime()));
  const newest = Math.max(...dates.map((date) => date.getTime()));
  assert.ok(anchor.getTime() - oldest <= 120 * 24 * 60 * 60 * 1000);
  assert.ok(anchor.getTime() - newest >= 0);
  assert.ok(db.getParticipantStatistics().last_7_days > 0);
  assert.ok(db.getParticipantStatistics().last_30_days > db.getParticipantStatistics().last_7_days);
  assert.equal(db.getParticipantStatistics().total, 150);
}));

test("поиск, телефон, список по страницам и статистика работают с демонстрационной базой", () => withDemo(({ db }) => {
  const first = db.db.prepare("SELECT * FROM participants ORDER BY id LIMIT 1").get();
  assert.ok(db.searchParticipants(first.first_name).length > 0);
  assert.ok(db.searchParticipants(first.last_name).length > 0);
  assert.equal(db.searchParticipants(first.phone).length, 1);
  assert.equal(db.listParticipants(10, 0).length, 10);
  assert.equal(db.listParticipants(10, 10).length, 10);
  assert.notEqual(db.listParticipants(10, 0)[0].id, db.listParticipants(10, 10)[0].id);
  const stats = db.getParticipantStatistics();
  assert.equal(stats.total, 150);
  assert.ok(stats.cities.length >= 10);
  assert.ok(stats.referral_sources.length > 1);
  assert.equal(stats.preferred_contacts.reduce((sum, row) => sum + row.count, 0), 150);
}));

test("администратор видит баннер демонстрационных данных в меню /admin", async () => withDemo(async ({ db }) => {
  const previousMode = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  delete require.cache[require.resolve("../src/admin")];
  const { Bot } = require("grammy");
  const bot = new Bot("123456:DEMO_MENU_TEST", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/admin").registerAdmin(bot);
  let response;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method !== "sendMessage") throw new Error(`Unexpected API method ${method}`);
    response = payload.text;
    return { ok: true, result: { message_id: 1, date: 1, chat: { id: ownerId, type: "private" }, text: payload.text } };
  });
  try {
    await bot.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: Number(ownerId), type: "private" }, from: { id: Number(ownerId), is_bot: false, first_name: "Owner" }, entities: [{ type: "bot_command", offset: 0, length: 6 }], text: "/admin" } });
    assert.match(response, /🧪 Демонстрационный режим\. Данные вымышленные/);
    assert.match(response, /Административное меню/);
  } finally {
    if (previousMode === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = previousMode;
  }
}));
test("Excel содержит 150 строк, кириллицу, не подтверждённые телефоны и объединённые аккаунты", async () => withDemo(async ({ db }) => {
  const rows = db.getParticipantsForExport();
  assert.equal(rows.length, 150);
  const both = rows.find((row) => row.telegram_id && row.max_id);
  assert.ok(both);
  assert.match(both.telegram_id, /^DEMO-TG-/);
  assert.match(both.max_id, /^DEMO-MAX-/);
  const { createParticipantsWorkbook, getExportFilename } = require("../src/excel-export");
  const buffer = await createParticipantsWorkbook(rows);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Участники");
  assert.equal(sheet.rowCount, 151);
  assert.equal(sheet.columnCount, 13);
  assert.equal(sheet.getRow(2).getCell(2).value, rows[0].first_name);
  const xlsxRow = Array.from({ length: sheet.rowCount - 1 }, (_, index) => sheet.getRow(index + 2)).find((row) => row.getCell(1).value === String(both.id));
  assert.equal(xlsxRow.getCell(4).value, both.phone);
  assert.equal(xlsxRow.getCell(10).value, both.telegram_id);
  assert.equal(xlsxRow.getCell(11).value, both.max_id);
  assert.equal(xlsxRow.getCell(12).value, "Не подтверждён");
  const previous = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "true";
  try { assert.match(getExportFilename(anchor), /^ДЕМО_Магия_утра_участники_/); }
  finally { if (previous === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = previous; }
}));

test("повторное заполнение не дублирует записи и отказывается перезаписывать изменённые данные", () => withDemo(({ db, demoPath }) => {
  assert.equal(db.getParticipantCount(), 150);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 130);
  db.db.prepare("UPDATE participants SET first_name='Изменённое демо-имя' WHERE id=1").run();
  db.closeDatabase();
  delete require.cache[require.resolve("../src/database")];
  assert.throws(() => seedDemoDatabase({ databasePath: demoPath, configuredDatabasePath: "C:/some/other/club.sqlite", productionDatabasePath: "C:/some/other/club.sqlite", ownerTelegramId: ownerId, now: anchor }), /изменил|остановлен/i);
  process.env.DB_PATH = demoPath;
  const reopened = require("../src/database");
  assert.equal(reopened.db.prepare("SELECT first_name FROM participants WHERE id=1").get().first_name, "Изменённое демо-имя");
  assert.equal(reopened.getParticipantCount(), 150);
}));

test("команда генератора отказывается от рабочего пути и оставляет файл нетронутым", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-demo-path-"));
  const working = path.join(dir, "club.sqlite");
  const before = Buffer.from("untouched working database sentinel");
  fs.writeFileSync(working, before);
  try {
    assert.throws(() => seedDemoDatabase({ databasePath: working, configuredDatabasePath: working, productionDatabasePath: working, ownerTelegramId: ownerId }), /совпадает с рабочей базой/);
    assert.deepEqual(fs.readFileSync(working), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("проверка готовности требует 150 участников и правильного владельца", () => withDemo(({ demoPath }) => {
  assert.deepEqual(verifyDemoDatabase({ databasePath: demoPath, ownerTelegramId: ownerId }), { count: 150, ownerConfigured: true });
  assert.throws(() => verifyDemoDatabase({ databasePath: demoPath, ownerTelegramId: "987654320" }), /не является владельцем/);
}));

test("настройка запуска выбирает только demo.sqlite, отключает backup и метит режим", () => {
  const { configureDemoEnvironment } = require("../src/demo/start");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-demo-start-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const env = { DB_PATH: path.join(dir, "data", "club.sqlite"), BACKUP_AUTO_ENABLED: "true", BACKUP_DIR: path.join(dir, "backups") };
  try {
    const result = configureDemoEnvironment(env, dir);
    assert.equal(env.DB_PATH, path.join(dir, "data", "demo.sqlite"));
    assert.equal(env.DEMO_MODE, "true");
    assert.equal(env.BACKUP_AUTO_ENABLED, "false");
    assert.equal(result.backupDirectory, path.join(dir, "data", "demo-backups"));
    assert.throws(() => configureDemoEnvironment({ DB_PATH: path.join(dir, "data", "demo.sqlite") }, dir), /совпадает с рабочей базой/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
