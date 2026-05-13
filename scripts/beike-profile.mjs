import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

export function defaultProfileDir() {
  return path.join(root, "data", "beike-chromium-profile");
}

/** Chromium 用户目录是否已初始化（登录脚本跑过后会有 Local State） */
export function isProfileSeeded(profileDir) {
  return fs.existsSync(path.join(profileDir, "Local State"));
}
