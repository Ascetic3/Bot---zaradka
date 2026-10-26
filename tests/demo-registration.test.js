const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Bot } = require("grammy");
const Database = require("better-sqlite3");

const ownerId = 71011001;
const adminId = 71011002;
const userId = 71011003;
const modules = ["../src/database", "../src/participant-service", "../src/registration", "../src/registration-preview", "../src/demo-registration", "../src/admin", "../src/profile", "../src/bot-handlers", "../src/participant-data", "../src/participant-data-menu", "../src/account-links"];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "magic-demo-registration-"));
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir);
  const demoPath = path.join(dataDir, "demo.sqlite");
  const productionPath = path.join(dataDir, "club.sqlite");
  fs.writeFileSync(productionPath, "unchanged synthetic production sentinel");
  const productionHash = crypto.createHash("sha256").update(fs.readFileSync(productionPath)).digest("hex");
  const envKeys = ["DB_PATH", "DEMO_MODE", "OWNER_TELEGRAM_ID", "PRIVACY_POLICY_URL", "PRIVACY_POLICY_VERSION", "PRIVACY_POLICY_PUBLISHED", "PREVIEW_POLICY_URL", "PHONE_PROOF_SECRET", "CONSENT_ATTESTATION_SECRET"];
  const env = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.DB_PATH = demoPath; process.env.DEMO_MODE = "true"; process.env.OWNER_TELEGRAM_ID = String(ownerId);
  process.env.PREVIEW_POLICY_URL = "https://preview.example.invalid/demo-policy.html";
  for (const name of modules) delete require.cache[require.resolve(name)];
  const { seedDemoDatabase } = require("../src/demo/seed");
  seedDemoDatabase({ databasePath: demoPath, configuredDatabasePath: productionPath, productionDatabasePath: productionPath, ownerTelegramId: ownerId });
  for (const name of modules) delete require.cache[require.resolve(name)];
  const db = require("../src/database");
  db.addAdmin(String(adminId));
  const bot = new Bot("123456:DEMO_TEST_TOKEN", { botInfo: { id: 123456, is_bot: true, first_name: "Test", username: "test_bot" } });
  const sent = [];
  bot.api.config.use(async (_previous, method, payload) => {
    if (method === "sendMessage") {
      sent.push(payload);
      return { ok: true, result: { message_id: sent.length, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text, reply_markup: payload.reply_markup } };
    }
    if (method === "editMessageText") {
      sent.push({ chat_id: payload.chat_id, text: payload.text, reply_markup: payload.reply_markup });
      return { ok: true, result: { message_id: payload.message_id, date: 1, chat: { id: payload.chat_id, type: "private" }, text: payload.text } };
    }
    if (["answerCallbackQuery", "editMessageReplyMarkup"].includes(method)) return { ok: true, result: true };
    if (method === "sendDocument") return { ok: true, result: { message_id: sent.length + 1, date: 1, chat: { id: payload.chat_id, type: "private" } } };
    throw new Error(`Unexpected method ${method}`);
  });
  const demoRegistrationService = require("../src/demo-registration").createDemoRegistrationService({ db, projectRoot: root });
  const participantDataService = require("../src/participant-data").createParticipantDataService({ db, projectRoot: root });
  const cleanups = require("../src/bot-handlers").registerBotHandlers(bot, { demoRegistrationService, participantDataService, demoProjectRoot: root });
  let updateId = 0;
  async function send(text, id = ownerId, type = "private") {
    const update = { update_id: ++updateId, message: { message_id: updateId, date: 1, chat: { id: type === "private" ? id : -711, type }, from: { id, is_bot: false, first_name: "Synthetic" }, text } };
    if (text.startsWith("/")) update.message.entities = [{ type: "bot_command", offset: 0, length: text.length }];
    await bot.handleUpdate(update); return sent.at(-1);
  }
  async function click(data, id = ownerId) {
    await bot.handleUpdate({ update_id: ++updateId, callback_query: { id: `cb-${updateId}`, from: { id, is_bot: false, first_name: "Synthetic" }, chat_instance: "test", data, message: { message_id: 800 + updateId, date: 1, chat: { id, type: "private" }, from: { id: 123456, is_bot: true, first_name: "Test" }, text: "Test" } } });
    return sent.at(-1);
  }
  async function start(id = ownerId) {
    const msg = await send("/demo_registration", id);
    if (!msg?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data) throw new Error(`Команда не показала экран тестового согласия: ${msg?.text || "нет ответа"}`);
    const data = msg.reply_markup.inline_keyboard[0][0].callback_data;
    return click(data, id);
  }
  return { root, demoPath, productionPath, productionHash, db, bot, sent, send, click, start, close() {
    for (const cleanup of cleanups) cleanup?.();
    if (db.db.open) db.closeDatabase();
    for (const name of modules) delete require.cache[require.resolve(name)];
    for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

async function fillToConfirm(x, id = ownerId, phone = "+70000001234") {
  await x.start(id);
  await x.send("Мария", id);
  await x.send("Синтетическая", id);
  await x.send(phone, id);
  await x.send("Пропустить", id);
  await x.send("test@example.invalid", id);
  await x.send("Электронная почта", id);
  await x.send("Другое", id);
  return x.send("Тестовая встреча", id);
}

test("/demo_registration сохраняет только помеченную тестовую анкету, а preview остаётся без сохранения", async () => {
  const x = setup(); try {
    const beforeSeed = x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n;
    await x.send("/preview_registration");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, beforeSeed);
    const summary = await fillToConfirm(x);
    assert.match(summary.text, /Тестовая анкета деморежима/);
    const saved = await x.send("✅ Подтвердить тестовую регистрацию");
    assert.match(saved.text, /только в demo\.sqlite/);
    const row = x.db.findParticipantByTelegramId(ownerId);
    assert.ok(row);
    assert.equal(row.phone, "+70000001234");
    assert.equal(row.consent_version, "DEMO_TEST_ONLY_V1");
    assert.equal(x.db.isDemoTestParticipant(row.id), true);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, beforeSeed + 1);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM registration_drafts").get().n, 0);
    assert.equal(x.db.getParticipantCount(), 151);
    assert.equal(x.db.getParticipantStatistics().total, 151);
    assert.equal(x.db.getParticipantsForExport().filter((p) => p.demo_test).length, 1);
    const check = require("../src/demo/seed").verifyDemoDatabase({ databasePath: x.demoPath, productionDatabasePath: x.productionPath, ownerTelegramId: ownerId });
    assert.deepEqual(check, { count: 151, ownerConfigured: true });
    const testRowId = x.db.findParticipantByTelegramId(ownerId).id;
    x.db.db.prepare("UPDATE participants SET consent_version='forged' WHERE id=?").run(testRowId);
    assert.throws(() => require("../src/demo/seed").verifyDemoDatabase({ databasePath: x.demoPath, productionDatabasePath: x.productionPath, ownerTelegramId: ownerId }), /некорректная или неподтверждённая метка/i);
    x.db.db.prepare("UPDATE participants SET consent_version=? WHERE id=?").run("DEMO_TEST_ONLY_V1", testRowId);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(x.productionPath)).digest("hex"), x.productionHash);
  } finally { x.close(); }
});

test("обычные пользователи, группы и production-процесс не могут начать тестовую регистрацию", async () => {
  const x = setup(); try {
    assert.match((await x.send("/demo_registration", userId)).text, /только владельцу и действующим администраторам/i);
    assert.match((await x.send("/demo_registration", adminId, "group")).text, /личном чате/i);
    const service = require("../src/demo-registration").createDemoRegistrationService({ db: x.db, envProvider: () => ({ DEMO_MODE: "false" }), projectRoot: x.root });
    assert.throws(() => service.assertAccess(ownerId), (error) => error.code === "DEMO_MODE_REQUIRED");
    const prodDir = path.join(x.root, "production"); fs.mkdirSync(path.join(prodDir, "data"), { recursive: true });
    const prodPath = path.join(prodDir, "data", "club.sqlite");
    const prod = new Database(prodPath); prod.close();
    const wrongDb = { ...x.db, dbPath: prodPath };
    const wrongService = require("../src/demo-registration").createDemoRegistrationService({ db: wrongDb, envProvider: () => ({ DEMO_MODE: "true" }), projectRoot: prodDir });
    assert.throws(() => wrongService.assertAccess(ownerId), (error) => error.code === "DEMO_DATABASE_MISMATCH");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 150);
    const badPhone = await x.start();
    assert.match(badPhone.text, /Как вас зовут/);
    await x.send("ВымышленноеИмя"); await x.send("ВымышленнаяФамилия");
    assert.match((await x.send("+79001234567")).text, /вымышленный тестовый номер/i);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    await x.send("❌ Отменить тестовую регистрацию");
  } finally { x.close(); }
});

test("валидация, уникальный тестовый телефон, сохранение после открытия базы и профиль", async () => {
  const x = setup(); try {
    await x.start();
    await x.send("", ownerId); // пустое имя должно оставить тот же шаг
    assert.match(x.sent.at(-1).text, /обязательно/i);
    const summary = await fillToConfirm(x, ownerId, "+7 (000) 000-12-34");
    assert.match(summary.text, /\+70000001234/);
    await x.send("✅ Подтвердить тестовую регистрацию");
    const duplicate = await fillToConfirm(x, adminId, "+70000001234");
    assert.match(duplicate.text, /Тестовая анкета/);
    assert.match((await x.send("✅ Подтвердить тестовую регистрацию", adminId)).text, /уже используется/i);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants WHERE phone=?").get("+70000001234").n, 1);
    const participant = x.db.findParticipantByTelegramId(ownerId);
    assert.ok(participant);
    assert.match((await x.send("Моя анкета")).text, /Мария/);
    assert.equal(x.db.isDemoTestParticipant(participant.id), true);
    assert.throws(() => x.db.deleteDemoTestParticipantById(1, ownerId, { projectRoot: x.root }), (error) => error.code === "DEMO_TEST_PARTICIPANT_REQUIRED");
    await x.send("✏️ Изменить данные");
    await x.send("Имя");
    await x.send("НоваяМария");
    assert.match(x.sent.at(-1).text, /Данные успешно изменены/);
    assert.equal(x.db.findParticipantByTelegramId(ownerId).first_name, "НоваяМария");
    const reopened = new Database(x.demoPath, { readonly: true, fileMustExist: true });
    try { assert.equal(reopened.prepare("SELECT first_name FROM participants WHERE id=?").get(participant.id).first_name, "НоваяМария"); }
    finally { reopened.close(); }
    assert.match((await x.send("/demo_registration")).text, /уже связан|уже зарегистрирован/i);
    const workbook = await require("../src/excel-export").createParticipantsWorkbook(x.db.getParticipantsForExport());
    const ExcelJS = require("exceljs"); const checkWorkbook = new ExcelJS.Workbook();
    await checkWorkbook.xlsx.load(workbook);
    assert.ok(checkWorkbook.getWorksheet("Участники").getRow(1).values.includes("Метка деморежима"));
    assert.ok(checkWorkbook.getWorksheet("Участники").getSheetValues().some((row) => row?.includes("Тестовая анкета")));
    assert.equal(x.db.searchParticipants("НоваяМария").length, 1);
    assert.ok(x.db.listParticipants(100, 0).some((item) => item.id === participant.id));
  } finally { x.close(); }
});

test("отказ от регистрации не создаёт записей, а устаревшее согласие и отмена не дают сохранить анкету", async () => {
  const x = setup(); try {
    const consent = await x.send("/demo_registration");
    const decline = consent.reply_markup.inline_keyboard[1][0].callback_data;
    assert.match((await x.click(decline)).text, /отменена/i);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    const started = await x.send("/demo_registration");
    const accept = started.reply_markup.inline_keyboard[0][0].callback_data;
    await x.click(accept);
    const stale = await x.click(accept);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    await x.send("Мария");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    const cancelled = await x.send("❌ Отменить тестовую регистрацию");
    assert.match(cancelled.text, /не сохранены/i);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    assert.ok(stale);
  } finally { x.close(); }
});

test("preview и тестовая регистрация очищают сессию друг друга и старые кнопки остаются недействительными", async () => {
  const x = setup(); try {
    const demoConsent = await x.send("/demo_registration");
    const oldDemoButton = demoConsent.reply_markup.inline_keyboard[0][0].callback_data;
    const previewConsent = await x.send("/preview_registration");
    assert.match(previewConsent.text, /демонстрационный экран согласия/i);
    assert.equal(previewConsent.reply_markup.inline_keyboard.length, 2);
    await x.click(oldDemoButton);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    const previewAccept = previewConsent.reply_markup.inline_keyboard[0][0].callback_data;
    assert.match((await x.click(previewAccept)).text, /Как вас зовут/);
    assert.match((await x.send("Просмотр без записи")).text, /фамилию/);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
  } finally { x.close(); }
});

test("потеря роли администратора немедленно останавливает активную тестовую регистрацию", async () => {
  const x = setup(); try {
    await x.send("/demo_registration", adminId);
    x.db.removeAdmin(String(adminId));
    const response = await x.send("НесохранённоеИмя", adminId);
    assert.match(response.text, /доступ|администратор/i);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM demo_test_participants").get().n, 0);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 150);
  } finally { x.close(); }
});

test("тестовая анкета поддерживает личный запрос удаления и администратор удаляет её только после подтверждения", async () => {
  const x = setup(); try {
    await fillToConfirm(x);
    await x.send("✅ Подтвердить тестовую регистрацию");
    await x.send("🔐 Мои данные");
    const withdrawal = await x.send("🚫 Отозвать согласие");
    assert.ok(withdrawal.reply_markup.inline_keyboard[0][0].callback_data.startsWith("pdata:consent:confirm:"));
    await x.click(withdrawal.reply_markup.inline_keyboard[0][0].callback_data);
    assert.equal(x.db.findParticipantByTelegramId(ownerId), undefined);
    assert.equal(x.db.getParticipantCount(), 150);
    assert.equal(x.db.getParticipantsForExport().some((p) => p.demo_test), false);
    assert.ok(x.db.listParticipantDataRequests(20).some((request) => request.request_type === "consent_withdrawal" && request.status === "pending_review"));
    await x.send("🔐 Мои данные");
    const prompt = await x.send("🗑 Запросить удаление анкеты");
    assert.ok(prompt.reply_markup.inline_keyboard[0][0].callback_data.startsWith("pdata:delete:confirm:"));
    await x.click(prompt.reply_markup.inline_keyboard[0][0].callback_data);
    const id = x.db.findParticipantByTelegramIdIncludingWithdrawn(ownerId).id;
    x.db.recordTelegramPrivateChat(String(ownerId));
    const meetingId = Number(x.db.db.prepare(`INSERT INTO meetings(title,starts_at,zoom_url,created_by)
      VALUES('Тестовая встреча','2031-01-01T10:00:00.000Z','https://zoom.us/j/123',?)`).run(String(ownerId)).lastInsertRowid);
    const broadcastId = Number(x.db.db.prepare(`INSERT INTO meeting_broadcasts(meeting_id,status,scheduled_at,timezone,created_by)
      VALUES(?,'completed','2030-12-31T10:00:00.000Z','Etc/UTC',?)`).run(meetingId, String(ownerId)).lastInsertRowid);
    const deliveryId = Number(x.db.db.prepare(`INSERT INTO meeting_deliveries(broadcast_id,participant_id,platform,messenger_user_id,status,attempt_count,last_error_code)
      VALUES(?,?,'telegram',?,'uncertain',1,'DELIVERY_RESULT_REQUIRES_REVIEW')`).run(broadcastId, id, String(ownerId)).lastInsertRowid);
    assert.equal(x.db.listDemoTestDeletionRequests().length, 1);
    await x.send("/admin");
    await x.send("📋 Запросы участников");
    const actionMessage = x.sent.at(-1);
    const review = actionMessage.reply_markup.inline_keyboard[0][0].callback_data;
    const confirmation = await x.click(review);
    assert.match(confirmation.text, /подтвердите фактическое удаление/i);
    const confirmData = confirmation.reply_markup.inline_keyboard[0][0].callback_data;
    const result = await x.click(confirmData);
    assert.match(result.text, /удалены из demo\.sqlite/i);
    assert.equal(x.db.getParticipantIncludingWithdrawn(id), undefined);
    assert.equal(x.db.findParticipantByPhone("+70000001234"), undefined);
    assert.equal(x.db.hasTelegramPrivateChat(String(ownerId)), false);
    const anonymizedDelivery = x.db.db.prepare("SELECT participant_id,messenger_user_id,status,last_error_code FROM meeting_deliveries WHERE broadcast_id=?").get(broadcastId);
    assert.deepEqual(anonymizedDelivery, { participant_id: null, messenger_user_id: `deleted-delivery-${deliveryId}`, status: "uncertain", last_error_code: "DELIVERY_RESULT_REQUIRES_REVIEW" });
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS n FROM participants").get().n, 150);
    const dataService = require("../src/participant-data").createParticipantDataService({ db: x.db, projectRoot: x.root });
    assert.throws(() => dataService.prepareAdminDeletion(userId, 1), /административных прав/i);
    await fillToConfirm(x, ownerId, "+70000001234");
    assert.match((await x.send("✅ Подтвердить тестовую регистрацию")).text, /только в demo\.sqlite/);
  } finally { x.close(); }
});


test("демобаза запускается после перезапуска с допустимым черновиком редактирования тестовой анкеты", async () => {
  const x = setup();
  try {
    await fillToConfirm(x);
    await x.send("✅ Подтвердить тестовую регистрацию");
    await x.send("✏️ Изменить данные");
    await x.send("Город");
    const draft = x.db.getDraft("telegram", ownerId);
    assert.equal(draft.current_step, "profile_edit:city");
    assert.equal(draft.answers.edit_field, "city");
    assert.equal(draft.answers.participant_id, draft.answers.snapshot.id);
    assert.equal(draft.answers.snapshot.city, null);

    x.db.closeDatabase();
    for (const name of modules) delete require.cache[require.resolve(name)];
    const reopened = require("../src/database");
    const { verifyDemoDatabase } = require("../src/demo/seed");
    const verification = verifyDemoDatabase({ databasePath: x.demoPath, productionDatabasePath: x.productionPath, ownerTelegramId: ownerId });
    assert.equal(verification.count, 151);
    assert.equal(reopened.getDraft("telegram", ownerId).current_step, "profile_edit:city");
    assert.deepEqual(reopened.getDraft("telegram", ownerId).answers, draft.answers);
    assert.equal(reopened.isDemoTestParticipantForTelegram(ownerId), true);
    reopened.closeDatabase();
  } finally {
    try { x.close(); } catch {}
  }
});

test("проверка демобазы отклоняет произвольные, повреждённые и не принадлежащие тестовому аккаунту черновики", async () => {
  const x = setup();
  try {
    await fillToConfirm(x);
    await x.send("✅ Подтвердить тестовую регистрацию");
    const { verifyDemoDatabase } = require("../src/demo/seed");
    const verify = () => verifyDemoDatabase({ databasePath: x.demoPath, productionDatabasePath: x.productionPath, ownerTelegramId: ownerId });
    x.db.saveDraft("telegram", ownerId, "city", {});
    assert.throws(verify, /недопустимый.*черновик/i);
    x.db.deleteDraft("telegram", ownerId);

    x.db.saveDraft("telegram", ownerId, "profile_edit:city", { email: "unexpected@example.invalid" });
    assert.throws(verify, /некорректный.*снимок/i);
    x.db.deleteDraft("telegram", ownerId);

    x.db.saveDraft("telegram", 99999123, "profile_edit:city", {});
    assert.throws(verify, /не связан.*тестовой анкетой/i);
    x.db.deleteDraft("telegram", 99999123);

    x.db.db.prepare("INSERT INTO registration_drafts(platform,messenger_user_id,current_step,answers_json) VALUES('telegram',?,?,?)").run(String(ownerId), "profile_edit:city", "not-json");
    assert.throws(verify, /повреждённый черновик/i);
  } finally { x.close(); }
});

