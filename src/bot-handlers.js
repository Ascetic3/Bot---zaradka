const { registerRegistration } = require("./registration");
const { registerRegistrationPreview } = require("./registration-preview");
const { registerDemoRegistration } = require("./demo-registration");
const { registerProfile } = require("./profile");
const { registerAdmin, registerAdminUsernameRefresh } = require("./admin");
const { registerMyId } = require("./myid");
const { registerPrivateCallbackGuard } = require("./chat-guards");
const { registerStart } = require("./main-menu");
const { registerAccountLinks } = require("./account-links");
const { registerParticipantDataMenu } = require("./participant-data-menu");

// Keep one canonical registration order for production and integration tests.
function registerBotHandlers(bot, { rateLimiter, demoRegistrationService, participantDataService, demoProjectRoot } = {}) {
  const cleanups = [];
  registerAdminUsernameRefresh(bot);
  registerPrivateCallbackGuard(bot);
  cleanups.push(registerAdmin(bot, { rateLimiter, demoProjectRoot }));
  // Test registration and preview own independent in-memory sessions.
  // Register the test flow first so /preview_registration can release its
  // session before the preview flow handles the command.
  cleanups.push(registerDemoRegistration(bot, { rateLimiter, service: demoRegistrationService }));
  cleanups.push(registerRegistrationPreview(bot, { rateLimiter }));
  registerStart(bot, { rateLimiter });
  registerMyId(bot, { rateLimiter });
  cleanups.push(registerParticipantDataMenu(bot, { rateLimiter, service: participantDataService }));
  registerRegistration(bot, { rateLimiter });
  registerProfile(bot, { rateLimiter });
  cleanups.push(registerAccountLinks(bot, { rateLimiter }));
  return cleanups;
}

module.exports = { registerBotHandlers };

