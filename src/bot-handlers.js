const { registerRegistration } = require("./registration");
const { registerRegistrationPreview } = require("./registration-preview");
const { registerProfile } = require("./profile");
const { registerAdmin, registerAdminUsernameRefresh } = require("./admin");
const { registerMyId } = require("./myid");
const { registerPrivateCallbackGuard } = require("./chat-guards");
const { registerStart } = require("./main-menu");
const { registerAccountLinks } = require("./account-links");
const { registerParticipantDataMenu } = require("./participant-data-menu");

// Keep one canonical registration order for production and integration tests.
function registerBotHandlers(bot, { rateLimiter } = {}) {
  const cleanups = [];
  registerAdminUsernameRefresh(bot);
  registerPrivateCallbackGuard(bot);
  cleanups.push(registerAdmin(bot, { rateLimiter }));
  registerStart(bot, { rateLimiter });
  registerMyId(bot, { rateLimiter });
  cleanups.push(registerParticipantDataMenu(bot, { rateLimiter }));
  cleanups.push(registerRegistrationPreview(bot, { rateLimiter }));
  registerRegistration(bot, { rateLimiter });
  registerProfile(bot, { rateLimiter });
  cleanups.push(registerAccountLinks(bot, { rateLimiter }));
  return cleanups;
}

module.exports = { registerBotHandlers };
