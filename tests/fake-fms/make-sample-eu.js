// 用真实的清洗代码，拿虚构数据生成一份 Justfab EU 的对账表样例（3 个结算主体、多个站点、两个品牌）
const fs = require("fs");
const path = require("path");
const XLSX = require(path.join(path.join(__dirname, "..", ".."), "libs", "xlsx.full.min.js"));
const ExcelJS = require(path.join(path.join(__dirname, "..", ".."), "libs", "exceljs.min.js"));
const C = new Function("XLSX", "ExcelJS", fs.readFileSync(path.join(path.join(__dirname, "..", ".."), "src", "cleaner.js"), "utf8") + "\nreturn FMSCleaner;")(XLSX, ExcelJS);

const H = ["账单编号", "结算月份", "品牌", "结算主体", "结算类型", "站点", "店铺", "订单号", "Brand SKU", "数量", "单价", "结算币种", "结算金额", "产品收入（不含税）", "销售税合计", "运费", "交易币种", "销售收入（结算币种）", "是否结算"];
const E = { de: "TechStyle GmbH", uk: "TechStyle Fashion Group Ltd.", es: "TechStyle Fashion Group S.L." };
let n = 1000;
const row = (brand, entity, site, type, qty, price, cur, settled) => {
  const amount = qty * price * (type === "refund" ? -1 : 1);
  return ["SAMPLE-EU-" + site, "2026-09", brand, entity, type, site, "Justfab EU", "O" + n++, brand.slice(0, 2).toUpperCase() + "-" + site + "-" + n, type === "refund" ? -qty : qty, price, cur, amount, 0, 0, 0, cur, 0, settled || "是"];
};
const rows = [
  row("Imily Bela", E.de, "DE", "order", 40, 12, "EUR"), row("Imily Bela", E.de, "DE", "refund", 3, 12, "EUR"),
  row("Imily Bela", E.de, "NL", "order", 12, 12, "EUR"),
  row("Imily Bela", E.uk, "GB", "order", 25, 10, "GBP"), row("Imily Bela", E.uk, "GB", "refund", 2, 10, "GBP"),
  row("Imily Bela", E.es, "ES", "order", 9, 12, "EUR"), row("Imily Bela", E.es, "FR", "order", 14, 12, "EUR"),
  row("Runcati", E.de, "DE", "order", 18, 15, "EUR"), row("Runcati", E.de, "NL", "order", 6, 15, "EUR"), row("Runcati", E.de, "NL", "order", 4, 15, "EUR", "否"),
  row("Runcati", E.uk, "GB", "order", 11, 13, "GBP"),
  row("Runcati", E.es, "FR", "order", 7, 15, "EUR"),
];
const wb = { SheetNames: ["Sheet1"], Sheets: { Sheet1: XLSX.utils.aoa_to_sheet([H, ...rows]) } };
const result = C.clean(C.mergeSources([wb]));
result.brand = "Imily Bela & Runcati";
const name = C.buildOutputFileName(result, new Date(2026, 9, 13)).replace(/\.xlsx$/, "（EU样例）.xlsx");
C.buildWorkbook(result).xlsx.writeBuffer().then((buf) => {
  const p = path.join(__dirname, "samples") + "/" + name;
  fs.writeFileSync(p, Buffer.from(buf));
  console.log(p);
  console.log(JSON.stringify(result.euTotals.map((x) => [x.entity, x.site, x.brand, x.currency, x.fQty, x.fPrice, x.rQty, x.rPrice])));
});
