import fs from "node:fs";
import path from "node:path";

/**
 * 读取项目根目录 .env / .env.local，写入 process.env。
 * - 若某键在环境中为「未定义」或「仅空白」，才用文件中的值填充（空白可被 .env 覆盖）。
 * - 支持 UTF-8 BOM、行首 `export `、键名两侧空格。
 */
export function loadDotenv(rootDir) {
  const files = [
    path.join(rootDir, ".env"),
    path.join(rootDir, ".env.local"),
  ];

  for (const p of files) {
    if (!fs.existsSync(p)) continue;
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

    for (const line of raw.split(/\r?\n/)) {
      let s = line.trim();
      if (!s || s.startsWith("#")) continue;
      if (/^export\s+/i.test(s)) s = s.replace(/^export\s+/i, "").trim();
      const eq = s.indexOf("=");
      if (eq <= 0) continue;
      let key = s.slice(0, eq).trim().replace(/^\uFEFF/, "");
      let val = s.slice(eq + 1).trim();
      if (!key) continue;
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      const cur = process.env[key];
      const missingOrBlank =
        cur === undefined || String(cur).trim() === "";
      if (missingOrBlank) process.env[key] = val;
    }
  }
}
