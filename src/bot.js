require("dotenv").config();
const { Bot } = require("grammy");
const { registerRegistration } = require("./registration");
const { registerRegistrationPreview } = require("./registration-preview");
const { registerProfile } = require("./profile");
const { registerAdmin, registerAdminUsernameRefresh } = require("./admin");
const { registerMyId } = require("./myid");
const { registerPrivateCallbackGuard } = require("./chat-guards");
const { registerStart } = require("./main-menu");
const { handleBotError, handleStartupError } = require("./error-handler");
const { createBackupManager, startAutomaticBackups } = require("./database/backup");
const database = require("./database");
const { readBackupSettings } = require("./database/config");

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не задан BOT_TOKEN. Добавьте токен в файл .env.");
  process.exit(1);
}

const bot = new Bot(token);
bot.catch(handleBotError);
registerAdminUsernameRefresh(bot);
registerPrivateCallbackGuard(bot);
registerStart(bot);
const backupSettings = readBackupSettings();
const backupManager = createBackupManager({
  sourceDb: database.db,
  sourcePath: database.dbPath,
  backupDir: backupSettings.backupDir,
  retentionCount: backupSettings.retentionCount
});

registerMyId(bot);

// Register admin handlers before registration flows so active drafts cannot
// consume administrator buttons or search queries as questionnaire answers.
registerAdmin(bot);

registerRegistrationPreview(bot);

registerRegistration(bot);

registerProfile(bot);

bot.start({
  onStart: (botInfo) => {
    console.log(`Бот @${botInfo.username} успешно запущен!`);
    if (backupSettings.autoEnabled) {
      startAutomaticBackups(backupManager, { intervalMs: backupSettings.intervalHours * 60 * 60 * 1000 });
      console.log(`Автоматическое резервирование включено: раз в ${backupSettings.intervalHours} ч.`);
    } else {
      console.log("Автоматическое резервирование отключено настройкой BACKUP_AUTO_ENABLED.");
    }
  }
}).catch((error) => {
  handleStartupError(error);
});

