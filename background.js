// 后台服务 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 为什么要放在后台：popup 弹窗一失去焦点（比如去点别的标签页看进度）就会被浏览器关掉，
// 里面正在跑的任务也跟着停了。耗时的任务（补基础数据要后台开 FMS 和 EH 两个标签页）改在这里跑，
// 弹窗关了也不受影响；进度写进 chrome.storage.local，弹窗重新打开（或一直开着）都能看到最新状态。

importScripts("src/baseData.js", "src/baseDataSync.js", "src/fmsSync.js", "src/billGen.js");

// 点工具栏图标打开侧边栏（侧边栏切换标签页也不会关，不像弹窗一失焦就消失）
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.error(e));
}

const JOB_KEY = "baseJob";
const STALE_JOB_MS = 10 * 60 * 1000; // 超过10分钟还显示"运行中"，认为是上次异常中断留下的，允许重新开始

async function setJob(patch) {
  const cur = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY] || {};
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ [JOB_KEY]: next });
  return next;
}

async function runStep(tabId, func, args, label) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "MAIN" });
  const r = res && res.result;
  if (!r) throw new Error(`${label}：没有拿到页面的执行结果（可能是页面被刷新或关闭了）`);
  if (!r.ok) {
    const trace = (r.log || []).join(" → ");
    throw new Error(`${label}失败：${r.error}` + (trace ? `\n执行轨迹：${trace}` : ""));
  }
  return r;
}

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
async function withBackgroundTab(url, name, fn, opts) {
  const foreground = !!(opts && opts.foreground);
  const target = new URL(url);
  let prevTab = null;
  if (foreground) {
    try {
      prevTab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
    } catch (e) {}
  }
  const tab = await chrome.tabs.create({ url, active: foreground });
  let keep = false;
  const onTarget = async () => {
    const u = new URL((await chrome.tabs.get(tab.id)).url);
    return u.origin === target.origin && u.pathname.startsWith(target.pathname);
  };
  const needLogin = async () => {
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
    if (!keep) chrome.tabs.remove(tab.id).catch(() => {});
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
      const one = await withBackgroundTab(BaseDataSync.FMS_BILL_URL, "FMS", (tabId) =>
        runStep(tabId, BaseDataSync.fetchMissingPriceRows, [billNos[i]], "读取缺价明细")
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
      const res = await withBackgroundTab(
        BaseDataSync.EH_PRICING_URL,
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

// 一键导入：把人工复查过的 xlsx 传进 FMS「基础数据」→ 导入。耗时较长，直接等结果再回复。
async function runImport(fileName, base64) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const r = await withBackgroundTab(
      BaseDataSync.FMS_BASEDATA_URL,
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
async function runGenerateJob(brands, shop, month) {
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  const multi = brands.length > 1;
  const label = (multi ? brands.join(" + ") : brands[0]) + " / " + shop + " / " + month;
  try {
    await setGen({ text: "正在检查 " + label + " 的账单是否已经存在…", kind: "busy", bills: [] });
    const out = await withBackgroundTab(
      FMSSync.FMS_BILL_URL,
      "FMS",
      async (tabId) => {
        const read = async () => (await runStep(tabId, FMSSync.fetchBillList, [], "读取账单列表")).records;
        const foundOf = (records) => Object.fromEntries(brands.map((b) => [b, BillGen.findBills(records, b, shop, month)]));
        let found = foundOf(await read());
        const existed = brands.filter((b) => found[b].length);
        const failures = {};
        const submitted = [];
        const messages = [];

        let idx = 0;
        for (const brand of brands) {
          idx++;
          if (found[brand].length) continue;
          await setGen({ text: "正在 FMS 生成 " + (multi ? brand + "（" + idx + "/" + brands.length + "）" : label) + " 的账单…", kind: "busy" });
          try {
            const g = await runStep(tabId, BillGen.generateBill, [brand, shop, month], "生成账单");
            submitted.push(brand);
            (g.messages || []).forEach((m) => messages.push(m));
          } catch (e) {
            if (!multi) throw e;
            failures[brand] = e.message.split("\n")[0];
          }
        }

        for (let i = 0; i < 8 && submitted.some((b) => !found[b].length); i++) {
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

    const bills = [];
    for (const brand of brands) {
      for (const r of out.found[brand] || []) bills.push({ billNo: r.settlementNo, status: r.settlementStatus, site: r.siteCode, brand });
    }
    const missing = out.submitted.filter((b) => !out.found[b].length);
    const failedBrands = Object.keys(out.failures);

    if (!bills.length) {
      await setGen({
        running: false,
        kind: failedBrands.length ? "error" : "",
        bills: [],
        text: failedBrands.length
          ? "生成失败：" + failedBrands.map((b) => b + "（" + out.failures[b] + "）").join("；")
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
      const okBrands = [...new Set(bills.map((b) => b.brand))];
      text = "共 " + bills.length + " 张账单（" + okBrands.join("、") + "）" +
        (out.existed.length ? "，其中已存在的：" + out.existed.join("、") : "") + "，已全部填入账单编号。";
      if (missing.length) text += "\n已提交但暂时没在列表里看到：" + missing.join("、") + "，请稍后到 FMS 确认。";
      if (failedBrands.length) text += "\n生成失败：" + failedBrands.map((b) => b + "（" + out.failures[b] + "）").join("；");
    }
    await setGen({ running: false, kind: failedBrands.length || missing.length ? "" : "ok", bills, text });
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
    const out = await withBackgroundTab(
      FMSSync.FMS_BILL_URL,
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
  if (msg && msg.type === "brands:refresh") {
    // 读 FMS「账单生成」弹窗里品牌下拉的全部选项（FMS 新增品牌后，这里能同步到），存起来给面板的品牌下拉用
    (async () => {
      try {
        const r = await withBackgroundTab(
          FMSSync.FMS_BILL_URL,
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
        const recs = await withBackgroundTab(FMSSync.FMS_BILL_URL, "FMS", async (tabId) => {
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
        const recs = await withBackgroundTab(FMSSync.FMS_BILL_URL, "FMS", async (tabId) => {
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
        const recs = await withBackgroundTab(FMSSync.FMS_BILL_URL, "FMS", async (tabId) => {
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
      await setGen({ running: true, startedAt: Date.now(), brands, shop: msg.shop, month: msg.month, text: "任务已开始…", kind: "busy", bills: [] });
      sendResponse({ started: true });
      runGenerateJob(brands, msg.shop, msg.month);
    })();
    return true;
  }
  if (msg && msg.type === "baseData:import") {
    runImport(msg.fileName, msg.base64).then(sendResponse);
    return true;
  }
  if (!msg || msg.type !== "baseData:start") return;
  (async () => {
    const job = (await chrome.storage.local.get(JOB_KEY))[JOB_KEY];
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
