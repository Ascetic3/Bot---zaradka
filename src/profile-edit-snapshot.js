const editableFields = new Set(["first_name", "last_name", "city", "email", "preferred_contact", "referral_source"]);
const nullableTextFields = ["last_name", "city", "email", "preferred_contact", "referral_source", "phone_confirmed_at", "consent_withdrawn_at"];
const requiredTextFields = ["first_name", "phone", "registered_at", "updated_at", "consent_at", "consent_version"];
const snapshotFields = Object.freeze([
  "id", "first_name", "last_name", "phone", "city", "email", "preferred_contact", "referral_source",
  "registered_at", "updated_at", "phone_confirmed_at", "personal_data_consent", "consent_at", "consent_version", "consent_withdrawn_at"
]);

function createProfileEditSnapshot(participant) {
  return Object.fromEntries(snapshotFields.map((field) => [field, participant[field] ?? null]));
}

function hasExactKeys(value, keys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

function isTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function isValidProfileSnapshot(snapshot, expectedParticipantId = null) {
  if (!hasExactKeys(snapshot, snapshotFields)) return false;
  if (!Number.isSafeInteger(snapshot.id) || snapshot.id <= 0 ||
      (expectedParticipantId !== null && snapshot.id !== Number(expectedParticipantId))) return false;
  if (requiredTextFields.some((field) => typeof snapshot[field] !== "string" || !snapshot[field].trim())) return false;
  if (nullableTextFields.some((field) => snapshot[field] !== null && typeof snapshot[field] !== "string")) return false;
  if (!/^\+[1-9]\d{7,14}$/.test(snapshot.phone)) return false;
  if (![0, 1].includes(snapshot.personal_data_consent) || snapshot.personal_data_consent !== 1 || snapshot.consent_withdrawn_at !== null) return false;
  if (!isTimestamp(snapshot.registered_at) || !isTimestamp(snapshot.updated_at) || !isTimestamp(snapshot.consent_at)) return false;
  if (snapshot.phone_confirmed_at !== null && !isTimestamp(snapshot.phone_confirmed_at)) return false;
  if (snapshot.preferred_contact !== null && !["Telegram", "MAX", "Телефонный звонок", "Электронная почта"].includes(snapshot.preferred_contact)) return false;
  if (snapshot.preferred_contact === "Электронная почта" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(snapshot.email ?? "")) return false;
  return true;
}

function isValidProfileEditDraft(step, answers, expectedParticipantId = null) {
  if (step === "profile_edit_select") return hasExactKeys(answers, []);
  const field = typeof step === "string" && step.startsWith("profile_edit:") ? step.slice("profile_edit:".length) : "";
  if (!editableFields.has(field) || !hasExactKeys(answers, ["edit_field", "participant_id", "snapshot"])) return false;
  if (answers.edit_field !== field || !Number.isSafeInteger(answers.participant_id) || answers.participant_id <= 0) return false;
  if (expectedParticipantId !== null && answers.participant_id !== Number(expectedParticipantId)) return false;
  return isValidProfileSnapshot(answers.snapshot, answers.participant_id);
}

module.exports = { createProfileEditSnapshot, isValidProfileSnapshot, isValidProfileEditDraft };
