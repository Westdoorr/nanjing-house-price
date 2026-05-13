/**
 * 降低被极验/风控识别为「无头自动化」的概率（无法保证一定通过）。
 */

export const STEALTH_CHROME_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-default-browser-check",
  "--disable-infobars",
];

/** @param {import('playwright').BrowserContext} context */
export async function applyStealthInitScripts(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
  });
}
