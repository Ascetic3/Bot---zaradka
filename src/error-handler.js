const allowedApiMethods = new Set([
  "sendMessage", "sendDocument", "answerCallbackQuery", "getMe", "getUpdates"
]);
const knownErrorTypes = new Set(["Error", "TypeError", "RangeError", "GrammyError", "HttpError"]);

function safeErrorType(error) {
  const type = error?.name;
  return knownErrorTypes.has(type) ? type : "Error";
}

function safeErrorDetails(error, updateId) {
  const details = {
    event: "telegram_update_failed",
    update_id: Number.isSafeInteger(updateId) ? updateId : null,
    error_type: safeErrorType(error)
  };
  if (Number.isInteger(error?.error_code)) details.telegram_error_code = error.error_code;
  if (allowedApiMethods.has(error?.method)) details.telegram_method = error.method;
  return details;
}

function handleBotError(botError) {
  const details = safeErrorDetails(botError?.error, botError?.ctx?.update?.update_id);
  // Не добавляйте сюда error.message, error, ctx.update или Telegram API payload.
  console.error(JSON.stringify(details));
}

function handleStartupError(error) {
  const details = safeErrorDetails(error, null);
  details.event = "telegram_start_failed";
  console.error(JSON.stringify(details));
}

module.exports = { handleBotError, handleStartupError, safeErrorDetails };

