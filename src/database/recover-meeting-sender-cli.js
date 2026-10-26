const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { inspectSchema, CURRENT_SCHEMA_VERSION } = require('./migrations');
const { createMeetingBroadcastStore } = require('../meeting-broadcast-store');

function parseArgs(argv) {
  const args = { mode: null, databasePath: null, confirmation: null, ownerPid: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.mode = 'check';
    else if (argv[i] === '--apply') args.mode = 'apply';
    else if (argv[i] === '--db') args.databasePath = argv[++i];
    else if (argv[i] === '--confirm') args.confirmation = argv[++i];
    else if (argv[i] === '--owner-pid') args.ownerPid = Number(argv[++i]);
    else throw new Error('Неизвестный параметр восстановления отправителя.');
  }
  if (!args.mode || !args.databasePath) throw new Error('Укажите --check|--apply и --db <путь>.');
  args.databasePath = path.resolve(args.databasePath);
  if (args.mode === 'apply' && (args.confirmation !== args.databasePath || !Number.isSafeInteger(args.ownerPid) || args.ownerPid <= 0)) {
    throw new Error('Для восстановления повторите абсолютный путь в --confirm и PID владельца в --owner-pid.');
  }
  return args;
}

function runRecoveryCommand(args) {
  if (!['check', 'apply'].includes(args.mode) || !path.isAbsolute(args.databasePath)) throw new Error('Укажите режим и абсолютный путь к базе.');
  if (args.mode === 'apply' && (args.confirmation !== args.databasePath || !Number.isSafeInteger(args.ownerPid) || args.ownerPid <= 0)) {
    throw new Error('Для восстановления повторите абсолютный путь и PID владельца.');
  }
  if (!fs.existsSync(args.databasePath) || !fs.statSync(args.databasePath).isFile()) throw new Error('Файл базы не найден.');
  const connection = new Database(args.databasePath, { readonly: args.mode === 'check', fileMustExist: true, timeout: 5000 });
  try {
    if (inspectSchema(connection).version !== CURRENT_SCHEMA_VERSION) throw new Error('Сначала требуется схема SQLite v11.');
    const store = createMeetingBroadcastStore(connection);
    const owner = store.getSenderState();
    if (!owner?.sender_token) return { active: false };
    const details = { active: true, pid: owner.sender_pid, host: owner.sender_host,
      acquiredAt: owner.sender_acquired_at, deliveryId: owner.sender_delivery_id };
    if (args.mode === 'check') return details;
    if (args.ownerPid !== owner.sender_pid) throw new Error('PID владельца изменился; повторите проверку.');
    return { ...details, ...store.recoverAbandonedSender(owner.sender_token, new Date().toISOString()) };
  } finally { connection.close(); }
}

function main() {
  try {
    const result = runRecoveryCommand(parseArgs(process.argv.slice(2)));
    if (!result.active) console.log('Исключительное право отправки свободно.');
    else if (result.recovered) console.log('Право освобождено; неопределённая доставка направлена на ручную проверку.');
    else console.log(`Владелец отправки: PID ${result.pid}, компьютер ${result.host}, получено ${result.acquiredAt}, доставка #${result.deliveryId}.`);
  } catch (error) {
    console.error(`Восстановление отправителя остановлено: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArgs, runRecoveryCommand };

