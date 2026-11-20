// 在假 FMS 页面里跑插件的「页面注入函数」。
// 每个注入函数都会被 toString 后在全局作用域重新 eval 一遍再调用——跟 chrome.scripting.executeScript
// 序列化函数的方式一样，这样能暴露「函数不是自包含」的问题。
// 用法：打开 http://localhost:5300/fake/index.html，在控制台（或浏览器工具里）执行 await __runTests()
(() => {
  const F = window.__fake;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const inject = (fn) => (0, eval)("(" + fn.toString() + ")");
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const tests = [];
  const test = (name, fn, opts) => tests.push({ name, fn, slow: !!(opts && opts.slow) });

  async function fresh(overrides, page) {
    F.reset(overrides);
    F.goto(page || "bill");
    await sleep(80); // 故意不等页面默认查询返回，让「默认查询晚返回」的竞态真实存在
  }
  const waitLog = async (action, ms = 6000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (F.db.log.some((l) => l.action === action)) return;
      await sleep(100);
    }
    throw new Error("等待日志超时: " + action);
  };
  const logs = (action) => F.db.log.filter((l) => l.action === action);
  const listBills = async () => {
    const r = await inject(FMSSync.fetchBillList)();
    assert(r.ok, "fetchBillList 失败: " + r.error);
    return r.records;
  };
  const statusOf = async (no) => {
    const b = (await listBills()).find((x) => x.settlementNo === no);
    return b && b.settlementStatus;
  };

  // 用插件自己的代码生成一份真实的基础数据模板 → base64
  async function templateBase64(skus) {
    const rows = skus.map((s) => ({
      站点: "US", 店铺: "JUSTFAB", 品牌: "Imily Bela", "MM SKU": s, "Brand SKU": "CP_" + s, "MM Style": "A", "MM Color": "Khaki", "MM Size": "S",
      结算币种: "USD", 结算单价: 22.3, 数据状态: "", 备注: "",
    }));
    const wb = FMSBaseData.toWorkbook(ExcelJS, rows);
    const buf = await wb.xlsx.writeBuffer();
    let bin = "";
    new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  }

  // ---------------- 账单列表 ----------------
  test("fetchBillList：读到全部账单，字段齐全", async () => {
    await fresh();
    const recs = await listBills();
    assert(recs.length === 7, "应有 7 条，实际 " + recs.length);
    const b = recs.find((x) => x.settlementNo === "SETA0002");
    assert(b.brandName === "Imily Bela" && b.shopCode === "JUSTFAB" && b.accountingMonth === "2026-09" && b.settlementStatus === "PENDING_CONFIRM", "字段不对 " + JSON.stringify(b));
  });

  test("fetchBillList：页面记住了品牌筛选 → 先重置，仍读到全部账单", async () => {
    await fresh({ config: { initialBrandFilter: "Imily Bela" } });
    const recs = await listBills();
    assert(recs.length === 7, "应有 7 条，实际 " + recs.length);
  });

  test("fetchBillList：记住的筛选筛出 0 条（分页组件不显示）→ 不卡住，读到全部账单", async () => {
    await fresh({ config: { initialBrandFilter: "不存在的品牌" } });
    const recs = await listBills();
    assert(recs.length === 7, "应有 7 条，实际 " + recs.length);
  });

  test("生成账单：页面残留了别的品牌的筛选 → 新账单仍能被读到", async () => {
    await fresh({ config: { initialBrandFilter: "Imily Bela" } });
    const r = await inject(BillGen.generateBill)("Where's That From", "Justfab EU", "2026-10");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    await waitLog("generate:done");
    const found = BillGen.findBills(await listBills(), "Where's That From", "Justfab EU", "2026-10");
    assert(found.length === 1, "新账单没读到 " + JSON.stringify(found));
  });

  test("读取品牌清单：读到 FMS 下拉里的全部品牌，并关掉弹窗、不提交", async () => {
    await fresh();
    const r = await inject(BillGen.listBrands)();
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(r.brands.length >= 20 && r.brands.includes("Imily Bela"), "品牌清单不对 " + JSON.stringify(r.brands));
    await sleep(600);
    const open = [...document.querySelectorAll(".el-dialog")].filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== "none");
    assert(open.length === 0, "弹窗没关掉");
    assert(logs("generate").length === 0, "不应该提交生成");
  });

  // ---------------- 生成账单 ----------------
  test("生成账单：基础数据完整 → 点确认 → 新账单出现，状态待生成请款单", async () => {
    await fresh();
    const r = await inject(BillGen.generateBill)("Imily Bela", "JUSTFAB", "2026-10");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const g = logs("generate");
    assert(g.length === 1 && g[0].brand === "Imily Bela" && g[0].shop === "JUSTFAB" && g[0].month === "2026-10", "提交的参数不对 " + JSON.stringify(g));
    assert(r.messages.some((m) => /已提交/.test(m)), "没捕获到页面提示: " + JSON.stringify(r.messages));
    await waitLog("generate:done");
    const found = BillGen.findBills(await listBills(), "Imily Bela", "JUSTFAB", "2026-10");
    assert(found.length === 1 && found[0].settlementStatus === "PENDING_GENERATE_REQUEST", "新账单没找到或状态不对 " + JSON.stringify(found));
  });

  test("生成账单：往前翻年份选 2025-11", async () => {
    await fresh();
    const r = await inject(BillGen.generateBill)("Dorina", "Justfab EU", "2025-11");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const g = logs("generate")[0];
    assert(g && g.month === "2025-11" && g.shop === "Justfab EU", "参数不对 " + JSON.stringify(g));
  });

  test("生成账单：后台标签页（动画帧暂停）里也能选上品牌/店铺/月份——排在后面的品牌也行", async () => {
    // 浏览器会暂停后台标签页的动画帧，Element Plus 的下拉和日期面板会卡在「刚出现、缩放为 0」的状态
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    try {
      await fresh();
      const r = await inject(BillGen.generateBill)("CAMEL", "Justfab EU", "2026-10");
      assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
      const g = logs("generate");
      assert(g.length === 1 && g[0].brand === "CAMEL" && g[0].shop === "Justfab EU" && g[0].month === "2026-10", "参数不对 " + JSON.stringify(g));
    } finally {
      window.requestAnimationFrame = raf;
    }
  });

  test("生成账单：同一个 vendor 的多个品牌在同一页面里连续生成（不刷新页面）", async () => {
    await fresh();
    const r1 = await inject(BillGen.generateBill)("Imily Bela", "Justfab EU", "2026-10");
    assert(r1.ok, "第一个失败: " + r1.error);
    const r2 = await inject(BillGen.generateBill)("Dorina", "Justfab EU", "2026-10");
    assert(r2.ok, "第二个失败: " + r2.error + " | " + (r2.log || []).join(">"));
    const g = logs("generate").map((x) => x.brand);
    assert(g.join() === "Imily Bela,Dorina", "应依次生成两个品牌 " + g.join());
    await waitLog("generate:done");
    await sleep(900);
    const recs = await listBills();
    assert(BillGen.findBills(recs, "Imily Bela", "Justfab EU", "2026-10").length === 1 && BillGen.findBills(recs, "Dorina", "Justfab EU", "2026-10").length === 1, "两个品牌的新账单都应读到");
  });

  test("生成账单：缺基础数据的品牌 → 新账单状态待确认", async () => {
    await fresh();
    const r = await inject(BillGen.generateBill)("Attraco", "JUSTFAB", "2026-10");
    assert(r.ok, r.error);
    await waitLog("generate:done");
    const found = BillGen.findBills(await listBills(), "Attraco", "JUSTFAB", "2026-10");
    assert(found.length === 1 && found[0].settlementStatus === "PENDING_CONFIRM", "状态不对 " + JSON.stringify(found));
  });

  test("生成账单：品牌下拉里没有该选项 → 报错，且没有提交", async () => {
    await fresh();
    const r = await inject(BillGen.generateBill)("不存在的品牌", "JUSTFAB", "2026-10");
    assert(!r.ok && /品牌选项/.test(r.error), "应报品牌选项错误: " + JSON.stringify(r));
    assert(logs("generate").length === 0, "不该提交");
  });

  test("生成账单：该月账单已存在 → 页面报错提示被捕获", async () => {
    await fresh();
    const r = await inject(BillGen.generateBill)("Imily Bela", "JUSTFAB", "2026-09");
    assert(r.ok, r.error);
    assert(r.messages.some((m) => /已存在/.test(m)), "应捕获「已存在」提示: " + JSON.stringify(r.messages));
  });

  // ---------------- 重新生成 ----------------
  test("重新生成（弹确认框）：基础数据还没导入 → 点了并确认，状态仍待确认", async () => {
    await fresh();
    const r = await inject(BillGen.regenerateBill)("SETA0002");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(/确认重新生成账单 SETA0002/.test(r.dialogText), "没抓到确认框内容: " + r.dialogText);
    assert(logs("regenerate").length === 1 && logs("regenerate")[0].billNo === "SETA0002", "应只对 SETA0002 点一次");
    await waitLog("regenerate:done");
    assert((await statusOf("SETA0002")) === "PENDING_CONFIRM", "缺数据时状态不该变");
  });

  test("重新生成（弹确认框）：基础数据已导入 → 状态变成待生成请款单", async () => {
    await fresh({ baseData: ["IB-A-S1", "IB-A-S2"] });
    const r = await inject(BillGen.regenerateBill)("SETA0002");
    assert(r.ok, r.error);
    await waitLog("regenerate:done");
    assert((await statusOf("SETA0002")) === "PENDING_GENERATE_REQUEST", "状态应变成待生成请款单");
  });

  test("重新生成（不弹确认框）：直接生效", async () => {
    await fresh({ baseData: ["IB-A-S1", "IB-A-S2"], config: { regenConfirm: false } });
    const r = await inject(BillGen.regenerateBill)("SETA0002");
    assert(r.ok, r.error);
    assert(r.dialogText === "", "不该有弹窗，实际: " + r.dialogText);
    await waitLog("regenerate:done");
    assert((await statusOf("SETA0002")) === "PENDING_GENERATE_REQUEST", "状态应变");
  });

  test("重新生成：账单不是待确认（待生成请款单）→ 拒绝，没有点", async () => {
    await fresh();
    const r = await inject(BillGen.regenerateBill)("SETA0001");
    assert(!r.ok && /不是「待确认」/.test(r.error), "应拒绝: " + JSON.stringify(r));
    assert(logs("regenerate").length === 0, "不该点重新生成");
  });

  test("重新生成：账单已付款 → 拒绝，没有点", async () => {
    await fresh();
    const r = await inject(BillGen.regenerateBill)("SETA0003");
    assert(!r.ok && /已付款/.test(r.error), "应拒绝: " + JSON.stringify(r));
    assert(logs("regenerate").length === 0, "不该点重新生成");
  });

  test("重新生成：页面默认查询很晚才返回（盖掉筛选结果）→ 重试后仍只处理目标账单", async () => {
    await fresh({ baseData: ["LH-1"], config: { initialQueryDelayMs: 2500 } });
    const r = await inject(BillGen.regenerateBill)("SETA0004");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const rg = logs("regenerate");
    assert(rg.length === 1 && rg[0].billNo === "SETA0004", "只应对 SETA0004 点一次，实际 " + JSON.stringify(rg));
  });

  test("重新生成：筛选后接着读账单列表（后台轮询的做法）能读到这张账单的新状态", async () => {
    await fresh({ baseData: ["IB-A-S1", "IB-A-S2"] });
    const r = await inject(BillGen.regenerateBill)("SETA0002");
    assert(r.ok, r.error);
    await waitLog("regenerate:done");
    const recs = await listBills();
    const b = recs.find((x) => x.settlementNo === "SETA0002");
    assert(b && b.settlementStatus === "PENDING_GENERATE_REQUEST", "读不到新状态: " + JSON.stringify(recs.map((x) => x.settlementNo)));
  });

  test("重新生成：账单号不存在 → 报错，没有点（约 15 秒）", async () => {
    await fresh();
    const r = await inject(BillGen.regenerateBill)("NOPE-1");
    assert(!r.ok, "应失败");
    assert(logs("regenerate").length === 0, "不该点重新生成");
  }, { slow: true });

  // ---------------- 导入基础数据 ----------------
  test("导入基础数据：插件生成的模板 → 假 FMS 能解析并收下", async () => {
    await fresh({}, "data");
    const b64 = await templateBase64(["IB-A-S1", "IB-A-S2"]);
    const r = await inject(BaseDataSync.importBaseDataFile)("基础数据_TEST_20261012.xlsx", b64);
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const im = logs("import");
    assert(im.length === 1 && im[0].skus.join() === "IB-A-S1,IB-A-S2", "导入内容不对 " + JSON.stringify(im));
    assert(r.messages.some((m) => /导入任务已提交/.test(m)), "没捕获成功提示: " + JSON.stringify(r.messages));
    assert(F.db.baseData.includes("IB-A-S1"), "数据没入库");
  });

  test("导入基础数据：文件内容不对 → 页面报错被捕获", async () => {
    await fresh({}, "data");
    const r = await inject(BaseDataSync.importBaseDataFile)("坏文件.xlsx", btoa("this is not an xlsx"));
    assert(r.ok, r.error);
    assert(r.messages.some((m) => /解析失败/.test(m)), "应捕获解析失败: " + JSON.stringify(r.messages));
    assert(F.db.baseData.length === 0, "不该入库");
  });

  // ---------------- 整条链路 ----------------
  test("完整链路：生成(待确认) → 重新生成(仍待确认) → 导入基础数据 → 重新生成(变待生成请款单)", async () => {
    await fresh();
    let r = await inject(BillGen.generateBill)("Attraco", "JUSTFAB", "2026-10");
    assert(r.ok, r.error);
    await waitLog("generate:done");
    const no = BillGen.findBills(await listBills(), "Attraco", "JUSTFAB", "2026-10")[0].settlementNo;
    assert((await statusOf(no)) === "PENDING_CONFIRM", "新账单应是待确认");

    F.goto("bill");
    await sleep(80);
    r = await inject(BillGen.regenerateBill)(no);
    assert(r.ok, r.error);
    await waitLog("regenerate:done");
    assert((await statusOf(no)) === "PENDING_CONFIRM", "没补数据时重新生成不该有效果");

    F.goto("data");
    await sleep(80);
    const b64 = await templateBase64(F.db.missing[no]);
    r = await inject(BaseDataSync.importBaseDataFile)("基础数据_x.xlsx", b64);
    assert(r.ok, r.error);

    F.goto("bill");
    await sleep(80);
    F.db.log.length = 0;
    r = await inject(BillGen.regenerateBill)(no);
    assert(r.ok, r.error);
    await waitLog("regenerate:done");
    assert((await statusOf(no)) === "PENDING_GENERATE_REQUEST", "补数据后重新生成应变成待生成请款单");
  });

  // ---------------- 请款 + 上传发票 ----------------
  const pdfB64 = btoa("%PDF-1.4 fake");
  const billsOf = (...nos) => nos;
  const INV = (...names) => (names.length ? names : ["发票.pdf"]).map((n) => ({ name: n, mime: "application/pdf", b64: pdfB64 }));

  test("请款（单张）：勾选 → 请款 → 等待 → 打开费控单 → 上传发票 → 确认，停在草稿", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceAndConfirm)("SETA0005", INV());
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(JSON.stringify(logs("request").map((l) => l.nos)) === JSON.stringify([["SETA0005"]]), "请款参数不对 " + JSON.stringify(logs("request")));
    assert(logs("invoice").length === 1 && logs("invoice")[0].fileName === "发票.pdf" && logs("invoice")[0].ajf === r.ajfNo, "发票没传上 " + JSON.stringify(logs("invoice")));
  }, { slow: true });

  test("请款（单张）：业务发生日期被改成所开月份的第一天（FMS 默认是请款当天）", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceAndConfirm)("SETA0005", INV(), "2026-09");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(!r.dateNote, "不应有日期提示: " + r.dateNote);
    assert(logs("invoice")[0].bizDate === "2026-09-01", "业务发生日期应为 2026-09-01，实际 " + logs("invoice")[0].bizDate);
  }, { slow: true });

  test("请款（多张）：业务发生日期也是所开月份的第一天", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0005"], INV(), "2026-08");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(logs("invoice")[0].bizDate === "2026-08-01", "业务发生日期应为 2026-08-01，实际 " + logs("invoice")[0].bizDate);
  }, { slow: true });

  test("请款（单张）：多个发票文件 → 逐个上传，都出现在附件里", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceAndConfirm)("SETA0005", INV("发票1.pdf", "发票2.pdf", "发票3.pdf"), "2026-09");
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const inv = logs("invoice");
    assert(inv.length === 1 && JSON.stringify(inv[0].fileNames) === JSON.stringify(["发票1.pdf", "发票2.pdf", "发票3.pdf"]), "附件不对 " + JSON.stringify(inv));
  }, { slow: true });

  test("请款（单张）：没给月份时不动业务发生日期", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceAndConfirm)("SETA0005", INV());
    assert(r.ok, "返回失败: " + r.error);
    assert(logs("invoice")[0].bizDate === "2026-10-09", "不该改日期，实际 " + logs("invoice")[0].bizDate);
  }, { slow: true });

  test("请款（多张，合并成一张费控单）：一起勾选请款 → 上传一份发票", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0005"], INV());
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    const rq = logs("request");
    assert(rq.length === 1 && rq[0].nos.slice().sort().join() === "SETA0001,SETA0005", "应一次性对两张账单请款 " + JSON.stringify(rq));
    assert(logs("invoice").length === 1 && logs("invoice")[0].ajf === r.ajfNo, "应只上传一份发票 " + JSON.stringify(logs("invoice")));
    assert(r.billCount === 2 && r.lineCount === 1, "返回信息不对 " + JSON.stringify(r));
  }, { slow: true });

  test("请款（多张）：FMS 没有合并成一张费控单 → 中止，没有上传发票", async () => {
    await fresh({ config: { mergeDocs: false } });
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0005"], INV());
    assert(!r.ok && /没有把这几张账单合并成一张费控单/.test(r.error), "应中止: " + JSON.stringify(r));
    assert(logs("invoice").length === 0, "不该上传发票");
  }, { slow: true });

  test("请款（多张）：其中一张还是待确认 → 中止，一张都不请款", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0002"], INV());
    assert(!r.ok && /状态不一致/.test(r.error), "应中止: " + JSON.stringify(r));
    assert(logs("request").length === 0, "不该请款");
  });

  test("请款（多张）：已经请过款并且共用一张费控单 → 不再重复请款，直接上传发票", async () => {
    await fresh();
    F.db.bills.find((b) => b.settlementNo === "SETA0001").settlementStatus = "PENDING_REQUEST";
    F.db.bills.find((b) => b.settlementNo === "SETA0001").documentCode = "AJF900001";
    F.db.bills.find((b) => b.settlementNo === "SETA0005").settlementStatus = "PENDING_REQUEST";
    F.db.bills.find((b) => b.settlementNo === "SETA0005").documentCode = "AJF900001";
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0005"], INV());
    assert(r.ok, "返回失败: " + r.error + " | " + (r.log || []).join(">"));
    assert(logs("request").length === 0, "不该再请款");
    assert(logs("invoice").length === 1 && logs("invoice")[0].ajf === "AJF900001", "发票没传到这张费控单");
  });

  test("请款（多张）：报账明细有 2 行 → 发票附在第一行，并返回行数提醒", async () => {
    await fresh({ config: { docLines: 2 } });
    F.db.bills.find((b) => b.settlementNo === "SETA0001").settlementStatus = "PENDING_REQUEST";
    F.db.bills.find((b) => b.settlementNo === "SETA0001").documentCode = "AJF900002";
    F.db.bills.find((b) => b.settlementNo === "SETA0005").settlementStatus = "PENDING_REQUEST";
    F.db.bills.find((b) => b.settlementNo === "SETA0005").documentCode = "AJF900002";
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "SETA0005"], INV());
    assert(r.ok && r.lineCount === 2, "应返回 lineCount=2: " + JSON.stringify(r));
    assert(logs("invoice")[0].line === 1, "应附在第一行");
  });

  test("请款（多张）：账单编号里有不存在的 → 显示的账单对不上，中止，不请款（约 10 秒）", async () => {
    await fresh();
    const r = await inject(FMSAutomation.submitInvoiceMulti)(["SETA0001", "NOPE-9"], INV());
    assert(!r.ok && /不一致/.test(r.error), "应中止: " + JSON.stringify(r));
    assert(logs("request").length === 0, "不该请款");
  }, { slow: true });

  window.__runTests = async (filter) => {
    const results = [];
    for (const t of tests) {
      if (filter && !t.name.includes(filter)) continue;
      const start = Date.now();
      try {
        await t.fn();
        results.push({ name: t.name, ok: true, ms: Date.now() - start });
      } catch (e) {
        results.push({ name: t.name, ok: false, ms: Date.now() - start, error: e.message });
      }
    }
    const fail = results.filter((r) => !r.ok);
    document.title = (fail.length ? "FAIL " + fail.length : "PASS") + " / " + results.length;
    return results;
  };
})();
