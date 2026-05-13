#!/usr/bin/env node
/**
 * 从南京市网上房地产公开页面抓取「新房」与「存量房」当日/近日官方口径数据，
 * 写入 data/nanjing-daily.json，供 daily-push.mjs 推送。
 *
 * 口径说明（务必读）：
 * - 新房：njhouse「今日商品房」认购/成交套数 + 「今日销售排行」（销售=认购+成交，非纯成交价）。
 * - 二手房：njzl 列表页仅提供「昨日住宅成交量」等汇总，不提供逐套成交价；逐套成交价需其它合规渠道。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const LOCAL_ERSHOU_PATH = path.join(root, "data", "ershou-local.json");

const UA =
  "Mozilla/5.0 (compatible; nanjing-house-price/1.0; +https://github.com/)";

const URL_NEW =
  "https://www.njhouse.com.cn/projectindex.html";
const URL_STOCK = "http://njzl.njhouse.com.cn/stock";
const DEFAULT_FOCUS_DISTRICTS = ["玄武区", "秦淮区", "建邺区", "鼓楼区", "雨花台区"];

function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const REQUEST_MS = Number(process.env.FETCH_TIMEOUT_MS || "25000") || 25000;

function fetchText(urlString, redirectCount = 0) {
  if (redirectCount > 10) {
    return Promise.reject(new Error("重定向次数过多"));
  }
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_MS);

    const u = new URL(urlString);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      urlString,
      {
        method: "GET",
        signal: ac.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, urlString).href;
          res.resume();
          clearTimeout(timer);
          fetchText(next, redirectCount + 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          reject(new Error(`GET ${urlString} → HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );
    req.on("error", (err) => {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        reject(new Error(`请求超时（${REQUEST_MS}ms）：${urlString}`));
        return;
      }
      reject(err);
    });
    req.end();
  });
}

function parseNewHouse(html) {
  const subscribeDeal = html.match(
    /认购\s*<div class="busniess_num_word">\s*(\d+)\s*<\/div>[\s\S]*?成交\s*<div class="busniess_num_word[^"]*">\s*(\d+)\s*<\/div>/i
  );
  const subscribeSets = subscribeDeal ? Number(subscribeDeal[1]) : null;
  const dealSets = subscribeDeal ? Number(subscribeDeal[2]) : null;

  const table = {};
  const tableHtml =
    html.includes("busniess_num_content") && html.includes("busniess_area")
      ? html.split("busniess_num_content")[1].split("busniess_area")[0]
      : html;
  const rowRe =
    /<span class="fs-6">([^<]+)<\/span>[\s\S]*?<span class="fs-6">([^<]+)<\/span>/g;
  let m;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const k = m[1].replace(/\s/g, "");
    const v = m[2].replace(/\s/g, "");
    if (k && v) table[k] = v;
  }

  const rank = [];
  const rankRe =
    /<a href="(\/project\/info\/\d+\/homePage\.html)"[^>]*class="busniess_house[^"]*"[^>]*>[\s\S]*?<div class="busniess_house_title">\s*([^<]+?)\s*<\/div>[\s\S]*?销售套数：<span[^>]*>(\d+)<\/span>[\s\S]*?销售面积：<span>([\d.]+)<\/span>/gi;
  while ((m = rankRe.exec(html)) !== null) {
    const href = m[1];
    const title = m[2].replace(/\s+/g, " ").trim();
    const sets = m[3];
    const area = m[4];
    rank.push({
      title,
      price: `销售套数 ${sets} 套 · 销售面积 ${area}㎡（销售=认购+成交）`,
      link: `https://www.njhouse.com.cn${href}`,
    });
    if (rank.length >= 15) break;
  }

  return { subscribeSets, dealSets, table, rank };
}

function parseFocusDistricts() {
  const raw = process.env.FOCUS_DISTRICTS?.trim();
  if (!raw) return DEFAULT_FOCUS_DISTRICTS;
  const list = raw
    .split(/[,\s，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_FOCUS_DISTRICTS;
}

function extractDistrictFromTitle(title) {
  const m = String(title).match(/^\[([^\]]+)\]/);
  return m ? m[1].trim() : "";
}

function parseStock(html) {
  const pick = (label) => {
    const re = new RegExp(`${label}[:：]\\s*(\\d+)`, "i");
    const x = html.match(re);
    return x ? Number(x[1]) : null;
  };

  return {
    totalListing: pick("总挂牌房源"),
    agencyListing: pick("中介挂牌房源"),
    personalListing: pick("个人挂牌房源"),
    yesterdayResidentialVolume: pick("昨日住宅成交量"),
  };
}

function loadLocalSecondHand() {
  if (!fs.existsSync(LOCAL_ERSHOU_PATH)) {
    return { list: [], warning: "" };
  }
  try {
    const raw = fs.readFileSync(LOCAL_ERSHOU_PATH, "utf8");
    const data = JSON.parse(raw);
    const list = Array.isArray(data.secondHand) ? data.secondHand : [];
    const warning = String(data.warning || "");
    return { list, warning };
  } catch (e) {
    return { list: [], warning: `读取本地二手数据失败：${String(e.message || e)}` };
  }
}

function buildReport(newParsed, stockParsed, stockWarn) {
  const date = todayShanghai();
  const focusDistricts = parseFocusDistricts();
  const newHouse = newParsed.rank.filter((item) =>
    focusDistricts.includes(extractDistrictFromTitle(item.title))
  );

  const secondHand = [];
  if (stockParsed.yesterdayResidentialVolume != null) {
    secondHand.push({
      title: "官方汇总：昨日住宅成交量（套）",
      price: `${stockParsed.yesterdayResidentialVolume} 套`,
      link: URL_STOCK,
    });
  }
  if (stockParsed.totalListing != null) {
    secondHand.push({
      title: "官方汇总：当前总挂牌房源（套）",
      price: `${stockParsed.totalListing} 套`,
      link: URL_STOCK,
    });
  }
  const localSecond = loadLocalSecondHand();
  if (localSecond.list.length) {
    secondHand.push(...localSecond.list);
  }

  const noteParts = [];
  if (stockWarn) {
    noteParts.push(`存量房页面抓取失败（已尝试 HTTP/HTTPS）：${stockWarn}。`);
  }
  if (localSecond.warning) {
    noteParts.push(`贝壳本地采集提示：${localSecond.warning}`);
  }
  noteParts.push(
    "数据来源：南京市网上房地产公开页面（新房）与存量房列表页（汇总）。",
    `推送范围：仅保留关注区域（${focusDistricts.join("、")}）。`,
    "新房「今日销售排行」口径为销售套数（销售=认购+成交），非单套成交价；单价需进入具体楼盘/许可页面查看。",
    "二手房公开列表页不提供「当日逐套成交价」；页面展示为「昨日住宅成交量」等汇总指标。若需成交明细与价格，需另行对接合规数据服务或手工维护。"
  );

  return {
    date,
    summary: {
      newHouseTodaySets: {
        subscribe: newParsed.subscribeSets,
        deal: newParsed.dealSets,
        source: URL_NEW,
      },
      newHouseMarketTable: newParsed.table,
      secondHandOfficial: {
        ...stockParsed,
        source: URL_STOCK,
      },
    },
    newHouse,
    secondHand,
    note: noteParts.join(" "),
  };
}

async function main() {
  const outPath =
    process.env.DAILY_REPORT_PATH?.trim() ||
    path.join(root, "data", "nanjing-daily.json");

  let stockWarn = "";
  const newHtml = await fetchText(URL_NEW);

  let stockHtml = "";
  const stockUrls = [
    process.env.NJZL_STOCK_URL?.trim() || URL_STOCK,
    "https://njzl.njhouse.com.cn/stock",
    "http://njzl.njhouse.com.cn/stock",
  ];
  const tried = new Set();
  for (const u of stockUrls) {
    if (!u || tried.has(u)) continue;
    tried.add(u);
    try {
      stockHtml = await fetchText(u);
      break;
    } catch (e) {
      stockWarn = String(e?.message || e);
    }
  }

  const newParsed = parseNewHouse(newHtml);
  const stockParsed = stockHtml ? parseStock(stockHtml) : {};
  const report = buildReport(newParsed, stockParsed, stockWarn);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`已写入 ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
