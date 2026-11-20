// 基础数据 · 全量匹配 的单元测试（不连真实系统）
// 用法：在仓库根目录运行  node tests/basedata-match.test.js
// 覆盖：缺价行 → 计划 → 匹配的纯函数、EH 导出 CSV 解析和成本优先级、品牌→EH 商户对应、
//       后台任务（假 chrome）：两步拆开 / 连着做 / 失败重试 / 多商户文件合并。
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const R = require("path").join(__dirname, "..") + "/"; // 仓库根目录
const read = (f) => fs.readFileSync(R + f, "utf8");

// ---------- 1. 纯函数：planFromFmsRows + resolve ----------
const B = new Function(read("src/config.js").replace(/if \(typeof module[\s\S]*$/, "") + read("src/baseData.js").replace(/if \(typeof module[\s\S]*$/, "") + "\nreturn FMSBaseData;")();
const fmsRow = (shop, sku, extra) => ({ siteCode: "US", shopCode: shop, brandName: "TIJN", sku, brandSku: null, style: "ST1", color: "Black", size: "S", currency: "USD", dataStatus: "待确认", ...extra });
const missing = [
  fmsRow("JUSTFAB", "A-C1-S1"), fmsRow("JUSTFAB", "A-C1-S2"), fmsRow("JUSTFAB", "A-C1-S3"), fmsRow("JUSTFAB", "A-C1-S4"),
  fmsRow("JUSTFAB", "A-C1-S5", { currency: "EUR" }),
  fmsRow("shoedazzle", "Z-1"), fmsRow("shoedazzle", "Z-2"),
];
{
  const { plan, skippedShops } = B.planFromFmsRows(missing);
  assert.strictEqual(plan.items.length, 7);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(skippedShops)), { shoedazzle: 2 }); // 没有 EH 渠道的店铺单独统计
  assert.strictEqual(plan.jobs.length, 1);
  assert.strictEqual(plan.jobs[0].channel, "justfab-us");
  const eh = { "justfab-us": { skus: { "A-C1-S1": { seller: "SELL-1", cost: "10.5", currency: "USD" }, "A-C1-S2": { seller: "SELL-2", cost: "0", currency: "USD" }, "A-C1-S4": { seller: "SELL-4", cost: "12", currency: "USD" }, "A-C1-S5": { seller: "SELL-5", cost: "9", currency: "USD" } } } };
  const out = B.resolve(plan.items, eh);
  assert.deepStrictEqual(out.rows.map((r) => r["MM SKU"]), ["A-C1-S1", "A-C1-S4"]);
  assert.strictEqual(out.rows[0]["结算单价"], 10.5);
  assert.strictEqual(out.rows[0]["Brand SKU"], "SELL-1"); // Brand SKU 取 EH 的 seller_sku_code
  const why = Object.fromEntries(out.unresolved.map((u) => [u.item.sku, u.reason]));
  assert.ok(/成本/.test(why["A-C1-S2"]), "成本为 0：" + why["A-C1-S2"]);
  assert.ok(/搜不到/.test(why["A-C1-S3"]), "EH 没有：" + why["A-C1-S3"]);
  assert.ok(/币种/.test(why["A-C1-S5"]), "币种不一致：" + why["A-C1-S5"]);
  assert.ok(/没有对应的 EH Channel/.test(why["Z-1"]));
  console.log("ok  planFromFmsRows / resolve：成本为 0、EH 没有、币种不一致、无渠道店铺都不乱填");
}
assert.strictEqual(B.matchFileName("Pretty/Garden", new Date(2026, 10, 20)), "基础数据_Pretty_Garden_全量匹配_20261120.xlsx");
console.log("ok  文件名里的非法字符被替换");

// ---------- 2. 后台任务 runMatchJob（假 chrome，注入函数按名字返回） ----------
const store = {};
const calls = [];
let fmsResult, ehResult, lastTabUrl = "";
const chrome = {
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} }, onInstalled: { addListener() {} }, getPlatformInfo() {}, getManifest: () => ({ version: "test" }) },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  permissions: { contains: async () => false },
  downloads: { download: async () => 1, search: async () => [] },
  storage: { onChanged: { addListener() {} }, local: { get: async (k) => (typeof k === "string" ? { [k]: store[k] } : store), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))) } },
  tabs: { create: async ({ url }) => { lastTabUrl = url; return { id: 1 }; }, get: async () => ({ id: 1, status: "complete", url: lastTabUrl }), update: async () => ({}), remove: async () => {}, query: async () => [], onUpdated: { addListener() {}, removeListener() {} } },
  scripting: {
    executeScript: async ({ func, args }) => {
      calls.push([func.name, JSON.parse(JSON.stringify(args))]);
      if (func.name === "fetchBaseDataMissingRows") return [{ result: fmsResult }];
      if (func.name === "fetchEhExportLinks") return [{ result: ehResult }];
      throw new Error("unexpected " + func.name);
    },
  },
};
const CSV = ['﻿"Seller SKU","MM SKU",Channel,"Cost(Active)","Cost Currency(Active)","Cost(Pending)","Cost Currency(Pending)","Base Cost(Active)","Base Cost Currency(Active)"', "SELL-1,A-C1-S1,justfab-us,10.5,USD,,,,", "SELL-2,A-C1-S2,justfab-us,,,9,USD,,", "SELL-4,A-C1-S4,justfab-us,,,,,12,USD"].join("\r\n");
const CSV_HEAD = '"Seller SKU","MM SKU",Channel,"Cost(Active)","Cost Currency(Active)","Base Cost(Active)","Base Cost Currency(Active)"';
const CSV_A = [CSV_HEAD, "SELL-1,A-C1-S1,justfab-us,10.5,USD,,", "SELL-4,A-C1-S4,justfab-us,,,,"].join("\r\n");
const CSV_B = [CSV_HEAD, "SELL-4,A-C1-S4,justfab-us,,,12,USD"].join("\r\n");
const sandbox = { fetch: async (u) => ({ ok: true, status: 200, text: async () => (String(u).includes("b.csv") ? CSV_B : String(u).includes("a.csv") ? CSV_A : CSV) }), chrome, console, setTimeout: (f, ms) => (ms >= 30000 ? 0 : (Promise.resolve().then(f), 0)), clearTimeout() {}, setInterval: () => 0, clearInterval() {}, importScripts() {}, URL, JSON, Date, Math, Object, Array, Set, Map, Promise, Error, String, Number, RegExp };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const [f, name] of [["src/config.js", "FMSConfig"], ["src/pageRun.js", "PageRun"]]) {
  vm.runInContext(read(f).replace(/if \(typeof module[\s\S]*$/, "") + "\nthis." + name + " = " + name + ";", sandbox);
}
vm.runInContext(read("src/baseData.js").replace(/if \(typeof module[\s\S]*$/, "") + "\nthis.FMSBaseData = FMSBaseData;", sandbox);
vm.runInContext(read("src/baseDataSync.js") + "\nthis.BaseDataSync = BaseDataSync;", sandbox);
vm.runInContext(read("src/fmsSync.js") + "\nthis.FMSSync = FMSSync;", sandbox);
vm.runInContext(read("src/billGen.js").replace(/if \(typeof module[\s\S]*$/, "") + "\nthis.BillGen = BillGen;", sandbox);
for (const [f, name] of [["src/monthFlow.js", "MonthFlow"], ["src/loopWorker.js", "LoopWorker"]]) {
  vm.runInContext(read(f).replace(/if \(typeof module[\s\S]*$/, "") + "\nthis." + name + " = " + name + ";", sandbox);
}
vm.runInContext(read("background.js") + "\nthis.runMatchJob = runMatchJob; this.runMatchQuery = runMatchQuery; this.runMatchResolve = runMatchResolve;", sandbox);

(async () => {
  const reset = () => { Object.keys(store).forEach((k) => delete store[k]); calls.length = 0; };

  reset();
  fmsResult = { ok: true, total: 802, missing, byShop: { JUSTFAB: { total: 5, missing: 5 }, shoedazzle: { total: 2, missing: 2 } }, log: [] };
  ehResult = { ok: true, results: { "justfab-us": { url: "https://file.example/x.csv", fileName: "admin_pricing-1.csv" } }, log: [] };
  await sandbox.runMatchJob("TIJN", ["JUSTFAB"]);
  let j = store.matchJob;
  assert.strictEqual(j.running, false);
  assert.strictEqual(j.stats.missing, 7);
  assert.strictEqual(j.stats.skus, 7);
  assert.strictEqual(j.stats.matched, 2);
  assert.strictEqual(j.stats.unresolved, 5);
  assert.deepStrictEqual(j.stats.skipped, { shoedazzle: 2 });
  assert.strictEqual(j.rows.length, 2);
  assert.ok(/全量匹配_/.test(j.fileName), j.fileName);
  assert.ok(/没有成本|搜不到|币种/.test(j.unresolved), j.unresolved);
  assert.ok(/没有成本/.test(j.unresolved) && /A-C1-S2/.test(j.unresolved), "只有 Pending 成本的 SKU 不补：" + j.unresolved);
  assert.deepStrictEqual(calls.map((c) => c[0]), ["fetchBaseDataMissingRows", "fetchEhExportLinks"]);
  assert.deepStrictEqual(calls[0][1], ["TIJN", ["JUSTFAB"]]);
  assert.deepStrictEqual(calls[1][1], [["justfab-us"], "TIJN", []]); // TIJN 没有特殊对应，按「商户名包含品牌名」 // 只去 EH 读有对应渠道的店铺
  console.log("ok  runMatchJob：读 FMS → 读 EH 对应渠道 → 匹配，统计和未解决原因正确");

  reset();
  fmsResult = { ok: true, total: 120, missing: [], byShop: {}, log: [] };
  await sandbox.runMatchJob("TIJN", ["JUSTFAB"]);
  j = store.matchJob;
  assert.strictEqual(j.running, false);
  assert.strictEqual(j.kind, "ok");
  assert.ok(/没有缺结算价/.test(j.text), j.text);
  assert.deepStrictEqual(calls.map((c) => c[0]), ["fetchBaseDataMissingRows"], "没有缺价就不用去 EH");
  console.log("ok  没有缺价：直接报告，不打开 EH");

  reset();
  fmsResult = { ok: false, error: "等待超时: 品牌商选项「X」", log: ["a"] };
  await sandbox.runMatchJob("X", []);
  j = store.matchJob;
  assert.strictEqual(j.kind, "error");
  assert.ok(/查询 FMS 缺失 SKU 失败/.test(j.text) && /品牌商选项/.test(j.text), j.text);
  console.log("ok  读 FMS 失败：报错带原因");

  reset();
  fmsResult = { ok: true, total: 10, missing: [fmsRow("shoedazzle", "Z-1")], byShop: {}, log: [] };
  await sandbox.runMatchJob("TIJN", ["shoedazzle"]);
  j = store.matchJob;
  assert.strictEqual(j.stats.matched, 0);
  assert.deepStrictEqual(calls.map((c) => c[0]), ["fetchBaseDataMissingRows"], "没有任何 EH 渠道时不去 EH");
  console.log("ok  只有无渠道店铺：不去 EH，全部列入跳过");

  {
    const p = B.parseEhPricingCsv(CSV);
    assert.strictEqual(p.count, 3);
    assert.strictEqual(p.skus["A-C1-S1"].cost, "10.5");
    assert.strictEqual(p.skus["A-C1-S1"].source, "Cost(Active)");
    assert.strictEqual(p.skus["A-C1-S4"].source, "Base Cost(Active)");
    assert.strictEqual(p.skus["A-C1-S2"].cost, "");
    assert.strictEqual(p.noCost, 1);
    assert.deepStrictEqual(B.parseCsv('a,"b,""c""\nd",e\r\n'), [["a", 'b,"c"\nd', "e"]]);
    assert.throws(() => B.parseEhPricingCsv("x,y\n1,2"), /缺少/);
    console.log("ok  EH 导出 CSV 解析：Cost(Active) 优先，其次 Base Cost(Active)，只有 Pending 的算没成本");
  }
  {
    assert.deepStrictEqual(B.ehMerchantsOf("Attraco"), ["Attraco-Drop Ship", "Attraco"]);
    assert.deepStrictEqual(B.ehMerchantsOf("V for City"), ["Attraco-Drop Ship", "Attraco"]);
    assert.deepStrictEqual(B.ehMerchantsOf("attraco-b"), ["Attraco-Drop Ship", "Attraco"]);
    assert.deepStrictEqual(B.ehMerchantsOf("CHARMO"), ["Attraco-Drop Ship", "Attraco"]);
    assert.deepStrictEqual(B.ehMerchantsOf("Ecosusi"), ["BAGSMART"]);
    assert.deepStrictEqual(B.ehMerchantsOf("Camel"), ["Camel"]);
    assert.deepStrictEqual(B.ehMerchantsOf("Camel Crown"), ["Camel Crown"]);
    assert.deepStrictEqual(B.ehMerchantsOf("TIJN"), []);
    assert.deepStrictEqual(B.ehMerchantsOf("Pretty Garden"), []);
    console.log("ok  品牌 → EH 商户对应关系");
  }
  {
    // 两步拆开：第二步失败，第一步的结果还在，重试第二步不用再读 FMS
    reset();
    fmsResult = { ok: true, total: 802, missing, byShop: { JUSTFAB: { total: 5, missing: 5 } }, log: [] };
    await sandbox.runMatchQuery("TIJN", ["JUSTFAB"]);
    let j2 = store.matchJob;
    assert.strictEqual(j2.stage, "queried");
    assert.strictEqual(j2.running, false);
    assert.ok(j2.fms && j2.fms.missing.length === 7 && j2.fms.brand === "TIJN");
    assert.strictEqual(j2.stats.skus, 7);
    assert.strictEqual(j2.stats.matched, null);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["fetchBaseDataMissingRows"], "第一步只读 FMS，不碰 EH");

    calls.length = 0;
    ehResult = { ok: false, error: "Merchant 选择未生效", log: [] };
    await sandbox.runMatchResolve();
    j2 = store.matchJob;
    assert.strictEqual(j2.kind, "error");
    assert.strictEqual(j2.stage, "queried", "失败后仍可重试第二步");
    assert.ok(j2.fms && j2.fms.missing.length === 7, "第一步结果没丢");
    assert.ok(/可以直接重试/.test(j2.text), j2.text);
    assert.strictEqual(j2.stats.skus, 7);

    calls.length = 0;
    ehResult = { ok: true, results: { "justfab-us": { url: "https://file.example/x.csv", fileName: "admin_pricing-1.csv" } }, log: [] };
    await sandbox.runMatchResolve();
    j2 = store.matchJob;
    assert.strictEqual(j2.stage, "matched");
    assert.strictEqual(j2.stats.matched, 2);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["fetchEhExportLinks"], "重试第二步不再读 FMS");
    console.log("ok  拆成两步：第二步失败不丢第一步结果，重试只跑第二步");

    reset();
    await sandbox.runMatchResolve();
    assert.strictEqual(store.matchJob.kind, "error");
    assert.ok(/请先做第一步/.test(store.matchJob.text));
    console.log("ok  没做第一步直接点第二步：提示先做第一步");
  }
  {
    // 一个品牌对应多个 EH 商户：每个商户一个文件，合并后再匹配
    reset();
    fmsResult = { ok: true, total: 802, missing, byShop: { JUSTFAB: { total: 5, missing: 5 } }, log: [] };
    await sandbox.runMatchQuery("TIJN", ["JUSTFAB"]);
    calls.length = 0;
    ehResult = { ok: true, results: { "justfab-us": { files: [{ url: "https://file.example/a.csv", fileName: "a.csv", merchant: "TIJN-Consignment" }, { url: "https://file.example/b.csv", fileName: "b.csv", merchant: "TIJN-Drop Ship" }] } }, log: [] };
    await sandbox.runMatchResolve();
    const j3 = store.matchJob;
    assert.strictEqual(j3.stage, "matched");
    assert.strictEqual(j3.stats.matched, 2, "两个商户的成本合并后，A-C1-S1 和 A-C1-S4 都能补: " + j3.text);
    console.log("ok  多个商户各导出一个文件：合并后匹配，有成本的不被没成本的覆盖");
  }
  console.log("\n全部通过");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
