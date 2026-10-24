const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { migrateDatabase, previewMigrations, inspectSchema } = require("./migrations");

function parseArgs(argv) {
  const result = { mode: null, databasePath: null, confirmation: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--check") result.mode = "check";
    else if (argv[i] === "--apply") result.mode = "apply";
    else if (argv[i] === "--db") result.databasePath = argv[++i];
    else if (argv[i] === "--confirm") result.confirmation = argv[++i];
    else throw new Error("Неизвестный параметр. Используйте --check или --apply, --db и при применении --confirm.");
  }
  if (!result.mode || !result.databasePath) throw new Error("Укажите режим и существующую базу: --check|--apply --db <путь>.");
  result.databasePath = path.resolve(result.databasePath);
  if (result.mode === "apply" && result.confirmation !== result.databasePath) throw new Error("Для изменений повторите полный разрешённый путь после параметра --confirm.");
  return result;
}

function runMigrationCommand(args, DatabaseConstructor = Database) {
  const options = typeof args === "string" ? parseArgs(args.split(/\s+/).filter(Boolean)) : args;
  if (!fs.existsSync(options.databasePath) || !fs.statSync(options.databasePath).isFile()) throw new Error("Файл базы не найден; команда не создаёт новую базу.");
  const db = new DatabaseConstructor(options.databasePath, { readonly: options.mode === "check", fileMustExist: true, timeout: 5000 });
  try {
    if (options.mode === "check") return { mode: "check", path: options.databasePath, preview: previewMigrations(db) };
    if (options.mode !== "apply" || options.confirmation !== options.databasePath) throw new Error("Подтверждение применения миграции отсутствует.");
    return { mode: "apply", path: options.databasePath, result: migrateDatabase(db), schema: inspectSchema(db, { allowKnownOptionalColumns: false }) };
  } finally { db.close(); }
}

function main() {
  try {
    const result = runMigrationCommand(parseArgs(process.argv.slice(2)));
    if (result.mode === "check") {
      const { preview } = result;
      const state = preview.empty ? "пустая новая база" : preview.legacyUnversioned ? "старая база без номера версии" : "версионированная база";
      console.log(`База: ${result.path}\nСостояние: ${state}\nPRAGMA user_version: ${preview.currentVersion}\nВерсия по фактической схеме: ${preview.structuralVersion}\nЦелевая версия: ${preview.targetVersion}`);
      if (preview.alreadyCurrent) console.log("Миграция не требуется.");
      else if (preview.plan.length) console.log(`Точный план:\n${preview.plan.map((item) => item.action === "set-user-version-only" ? `${item.version}. ${item.label} (таблицы и строки не изменяются)` : `${item.version}. ${item.label}`).join("\n")}`);
      else console.log("Схема уже содержит все необходимые изменения.");
    } else console.log(`Миграции завершены: ${result.result.from} → ${result.result.to}. Выполнено шагов: ${result.result.applied.length}.`);
  } catch (error) {
    console.error(`Проверка миграций остановлена: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArgs, runMigrationCommand };
