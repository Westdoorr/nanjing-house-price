#!/usr/bin/env node
/**
 * 保存贝壳可用的浏览器环境，供 fetch-ershou-playwright 复用。
 *
 * 方式 A（推荐）：持久化 Chromium 用户目录（更像日常浏览器，极验通过率更高）
 * 方式 B：你已手动打开 Chrome 并开启远程调试时，用 CDP 连接后保存 storageState
 *
 * 出现「极验封禁」时：换手机热点/隔一段时间再试；或用手动 Chrome + BEIKE_CDP_URL。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { defaultProfileDir } from "./beike-profile.mjs";
import { applyStealthInitScripts, STEALTH_CHROME_ARGS } from "./beike-playwright-stealth.mjs";
import { loadDotenv } from "./load-dotenv.mjs";
import { DISTRICT_URLS } from "./beike-parse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
loadDotenv(root);

function question(rl, text) {
  return new Promise((resolve) => {
    rl.question(text, resolve);
  });
}

const storagePath =
  process.env.BEIKE_STORAGE_PATH?.trim() ||
  path.join(root, "data", "beike-storage.json");
const startUrl =
  process.env.BEIKE_LOGIN_START_URL?.trim() || DISTRICT_URLS[0];
const profileDir =
  process.env.BEIKE_PROFILE_DIR?.trim() || defaultProfileDir();
const cdpUrl = process.env.BEIKE_CDP_URL?.trim();
const useChrome = process.env.BEIKE_USE_CHROME !== "0";

async function main() {
  fs.mkdirSync(path.dirname(storagePath), { recursive: true });
  fs.mkdirSync(profileDir, { recursive: true });

  const rl = readline.createInterface({ input, output });

  if (cdpUrl) {
    console.log("使用 CDP 连接已打开的 Chrome：", cdpUrl);
    const browser = await chromium.connectOverCDP(cdpUrl);
    let context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext();
    }
    const page = await context.newPage();
    await applyStealthInitScripts(context);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await question(
      rl,
      "在已连接的 Chrome 里完成极验/登录，列表可正常打开后，按回车保存登录态到：\n" +
        storagePath +
        "\n> "
    );
    rl.close();
    await context.storageState({ path: storagePath });
    await browser.close();
    console.log("已保存：" + storagePath + "（可与持久目录二选一供抓取脚本使用）");
    return;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      ...(useChrome ? { channel: "chrome" } : {}),
      args: STEALTH_CHROME_ARGS,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1366, height: 900 },
    });
  } catch (e) {
    console.warn("使用系统 Chrome 启动失败，改用 Playwright Chromium：", e.message || e);
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: STEALTH_CHROME_ARGS,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1366, height: 900 },
    });
  }

  await applyStealthInitScripts(context);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  await question(
    rl,
    "在窗口中完成极验/登录，确认成交列表可浏览后，按回车保存。\n" +
      "持久目录：" +
      profileDir +
      "\n同时会写入：" +
      storagePath +
      "\n> "
  );
  rl.close();

  await context.storageState({ path: storagePath });
  await context.close();
  console.log("已保存。可执行：npm run daily:fetch:ershou:local");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
