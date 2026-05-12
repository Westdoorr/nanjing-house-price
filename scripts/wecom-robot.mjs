/**
 * 企业微信群机器人 Webhook 发送（markdown）
 * 使用 Node 内置 https，兼容 Node 16（无全局 fetch）。
 * @see https://developer.work.weixin.qq.com/document/path/91770
 */
import https from "node:https";
import { URL } from "node:url";

const MAX_MARKDOWN = 3800;
const POST_MS = Number(process.env.WECOM_POST_TIMEOUT_MS || "20000") || 20000;

function normalizeWebhook(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(s)}`;
}

/**
 * @param {string} webhookUrlOrKey
 * @param {string} markdown
 */
export function sendWecomMarkdown(webhookUrlOrKey, markdown) {
  const url = normalizeWebhook(webhookUrlOrKey);
  if (!url) {
    return Promise.reject(
      new Error("缺少 WECHAT_WORK_WEBHOOK：请配置完整 Webhook 地址或 key")
    );
  }

  let content = markdown;
  if (content.length > MAX_MARKDOWN) {
    content =
      content.slice(0, MAX_MARKDOWN) +
      "\n\n> …内容过长已截断，请查看腾讯文档或本地 data/nanjing-daily.json";
  }

  const payload = JSON.stringify({
    msgtype: "markdown",
    markdown: { content },
  });

  const u = new URL(url);
  if (u.protocol !== "https:") {
    return Promise.reject(new Error("企业微信 Webhook 仅支持 https 地址"));
  }

  return new Promise((resolve, reject) => {
    /** @type {import("node:https").ClientRequest | undefined} */
    let req;
    const timer = setTimeout(() => {
      req?.destroy(new Error(`推送请求超时（${POST_MS}ms）`));
    }, POST_MS);

    req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          let data = {};
          try {
            data = JSON.parse(
              Buffer.concat(chunks).toString("utf8") || "{}"
            );
          } catch {
            data = {};
          }
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${res.statusCode} ${res.statusMessage}: ${JSON.stringify(data)}`
              )
            );
            return;
          }
          if (data.errcode !== 0) {
            reject(
              new Error(
                `企业微信返回错误 errcode=${data.errcode} errmsg=${data.errmsg}`
              )
            );
            return;
          }
          resolve(data);
        });
      }
    );

    req.on("error", reject);
    req.on("close", () => clearTimeout(timer));

    req.write(payload);
    req.end();
  });
}
