// =============================================
// 台灣國定假日資料
// 來源：行政院人事行政總處
// =============================================

const TAIWAN_HOLIDAYS = {
  2025: [
    { date: "2025-01-01", name: "元旦" },
    { date: "2025-01-27", name: "除夕" },
    { date: "2025-01-28", name: "春節" },
    { date: "2025-01-29", name: "春節" },
    { date: "2025-01-30", name: "春節" },
    { date: "2025-01-31", name: "春節" },
    { date: "2025-02-28", name: "和平紀念日" },
    { date: "2025-04-03", name: "兒童節" },
    { date: "2025-04-04", name: "清明節" },
    { date: "2025-05-01", name: "勞動節" },
    { date: "2025-05-31", name: "端午節" },
    { date: "2025-10-06", name: "中秋節" },
    { date: "2025-10-10", name: "國慶日" },
  ],
  2026: [
    { date: "2026-01-01", name: "元旦" },
    { date: "2026-02-16", name: "除夕" },
    { date: "2026-02-17", name: "春節" },
    { date: "2026-02-18", name: "春節" },
    { date: "2026-02-19", name: "春節" },
    { date: "2026-02-20", name: "春節" },
    { date: "2026-02-28", name: "和平紀念日" },
    { date: "2026-04-04", name: "兒童節" },
    { date: "2026-04-05", name: "清明節" },
    { date: "2026-05-01", name: "勞動節" },
    { date: "2026-06-19", name: "端午節" },
    { date: "2026-09-25", name: "中秋節" },
    { date: "2026-10-10", name: "國慶日" },
  ],
  2027: [
    { date: "2027-01-01", name: "元旦" },
    { date: "2027-02-05", name: "除夕" },
    { date: "2027-02-06", name: "春節" },
    { date: "2027-02-07", name: "春節" },
    { date: "2027-02-08", name: "春節" },
    { date: "2027-02-09", name: "春節" },
    { date: "2027-02-28", name: "和平紀念日" },
    { date: "2027-04-04", name: "兒童節" },
    { date: "2027-04-05", name: "清明節" },
    { date: "2027-05-01", name: "勞動節" },
    { date: "2027-06-09", name: "端午節" },
    { date: "2027-10-10", name: "國慶日" },
    { date: "2027-10-15", name: "中秋節" },
  ],
};

/**
 * 取得某年的國定假日列表
 */
function getHolidays(year) {
  return TAIWAN_HOLIDAYS[year] || [];
}

/**
 * 判斷某日期是否為國定假日
 */
function isHoliday(dateStr) {
  const year = parseInt(dateStr.slice(0, 4));
  const holidays = TAIWAN_HOLIDAYS[year] || [];
  return holidays.some((h) => h.date === dateStr);
}

/**
 * 取得某日期的假日名稱
 */
function getHolidayName(dateStr) {
  const year = parseInt(dateStr.slice(0, 4));
  const holidays = TAIWAN_HOLIDAYS[year] || [];
  const match = holidays.find((h) => h.date === dateStr);
  return match ? match.name : null;
}

/**
 * 取得某月份的國定假日列表
 */
function getHolidaysInMonth(yearMonth) {
  const year = parseInt(yearMonth.slice(0, 4));
  const holidays = TAIWAN_HOLIDAYS[year] || [];
  return holidays.filter((h) => h.date.startsWith(yearMonth));
}

module.exports = { TAIWAN_HOLIDAYS, getHolidays, isHoliday, getHolidayName, getHolidaysInMonth };
