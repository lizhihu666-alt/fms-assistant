// FMS付款助手 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
(() => {
  /**
   * 原始账单 ArrayBuffer（一张或多张）-> 清洗 -> 生成可下载的 blob URL。
   * 多张（同一个 vendor 下的多个品牌）先合并明细再清洗，得到一份整体的对账表，文件名里用 label。
   */
  async function cleanBuffers(buffers, label) {
    const workbooks = buffers.map((b) => XLSX.read(b, { type: "array" }));
    const source = workbooks.length === 1 ? workbooks[0] : FMSCleaner.mergeSources(workbooks);
    const result = FMSCleaner.clean(source);
    if (workbooks.length > 1 && label) result.brand = label;
    // 中文版、英文版各出一份（海外品牌看不懂中文），内容一致，只是表头/标签/文件名的语言不同
    const make = async (lang) => {
      const wbout = await FMSCleaner.workbookToBuffer(FMSCleaner.buildWorkbook(result, lang));
      const blob = new Blob([wbout], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      return { url: URL.createObjectURL(blob), filename: FMSCleaner.buildOutputFileName(result, new Date(), lang) };
    };
    return { zh: await make("zh"), en: await make("en"), rowCount: result.fmsExport.rows.length };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        resolve(result.slice(result.indexOf(",") + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // =====================================================================
  // 整体流程（按账单当前状态分叉）：
  //   1 生成账单 ──→ 状态「待生成请款单」（基础数据完整）─────────────┐
  //              └→ 状态「待确认」（基础数据缺失）                    │
  //                   2 补基础数据（生成模板 → 复查 → 导入）          │
  //                   3 到 FMS 点「重新生成」→ 检查状态变为待生成请款单 ─┤
  //                                                                    ↓
  //   4 下载并清洗对账表（可选，用于跟商家对账） → 5 上传发票并请款（停在草稿）
  // 界面根据「当前账单的状态」决定哪一步亮起、哪些步骤折叠/锁住/跳过。
  // =====================================================================
  const STATUS_LABEL = FMSProgress.STATUS_LABEL;

  const step1Btn = document.getElementById("step1Btn");
  const step2Btn = document.getElementById("step2Btn");
  const resetBtn = document.getElementById("resetBtn");
  const invoiceStatusEl = document.getElementById("invoiceStatus");
  const cleanStatusEl = document.getElementById("cleanStatus");
  const billNoInput = document.getElementById("billNoInput");
  const regenBtn = document.getElementById("regenBtn");
  const skipImportBtn = document.getElementById("skipImportBtn");
  let regenRunning = false;
  const regenStatusEl = document.getElementById("regenStatus");
  const billChip = document.getElementById("billChip");
  const billHint = document.getElementById("billHint");
  const flowGuide = document.getElementById("flowGuide");
  document.getElementById("appVersion").textContent = "v" + chrome.runtime.getManifest().version;
  const invoiceDownloadLink = document.getElementById("invoiceDownloadLink");
  const cleanDlZh = document.getElementById("cleanDlZh");
  const cleanDlEn = document.getElementById("cleanDlEn");
  const cleanDlZhText = document.getElementById("cleanDlZhText");
  const cleanDlEnText = document.getElementById("cleanDlEnText");
  const invoiceDropzone = document.getElementById("invoiceDropzone");
  const invoiceFileInput = document.getElementById("invoiceFileInput");
  const invoiceFileList = document.getElementById("invoiceFileList");

  let invoiceFiles = []; // 可以有多个发票/附件，请款时按顺序都传到报账明细里
  let checking = false;

  // 账单编号框里可以有一张或多张（同一个 vendor 下的多个品牌各有一张账单）：换行/空格/逗号分隔。
  const parseBills = (text) => [...new Set(String(text || "").split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean))];
  const currentBills = () => parseBills(billNoInput.value);
  const flowKeyOf = (nos) => nos.join(",");

  // 当前这批账单的流程进度。侧边栏关掉再开要能接着看，所以存进 chrome.storage.local。
  // bills[i].status 是 FMS 里的结算状态（PENDING_CONFIRM / PENDING_GENERATE_REQUEST …），空表示还没读到。
  // imported/cleaned/requested 是这一批作为整体的进度（补数据是一份合并的模板，清洗是一份合并的对账表，请款是一张费控单）。
  const freshFlow = (key, bills, vendor) => ({
    key: key || "",
    bills: bills || [],
    vendor: vendor || "",
    imported: false,
    cleaned: false,
    requested: false,
  });
  let flow = freshFlow("");
  function saveFlow() {
    chrome.storage.local.set({ flow });
  }
  function setFlow(patch) {
    Object.assign(flow, patch);
    saveFlow();
    renderFlow();
  }
  // 这一批账单的汇总视图（只在 flow 跟输入框里的编号对得上时才有效）
  function flowView() {
    const nos = currentBills();
    const matches = nos.length > 0 && flow.key === flowKeyOf(nos);
    const info = (no) => (matches ? flow.bills.find((b) => b.billNo === no) : null) || {};
    const statuses = nos.map((no) => info(no).status || "");
    const known = nos.length > 0 && statuses.every(Boolean);
    const pendingNos = nos.filter((no) => info(no).status === "PENDING_CONFIRM");
    return { nos, matches, info, known, pendingNos, pending: known && pendingNos.length > 0, ready: known && pendingNos.length === 0 };
  }
  // 清洗对账表、文件名里用的「品牌/Vendor」名称
  function batchLabel() {
    if (flow.vendor) return flow.vendor;
    const brands = [...new Set(flow.bills.map((b) => b.brand).filter(Boolean))];
    return brands.join(" & ");
  }

  const cards = {
    gen: document.getElementById("stepGen"),
    verify: document.getElementById("stepVerify"),
    base: document.getElementById("stepBase"),
    regen: document.getElementById("stepRegen"),
    clean: document.getElementById("stepClean"),
    invoice: document.getElementById("stepInvoice"),
  };
  const subs = {
    gen: document.getElementById("stepGenSub"),
    verify: document.getElementById("stepVerifySub"),
    base: document.getElementById("stepBaseSub"),
    regen: document.getElementById("stepRegenSub"),
    clean: document.getElementById("stepCleanSub"),
    invoice: document.getElementById("stepInvoiceSub"),
  };
  const STATE_TEXT = { done: "✓ 已完成", skipped: "无需此步", locked: "", active: "" };

  // ---- 动效（都是增强：不支持或用户开了「减少动态效果」时直接退化成瞬间切换）----
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let flowReady = false; // 第一次渲染（恢复上次状态）不播动画，之后的状态变化才播
  let lastActive = "";
  const restartAnim = (el, cls, ms) => {
    el.classList.remove(cls);
    void el.offsetWidth; // 强制重排，才能重复播放同一个动画
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  };
  // 展开/折叠用 grid 行高过渡：把每个步骤的内容包一层，才能从 0 平滑过渡到实际高度
  Object.values(cards).forEach((card) => {
    const body = card.querySelector(".step-card-body");
    if (!body || body.querySelector(".step-inner")) return;
    const inner = document.createElement("div");
    inner.className = "step-inner";
    const content = document.createElement("div");
    content.className = "step-content";
    while (body.firstChild) content.appendChild(body.firstChild);
    inner.appendChild(content);
    body.appendChild(inner);
  });

  function setCard(key, state, sub) {
    const card = cards[key];
    const prev = card.dataset.state;
    card.dataset.state = state;
    if (flowReady && prev && prev !== state && state === "done") restartAnim(card.querySelector(".step-badge"), "pop", 700);
    card.querySelector(".step-state").textContent = STATE_TEXT[state] || "";
    subs[key].textContent = sub || "";
    if (state === "active" || state === "locked") card.classList.remove("expanded");
    const head = card.querySelector(".step-card-head");
    const foldable = state === "done" || state === "skipped";
    head.setAttribute("role", foldable ? "button" : "group");
    head.tabIndex = foldable ? 0 : -1;
    if (foldable) head.setAttribute("aria-expanded", String(card.classList.contains("expanded")));
    else head.removeAttribute("aria-expanded");
    card.setAttribute("aria-disabled", String(state === "locked"));
  }
  // 已完成/已跳过的步骤默认折叠，点标题可以展开再看
  Object.values(cards).forEach((card) => {
    const head = card.querySelector(".step-card-head");
    const toggle = () => {
      const s = card.dataset.state;
      if (s === "done" || s === "skipped") {
        card.classList.toggle("expanded");
        head.setAttribute("aria-expanded", String(card.classList.contains("expanded")));
      }
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  });

  const billListEl = document.getElementById("billList");

  function renderFlow() {
    const v = flowView();
    const nos = v.nos;
    const has = nos.length > 0;
    const multi = nos.length > 1;
    const { known, pending, ready } = v;
    const labelOfStatus = (st) => STATUS_LABEL[st] || st;
    const statusSet = [...new Set(nos.map((no) => v.info(no).status).filter(Boolean))];
    const subjectWord = multi ? "这几张账单" : "这张账单";

    // 账单状态：徽标 + 一句话提示（多张时汇总）
    let chipText;
    if (!has) chipText = "未生成";
    else if (!known) chipText = "未检查";
    else if (!multi) chipText = labelOfStatus(statusSet[0]);
    else if (statusSet.length === 1) chipText = "共 " + nos.length + " 张 · " + labelOfStatus(statusSet[0]);
    else chipText = "共 " + nos.length + " 张 · " + v.pendingNos.length + " 张待确认";
    billChip.textContent = chipText;
    billChip.dataset.kind = !known ? "none" : pending ? "warn" : "ok";
    if (!checking && !billHint.dataset.sticky) {
      billHint.className = "bill-hint";
      billHint.textContent = !has
        ? "先在第 1 步生成账单，或直接输入已有账单编号"
        : !known
        ? "还没读到账单状态，点左边的状态标签可以重新读取"
        : pending
        ? (multi ? v.pendingNos.length + " 张基础数据有缺失 → 先做第 3、4 步" : "基础数据有缺失 → 先做第 3、4 步")
        : statusSet.length === 1 && statusSet[0] === "PENDING_GENERATE_REQUEST"
        ? (multi ? "基础数据都完整 → 直接做第 5、6 步" : "基础数据完整 → 直接做第 5、6 步")
        : statusSet.length === 1
        ? subjectWord + "当前是「" + labelOfStatus(statusSet[0]) + "」，不是「待生成请款单」，一般不用再走下面的步骤。"
        : subjectWord + "的状态不一致（" + statusSet.map(labelOfStatus).join("、") + "），请确认后再继续。";
    }

    // 每张账单一行：品牌 · 编号 · 状态（只有读到状态之后才显示）
    billListEl.hidden = !(has && known);
    billListEl.innerHTML = billListEl.hidden
      ? ""
      : nos
          .map((no) => {
            const b = v.info(no);
            const kind = b.status === "PENDING_CONFIRM" ? "warn" : "ok";
            return `<li class="bill-item"><span class="bill-item-brand">${escHtml(b.brand || "")}</span><span class="bill-item-no">${escHtml(no)}</span><span class="bill-chip small" data-kind="${kind}">${escHtml(labelOfStatus(b.status))}</span></li>`;
          })
          .join("");

    // 六个步骤各自的状态
    setCard("gen", has ? "done" : "active", "");
    // 第 2 步：账单状态验证。读到状态后折叠，标题下面保留「编号 · 状态」；没读到（含读取失败）保持展开
    setCard("verify", known ? "done" : "active", known ? (multi ? nos.length + " 张账单 · " + chipText.replace(/^共 \d+ 张 · /, "") : nos[0] + " · " + chipText) : "");
    const waiting = has ? "正在读取账单状态" : "先生成或输入账单";
    if (!known) {
      setCard("base", "locked", waiting);
      setCard("regen", "locked", waiting);
    } else if (ready) {
      setCard("base", "skipped", "基础数据完整，不用补");
      setCard("regen", "skipped", "不用重新生成");
    } else {
      setCard("base", flow.imported ? "done" : "active", flow.imported ? "模板已导入 FMS" : multi ? v.pendingNos.length + " 张账单缺基础数据" : "账单缺基础数据");
      setCard("regen", flow.imported ? "active" : "locked", flow.imported ? "导入后自动重新生成账单" : "先完成第 3 步");
    }
    const lockedSub = !known ? waiting : "账单变成「待生成请款单」后解锁";
    setCard("clean", ready ? (flow.cleaned ? "done" : "active") : "locked", ready ? (multi ? "多个品牌合并成一份对账表" : "可选：用来跟商家对账") : lockedSub);
    setCard("invoice", ready ? (flow.requested ? "done" : "active") : "locked", ready ? (multi ? "多张账单合并请款，上传一份发票" : "") : lockedSub);

    // 顶部「下一步」提示
    let guide;
    if (!has) guide = "下一步：选好品牌（或 Vendor）、店铺和结算月份，生成账单（第 1 步）";
    else if (!known) guide = "正在读取账单状态，稍等…";
    else if (pending && !flow.imported) guide = "下一步：生成基础数据导入文件，复查后导入 FMS（第 3 步）";
    else if (pending) guide = regenRunning ? "正在 FMS 重新生成账单，请稍等（第 4 步）" : "下一步：重新生成账单（第 4 步，导入后会自动执行）";
    else if (flow.requested) guide = "请款完成：请到 FMS 核对草稿，确认无误后自己点「提交」";
    else guide = "下一步：需要对账就先下载对账表（第 5 步），否则直接上传发票请款（第 6 步）";
    if (flowReady && flowGuide.textContent !== guide) restartAnim(flowGuide, "swap", 400);
    flowGuide.textContent = guide;

    // 轮到新的一步时：滚到视野里并轻轻闪一下描边，让人一眼看到「现在该做这个」
    const act = ["gen", "verify", "base", "regen", "clean", "invoice"].find((k) => cards[k].dataset.state === "active") || "";
    if (flowReady && act && act !== lastActive) {
      restartAnim(cards[act], "pulse", 1300);
      setTimeout(() => cards[act].scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" }), 320);
    }
    lastActive = act;
    flowGuide.dataset.kind = flow.requested ? "done" : "next";

    // 按钮可用性：只有账单都确认过、且都不是「待确认」才能走 5、6 步
    const canStep1 = ready && has;
    const canStep2 = ready && has && invoiceFiles.length > 0;
    step1Btn.disabled = !canStep1;
    step2Btn.disabled = !canStep2;
    step1Btn.classList.toggle("btn-primary", canStep1 && !canStep2);
    step1Btn.classList.toggle("btn-outline", !(canStep1 && !canStep2));
    step2Btn.classList.toggle("btn-primary", canStep2);
    step2Btn.classList.toggle("btn-outline", !canStep2);
    regenBtn.disabled = regenRunning;
    regenBtn.textContent = regenRunning ? "后台重新生成中…（可以去看别的标签页）" : "重新生成账单";
    updateBaseBtn(lastBaseJob);
    chrome.storage.local.set({ billNo: billNoInput.value });
  }

  function updateStepButtonsEnabled() {
    renderFlow();
  }

  const escHtml = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // 账单编号变了：流程进度作废，各步骤的结果提示清掉，重新读取账单状态
  function onBillChanged() {
    const key = flowKeyOf(currentBills());
    if (key !== flow.key) {
      flow = freshFlow(key);
      saveFlow();
      billHint.dataset.sticky = "";
      setCleanStatus("");
      setInvoiceStatus("");
      setRegenStatus("");
      invoiceDownloadLink.hidden = true;
      renderBaseJob(lastBaseJob);
    }
    renderFlow();
  }

  // 每个步骤的状态提示也存起来，侧边栏重开后还能看到
  function makeStatusSetter(el, key) {
    return (text, kind) => {
      el.hidden = !text;
      el.textContent = text || "";
      el.className = "status" + (kind ? " " + kind : "");
      chrome.storage.local.set({ [key]: { text: text || "", kind: kind || "" } });
    };
  }
  const setInvoiceStatus = makeStatusSetter(invoiceStatusEl, "invoiceStatus");
  const setCleanStatus = makeStatusSetter(cleanStatusEl, "cleanStatus");
  const setRegenStatus = makeStatusSetter(regenStatusEl, "regenStatus");

  const FILE_ICON =
    '<svg class="file-chip-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.6"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.6"/></svg>';
  const sameFile = (x, y) => x.name === y.name && x.size === y.size && x.lastModified === y.lastModified;
  function renderInvoiceFiles() {
    invoiceFileList.innerHTML = invoiceFiles
      .map(
        (f, i) =>
          '<div class="file-chip">' + FILE_ICON + '<span class="file-chip-name">' + escHtml(f.name) + '</span>' +
          '<button type="button" class="file-chip-remove" data-i="' + i + '" aria-label="移除 ' + escHtml(f.name) + '">✕</button></div>'
      )
      .join("");
    document.getElementById("invoiceDropText").textContent = invoiceFiles.length ? "继续添加文件" : "点击或拖拽上传发票文件（可多选）";
    invoiceDropzone.classList.toggle("compact", invoiceFiles.length > 0);
    document.getElementById("invoiceClear").hidden = invoiceFiles.length < 2;
    renderFlow();
  }
  document.getElementById("invoiceClear").addEventListener("click", () => {
    invoiceFiles = [];
    invoiceFileInput.value = "";
    renderInvoiceFiles();
  });
  function addInvoiceFiles(list) {
    for (const f of list) if (!invoiceFiles.some((x) => sameFile(x, f))) invoiceFiles.push(f);
    renderInvoiceFiles();
  }

  billNoInput.addEventListener("input", onBillChanged);

  resetBtn.addEventListener("click", () => {
    billNoInput.value = "";
    invoiceFileInput.value = "";
    invoiceFiles = [];
    renderInvoiceFiles();
    onBillChanged();
  });

  invoiceDropzone.addEventListener("click", () => invoiceFileInput.click());
  invoiceFileInput.addEventListener("change", (e) => {
    addInvoiceFiles([...e.target.files]);
    invoiceFileInput.value = ""; // 清空，下次再选同一个文件也会触发
  });
  ["dragenter", "dragover"].forEach((evt) => {
    invoiceDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      invoiceDropzone.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    invoiceDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      invoiceDropzone.classList.remove("dragover");
    });
  });
  invoiceDropzone.addEventListener("drop", (e) => {
    addInvoiceFiles([...e.dataTransfer.files]);
  });

  invoiceFileList.addEventListener("click", (e) => {
    const btn = e.target.closest(".file-chip-remove");
    if (!btn) return;
    invoiceFiles.splice(Number(btn.dataset.i), 1);
    renderInvoiceFiles();
  });

  // ---- 读取账单状态：后台打开 FMS 账单列表，一次读出这批账单各自处于什么状态，决定走哪个分支 ----
  async function checkStatus() {
    const nos = currentBills();
    if (!nos.length || checking) return;
    const key = flowKeyOf(nos);
    checking = true;
    billHint.dataset.sticky = "1";
    billHint.className = "bill-hint busy";
    billHint.textContent = nos.length > 1 ? "正在 FMS 里查这 " + nos.length + " 张账单的状态…" : "正在 FMS 里查这张账单的状态…";
    renderFlow();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "bill:status", billNos: nos });
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    checking = false;
    billHint.dataset.sticky = "";
    if (flowKeyOf(currentBills()) !== key) return renderFlow(); // 查的过程中用户改了编号，结果作废
    if (!res || !res.ok) {
      billHint.dataset.sticky = "1";
      billHint.className = "bill-hint error";
      billHint.textContent = "读取账单状态失败：" + ((res && res.error) || "后台服务没有响应，请在扩展管理页刷新本插件后重试");
      setRegenStatus("读取账单状态失败：" + ((res && res.error) || "后台服务没有响应"), "error");
      renderFlow();
      return;
    }
    const wasImported = flow.imported;
    const bills = (res.bills || []).map((b) => ({ billNo: b.billNo, brand: b.brand || "", status: b.status, month: b.month || "" }));
    const stillPending = bills.filter((b) => b.status === "PENDING_CONFIRM");
    if (stillPending.length) {
      setRegenStatus(
        wasImported ? (stillPending.length > 1 ? stillPending.length + " 张账单" : "账单") + "状态还是「待确认」：请确认已在 FMS 点了「重新生成」，等几十秒后再检查一次。" : "",
        wasImported ? "error" : ""
      );
    } else {
      setRegenStatus(wasImported ? "状态已变成「" + (STATUS_LABEL[bills[0].status] || bills[0].status) + "」，基础数据已补齐，可以继续第 5、6 步。" : "", wasImported ? "ok" : "");
    }
    setFlow({ key, bills });
  }

  // 状态提示文字变化时，读屏软件会自动播报
  document.querySelectorAll(".status, .bill-hint, .flow-guide").forEach((el) => {
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
  });

  // 不需要手动点：编号输入完（回车/离开输入框）就自动读取；点状态标签可以重新读取
  billNoInput.addEventListener("change", checkStatus);
  billChip.addEventListener("click", checkStatus);
  billChip.title = "点击重新读取账单状态";

  /**
   * 强制把tab硬刷新到指定URL并等待加载完成（不是SPA内部导航）。
   * 环节二开始前必须这样做一次，否则Vue的keep-alive可能复用上一次访问该页面时
   * 缓存的组件状态（比如上一次搜索过的账单号），导致自动化操作到错误的账单——
   * 这是真实发生过的事故，这道保险不能省。
   */
  function navigateTabAndWait(tabId, url, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let sawLoading = false;
      const finish = (fn, arg) => {
        clearTimeout(timer);
        clearInterval(poll);
        chrome.tabs.onUpdated.removeListener(listener);
        fn(arg);
      };
      // 不只靠事件：每 500ms 也直接问一次标签页的状态，防止错过「加载完成」事件。
      // 必须先看到过「加载中」才认「完成」，免得把刷新前那次旧的「完成」当成这次的。
      const check = async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          if (t.status === "loading") sawLoading = true;
          else if (t.status === "complete" && sawLoading && (t.url || "").startsWith(url)) finish(resolve);
        } catch (e) {
          // 标签页不存在了（被关掉）：不用傻等到超时，马上报出来让调用方重选
          const gone = new Error("要刷新的 FMS 标签页被关掉了");
          gone.tabGone = true;
          finish(reject, gone);
        }
      };
      const poll = setInterval(check, 500);
      const timer = setTimeout(async () => {
        let where = "";
        try {
          const t = await chrome.tabs.get(tabId);
          where = "（页面状态：" + t.status + "，地址：" + (t.url || "").slice(0, 80) + "）";
        } catch (e) {
          // 标签页已经不存在了：被关掉了，不是加载慢——交给调用方重新选一个标签页再试
          const gone = new Error("要刷新的 FMS 标签页被关掉了");
          gone.tabGone = true;
          return finish(reject, gone);
        }
        finish(reject, new Error("页面刷新超时" + where + "。如果浏览器弹出了「离开此网站？」之类的提示，请点「离开」；也可能是 FMS 页面加载很慢，稍后再试一次。"));
      }, timeoutMs);
      function listener(updatedTabId, info) {
        if (updatedTabId !== tabId) return;
        if (info.status === "loading") sawLoading = true;
        if (info.status === "complete" && sawLoading) check();
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.update(tabId, { url });
    });
  }

  async function runStep(tabId, func, args, label) {
    const [injectionResult] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      world: "MAIN", // 必须用主世界，才能跟FMS页面自己的代码共用同一个 Node.prototype
    });
    const automationResult = injectionResult && injectionResult.result;
    if (!automationResult) {
      throw new Error(`${label}：插件没有拿到FMS页面的执行结果（可能是页面刷新打断了执行）`);
    }
    if (!automationResult.ok) {
      const trace = (automationResult.log || []).join(" → ");
      throw new Error(`${label}失败：${automationResult.error}` + (trace ? `\n执行轨迹：${trace}` : ""));
    }
    return automationResult;
  }

  /**
   * 确保当前有一个标签页停在 FMS 品牌商账单页，并且是刚硬刷新过的、干净的状态
   * （不依赖SPA内部导航/keep-alive缓存——真实事故教训，见 navigateTabAndWait 注释）。
   * 第 5、6 步开始前都调用这个，保证不管隔了多久、标签页停在哪个页面，
   * 每次真正开始自动化操作前状态都是可靠的。
   */
  async function ensureFreshFmsTab(setStatus) {
    // 选中的标签页如果在刷新途中消失了（被别的后台任务关掉），重新选一次再试，最多 2 次
    for (let attempt = 1; ; attempt++) {
      try {
        return await pickAndRefreshFmsTab(setStatus);
      } catch (e) {
        if (attempt >= 2 || !e.tabGone) throw e;
      }
    }
  }
  async function pickAndRefreshFmsTab(setStatus) {
    // 插件自己临时开的标签页（读账单列表等后台任务用的，马上会关）不能当成「用户的 FMS 页面」
    let tempIds = [];
    try {
      tempIds = ((await chrome.runtime.sendMessage({ type: "tabs:temp" })) || {}).ids || [];
    } catch (e) {}
    let tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!FMSAutomation.isOnFmsBillPage(tab && tab.url) || tempIds.includes(tab && tab.id)) {
      // 当前激活的标签页不是FMS账单页，尝试在所有已打开的标签页里找一个匹配的，自动切过去
      const allTabs = await chrome.tabs.query({});
      const fmsTab = allTabs.find((t) => FMSAutomation.isOnFmsBillPage(t.url) && !tempIds.includes(t.id));
      if (fmsTab) {
        tab = fmsTab;
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } else if (!(tab && tab.id != null)) {
        throw new Error(`请先在浏览器标签页打开 FMS 账单页面：\n${FMSAutomation.FMS_URL_PATTERN}`);
      }
    }
    setStatus("正在刷新页面，确保状态是最新的…", "busy");
    await navigateTabAndWait(tab.id, FMSAutomation.FMS_URL_PATTERN);
    return tab;
  }

  // 第 5 步：下载原始明细并清洗。只需要账单编号，不需要发票文件——
  // 需要跟商家对账的场景就用这一步产出的清洗后文件去对账。
  // 同一个 vendor 下的多张账单：逐张下载原始明细，合并成一份再清洗，得到一份整个 vendor 的对账表。
  step1Btn.addEventListener("click", async () => {
    const nos = currentBills();
    if (!nos.length) return;

    step1Btn.disabled = true;
    invoiceDownloadLink.hidden = true;

    try {
      const buffers = [];
      for (let i = 0; i < nos.length; i++) {
        const tag = nos.length > 1 ? `（第 ${i + 1}/${nos.length} 张 ${nos[i]}）` : "";
        const tab = await ensureFreshFmsTab(setCleanStatus);

        setCleanStatus("查看明细 → 导出 → 等待任务处理…" + tag, "busy");
        const step1 = await runStep(tab.id, FMSAutomation.downloadRawBillFile, [nos[i]], "下载账单" + tag);

        setCleanStatus(`导出任务 ${step1.taskNo} 处理成功，正在下载原始账单…` + tag, "busy");
        const resp = await fetch(step1.downloadUrl);
        if (!resp.ok) throw new Error(`下载原始账单失败: HTTP ${resp.status}` + tag);
        buffers.push(await resp.arrayBuffer());
      }

      setCleanStatus(nos.length > 1 ? "正在合并 " + nos.length + " 张账单并清洗数据…" : "正在清洗数据…", "busy");
      const { zh, en, rowCount } = await cleanBuffers(buffers, batchLabel());
      cleanDlZh.href = zh.url;
      cleanDlZh.download = zh.filename;
      cleanDlZhText.textContent = `中文版：${zh.filename}`;
      cleanDlEn.href = en.url;
      cleanDlEn.download = en.filename;
      cleanDlEnText.textContent = `English：${en.filename}`;
      invoiceDownloadLink.hidden = false;

      setCleanStatus(
        `清洗完成，${nos.length > 1 ? "合并了 " + nos.length + " 张账单，" : ""}共 ${rowCount} 行。可以下载去对账，对完账再做第 6 步；不需要对账就直接做第 6 步。`,
        "ok"
      );
      setFlow({ cleaned: true });
    } catch (err) {
      console.error(err);
      setCleanStatus("下载或清洗失败：" + err.message, "error");
    } finally {
      renderFlow();
    }
  });

  // 第 6 步：请款 + 上传发票，停在草稿。不关心第 5 步是否刚刚由本插件跑过——
  // 只要账单在FMS里处于正确的结算状态即可，所以可以跟第 5 步间隔任意长时间执行。
  // 多张账单（同一个 vendor）：一起勾选请款，合并成一张费控单，上传一份发票。
  step2Btn.addEventListener("click", async () => {
    const allNos = currentBills();
    if (!allNos.length || !invoiceFiles.length) return;

    // 一个 vendor 下的账单状态常常不一样：「无需结算」的不用请款；已经「待请款」的已有自己的费控单，
    // 不能再并进新的请款单。所以只对「待生成请款单」的那批一起请款，其余的先告诉用户、让用户确认。
    const statusOf = Object.fromEntries((flow.bills || []).map((b) => [b.billNo, b.status]));
    const skipNos = allNos.filter((no) => statusOf[no] === "NO_SETTLEMENT_REQUIRED");
    const doneNos = allNos.filter((no) => statusOf[no] === "PENDING_REQUEST");
    const todoNos = allNos.filter((no) => statusOf[no] === "PENDING_GENERATE_REQUEST");
    let nos = allNos;
    if (skipNos.length || (doneNos.length && todoNos.length)) {
      const keep = todoNos.length ? todoNos : doneNos; // 有待请款的就请这批；全是「待请款」就是补传发票
      nos = allNos.filter((no) => keep.includes(no) || !skipNos.includes(no) && !doneNos.includes(no) && !todoNos.includes(no));
      const lines = [];
      if (skipNos.length) lines.push("无需结算，已跳过（" + skipNos.length + " 张）：" + skipNos.join("、"));
      if (doneNos.length && todoNos.length) lines.push("已经请过款，有自己的费控单，不会并入（" + doneNos.length + " 张）：" + doneNos.join("、"));
      const ok = window.confirm(
        "这批账单的状态不完全一样：\n" + lines.join("\n") +
          "\n\n本次将处理 " + nos.length + " 张：" + nos.join("、") +
          (todoNos.length ? "\n（一起请款，合并成一张请款单，上传发票）" : "\n（已请过款，直接在现有费控单上传发票）") +
          "\n\n确定：继续\n取消：先不处理"
      );
      if (!ok) {
        setInvoiceStatus("已取消请款，没有对 FMS 做任何改动。", "");
        return;
      }
    }
    if (!nos.length) {
      setInvoiceStatus("这些账单都不需要请款（状态是「无需结算」）。", "error");
      return;
    }

    step2Btn.disabled = true;

    try {
      // 请款前先看同品牌有没有别的待请款账单：FMS 请款时可能把它们并进同一张费控单，让用户自己决定
      setInvoiceStatus("检查同品牌的其他待请款账单…", "busy");
      let sib = null;
      try {
        sib = await chrome.runtime.sendMessage({ type: "bill:siblings", billNos: nos });
      } catch (e) {
        sib = null;
      }
      if (sib && sib.ok && sib.siblings.length) {
        const list = sib.siblings.map((s) => s.brand + " " + s.month + "（" + s.billNo + "）").join("\n");
        const go = window.confirm(
          "同品牌还有 " + sib.siblings.length + " 张待请款账单：\n" + list +
          "\n\nFMS 请款时可能会把它们一起并进同一张请款单（金额合并）。\n\n确定：继续请款\n取消：先不请款（可以先到 FMS 处理其他账单）"
        );
        if (!go) {
          setInvoiceStatus("已取消请款，没有对 FMS 做任何改动。", "");
          return;
        }
      }
      const tab = await ensureFreshFmsTab(setInvoiceStatus);

      setInvoiceStatus(nos.length > 1 ? "一起勾选 " + nos.length + " 张账单请款 → 等待10秒 → 上传发票…" : "请款 → 等待10秒 → 上传发票…", "busy");
      const files = [];
      for (const f of invoiceFiles) files.push({ name: f.name, mime: f.type, b64: await fileToBase64(f) });
      // 报账明细里的「业务发生日期」要填所开月份的第一天；多张账单取最早的月份
      const months = (flow.bills || []).map((b) => b.month).filter((m) => /^\d{4}-\d{2}$/.test(m || "")).sort();
      const args = [files, months[0] || ""];
      const step2 =
        nos.length > 1
          ? await runStep(tab.id, FMSAutomation.submitInvoiceMulti, [nos, ...args], "请款并上传发票")
          : await runStep(tab.id, FMSAutomation.submitInvoiceAndConfirm, [nos[0], ...args], "请款并上传发票");

      const warn = [];
      if (step2.lineCount > 1) warn.push(`注意：这张请款单的报账明细有 ${step2.lineCount} 行，发票只附在了第一行，请核对其余行是否也需要附件。`);
      if (step2.dateNote) warn.push(step2.dateNote);
      setInvoiceStatus(
        `请款完成：${nos.length > 1 ? nos.length + " 张账单合并成请款单 " : "请款单 "}${step2.ajfNo} 已附上${files.length > 1 ? files.length + " 个文件" : "发票"}，保存为草稿。请到 FMS 核对后，自己点「提交」。` +
          (warn.length ? "\n" + warn.join("\n") : ""),
        warn.length ? "" : "ok"
      );
      setFlow({ requested: true });
    } catch (err) {
      console.error(err);
      setInvoiceStatus("请款失败：" + err.message, "error");
    } finally {
      renderFlow();
    }
  });

  // ---- 第 1 步 生成账单：任务在后台服务里跑，这里只发起任务、显示进度、把账单编号填进第 2 步 ----
  // 两种方式：按品牌（一个品牌一张账单）/ 按 Vendor（该 vendor 下勾选的所有品牌，每个品牌各一张账单）。
  const genBrand = document.getElementById("genBrand");
  const genShop = document.getElementById("genShop");
  const genMonth = document.getElementById("genMonth");
  const genMonthsEl = document.getElementById("genMonths");
  let genMonths = []; // 已选的结算月份（升序），生成时每个月份 × 每个品牌各生成一张
  const genBtn = document.getElementById("genBtn");
  const genStatus = document.getElementById("genStatus");
  const genMode = document.getElementById("genMode");
  const genBrandBox = document.getElementById("genBrandBox");
  const genVendorBox = document.getElementById("genVendorBox");
  const genVendor = document.getElementById("genVendor");
  const genVendorBrands = document.getElementById("genVendorBrands");
  let genAppliedKey = "";
  let genModeValue = "brand";
  let vendors = [];
  let savedVendorId = "";

  // 品牌清单：优先用从 FMS 读回来的（点「刷新品牌」），没读过就用内置的
  let brandList = BillGen.BRANDS.slice();
  function renderBrandOptions() {
    const cur = genBrand.value;
    genBrand.innerHTML = '<option value="">请选择品牌</option>' + brandList.map((b) => '<option value="' + escHtml(b) + '">' + escHtml(b) + "</option>").join("");
    if (cur && brandList.includes(cur)) genBrand.value = cur;
  }
  renderBrandOptions();
  chrome.storage.local.get("brandList", (r) => {
    if (r.brandList && r.brandList.brands && r.brandList.brands.length) {
      brandList = r.brandList.brands.slice();
      renderBrandOptions();
      renderVendorBrands();
    }
  });
  const genBrandRefresh = document.getElementById("genBrandRefresh");
  genBrandRefresh.addEventListener("click", async () => {
    genBrandRefresh.disabled = true;
    genBrandRefresh.textContent = "读取中…";
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "brands:refresh" });
    } catch (e) {
      res = null;
    }
    genBrandRefresh.disabled = false;
    if (res && res.ok) {
      const stored = await chrome.storage.local.get("brandList");
      brandList = stored.brandList.brands.slice();
      renderBrandOptions();
      renderVendorBrands();
      genBrandRefresh.textContent = "已更新 " + res.count + " 个";
      setTimeout(() => (genBrandRefresh.textContent = "刷新品牌"), 2500);
    } else {
      genBrandRefresh.textContent = "读取失败，点击重试";
    }
  });
  genShop.innerHTML = BillGen.SHOPS.map((s) => '<option value="' + escHtml(s) + '">' + escHtml(s) + "</option>").join("");
  {
    // 默认上个月（一般是生成上个月的账单）
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    genMonth.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    genMonths = [genMonth.value];
  }

  // Vendor 清单：手动指定的分组（见 progress.js 的 vendorGroups）+ FMS 账单里「品牌商公司」下有 2 个以上品牌的。
  // FMS 的数据来自付款进度上次同步的快照，没同步过就只有手动指定的。
  function buildVendors(snapshotBills) {
    const out = [];
    const covered = new Set();
    for (const g of FMSProgress.DEFAULTS.vendorGroups || []) {
      out.push({ id: "m:" + g.vendor, label: g.brands.join(" + ") + " · " + g.shop, shop: g.shop, brands: g.brands.slice() });
      g.brands.forEach((b) => covered.add(b.toLowerCase()));
    }
    // 同一个 vendor = 同一个品牌商公司 + 同一个店铺（同一个品牌在不同店铺下的品牌商公司可能不同）
    const groups = new Map();
    for (const b of snapshotBills || []) {
      if (!b.brandCompany || !b.brandName) continue;
      const k = String(b.brandCompany) + "|" + (b.shopCode || "");
      if (!groups.has(k)) groups.set(k, { company: String(b.brandCompany), shop: b.shopCode || "", brands: new Set() });
      groups.get(k).brands.add(b.brandName);
    }
    for (const g of groups.values()) {
      const brands = [...g.brands].sort((x, y) => x.localeCompare(y));
      if (brands.length < 2 || brands.every((b) => covered.has(b.toLowerCase()))) continue;
      out.push({ id: "c:" + g.company + "|" + g.shop, label: brands.join(" + ") + (g.shop ? " · " + g.shop : ""), shop: g.shop, brands });
    }
    return out;
  }

  // 选了 vendor 就已经确定了店铺（vendor = 品牌商公司 + 店铺），不用再选；vendor 没有店铺信息时才显示店铺下拉
  const genShopBlock = document.getElementById("genShopBlock");
  const genRow = genShopBlock.parentElement;
  function updateShopVisibility() {
    const v = vendors.find((x) => x.id === genVendor.value);
    const fixed = genModeValue === "vendor" && !!(v && v.shop);
    genShopBlock.hidden = fixed;
    genRow.classList.toggle("single", fixed);
  }

  function renderVendorBrands() {
    const v = vendors.find((x) => x.id === genVendor.value);
    genVendorBrands.innerHTML = v
      ? v.brands
          .map((b) => {
            const known = brandList.some((x) => x.toLowerCase() === b.toLowerCase());
            return `<label class="brand-check"><input type="checkbox" value="${escHtml(b)}" checked><span>${escHtml(b)}</span>${known ? "" : "<em>FMS 下拉里暂无，可能生成失败</em>"}</label>`;
          })
          .join("")
      : '<p class="empty-note">没有可选的 Vendor：到「付款进度」里同步一次数据后，会列出 FMS 里有多个品牌的 vendor。</p>';
    if (v && v.shop) genShop.value = v.shop;
    updateShopVisibility();
    updateGenBtn();
  }
  // 后台读一遍 FMS 账单列表，更新 vendor 清单（付款进度同步过的快照可能是旧的/不全的）
  const genVendorRefresh = document.getElementById("genVendorRefresh");
  let vendorBillsCache = null; // { at, bills }
  let vendorRefreshing = false;
  async function refreshVendors() {
    if (vendorRefreshing) return;
    vendorRefreshing = true;
    genVendorRefresh.textContent = "读取中…";
    genVendorRefresh.disabled = true;
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "vendors:refresh" });
    } catch (e) {
      res = null;
    }
    vendorRefreshing = false;
    genVendorRefresh.disabled = false;
    genVendorRefresh.textContent = res && res.ok ? "刷新清单" : "读取失败，点击重试";
    if (res && res.ok) {
      const stored = await chrome.storage.local.get("vendorBills");
      vendorBillsCache = stored.vendorBills || null;
      vendors = buildVendors(allVendorSourceBills());
      renderVendorOptions();
    }
  }
  genVendorRefresh.addEventListener("click", refreshVendors);
  let snapshotBillsCache = [];
  const allVendorSourceBills = () => [...snapshotBillsCache, ...((vendorBillsCache && vendorBillsCache.bills) || [])];

  // ---- Vendor 下拉：自绘，店铺名用红字，跟前面的品牌名区分开 ----
  const vselBtn = document.getElementById("genVendorBtn");
  const vselList = document.getElementById("genVendorList");
  const vendorLabelHtml = (v) => escHtml(v.brands.join(" + ")) + (v.shop ? ' · <span class="shop-red">' + escHtml(v.shop) + "</span>" : "");
  function syncVendorBtn() {
    const v = vendors.find((x) => x.id === genVendor.value);
    vselBtn.innerHTML = v ? vendorLabelHtml(v) : "（暂无）";
    vselList.querySelectorAll("li").forEach((li) => li.setAttribute("aria-selected", String(li.dataset.id === genVendor.value)));
  }
  function setVselOpen(open) {
    vselList.hidden = !open;
    vselBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      const cur = vselList.querySelector('li[aria-selected="true"]');
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
  }
  function pickVendor(id) {
    genVendor.value = id;
    genVendor.dispatchEvent(new Event("change"));
    syncVendorBtn();
    setVselOpen(false);
  }
  vselBtn.addEventListener("click", () => {
    if (vendors.length) setVselOpen(vselList.hidden);
  });
  vselList.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (li) pickVendor(li.dataset.id);
  });
  vselBtn.addEventListener("keydown", (e) => {
    if (!vendors.length) return;
    const i = vendors.findIndex((x) => x.id === genVendor.value);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const j = Math.min(vendors.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
      if (vselList.hidden) setVselOpen(true);
      pickVendor(vendors[j].id);
      setVselOpen(true);
    } else if (e.key === "Escape") {
      setVselOpen(false);
    }
  });
  document.addEventListener("click", (e) => {
    if (!vselList.hidden && !document.getElementById("genVendorSel").contains(e.target)) setVselOpen(false);
  });

  function renderVendorOptions() {
    genVendor.innerHTML = vendors.length
      ? vendors.map((v) => `<option value="${escHtml(v.id)}">${escHtml(v.label)}</option>`).join("")
      : '<option value="">（暂无）</option>';
    if (savedVendorId && vendors.some((v) => v.id === savedVendorId)) genVendor.value = savedVendorId;
    vselList.innerHTML = vendors
      .map((v) => '<li role="option" data-id="' + escHtml(v.id) + '" aria-selected="false">' + vendorLabelHtml(v) + "</li>")
      .join("");
    syncVendorBtn();
    renderVendorBrands();
  }
  const selectedBrands = () =>
    genModeValue === "vendor" ? [...genVendorBrands.querySelectorAll("input:checked")].map((i) => i.value) : genBrand.value ? [genBrand.value] : [];

  function setGenMode(m, persist) {
    genModeValue = m;
    genMode.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.mode === m);
      b.setAttribute("aria-selected", String(b.dataset.mode === m));
    });
    genBrandBox.hidden = m !== "brand";
    genVendorBox.hidden = m !== "vendor";
    updateShopVisibility();
    if (m === "vendor") {
      renderVendorBrands();
      if (!vendorBillsCache || Date.now() - vendorBillsCache.at > 12 * 3600 * 1000) refreshVendors();
    }
    if (persist) saveGenForm();
    else updateGenBtn();
  }

  function saveGenForm() {
    chrome.storage.local.set({ genForm: { mode: genModeValue, brand: genBrand.value, vendor: genVendor.value, shop: genShop.value, month: genMonth.value, months: genMonths } });
    updateGenBtn();
  }
  let genRunning = false;
  function updateGenBtn() {
    const brands = selectedBrands();
    genBtn.disabled = genRunning || !brands.length || !genShop.value || !genMonths.length;
    genBtn.textContent = genRunning
      ? "后台生成中…（可以去看别的标签页）"
      : genModeValue === "vendor"
      ? brands.length
        ? `生成 ${brands.length} 个品牌${genMonths.length > 1 ? " × " + genMonths.length + " 个月份" : ""}的账单`
        : "请至少勾选一个品牌"
      : genMonths.length > 1
      ? `生成 ${genMonths.length} 个月份的账单`
      : "生成账单";
  }

  // 已选月份的标签：月份输入框每选一个就加进来，点 ✕ 去掉；至少保留一个
  function renderGenMonths() {
    genMonths = [...new Set(genMonths)].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
    genMonthsEl.innerHTML = genMonths
      .map((m) => '<span class="month-chip">' + m.replace("-", "年") + '月' + '<button type="button" data-m="' + m + '" aria-label="移除 ' + m + '">✕</button>' + "</span>")
      .join("");
    genMonthsClear.hidden = genMonths.length < 2;
    updateGenBtn();
  }
  const genMonthsClear = document.getElementById("genMonthsClear");
  genMonthsClear.addEventListener("click", () => {
    genMonths = [];
    genMonth.value = "";
    renderGenMonths();
    saveGenForm();
  });
  genMonth.addEventListener("change", () => {
    if (genMonth.value) genMonths.push(genMonth.value);
    renderGenMonths();
    saveGenForm();
  });
  genMonthsEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-m]");
    if (!b) return;
    genMonths = genMonths.filter((m) => m !== b.dataset.m);
    renderGenMonths();
    saveGenForm();
  });
  renderGenMonths();
  [genBrand, genShop, genMonth, genVendor].forEach((el) => el.addEventListener("change", () => (el === genVendor ? (renderVendorBrands(), saveGenForm()) : saveGenForm())));
  genVendorBrands.addEventListener("change", updateGenBtn);
  genMode.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => setGenMode(b.dataset.mode, true)));

  function renderGenJob(job) {
    genRunning = !!(job && job.running);
    updateGenBtn();
    if (!job || !job.text) return;
    genStatus.hidden = false;
    genStatus.textContent = job.text;
    genStatus.className = "status" + (job.kind ? " " + job.kind : "");
    // 生成成功后把账单编号和状态填进第 2 步（同一次结果只填一次，不覆盖用户之后的修改）
    const key = (job.startedAt || 0) + ":" + (job.bills || []).map((x) => x.billNo).join(",");
    if (!job.running && job.bills && job.bills.length && key !== genAppliedKey) {
      genAppliedKey = key;
      const nos = job.bills.map((x) => x.billNo);
      billNoInput.value = nos.join("\n");
      flow = freshFlow(flowKeyOf(nos), job.bills.map((x) => ({ billNo: x.billNo, brand: x.brand || "", status: x.status || "", month: x.month || "" })));
      saveFlow();
      setCleanStatus("");
      setInvoiceStatus("");
      setRegenStatus("");
      invoiceDownloadLink.hidden = true;
      billHint.dataset.sticky = "";
      renderBaseJob(lastBaseJob);
      renderFlow();
    }
  }

  genBtn.addEventListener("click", async () => {
    const brands = selectedBrands();
    if (!brands.length || !genShop.value || !genMonths.length) return;
    const msg =
      "确认在 FMS 生成账单？\n" +
      (brands.length > 1 ? "品牌（" + brands.length + " 个）：" + brands.join("、") : "品牌：" + brands[0]) +
      "\n店铺：" + genShop.value + "\n结算月份：" + genMonths.join("、") +
      (genMonths.length * brands.length > 1 ? "\n共 " + genMonths.length * brands.length + " 张账单（已存在的不会重复生成）" : "");
    if (genRunning || !confirm(msg)) return;
    genRunning = true; // 先本地上锁，等后台写入进度前再点也不会重复生成
    updateGenBtn();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "bill:generate", brands, shop: genShop.value, months: genMonths, month: genMonths[0] });
    } catch (e) {
      res = null;
    }
    if (!res || !res.started) {
      genRunning = false;
      updateGenBtn();
      genStatus.hidden = false;
      genStatus.className = "status error";
      genStatus.textContent = (res && res.reason) || "后台服务没有响应。请在浏览器的扩展管理页刷新本插件，再重试。";
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.genJob) renderGenJob(changes.genJob.newValue);
  });

  // ---- 第 4 步 重新生成：后台在 FMS 账单总表点「重新生成」，并等状态变成「待生成请款单」 ----
  // 多张账单时只处理还是「待确认」的那几张。
  let regenAppliedKey = "";
  async function startRegen() {
    const v = flowView();
    const billNos = v.pendingNos.length ? v.pendingNos : v.nos;
    if (!billNos.length || regenRunning) return;
    regenRunning = true;
    renderFlow();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "bill:regenerate", billNos });
    } catch (e) {
      res = null;
    }
    if (!res || !res.started) regenRunning = false;
    renderFlow();
    if (!res || !res.started) setRegenStatus((res && res.reason) || "后台服务没有响应。请在浏览器的扩展管理页刷新本插件，再重试。", "error");
  }
  regenBtn.addEventListener("click", startRegen);
  skipImportBtn.addEventListener("click", () => setFlow({ imported: true }));

  function renderRegenJob(job) {
    regenRunning = !!(job && job.running);
    const jobNos = (job && (job.billNos || (job.billNo ? [job.billNo] : []))) || [];
    const cur = currentBills();
    if (job && job.text && jobNos.length && jobNos.every((no) => cur.includes(no))) {
      setRegenStatus(job.text, job.kind);
      const key = (job.startedAt || 0) + ":" + JSON.stringify(job.statuses || job.status || "");
      if (!job.running && (job.statuses || job.status) && key !== regenAppliedKey) {
        regenAppliedKey = key;
        const statuses = job.statuses && Object.keys(job.statuses).length ? job.statuses : { [jobNos[0]]: job.status };
        const bills = flow.bills.map((b) => (statuses[b.billNo] ? { ...b, status: statuses[b.billNo] } : b));
        setFlow({ bills });
        return;
      }
    }
    renderFlow();
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.regenJob) renderRegenJob(changes.regenJob.newValue);
  });

  // ---- 第 3 步 补基础数据：待确认账单缺结算价 → 读缺失SKU → EH查成本 → 生成模板 → 复查 → 一键导入 ----
  // 任务本身在后台服务（background.js）里跑：侧边栏/弹窗被关掉不影响任务，
  // 这里只负责发起任务、把后台写进 storage 的进度显示出来。
  const baseBtn = document.getElementById("baseBtn");
  const baseStatusEl = document.getElementById("baseStatus");
  const baseDownload = document.getElementById("baseDownload");
  const baseDownloadText = document.getElementById("baseDownloadText");
  const baseUnresolved = document.getElementById("baseUnresolved");
  let baseDownloadKey = ""; // 同一份结果只生成一次下载链接
  let baseBlob = null; // 当前生成的模板，一键导入用
  let lastBaseJob = null;
  const baseImportBox = document.getElementById("baseImportBox");
  const baseImportBtn = document.getElementById("baseImportBtn");
  const baseImportOwnBtn = document.getElementById("baseImportOwnBtn");
  const baseImportFile = document.getElementById("baseImportFile");
  const baseImportStatus = document.getElementById("baseImportStatus");
  let importing = false;

  function setImportStatus(text, kind) {
    baseImportStatus.hidden = !text;
    baseImportStatus.textContent = text || "";
    baseImportStatus.className = "status" + (kind ? " " + kind : "");
  }

  async function runImport(fileName, blob) {
    if (importing) return;
    importing = true;
    baseImportBtn.disabled = baseImportOwnBtn.disabled = true;
    setImportStatus("正在导入：后台打开 FMS「基础数据」→ 上传文件 → 确认…（可以去看别的标签页）", "busy");
    try {
      const base64 = await fileToBase64(blob);
      const res = await chrome.runtime.sendMessage({ type: "baseData:import", fileName, base64 });
      if (!res || !res.ok) {
        setImportStatus("导入失败：" + ((res && res.error) || "后台没有返回结果，请刷新插件后重试"), "error");
        return;
      }
      const tips = res.messages.length ? "FMS 提示：" + res.messages.join("；") + "\n" : "";
      setImportStatus(
        "已提交导入。" + tips + "导入是否成功，可到 FMS「基础数据」→「导入导出任务」确认。正在自动进入第 4 步：重新生成账单。",
        "ok"
      );
      setFlow({ imported: true });
      startRegen();
    } catch (err) {
      console.error(err);
      setImportStatus("导入失败：" + err.message, "error");
    } finally {
      importing = false;
      baseImportBtn.disabled = baseImportOwnBtn.disabled = false;
    }
  }

  baseImportBtn.addEventListener("click", () => {
    if (!baseBlob) return;
    if (!confirm("确认已人工复查过模板？将直接导入 FMS「基础数据」。")) return;
    runImport(baseDownload.download, baseBlob);
  });
  baseImportOwnBtn.addEventListener("click", () => baseImportFile.click());
  baseImportFile.addEventListener("change", () => {
    const f = baseImportFile.files[0];
    baseImportFile.value = "";
    if (!f) return;
    if (!confirm("确认导入你选择的文件「" + f.name + "」到 FMS「基础数据」？")) return;
    runImport(f.name, f);
  });

  function updateBaseBtn(job) {
    const running = !!(job && job.running);
    baseBtn.disabled = running || !currentBills().length;
    baseBtn.textContent = running ? "后台处理中…（可以去看别的标签页）" : "生成基础数据导入文件";
  }

  async function renderBaseJob(job) {
    lastBaseJob = job || null;
    updateBaseBtn(job);
    // 后台任务是针对某一批账单的；当前账单换了，就不显示上一批的结果
    const jobNos = (job && (job.billNos || (job.billNo ? [job.billNo] : []))) || [];
    const mine = job && job.text && (!jobNos.length || jobNos.every((no) => currentBills().includes(no)));
    if (!mine) {
      baseStatusEl.hidden = true;
      baseUnresolved.hidden = true;
      baseDownload.hidden = true;
      baseImportBox.hidden = true;
      return;
    }
    baseStatusEl.hidden = false;
    baseStatusEl.textContent = job.text;
    baseStatusEl.className = "status" + (job.kind ? " " + job.kind : "");
    baseUnresolved.hidden = !job.unresolved;
    baseUnresolved.textContent = job.unresolved || "";

    if (!job.running && job.rows && job.rows.length && job.fileName) {
      const key = job.fileName + ":" + job.rows.length + ":" + (job.startedAt || 0);
      if (key !== baseDownloadKey) {
        baseDownloadKey = key;
        const wb = FMSBaseData.toWorkbook(ExcelJS, job.rows);
        const buf = await wb.xlsx.writeBuffer();
        const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        baseBlob = blob;
        setImportStatus("");
        baseDownload.href = URL.createObjectURL(blob);
        baseDownload.download = job.fileName;
        baseDownloadText.textContent = "下载：" + job.fileName;
      }
      baseDownload.hidden = false;
      baseImportBox.hidden = false;
    } else {
      baseDownload.hidden = true;
      baseImportBox.hidden = true;
    }
  }

  baseBtn.addEventListener("click", async () => {
    // 只处理还是「待确认」的账单（同一个 vendor 下多张时，其余已经没问题的不用补）
    const v = flowView();
    const billNos = v.pendingNos.length ? v.pendingNos : v.nos;
    if (!billNos.length) return;
    baseDownload.hidden = true;
    baseImportBox.hidden = true;
    setImportStatus("");
    baseBtn.disabled = true; // 先本地上锁，防止后台进度写入前重复点击
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: "baseData:start", billNos });
    } catch (e) {
      res = null;
    }
    if (!res || !res.started) {
      updateBaseBtn(lastBaseJob);
      baseStatusEl.hidden = false;
      baseStatusEl.className = "status error";
      baseStatusEl.textContent = (res && res.reason) || "后台服务没有响应。请在浏览器的扩展管理页刷新本插件，再重试。";
    }
  });

  // 后台每更新一次进度，侧边栏（如果开着）就跟着刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.baseJob) renderBaseJob(changes.baseJob.newValue);
  });

  // ---- 付款进度摘要：数据来自看板上次同步的快照，点击打开（或切到）看板页 ----

  document.getElementById("openDashboardBtn").addEventListener("click", async () => {
    const url = chrome.runtime.getURL("dashboard.html");
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
  });

  const progressTiles = document.getElementById("progressTiles");
  const progressList = document.getElementById("progressList");
  const progressScope = document.getElementById("progressScope");
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const TILES = [
    ["overdue", "逾期"],
    ["warn", "关注"],
    ["ok", "正常"],
    ["pending", "待出账"],
  ];
  const TODO_LIMIT = 6;
  const progressBrands = document.getElementById("progressBrands");

  function renderProgressCounts(snapshot, operator, shop) {
    // 数字按跟踪表里选的操作人、店铺统计，标明口径
    progressScope.textContent = (operator || "全部人员") + " · " + (shop || "全部店铺");
    if (!snapshot) {
      progressTiles.innerHTML = '<p class="empty-note">还没有同步过数据，打开跟踪表同步一次后这里会显示概况。</p>';
      progressList.innerHTML = "";
      progressBrands.innerHTML = "";
      return;
    }
    const items = FMSProgress.filterItems(
      FMSProgress.buildItems(snapshot.bills, snapshot.chains, new Date()),
      { operator, shop }
    );
    const c = FMSProgress.summarize(items);
    progressTiles.innerHTML =
      TILES.map(([k, label]) => `<div class="stat-tile ${k}"><span class="stat-num">${c[k]}</span><span class="stat-label">${label}</span></div>`).join("");

    // 需要处理：逾期和关注的账单，最紧急的排前面
    const todo = items
      .filter((it) => it.risk === "overdue" || it.risk === "warn")
      .sort((a, b) => FMSProgress.RISK_RANK[b.risk] - FMSProgress.RISK_RANK[a.risk] || !!b.urgent - !!a.urgent || (b.stayDays || 0) - (a.stayDays || 0));
    progressList.innerHTML = todo.length
      ? todo
          .slice(0, TODO_LIMIT)
          .map(
            (it) => `<li class="todo-item ${it.risk}" role="button" tabindex="0" data-nos="${esc((it.settlementNos || []).join(","))}">
              <div class="todo-main"><span class="todo-name">${esc(it.brandName)} · ${esc(it.month)}</span><span class="todo-stage">${esc(it.stageLabel)}</span></div>
              <div class="todo-reason">${esc(it.reason)}</div>
            </li>`
          )
          .join("") + (todo.length > TODO_LIMIT ? `<li class="todo-more">还有 ${todo.length - TODO_LIMIT} 条，到跟踪表查看</li>` : "")
      : '<li class="todo-empty">暂无需要处理的账单</li>';

    // 按品牌：逾期/关注多的排前面
    const byBrand = new Map();
    for (const it of items) {
      if (it.risk === "done") continue;
      const e = byBrand.get(it.brandName) || { name: it.brandName, total: 0, overdue: 0, warn: 0 };
      e.total++;
      if (it.risk === "overdue") e.overdue++;
      if (it.risk === "warn") e.warn++;
      byBrand.set(it.brandName, e);
    }
    const brands = [...byBrand.values()].sort((a, b) => b.overdue - a.overdue || b.warn - a.warn || b.total - a.total || a.name.localeCompare(b.name));
    progressBrands.innerHTML = brands.length
      ? brands
          .slice(0, 8)
          .map((b) => `<li class="brand-item"><span class="brand-name">${esc(b.name)}</span><span class="brand-tags">${b.overdue ? `<em class="t-overdue">逾期 ${b.overdue}</em>` : ""}${b.warn ? `<em class="t-warn">关注 ${b.warn}</em>` : ""}<em class="t-total">共 ${b.total}</em></span></li>`)
          .join("") + (brands.length > 8 ? `<li class="todo-more">还有 ${brands.length - 8} 个品牌，到跟踪表查看</li>` : "")
      : '<li class="todo-empty">暂无进行中的账单</li>';

  }

  // 点「需要处理」里的账单：切到请款流程，把账单号填进第 2 步
  function openTodo(li) {
    const nos = (li.dataset.nos || "").trim();
    if (!nos) return;
    showTab("flow");
    const input = document.getElementById("billNoInput");
    input.value = nos.split(",").join("\n");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.scrollIntoView({ block: "center" });
  }
  progressList.addEventListener("click", (e) => {
    const li = e.target.closest(".todo-item");
    if (li) openTodo(li);
  });
  progressList.addEventListener("keydown", (e) => {
    const li = e.target.closest(".todo-item");
    if (li && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openTodo(li);
    }
  });

  // 跟踪表里换了操作人/店铺或重新同步后，这一条跟着刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(changes.fmsSnapshot || changes.dashOperator || changes.dashShop)) return;
    chrome.storage.local.get(["fmsSnapshot", "dashOperator", "dashShop"], (r) => renderProgressCounts(r.fmsSnapshot, r.dashOperator, r.dashShop));
  });

  // ---- 顶部标签页：请款流程 / 付款进度（两块互相独立）----
  function showTab(name) {
    document.querySelectorAll(".main-tab").forEach((t) => {
      t.classList.toggle("is-active", t.dataset.tab === name);
      t.setAttribute("aria-selected", String(t.dataset.tab === name));
    });
    document.getElementById("tabFlow").hidden = name !== "flow";
    document.getElementById("tabProgress").hidden = name !== "progress";
    chrome.storage.local.set({ panelTab: name });
  }
  document.querySelectorAll(".main-tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

  // ---- 打开时恢复上一次的状态（账单编号、流程进度、各步骤提示、生成/补数任务），避免一关就全部丢失 ----
  chrome.storage.local.get(["fmsSnapshot", "dashOperator", "dashShop", "panelTab"], (r) => {
    renderProgressCounts(r.fmsSnapshot, r.dashOperator, r.dashShop);
    if (r.panelTab === "progress") showTab("progress");
  });
  chrome.storage.local.get(["invoiceStatus", "cleanStatus", "regenStatus", "billNo", "flow", "baseJob", "genJob", "genForm", "regenJob", "fmsSnapshot", "vendorBills"], (r) => {
    if (r.invoiceStatus && r.invoiceStatus.text) setInvoiceStatus(r.invoiceStatus.text, r.invoiceStatus.kind);
    if (r.cleanStatus && r.cleanStatus.text) setCleanStatus(r.cleanStatus.text, r.cleanStatus.kind);
    if (r.regenStatus && r.regenStatus.text) setRegenStatus(r.regenStatus.text, r.regenStatus.kind);
    if (r.billNo) billNoInput.value = r.billNo;
    const key = flowKeyOf(currentBills());
    flow = r.flow && r.flow.key === key ? Object.assign(freshFlow(""), r.flow) : freshFlow(key);

    if (r.genForm) {
      if (r.genForm.brand) genBrand.value = r.genForm.brand;
      if (r.genForm.shop) genShop.value = r.genForm.shop;
      if (r.genForm.month) genMonth.value = r.genForm.month;
      genMonths = Array.isArray(r.genForm.months) && r.genForm.months.length ? r.genForm.months.slice() : r.genForm.month ? [r.genForm.month] : genMonths;
      renderGenMonths();
      savedVendorId = r.genForm.vendor || "";
    }
    snapshotBillsCache = (r.fmsSnapshot && r.fmsSnapshot.bills) || [];
    vendorBillsCache = r.vendorBills || null;
    vendors = buildVendors(allVendorSourceBills());
    renderVendorOptions();
    setGenMode((r.genForm && r.genForm.mode) || "brand", false);
    if (r.genJob) {
      // 打开时只显示上次的状态，不再次回填编号
      genAppliedKey = (r.genJob.startedAt || 0) + ":" + (r.genJob.bills || []).map((x) => x.billNo).join(",");
      renderGenJob(r.genJob);
    }
    renderBaseJob(r.baseJob);
    if (currentBills().length && !flowView().known) setTimeout(checkStatus, 0); // 打开时有编号但没读过状态 → 自动读
    if (r.regenJob) {
      regenAppliedKey = (r.regenJob.startedAt || 0) + ":" + JSON.stringify(r.regenJob.statuses || r.regenJob.status || "");
      regenRunning = !!r.regenJob.running;
    }
    renderFlow();
    setTimeout(() => (flowReady = true), 600);
  });
})();
