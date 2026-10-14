// FMS账单清洗核心逻辑 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
// 纯函数风格：输入原始行数组，输出处理后的数据。
// 规则会随对话逐步补充，每条规则单独一个函数，方便以后调整。

const FMSCleaner = (() => {
  // 规则1：从"账单明细"原表中删除的列（按表头名匹配，不依赖列顺序）
  const COLUMNS_TO_DELETE = [
    "结算金额",
    "产品收入（不含税）",
    "VIP CREDIT折扣分摊（不含税）",
    "其他折扣合计",
    "调整费用",
    "销售税合计",
    "VAT",
    "运费",
    "订单行收入（含VIP CREDIT）",
    "订单行收入（不含VIP CREDIT）",
    "交易币种",
    "销售收入（交易币种）",
    "履约仓库",
    "履约类型",
    "销售收入（结算币种）",
  ];

  // 常见货币代码 -> 符号。查不到的代码退化为"代码+空格"前缀（如 "SEK "）
  const CURRENCY_SYMBOLS = {
    USD: "$",
    CAD: "CA$",
    AUD: "A$",
    NZD: "NZ$",
    EUR: "€",
    GBP: "£",
    CNY: "¥",
    JPY: "¥",
    HKD: "HK$",
    SGD: "S$",
    MXN: "MX$",
    KRW: "₩",
  };

  /**
   * 货币代码 -> 两位小数的Excel numFmt字符串，如 "$"#,##0.00
   */
  function currencyNumFmt(currencyCode) {
    const symbol = CURRENCY_SYMBOLS[currencyCode] || (currencyCode ? currencyCode + " " : "");
    return `"${symbol}"#,##0.00`;
  }

  // 配色方案（写入 ExcelJS 的真实底色/字体，不是靠数字格式模拟）
  const STYLE = {
    headerFill: "FFDCE6F7", // 表头浅蓝底
    headerFont: "FF1F3864", // 表头深蓝字
    totalFill: "FFF2F2F2", // 总计行浅灰底
    totalBorder: "FFB0B0B0",
    overviewTitleFill: "FF1F3864", // 数据概览大标题深蓝底
    settleFill: "FFDFF0D8", // 结算总额(G3) 浅绿底
    settleFont: "FF1E7B34",
    headlineFill: "FFFFE699", // 结算总额大字(G5) 金色底
    headlineFont: "FF7F6000",
    fontName: "Microsoft YaHei",
  };

  function argb(hex) {
    return { argb: hex };
  }

  /**
   * 规则5：列宽自适应。中日韩字符按2倍宽度估算，单列宽度限制在[min, max]之间。
   */
  function displayWidth(value) {
    const s = value === null || value === undefined ? "" : String(value);
    let w = 0;
    for (const ch of s) {
      w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
    }
    return w;
  }

  function computeColWidths(aoa, { min = 6, max = 40, padding = 2 } = {}) {
    const colCount = aoa.reduce((n, row) => Math.max(n, row.length), 0);
    const widths = new Array(colCount).fill(min);
    for (const row of aoa) {
      row.forEach((cell, i) => {
        const w = Math.min(displayWidth(cell) + padding, max);
        if (w > widths[i]) widths[i] = w;
      });
    }
    return widths.map((wch) => ({ wch }));
  }

  /**
   * 读取原始workbook中的第一个sheet，返回 {headers, rows}
   * headers: string[]
   * rows: any[][]（不含表头）
   */
  function readSourceSheet(workbook) {
    const sheetName = workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const all = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
    const headers = all[0] || [];
    const rows = all.slice(1);
    return { headers, rows };
  }

  /**
   * 多张账单（同一个 vendor 下的多个品牌）合并成一份「原始明细」：
   * 各张账单的明细表头必须完全一致，行直接首尾相接。合并后照常走 clean()，
   * 汇总、概览、FMS导出都是整个 vendor 的合计，品牌区分靠明细里本来就有的「品牌」列。
   * 返回一个 clean() 能直接读的 workbook 对象。
   */
  function mergeSources(workbooks) {
    if (!workbooks.length) throw new Error("没有要合并的账单");
    const parts = workbooks.map(readSourceSheet);
    const headers = parts[0].headers;
    parts.forEach((p, i) => {
      if (JSON.stringify(p.headers) !== JSON.stringify(headers)) {
        throw new Error("第 " + (i + 1) + " 张账单的明细表头和第 1 张不一致，无法合并");
      }
    });
    const aoa = [headers, ...parts.flatMap((p) => p.rows)];
    return { SheetNames: ["Sheet1"], Sheets: { Sheet1: XLSX.utils.aoa_to_sheet(aoa) } };
  }

  /**
   * 规则1：删除指定列，返回新的 {headers, rows}
   */
  function removeColumns(headers, rows, columnsToDelete) {
    const deleteSet = new Set(columnsToDelete);
    const keepIndexes = headers
      .map((h, i) => i)
      .filter((i) => !deleteSet.has(headers[i]));

    const newHeaders = keepIndexes.map((i) => headers[i]);
    const newRows = rows.map((row) => keepIndexes.map((i) => row[i] ?? ""));

    return { headers: newHeaders, rows: newRows };
  }

  /**
   * 规则2：按 Brand SKU 汇总数量、结算金额（静态版“透视表”）
   * headers/rows 必须来自【原始】账单数据（删列之前），因为"结算金额"是被删除的列之一。
   * options:
   *   settlementType: "order" | "refund"        -> 对应"结算类型"筛选
   *   settledFilter: "是" | null                 -> 对应"是否结算"筛选，null 表示不筛选（全部）
   * 返回 {skuRows, totalQty, totalPrice}
   */
  function summarizeByBrandSku(headers, rows, { settlementType, settledFilter }) {
    const idx = {
      settlementType: headers.indexOf("结算类型"),
      settled: headers.indexOf("是否结算"),
      brandSku: headers.indexOf("Brand SKU"),
      qty: headers.indexOf("数量"),
      price: headers.indexOf("结算金额"),
    };

    const filtered = rows.filter((row) => {
      if (row[idx.settlementType] !== settlementType) return false;
      if (settledFilter !== null && row[idx.settled] !== settledFilter) return false;
      return true;
    });

    const sumMap = new Map(); // brandSku -> { qty, price }
    for (const row of filtered) {
      const sku = row[idx.brandSku];
      const qty = Number(row[idx.qty]) || 0;
      const price = Number(row[idx.price]) || 0;
      const entry = sumMap.get(sku) || { qty: 0, price: 0 };
      entry.qty += qty;
      entry.price += price;
      sumMap.set(sku, entry);
    }

    const skuRows = Array.from(sumMap.entries())
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), "zh"))
      .map(([sku, sums]) => [sku, sums.qty, sums.price]);

    const totalQty = skuRows.reduce((s, r) => s + r[1], 0);
    const totalPrice = skuRows.reduce((s, r) => s + r[2], 0);

    return { skuRows, totalQty, totalPrice };
  }

  // Justfab EU 店铺：账单按「结算主体」分，每个主体对应固定的几个站点。
  // 站点用 FMS 里的站点代码（英国是 GB，用户口头说的 UK 也认）。
  const EU_SHOP = "justfabeu";
  const EU_ENTITIES = [
    { name: "TechStyle GmbH", sites: ["DE", "NL"] },
    { name: "TechStyle Fashion Group Ltd.", sites: ["GB"] },
    { name: "TechStyle Fashion Group S.L.", sites: ["ES", "FR"] },
  ];
  const normKey = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const normSite = (v) => {
    const k = String(v ?? "").trim().toUpperCase();
    return k === "UK" ? "GB" : k;
  };

  /**
   * Justfab EU 的账单：按 结算主体 + 站点 + 品牌 + 结算币种 汇总正向/逆向（口径同 totalsByBrand）。
   * 不是 EU 店铺的账单（或表里没有 结算主体/站点/店铺 列）返回 null，沿用原来的概览布局。
   * 每一条带 note：站点跟主体对应关系不符、主体不认识时提示，方便核对。
   * 排序：主体按 EU_ENTITIES 的顺序（不认识的排最后），站点按对应关系的顺序，品牌按首次出现顺序。
   */
  function totalsByEntitySite(headers, rows) {
    const idx = {
      shop: headers.indexOf("店铺"),
      entity: headers.indexOf("结算主体"),
      site: headers.indexOf("站点"),
      brand: headers.indexOf("品牌"),
      cur: headers.indexOf("结算币种"),
      type: headers.indexOf("结算类型"),
      settled: headers.indexOf("是否结算"),
      qty: headers.indexOf("数量"),
      price: headers.indexOf("结算金额"),
    };
    if (idx.shop < 0 || idx.entity < 0 || idx.site < 0 || !rows.length) return null;
    if (!rows.every((row) => normKey(row[idx.shop]) === EU_SHOP)) return null;

    const map = new Map();
    for (const row of rows) {
      const rawEntity = String(row[idx.entity] ?? "").trim();
      const known = EU_ENTITIES.findIndex((e) => normKey(e.name) === normKey(rawEntity));
      const entity = known >= 0 ? EU_ENTITIES[known].name : rawEntity;
      const site = normSite(row[idx.site]);
      const brand = String(row[idx.brand] ?? "");
      const currency = String(row[idx.cur] ?? "");
      const key = [entity, site, brand, currency].join("|");
      let e = map.get(key);
      if (!e) {
        let note = "";
        if (known < 0) note = "结算主体不在已知的 3 个主体里";
        else if (!EU_ENTITIES[known].sites.includes(site)) note = "站点不在该主体对应的站点里（应为 " + EU_ENTITIES[known].sites.join("+") + "）";
        e = { entity, entityRank: known < 0 ? 99 : known, site, brand, currency, fQty: 0, fPrice: 0, rQty: 0, rPrice: 0, note, order: map.size };
        map.set(key, e);
      }
      if (row[idx.settled] !== "是") continue;
      const kind = row[idx.type] === "order" ? "f" : row[idx.type] === "refund" ? "r" : null;
      if (!kind) continue;
      e[kind + "Qty"] += Number(row[idx.qty]) || 0;
      e[kind + "Price"] += Number(row[idx.price]) || 0;
    }
    const siteRank = (e) => {
      const k = EU_ENTITIES.findIndex((x) => x.name === e.entity);
      const i = k >= 0 ? EU_ENTITIES[k].sites.indexOf(e.site) : -1;
      return i < 0 ? 99 : i;
    };
    return [...map.values()].sort((a, b) => a.entityRank - b.entityRank || a.entity.localeCompare(b.entity) || siteRank(a) - siteRank(b) || a.site.localeCompare(b.site) || a.order - b.order);
  }

  /**
   * 按品牌汇总正向/逆向的数量和结算金额（口径跟 summarizeByBrandSku 完全一致：
   * 正向 = 结算类型 order 且 是否结算=是；逆向 = refund 且 是否结算=是），品牌按首次出现的顺序排列。
   * headers/rows 必须来自【原始】账单数据（删列之前）。只有一个品牌时也会返回（调用方决定要不要展示）。
   */
  function totalsByBrand(headers, rows) {
    const idx = {
      brand: headers.indexOf("品牌"),
      type: headers.indexOf("结算类型"),
      settled: headers.indexOf("是否结算"),
      qty: headers.indexOf("数量"),
      price: headers.indexOf("结算金额"),
    };
    const map = new Map();
    for (const row of rows) {
      if (row[idx.settled] !== "是") continue;
      const kind = row[idx.type] === "order" ? "f" : row[idx.type] === "refund" ? "r" : null;
      if (!kind) continue;
      const brand = String(row[idx.brand] ?? "");
      const e = map.get(brand) || { brand, fQty: 0, fPrice: 0, rQty: 0, rPrice: 0 };
      e[kind + "Qty"] += Number(row[idx.qty]) || 0;
      e[kind + "Price"] += Number(row[idx.price]) || 0;
      map.set(brand, e);
    }
    // 没有任何已结算行的品牌也要列出来（数据全是 0），免得对账时以为漏了这个品牌
    for (const row of rows) {
      const brand = String(row[idx.brand] ?? "");
      if (!map.has(brand)) map.set(brand, { brand, fQty: 0, fPrice: 0, rQty: 0, rPrice: 0 });
    }
    return [...map.values()];
  }

  /**
   * 拼装成"正向数据"/"逆向数据" tab 的完整表格内容（AOA），外观仿照原透视表：
   * 行1：结算类型 | 值
   * 行2：是否结算 | 值
   * 行3：空行
   * 行4：行标签 | 求和项:数量 | 求和项:单价
   * 行5+：各SKU汇总
   * 末行：总计
   */
  function summaryToAoa(summary, settlementType, settledLabel) {
    return [
      ["结算类型", settlementType, ""],
      ["是否结算", settledLabel, ""],
      ["", "", ""],
      ["行标签", "求和项:数量", "求和项:结算金额"],
      ...summary.skuRows,
      ["总计", summary.totalQty, summary.totalPrice],
    ];
  }

  /**
   * "YYYY-MM" -> 当月1号对应的Excel日期序列号（1900日期系统）
   */
  function excelSerialFromYearMonth(yearMonthStr) {
    const [y, m] = String(yearMonthStr).split("-").map(Number);
    const utcMs = Date.UTC(y, m - 1, 1);
    const epochMs = Date.UTC(1899, 11, 30);
    return Math.round((utcMs - epochMs) / 86400000);
  }

  /**
   * 规则3：数据概览 tab（真实颜色版，用 ExcelJS 写入）
   * B3：结算月份（取自原始数据"结算月份"列第一行的值），显示为"yyyy年m月"
   * C3/D3：正向数据 总计-数量/结算价
   * E3/F3：逆向数据 总计-数量/结算价
   * G3：=D3-F3（浅绿底）
   * F5/G5："结算总额" / =G3（金色底、加粗大字，全表的视觉焦点）
   */
  function buildOverviewSheet(workbook, monthStr, forwardTotals, reverseTotals, currencyCode, brandTotals, euTotals) {
    const ws = workbook.addWorksheet("数据概览");
    const numFmt = currencyNumFmt(currencyCode);
    const monthSerial = monthStr ? excelSerialFromYearMonth(monthStr) : null;

    // Justfab EU：按 结算主体 → 站点 → 品牌 展开，每个主体后面一行小计，最后按币种合计。
    // （EU 的几个主体币种不同，比如英国是 GBP，不能把所有行直接加在一起。）
    if (euTotals && euTotals.length) {
      ws.columns = [
        { width: Math.max(28, ...euTotals.map((x) => displayWidth(x.entity) + 8)) },
        { width: 8 },
        { width: Math.max(12, ...euTotals.map((x) => displayWidth(x.brand) + 2)) },
        { width: 12 },
        { width: 11 },
        { width: 14 },
        { width: 11 },
        { width: 14 },
        { width: 16 },
        { width: 8 },
        { width: 34 },
      ];
      const t = ws.getCell("A1");
      t.value = "单位：见「币种」列";
      t.font = { name: STYLE.fontName, bold: true };

      const hdr = ws.getRow(2);
      hdr.values = ["结算主体", "站点", "品牌", "结算月份", "正向数量", "正向结算价", "逆向数量", "逆向结算价", "结算总额", "币种", "备注"];
      for (let c = 1; c <= 11; c++) {
        const cell = hdr.getCell(c);
        cell.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headerFont) };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headerFill) };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
      hdr.height = 20;

      let rowNo = 3;
      const firstData = rowNo;
      const currencies = [];
      const groups = [];
      for (const x of euTotals) {
        if (!groups.length || groups[groups.length - 1].entity !== x.entity) groups.push({ entity: x.entity, items: [] });
        groups[groups.length - 1].items.push(x);
      }
      const styleRow = (row, bold, fill) => {
        for (let c = 1; c <= 11; c++) {
          const cell = row.getCell(c);
          cell.font = { name: STYLE.fontName, bold: bold || c === 1 };
          cell.alignment = { horizontal: c === 1 || c === 11 ? "left" : "center", vertical: "middle" };
          if (fill) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.totalFill) };
            cell.border = { top: { style: "thin", color: argb(STYLE.totalBorder) } };
          }
        }
      };
      const dataRows = []; // 实际数据行号（不含小计行），汇总币种合计时用
      for (const g of groups) {
        const gStart = rowNo;
        for (const x of g.items) {
          const row = ws.getRow(rowNo);
          const fmt = currencyNumFmt(x.currency);
          row.getCell(1).value = x.entity;
          row.getCell(2).value = x.site;
          row.getCell(3).value = x.brand;
          row.getCell(4).value = monthSerial;
          if (monthSerial !== null) row.getCell(4).numFmt = 'yyyy"年"m"月"';
          row.getCell(5).value = x.fQty;
          row.getCell(6).value = x.fPrice;
          row.getCell(6).numFmt = fmt;
          row.getCell(7).value = x.rQty;
          row.getCell(8).value = Math.abs(x.rPrice);
          row.getCell(8).numFmt = fmt;
          row.getCell(9).value = { formula: "F" + rowNo + "-H" + rowNo };
          row.getCell(9).numFmt = fmt;
          row.getCell(10).value = x.currency;
          row.getCell(11).value = x.note;
          styleRow(row, false, false);
          if (x.note) row.getCell(11).font = { name: STYLE.fontName, color: argb("FFC0392B") };
          if (x.currency && !currencies.includes(x.currency)) currencies.push(x.currency);
          dataRows.push(rowNo);
          rowNo++;
        }
        // 小计：一个主体下币种只有一种时才加（币种不同的数相加没有意义）
        const gCur = [...new Set(g.items.map((x) => x.currency))];
        if (gCur.length === 1) {
          const sub = ws.getRow(rowNo);
          const fmt = currencyNumFmt(gCur[0]);
          sub.getCell(1).value = g.entity + " 小计";
          for (const [col, letter] of [[5, "E"], [6, "F"], [7, "G"], [8, "H"]]) {
            sub.getCell(col).value = { formula: "SUM(" + letter + gStart + ":" + letter + (rowNo - 1) + ")" };
            if (col === 6 || col === 8) sub.getCell(col).numFmt = fmt;
          }
          sub.getCell(9).value = { formula: "F" + rowNo + "-H" + rowNo };
          sub.getCell(9).numFmt = fmt;
          styleRow(sub, true, true);
          rowNo++;
        }
      }

      // 按币种合计：只汇总数据行（小计行的「币种」列是空的，SUMIF 自然不会重复计入）
      const lastData = rowNo - 1;
      rowNo++;
      for (const cur of currencies) {
        const tot = ws.getRow(rowNo);
        const fmt = currencyNumFmt(cur);
        tot.getCell(1).value = "合计（" + cur + "）";
        for (const [col, letter] of [[5, "E"], [6, "F"], [7, "G"], [8, "H"]]) {
          tot.getCell(col).value = { formula: 'SUMIF($J$' + firstData + ":$J$" + lastData + ',"' + cur + '",' + letter + "$" + firstData + ":" + letter + "$" + lastData + ")" };
          if (col === 6 || col === 8) tot.getCell(col).numFmt = fmt;
        }
        tot.getCell(9).value = { formula: "F" + rowNo + "-H" + rowNo };
        tot.getCell(9).numFmt = fmt;
        tot.getCell(10).value = cur;
        styleRow(tot, true, true);
        const g = tot.getCell(9);
        g.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headlineFont) };
        g.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headlineFill) };
        tot.height = 22;
        rowNo++;
      }
      ws.views = [{ state: "frozen", ySplit: 2 }];
      return ws;
    }

    // 多个品牌（同一个 vendor 合并对账）：整张表按品牌展开，一行一个品牌，最后一行合计，
    // 结算总额的合计单元格用金色底突出。只有一个品牌时仍然用下面原来的单行布局。
    if (brandTotals && brandTotals.length > 1) {
      ws.columns = [
        { width: Math.max(12, ...brandTotals.map((x) => displayWidth(x.brand) + 2)) },
        { width: 14 },
        { width: 12 },
        { width: 14 },
        { width: 12 },
        { width: 14 },
        { width: 16 },
      ];
      const title = ws.getCell("A1");
      title.value = "单位：" + currencyCode;
      title.font = { name: STYLE.fontName, bold: true };

      const hdr = ws.getRow(2);
      hdr.values = ["品牌", "结算月份", "正向数量", "正向结算价", "逆向数量", "逆向结算价", "结算总额"];
      for (let c = 1; c <= 7; c++) {
        const cell = hdr.getCell(c);
        cell.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headerFont) };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headerFill) };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
      hdr.height = 20;

      brandTotals.forEach((x, i) => {
        const rowNo = 3 + i;
        const row = ws.getRow(rowNo);
        row.getCell(1).value = x.brand;
        row.getCell(2).value = monthSerial;
        if (monthSerial !== null) row.getCell(2).numFmt = 'yyyy"年"m"月"';
        row.getCell(3).value = x.fQty;
        row.getCell(4).value = x.fPrice;
        row.getCell(4).numFmt = numFmt;
        row.getCell(5).value = x.rQty;
        row.getCell(6).value = Math.abs(x.rPrice);
        row.getCell(6).numFmt = numFmt;
        row.getCell(7).value = { formula: "D" + rowNo + "-F" + rowNo };
        row.getCell(7).numFmt = numFmt;
        for (let c = 1; c <= 7; c++) {
          const cell = row.getCell(c);
          cell.font = { name: STYLE.fontName, bold: c === 1 };
          cell.alignment = { horizontal: c === 1 ? "left" : "center", vertical: "middle" };
        }
      });

      const last = 2 + brandTotals.length;
      const totalNo = last + 1;
      const tot = ws.getRow(totalNo);
      tot.getCell(1).value = "合计";
      for (const [col, letter] of [[3, "C"], [4, "D"], [5, "E"], [6, "F"]]) {
        tot.getCell(col).value = { formula: "SUM(" + letter + "3:" + letter + last + ")" };
        if (col === 4 || col === 6) tot.getCell(col).numFmt = numFmt;
      }
      tot.getCell(7).value = { formula: "D" + totalNo + "-F" + totalNo };
      tot.getCell(7).numFmt = numFmt;
      for (let c = 1; c <= 7; c++) {
        const cell = tot.getCell(c);
        cell.font = { name: STYLE.fontName, bold: true };
        cell.alignment = { horizontal: c === 1 ? "left" : "center", vertical: "middle" };
        if (c < 7) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.totalFill) };
          cell.border = { top: { style: "thin", color: argb(STYLE.totalBorder) } };
        }
      }
      // 结算总额合计：金色底大字，跟单品牌版的「结算总额」一致，是全表的视觉焦点
      const g = tot.getCell(7);
      g.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headlineFont) };
      g.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headlineFill) };
      g.border = {
        top: { style: "thin", color: argb(STYLE.headlineFont) },
        bottom: { style: "thin", color: argb(STYLE.headlineFont) },
        left: { style: "thin", color: argb(STYLE.headlineFont) },
        right: { style: "thin", color: argb(STYLE.headlineFont) },
      };
      tot.height = 22;
      return ws;
    }

    ws.columns = [
      { width: 12 },
      { width: 14 },
      { width: 12 },
      { width: 14 },
      { width: 12 },
      { width: 14 },
      { width: 16 },
    ];

    // 标题（仅 A1 单元格，不跨列合并）
    const title = ws.getCell("A1");
    title.value = `单位：${currencyCode}`;
    title.font = { name: STYLE.fontName, bold: true };

    // 表头行
    const headerRow = ws.getRow(2);
    headerRow.values = ["", "", "正向数量", "正向结算价", "逆向数量", "逆向结算价", "结算总额"];
    for (let c = 3; c <= 7; c++) {
      const cell = headerRow.getCell(c);
      cell.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headerFont) };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headerFill) };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    }
    headerRow.height = 20;

    // 数据行
    const dataRow = ws.getRow(3);
    dataRow.getCell(2).value = monthSerial;
    if (monthSerial !== null) dataRow.getCell(2).numFmt = 'yyyy"年"m"月"';
    dataRow.getCell(3).value = forwardTotals.totalQty;
    dataRow.getCell(4).value = forwardTotals.totalPrice;
    dataRow.getCell(4).numFmt = numFmt;
    dataRow.getCell(5).value = reverseTotals.totalQty;
    dataRow.getCell(6).value = Math.abs(reverseTotals.totalPrice);
    dataRow.getCell(6).numFmt = numFmt;

    const g3 = dataRow.getCell(7);
    g3.value = { formula: "D3-F3" };
    g3.numFmt = numFmt;
    g3.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.settleFont) };
    g3.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.settleFill) };
    dataRow.height = 20;
    dataRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = cell.font || { name: STYLE.fontName };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    // 结算总额大字标题（视觉焦点）
    const headlineRow = ws.getRow(5);
    const label = headlineRow.getCell(6);
    label.value = "结算总额";
    label.font = { name: STYLE.fontName, bold: true };
    label.alignment = { horizontal: "right", vertical: "middle" };

    const g5 = headlineRow.getCell(7);
    g5.value = { formula: "G3" };
    g5.numFmt = numFmt;
    g5.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headlineFont) };
    g5.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headlineFill) };
    g5.alignment = { horizontal: "center", vertical: "middle" };
    g5.border = {
      top: { style: "medium", color: argb(STYLE.headlineFont) },
      bottom: { style: "medium", color: argb(STYLE.headlineFont) },
      left: { style: "medium", color: argb(STYLE.headlineFont) },
      right: { style: "medium", color: argb(STYLE.headlineFont) },
    };
    headlineRow.height = 24;

    return ws;
  }

  /**
   * 主流程：删除多余列 -> 生成正向/逆向汇总表 -> 生成数据概览。
   */
  function clean(workbook) {
    const { headers, rows } = readSourceSheet(workbook);

    // 货币符号规则依据原表"交易币种"列（该列本身会被删除，这里在删除前取值）
    // 品牌/结算月份用于生成输出文件名
    const currencyColIdx = headers.indexOf("交易币种");
    const brandColIdx = headers.indexOf("品牌");
    const monthColIdx = headers.indexOf("结算月份");
    const currencyCode = rows.length ? rows[0][currencyColIdx] : "";
    const brand = rows.length ? rows[0][brandColIdx] : "";
    const monthStr = rows.length ? rows[0][monthColIdx] : "";

    const fmsExport = removeColumns(headers, rows, COLUMNS_TO_DELETE);

    // 汇总用"结算金额"，该列已被删除，必须从删列前的原始 headers/rows 取数
    const forward = summarizeByBrandSku(headers, rows, {
      settlementType: "order",
      settledFilter: "是",
    });
    const reverse = summarizeByBrandSku(headers, rows, {
      settlementType: "refund",
      settledFilter: "是",
    });

    const forwardAoa = summaryToAoa(forward, "order", "是");
    const reverseAoa = summaryToAoa(reverse, "refund", "是");

    return {
      fmsExport, // { headers, rows } -> "FMS导出" tab
      forwardAoa, // "正向数据" tab 的完整AOA
      reverseAoa, // "逆向数据" tab 的完整AOA
      forwardTotals: forward, // { skuRows, totalQty, totalPrice }
      reverseTotals: reverse,
      currencyCode,
      brand,
      monthStr, // "YYYY-MM"
      euTotals: totalsByEntitySite(headers, rows), // Justfab EU 才有：按 结算主体/站点/品牌/币种 汇总，数据概览用
      brandTotals: totalsByBrand(headers, rows), // 按品牌的合计，多个品牌时展示在数据概览里
    };
  }

  /**
   * FMS导出 sheet：表头加粗底色、冻结首行、"单价"列货币格式、列宽自适应
   */
  function buildExportSheet(workbook, fmsExport, numFmt) {
    const ws = workbook.addWorksheet("FMS导出");
    const aoa = [fmsExport.headers, ...fmsExport.rows];
    ws.addRows(aoa);

    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headerFont) };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headerFill) };
      cell.alignment = { vertical: "middle" };
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    const priceColIdx = fmsExport.headers.indexOf("单价");
    if (priceColIdx !== -1) {
      ws.getColumn(priceColIdx + 1).numFmt = numFmt;
    }

    computeColWidths(aoa).forEach((w, i) => {
      ws.getColumn(i + 1).width = w.wch;
    });

    return ws;
  }

  /**
   * "正向数据"/"逆向数据" sheet：筛选条件行 + 表头行 底色，总计行加粗+上边框，
   * "求和项:结算金额"列货币格式，冻结到表头行(第4行)，列宽自适应
   */
  function buildSummarySheet(workbook, name, aoa, numFmt) {
    const ws = workbook.addWorksheet(name);
    ws.addRows(aoa);

    // 筛选条件行 (1,2)：加粗
    [1, 2].forEach((r) => {
      ws.getRow(r).getCell(1).font = { name: STYLE.fontName, bold: true };
    });

    // 表头行 (4)：底色
    const headerRow = ws.getRow(4);
    headerRow.eachCell((cell) => {
      cell.font = { name: STYLE.fontName, bold: true, color: argb(STYLE.headerFont) };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.headerFill) };
    });

    // 总计行：加粗 + 上边框
    const totalRow = ws.getRow(aoa.length);
    totalRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: STYLE.fontName, bold: true };
      cell.border = { top: { style: "thin", color: argb(STYLE.totalBorder) } };
    });
    totalRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.totalFill) };
    totalRow.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.totalFill) };
    totalRow.getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: argb(STYLE.totalFill) };

    // "求和项:结算金额"列（C列）货币格式，从第5行(第一条SKU)到总计行
    for (let r = 5; r <= aoa.length; r++) {
      ws.getCell(`C${r}`).numFmt = numFmt;
    }

    ws.views = [{ state: "frozen", ySplit: 4 }];
    computeColWidths(aoa, { min: 10 }).forEach((w, i) => {
      ws.getColumn(i + 1).width = w.wch;
    });

    return ws;
  }

  /**
   * 规则4：输出文件命名 = 品牌 + 结算月份第一天-最后一天 + 结算明细 + 生成日期(YYYYMMDD)
   * 例："Pretty Garden 8.01-8.31结算明细20260916.xlsx"
   */
  function buildOutputFileName(result, generatedDate = new Date(), lang = "zh") {
    const [y, m] = String(result.monthStr).split("-").map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const dateRange = `${m}.01-${m}.${String(lastDay).padStart(2, "0")}`;

    const yyyy = generatedDate.getFullYear();
    const mm = String(generatedDate.getMonth() + 1).padStart(2, "0");
    const dd = String(generatedDate.getDate()).padStart(2, "0");
    const generatedStr = `${yyyy}${mm}${dd}`;

    if (lang === "en") return `${result.brand} ${dateRange} Settlement Details ${generatedStr}.xlsx`;
    return `${result.brand} ${dateRange}结算明细${generatedStr}.xlsx`;
  }

  /**
   * 把清洗结果转成新的 ExcelJS workbook（真实颜色/加粗/冻结窗格）
   */
  // 英文版：先按中文版生成，再把表里的中文标签/表头/sheet 名换成英文（数字、公式、样式不动）。
  // 明细里没收录的中文列名保持原样。
  const EN = {
    "数据概览": "Overview", "FMS导出": "FMS Export", "正向数据": "Forward", "逆向数据": "Reverse",
    "品牌": "Brand", "结算月份": "Settlement Month", "正向数量": "Forward Qty", "正向结算价": "Forward Amount",
    "逆向数量": "Reverse Qty", "逆向结算价": "Reverse Amount", "结算总额": "Total Settlement",
    "结算主体": "Settlement Entity", "站点": "Site", "币种": "Currency", "备注": "Notes", "合计": "Total",
    "账单编号": "Bill No.", "结算类型": "Settlement Type", "店铺": "Shop", "订单号": "Order No.",
    "数量": "Qty", "单价": "Unit Price", "结算币种": "Settlement Currency", "是否结算": "Settled",
    "是": "Yes", "否": "No",
    "行标签": "Row Labels", "求和项:数量": "Sum of Qty", "求和项:结算金额": "Sum of Settlement Amount", "总计": "Grand Total",
    "单位：见「币种」列": "Currency: see Currency column",
    "结算主体不在已知的 3 个主体里": "Settlement entity is not one of the 3 known entities",
  };
  function translateCell(v) {
    if (typeof v !== "string") return v;
    if (EN[v] !== undefined) return EN[v];
    let m;
    if ((m = v.match(/^单位：(.*)$/))) return "Currency: " + m[1];
    if ((m = v.match(/^(.*) 小计$/))) return m[1] + " Subtotal";
    if ((m = v.match(/^合计（(.*)）$/))) return "Total (" + m[1] + ")";
    if ((m = v.match(/^站点不在该主体对应的站点里（应为 (.*)）$/))) return "Site does not belong to this entity (expected " + m[1] + ")";
    return v;
  }
  function translateWorkbook(wb) {
    wb.worksheets.forEach((ws) => {
      const settledCol = ws.name === "FMS导出" ? (() => { let c = 0; ws.getRow(1).eachCell((cell, i) => { if (cell.value === "是否结算") c = i; }); return c; })() : 0;
      ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
        row.eachCell({ includeEmpty: false }, (cell, colNo) => {
          const v = cell.value;
          if (typeof v === "string") {
            // FMS导出 的明细行里只翻译「是否结算」列，别的明细值（品牌、店铺名等）原样保留
            if (ws.name === "FMS导出" && rowNo > 1 && colNo !== settledCol) return;
            if (ws.name.endsWith("数据") && rowNo > 4 && rowNo < ws.rowCount) return; // SKU 行不翻
            cell.value = translateCell(v);
          }
          if (cell.numFmt === 'yyyy"年"m"月"') cell.numFmt = "mmm yyyy";
        });
      });
    });
    wb.worksheets.forEach((ws) => { if (EN[ws.name]) ws.name = EN[ws.name]; });
    return wb;
  }

  function buildWorkbook(result, lang = "zh") {
    const wb = new ExcelJS.Workbook();
    const numFmt = currencyNumFmt(result.currencyCode);

    buildOverviewSheet(wb, result.monthStr, result.forwardTotals, result.reverseTotals, result.currencyCode, result.brandTotals, result.euTotals);
    buildExportSheet(wb, result.fmsExport, numFmt);
    buildSummarySheet(wb, "正向数据", result.forwardAoa, numFmt);
    buildSummarySheet(wb, "逆向数据", result.reverseAoa, numFmt);

    return lang === "en" ? translateWorkbook(wb) : wb;
  }

  /**
   * ExcelJS workbook -> ArrayBuffer，可直接用于 Blob 下载
   */
  async function workbookToBuffer(wb) {
    return wb.xlsx.writeBuffer();
  }

  return {
    COLUMNS_TO_DELETE,
    CURRENCY_SYMBOLS,
    currencyNumFmt,
    readSourceSheet,
    mergeSources,
    removeColumns,
    summarizeByBrandSku,
    totalsByBrand,
    totalsByEntitySite,
    EU_ENTITIES,
    summaryToAoa,
    excelSerialFromYearMonth,
    computeColWidths,
    buildOutputFileName,
    clean,
    buildWorkbook,
    workbookToBuffer,
  };
})();
