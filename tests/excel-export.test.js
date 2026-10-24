const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { InputFile, Bot } = require("grammy");
const exportModule = require("../src/excel-export");

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

    x.db.initializeOwner("70001");
    await x.send("📥 Скачать Excel");
    x.add(2);
    assert.match((await x.send("✅ Подтвердить выгрузку")).payload.text, /Количество участников изменилось/);
    assert.equal(x.sent.some((item) => item.method === "sendDocument"), false);
  } finally { x.close(); }
});

test("имя файла использует заданную календарную дату", () => {
  assert.equal(exportModule.getExportFilename(new Date(2026, 9, 23)), "Магия_утра_участники_2026-10-23.xlsx");
});

