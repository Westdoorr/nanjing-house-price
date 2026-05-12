#!/usr/bin/env node
/**
 * 读取日报 JSON → 组装 Markdown → 企业微信群机器人推送
 * 环境变量：WECHAT_WORK_WEBHOOK（必填）
 * - 可在终端先 export；或写在项目根目录 .env（勿提交 git），本脚本会自动加载。
 * 可选：DAILY_REPORT_PATH（默认项目根目录 data/nanjing-daily.json）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotenv } from "./load-dotenv.mjs";
import { sendWecomMarkdown } from "./wecom-robot.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
loadDotenv(root);
// 若从上级目录执行 node/npm，cwd 可能与 package 根不一致，再尝试 cwd 下的 .env
if (path.resolve(process.cwd()) !== path.resolve(root)) {
  loadDotenv(process.cwd());
}

function todayShanghai() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function loadReport() {
  const inline = process.env.DAILY_REPORT_JSON?.trim();
  if (inline) {
    try {
      return { path: "(环境变量 DAILY_REPORT_JSON)", data: JSON.parse(inline) };
    } catch (e) {
      return { path: "(环境变量 DAILY_REPORT_JSON)", data: null, error: e };
    }
  }

  const reportPath =
    process.env.DAILY_REPORT_PATH?.trim() ||
    path.join(root, "data", "nanjing-daily.json");
  if (!fs.existsSync(reportPath)) {
    return { path: reportPath, data: null };
  }
  try {
    const raw = fs.readFileSync(reportPath, "utf8");
    return { path: reportPath, data: JSON.parse(raw) };
  } catch (e) {
    return { path: reportPath, data: null, error: e };
  }
}

function escMd(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatList(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) {
    return emptyText;
  }
  return items
    .slice(0, 30)
    .map((it, i) => {
      const title = escMd(it.title ?? it.name ?? "（无标题）");
      const price = it.price != null ? ` ${escMd(it.price)}` : "";
      const link = it.link ? ` [详情](${String(it.link).trim()})` : "";
      return `${i + 1}. ${title}${price}${link}`;
    })
    .join("\n");
}

function formatSummary(summary) {
  if (!summary || typeof summary !== "object") return "";

  const lines = [];
  const n = summary.newHouseTodaySets;
  if (n && (n.subscribe != null || n.deal != null)) {
    const sub = n.subscribe != null ? `${n.subscribe} 套` : "—";
    const deal = n.deal != null ? `${n.deal} 套` : "—";
    lines.push(`- **今日商品房（官方）**：认购 ${sub}，成交 ${deal}`);
    if (n.source) lines.push(`  - 来源：[南京网上房地产·商品房](${n.source})`);
  }

  const t = summary.newHouseMarketTable;
  if (t && typeof t === "object" && Object.keys(t).length) {
    const picks = ["全市入网项目", "全市入网面积", "本年上市", "本年成交", "本月上市", "本月成交"];
    const parts = picks
      .filter((k) => t[k])
      .map((k) => `${k} ${escMd(t[k])}`);
    if (parts.length) {
      lines.push(`- **新房市场概览**：${parts.join("；")}`);
    }
  }

  const s = summary.secondHandOfficial;
  if (s && typeof s === "object") {
    const bits = [];
    if (s.yesterdayResidentialVolume != null) {
      bits.push(`昨日住宅成交量 ${s.yesterdayResidentialVolume} 套`);
    }
    if (s.totalListing != null) bits.push(`总挂牌 ${s.totalListing} 套`);
    if (bits.length) {
      lines.push(`- **存量房（官方汇总）**：${bits.join("；")}`);
      if (s.source) lines.push(`  - 来源：[存量房列表](${s.source})`);
    }
  }

  if (!lines.length) return "";
  return `#### 数据摘要\n${lines.join("\n")}\n\n`;
}

function buildMarkdown({ reportPath, data, error }) {
  const date = data?.date || todayShanghai();
  const header = `### 南京房产成交日报（${date}）\n`;

  if (error) {
    return (
      header +
      `> 读取日报文件失败：${escMd(error.message)}\n` +
      `> 路径：<${escMd(reportPath)}>\n`
    );
  }

  if (!data) {
    return (
      header +
      `> 未找到日报数据文件。\n` +
      `> 请先运行 \`npm run daily:fetch\` 或写入：<${escMd(reportPath)}>\n` +
      `> 可参考仓库内 \`data/nanjing-daily.example.json\` 格式。\n`
    );
  }

  const summaryBlock = formatSummary(data.summary);
  const note = data.note ? `\n**备注**：${escMd(data.note)}\n` : "";
  const second = formatList(
    data.secondHand,
    "> 今日暂无二手房成交记录（或列表为空）。"
  );
  const neu = formatList(
    data.newHouse,
    "> 今日暂无新房成交记录（或列表为空）。"
  );

  return (
    header +
    summaryBlock +
    `#### 二手房\n${second}\n\n` +
    `#### 新房\n${neu}\n` +
    note +
    `\n<font color="comment">推送时间（上海）：${escMd(
      new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    )}</font>`
  );
}

async function main() {
  const webhook = process.env.WECHAT_WORK_WEBHOOK;
  if (!webhook?.trim()) {
    const envPaths = [
      path.join(root, ".env"),
      path.join(root, ".env.local"),
    ];
    if (path.resolve(process.cwd()) !== path.resolve(root)) {
      envPaths.push(path.join(process.cwd(), ".env"));
      envPaths.push(path.join(process.cwd(), ".env.local"));
    }
    const exists = envPaths.filter((p) => fs.existsSync(p));
    console.error(
      "请设置环境变量 WECHAT_WORK_WEBHOOK（注意大小写与拼写）。\n" +
        "任选其一：\n" +
        "  1) 终端执行：export WECHAT_WORK_WEBHOOK='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...'\n" +
        "  2) 在以下路径之一创建 .env，单独一行（不要改变量名）：WECHAT_WORK_WEBHOOK=你的完整地址\n" +
        envPaths.map((p) => `     - ${p}`).join("\n") +
        "\n" +
        (exists.length
          ? `已检测到 .env 文件：${exists.join("；")} —— 若仍失败，请打开检查：是否有 BOM、是否写成 export WECHAT_WORK_WEBHOOK=、等号两侧是否有多余空格、值是否被截断。\n`
          : "当前未检测到上述路径中的 .env / .env.local 文件。\n") +
        "说明：若系统里存在「同名但值为空」的环境变量，会阻止读取 .env；已改为空值时也会用 .env 覆盖。"
    );
    process.exit(1);
  }

  const { path: reportPath, data, error } = loadReport();
  const markdown = buildMarkdown({ reportPath, data, error });

  await sendWecomMarkdown(webhook, markdown);
  console.log("企业微信推送成功");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
