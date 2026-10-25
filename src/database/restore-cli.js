const path = require("node:path");
const { restoreBackup } = require("./backup");

function parseArgs(argv) {
  const args = { backupPath: null, destinationPath: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--backup") args.backupPath = argv[++i];
    else if (argv[i] === "--destination") args.destinationPath = argv[++i];
    else throw new Error("Неизвестный параметр. Используйте --backup и --destination.");
  }
  if (!args.backupPath || !args.destinationPath) throw new Error("Укажите проверенную копию и новый путь восстановления.");
  return { backupPath: path.resolve(args.backupPath), destinationPath: path.resolve(args.destinationPath) };
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = restoreBackup(options.backupPath, options.destinationPath);
    console.log(`Копия проверена и восстановлена в отдельный файл: ${result.path}`);
    console.log("Рабочая база не заменялась. Перед использованием проверьте восстановленный файл.");
  } catch (error) {
    console.error(`Восстановление остановлено: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArgs };

