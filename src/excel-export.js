const ExcelJS = require("exceljs");

const columns = [
  { header: "ID участника", key: "id", width: 15, text: true },
  { header: "Имя", key: "first_name", width: 22, text: true },
  { header: "Фамилия", key: "last_name", width: 24, text: true },
  { header: "Номер телефона", key: "phone", width: 22, text: true },
  { header: "Город проживания", key: "city", width: 24, text: true },
  { header: "Электронная почта", key: "email", width: 30, text: true },
  { header: "Предпочтительный способ связи", key: "preferred_contact", width: 32, text: true },
  { header: "Откуда узнали о клубе", key: "referral_source", width: 26, text: true },
  { header: "Дата регистрации", key: "registered_at", width: 20, date: true },
  { header: "Telegram ID", key: "telegram_id", width: 20, text: true },
  { header: "MAX ID", key: "max_id", width: 20, text: true },
  { header: "Статус подтверждения телефона", key: "phone_status", width: 34, text: true },
  { header: "Дата согласия на обработку данных", key: "consent_at", width: 36, date: true }
];

function asText(value) {
  return value === null || value === undefined || value === "" ? "Не указано" : String(value);
}

function asDate(value) {
  if (!value) return "Не указано";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Не указано" : date;
}

function filenameDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getExportFilename(now = new Date()) {
  return `Магия_утра_участники_${filenameDate(now)}.xlsx`;
}

async function createParticipantsWorkbook(participants) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Клуб «Магия утра»";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Участники", { views: [{ state: "frozen", ySplit: 1 }] });
  worksheet.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  worksheet.autoFilter = { from: "A1", to: `${worksheet.getColumn(columns.length).letter}1` };
  const header = worksheet.getRow(1);
  header.height = 30;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF287A54" } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });

  for (const person of participants) {
    const row = worksheet.addRow({
      id: asText(person.id),
      first_name: asText(person.first_name),
      last_name: asText(person.last_name),
      phone: asText(person.phone),
      city: asText(person.city),
      email: asText(person.email),
      preferred_contact: asText(person.preferred_contact),
      referral_source: asText(person.referral_source),
      registered_at: asDate(person.registered_at),
      telegram_id: asText(person.telegram_id),
      max_id: asText(person.max_id),
      phone_status: person.phone_confirmed_at ? "Подтверждён" : "Не подтверждён",
      consent_at: asDate(person.consent_at)
    });
    for (const column of columns) {
      const cell = row.getCell(column.key);
      if (column.date && cell.value instanceof Date) {
        cell.numFmt = "dd.mm.yyyy hh:mm";
      } else if (column.text) {
        // Строковые ячейки XLSX не интерпретируются как формулы. Формулы в выгрузке не создаются.
        cell.value = asText(cell.value);
        cell.type = ExcelJS.ValueType.String;
        cell.numFmt = "@";
      }
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { createParticipantsWorkbook, getExportFilename };

