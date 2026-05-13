#!/usr/bin/env node
/**
 * 使用 Playwright 抓取贝壳成交页 → data/ershou-local.json
 *
 * CDP 模式要点：复用你已打开、且已过极验的标签页，不要 newPage 后连跳 5 个区（会反复触发极验）。
 * 可选：BEIKE_INTERACTIVE=1 遇极验时在终端按回车再继续；BEIKE_ONLY_FIRST_DISTRICT=1 只抓一个区。
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  getFetchDistrictUrls,
  isCaptcha,
  parseCards,
  parseCardsFromPage,
  enrichSecondHandRowsListPriceFromDetails,
  todayShanghai,
} from "./beike-parse.mjs";
import { defaultProfileDir, isProfileSeeded } from "./beike-profile.mjs";
import { applyStealthInitScripts, STEALTH_CHROME_ARGS } from "./beike-playwright-stealth.mjs";
import { loadDotenv } from "./load-dotenv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
loadDotenv(root);

const OUT = path.join(root, "data", "ershou-local.json");
const storagePath =
  process.env.BEIKE_STORAGE_PATH?.trim() ||
  path.join(root, "data", "beike-storage.json");
const profileDir =
  process.env.BEIKE_PROFILE_DIR?.trim() || defaultProfileDir();
const cdpUrl =
  process.env.BEIKE_FETCH_CDP_URL?.trim() ||
  process.env.BEIKE_CDP_URL?.trim() ||
  "";
const MAX_ITEMS = Number(process.env.BEIKE_MAX_ITEMS || "30") || 30;
const NAV_TIMEOUT_MS = Number(process.env.BEIKE_NAV_TIMEOUT_MS || "60000") || 60000;
const HEADLESS = process.env.BEIKE_HEADLESS !== "0";
const useChrome = process.env.BEIKE_USE_CHROME !== "0";
const PAUSE_MS = Number(process.env.BEIKE_PAUSE_MS || "3500") || 3500;
const LIST_WAIT_MS = Number(process.env.BEIKE_LIST_WAIT_MS || "18000") || 18000;
const INTERACTIVE =
  process.env.BEIKE_INTERACTIVE === "1" ||
  process.env.BEIKE_INTERACTIVE === "true";
const ENRICH_DETAIL_LIST_PRICE = process.env.BEIKE_DETAIL_LIST_PRICE !== "0";
const DETAIL_LIST_PRICE_DELAY_MS =
  Number(process.env.BEIKE_DETAIL_LIST_PRICE_DELAY_MS || "280") || 280;
const DETAIL_SKIP_IF_COMPLETE = process.env.BEIKE_DETAIL_SKIP_IF_COMPLETE !== "0";
const CAPTCHA_RETRY = Math.min(
  8,
  Math.max(1, Number(process.env.BEIKE_CAPTCHA_RETRY || "4") || 4)
);

const LIST_SELECTORS =
  "ul.listContent, ul.listContent li, .content__list--item, .listContent";

function questionLine(text) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(text, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    let s = x.href;
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return String(u || "").replace(/\/$/, "");
  }
}

/** CDP：优先用当前已打开的成交列表标签，避免新开空白页触发风控 */
function pickPageForCdp(ctx) {
  const pages = ctx.pages();
  const ok = (p) => {
    try {
      const u = p.url();
      return u && !/^about:/i.test(u) && !/^chrome:\/\//i.test(u);
    } catch {
      return false;
    }
  };
  const cj = pages.find((p) => {
    try {
      return ok(p) && /ke\.com\/chengjiao/i.test(p.url());
    } catch {
      return false;
    }
  });
  if (cj) return cj;
  return pages.find((p) => ok(p)) || null;
}

async function openContext() {
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    let ctx = browser.contexts()[0];
    if (!ctx) ctx = await browser.newContext();
    await applyStealthInitScripts(ctx);
    return { kind: "cdp", browser, ctx };
  }

  if (isProfileSeeded(profileDir)) {
    try {
      const ctx = await chromium.launchPersistentContext(profileDir, {
        headless: HEADLESS,
        ...(useChrome && !HEADLESS ? { channel: "chrome" } : {}),
        args: STEALTH_CHROME_ARGS,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        viewport: { width: 1366, height: 900 },
      });
      await applyStealthInitScripts(ctx);
      return { kind: "persistent", ctx };
    } catch (e) {
      console.warn("持久目录启动失败，尝试 storageState：", e.message || e);
    }
  }

  if (fs.existsSync(storagePath)) {
    const browser = await chromium.launch({
      headless: HEADLESS,
      ...(useChrome && !HEADLESS ? { channel: "chrome" } : {}),
      args: STEALTH_CHROME_ARGS,
    });
    const ctx = await browser.newContext({
      storageState: storagePath,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1366, height: 900 },
    });
    await applyStealthInitScripts(ctx);
    return { kind: "ephemeral", browser, ctx };
  }

  return null;
}

async function waitForListOrTimeout(page) {
  try {
    await page.waitForSelector(LIST_SELECTORS, { timeout: LIST_WAIT_MS });
  } catch {
    /* ignore */
  }
}

async function loadHtmlAfterCaptcha(page, targetUrl, warnings) {
  for (let attempt = 0; attempt < CAPTCHA_RETRY; attempt++) {
    const cur = normalizeUrl(page.url());
    const want = normalizeUrl(targetUrl);
    if (cur !== want) {
      await page.goto(targetUrl, {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
    }
    await waitForListOrTimeout(page);
    await new Promise((r) => setTimeout(r, PAUSE_MS));

    let html = await page.content();
    if (!isCaptcha(html)) return html;

    const shot = path.join(root, "data", "beike-captcha.png");
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

    if (INTERACTIVE) {
      console.log(
        `\n[极验] 请在浏览器中完成验证（当前：${targetUrl}），完成后回到终端按回车继续（第 ${attempt + 1}/${CAPTCHA_RETRY} 次）…\n` +
          "（不会再整页跳转，以免再次触发极验；若仍失败可多按几次回车前确认列表已出来。）"
      );
      await questionLine("> ");
      /** 勿再次 goto：整页重载会再次触发极验；只等待 DOM 稳定后重新取 HTML */
      await new Promise((r) => setTimeout(r, 2500));
      await waitForListOrTimeout(page);
      continue;
    }

    warnings.push(
      `命中验证码/极验：${targetUrl}（截图 ${shot}）。` +
        (cdpUrl
          ? "CDP 下请先在已连接 Chrome 的当前标签打开该区列表并手动过极验；或设 BEIKE_INTERACTIVE=1 在终端等待；或减少区：BEIKE_ONLY_FIRST_DISTRICT=1。"
          : "可设 BEIKE_INTERACTIVE=1、或 BEIKE_CDP_URL 连接已手动过极验的 Chrome。")
    );
    return null;
  }
  warnings.push(`极验重试 ${CAPTCHA_RETRY} 次仍失败：${targetUrl}`);
  return null;
}

async function main() {
  const warnings = [];
  const list = [];
  const districtUrls = getFetchDistrictUrls();

  const opened = await openContext();
  if (!opened) {
    warnings.push(
      `未配置 CDP，且未找到持久目录（${profileDir}）与 ${storagePath}。请先 npm run beike:login；若仍遇极验，请用手动 Chrome 开调试端口并设 BEIKE_CDP_URL 后再抓取。`
    );
    writeOut(list, warnings);
    return;
  }

  const { ctx } = opened;
  let page;
  try {
    if (opened.kind === "cdp") {
      page = pickPageForCdp(ctx);
      if (!page) page = await ctx.newPage();
      if (cdpUrl && !process.env.BEIKE_DISTRICT_URLS?.trim()) {
        console.log(
          "CDP 已连接：将复用当前可见标签（若已是成交列表页更佳）。\n" +
            "若仍反复极验，建议在 .env 设 BEIKE_ONLY_FIRST_DISTRICT=1 或 BEIKE_INTERACTIVE=1。\n"
        );
      }
    } else {
      page = await ctx.newPage();
    }

    for (const url of districtUrls) {
      try {
        const html = await loadHtmlAfterCaptcha(page, url, warnings);
        if (!html) continue;

        let rows = parseCards(html, url, MAX_ITEMS - list.length);
        if (!rows.length) {
          rows = await parseCardsFromPage(
            page,
            url,
            MAX_ITEMS - list.length
          );
        }
        if (rows.length) {
          rows = await enrichSecondHandRowsListPriceFromDetails(page, rows, {
            enrichFromDetail: ENRICH_DETAIL_LIST_PRICE,
            detailDelayMs: DETAIL_LIST_PRICE_DELAY_MS,
            skipIfComplete: DETAIL_SKIP_IF_COMPLETE,
          });
        }
        if (!rows.length) {
          warnings.push(`页面可访问但未解析到条目：${url}`);
        }
        list.push(...rows);
        if (list.length >= MAX_ITEMS) break;
      } catch (e) {
        warnings.push(`${url} 抓取失败：${String(e.message || e)}`);
      }
    }
  } finally {
    if (opened.kind !== "cdp") {
      await page?.close().catch(() => {});
    }
    if (opened.kind === "cdp") {
      await opened.browser.close();
    } else if (opened.kind === "persistent") {
      await opened.ctx.close();
    } else {
      await opened.ctx.close();
      await opened.browser.close();
    }
  }

  writeOut(list, warnings);
}

function writeOut(secondHand, warnings) {
  const data = {
    date: todayShanghai(),
    source: "beike-playwright",
    secondHand: secondHand.slice(0, MAX_ITEMS),
    warning: warnings.join("；"),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2), "utf8");
  console.log(`已写入 ${OUT}`);
  if (data.warning) console.log(`warning: ${data.warning}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
