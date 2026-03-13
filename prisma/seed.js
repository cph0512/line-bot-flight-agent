const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding database...");

  // 1. 建立原始用戶（Owner）
  const ownerLineId = process.env.OWNER_LINE_USER_ID;
  if (!ownerLineId) {
    console.warn("⚠️  OWNER_LINE_USER_ID 未設定，跳過 owner 建立");
  } else {
    const owner = await prisma.user.upsert({
      where: { lineUserId: ownerLineId },
      update: {},
      create: {
        lineUserId: ownerLineId,
        displayName: "Owner",
        status: "ACTIVE",
        activatedAt: new Date(),
        settings: {
          create: {
            defaultCity: process.env.DEFAULT_CITY || "臺北市",
            timezone: process.env.TZ || "Asia/Taipei",
            eventReminderMin: parseInt(process.env.EVENT_REMINDER_MINUTES) || 120,
            eventReminderOrigin: process.env.EVENT_REMINDER_ORIGIN || null,
          },
        },
      },
    });
    console.log(`✅ Owner 用戶已建立: ${owner.id} (${ownerLineId.slice(-6)})`);

    // Owner 預設開啟 nanny 模組
    await prisma.userSettings.upsert({
      where: { userId: owner.id },
      update: { enabledModules: JSON.stringify(["nanny"]) },
      create: {
        userId: owner.id,
        defaultCity: process.env.DEFAULT_CITY || "臺北市",
        timezone: process.env.TZ || "Asia/Taipei",
        enabledModules: JSON.stringify(["nanny"]),
      },
    });
    console.log("  ✅ Owner nanny 模組已啟用");

    // 2. 遷移保母設定
    const nannyConfigPath = process.env.NANNY_CONFIG_PATH || "./data/nanny-config.json";
    if (fs.existsSync(nannyConfigPath)) {
      const nannyData = JSON.parse(fs.readFileSync(nannyConfigPath, "utf-8"));
      for (const nanny of nannyData.nannies || []) {
        await prisma.nannyConfig.upsert({
          where: {
            userId_nannyId: { userId: owner.id, nannyId: nanny.id },
          },
          update: {
            name: nanny.name,
            baseSalary: nanny.baseSalary || 0,
            overtimeAllowance: nanny.overtimeAllowance || 0,
            leaveDeductFrom: nanny.leaveDeductFrom || "base",
            leaveKeyword: nanny.leaveKeyword || null,
            notes: nanny.notes || null,
          },
          create: {
            userId: owner.id,
            nannyId: nanny.id,
            name: nanny.name,
            baseSalary: nanny.baseSalary || 0,
            overtimeAllowance: nanny.overtimeAllowance || 0,
            leaveDeductFrom: nanny.leaveDeductFrom || "base",
            leaveKeyword: nanny.leaveKeyword || null,
            notes: nanny.notes || null,
          },
        });
        console.log(`  ✅ 保母 ${nanny.name} 已遷移`);
      }

      // 遷移自訂假日
      for (const [year, holidays] of Object.entries(nannyData.holidays || {})) {
        for (const h of holidays) {
          await prisma.customHoliday.upsert({
            where: {
              userId_date: { userId: owner.id, date: h.date },
            },
            update: { name: h.name, year: parseInt(year) },
            create: {
              userId: owner.id,
              year: parseInt(year),
              date: h.date,
              name: h.name,
            },
          });
        }
        if (holidays.length > 0) {
          console.log(`  ✅ ${year} 年假日 ${holidays.length} 筆已遷移`);
        }
      }
    }

    // 3. 遷移晨報設定
    if (process.env.BRIEFING_RECIPIENTS) {
      await prisma.briefingConfig.upsert({
        where: { userId: owner.id },
        update: {},
        create: {
          userId: owner.id,
          enabled: true,
          time: process.env.MORNING_BRIEFING_TIME || "07:00",
          cities: process.env.BRIEFING_CITIES || "臺北市",
          newsSections: process.env.BRIEFING_NEWS || "tw:general:5",
        },
      });
      console.log("  ✅ 晨報設定已遷移");
    }

    // 4. 遷移通勤路線
    if (process.env.COMMUTE_ROUTES) {
      const routes = process.env.COMMUTE_ROUTES.split(",").map((r) => {
        const [name, origin, destination] = r.split("|").map((s) => s.trim());
        return { name, origin, destination };
      });
      for (const route of routes) {
        if (!route.name || !route.origin || !route.destination) continue;
        await prisma.commuteRoute.create({
          data: {
            userId: owner.id,
            name: route.name,
            origin: route.origin,
            destination: route.destination,
            notifyTime: process.env.COMMUTE_NOTIFICATION_TIME || "08:15",
            weekdayOnly: process.env.COMMUTE_WEEKDAY_ONLY !== "false",
          },
        });
        console.log(`  ✅ 通勤路線 ${route.name} 已遷移`);
      }
    }

    // 5. 遷移家庭行事曆
    if (process.env.FAMILY_CALENDARS) {
      const cals = process.env.FAMILY_CALENDARS.split(",").map((pair) => {
        const [name, id] = pair.split(":").map((s) => s.trim());
        return { name, calendarId: id };
      });
      for (const cal of cals) {
        if (!cal.name || !cal.calendarId) continue;
        await prisma.familyCalendar.create({
          data: {
            userId: owner.id,
            name: cal.name,
            calendarId: cal.calendarId,
          },
        });
        console.log(`  ✅ 家庭行事曆 ${cal.name} 已遷移`);
      }
    }
  }

  // 6. 建立預設邀請碼
  const defaultCodes = ["FAMILY2026", "FRIEND2026", "VIP2026"];
  for (const code of defaultCodes) {
    await prisma.invitationCode.upsert({
      where: { code },
      update: {},
      create: {
        code,
        maxUses: 5,
        createdBy: "seed",
      },
    });
  }
  console.log(`✅ 預設邀請碼已建立: ${defaultCodes.join(", ")}`);

  console.log("\n🎉 Seeding 完成！");
}

main()
  .catch((e) => {
    console.error("❌ Seed 失敗:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
