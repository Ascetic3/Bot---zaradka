const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const ExcelJS = require("exceljs");
const { InputFile, Bot } = require("grammy");
const exportModule = require("../src/excel-export");

test("переопределённый uuid сохраняет CommonJS API, нужный ExcelJS", async () => {
  const excelRequire = createRequire(require.resolve("exceljs"));
  const uuidEntry = excelRequire.resolve("uuid");
  const uuidPackagePath = path.resolve(path.dirname(uuidEntry), "..", "..", "package.json");
  const uuidPackage = JSON.parse(fs.readFileSync(uuidPackagePath, "utf8"));
  assert.equal(uuidPackage.version, "11.1.1");
  assert.match(excelRequire("uuid").v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

  const buffer = await exportModule.createParticipantsWorkbook([{
    id: "900000000001",
    first_name: "Ёлка",
    last_name: "Тестовая",
    phone: "+79991234567",
    city: null,
    email: null,
    preferred_contact: "Telegram",
    referral_source: null,
    registered_at: "2026-10-24T10:00:00.000Z",
    telegram_id: "700000001",
    max_id: null,
    phone_confirmed_at: "2026-10-24T10:00:00.000Z",
    consent_at: null
  }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Участники");
  assert.equal(sheet.getRow(2).getCell(2).value, "Ёлка");
  assert.equal(sheet.getRow(2).getCell(4).value, "+79991234567");
  assert.equal(sheet.getRow(2).getCell(2).type, ExcelJS.ValueType.String);
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-excel-test-"));
  process.env.DB_PATH = path.join(dir, "export.sqlite");
  process.env.OWNER_TELEGRAM_ID = "70001";
  delete require.cache[require.resolve("../src/database")];
  delete require.cache[require.resolve("../src/admin")];
  const db = require("../src/database");
  const bot = new Bot("123456:TEST_ONLY", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  require("../src/admin").registerAdmin(bot);
  const sent = [];
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
  });
  let updateId = 0;
  async function send(text, id = 70001, type = "private") {
    const chatId = type === "private" ? id : -555;
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: chatId, type }, from: { id, is_bot: false, first_name: "Test" }, text } });
    return sent.at(-1);
  }
  function add(index, data = {}) {
    const participant = db.addParticipant({ first_name: `Имя${index}`, phone: `+7999000${String(index).padStart(4, "0")}`, ...data });
    return participant;
  }
  return {
    db, send, sent, add,
    close() {
      db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID;
      delete require.cache[require.resolve("../src/database")]; delete require.cache[require.resolve("../src/admin")];
    }
  };
}

test("выгрузка из пустой базы возвращает пустой список и бот не предлагает отправлять пустой файл", async () => {
  const x = setup();
  try {
    assert.deepEqual(x.db.getParticipantsForExport(), []);
    assert.match((await x.send("📥 Скачать Excel")).payload.text, /Пока нет участников/);
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
  } finally { x.close(); }
});

test("один участник экспортируется со всеми столбцами, кириллицей и двумя ID", async () => {
  const x = setup();
  try {
    const p = x.add(1, { first_name: "Анастасия", last_name: "Тестова", phone: "+79991234567", city: "Екатеринбург", email: "test@example.invalid", preferred_contact: "Telegram", referral_source: "Друзья", phone_confirmed_at: "2026-10-20T10:00:00.000Z", consent_at: "2026-10-20T09:00:00.000Z" });
    x.db.linkAccount(p.id, "telegram", "70001");
    x.db.linkAccount(p.id, "max", "MAX-70001");
    const rows = x.db.getParticipantsForExport();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].telegram_id, "70001");
    assert.equal(rows[0].max_id, "MAX-70001");
    const buffer = await exportModule.createParticipantsWorkbook(rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Участники");
    assert.equal(sheet.columnCount, 13);
    assert.equal(sheet.getRow(1).getCell(2).value, "Имя");
    assert.equal(sheet.getRow(2).getCell(2).value, "Анастасия");
    assert.equal(sheet.getRow(2).getCell(3).value, "Тестова");
    assert.equal(sheet.getRow(2).getCell(4).value, "+79991234567");
    assert.equal(sheet.getRow(2).getCell(10).value, "70001");
    assert.equal(sheet.getRow(2).getCell(11).value, "MAX-70001");
    assert.equal(sheet.getRow(2).getCell(12).value, "Подтверждён");
    assert.ok(sheet.getRow(2).getCell(9).value instanceof Date);
    assert.equal(sheet.getRow(2).getCell(9).value.getFullYear(), 2026);
    assert.ok(sheet.views[0].ySplit === 1);
    assert.ok(sheet.autoFilter);
  } finally { x.close(); }
});

test("необязательные пустые данные маркируются, а текст формулой не становится", async () => {
  const x = setup();
  try {
    const p = x.add(2, { first_name: "=1+1", last_name: null, phone: "+79991234568" });
    const buffer = await exportModule.createParticipantsWorkbook(x.db.getParticipantsForExport());
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Участники");
    assert.equal(sheet.getRow(2).getCell(2).value, "=1+1");
    assert.equal(sheet.getRow(2).getCell(2).type, ExcelJS.ValueType.String);
    assert.equal(sheet.getRow(2).getCell(2).formula, undefined);
    for (const col of [3, 5, 6, 7, 8, 10, 11, 13]) assert.equal(sheet.getRow(2).getCell(col).value, "Не указано");
    assert.equal(sheet.getRow(2).getCell(12).value, "Не подтверждён");
    assert.equal(p.first_name, "=1+1");
  } finally { x.close(); }
});

test("экспорт 500 участников содержит все строки", async () => {
  const x = setup();
  try {
    const insertMany = x.db.db.transaction(() => {
      for (let i = 1; i <= 500; i++) x.add(i, { last_name: `Фамилия${i}` });
    });
    insertMany();
    const buffer = await exportModule.createParticipantsWorkbook(x.db.getParticipantsForExport());
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
    assert.equal(workbook.getWorksheet("Участники").rowCount, 501);
  } finally { x.close(); }
});

test("выгрузка требует подтверждения, отправляется документом в личный чат и не повторяется", async () => {
  const x = setup();
  try {
    x.add(1, { last_name: "Вымышленный" });
    const prompt = await x.send("📥 Скачать Excel");
    assert.match(prompt.payload.text, /Excel-файл войдёт 1 участник/);
    assert.ok(prompt.payload.reply_markup.keyboard.flat().some((button) => button.text === "✅ Подтвердить выгрузку"));
    const docStart = x.sent.length;
    await x.send("✅ Подтвердить выгрузку");
    const documents = x.sent.slice(docStart).filter((item) => item.method === "sendDocument");
    assert.equal(documents.length, 1);
    assert.ok(documents[0].payload.document instanceof InputFile);
    assert.match(documents[0].payload.document.filename, /^Магия_утра_участники_\d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.match(x.sent.at(-1).payload.text, /Excel-файл отправлен/);
    const afterSuccess = x.sent.length;
    assert.match((await x.send("✅ Подтвердить выгрузку")).payload.text, /Подтверждение не найдено/);
    assert.equal(x.sent.slice(afterSuccess).filter((item) => item.method === "sendDocument").length, 0);
  } finally { x.close(); }
});

test("одновременные подтверждения Excel не запускают две тяжёлые выгрузки", async () => {
  const original = exportModule.createParticipantsWorkbook;
  let callCount = 0;
  let release;
  exportModule.createParticipantsWorkbook = (rows) => {
    callCount += 1;
    return new Promise((resolve, reject) => {
      release = async () => {
        try { resolve(await original(rows)); } catch (error) { reject(error); }
      };
    });
  };
  const x = setup();
  try {
    x.add(1);
    x.db.addAdmin("70002");
    await x.send("📥 Скачать Excel", 70001);
    await x.send("📥 Скачать Excel", 70002);
    const sendFirst = x.send("✅ Подтвердить выгрузку", 70001);
    for (let attempt = 0; attempt < 20 && !release; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, "function");
    const second = await x.send("✅ Подтвердить выгрузку", 70002);
    assert.match(second.payload.text, /Другая выгрузка уже выполняется/);
    assert.equal(callCount, 1);
    await release();
    await sendFirst;
    assert.equal(x.sent.filter((item) => item.method === "sendDocument").length, 1);
  } finally {
    exportModule.createParticipantsWorkbook = original;
    x.close();
  }
});

test("отмена не отправляет файл; обычный пользователь и группа не могут подтвердить экспорт", async () => {
  const x = setup();
  try {
    x.add(1);
    await x.send("📥 Скачать Excel");
    assert.match((await x.send("Отмена")).payload.text, /Выгрузка отменена/);
    assert.match((await x.send("✅ Подтвердить выгрузку", 70003)).payload.text, /нет доступа/);
    assert.match((await x.send("📥 Скачать Excel", 70003)).payload.text, /нет доступа/);
    assert.match((await x.send("✅ Подтвердить выгрузку", 70003)).payload.text, /нет доступа/);
    assert.match((await x.send("📥 Скачать Excel", 70001, "group")).payload.text, /только в личном чате/);
    assert.match((await x.send("✅ Подтвердить выгрузку", 70001, "group")).payload.text, /только в личном чате/);
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
  } finally { x.close(); }
});

test("подтверждение повторно проверяет роль и актуальное количество записей", async () => {
  const x = setup();
  try {
    x.add(1);
    await x.send("📥 Скачать Excel");
    x.db.addAdmin("70002");
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("70001");
    assert.match((await x.send("✅ Подтвердить выгрузку")).payload.text, /нет доступа/);
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
  } finally { x.close(); }

  const y = setup();
  try {
    y.add(1);
    await y.send("📥 Скачать Excel");
    y.add(2);
    assert.match((await y.send("✅ Подтвердить выгрузку")).payload.text, /Количество участников изменилось/);
    assert.equal(y.sent.some((item) => item.method === "sendDocument"), false);
  } finally { y.close(); }
});

test("отзыв согласия после начала формирования Excel не приводит к отправке устаревшей анкеты", async () => {
  const original = exportModule.createParticipantsWorkbook;
  let release;
  exportModule.createParticipantsWorkbook = (rows) => new Promise((resolve, reject) => {
    release = async () => { try { resolve(await original(rows)); } catch (error) { reject(error); } };
  });
  const x = setup();
  try {
    const participant = x.add(31, { last_name: "Тестовая", personal_data_consent: true, consent_at: "2026-10-20T00:00:00.000Z", consent_version: "synthetic-v1" });
    await x.send("📥 Скачать Excel");
    const confirming = x.send("✅ Подтвердить выгрузку");
    for (let attempt = 0; attempt < 30 && !release; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, "function");
    const withdrawnAt = new Date().toISOString();
    x.db.db.prepare("UPDATE participants SET personal_data_consent=0, consent_withdrawn_at=?, updated_at=? WHERE id=?").run(withdrawnAt, withdrawnAt, participant.id);
    await release();
    await confirming;
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
    assert.match(x.sent.at(-1).payload.text, /изменились во время формирования/);
  } finally {
    exportModule.createParticipantsWorkbook = original;
    x.close();
  }
});

test("права администратора перепроверяются после асинхронного формирования Excel", async () => {
  const original = exportModule.createParticipantsWorkbook;
  let release;
  exportModule.createParticipantsWorkbook = (rows) => new Promise((resolve, reject) => {
    release = async () => { try { resolve(await original(rows)); } catch (error) { reject(error); } };
  });
  const x = setup();
  try {
    x.add(32);
    await x.send("📥 Скачать Excel");
    const confirming = x.send("✅ Подтвердить выгрузку");
    for (let attempt = 0; attempt < 30 && !release; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, "function");
    x.db.db.prepare("DELETE FROM admins WHERE telegram_id=?").run("70001");
    await release();
    await confirming;
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
    assert.match(x.sent.at(-1).payload.text, /доступ к выгрузке отозван/i);
  } finally {
    exportModule.createParticipantsWorkbook = original;
    x.close();
  }
});

test("имя файла использует заданную календарную дату", () => {
  assert.equal(exportModule.getExportFilename(new Date(2026, 9, 23)), "Магия_утра_участники_2026-10-23.xlsx");
});

