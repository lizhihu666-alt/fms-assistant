// 用真实的清洗代码，拿虚构的两个品牌数据生成一份「同一 vendor 多品牌合并后」的对账表样例
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const XLSX = require(path.join(path.join(__dirname, "..", ".."), "libs", "xlsx.full.min.js"));
const ExcelJS = require(path.join(path.join(__dirname, "..", ".."), "libs", "exceljs.min.js"));
// 不用 vm 沙箱：ExcelJS 认不出沙箱里创建的数组，会导致表头行写不进去。直接在同一个运行环境里加载清洗代码。
const C = new Function("XLSX", "ExcelJS", fs.readFileSync(path.join(path.join(__dirname, "..", ".."), "src", "cleaner.js"), "utf8") + "\nreturn FMSCleaner;")(XLSX, ExcelJS);

const H = ["账单编号", "站点", "品牌", "结算月份", "结算类型", "是否结算", "订单号", "Brand SKU", "MM SKU", "数量", "单价", "结算金额", "产品收入（不含税）", "销售税合计", "运费", "交易币种", "销售收入（结算币种）"];
const row = (no, brand, type, settled, order, sku, mm, qty, price) => [no, "DE", brand, "2026-09", type, settled, order, sku, mm, qty, price, qty * price * (type === "refund" ? -1 : 1), qty * price * 1.2, 1.5, 3, "EUR", qty * price];

const brandA = [
  row("SAMPLE-0001", "Imily Bela", "order", "是", "O1001", "IB-DRESS-RED-S", "MM-IB-001", 3, 12.5),
  row("SAMPLE-0001", "Imily Bela", "order", "是", "O1002", "IB-DRESS-RED-M", "MM-IB-002", 2, 12.5),
  row("SAMPLE-0001", "Imily Bela", "order", "是", "O1003", "IB-TOP-BLK-S", "MM-IB-010", 5, 8),
  row("SAMPLE-0001", "Imily Bela", "refund", "是", "O0991", "IB-DRESS-RED-S", "MM-IB-001", 1, 12.5),
  row("SAMPLE-0001", "Imily Bela", "order", "否", "O1004", "IB-TOP-BLK-M", "MM-IB-011", 1, 8),
];
const brandB = [
  row("SAMPLE-0002", "Runcati", "order", "是", "R2001", "RC-SKIRT-NVY-S", "MM-RC-001", 4, 15),
  row("SAMPLE-0002", "Runcati", "order", "是", "R2002", "RC-SKIRT-NVY-M", "MM-RC-002", 2, 15),
  row("SAMPLE-0002", "Runcati", "order", "是", "R2003", "RC-COAT-GRY-L", "MM-RC-020", 1, 40),
  row("SAMPLE-0002", "Runcati", "refund", "是", "R1990", "RC-SKIRT-NVY-S", "MM-RC-001", 1, 15),
];
const wb = (rows) => ({ SheetNames: ["Sheet1"], Sheets: { Sheet1: XLSX.utils.aoa_to_sheet([H, ...rows]) } });

const merged = C.mergeSources([wb(brandA), wb(brandB)]);
const result = C.clean(merged);
result.brand = "Imily Bela & Runcati"; // 跟插件里一致：多品牌用品牌名拼起来
const out = C.buildWorkbook(result);
const name = C.buildOutputFileName(result, new Date(2026, 9, 13)).replace(/\.xlsx$/, "（样例）.xlsx");
out.xlsx.writeBuffer().then((buf) => {
  const p = path.join(__dirname, "samples") + "/" + name;
  fs.writeFileSync(p, Buffer.from(buf));
  console.log(p);
  console.log("正向", result.forwardTotals.totalQty, result.forwardTotals.totalPrice, "逆向", result.reverseTotals.totalQty, result.reverseTotals.totalPrice, "明细行", result.fmsExport.rows.length);
});
