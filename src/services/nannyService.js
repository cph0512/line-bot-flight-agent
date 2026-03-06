// =============================================
// 保母薪資管理服務
//
// 計算月薪：底薪 + 加班費 - 請假扣款 + 假日加倍
// 整合 Google Calendar 讀取請假事件
// =============================================

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { config } = require("../config");
const { getHolidaysInMonth } = require("../utils/taiwanHolidays");
const calendarService = require("./calendarService");

// ========== 檔案讀寫 ==========

function getConfigPath() {
  return path.resolve(config.nanny?.configPath || "./data/nanny-config.json");
}

function getRecordsPath() {
  return path.resolve(config.nanny?.recordsPath || "./data/salary-records.json");
}

function isAvailable() {
  try {
    return fs.existsSync(getConfigPath());
  } catch {
    return false;
  }
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    logger.warn(`[Nanny] 無法讀取設定檔: ${e.message}`);
    return { nannies: [], holidays: {} };
  }
}

function saveConfig(data) {
  const filePath = getConfigPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  data.updatedAt = new Date().toISOString();
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

function loadRecords() {
  try {
    const raw = fs.readFileSync(getRecordsPath(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return { records: [] };
  }
}

function saveRecords(data) {
  const filePath = getRecordsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// ========== 保母 CRUD ==========

function getAllNannies() {
  const cfg = loadConfig();
  return cfg.nannies || [];
}

function getNanny(id) {
  const nannies = getAllNannies();
  return nannies.find((n) => n.id === id) || null;
}

function upsertNanny(nannyData) {
  const cfg = loadConfig();
  if (!cfg.nannies) cfg.nannies = [];

  const idx = cfg.nannies.findIndex((n) => n.id === nannyData.id);
  if (idx >= 0) {
    cfg.nannies[idx] = { ...cfg.nannies[idx], ...nannyData };
  } else {
    cfg.nannies.push(nannyData);
  }
  saveConfig(cfg);
  return cfg.nannies.find((n) => n.id === nannyData.id);
}

function deleteNanny(id) {
  const cfg = loadConfig();
  const before = cfg.nannies.length;
  cfg.nannies = (cfg.nannies || []).filter((n) => n.id !== id);
  if (cfg.nannies.length < before) {
    saveConfig(cfg);
    return true;
  }
  return false;
}

// ========== 假日管理 ==========

function getHolidays(year) {
  const cfg = loadConfig();
  // 優先用自訂假日，fallback 到內建假日表
  if (cfg.holidays && cfg.holidays[year] && cfg.holidays[year].length > 0) {
    return cfg.holidays[year];
  }
  return getHolidaysInMonth(`${year}`) || [];
}

function getHolidaysForMonth(yearMonth) {
  const year = yearMonth.slice(0, 4);
  const cfg = loadConfig();

  // 優先用自訂假日
  if (cfg.holidays && cfg.holidays[year] && cfg.holidays[year].length > 0) {
    return cfg.holidays[year].filter((h) => h.date.startsWith(yearMonth));
  }
  // fallback 內建
  return getHolidaysInMonth(yearMonth);
}

function updateHolidays(year, holidays) {
  const cfg = loadConfig();
  if (!cfg.holidays) cfg.holidays = {};
  cfg.holidays[year] = holidays;
  saveConfig(cfg);
}

// ========== 薪資計算（核心）==========

/**
 * 計算單人月薪
 */
async function calculateMonthlySalary(nannyId, yearMonth) {
  const nanny = getNanny(nannyId);
  if (!nanny) throw new Error(`找不到保母 "${nannyId}"`);

  const year = parseInt(yearMonth.slice(0, 4));
  const month = parseInt(yearMonth.slice(5, 7));
  const daysInMonth = new Date(year, month, 0).getDate();

  // 1. 取得請假天數（從 Google Calendar）
  const leaveDays = await getLeaveDays(nanny, yearMonth, daysInMonth);

  // 2. 取得國定假日
  const holidays = getHolidaysForMonth(yearMonth);
  const holidayDates = new Set(holidays.map((h) => h.date));
  const leaveDates = new Set(leaveDays.map((l) => l.date));

  // 3. 國定假日有上班（假日不在請假日內）
  const holidaysWorked = holidays.filter((h) => !leaveDates.has(h.date));

  // 4. 計算薪資
  const baseSalary = nanny.baseSalary || 0;
  const overtimeAllowance = nanny.overtimeAllowance || 0;
  const totalMonthly = baseSalary + overtimeAllowance;

  let leaveDeduction = 0;
  let dailyDeductRate = 0;

  if (nanny.leaveDeductFrom === "overtime" && overtimeAllowance > 0) {
    // Wendy 模式：請假扣加班費
    dailyDeductRate = Math.round(overtimeAllowance / daysInMonth);
    leaveDeduction = dailyDeductRate * leaveDays.length;
  } else {
    // 阿姨模式：請假扣日薪（從底薪算）
    dailyDeductRate = Math.round(baseSalary / daysInMonth);
    leaveDeduction = dailyDeductRate * leaveDays.length;
  }

  // 5. 假日加倍（多給一倍日薪）
  const dailyRate = Math.round(totalMonthly / daysInMonth);
  const holidayBonus = dailyRate * holidaysWorked.length;

  // 6. 最終薪資
  const finalSalary = totalMonthly - leaveDeduction + holidayBonus;

  const record = {
    id: `${nannyId}-${yearMonth}`,
    nannyId,
    nannyName: nanny.name,
    month: yearMonth,
    baseSalary,
    overtimeAllowance,
    daysInMonth,
    leaveDays,
    leaveDaysCount: leaveDays.length,
    leaveDeduction,
    dailyDeductRate,
    holidaysInMonth: holidays,
    holidaysWorked,
    holidaysWorkedCount: holidaysWorked.length,
    holidayBonus,
    finalSalary,
    calculatedAt: new Date().toISOString(),
  };

  // 儲存紀錄
  saveSalaryRecord(record);

  return record;
}

/**
 * 計算全員月薪
 */
async function calculateAllSalaries(yearMonth) {
  const nannies = getAllNannies();
  if (nannies.length === 0) {
    return { text: "目前沒有設定任何保母。請先到後台新增保母資料。", records: [] };
  }

  const records = [];
  for (const nanny of nannies) {
    try {
      const record = await calculateMonthlySalary(nanny.id, yearMonth);
      records.push(record);
    } catch (e) {
      logger.error(`[Nanny] ${nanny.name} 薪資計算失敗: ${e.message}`);
      records.push({ nannyId: nanny.id, nannyName: nanny.name, error: e.message });
    }
  }

  const text = formatSalaryReport(records, yearMonth);
  return { text, records };
}

// ========== 請假偵測 ==========

/**
 * 從 Google Calendar 取得保母的請假天數
 */
async function getLeaveDays(nanny, yearMonth, daysInMonth) {
  if (!calendarService.isAvailable()) {
    logger.warn("[Nanny] 行事曆未設定，無法讀取請假資料");
    return [];
  }

  const year = yearMonth.slice(0, 4);
  const month = yearMonth.slice(5, 7);
  const startDate = `${yearMonth}-01`;
  const endDate = `${yearMonth}-${String(daysInMonth).padStart(2, "0")}`;

  try {
    const events = await calendarService.getRawEvents(startDate, endDate);
    const keyword = nanny.leaveKeyword;
    if (!keyword) return [];

    const leaveDays = [];
    const seenDates = new Set();

    for (const event of events) {
      // 比對事件標題
      if (!event.summary || !event.summary.includes(keyword)) continue;

      if (event.allDay) {
        // 全天事件 — 可能跨多天
        const eventStart = event.start; // "2026-03-05"
        const eventEnd = event.end; // "2026-03-06" (exclusive in Google Calendar)

        const start = new Date(eventStart + "T00:00:00+08:00");
        const end = new Date(eventEnd + "T00:00:00+08:00");

        // Google Calendar 全天事件 end 是 exclusive 的
        for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
          const dateStr = d.toISOString().slice(0, 10);
          if (dateStr.startsWith(yearMonth) && !seenDates.has(dateStr)) {
            seenDates.add(dateStr);
            leaveDays.push({ date: dateStr, source: "calendar", eventSummary: event.summary });
          }
        }
      } else {
        // 有時間的事件 — 算當天
        const dateStr = event.start.slice(0, 10);
        if (dateStr.startsWith(yearMonth) && !seenDates.has(dateStr)) {
          seenDates.add(dateStr);
          leaveDays.push({ date: dateStr, source: "calendar", eventSummary: event.summary });
        }
      }
    }

    leaveDays.sort((a, b) => a.date.localeCompare(b.date));
    return leaveDays;
  } catch (e) {
    logger.error(`[Nanny] 讀取 ${nanny.name} 請假失敗: ${e.message}`);
    return [];
  }
}

// ========== 格式化 ==========

function formatSalaryReport(records, yearMonth) {
  const [y, m] = yearMonth.split("-");
  let text = `💰 ${y}年${parseInt(m)}月 保母薪資\n`;

  let grandTotal = 0;

  for (const r of records) {
    if (r.error) {
      text += `\n👩 ${r.nannyName}\n  ⚠️ 計算失敗：${r.error}\n`;
      continue;
    }

    text += `\n👩 ${r.nannyName}`;
    if (r.overtimeAllowance > 0) {
      text += `\n  底薪：NT$ ${r.baseSalary.toLocaleString()}`;
      text += `\n  加班費：NT$ ${r.overtimeAllowance.toLocaleString()}`;
    } else {
      text += `\n  月薪：NT$ ${r.baseSalary.toLocaleString()}`;
    }

    if (r.leaveDaysCount > 0) {
      const dates = r.leaveDays.map((l) => l.date.slice(5)).join(", ");
      text += `\n  請假：${r.leaveDaysCount}天 (${dates})`;
      text += `\n  請假扣款：-NT$ ${r.leaveDeduction.toLocaleString()}`;
    } else {
      text += `\n  請假：0天`;
    }

    if (r.holidaysWorkedCount > 0) {
      const hDates = r.holidaysWorked.map((h) => `${h.date.slice(5)} ${h.name}`).join(", ");
      text += `\n  國定假日上班：${r.holidaysWorkedCount}天 (${hDates})`;
      text += `\n  假日加倍：+NT$ ${r.holidayBonus.toLocaleString()}`;
    }

    text += `\n  ────────────`;
    text += `\n  本月薪資：NT$ ${r.finalSalary.toLocaleString()}\n`;
    grandTotal += r.finalSalary;
  }

  text += `\n💰 本月總計：NT$ ${grandTotal.toLocaleString()}`;
  return text;
}

function formatSingleSalary(record) {
  return formatSalaryReport([record], record.month);
}

// ========== 紀錄管理 ==========

function saveSalaryRecord(record) {
  const data = loadRecords();
  const idx = data.records.findIndex((r) => r.id === record.id);
  if (idx >= 0) {
    data.records[idx] = record;
  } else {
    data.records.push(record);
  }
  // 只保留最近 100 筆
  if (data.records.length > 100) {
    data.records = data.records.slice(-100);
  }
  saveRecords(data);
}

function getSalaryRecords(limit = 20) {
  const data = loadRecords();
  return data.records.slice(-limit).reverse();
}

function getSalaryRecord(id) {
  const data = loadRecords();
  return data.records.find((r) => r.id === id) || null;
}

module.exports = {
  isAvailable,
  loadConfig,
  saveConfig,
  getAllNannies,
  getNanny,
  upsertNanny,
  deleteNanny,
  getHolidays,
  getHolidaysForMonth,
  updateHolidays,
  calculateMonthlySalary,
  calculateAllSalaries,
  formatSingleSalary,
  getSalaryRecords,
  getSalaryRecord,
};
