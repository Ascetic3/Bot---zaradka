const path = require("node:path");
const dotenv = require("dotenv");
const { seedDemoDatabase, defaultDemoPath, defaultProductionPath } = require("./seed");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const configuredDatabasePath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : defaultProductionPath;

try {
  const result = seedDemoDatabase({
    databasePath: defaultDemoPath,
    configuredDatabasePath,
    productionDatabasePath: defaultProductionPath,
    ownerTelegramId: process.env.OWNER_TELEGRAM_ID
  });
  if (result.alreadySeeded) console.log(`Демонстрационная база уже содержит ${result.count} участников; данные не изменялись.`);
  else console.log(`Создана демонстрационная база: ${result.count} вымышленных участников.`);
  console.log("Телефоны, почта и связанные аккаунты являются синтетическими и не предназначены для связи.");
} catch (error) {
  console.error(`Не удалось подготовить демонстрационную базу: ${error.message}`);
  process.exitCode = 1;
}
