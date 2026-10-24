const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");
const { ensureSafeTarget, verifyDemoDatabase, defaultDemoPath, defaultProductionPath } = require("./seed");

function configureDemoEnvironment(env = process.env, root = path.resolve(__dirname, "../..")) {
  const demoPath = path.resolve(root, "data", "demo.sqlite");
  const productionPath = path.resolve(root, "data", "club.sqlite");
  const configuredPath = env.DB_PATH ? path.resolve(env.DB_PATH) : productionPath;
  ensureSafeTarget(demoPath, configuredPath, productionPath);
  env.DB_PATH = demoPath;
  env.DEMO_MODE = "true";
  env.BACKUP_AUTO_ENABLED = "false";
  env.BACKUP_DIR = path.resolve(root, "data", "demo-backups");
  return { demoPath, productionPath, backupDirectory: env.BACKUP_DIR };
}

function main() {
  const root = path.resolve(__dirname, "../..");
  dotenv.config({ path: path.join(root, ".env") });
  if (!/^\d+$/.test(String(process.env.OWNER_TELEGRAM_ID || ""))) {
    console.error("Для демонстрационного запуска укажите OWNER_TELEGRAM_ID в .env.");
    process.exitCode = 1;
    return;
  }
  try {
    const paths = configureDemoEnvironment(process.env, root);
    verifyDemoDatabase({ databasePath: paths.demoPath, ownerTelegramId: process.env.OWNER_TELEGRAM_ID });
    console.log("🧪 Демонстрационный режим. Данные вымышленные.");
    console.log("Автоматические резервные копии отключены для демонстрационного запуска.");
    if (!fs.existsSync(paths.demoPath)) throw new Error("Сначала создайте базу командой npm.cmd run demo:seed.");
    require("../bot");
  } catch (error) {
    console.error(`Демонстрационный запуск остановлен: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { configureDemoEnvironment, main };
