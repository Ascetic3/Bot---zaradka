require("dotenv").config();
const path = require("node:path");
const https = require("node:https");
const { assertDatabaseMode } = require("./database/config");
try {
  assertDatabaseMode(undefined, { projectRoot: path.resolve(__dirname, "..") });
} catch (error) {
  console.error(`Запуск остановлен: ${error.message}`);
  process.exit(1);
}
// The read-only preflight above validated an existing v11 database. Make the
// subsequent SQLite open fail closed if the file disappears in between.
process.env.MAGIC_MORNING_REQUIRE_EXISTING_DB = "true";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не задан BOT_TOKEN. Добавьте токен в файл .env.");
  process.exit(1);
}

const { Bot } = require("grammy");
const { registerBotHandlers } = require("./bot-handlers");
const { handleBotError, handleStartupError } = require("./error-handler");
const { createBackupManager, startAutomaticBackups } = require("./database/backup");
const database = require("./database");
const { readBackupSettings } = require("./database/config");
const { createRateLimiter } = require("./request-limits");
const { createMeetingBroadcastRuntime } = require("./meeting-broadcast-runtime");
const { demoIds } = require("./meeting-broadcasts");
const { createUpdateTracker, createGracefulShutdown, installSignalHandlers } = require("./lifecycle");

// grammY uses node-fetch with its own https.Agent, so Node's global
// NODE_USE_ENV_PROXY setting alone does not route Telegram requests through a proxy.
const proxyConfigured = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
const bot = new Bot(token, proxyConfigured ? {
  client: { baseFetchConfig: { agent: new https.Agent({ keepAlive: true, proxyEnv: process.env }) } }
} : undefined);
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
let stopMeetingScheduler = async () => {};
const meetingScheduler = createMeetingBroadcastRuntime({
  database,
  telegramApi: bot.api,
  demoMode: String(process.env.DEMO_MODE).toLowerCase() === "true",
  demoAdminIds: demoIds(process.env.DEMO_BROADCAST_TELEGRAM_IDS)
});
let removeSignalHandlers = () => {};
const shutdown = createGracefulShutdown({
  bot,
  database,
  tracker,
  stopBackground: async () => { await Promise.all([stopBackups(), stopMeetingScheduler()]); },
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
    if (!shutdown.stopping) stopMeetingScheduler = meetingScheduler.start();
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
