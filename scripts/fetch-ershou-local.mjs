#!/usr/bin/env node
/**
 * 本地用裸 HTTPS 抓贝壳（易被验证码拦截）。优先使用 Playwright：npm run daily:fetch:ershou:local
 */
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISTRICT_URLS,
  isCaptcha,
  parseCards,
  todayShanghai,
} from "./beike-parse.mjs";
import { loadDotenv } from "./load-dotenv.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
loadDotenv(root);

const OUT = path.join(root, "data", "ershou-local.json");
const REQUEST_MS = Number(process.env.BEIKE_TIMEOUT_MS || "15000") || 15000;
const MAX_ITEMS = Number(process.env.BEIKE_MAX_ITEMS || "30") || 30;
const UA =
  process.env.BEIKE_UA?.trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const COOKIE = process.env.BEIKE_COOKIE?.trim() || "";

function chromeLikeHeaders(targetUrl) {
  const u = new URL(targetUrl);
  return {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    Referer: process.env.BEIKE_REFERER?.trim() || `${u.origin}/`,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    ...(COOKIE ? { Cookie: COOKIE } : {}),
  };
}

function fetchText(url, redirectCount = 0) {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`重定向过多：${url}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers: chromeLikeHeaders(url) },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchText(next, redirectCount + 1).then(resolve).catch(reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`GET ${url} HTTP ${res.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );
    req.setTimeout(REQUEST_MS, () =>
      req.destroy(new Error(`请求超时（${REQUEST_MS}ms）：${url}`))
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const list = [];
  const warnings = [];
  if (!COOKIE) {
    warnings.push(
      "未配置 BEIKE_COOKIE：建议改用 Playwright（npm run beike:login 后 npm run daily:fetch:ershou:local）"
    );
  }
  for (const url of DISTRICT_URLS) {
    try {
      const html = await fetchText(url);
      if (isCaptcha(html)) {
        warnings.push(`命中验证码：${url}`);
        continue;
      }
      const rows = parseCards(html, url, MAX_ITEMS - list.length);
      if (!rows.length) warnings.push(`页面可访问但未解析到条目：${url}`);
      list.push(...rows);
      if (list.length >= MAX_ITEMS) break;
    } catch (e) {
      warnings.push(`${url} 抓取失败：${String(e.message || e)}`);
    }
  }

  const data = {
    date: todayShanghai(),
    source: "beike-http",
    secondHand: list.slice(0, MAX_ITEMS),
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
