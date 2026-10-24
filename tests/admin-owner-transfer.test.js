const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-owner-transfer-"));
  process.env.DB_PATH = path.join(dir, "temporary.sqlite");
  process.env.OWNER_TELEGRAM_ID = "10001";
  delete require.cache[require.resolve("../src/database")];
  const db = require("../src/database");
  db.initializeOwner(process.env.OWNER_TELEGRAM_ID);
  db.addAdmin("10002");
  return { db, dir, close() { db.closeDatabase(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env.DB_PATH; delete process.env.OWNER_TELEGRAM_ID; delete require.cache[require.resolve("../src/database")]; } };
}

test("передача роли проводится атомарно только действующим владельцем действующему администратору", () => {
  const x = setup(); try {
    assert.equal(x.db.transferOwner("10001", "10002", "admin", "TRANSFER_OWNER"), true);
    assert.equal(x.db.getAdminRole("10001"), "admin");
    assert.equal(x.db.getAdminRole("10002"), "owner");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count, 1);
  } finally { x.close(); }
});

test("передачу нельзя сделать неавторизованным вызовом или случайному пользователю", () => {
  const x = setup(); try {
    assert.equal(x.db.transferOwner("99999", "10002", "admin", "TRANSFER_OWNER"), false);
    assert.equal(x.db.transferOwner("10001", "99999", "admin", "TRANSFER_OWNER"), false);
    assert.throws(() => x.db.transferOwner("10001", "10002", "admin", ""), /явного подтверждения/);
    assert.equal(x.db.getAdminRole("10001"), "owner");
    assert.equal(x.db.getAdminRole("10002"), "admin");
  } finally { x.close(); }
});

test("после передачи повторная операция прежнего владельца не меняет роли", () => {
  const x = setup(); try {
    assert.equal(x.db.transferOwner("10001", "10002", "remove", "TRANSFER_OWNER"), true);
    assert.equal(x.db.getAdminRole("10001"), null);
    assert.equal(x.db.transferOwner("10001", "10002", "admin", "TRANSFER_OWNER"), false);
    assert.equal(x.db.getAdminRole("10002"), "owner");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count, 1);
  } finally { x.close(); }
});

test("инициализация не меняет владельца при изменении OWNER_TELEGRAM_ID и не повышает админа автоматически", () => {
  const x = setup(); try {
    process.env.OWNER_TELEGRAM_ID = "10002";
    assert.equal(x.db.initializeOwner(process.env.OWNER_TELEGRAM_ID), false);
    assert.equal(x.db.getAdminRole("10001"), "owner");
    assert.equal(x.db.getAdminRole("10002"), "admin");

    x.db.db.prepare("UPDATE admins SET role='admin' WHERE telegram_id='10001'").run();
    assert.equal(x.db.initializeOwner("10003"), false);
    assert.equal(x.db.getAdminRole("10003"), null);
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count, 0);
  } finally { x.close(); }
});

test("ошибка внутри передачи откатывает обе смены ролей", () => {
  const x = setup(); try {
    x.db.db.exec("CREATE TRIGGER reject_owner_promotion BEFORE UPDATE OF role ON admins WHEN NEW.telegram_id='10002' AND NEW.role='owner' BEGIN SELECT RAISE(ABORT, 'simulated transfer failure'); END;");
    assert.throws(() => x.db.transferOwner("10001", "10002", "remove", "TRANSFER_OWNER"), /simulated transfer failure/);
    assert.equal(x.db.getAdminRole("10001"), "owner");
    assert.equal(x.db.getAdminRole("10002"), "admin");
    assert.equal(x.db.db.prepare("SELECT COUNT(*) AS count FROM admins WHERE role='owner'").get().count, 1);
  } finally { x.close(); }
});
