/** 贝壳南京成交页：区列表 URL + HTML 解析（与 Playwright / 裸 HTTP 共用） */

export const DISTRICT_URLS = [
  "https://nj.ke.com/chengjiao/xuanwu/",
  "https://nj.ke.com/chengjiao/qinhuai/",
  "https://nj.ke.com/chengjiao/jianye/",
  "https://nj.ke.com/chengjiao/gulou/",
  "https://nj.ke.com/chengjiao/yuhuatai/",
];

/**
 * 本次要抓的区 URL（环境变量可覆盖）。
 * - BEIKE_DISTRICT_URLS：逗号分隔，可为完整 URL 或区 slug（如 xuanwu,qinhuai）
 * - BEIKE_ONLY_FIRST_DISTRICT=1：只抓列表中的第一个区（CDP 下建议先只抓一个，减少极验次数）
 */
export function getFetchDistrictUrls() {
  const onlyFirst =
    process.env.BEIKE_ONLY_FIRST_DISTRICT === "1" ||
    process.env.BEIKE_ONLY_FIRST_DISTRICT === "true";
  const raw = process.env.BEIKE_DISTRICT_URLS?.trim();
  let urls = DISTRICT_URLS;
  if (raw) {
    urls = raw
      .split(/[,;\s，]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((u) => {
        if (/^https?:\/\//i.test(u)) return u;
        const slug = u.replace(/^\/+|\/+$/g, "");
        return `https://nj.ke.com/chengjiao/${slug}/`;
      });
  }
  if (onlyFirst) urls = urls.slice(0, 1);
  return urls;
}

export function todayShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function isCaptcha(html) {
  const h = html || "";
  /** 正常成交列表页会带 listContent；有此结构则不再因脚本 URL 里的 captcha 误判 */
  if (/<ul[^>]*class="[^"]*listContent/i.test(h) || /\blistContent\b/i.test(h)) {
    return false;
  }
  return (
    /<title>\s*CAPTCHA/i.test(h) ||
    /极验封禁/.test(h) ||
    (/人机验证/.test(h) && /(hip-static|captcha-anti-spider|validate\.js)/i.test(h)) ||
    /验证失败/.test(h)
  );
}

/** @param {string} href @param {string} base */
export function absoluteBeikeHref(href, base) {
  const h = (href || "").trim();
  if (!h) return "";
  try {
    if (h.startsWith("//")) return new URL(`https:${h}`).href;
    return new URL(h, base).href;
  } catch {
    return "";
  }
}

export function stripHtmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(div|p|li|span|h\d)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 列表页「挂牌」与数字常被拆到不同 span，innerText 拼不出正则；从 deal/msg/整条 li 的 HTML 补抓。
 * @param {string} dealHtml
 * @param {string} msgHtml
 * @param {string} [liHtml]
 * @returns {string} 如 "316万"，无则 ""
 */
export function extractListPriceFromListItemFragmentHtml(dealHtml, msgHtml, liHtml) {
  const h = `${dealHtml || ""} ${msgHtml || ""} ${liHtml || ""}`.replace(/\s+/g, " ");
  if (!h.trim()) return "";
  const patterns = [
    /<span[^>]*>\s*挂牌\s*<\/span>\s*<span[^>]*>([0-9]+(?:\.[0-9]+)?)<\/span>\s*<span[^>]*>\s*万/si,
    /挂牌\s*<\/[^>]+>\s*<[^>]+>\s*([0-9]+(?:\.[0-9]+)?)\s*<\/[^>]+>\s*<[^>]+>\s*万/si,
    /([0-9]+(?:\.[0-9]+)?)\s*<\/[^>]+>\s*<[^>]+>\s*挂牌价格[（(]万/si,
    /挂牌价格[（(]万[）)]\s*<\/[^>]+>\s*<[^>]+>\s*([0-9]+(?:\.[0-9]+)?)/si,
    /挂牌(?:价|格|价格)?[^0-9]{0,12}([0-9]+(?:\.[0-9]+)?)\s*万/si,
  ];
  for (const re of patterns) {
    const m = h.match(re);
    if (m) {
      const n = m[1];
      return /万$/.test(n) ? n : `${n}万`;
    }
  }
  const plain = stripHtmlToPlainText(h);
  return extractBeikeMetricsFromText(plain).listPrice;
}

function tryNextDataListPriceWan(html) {
  const m = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) return "";
  try {
    const s = JSON.stringify(JSON.parse(m[1]));
    const hits = [
      /"(?:listPrice|listingPrice|list_price|signPrice|startPrice|priceListing|displayListPrice|transListPrice|showPrice)"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
    ];
    for (const re of hits) {
      const x = s.match(re);
      if (x) {
        const v = x[1];
        const num = Number(v);
        if (num > 0 && num < 50000) return `${v}万`;
      }
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * 挂牌价常只在 script / __NEXT_DATA__ 的 JSON 里；对整段 HTML 做补充匹配（不依赖 stripHtml）。
 * @param {string} html
 * @returns {string} 如 "113万"，无则 ""
 */
export function extractListPriceWanFromDetailHtmlRaw(html) {
  if (!html) return "";
  const flat = html.replace(/\s+/g, " ");
  const loose = [
    /"(?:listPrice|listingPrice|list_price|signPrice|startPrice|displayListPrice|priceListing)"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/gi,
    /挂牌(?:展示)?价格[（(]万[）)]\s*[:：=]\s*['"]?([0-9]+(?:\.[0-9]+)?)/i,
    /"listingTotalPrice"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?/i,
  ];
  for (const re of loose) {
    const x = flat.match(re);
    if (x) {
      const v = x[1];
      const num = Number(v);
      if (num > 0 && num < 50000) return `${v}万`;
    }
  }
  return "";
}

/**
 * 从成交详情页 HTML 抽挂牌总价（万）；列表未展示时用。
 * @param {string} html
 */
export function extractBeikeListPriceFromDetailHtml(html) {
  const panel = extractBeikeDealPanelFromDetailHtml(html);
  if (panel?.listPriceWan) return panel.listPriceWan;
  return extractListPriceWanFromDetailHtmlRaw(html);
}

/**
 * 成交详情页「数据块」：挂牌价格（万）、成交周期（天）、调价/带看/关注/浏览及户型/建面/年限。
 * @param {string} html
 * @returns {{
 *   listPriceWan: string,
 *   cycleDays: string,
 *   adjustCount: string,
 *   kanCount: string,
 *   followCount: string,
 *   viewCount: string,
 *   houseLayout: string,
 *   buildingArea: string,
 *   houseYears: string
 * } | null}
 */
export function extractBeikeDealPanelFromDetailHtml(html) {
  if (!html || html.length < 40) return null;
  const text = stripHtmlToPlainText(html.split(/<\/head>/i)[1] || html).replace(/\s+/g, " ");
  const raw = html.replace(/\s+/g, " ");

  /** 详情页多为「数字 + 标签」；先试数字在前的匹配，避免「挂牌价格（万）」后紧跟下一项的周期天数被误吸。 */
  const pick = (labelRe) => {
    const before = new RegExp(
      `([0-9]+(?:\\.[0-9]+)?)[^0-9]{0,12}${labelRe.source}`,
      labelRe.flags
    );
    const after = new RegExp(
      `${labelRe.source}[^0-9]{0,12}([0-9]+(?:\\.[0-9]+)?)`,
      labelRe.flags
    );
    let m = text.match(before);
    if (m) return m[1];
    m = text.match(after);
    return m ? m[1] : "";
  };

  let listWan =
    pick(/挂牌价格[（(]万[）)]/i) ||
    pick(/挂牌价[（(]万[）)]/i) ||
    "";
  if (!listWan) {
    const fm = extractBeikeMetricsFromText(text).listPrice;
    if (fm) listWan = fm.includes("万") ? fm.replace(/万$/, "") : fm;
  }
  if (!listWan) {
    const fromNext = tryNextDataListPriceWan(html);
    if (fromNext) listWan = fromNext.replace(/万$/, "");
  }
  if (!listWan) {
    const rawLp = extractListPriceWanFromDetailHtmlRaw(html);
    if (rawLp) listWan = rawLp.replace(/万$/, "");
  }
  if (listWan && !/万$/.test(listWan)) listWan = `${listWan}万`;

  const cycleDays =
    pick(/成交周期[（(]天[）)]/i) ||
    (text.match(/成交周期[^0-9]*([0-9]+)\s*天/) || [])[1] ||
    "";

  const adjustCount =
    pick(/调价[（(]次[）)]/i) ||
    (text.match(/调价[^0-9]*([0-9]+)\s*次/) || [])[1] ||
    "";

  const kanCount = pick(/带看[（(]次[）)]/i) || "";
  const followCount = pick(/关注[（(]人[）)]/i) || "";
  const viewCount = pick(/浏览[（(]次[）)]/i) || "";

  const hb = extractHouseBasicsFromText(text);
  const areaPick =
    pick(/建筑面积[（(]㎡[）)]/i) ||
    pick(/建筑面积[（(]平方米[）)]/i) ||
    pick(/建筑面积[（(]平米[）)]/i) ||
    "";
  let buildingArea = hb.buildingArea;
  if (areaPick) buildingArea = `${areaPick}㎡`;

  const layoutM =
    text.match(/房屋户型[（(][^）]*[）)]\s*[：:]?\s*(\d+室\d+厅(?:\d+卫)?)/i) ||
    text.match(/户型[：:\s]+(\d+室\d+厅(?:\d+卫)?)/);
  const houseLayout = (layoutM && layoutM[1]) || hb.houseLayout;

  const yearsLabel = (
    text.match(/房屋年限[（(][^）]*[）)]\s*[：:]?\s*([^|·。；]{1,16}?)(?=\s*[|·。；]|$)/i) || []
  )[1]?.trim();
  const houseYears = yearsLabel || hb.houseYears;

  /** 从 HTML 结构再试（数字与标签被拆开时） */
  const looseNum = (re) => {
    const m = raw.match(re);
    return m ? m[1] : "";
  };
  let listPriceWan = listWan;
  if (!listPriceWan) {
    const v = looseNum(/挂牌价格[（(]万[）)][^0-9]{0,40}>([0-9]+(?:\.[0-9]+)?)</i);
    if (v) listPriceWan = `${v}万`;
  }

  const panel = {
    listPriceWan,
    cycleDays: cycleDays || looseNum(/成交周期[（(]天[）)][^<]{0,40}>([0-9]+)</i),
    adjustCount: adjustCount || looseNum(/调价[（(]次[）)][^<]{0,40}>([0-9]+)</i),
    kanCount: kanCount || looseNum(/带看[（(]次[）)][^<]{0,40}>([0-9]+)/i),
    followCount: followCount || looseNum(/关注[（(]人[）)][^<]{0,40}>([0-9]+)/i),
    viewCount: viewCount || looseNum(/浏览[（(]次[）)][^<]{0,40}>([0-9]+)/i),
    houseLayout,
    buildingArea,
    houseYears,
  };

  if (
    !panel.listPriceWan &&
    !panel.cycleDays &&
    !panel.adjustCount &&
    !panel.kanCount &&
    !panel.followCount &&
    !panel.viewCount &&
    !panel.houseLayout &&
    !panel.buildingArea &&
    !panel.houseYears
  ) {
    return null;
  }
  return panel;
}

/**
 * 将详情页数据块格式化为一条展示串（可与列表摘要后缀拼接）。
 * @param {NonNullable<ReturnType<typeof extractBeikeDealPanelFromDetailHtml>>} panel
 */
export function formatBeikeDealPanelLine(panel) {
  const bits = [];
  if (panel.listPriceWan) bits.push(`挂牌价 ${panel.listPriceWan}`);
  if (panel.cycleDays) bits.push(`成交周期 ${panel.cycleDays}天`);
  if (panel.adjustCount) bits.push(`调价 ${panel.adjustCount}次`);
  if (panel.kanCount) bits.push(`带看 ${panel.kanCount}次`);
  if (panel.followCount) bits.push(`关注 ${panel.followCount}人`);
  if (panel.viewCount) bits.push(`浏览 ${panel.viewCount}次`);
  if (panel.houseLayout) bits.push(`户型 ${panel.houseLayout}`);
  if (panel.buildingArea) bits.push(`建面 ${panel.buildingArea}`);
  if (panel.houseYears) bits.push(`年限 ${panel.houseYears}`);
  return bits.join(" · ");
}

/**
 * 详情指标与列表页解析字段合并（详情优先覆盖挂牌/周期/调价及户型等）。
 * @param {ReturnType<typeof extractBeikeDealPanelFromDetailHtml>} panel
 * @param {ReturnType<typeof extractBeikeMetricsFromText>} listFields
 */
export function mergeDealPanelWithListMetrics(panel, listFields) {
  const lf = listFields || {};
  const p = panel || {};
  const listPrice =
    p.listPriceWan ||
    (lf.listPrice && /万$/.test(lf.listPrice) ? lf.listPrice : lf.listPrice ? `${lf.listPrice}万` : "");
  const cycle = p.cycleDays || lf.cycle || "";
  const reduce = p.adjustCount || lf.reduce || "";
  return {
    ...lf,
    listPrice: listPrice ? (listPrice.endsWith("万") ? listPrice : `${listPrice}万`) : lf.listPrice,
    cycle,
    reduce,
    kanCount: p.kanCount || "",
    followCount: p.followCount || "",
    viewCount: p.viewCount || "",
    houseLayout: p.houseLayout || lf.houseLayout || "",
    buildingArea: p.buildingArea || lf.buildingArea || "",
    houseYears: p.houseYears || lf.houseYears || "",
  };
}

/**
 * 在已登录/同源的浏览器上下文中拉取详情页 HTML（避免整页 goto 触发极验）。
 * @param {import('playwright').Page} page
 * @param {string} url
 */
export async function fetchBeikePageHtmlViaBrowser(page, url) {
  return page.evaluate(async (u) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 14000);
    try {
      const r = await fetch(u, {
        credentials: "include",
        signal: ctrl.signal,
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      clearTimeout(tid);
      if (!r.ok) return "";
      return await r.text();
    } catch {
      clearTimeout(tid);
      return "";
    }
  }, url);
}

/**
 * 同源 fetch 成交详情页，合并挂牌/周期/调价/带看/关注/浏览及户型/建面/年限。
 * @param {import('playwright').Page} page
 * @param {Array<{ title?: string, price?: string, link?: string }>} rows
 * @param {{ enrichFromDetail?: boolean, detailDelayMs?: number, skipIfComplete?: boolean }} [opts]
 */
export async function enrichSecondHandRowsListPriceFromDetails(page, rows, opts = {}) {
  const on = opts.enrichFromDetail !== false;
  if (!on || !page || !Array.isArray(rows) || !rows.length) return rows;
  const delayMs = Number(opts.detailDelayMs ?? 280) || 280;
  const skipIfComplete = opts.skipIfComplete !== false;
  const out = [];
  for (const row of rows) {
    if (!row.link) {
      out.push(row);
      continue;
    }
    const link = String(row.link).trim();
    if (!/^https?:\/\//i.test(link) || !/chengjiao\/\d+\.html/i.test(link)) {
      out.push(row);
      continue;
    }

    const priceStr = String(row.price || "");
    const looksComplete =
      priceStr.includes("挂牌价") &&
      priceStr.includes("带看") &&
      priceStr.includes("关注") &&
      priceStr.includes("浏览") &&
      priceStr.includes("户型") &&
      (priceStr.includes("建面") || priceStr.includes("㎡"));
    if (skipIfComplete && looksComplete) {
      out.push(row);
      continue;
    }

    await new Promise((r) => setTimeout(r, delayMs));
    const html = await fetchBeikePageHtmlViaBrowser(page, link);
    const panel = extractBeikeDealPanelFromDetailHtml(html);
    if (panel) {
      const listFields = extractBeikeMetricsFromText(priceStr.replace(/·/g, " "));
      const merged = mergeDealPanelWithListMetrics(panel, listFields);
      out.push({
        ...row,
        price: formatBeikeSecondHandPriceLine(merged),
      });
      continue;
    }

    if (!priceStr.includes("挂牌价")) {
      const lp = extractBeikeListPriceFromDetailHtml(html);
      if (lp) {
        const wan = /万$/.test(lp) ? lp : `${lp}万`;
        out.push({ ...row, price: `挂牌价 ${wan} · ${row.price}` });
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * 房屋户型、建筑面积、年限（满五/满二等或建成年代），列表/详情纯文本共用。
 * @param {string} raw
 * @returns {{ houseLayout: string, buildingArea: string, houseYears: string }}
 */
export function extractHouseBasicsFromText(raw) {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  let houseLayout =
    (text.match(/(\d+室\d+厅(?:\d+卫)?)/) || [])[1] ||
    (text.match(/(\d+居\d+厅)/) || [])[1] ||
    "";

  let areaNum =
    (text.match(/建筑(?:面积)?[：:\s]*([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|平方米|平米)/) || [])[1] ||
    (text.match(/建面[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)\s*(?:㎡|平方米|平米)?/) || [])[1] ||
    (text.match(/([0-9]+(?:\.[0-9]+)?)\s*平方米/) || [])[1] ||
    (text.match(/([0-9]+(?:\.[0-9]+)?)\s*平米/) || [])[1] ||
    (text.match(/([0-9]+(?:\.[0-9]+)?)\s*㎡/) || [])[1] ||
    "";
  const buildingArea = areaNum ? `${areaNum}㎡` : "";

  let houseYears =
    (text.match(
      /满五唯一|满五|满二|不满二|满两年|未满两年|两年内|两年以上|五年以上/
    ) || [])[0] ||
    "";
  if (!houseYears) {
    const m = text.match(
      /(?:房屋年限|交易年限|年限|房本)[（(][^）]*[）)]?\s*[：:\s]*([^|·。；]{1,14}?)(?=\s*[|·。；]|$)/
    );
    if (m) houseYears = m[1].replace(/\s+/g, " ").trim();
  }
  if (!houseYears) {
    const y = text.match(/(?:建成年代|建筑年代|竣工年代)[：:\s]*(\d{4})\s*年?/);
    if (y) houseYears = `${y[1]}年建成`;
  }
  return { houseLayout, buildingArea, houseYears: (houseYears || "").trim() };
}

/**
 * 从列表项纯文本里抽挂牌价、成交周期、调价及户型/建面/年限。
 * @param {string} raw
 * @returns {{ listPrice: string, cycle: string, reduce: string, houseLayout: string, buildingArea: string, houseYears: string }}
 */
export function extractBeikeMetricsFromText(raw) {
  const t = (raw || "").replace(/\s+/g, " ").trim();
  let listPrice = "";

  const listPatterns = [
    /** 挂牌价 320 万 / 挂牌 320万 / 挂牌320万（无空格） */
    /挂牌(?:价|价格|总价)?\s*[：:]?\s*([0-9]+(?:\.[0-9]+)?)\s*万/,
    /** 316挂牌价格（万） 或 316 挂牌价格（万）；半角括号版 */
    /([0-9]+(?:\.[0-9]+)?)\s*挂牌价格[（(]万[）)]/,
    /** 挂牌价格（万） 后接数字的变体 */
    /挂牌价格[（(]万[）)]\s*[：:]?\s*([0-9]+(?:\.[0-9]+)?)/,
    /** 历史挂牌、原挂牌等 */
    /(?:历史|原)?挂牌\s*[：:]?\s*([0-9]+(?:\.[0-9]+)?)\s*万/,
    /** 参考挂牌、初始挂牌等 */
    /(?:参考|初始|首次)?挂牌[^0-9]{0,6}([0-9]+(?:\.[0-9]+)?)\s*万/,
  ];
  for (const re of listPatterns) {
    const m = t.match(re);
    if (m) {
      listPrice = m[1];
      break;
    }
  }
  if (listPrice && !/万$/.test(listPrice)) listPrice = `${listPrice}万`;

  const cycle =
    (t.match(/([0-9]+)\s*成交周期[（(]天[）)]/) || [])[1] ||
    (t.match(/成交周期[（(]天[）)][^0-9]*([0-9]+)/) || [])[1] ||
    (t.match(/成交周期[^0-9]*([0-9]+)\s*天/) || [])[1] ||
    "";
  let reduce =
    (t.match(/([0-9]+)\s*调价[（(]次[）)]/) || [])[1] ||
    (t.match(/调价[（(]次[）)][^0-9]*([0-9]+)/) || [])[1] ||
    (t.match(/调价[^0-9]*([0-9]+)\s*次/) || [])[1] ||
    (t.match(/([0-9]+)\s*次\s*调价/) || [])[1] ||
    (t.match(/降价[^0-9]*([0-9]+)\s*次/) || [])[1] ||
    "";

  const { houseLayout, buildingArea, houseYears } = extractHouseBasicsFromText(t);

  return { listPrice, cycle, reduce, houseLayout, buildingArea, houseYears };
}

/**
 * @param {ReturnType<typeof extractBeikeMetricsFromText> & { kanCount?: string, followCount?: string, viewCount?: string }} f
 */
export function formatBeikeSecondHandPriceLine(f) {
  const bits = [];
  if (f.listPrice) bits.push(`挂牌价 ${f.listPrice}`);
  if (f.cycle) bits.push(`成交周期 ${f.cycle}天`);
  if (f.reduce) bits.push(`调价 ${f.reduce}次`);
  if (f.kanCount) bits.push(`带看 ${f.kanCount}次`);
  if (f.followCount) bits.push(`关注 ${f.followCount}人`);
  if (f.viewCount) bits.push(`浏览 ${f.viewCount}次`);
  if (f.houseLayout) bits.push(`户型 ${f.houseLayout}`);
  if (f.buildingArea) bits.push(`建面 ${f.buildingArea}`);
  if (f.houseYears) bits.push(`年限 ${f.houseYears}`);
  return bits.join(" · ");
}

/** 从列表项 HTML 中取首条成交详情链接（失败则空串）。 */
export function pickDetailHrefFromLiHtml(block, pageUrl) {
  const titleA = block.match(
    /<div[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>[\s\S]*?<a[^>]+href\s*=\s*["']([^"']+)["']/i
  );
  const anyCj = block.match(
    /<a[^>]+href\s*=\s*["']([^"']*\/chengjiao\/[^"']+)["']/i
  );
  const href = (titleA && titleA[1]) || (anyCj && anyCj[1]) || "";
  return absoluteBeikeHref(href, pageUrl);
}

function cardFromPlainText(txt, pageUrl, detailHref, frag) {
  const t = (txt || "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  let title = (t.match(/([^\s]+小区)/) || [])[1] || "";
  if (!title) {
    const pipe = t.split(/\s*\|\s*/)[0]?.trim() || "";
    if (pipe && !/^(挂牌|成交|调价)/.test(pipe)) title = pipe.split(/\s+/)[0] || "";
  }
  let fields = extractBeikeMetricsFromText(t);
  const lpFrag = extractListPriceFromListItemFragmentHtml(
    frag?.dealHtml,
    frag?.msgHtml,
    frag?.liHtml
  );
  if (lpFrag && !fields.listPrice) {
    fields = { ...fields, listPrice: /万$/.test(lpFrag) ? lpFrag : `${lpFrag}万` };
  }

  if (!title && !fields.listPrice && !fields.cycle && !fields.reduce) return null;
  const link = detailHref ? detailHref : pageUrl;
  return {
    title: title || "贝壳成交页条目",
    price: formatBeikeSecondHandPriceLine(fields),
    link,
  };
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @param {number} maxItems
 */
export function parseCards(html, pageUrl, maxItems) {
  const cards = [];
  const ulMatch = html.match(
    /<ul[^>]*class\s*=\s*["'][^"']*listContent[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i
  );
  const chunk = ulMatch ? ulMatch[1] : html;
  /** 列表项 class 已不再固定含 clear，改为在 listContent 内匹配顶层 li */
  const liRe = /<li\b[^>]*>[\s\S]*?<\/li>/gi;
  let m;
  while ((m = liRe.exec(chunk)) !== null) {
    const block = m[0];
    const txt = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const detail = pickDetailHrefFromLiHtml(block, pageUrl);
    const row = cardFromPlainText(txt, pageUrl, detail, {
      dealHtml: block,
      msgHtml: "",
      liHtml: block,
    });
    if (!row) continue;
    cards.push(row);
    if (cards.length >= maxItems) break;
  }
  return cards;
}

/**
 * 当服务端 HTML 与正则不一致时，用页面真实 DOM 解析（Playwright 传入的 page）。
 * @param {import('playwright').Page} page
 * @param {string} pageUrl
 * @param {number} maxItems
 */
export async function parseCardsFromPage(page, pageUrl, maxItems) {
  const rawItems = await page.evaluate((n) => {
    const pickLis = () => {
      const ul = document.querySelector("ul.listContent");
      if (ul) return Array.from(ul.querySelectorAll(":scope > li"));
      return Array.from(document.querySelectorAll(".content__list--item"));
    };
    const textOne = (el, sel) => {
      const x = el.querySelector(sel);
      return (x && x.textContent ? x.textContent : "").replace(/\s+/g, " ").trim();
    };
    const parts = [];
    for (const li of pickLis()) {
      if (parts.length >= n) break;
      let title =
        textOne(li, ".title a") ||
        textOne(li, "a.title") ||
        textOne(li, ".title") ||
        "";
      const txt = (li.innerText || "").replace(/\s+/g, " ").trim();
      const deal = textOne(li, ".dealCycleTxt") || textOne(li, "[class*='dealCycle']");
      const msg = textOne(li, ".msg");
      const houseInfo = textOne(li, ".houseInfo");
      const pos = textOne(li, ".positionInfo");
      const flood = textOne(li, ".dealHouseTxt") || textOne(li, ".flood");
      const tagBits = Array.from(
        li.querySelectorAll(
          ".tag span, .houseTags span, .houseListTag span, .saleTxt span, [class*='goodSchool'], [class*='Tag'] span"
        )
      )
        .map((e) => (e.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ");
      const blob = [txt, deal, msg, houseInfo, pos, flood, tagBits].filter(Boolean).join(" | ");
      const a = li.querySelector(".title a") || li.querySelector("a.img");
      const href = a && a.href ? String(a.href) : "";
      const dealEl =
        li.querySelector(".dealCycleTxt") || li.querySelector("[class*='dealCycle']");
      const msgEl = li.querySelector(".msg");
      const dealHtml = dealEl ? dealEl.innerHTML : "";
      const msgHtml = msgEl ? msgEl.innerHTML : "";
      const liHtml = li.innerHTML || "";
      parts.push({ title, blob, href, dealHtml, msgHtml, liHtml });
    }
    return parts;
  }, maxItems);

  const cards = [];
  for (const it of rawItems) {
    let title = (it.title || "").trim();
    const t = (it.blob || "").replace(/\s+/g, " ").trim();
    if (!title) {
      title = (t.match(/([^\s]+小区)/) || [])[1] || "";
    }
    if (!title) {
      const pipe = t.split(/\s*\|\s*/)[0]?.trim() || "";
      if (pipe && !/^(挂牌|成交|调价)/.test(pipe)) {
        title = pipe.split(/\s+/)[0] || "";
      }
    }
    let fields = extractBeikeMetricsFromText(t);
    const lpFrag = extractListPriceFromListItemFragmentHtml(
      it.dealHtml,
      it.msgHtml,
      it.liHtml
    );
    if (lpFrag && !fields.listPrice) {
      fields = { ...fields, listPrice: /万$/.test(lpFrag) ? lpFrag : `${lpFrag}万` };
    }
    if (!title && !fields.listPrice && !fields.cycle && !fields.reduce) continue;
    const href = (it.href || "").trim();
    const link = /^https?:\/\//i.test(href) ? href : pageUrl;

    cards.push({
      title: title || "贝壳成交页条目",
      price: formatBeikeSecondHandPriceLine(fields),
      link,
    });
  }
  return cards;
}
