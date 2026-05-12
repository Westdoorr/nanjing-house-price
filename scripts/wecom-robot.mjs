/**
 * 企业微信群机器人 Webhook 发送（markdown）
 * @see https://developer.work.weixin.qq.com/document/path/91770
 */

const MAX_MARKDOWN = 3800;

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
export async function sendWecomMarkdown(webhookUrlOrKey, markdown) {
  const url = normalizeWebhook(webhookUrlOrKey);
  if (!url) {
    throw new Error("缺少 WECHAT_WORK_WEBHOOK：请配置完整 Webhook 地址或 key");
  }

  let content = markdown;
  if (content.length > MAX_MARKDOWN) {
    content =
      content.slice(0, MAX_MARKDOWN) +
      "\n\n> …内容过长已截断，请查看腾讯文档或本地 data/nanjing-daily.json";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
  }
  if (data.errcode !== 0) {
    throw new Error(`企业微信返回错误 errcode=${data.errcode} errmsg=${data.errmsg}`);
  }
  return data;
}
