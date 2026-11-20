// 基础数据补充（缺结算价）核心逻辑 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 背景：账单状态为「待确认」= 账单明细里有 SKU 没有结算价（cost），要先把结算价补进 FMS「基础数据」，
// 再重新生成账单。结算价来自 EH（Engage Hub）的 Pricing 页面。
//
// 这里是纯函数部分（不依赖 DOM / chrome.*，可在 Node 里测试）：
//   1. planMissing：把缺价明细行按「站点+店铺+MM SKU」去重，按店铺映射到 EH 的 Channel，
//      并整理出每个 Channel 需要去 EH 搜的 MM SKU（EH 搜一个 SKU 会返回它所在商品下的全部 SKU，
//      所以已经被前面的搜索覆盖到的 SKU 不用重复搜，由 EH 那端的脚本负责跳过）。
//   2. resolve：把 EH 查到的结果和缺价清单对上，得到可直接写进模板的行，以及对不上的（不瞎填）。
//   3. toWorkbook：按 FMS「第三方基础配置导入」模板的格式生成 xlsx。

const FMSBaseData = (() => {
  // FMS 店铺 -> EH Channel。shoedazzle 等不在这里的店铺不处理（会进未处理清单）。
  const SHOP_TO_CHANNEL = { justfab: "justfab-us", justfabeu: "justfab-eu" };

  // FMS 模板（「下载模板」拿到的文件）：sheet 名「数据页」，第一行是这 12 个表头，冻结首行，列宽 19.5
  const SHEET_NAME = "数据页";
  const HEADERS = ["站点", "店铺", "品牌", "MM SKU", "Brand SKU", "MM Style", "MM Color", "MM Size", "结算币种", "结算单价", "数据状态", "备注"];

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  // FMS 品牌名 → EH 里对应的商户名（精确匹配）。没列在这里的品牌，按「EH 商户名包含品牌名」处理
  // （如 TIJN 会匹配 TIJN-consignment 和 TIJN-drop ship，Pretty Garden 会匹配 Pretty Garden US）
  const EH_MERCHANTS = {
    attraco: ["Attraco-Drop Ship", "Attraco"],
    vforcity: ["Attraco-Drop Ship", "Attraco"],
    attracob: ["Attraco-Drop Ship", "Attraco"],
    charmo: ["Attraco-Drop Ship", "Attraco"],
    ecosusi: ["BAGSMART"],
  };

  /** 返回 EH 商户名的精确列表；没有特殊对应时返回 []（调用方按名字包含品牌名处理） */
  function ehMerchantsOf(brand) {
    return (EH_MERCHANTS[norm(brand)] || []).slice();
  }

  function channelOf(shop) {
    return SHOP_TO_CHANNEL[norm(shop)] || "";
  }

  /**
   * rows：FMS 账单明细里「结算金额为空」的行（含 sku/style/color/size/shopCode/siteCode/brandName/currency）。
   * 返回 { items, jobs, unmapped }。
   */
  function planMissing(rows) {
    const seen = new Map();
    for (const r of rows) {
      const key = [r.siteCode, r.shopCode, r.sku].join("|");
      if (!seen.has(key)) {
        seen.set(key, {
          site: r.siteCode,
          shop: r.shopCode,
          brand: r.brandName,
          sku: r.sku,
          style: r.style,
          color: r.color,
          size: r.size,
          currency: r.currency,
          channel: channelOf(r.shopCode),
        });
      }
    }
    const items = [...seen.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.site.localeCompare(b.site));
    const unmapped = items.filter((i) => !i.channel);
    const byChannel = new Map();
    for (const it of items) {
      if (!it.channel) continue;
      if (!byChannel.has(it.channel)) byChannel.set(it.channel, new Set());
      byChannel.get(it.channel).add(it.sku);
    }
    const jobs = [...byChannel].map(([channel, skus]) => ({ channel, skus: [...skus] }));
    return { items, jobs, unmapped };
  }

  /**
   * eh：{ [channel]: { skus: { [mmSku]: { seller, cost, currency } }, notFound: [mmSku], error? } }
   * 返回 { rows, unresolved }：rows 是模板行（按模板列顺序的对象），unresolved 是没能填上的（带原因）。
   */
  function resolve(items, eh) {
    const rows = [];
    const unresolved = [];
    for (const it of items) {
      if (!it.channel) {
        unresolved.push({ item: it, reason: `店铺「${it.shop}」没有对应的 EH Channel，需人工处理` });
        continue;
      }
      const res = eh && eh[it.channel];
      if (!res) {
        unresolved.push({ item: it, reason: "没有查询到 EH 结果" });
        continue;
      }
      if (res.error) {
        unresolved.push({ item: it, reason: `EH 查询失败：${res.error}` });
        continue;
      }
      const sku = res.skus && res.skus[it.sku];
      if (!sku) {
        unresolved.push({ item: it, reason: `EH（${it.channel}）里搜不到这个 MM SKU` });
        continue;
      }
      const cost = Number(sku.cost);
      if (!isFinite(cost) || cost <= 0) {
        unresolved.push({ item: it, reason: "EH 里这个 SKU 还没有成本（cost 为空或 0）" });
        continue;
      }
      if (sku.currency && it.currency && String(sku.currency).toUpperCase() !== String(it.currency).toUpperCase()) {
        unresolved.push({ item: it, reason: `EH 成本币种(${sku.currency})与账单结算币种(${it.currency})不一致，需人工确认` });
        continue;
      }
      rows.push({
        站点: it.site,
        店铺: it.shop,
        品牌: it.brand,
        "MM SKU": it.sku,
        "Brand SKU": sku.seller,
        "MM Style": it.style,
        "MM Color": it.color,
        "MM Size": it.size,
        结算币种: it.currency,
        结算单价: cost,
        数据状态: "",
        备注: "",
      });
    }
    return { rows, unresolved };
  }

  /** 按 FMS 模板格式生成 workbook（ExcelJS 由调用方传入，方便在浏览器和 Node 里都能用） */
  function toWorkbook(ExcelJS, rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(SHEET_NAME, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = HEADERS.map((h) => ({ header: h, key: h, width: 19.5 }));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) ws.addRow(HEADERS.map((h) => r[h]));
    ws.getColumn(10).numFmt = "0.00";
    return wb;
  }

  function fileName(billNo, now) {
    const d = now || new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `基础数据_${billNo}_${ymd}.xlsx`;
  }

  /**
   * 导入前的确定性检查（不靠 AI）：对 resolve 出来的模板行找「看着不对劲」的地方，返回警告列表。
   * 有警告不代表一定错，但自动流程遇到任何警告都要停下来问人，不直接导入。
   *  - 同一个 Style 下各行结算单价差别超过 3 倍（可能串了款或单位不对）
   *  - 缺 Brand SKU
   *  - 同一个 站点+店铺+MM SKU 出现多行（重复）
   */
  function checkRows(rows) {
    const warnings = [];
    const byStyle = new Map();
    const seen = new Set();
    for (const r of rows) {
      const k = [r["站点"], r["店铺"], r["MM SKU"]].join("|");
      if (seen.has(k)) warnings.push("重复行：" + k);
      seen.add(k);
      if (!r["Brand SKU"]) warnings.push("缺 Brand SKU：" + r["MM SKU"]);
      const sk = [r["品牌"], r["MM Style"]].join("|");
      if (!byStyle.has(sk)) byStyle.set(sk, []);
      byStyle.get(sk).push(Number(r["结算单价"]));
    }
    for (const [sk, prices] of byStyle) {
      const lo = Math.min(...prices);
      const hi = Math.max(...prices);
      if (lo > 0 && hi / lo > 3) warnings.push("同款价差过大（" + sk + "：" + lo + " ~ " + hi + "）");
    }
    return { ok: warnings.length === 0, warnings };
  }

  /**
   * 全量匹配用：FMS「基础数据」里缺价的行（字段是基础数据接口的）→ planMissing 能吃的格式，
   * 并统计「没有对应 EH Channel 的店铺」有多少行（这些不处理，单独告诉用户）。
   * 返回 { plan, skippedShops: { 店铺: 行数 } }。
   */
  function planFromFmsRows(missingRows) {
    const rows = missingRows.map((r) => ({
      siteCode: r.siteCode,
      shopCode: r.shopCode,
      brandName: r.brandName,
      sku: r.sku,
      style: r.style,
      color: r.color,
      size: r.size,
      currency: r.currency,
    }));
    const plan = planMissing(rows);
    const skippedShops = {};
    for (const it of plan.unmapped) skippedShops[it.shop] = (skippedShops[it.shop] || 0) + 1;
    return { plan, skippedShops };
  }

  function matchFileName(brand, now) {
    const d = now || new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `基础数据_${String(brand).replace(/[\\/:*?"<>|]/g, "_")}_全量匹配_${ymd}.xlsx`;
  }

  /** 解析 CSV 文本（支持引号、转义引号、引号内换行、BOM） */
  function parseCsv(text) {
    const s = String(text || "").replace(/^﻿/, "");
    const rows = [];
    let row = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === '"') {
          if (s[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && s[i + 1] === "\n") i++;
        row.push(cur); cur = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  /**
   * 解析 EH「Pricing」导出的 CSV，成本优先取 Cost(Active)，没有再取 Base Cost(Active)。
   * 返回 { skus: { [mm_sku]: { seller, cost, currency, source } }, count, noCost }
   */
  function parseEhPricingCsv(text) {
    const rows = parseCsv(text);
    const skus = {};
    if (!rows.length) return { skus, count: 0, noCost: 0 };
    const head = rows[0].map((h) => String(h).trim());
    const idx = (name) => head.indexOf(name);
    const iMm = idx("MM SKU");
    const iSeller = idx("Seller SKU");
    const pairs = [
      [idx("Cost(Active)"), idx("Cost Currency(Active)"), "Cost(Active)"],
      [idx("Base Cost(Active)"), idx("Base Cost Currency(Active)"), "Base Cost(Active)"],
    ].filter((p) => p[0] >= 0);
    if (iMm < 0 || !pairs.length) throw new Error("EH 导出文件缺少 MM SKU / Cost 列，请确认导出的是 Pricing 页面");
    let noCost = 0;
    for (const r of rows.slice(1)) {
      const mm = String(r[iMm] || "").trim();
      if (!mm) continue;
      let cost = "";
      let currency = "";
      let source = "";
      for (const [ci, cu, name] of pairs) {
        const v = String(r[ci] == null ? "" : r[ci]).trim();
        if (v !== "") { cost = v; currency = String(r[cu] || "").trim(); source = name; break; }
      }
      const prev = skus[mm];
      if (prev && prev.cost !== "") continue; // 多个 Market 行：已有成本的不被覆盖
      skus[mm] = { seller: iSeller >= 0 ? String(r[iSeller] || "").trim() : "", cost, currency, source };
    }
    for (const k of Object.keys(skus)) if (skus[k].cost === "") noCost++;
    return { skus, count: Object.keys(skus).length, noCost };
  }

  return { SHOP_TO_CHANNEL, SHEET_NAME, HEADERS, channelOf, ehMerchantsOf, planMissing, planFromFmsRows, resolve, checkRows, toWorkbook, fileName, matchFileName, parseCsv, parseEhPricingCsv };
})();

if (typeof module !== "undefined") module.exports = FMSBaseData;
