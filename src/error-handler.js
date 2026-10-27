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
  const nested = error?.error;
  if (!details.telegram_method && typeof error?.message === "string") {
    const match = /^Network request for '([A-Za-z]+)' failed!/.exec(error.message);
    if (match && allowedApiMethods.has(match[1])) details.telegram_method = match[1];
  }
  const transportCode = nested?.code ?? nested?.cause?.code;
  if (typeof transportCode === "string" && /^[A-Z0-9_]{1,48}$/.test(transportCode)) {
    details.transport_error_code = transportCode;
  }
  const transportType = nested?.name ?? nested?.cause?.name;
  if (["FetchError", "TypeError", "AbortError", "TimeoutError", "Error"].includes(transportType)) {
    details.transport_error_type = transportType;
  }
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
