const firstNames = [
  "Анна", "Дмитрий", "Мария", "Алексей", "Екатерина", "Иван", "Ольга", "Сергей", "Наталья", "Андрей",
  "Елена", "Михаил", "Татьяна", "Павел", "Ирина", "Николай", "Светлана", "Роман", "Юлия", "Виктор",
  "Алина", "Максим", "Валерия", "Кирилл", "Дарья", "Егор", "Полина", "Артём", "Вера", "Тимофей"
];
const lastNames = [
  "Смирнова", "Волков", "Кузнецова", "Морозов", "Соколова", "Лебедев", "Козлова", "Новиков", "Попова", "Фёдоров",
  "Михайлова", "Орлов", "Павлова", "Семёнов", "Захарова", "Петров", "Васильева", "Голубев", "Виноградова", "Богданов",
  "Воробьёва", "Фролов", "Медведева", "Беляев", "Тарасова", "Комаров", "Жукова", "Киселёв", "Макарова", "Андреев",
  "Алексеева", "Яковлев"
];
const cityCounts = [35, 24, 20, 18, 15, 12, 10, 8, 5, 3];
const cityNames = ["Москва", "Санкт-Петербург", "Екатеринбург", "Казань", "Новосибирск", "Краснодар", "Тюмень", "Челябинск", "Пермь", "Самара"];
const weightedCities = cityCounts.flatMap((count, index) => Array(count).fill(cityNames[index]));
const contactOptions = ["Telegram", "MAX", "Телефонный звонок", "Электронная почта"];
const sources = ["От друзей или знакомых", "Telegram", "MAX", "Другие социальные сети", "Реклама", "Мероприятие", "Подкаст о привычках"];
const DAY_MS = 24 * 60 * 60 * 1000;

function createDemoRecords(seedDate = new Date()) {
  const anchor = new Date(seedDate);
  if (Number.isNaN(anchor.getTime())) throw new TypeError("Нужна корректная дата генерации.");
  return Array.from({ length: 150 }, (_, index) => {
    const number = index + 1;
    const tag = String(number).padStart(3, "0");
    const registeredAt = new Date(anchor.getTime() - ((index * 17) % 120) * DAY_MS).toISOString();
    const email = number % 13 === 0 ? null : `participant-${tag}@demo.example`;
    const contactIndex = number % 4;
    const referralIndex = number % sources.length;
    return {
      first_name: firstNames[index % firstNames.length],
      last_name: lastNames[(index * 7) % lastNames.length],
      phone: `+999000000${tag}`,
      city: number % 23 === 0 ? null : weightedCities[index],
      email,
      preferred_contact: contactIndex === 3 && !email ? "Telegram" : contactOptions[contactIndex],
      referral_source: number % 17 === 0 ? null : sources[referralIndex],
      registered_at: registeredAt,
      updated_at: registeredAt,
      phone_confirmed_at: null,
      personal_data_consent: 0,
      consent_at: null,
      accounts: [
        ...(number % 3 !== 0 ? [{ platform: "telegram", messenger_user_id: `DEMO-TG-${tag}` }] : []),
        ...(number % 5 === 0 ? [{ platform: "max", messenger_user_id: `DEMO-MAX-${tag}` }] : [])
      ]
    };
  });
}

module.exports = { createDemoRecords, firstNames, lastNames, cityNames, contactOptions, sources };
