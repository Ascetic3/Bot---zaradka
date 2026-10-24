require("dotenv").config();
const { Bot } = require("grammy");
const { registerBotHandlers } = require("./bot-handlers");
const { handleBotError, handleStartupError } = require("./error-handler");
const { createBackupManager, startAutomaticBackups } = require("./database/backup");
const database = require("./database");
const { readBackupSettings } = require("./database/config");
const { createRateLimiter } = require("./request-limits");
const { createUpdateTracker, createGracefulShutdown, installSignalHandlers } = require("./lifecycle");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не задан BOT_TOKEN. Добавьте токен в файл .env.");
  process.exit(1);
}

const bot = new Bot(token);
bot.catch(handleBotError);
const tracker = createUpdateTracker();
bot.use((ctx, next) => tracker.middleware(ctx, next));
const rateLimiter = createRateLimiter();
const moduleCleanups = registerBotHandlers(bot, { rateLimiter });
const backupSettings = readBackupSettings();
const backupManager = createBackupManager({
  sourceDb: database.db,
  sourcePath: database.dbPath,
  backupDir: backupSettings.backupDir,
  retentionCount: backupSettings.retentionCount
});

let pollingPromise = null;
let stopBackups = () => Promise.resolve();
let removeSignalHandlers = () => {};
const shutdown = createGracefulShutdown({
  bot,
  database,
  tracker,
  stopBackground: async () => { await stopBackups(); },
  cleanup: async () => {
    rateLimiter.stop();
    for (const cleanup of moduleCleanups) if (typeof cleanup === "function") cleanup();
    removeSignalHandlers();
  },
  getPollingPromise: () => pollingPromise
});
removeSignalHandlers = installSignalHandlers(shutdown);

pollingPromise = bot.start({
  onStart: (botInfo) => {
    console.log(`Бот @${botInfo.username} успешно запущен!`);
    if (backupSettings.autoEnabled) {
      if (shutdown.stopping) return;
      stopBackups = startAutomaticBackups(backupManager, { intervalMs: backupSettings.intervalHours * 60 * 60 * 1000 });
      console.log(`Автоматическое резервирование включено: раз в ${backupSettings.intervalHours} ч.`);
    } else {
      console.log("Автоматическое резервирование отключено настройкой BACKUP_AUTO_ENABLED.");
    }
  }
});
pollingPromise.catch((error) => {
  handleStartupError(error);
  void shutdown.shutdown("startup_error");
});
