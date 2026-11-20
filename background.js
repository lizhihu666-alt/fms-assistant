// 后台服务 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 为什么要放在后台：popup 弹窗一失去焦点（比如去点别的标签页看进度）就会被浏览器关掉，
// 里面正在跑的任务也跟着停了。耗时的任务（补基础数据要后台开 FMS 和 EH 两个标签页）改在这里跑，
// 弹窗关了也不受影响；进度写进 chrome.storage.local，弹窗重新打开（或一直开着）都能看到最新状态。

// 清洗对账表要用到的库；万一加载失败，只让清洗不能用，不影响别的功能
importScripts("src/config.js", "src/pageRun.js");

let CLEAN_READY = true;
try {
  importScripts("libs/xlsx.full.min.js", "libs/exceljs.min.js", "src/cleaner.js", "src/fmsAutomation.js");
} catch (e) {
  CLEAN_READY = false;
  console.error("清洗模块加载失败", e);
}
importScripts("src/baseData.js", "src/baseDataSync.js", "src/fmsSync.js", "src/billGen.js", "src/monthFlow.js", "src/loopWorker.js");

// 点工具栏图标打开侧边栏（侧边栏切换标签页也不会关，不像弹窗一失焦就消失）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error(e));
}

const BILL_FILL_KEY = "billFillJob"; // 请款第 3 步「补充数据」的任务状态（从一张账单出发补结算价）
// v0.10.34 起由 baseJob 改名：把旧的挪过来（只会做一次）
chrome.storage.local.get("baseJob").then((r) => {
  if (r && r.baseJob) chrome.storage.local.set({ billFillJob: r.baseJob }).then(() => chrome.storage.local.remove("baseJob"));
});
const STALE_JOB_MS = 10 * 60 * 1000; // 超过10分钟还显示"运行中"，认为是上次异常中断留下的，允许重新开始

async function setJob(patch) {
  const cur = (await chrome.storage.local.get(BILL_FILL_KEY))[BILL_FILL_KEY] || {};
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ [BILL_FILL_KEY]: next });
  return next;
}

// 在网页里执行注入函数（规矩见 src/pageRun.js 开头）
const runStep = PageRun.run;

function waitTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") listener(tabId, { status: "complete" });
    });
  });
}

// 在后台新开一个标签页（不抢焦点）跑 fn，跑完自动关；如果被跳到登录页，把它切到前台让用户登录。
// opts.foreground：写入类操作（生成账单、重新生成、导入）要在前台标签页里跑——
// 后台标签页里浏览器会暂停动画帧和限制定时器，Element Plus 的下拉、日期面板、弹窗会卡在半开状态，
// 自动选择就会时灵时不灵（有的品牌选得上、有的选不上）。跑完自动切回用户原来看的标签页。
const TEMP_TABS = new Set();
async function withTab(url, name, fn, opts) {
  const foreground = !!(opts && opts.foreground);
  const quiet = !!(opts && opts.quiet); // 自动任务用：登录过期时不把登录页弹到前台，只报错
  const target = new URL(url);
  let prevTab = null;
  if (foreground) {
    try {
      prevTab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
    } catch (e) {}
  }
  const tab = await chrome.tabs.create({ url, active: foreground });
  TEMP_TABS.add(tab.id); // 插件自己临时开的标签页：侧边栏找「FMS 页面」时要绕开它们（它们马上会被关掉）
  let keep = false;
  const onTarget = async () => {
    const u = new URL((await chrome.tabs.get(tab.id)).url);
    return u.origin === target.origin && u.pathname.startsWith(target.pathname);
  };
  const needLogin = async () => {
    if (quiet) throw new Error(`${name} 登录已过期`);
    keep = true;
    await chrome.tabs.update(tab.id, { active: true });
    throw new Error(`${name} 登录已过期，已为你打开登录页。登录完成后回到插件，重新操作一次。`);
  };
  try {
    await waitTabComplete(tab.id);
    if (!(await onTarget())) await needLogin();
    try {
      return await fn(tab.id);
    } catch (e) {
      if (!(await onTarget())) await needLogin();
      throw e;
    }
  } finally {
    // 等标签页真的关掉再返回：否则调用方紧接着查标签页，会把这个「正在关闭」的标签页当成 FMS 页面去刷新
    if (!keep) await chrome.tabs.remove(tab.id).catch(() => {});
    TEMP_TABS.delete(tab.id);
    if (foreground && !keep && prevTab && prevTab.id != null) chrome.tabs.update(prevTab.id, { active: true }).catch(() => {});
  }
}

// billNos：要补数据的账单（都是「待确认」的）。多张账单（同一个 vendor 下的多个品牌）会逐张读缺价明细，
// 合并成一份模板（模板里每行带品牌/店铺，本来就是按 SKU 导入，合并不影响）一次导入。
async function runBaseDataJob(billNos) {
  // 任务比较长，定时调一个扩展 API 防止服务被浏览器因空闲回收
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const progress = (text, kind) => setJob({ text, kind: kind || "", unresolved: "", rows: [], fileName: "" });
  const multi = billNos.length > 1;
  const billNo = billNos[0];
  try {
    const fms = { missing: [], total: 0 };
    for (let i = 0; i < billNos.length; i++) {
      await progress(multi ? `正在读取第 ${i + 1}/${billNos.length} 张账单（${billNos[i]}）缺结算价的明细…` : "正在读取这张账单里缺结算价的明细…", "busy");
      const one = await withTab(FMSConfig.FMS_BILL_URL, "FMS", (tabId) =>
        runStep(tabId, BaseDataSync.fetchBillMissingRows, [billNos[i]], "读取缺价明细")
      );
      fms.missing.push(...one.missing);
      fms.total += one.total;
    }
    if (!fms.missing.length) {
      await setJob({
        running: false,
        text: multi
          ? `这 ${billNos.length} 张账单共 ${fms.total} 行明细，没有缺结算价的行。请确认它们的状态是不是「待确认」。`
          : `账单 ${billNo} 共 ${fms.total} 行明细，没有缺结算价的行。请确认这张账单的状态是不是「待确认」。`,
        kind: "ok",
      });
      return;
    }

    const plan = FMSBaseData.planMissing(fms.missing);
    let eh = {};
    if (plan.jobs.length) {
      const skuCount = plan.jobs.reduce((n, j) => n + j.skus.length, 0);
      await progress(`缺价明细 ${fms.missing.length} 行，涉及 ${plan.items.length} 个 SKU。正在去 EH 查结算价（${skuCount} 个待查）…`, "busy");
      // EH 的下拉/选择操作依赖动画，放后台标签页里会被浏览器暂停，所以这一步开前台标签页，跑完切回
      const res = await withTab(
        FMSConfig.EH_PRICING_URL,
        "EH",
        (tabId) => runStep(tabId, BaseDataSync.fetchEhCosts, [plan.jobs], "读取 EH 结算价"),
        { foreground: true }
      );
      eh = res.results;
    }

    const out = FMSBaseData.resolve(plan.items, eh);
    const lines = out.unresolved.slice(0, 15).map((u) => `${u.item.sku}（${u.item.shop}/${u.item.site}）：${u.reason}`);
    if (out.unresolved.length > 15) lines.push(`…还有 ${out.unresolved.length - 15} 个`);
    await setJob({
      running: false,
      kind: out.unresolved.length ? "" : "ok",
      text:
        `共 ${plan.items.length} 个缺价 SKU：已填好 ${out.rows.length} 个` +
        (out.unresolved.length ? `，需人工处理 ${out.unresolved.length} 个（见下方）` : "") +
        (out.rows.length ? "。请先检查模板，没问题就点下面的「一键导入」。" : "。"),
      unresolved: lines.length ? "需要人工处理：\n" + lines.join("\n") : "",
      rows: out.rows,
      fileName: out.rows.length ? FMSBaseData.fileName(multi ? billNo + "等" + billNos.length + "张" : billNo) : "",
    });
  } catch (err) {
    console.error(err);
    await setJob({ running: false, text: "生成基础数据导入文件失败：" + err.message, kind: "error", unresolved: "", rows: [], fileName: "" });
  } finally {
    clearInterval(keepAlive);
  }
}

// ---- 全量匹配：不等账单缺数据，主动把一个品牌在 FMS「基础数据」里缺结算价的行，全部到 EH 去找成本补上 ----
const MATCH_KEY = "matchJob";
async function setMatch(patch) {
  const cur = (await chrome.storage.local.get(MATCH_KEY))[MATCH_KEY] || {};
  await chrome.storage.local.set({ [MATCH_KEY]: Object.assign({}, cur, patch) });
}
// 第一步：只在 FMS 基础数据里查出这个品牌缺结算价的 SKU，结果存起来（第二步失败可以只重做第二步，不用重查）
async function runMatchQuery(brand, shops) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const reset = { stats: null, unresolved: "", rows: [], fileName: "", warnings: [] };
  try {
    await setMatch({ ...reset, stage: "", fms: null, text: "正在读取 FMS 基础数据（" + brand + "）…", kind: "busy" });
    // 选下拉、翻页都依赖页面动画，放后台标签页会被浏览器暂停，所以开前台标签页，跑完自动切回
    const fms = await withTab(
      FMSConfig.FMS_BASEDATA_URL,
      "FMS",
      (tabId) => runStep(tabId, BaseDataSync.fetchBaseDataMissingRows, [brand, shops], "读取 FMS 基础数据"),
      { foreground: true }
    );
    if (!fms.missing.length) {
      await setMatch({ running: false, kind: "ok", stats: { total: fms.total, missing: 0, byShop: fms.byShop, skus: 0, matched: 0, unresolved: 0, skipped: {} }, text: brand + " 在 FMS 基础数据里共 " + fms.total + " 行，没有缺结算价的。" });
      return;
    }
    const { plan, skippedShops } = FMSBaseData.planFromFmsRows(fms.missing);
    const stats = { total: fms.total, missing: fms.missing.length, byShop: fms.byShop, skus: plan.items.length, skipped: skippedShops };
    const noChannel = !plan.jobs.length;
    await setMatch({
      running: false,
      kind: noChannel ? "" : "ok",
      stage: noChannel ? "" : "queried",
      fms: noChannel ? null : { brand, shops, total: fms.total, byShop: fms.byShop, missing: fms.missing, stats },
      stats: noChannel ? { ...stats, matched: 0, unresolved: 0 } : { ...stats, matched: null, unresolved: null },
      text: noChannel
        ? "FMS 缺价 " + fms.missing.length + " 行，但这些店铺都没有对应的 EH 渠道，没法去 EH 匹配。"
        : "已查到 FMS 缺价 " + fms.missing.length + " 行（" + plan.items.length + " 个 SKU）。",
    });
  } catch (err) {
    console.error(err);
    await setMatch({ running: false, kind: "error", ...reset, stage: "", fms: null, text: "查询 FMS 缺失 SKU 失败：" + err.message });
  } finally {
    clearInterval(keepAlive);
  }
}

// 第二步：用第一步存下的缺价 SKU，去 EH 导出成本并匹配。失败时保留第一步的结果，可以直接重试
async function runMatchResolve() {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const job0 = (await chrome.storage.local.get(MATCH_KEY))[MATCH_KEY] || {};
  const fms = job0.fms;
  const clear = { unresolved: "", unresolvedList: [], rows: [], fileName: "", warnings: [] };
  try {
    if (!fms || !fms.missing || !fms.missing.length) {
      await setMatch({ running: false, kind: "error", ...clear, text: "请先做第一步：查询 FMS 缺失 SKU" });
      return;
    }
    const brand = fms.brand;
    const { plan, skippedShops } = FMSBaseData.planFromFmsRows(fms.missing);
    const baseStats = fms.stats || { total: fms.total, missing: fms.missing.length, byShop: fms.byShop, skus: plan.items.length, skipped: skippedShops };
    const pendingStats = { ...baseStats, matched: null, unresolved: null };
    const failEh = (text) => setMatch({ running: false, kind: "error", ...clear, stage: "queried", stats: pendingStats, text });
    const chans = plan.jobs.map((j) => j.channel);
    const eh = {};
    await setMatch({ ...clear, stats: pendingStats, text: "正在读取 EH（" + chans.join("、") + "）的成本…", kind: "busy" });
    const res = await withTab(
      FMSConfig.EH_PRICING_URL,
      "EH",
      (tabId) => runStep(tabId, BaseDataSync.fetchEhExportLinks, [chans, brand, FMSBaseData.ehMerchantsOf(brand)], "导出 EH 成本"),
      { foreground: true }
    );
    // 导出文件由后台取回并解析：成本优先取 Cost(Active)，没有再取 Base Cost(Active)
    for (const ch of chans) {
      const r = res.results[ch] || {};
      const files = r.files || (r.url ? [{ url: r.url, fileName: r.fileName }] : []);
      if (r.error || !files.length) { eh[ch] = { skus: {}, count: 0, error: r.error || "没有拿到导出文件" }; continue; }
      try {
        // 一个商户一个文件，合并后再和缺价 SKU 对比；已经有成本的不被没成本的覆盖
        const merged = {};
        for (const f of files) {
          await setMatch({ text: "EH（" + ch + "）导出已生成，正在读取 " + f.fileName + "…", kind: "busy" });
          const resp = await fetch(f.url);
          if (!resp.ok) throw new Error("下载导出文件失败 HTTP " + resp.status);
          const parsed = FMSBaseData.parseEhPricingCsv(await resp.text());
          for (const [k, v] of Object.entries(parsed.skus)) {
            if (!merged[k] || (merged[k].cost === "" && v.cost !== "")) merged[k] = v;
          }
        }
        eh[ch] = { skus: merged, count: Object.keys(merged).length };
      } catch (e) {
        eh[ch] = { skus: {}, count: 0, error: (e && e.message) || String(e) };
      }
    }
    // 所有渠道都读取失败：直接报告失败原因，别当成「补不上」
    const ehErrors = Object.entries(eh).filter(([, v]) => v && v.error);
    if (ehErrors.length === Object.keys(eh).length) {
      await failEh("读取 EH 失败：" + ehErrors.map(([ch, v]) => ch + "：" + v.error).join("；") + "（第一步的结果还在，可以直接重试第二步）");
      return;
    }

    const out = FMSBaseData.resolve(plan.items, eh);
    // 按原因归类，比一长串 SKU 好看；每类只列前几个
    const groups = new Map();
    for (const u of out.unresolved) {
      const key = u.reason.replace(/（[^）]*）/g, "").replace(/\(.*?\)/g, "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    const lines = [];
    for (const [reason, arr] of groups) {
      lines.push(reason + "（" + arr.length + " 个）");
      arr.slice(0, 5).forEach((u) => lines.push("  " + u.item.sku + "  " + u.item.shop + "/" + u.item.site));
      if (arr.length > 5) lines.push("  …还有 " + (arr.length - 5) + " 个");
    }
    const check = FMSBaseData.checkRows(out.rows);
    await setMatch({
      running: false,
      kind: out.unresolved.length || check.warnings.length ? "" : "ok",
      stage: "matched",
      stats: { ...baseStats, matched: out.rows.length, unresolved: out.unresolved.length },
      text: out.rows.length ? "EH 能补 " + out.rows.length + " 个。导入前请先下载核对。" : "没有能补上的 SKU。",
      unresolved: lines.join("\n"),
      unresolvedList: out.unresolved.map((u) => ({ sku: u.item.sku, shop: u.item.shop, site: u.item.site, reason: u.reason.replace(/（[^）]*）/g, "").replace(/\(.*?\)/g, "") })),
      warnings: check.warnings.slice(0, 10),
      rows: out.rows,
      fileName: out.rows.length ? FMSBaseData.matchFileName(brand) : "",
    });
  } catch (err) {
    console.error(err);
    await setMatch({ running: false, kind: "error", ...clear, stage: fms ? "queried" : "", text: "EH 匹配失败：" + err.message + (fms ? "（第一步的结果还在，可以直接重试第二步）" : "") });
  } finally {
    clearInterval(keepAlive);
  }
}

// 两步连着做：勾了「查完自动去 EH 匹配」时走这里（单元测试也用它）
async function runMatchJob(brand, shops) {
  await runMatchQuery(brand, shops);
  const job = (await chrome.storage.local.get(MATCH_KEY))[MATCH_KEY] || {};
  if (job.stage !== "queried") return;
  await setMatch({ running: true, startedAt: Date.now(), kind: "busy", text: "第一步完成（缺价 " + ((job.stats && job.stats.skus) || 0) + " 个 SKU），接着去 EH 匹配…" });
  await runMatchResolve();
}

// 一键导入：把人工复查过的 xlsx 传进 FMS「基础数据」→ 导入。耗时较长，直接等结果再回复。
async function runImport(fileName, base64) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const r = await withTab(
      FMSConfig.FMS_BASEDATA_URL,
      "FMS",
      (tabId) => runStep(tabId, BaseDataSync.importBaseDataFile, [fileName, base64], "导入基础数据"),
      { foreground: true }
    );
    return { ok: true, messages: r.messages || [], dialogClosed: r.dialogClosed };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err.message };
  } finally {
    clearInterval(keepAlive);
  }
}

// ---- 生成账单：品牌+店铺+结算月份 → FMS「账单生成」→ 等账单出现在列表里 → 回填账单编号 ----
const GEN_KEY = "genJob";
async function setGen(patch) {
  const cur = (await chrome.storage.local.get(GEN_KEY))[GEN_KEY] || {};
  await chrome.storage.local.set({ [GEN_KEY]: Object.assign({}, cur, patch) });
}

// brands：要生成账单的品牌列表（单个品牌时就是 1 个；按 Vendor 生成时是该 vendor 下的所有品牌）。
// 每个品牌依次：已经有账单就不重复生成，没有就在 FMS「账单生成」里生成；最后统一等它们出现在账单列表里。
// 某个品牌失败（比如品牌下拉里没有这个品牌）不影响其他品牌，最后一起汇报。
async function runGenerateJob(brands, shop, monthsIn) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const months = [...new Set(monthsIn)].sort();
  // 每个「品牌 × 月份」是一张账单；pairs 的 key 用来在结果里区分
  const pairs = months.flatMap((month) => brands.map((brand) => ({ brand, month, key: brand + "|" + month })));
  const multi = pairs.length > 1;
  const monthLabel = months.length > 1 ? months[0] + " ~ " + months[months.length - 1] + "（" + months.length + " 个月）" : months[0];
  const label = (brands.length > 1 ? brands.join(" + ") : brands[0]) + " / " + shop + " / " + monthLabel;
  const nameOf = (p) => p.brand + (months.length > 1 ? " " + p.month : "");
  try {
    await setGen({ text: "正在检查 " + label + " 的账单是否已经存在…", kind: "busy", bills: [] });
    const out = await withTab(
      FMSConfig.FMS_BILL_URL,
      "FMS",
      async (tabId) => {
        const read = async () => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records;
        const foundOf = (records) => Object.fromEntries(pairs.map((p) => [p.key, BillGen.findBills(records, p.brand, shop, p.month)]));
        let found = foundOf(await read());
        const existed = pairs.filter((p) => found[p.key].length).map((p) => p.key);
        const failures = {};
        const submitted = [];
        const messages = [];

        let idx = 0;
        for (const p of pairs) {
          idx++;
          if (found[p.key].length) continue;
          await setGen({ text: "正在 FMS 生成 " + (multi ? nameOf(p) + "（" + idx + "/" + pairs.length + "）" : label) + " 的账单…", kind: "busy" });
          try {
            const g = await runStep(tabId, BillGen.generateBill, [p.brand, shop, p.month], "生成账单");
            submitted.push(p.key);
            (g.messages || []).forEach((m) => messages.push(m));
          } catch (e) {
            if (!multi) throw e;
            failures[p.key] = e.message.split("\n")[0];
          }
        }

        for (let i = 0; i < 8 && submitted.some((k) => !found[k].length); i++) {
          await new Promise((r) => setTimeout(r, 6000));
          await setGen({ text: "已提交生成，等 FMS 出账单（" + (i + 1) + "/8）…", kind: "busy" });
          try {
            found = foundOf(await read());
          } catch (e) {
            // 此时账单已经提交生成了，只是读列表失败：要让用户知道别重复点，去 FMS 确认
            throw new Error("账单已提交生成，但读取账单列表失败，不确定是否已出账单。请先到 FMS 账单总表确认，不要重复点「生成账单」。（" + e.message.split("\n")[0] + "）");
          }
        }
        return { found, existed, submitted, failures, messages };
      },
      { foreground: true }
    );

    const nameByKey = Object.fromEntries(pairs.map((p) => [p.key, nameOf(p)]));
    const bills = [];
    for (const p of pairs) {
      for (const r of out.found[p.key] || []) bills.push({ billNo: r.settlementNo, status: r.settlementStatus, site: r.siteCode, brand: p.brand, month: p.month });
    }
    const missing = out.submitted.filter((k) => !out.found[k].length);
    const failedKeys = Object.keys(out.failures);

    if (!bills.length) {
      await setGen({
        running: false,
        kind: failedKeys.length ? "error" : "",
        bills: [],
        text: failedKeys.length
          ? "生成失败：" + failedKeys.map((k) => nameByKey[k] + "（" + out.failures[k] + "）").join("；")
          : "已提交生成" + (out.messages.length ? "（FMS 提示：" + out.messages.join("；") + "）" : "") +
            "，但暂时没在账单列表里看到 " + label + " 的账单。可能还在处理，请稍后到 FMS 的账单列表或「任务日志」确认。",
      });
      return;
    }

    let text;
    if (!multi) {
      text =
        (out.existed.length ? "这个月的账单已经存在：" : "账单已生成：") +
        bills.map((x) => x.billNo + (x.site ? "（" + x.site + "）" : "")).join("、") +
        (bills.length > 1 ? "。同一组合有多张账单，已全部填入。" : "。已填入下方账单编号。");
    } else {
      text = "共 " + bills.length + " 张账单" +
        (out.existed.length ? "，其中已存在的：" + out.existed.map((k) => nameByKey[k]).join("、") : "") + "，已全部填入账单编号。";
      if (missing.length) text += "\n已提交但暂时没在列表里看到：" + missing.map((k) => nameByKey[k]).join("、") + "，请稍后到 FMS 确认。";
      if (failedKeys.length) text += "\n生成失败：" + failedKeys.map((k) => nameByKey[k] + "（" + out.failures[k] + "）").join("；");
    }
    await setGen({ running: false, kind: failedKeys.length || missing.length ? "" : "ok", bills, text });
  } catch (err) {
    console.error(err);
    await setGen({ running: false, kind: "error", bills: [], text: "生成账单失败：" + err.message });
  } finally {
    clearInterval(keepAlive);
  }
}

// ---- 重新生成：基础数据导入后，对「待确认」账单点「重新生成」，并等状态变成「待生成请款单」 ----
// 导入是异步任务，刚导完就重新生成可能还读不到新数据，所以最多试 3 轮，每轮点一次后轮询状态。
const REGEN_KEY = "regenJob";
async function setRegen(patch) {
  const cur = (await chrome.storage.local.get(REGEN_KEY))[REGEN_KEY] || {};
  await chrome.storage.local.set({ [REGEN_KEY]: Object.assign({}, cur, patch) });
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// billNos：要处理的账单（单张或同一个 vendor 下的多张）。只对状态还是「待确认」的账单点重新生成，
// 每一轮先把所有还没变的账单都点一遍，再统一等状态更新；最多 3 轮。
async function runRegenJob(billNos) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const multi = billNos.length > 1;
  try {
    const out = await withTab(
      FMSConfig.FMS_BILL_URL,
      "FMS",
      async (tabId) => {
        const read = async () => {
          const r = await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表");
          const m = {};
          for (const no of billNos) {
            const rec = r.records.find((x) => x.settlementNo === no);
            if (!rec) throw new Error("账单列表里没找到 " + no);
            m[no] = rec.settlementStatus;
          }
          return m;
        };
        let statuses = await read();
        const pendingOf = () => billNos.filter((no) => statuses[no] === "PENDING_CONFIRM");
        if (!pendingOf().length) return { statuses, already: true };
        const messages = [];
        for (let round = 1; round <= 3 && pendingOf().length; round++) {
          for (const no of pendingOf()) {
            await setRegen({ text: "第 " + round + " 轮：在 FMS 点「重新生成」" + (multi ? "（" + no + "）" : "") + "…", kind: "busy" });
            const g = await runStep(tabId, BillGen.regenerateBill, [no], "重新生成");
            (g.messages || []).forEach((m) => messages.push(m));
          }
          for (let i = 0; i < 6; i++) {
            await sleepMs(5000);
            await setRegen({ text: "第 " + round + " 轮：已点重新生成，等账单状态更新（" + (i + 1) + "/6）…", kind: "busy" });
            statuses = await read();
            if (!pendingOf().length) break;
          }
        }
        return { statuses, messages };
      },
      { foreground: true }
    );
    const st = out.statuses;
    const stillPending = billNos.filter((no) => st[no] === "PENDING_CONFIRM");
    const first = st[billNos[0]];
    const label = { PENDING_GENERATE_REQUEST: "待生成请款单", PENDING_CONFIRM: "待确认" };
    if (stillPending.length) {
      await setRegen({
        running: false,
        kind: "error",
        status: stillPending.length === billNos.length ? "PENDING_CONFIRM" : first,
        statuses: st,
        text:
          (multi ? stillPending.join("、") + " " : "") +
          "已重新生成 3 次，状态仍是「待确认」。可能是基础数据导入还没处理完，或者还有 SKU 缺结算价（可以回第 3 步重新生成模板看缺哪些）。到 FMS「导入导出任务」看导入结果。",
      });
    } else {
      await setRegen({
        running: false,
        kind: "ok",
        status: first,
        statuses: st,
        text: out.already
          ? (multi ? "这些账单" : "这张账单") + "已经不是「待确认」，不用重新生成。"
          : "重新生成完成，" + (multi ? "全部账单" : "账单状态") + "已变成「" + (label[first] || first) + "」。可以继续第 5、6 步。",
      });
    }
  } catch (err) {
    console.error(err);
    await setRegen({ running: false, kind: "error", status: "", statuses: {}, text: "重新生成失败：" + err.message });
  } finally {
    clearInterval(keepAlive);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "bill:regenerate") {
    (async () => {
      const job = (await chrome.storage.local.get(REGEN_KEY))[REGEN_KEY];
      if (job && job.running && Date.now() - (job.startedAt || 0) < STALE_JOB_MS) {
        sendResponse({ started: false, reason: "已有重新生成任务正在进行" });
        return;
      }
      const billNos = Array.isArray(msg.billNos) && msg.billNos.length ? msg.billNos : [msg.billNo];
      await setRegen({ running: true, startedAt: Date.now(), billNo: billNos[0], billNos, status: "", statuses: {}, text: "任务已开始…", kind: "busy" });
      sendResponse({ started: true });
      runRegenJob(billNos);
    })();
    return true;
  }
  if (msg && msg.type === "tabs:temp") {
    sendResponse({ ids: [...TEMP_TABS] });
    return false;
  }
  if (msg && msg.type === "brands:refresh") {
    // 读 FMS「账单生成」弹窗里品牌下拉的全部选项（FMS 新增品牌后，这里能同步到），存起来给面板的品牌下拉用
    (async () => {
      try {
        const r = await withTab(
          FMSConfig.FMS_BILL_URL,
          "FMS",
          (tabId) => runStep(tabId, BillGen.listBrands, [], "读取品牌清单"),
          { foreground: true }
        );
        if (!r.brands || !r.brands.length) throw new Error("没有读到品牌");
        await chrome.storage.local.set({ brandList: { at: Date.now(), brands: r.brands } });
        sendResponse({ ok: true, count: r.brands.length });
      } catch (err) {
        console.error(err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg && msg.type === "vendors:refresh") {
    // 读一遍 FMS 账单列表，只留「品牌 / 品牌商公司 / 店铺」，用来列出每个 vendor 下有哪些品牌
    (async () => {
      try {
        const recs = await withTab(FMSConfig.FMS_BILL_URL, "FMS", async (tabId) => {
          const r = await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表");
          return r.records;
        });
        const seen = new Set();
        const bills = [];
        for (const r of recs) {
          if (!r.brandName || !r.brandCompany) continue;
          const k = [r.brandName, r.brandCompany, r.shopCode].join("|");
          if (seen.has(k)) continue;
          seen.add(k);
          bills.push({ brandName: r.brandName, brandCompany: String(r.brandCompany), shopCode: r.shopCode });
        }
        await chrome.storage.local.set({ vendorBills: { at: Date.now(), bills } });
        sendResponse({ ok: true, count: bills.length });
      } catch (err) {
        console.error(err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg && msg.type === "bill:status") {
    // 查账单现在的结算状态（待确认 / 待生成请款单 …），决定走哪个分支；支持一次查多张
    (async () => {
      try {
        const nos = Array.isArray(msg.billNos) && msg.billNos.length ? msg.billNos : [msg.billNo];
        const recs = await withTab(FMSConfig.FMS_BILL_URL, "FMS", async (tabId) => {
          const r = await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表");
          return r.records;
        });
        const bills = [];
        const missing = [];
        for (const no of nos) {
          const rec = recs.find((x) => x.settlementNo === no);
          if (rec) bills.push({ billNo: no, status: rec.settlementStatus, brand: rec.brandName, shop: rec.shopCode, month: rec.accountingMonth, company: rec.brandCompany });
          else missing.push(no);
        }
        if (missing.length) {
          sendResponse({ ok: false, error: "账单列表里没找到 " + missing.join("、") + "，请检查编号是否正确" });
        } else {
          const f = bills[0];
          sendResponse({ ok: true, bills, status: f.status, brand: f.brand, shop: f.shop, month: f.month });
        }
      } catch (err) {
        console.error(err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg && msg.type === "bill:siblings") {
    // 请款前检查：同品牌（同品牌商公司 + 同店铺）是否还有别的「待生成请款单」账单。
    // FMS 请款时可能把它们一起并进同一张费控单，所以先让用户确认。读取失败不拦着请款。
    (async () => {
      try {
        const nos = msg.billNos || [];
        const recs = await withTab(FMSConfig.FMS_BILL_URL, "FMS", async (tabId) => {
          const r = await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表");
          return r.records;
        });
        const mine = recs.filter((x) => nos.includes(x.settlementNo));
        const keyOf = (x) => [x.brandName, x.brandCompany, x.shopCode].join("|");
        const keys = new Set(mine.filter((x) => x.settlementStatus === "PENDING_GENERATE_REQUEST").map(keyOf));
        const siblings = recs
          .filter((x) => !nos.includes(x.settlementNo) && x.settlementStatus === "PENDING_GENERATE_REQUEST" && keys.has(keyOf(x)))
          .map((x) => ({ billNo: x.settlementNo, brand: x.brandName, month: x.accountingMonth }));
        sendResponse({ ok: true, siblings });
      } catch (err) {
        console.error(err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (msg && msg.type === "bill:generate") {
    (async () => {
      const job = (await chrome.storage.local.get(GEN_KEY))[GEN_KEY];
      if (job && job.running && Date.now() - (job.startedAt || 0) < STALE_JOB_MS) {
        sendResponse({ started: false, reason: "已有生成任务正在进行" });
        return;
      }
      const brands = Array.isArray(msg.brands) && msg.brands.length ? msg.brands : [msg.brand];
      const months = Array.isArray(msg.months) && msg.months.length ? msg.months : [msg.month];
      await setGen({ running: true, startedAt: Date.now(), brands, shop: msg.shop, months, text: "任务已开始…", kind: "busy", bills: [] });
      sendResponse({ started: true });
      runGenerateJob(brands, msg.shop, months);
    })();
    return true;
  }
  if (msg && (msg.type === "match:query" || msg.type === "match:resolve")) {
    (async () => {
      const job = (await chrome.storage.local.get(MATCH_KEY))[MATCH_KEY];
      if (job && job.running && Date.now() - (job.startedAt || 0) < STALE_JOB_MS) {
        sendResponse({ started: false, reason: "已有全量匹配任务正在进行" });
        return;
      }
      if (msg.type === "match:resolve") {
        if (!job || !job.fms || !job.fms.missing || !job.fms.missing.length) {
          sendResponse({ started: false, reason: "请先做第一步：查询 FMS 缺失 SKU" });
          return;
        }
        await setMatch({ running: true, startedAt: Date.now(), text: "任务已开始…", kind: "busy", unresolved: "", rows: [], fileName: "", warnings: [], importedAt: null, importMsg: "", importKind: "" });
        sendResponse({ started: true });
        runMatchResolve();
        return;
      }
      const shops = Array.isArray(msg.shops) ? msg.shops : [];
      await setMatch({ running: true, startedAt: Date.now(), brand: msg.brand, shops, text: "任务已开始…", kind: "busy", stage: "", fms: null, stats: null, unresolved: "", rows: [], fileName: "", warnings: [], importedAt: null, importMsg: "", importKind: "" });
      sendResponse({ started: true });
      if (msg.auto) runMatchJob(msg.brand, shops); // 两步一起做：查完接着去 EH 匹配
      else runMatchQuery(msg.brand, shops);
    })();
    return true;
  }
  if (msg && msg.type === "baseData:import") {
    runImport(msg.fileName, msg.base64).then(sendResponse);
    return true;
  }
  if (!msg || msg.type !== "baseData:start") return;
  (async () => {
    const job = (await chrome.storage.local.get(BILL_FILL_KEY))[BILL_FILL_KEY];
    if (job && job.running && Date.now() - (job.startedAt || 0) < STALE_JOB_MS) {
      sendResponse({ started: false, reason: "已有任务正在进行" });
      return;
    }
    const billNos = Array.isArray(msg.billNos) && msg.billNos.length ? msg.billNos : [msg.billNo];
    await setJob({ running: true, startedAt: Date.now(), billNo: billNos[0], billNos, text: "任务已开始…", kind: "busy", unresolved: "", rows: [], fileName: "" });
    sendResponse({ started: true });
    runBaseDataJob(billNos); // 不 await：消息通道回复后任务继续在后台跑
  })();
  return true; // 异步回复
});

// ---- Loop 接单（可选，默认关闭；在扩展的「选项」页填写）----
// 目前只会回答「连通测试」，不碰 FMS。以后加的每一种任务都必须在这里登记，没登记的一律什么都不做。
// 把文件存进「下载」文件夹下的相对路径（同名覆盖，重跑不会留一堆副本），等下载完成才返回
async function saveBuffer(buf, relPath) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const url = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64," + btoa(bin);
  const id = await chrome.downloads.download({ url, filename: relPath, conflictAction: "overwrite", saveAs: false });
  for (let i = 0; i < 40; i++) {
    const [d] = await chrome.downloads.search({ id });
    if (d && d.state === "complete") return;
    if (d && d.state === "interrupted") throw new Error("保存失败：" + (d.error || "下载被中断"));
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("保存超时：" + relPath);
}

// 清洗：下载账单明细、清洗。save=false 时只报告会生成什么文件，不保存。
// （在 FMS 里「导出」会产生一条导出任务记录，不改账单数据。）
async function cleanBills(records, cfg, save) {
  const tag = save ? "清洗" : "清洗演练";
  if (!CLEAN_READY) return tag + "没跑成：清洗模块没加载上";
  if (save && !(await chrome.permissions.contains({ permissions: ["downloads"] }))) return "待你处理：还没授权保存文件。请在插件的选项页点「允许保存对账表」，然后再触发一次";
  const pick = MonthFlow.pickCleanable(records, cfg, BillGen.findBills);
  if (!pick.ok) return tag + "：" + pick.reason;
  const buffers = [];
  for (const no of pick.billNos) {
    const raw = await withTab(
      FMSConfig.FMS_BILL_URL,
      "FMS",
      async (tabId) => {
        const r = await runStep(tabId, FMSAutomation.downloadRawBillFile, [no], "下载账单 " + no);
        const resp = await fetch(r.downloadUrl);
        if (!resp.ok) throw new Error("下载原始账单失败: HTTP " + resp.status);
        return resp.arrayBuffer();
      },
      { quiet: true, foreground: true }
    );
    buffers.push(raw);
  }
  const workbooks = buffers.map((b) => XLSX.read(b, { type: "array" }));
  const source = workbooks.length === 1 ? workbooks[0] : FMSCleaner.mergeSources(workbooks);
  const result = FMSCleaner.clean(source);
  if (workbooks.length > 1) result.brand = cfg.brand;
  const names = [];
  const safe = (t) => String(t).replace(/[\\/:*?"<>|]/g, "_").trim();
  for (const lang of ["zh", "en"]) {
    const buf = await FMSCleaner.workbookToBuffer(FMSCleaner.buildWorkbook(result, lang));
    const fname = FMSCleaner.buildOutputFileName(result, new Date(), lang);
    if (save) {
      const where = "FMS对账表/" + safe(cfg.brand) + "/" + cfg.month + "/" + safe(fname);
      await saveBuffer(buf, where);
      names.push(where);
    } else {
      names.push(fname + "（" + Math.round(buf.byteLength / 1024) + " KB）");
    }
  }
  const head = tag + "：" + pick.billNos.length + " 张账单，共 " + result.fmsExport.rows.length + " 行；";
  return save ? head + "已保存到 下载/" + names.join("；下载/") : head + "会生成：" + names.join("；") + "；（没有保存任何文件）";
}

// 生成账单（会写 FMS）：只在「这个月还没有账单」时才生成；已经有就什么都不做。
// 防重复：提交过生成之后 30 分钟内，即使列表里还没看到账单，也不再提交第二次。
async function generateIfMissing(cfg) {
  if (MonthFlow.isTooEarly(cfg.month, new Date())) return "没生成：结算月份 " + cfg.month + " 还没到可以生成账单的时候（只处理上个月及更早）";
  const key = cfg.brand + "|" + cfg.shop + "|" + cfg.month;
  const out = await withTab(
    FMSConfig.FMS_BILL_URL,
    "FMS",
    async (tabId) => {
      const read = async () => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records;
      let bills = BillGen.findBills(await read(), cfg.brand, cfg.shop, cfg.month);
      if (bills.length) return { bills, submitted: false };
      const last = ((await chrome.storage.local.get("loopGenLast")).loopGenLast || {})[key];
      if (last && Date.now() - last < 30 * 60 * 1000) return { bills, submitted: false, blocked: true };
      const g = await runStep(tabId, BillGen.generateBill, [cfg.brand, cfg.shop, cfg.month], "生成账单");
      const all = (await chrome.storage.local.get("loopGenLast")).loopGenLast || {};
      all[key] = Date.now();
      await chrome.storage.local.set({ loopGenLast: all });
      for (let i = 0; i < 8 && !bills.length; i++) {
        await new Promise((r) => setTimeout(r, 6000));
        bills = BillGen.findBills(await read(), cfg.brand, cfg.shop, cfg.month);
      }
      return { bills, submitted: true, messages: g.messages || [] };
    },
    { quiet: true, foreground: true }
  );
  const nos = out.bills.map((b) => b.settlementNo + (b.siteCode ? "（" + b.siteCode + "）" : "") + "，" + (MonthFlow.STATUS[b.settlementStatus] || b.settlementStatus)).join("；");
  if (out.blocked) return "没重复生成：30 分钟内已经提交过这个月的生成，请到 FMS 账单总表或任务日志确认";
  if (!out.submitted) return "账单已存在，没有重复生成：" + nos;
  if (!out.bills.length) return "已提交生成，但暂时没在账单列表里看到，可能还在处理。请稍后到 FMS 确认，不要重复生成" + (out.messages.length ? "（FMS 提示：" + out.messages.join("；") + "）" : "");
  return "已生成账单：" + nos;
}

// 补基础数据：对「待确认」账单读缺价明细 → 去 EH 查结算价 → 对上号 → 做确定性检查，得到草稿。
// 这一步只读（EH、FMS 都只是查询），不导入。
async function baseDraft(records, cfg) {
  const bills = BillGen.findBills(records, cfg.brand, cfg.shop, cfg.month);
  const pend = bills.filter((b) => b.settlementStatus === "PENDING_CONFIRM");
  if (!pend.length) return { none: "没有「待确认」的账单，不需要补" };
  const missing = [];
  let total = 0;
  for (const b of pend) {
    const one = await withTab(
      FMSConfig.FMS_BILL_URL,
      "FMS",
      (tabId) => runStep(tabId, BaseDataSync.fetchBillMissingRows, [b.settlementNo], "读取缺价明细"),
      { quiet: true }
    );
    missing.push(...one.missing);
    total += one.total;
  }
  if (!missing.length) return { none: pend.length + " 张待确认账单共 " + total + " 行，没有缺结算价的行（状态可能需要在 FMS 里刷新）" };
  const plan = FMSBaseData.planMissing(missing);
  let eh = {};
  if (plan.jobs.length) {
    const res = await withTab(
      FMSConfig.EH_PRICING_URL,
      "EH",
      (tabId) => runStep(tabId, BaseDataSync.fetchEhCosts, [plan.jobs], "读取 EH 结算价"),
      { quiet: true, foreground: true }
    );
    eh = res.results;
  }
  const out = FMSBaseData.resolve(plan.items, eh);
  const chk = FMSBaseData.checkRows(out.rows);
  return { pend, billNos: pend.map((b) => b.settlementNo), missingCount: missing.length, items: plan.items, rows: out.rows, unresolved: out.unresolved, warnings: chk.warnings };
}

const draftDoubts = (d) => d.unresolved.length > 0 || d.warnings.length > 0 || !d.rows.length;
const draftKey = (cfg) => [cfg.brand, cfg.shop, cfg.month].join("|");

async function baseDry(records, cfg) {
  const d = await baseDraft(records, cfg);
  if (d.none) return "补基础数据演练：" + d.none;
  const un = d.unresolved.slice(0, 5).map((u) => u.item.sku + "：" + u.reason);
  return (
    "补基础数据演练：" + d.pend.length + " 张待确认账单，缺价 " + d.missingCount + " 行 / " + d.items.length + " 个 SKU；EH 对上 " + d.rows.length + " 个，对不上 " + d.unresolved.length + " 个" +
    (un.length ? "（" + un.join("；") + (d.unresolved.length > 5 ? "…" : "") + "）" : "") +
    "；检查：" + (d.warnings.length ? d.warnings.slice(0, 5).join("；") : "全部通过") +
    " → 计划：" + (draftDoubts(d) ? "有疑问，会停下来问你" : "没疑问，（影子期）先把摘要发给你再导入") + "（演练，没有导入）"
  );
}

async function dropDraft(cfg) {
  const drafts = (await chrome.storage.local.get("loopBaseDrafts")).loopBaseDrafts || {};
  delete drafts[draftKey(cfg)];
  await chrome.storage.local.set({ loopBaseDrafts: drafts });
}

// 第一步：算草稿，发审批卡片（有疑问就只告诉你，不给「导入」选项）。草稿存在本机，批准后按草稿导入。
async function baseProposeCard(records, cfg) {
  const d = await baseDraft(records, cfg);
  if (d.none) return { summary: "补基础数据：" + d.none };
  const label = cfg.brand + " / " + cfg.shop + " / " + cfg.month;
  if (draftDoubts(d)) {
    const lines = [].concat(
      d.unresolved.slice(0, 15).map((u) => u.item.sku + "（" + u.item.shop + "/" + u.item.site + "）：" + u.reason),
      d.warnings.slice(0, 10)
    );
    return {
      summary: "待你处理：补基础数据有疑问，没有导入（" + label + "）",
      ask: [{ title: "补基础数据有疑问：" + label, text: "缺价 " + d.items.length + " 个 SKU，EH 对上 " + d.rows.length + " 个。需要你人工处理：\n" + lines.join("\n"), options: ["知道了，我自己处理"], recommend: 0, key: "fms-base-doubt|" + draftKey(cfg), about: "有疑问的草稿不会自动导入" }],
    };
  }
  const drafts = (await chrome.storage.local.get("loopBaseDrafts")).loopBaseDrafts || {};
  drafts[draftKey(cfg)] = { key: draftKey(cfg), at: Date.now(), billNos: d.billNos, rows: d.rows };
  await chrome.storage.local.set({ loopBaseDrafts: drafts });
  const sample = d.rows.slice(0, 30).map((r) => r["MM SKU"] + "（" + r["站点"] + "/" + r["店铺"] + "）→ " + r["结算单价"] + " " + r["结算币种"]);
  return {
    summary: "待你批示：补基础数据草稿已备好，等你点「导入并重新生成账单」（" + label + "，" + d.rows.length + " 个 SKU）",
    ask: [{
      title: "补基础数据，要导入吗：" + label,
      text: d.billNos.length + " 张账单（" + d.billNos.join("、") + "），缺价 " + d.missingCount + " 行 / " + d.rows.length + " 个 SKU，EH 全部对上、检查全部通过。\n" + sample.join("\n") + (d.rows.length > 30 ? "\n…还有 " + (d.rows.length - 30) + " 个" : "") + "\n点「导入并重新生成账单」后，会把这份模板导入 FMS 基础数据，再重新生成账单。导入可以覆盖重导。",
      options: ["导入并重新生成账单", "先不导入，我自己看"],
      recommend: 0,
      key: "fms-base|" + draftKey(cfg),
      about: "批准后：按本机保存的草稿导入基础数据，再重新生成账单",
    }],
  };
}

// 第二步：你批准之后才会走到这里：按草稿导入 → 重新生成账单 → 报告状态。
async function baseApplied(cfg) {
  const draft = ((await chrome.storage.local.get("loopBaseDrafts")).loopBaseDrafts || {})[draftKey(cfg)];
  if (!draft) return "没导入：找不到对应的草稿，请重新触发一次";
  if (Date.now() - draft.at > 24 * 3600 * 1000) return "没导入：草稿已超过 24 小时，请重新触发一次";
  // 导入前再确认一遍：这些账单现在还是「待确认」
  const records = await withTab(
    FMSConfig.FMS_BILL_URL,
    "FMS",
    async (tabId) => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records,
    { quiet: true }
  );
  const still = draft.billNos.filter((no) => (records.find((r) => r.settlementNo === no) || {}).settlementStatus === "PENDING_CONFIRM");
  if (!still.length) return "没导入：这些账单已经不是「待确认」了，不需要再补";
  const wb = FMSBaseData.toWorkbook(ExcelJS, draft.rows);
  const buf = new Uint8Array(await wb.xlsx.writeBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const imp = await runImport(FMSBaseData.fileName(draft.billNos[0]), btoa(bin));
  if (!imp.ok) return "导入失败：" + String(imp.error).split("\n")[0] + "（没有重新生成账单）";
  await dropDraft(cfg);
  await new Promise((r) => setTimeout(r, 15000));
  const status = await withTab(
    FMSConfig.FMS_BILL_URL,
    "FMS",
    async (tabId) => {
      const read = async () => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records;
      const stOf = (rs) => Object.fromEntries(still.map((no) => [no, (rs.find((r) => r.settlementNo === no) || {}).settlementStatus]));
      let st = stOf(await read());
      for (let round = 1; round <= 3 && still.some((no) => st[no] === "PENDING_CONFIRM"); round++) {
        for (const no of still.filter((n) => st[n] === "PENDING_CONFIRM")) await runStep(tabId, BillGen.regenerateBill, [no], "重新生成");
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          st = stOf(await read());
          if (!still.some((no) => st[no] === "PENDING_CONFIRM")) break;
        }
      }
      return st;
    },
    { quiet: true, foreground: true }
  );
  const txt = still.map((no) => no + "：" + (MonthFlow.STATUS[status[no]] || status[no])).join("；");
  const left = still.filter((no) => status[no] === "PENDING_CONFIRM");
  return "已导入 " + draft.rows.length + " 个 SKU 的基础数据并重新生成账单：" + txt + (left.length ? "。仍是「待确认」的账单，请到 FMS「导入导出任务」看导入结果" : "。可以继续清洗对账表");
}

// 整月流程：每次都先读 FMS 现在的真实状态，再决定往前走哪一步（所以重跑、你批准后接着跑都是同一套逻辑）：
//   没账单 → 发卡片问你要不要生成（批准后才生成）
//   有「待确认」 → 算补数据草稿发卡片（批准后才导入并重新生成账单）；有疑问只告诉你
//   基础数据齐了 → 清洗对账表并保存到下载文件夹
//   然后停下：发票和请款、提交付款都是你自己来
// 不会点任何「提交付款」「请款」之类的按钮。
async function monthRun(cfg, answers) {
  const readList = () =>
    withTab(FMSConfig.FMS_BILL_URL, "FMS", async (tabId) => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records, { quiet: true });
  const answered = (t) => answers.some((a) => a.chosen === t);
  const label = cfg.brand + " / " + cfg.shop + " / " + cfg.month;
  const log = [];
  let records = await readList();
  let bills = BillGen.findBills(records, cfg.brand, cfg.shop, cfg.month);

  if (!bills.length) {
    if (!answered("生成账单")) {
      return {
        summary: "待你批示：" + label + " 还没有账单，要不要生成",
        ask: [{ title: "要生成账单吗：" + label, text: "FMS 里还没有这个月的账单。点「生成账单」后，我会在 FMS 的「账单生成」里提交（可在 FMS 里撤销），然后接着往下走。", options: ["生成账单", "这个月我自己做"], recommend: 0, key: "fms-gen|" + draftKey(cfg), about: "批准后：生成账单，再继续补数据和清洗" }],
      };
    }
    log.push(await generateIfMissing(cfg));
    records = await readList();
    bills = BillGen.findBills(records, cfg.brand, cfg.shop, cfg.month);
    if (!bills.length) return { summary: label + "：" + log.join("；") + "。暂时没在列表里看到账单，稍后重新触发" };
  }

  if (bills.some((b) => b.settlementStatus === "PENDING_CONFIRM")) {
    if (answered("导入并重新生成账单")) {
      log.push(await baseApplied(cfg));
      records = await readList();
    } else {
      const p = await baseProposeCard(records, cfg);
      if (p.ask) return { summary: log.concat(p.summary).join("；"), ask: p.ask };
      log.push(p.summary);
    }
  }

  const pick = MonthFlow.pickCleanable(records, cfg, BillGen.findBills);
  log.push(pick.ok ? await cleanBills(records, cfg, true) : "清洗：" + pick.reason);
  log.push(MonthFlow.plan(records, cfg, BillGen.findBills).summary.replace(/（演练，没有点任何按钮）/, ""));
  return { summary: "整月流程 " + label + "：" + log.join("；") };
}

// 同一店铺这个月所有已有账单的品牌：逐个走整月流程（一个品牌出错不影响别的品牌）。
// 你的答复是按卡片标题里的品牌对上号的，所以一个品牌点「我自己做」不会影响别的品牌。
// 不会替没账单的品牌生成账单（生成账单只在单品牌的整月流程里，并且要你批准）。
// 分段跑：浏览器会回收跑太久的后台脚本（实测十几分钟的一整轮会被中途回收，Loop 那边就丢了这一轮），
// 所以每段最多跑 ALL_BUDGET_MS，记下进度，让 Loop 到点叫醒接着跑，全部做完才发汇总。
let ALL_BUDGET_MS = 150 * 1000;
async function monthAll(cfg, answers) {
  const startedAt = Date.now();
  const pkey = cfg.shop + "|" + cfg.month;
  const store = async () => (await chrome.storage.local.get("loopAllProgress")).loopAllProgress;
  let prog = await store();
  const sameRun = prog && prog.key === pkey && Date.now() - prog.at < 6 * 3600 * 1000;
  const cont = !!(sameRun && prog.cont); // 上一段没做完、到点叫醒的接力
  const onlyAnswered = !cont && answers.length > 0; // 你批准卡片唤醒的：只处理有答复的品牌
  if (!(cont || (onlyAnswered && sameRun))) prog = { key: pkey, at: Date.now(), cont: false, done: {} };
  prog.cont = false;

  const records = await withTab(FMSConfig.FMS_BILL_URL, "FMS", async (tabId) => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records, { quiet: true });
  const brands = MonthFlow.brandsOfMonth(records, cfg.shop, cfg.month);
  if (!brands.length) return { summary: "整月流程（全品牌）" + cfg.shop + " / " + cfg.month + "：没有账单" };
  const asks = [];
  for (const brand of brands) {
    const c = Object.assign({}, cfg, { brand, mode: "month" });
    const mine = answers.filter((a) => String(a.title || "").includes(brand + " / "));
    if (onlyAnswered && !mine.length) continue;
    if (prog.done[brand] && !mine.length) continue; // 接力时已经做过的跳过
    if (Date.now() - startedAt > ALL_BUDGET_MS) {
      prog.cont = true;
      await chrome.storage.local.set({ loopAllProgress: prog });
      return {
        summary: "整月流程（全品牌）进行中：已处理 " + Object.keys(prog.done).length + "/" + brands.length + " 个品牌，稍后自动接着做",
        ask: asks.length ? asks : undefined,
        later: [{ key: "fms-runall|" + pkey, at: new Date(Date.now() + 20000).toISOString(), about: "接着处理剩下的品牌" }],
      };
    }
    if (mine.some((a) => a.chosen === "这个月我自己做")) { prog.done[brand] = "按你的决定，这个月自己做"; continue; }
    if (mine.some((a) => a.chosen === "先不导入，我自己看" || a.chosen === "知道了，我自己处理")) { await dropDraft(c); prog.done[brand] = "按你的决定，没有导入"; continue; }
    try {
      const r = await monthRun(c, mine);
      prog.done[brand] = r.summary.replace(/^整月流程 [^：]*：/, "");
      (r.ask || []).forEach((x) => asks.push(x));
    } catch (e) {
      const msg = ((e && e.message) || String(e)).split("\n")[0];
      // 页面没返回结果多半是登录过期后被跳走了：别把剩下的品牌都标成没跑成，直接按登录过期处理，发卡片
      if (/登录已过期|没有拿到页面的执行结果/.test(msg)) throw new Error("FMS 登录已过期（" + msg.split("\n")[0] + "）");
      prog.done[brand] = "没跑成：" + msg;
    }
    await chrome.storage.local.set({ loopAllProgress: prog });
  }
  await chrome.storage.local.set({ loopAllProgress: prog });
  const lines = brands.filter((x) => prog.done[x]).map((x) => x + "：" + prog.done[x]);
  // 中台限制回执里的一句话最多 500 字，22 个品牌的明细放不下会被整份拒收（这一轮就变成「不确定」）。
  // 一句话只写数量，完整明细放通知卡片（上限 4000 字）。
  const total = brands.length;
  const saved = brands.filter((x) => /已保存/.test(prog.done[x] || "")).length;
  const failed = brands.filter((x) => /^没跑成/.test(prog.done[x] || "")).length;
  const detail = lines.join("\n");
  return {
    summary: "整月流程（全品牌）" + cfg.shop + " / " + cfg.month + "，共 " + total + " 个品牌：" + saved + " 个已出对账表，" + failed + " 个没跑成，其余无需处理或按你的决定跳过；明细见通知卡片",
    notice: [{ title: "全品牌整月流程明细 " + cfg.shop + " / " + cfg.month, text: detail.length > 3900 ? detail.slice(0, 3900) + "…" : detail, key: "fms-runall-detail|" + pkey, fyi: true }],
    ask: asks.length ? asks : undefined,
  };
}

// 月结演练：只读。读一遍账单列表，说出「如果真做，打算做什么」，不点任何会改 FMS 数据的按钮。
// 品牌、店铺、月份来自 Loop 规则里的参数（JSON）；不认识的品牌或店铺直接拒绝，不猜。
async function monthDryRun(job) {
  const answers = (job.context && job.context.answers) || [];
  const cfg = MonthFlow.parseConfig((job.rule && job.rule.prompt) || "", BillGen.BRANDS, BillGen.SHOPS, new Date());
  if (!cfg.ok) return { outcome: "done", summary: "待你处理：规则里的参数有问题：" + cfg.error };
  if (cfg.mode === "monthall") {
    try {
      return Object.assign({ outcome: "done" }, await monthAll(cfg, answers));
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/登录已过期|没有拿到页面的执行结果/.test(msg)) return { outcome: "done", summary: "待你处理：FMS 登录已过期", ask: [{ title: "FMS 登录过期了", text: "整月流程读不到账单。请在浏览器里登录 FMS，登录好再点第一个选项。", options: ["已登录，再试一次", "这个月我自己做"], recommend: 0, key: "fms-login", about: "登录后重新跑整月流程" }] };
      return { outcome: "failed", error: msg, summary: "没跑成：" + msg.split("\n")[0] };
    }
  }
  if (answers.some((a) => a.chosen === "这个月我自己做")) return { outcome: "done", summary: "已按你的决定：这个月不自动处理" };
  if (answers.some((a) => a.chosen === "先不导入，我自己看" || a.chosen === "知道了，我自己处理")) {
    await dropDraft(cfg);
    return { outcome: "done", summary: "已按你的决定：没有导入，草稿已丢弃" };
  }
  try {
    if (cfg.mode === "month") return Object.assign({ outcome: "done" }, await monthRun(cfg, answers));
    if (cfg.mode === "generate") return { outcome: "done", summary: "生成账单：" + cfg.brand + " / " + cfg.shop + " / " + cfg.month + " → " + (await generateIfMissing(cfg)) };
    const records = await withTab(
      FMSConfig.FMS_BILL_URL,
      "FMS",
      async (tabId) => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records,
      { quiet: true }
    );
    const plan = MonthFlow.plan(records, cfg, BillGen.findBills);
    if (cfg.mode === "list") {
      const mine = records.filter((r) => String(r.brandName).toLowerCase() === cfg.brand.toLowerCase() && String(r.shopCode).toLowerCase() === cfg.shop.toLowerCase());
      const by = {};
      for (const r of mine) (by[r.accountingMonth] = by[r.accountingMonth] || []).push(r.settlementNo + "/" + (MonthFlow.STATUS[r.settlementStatus] || r.settlementStatus));
      const ms = Object.keys(by).sort();
      return { outcome: "done", summary: "账单月份清单（只读）：" + cfg.brand + " / " + cfg.shop + " 共 " + mine.length + " 张；" + (ms.map((m) => m + "：" + by[m].join("、")).join("；") || "没有账单") };
    }
    if (cfg.mode === "pending") {
      const mine = records.filter((r) => r.settlementStatus === "PENDING_CONFIRM" && String(r.shopCode).toLowerCase() === cfg.shop.toLowerCase());
      return { outcome: "done", summary: "待确认账单（只读）：" + cfg.shop + " 共 " + mine.length + " 张" + (mine.length ? "：" + mine.map((r) => r.brandName + " " + r.accountingMonth + " " + r.settlementNo).join("；") : "") };
    }
    if (cfg.mode === "base") {
      if (answers.some((a) => a.chosen === "导入并重新生成账单")) return { outcome: "done", summary: "补基础数据：" + cfg.brand + " / " + cfg.shop + " / " + cfg.month + " → " + (await baseApplied(cfg)) };
      const p = await baseProposeCard(records, cfg);
      return { outcome: "done", summary: p.summary, ask: p.ask };
    }
    if (cfg.mode === "basedry") {
      const plan0 = MonthFlow.plan(records, cfg, BillGen.findBills);
      return { outcome: "done", summary: plan0.summary + "\n" + (await baseDry(records, cfg)) };
    }
    if (cfg.mode === "dryrun") return { outcome: "done", summary: plan.summary };
    return { outcome: "done", summary: plan.summary + "\n" + (await cleanBills(records, cfg, cfg.mode === "clean")) };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/登录已过期/.test(msg)) {
      return {
        outcome: "done",
        summary: "待你处理：FMS 登录已过期",
        ask: [{ title: "FMS 登录过期了", text: "月结演练读不到账单。请在浏览器里登录 FMS，登录好再点第一个选项。", options: ["已登录，再试一次", "这个月我自己做"], recommend: 0, key: "fms-login", about: "登录后重新读一遍账单列表" }],
      };
    }
    return { outcome: "failed", error: msg, summary: "没跑成：" + msg.split("\n")[0] };
  }
}

const loopWorker = LoopWorker.create({
  getSettings: async () => (await chrome.storage.local.get("loop")).loop,
  setStatus: (s) => chrome.storage.local.set({ loopStatus: s }),
  handlers: {
    "fms.ping": async () => ({ outcome: "done", summary: "收到：FMS 插件在线（v" + chrome.runtime.getManifest().version + "）" }),
    "fms.month.dryrun": monthDryRun,
    "fms.month.cleandry": monthDryRun,
    "fms.month.clean": monthDryRun,
    "fms.month.generate": monthDryRun,
    "fms.month.list": monthDryRun,
    "fms.month.pending": monthDryRun,
    "rule:FMS·待确认账单清单(手动)": monthDryRun,
    "rule:FMS·补基础数据演练(手动)": monthDryRun,
    "fms.month.basedry": monthDryRun,
    "fms.month.base": monthDryRun,
    "fms.month.run": monthDryRun,
    "fms.month.runall": monthDryRun,
    "fms.month.bagsmart": monthDryRun,
    "rule:FMS·月结BAGSMART(手动)": monthDryRun,
    "rule:FMS·月结全品牌(手动)": monthDryRun,
    "rule:FMS·月结全流程(手动)": monthDryRun,
    "rule:FMS·补基础数据(手动)": monthDryRun,
    "rule:FMS·账单月份清单(手动)": monthDryRun,
    "rule:FMS·生成账单(手动)": monthDryRun,
    "rule:FMS·清洗对账表(手动)": monthDryRun,
    "rule:FMS·清洗演练(手动)": monthDryRun,
    "rule:FMS·月结演练": monthDryRun,
    "rule:FMS·月结流程": monthDryRun,
    "rule:FMS·月结演练(手动)": monthDryRun,
  },
});
function ensureLoop() {
  loopWorker.start(); // 已经在跑就什么都不做；没启用会直接退出
}
// 后台脚本空闲会被浏览器回收，定时唤醒一次，没在连着就重新连上
chrome.alarms.create("loopKeepAlive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "loopKeepAlive") ensureLoop();
});
chrome.runtime.onStartup.addListener(ensureLoop);
chrome.runtime.onInstalled.addListener(ensureLoop);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.loop) return;
  loopWorker.stop(); // 设置变了：让当前这一轮自然结束，下一次唤醒按新设置重新连
  setTimeout(ensureLoop, 1500);
});
ensureLoop();
