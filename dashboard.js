// 付款进度跟踪表 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
(() => {
  const P = FMSProgress;
  const $ = (id) => document.getElementById(id);
  const STALE_MS = 4 * 3600 * 1000; // 打开看板时数据超过4小时就自动同步一次
  const RISKS = ["overdue", "warn", "ok", "pending"];

  const state = {
    snapshot: null, // { syncedAt, bills, chains }
    operator: "",
    shop: "",
    risk: "", // 点击概览卡片筛选
    view: "matrix",
    group: "brand", // 矩阵分组：brand | vendor
    matrix: null, // 当前渲染的矩阵，明细面板从这里取格子
    selectedKey: "",
    syncing: false,
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (el.hidden = true), 2200);
  }

  function setNotice(text, kind) {
    const el = $("notice");
    el.hidden = !text;
    el.textContent = text || "";
    el.className = "notice" + (kind ? " " + kind : "");
  }

  // ---------- 展示用的小工具 ----------

  function ownerLabel(it) {
    if (it.ownerKind === "approver") return it.ownerNames.length ? it.ownerNames.join(" / ") : "审批人未知";
    if (it.ownerKind === "finance") return "财务";
    if (it.ownerKind === "me") return "我方";
    return "";
  }

  function chipTitle(it) {
    return it.risk === "done" ? "✓ 已付款" : it.stageLabel;
  }

  function chipMeta(it) {
    if (it.risk === "done") return "";
    if (it.risk === "pending") return `${P.fmtDate(it.timing.availableDate)} 起可请款`;
    const parts = [];
    const o = ownerLabel(it);
    if (o) parts.push(o);
    if (it.stayDays != null) parts.push(`${it.stayDays} 天`);
    return parts.join(" · ");
  }

  // ---------- 渲染 ----------

  function allItems() {
    return P.buildItems(state.snapshot.bills, state.snapshot.chains, new Date());
  }

  function render() {
    const hasData = !!state.snapshot;
    $("emptyState").hidden = hasData || state.syncing;
    $("content").hidden = !hasData;
    if (!hasData) return;

    const items = allItems();
    renderFilters(items);

    const scoped = P.filterItems(items, { operator: state.operator, shop: state.shop });
    renderSummary(scoped);

    const visible = P.filterItems(scoped, { risk: state.risk });
    $("viewHint").textContent =
      state.view === "matrix" ? "格子颜色代表风险；点击格子查看明细" : "按卡点的人分组；复制话术后自己发给对方，插件不会代发";
    $("groupSeg").hidden = state.view !== "matrix";
    document.querySelectorAll("#groupSeg .seg").forEach((s) => s.classList.toggle("active", s.dataset.group === state.group));
    $("matrixView").hidden = state.view !== "matrix";
    $("nudgeView").hidden = state.view !== "nudge";
    if (state.view === "matrix") renderMatrix(visible);
    else renderNudges(visible);
    renderDetail();
    updateBadge(scoped);
  }

  // 操作人、店铺两个下拉。括号里是「已逾期 + 关注」的单子数；
  // 每个下拉的数字都按另一个下拉当前的选择来算，所以组合筛选时数字也对得上。
  function renderFilters(items) {
    const ops = P.DEFAULTS.operators;
    const shops = P.DEFAULTS.shops;
    if (state.operator && !ops.includes(state.operator)) state.operator = "";
    if (state.shop && !shops.includes(state.shop)) state.shop = "";
    const todo = (list) => list.filter((i) => i.risk === "overdue" || i.risk === "warn").length;
    const fill = (selectId, names, current, baseFilter, key) => {
      const options = [["", "全部"], ...names.map((n) => [n, n])];
      $(selectId).innerHTML = options
        .map(([value, label]) => {
          const n = todo(P.filterItems(items, Object.assign({}, baseFilter, value ? { [key]: value } : {})));
          return `<option value="${esc(value)}"${current === value ? " selected" : ""}>${esc(label)}${n ? `（${n}）` : ""}</option>`;
        })
        .join("");
    };
    fill("operatorSelect", ops, state.operator, { shop: state.shop }, "operator");
    fill("shopSelect", shops, state.shop, { operator: state.operator }, "shop");
  }

  function renderSummary(items) {
    const counts = P.summarize(items);
    $("summary").innerHTML = RISKS.map(
      (r) => `<button type="button" class="tile${state.risk === r ? " active" : ""}" data-risk="${r}">
        <span class="tile-num">${counts[r]}</span>
        <span class="tile-label"><span class="dot ${r}"></span>${P.RISK_LABEL[r]}</span>
      </button>`
    ).join("");
  }

  function chipHtml(cellItems, key) {
    const it = cellItems[0];
    const more = cellItems.length > 1 ? `<span class="chip-more">+${cellItems.length - 1}</span>` : "";
    const meta = chipMeta(it);
    return `<button type="button" class="chip risk-${it.risk}${state.selectedKey === key ? " selected" : ""}" data-cell="${esc(key)}" title="${esc(it.stageLabel + (it.reason ? "\n" + it.reason : ""))}">
      <span class="chip-title"><span>${esc(chipTitle(it))}</span>${more}</span>
      ${meta ? `<span class="chip-meta">${esc(meta)}</span>` : ""}
    </button>`;
  }

  function renderMatrix(items) {
    const el = $("matrixView");
    if (!items.length) {
      el.innerHTML = `<div class="matrix-empty">没有符合条件的账单</div>`;
      return;
    }
    const now = new Date();
    const matrix = P.buildMatrix(items, state.group);
    state.matrix = matrix;
    const { months, rows } = matrix;
    const head = months
      .map((m) => {
        const t = P.monthTiming(m, now, P.DEFAULTS);
        return `<th class="month-col">${m}<small>死线 ${P.fmtDate(t.dueDate)} · 周四 ${P.fmtDate(t.lastPayThursday)}</small></th>`;
      })
      .join("");
    const body = rows
      .map((r) => {
        const cells = months
          .map((m) => {
            const list = r.cells[m];
            return `<td>${list ? chipHtml(list, r.key + "|" + m) : `<span class="cell-empty">—</span>`}</td>`;
          })
          .join("");
        return `<tr><th class="brand-col" scope="row">${esc(r.label)}</th>${cells}</tr>`;
      })
      .join("");
    el.innerHTML = `<table class="matrix"><thead><tr><th class="brand-col">${state.group === "vendor" ? "Vendor" : "品牌"}</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderNudges(items) {
    const el = $("nudgeView");
    const groups = P.buildNudges(items);
    if (!groups.length) {
      el.innerHTML = `<div class="card matrix-empty">没有需要催办的单据</div>`;
      return;
    }
    el.innerHTML = groups
      .map((g, gi) => {
        const rows = g.docs
          .map(
            (d) => `<div class="nudge-row">
          <div class="nudge-doc">${esc(d.docCode || "（未生成费控单）")}</div>
          <div class="nudge-brands" title="${esc(d.brands.join(" / "))}">${esc(d.brands.join(" / "))}<small>${esc(d.months.join("、"))} · ${esc(d.stageLabel)}</small></div>
          <div class="nudge-amount">${esc(P.fmtMoney(d.amounts))}</div>
          <div class="nudge-state"><span class="badge ${d.risk}">${P.RISK_LABEL[d.risk]}${d.stayDays != null ? ` · ${d.stayDays} 天` : ""}</span><span>${esc(d.reason)}</span></div>
        </div>`
          )
          .join("");
        const sub =
          g.kind === "me"
            ? "需要运营自己处理的环节"
            : g.kind === "finance"
              ? "审批已通过，等待财务周四付款"
              : "卡在这位审批人手上";
        const copy = g.kind === "me" ? "" : `<button type="button" class="btn btn-ghost" data-copy="${gi}">复制催办话术</button>`;
        return `<article class="nudge-card">
          <div class="nudge-head"><span class="nudge-name">${esc(g.name)}</span><span class="nudge-sub">${sub} · ${g.docs.length} 张 · 最久 ${g.maxStay} 天</span>${copy}</div>
          ${rows}
        </article>`;
      })
      .join("");
    el._groups = groups;
  }

  function renderDetail() {
    const el = $("detail");
    if (!state.selectedKey || state.view !== "matrix" || !state.matrix) {
      el.hidden = true;
      return;
    }
    const sep = state.selectedKey.lastIndexOf("|");
    const rowKey = state.selectedKey.slice(0, sep);
    const month = state.selectedKey.slice(sep + 1);
    const row = state.matrix.rows.find((r) => r.key === rowKey);
    const list = (row && row.cells[month]) || [];
    if (!list.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.innerHTML =
      `<h3>${esc(row.label)} · ${esc(month)}</h3>` +
      list
        .map(
          (it) => `<div class="detail-item">
        <span class="badge ${it.risk}">${P.RISK_LABEL[it.risk]}</span>
        <dl class="detail-grid">
          <dt>品牌</dt><dd>${esc(it.brandName)}</dd>
          <dt>当前阶段</dt><dd>${esc(it.stageLabel)}${ownerLabel(it) ? ` · ${esc(ownerLabel(it))}` : ""}${it.stayDays != null && it.risk !== "done" ? ` · 已停留 ${it.stayDays} 天` : ""}</dd>
          ${it.resubmitted ? `<dt>提交记录</dt><dd>首次提交已 ${it.totalDays} 天，中途撤回/退回后重新提交过（停留天数按最近一次提交重新计算）</dd>` : ""}
          ${it.reason ? `<dt>判断依据</dt><dd>${esc(it.reason)}</dd>` : ""}
          <dt>费控单</dt><dd>${esc(it.docCode || "尚未生成")}</dd>
          <dt>账单编号</dt><dd>${esc(it.settlementNos.join("、"))}</dd>
          <dt>结算金额</dt><dd>${esc(P.fmtMoney(it.amounts))}</dd>
          <dt>操作人</dt><dd>${esc(it.operators.join("、") || "—")}</dd>
        </dl>
      </div>`
        )
        .join("");
  }

  function updateBadge(scopedItems) {
    if (typeof chrome === "undefined" || !chrome.action) return;
    const n = P.badgeCount(scopedItems);
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  }

  // ---------- 同步 ----------

  function waitTabComplete(tabId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error("FMS 页面加载超时"));
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

  async function runInTab(tabId, func, args, label) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "MAIN" });
    const r = res && res.result;
    if (!r) throw new Error(`${label}：没有拿到FMS页面的执行结果`);
    if (!r.ok) throw new Error(`${label}失败：${r.error}`);
    return r;
  }

  function setSyncing(on, text) {
    state.syncing = on;
    const btn = $("syncBtn");
    btn.disabled = on;
    btn.innerHTML = on ? `<span class="spinner"></span>同步中…` : "同步最新进度";
    if (on) setNotice(text);
  }

  async function sync() {
    if (state.syncing) return;
    setSyncing(true, "正在后台打开 FMS…");
    let tab = null;
    let keepTab = false;
    try {
      tab = await chrome.tabs.create({ url: FMSSync.FMS_BILL_URL, active: false });
      await waitTabComplete(tab.id);

      const loggedIn = async () => (await chrome.tabs.get(tab.id)).url.startsWith(FMSSync.FMS_ORIGIN);
      const needLogin = async () => {
        keepTab = true;
        await chrome.tabs.update(tab.id, { active: true });
        throw new Error("FMS 登录已过期，已为你打开登录页。登录完成后回到这里再点一次「同步最新进度」。");
      };
      if (!(await loggedIn())) await needLogin();

      setNotice("正在读取账单列表…");
      let list;
      try {
        list = await runInTab(tab.id, FMSSync.fetchBillList, [], "读取账单列表");
      } catch (e) {
        if (!(await loggedIn())) await needLogin();
        throw e;
      }

      const codes = P.docsToFetch(list.records);
      let chains = {};
      if (codes.length) {
        setNotice(`正在读取 ${codes.length} 张审批中单据的审批链…`);
        chains = (await runInTab(tab.id, FMSSync.fetchApprovalChains, [codes], "读取审批链")).chains;
      }

      state.snapshot = { syncedAt: new Date().toISOString(), bills: list.records, chains };
      await chrome.storage.local.set({ fmsSnapshot: state.snapshot });
      setNotice("");
      const failed = Object.values(chains).filter((c) => c.error).length;
      toast(failed ? `已同步（${failed} 张单据的审批链读取失败，对应审批人显示为未知）` : "已同步最新进度");
    } catch (err) {
      console.error(err);
      setNotice("同步失败：" + err.message, "error");
    } finally {
      if (tab && !keepTab) chrome.tabs.remove(tab.id).catch(() => {});
      setSyncing(false);
      render();
    }
  }

  // ---------- 事件 ----------

  $("syncBtn").addEventListener("click", sync);

  $("operatorSelect").addEventListener("change", (e) => {
    state.operator = e.target.value;
    chrome.storage.local.set({ dashOperator: state.operator });
    render();
  });

  $("shopSelect").addEventListener("change", (e) => {
    state.shop = e.target.value;
    chrome.storage.local.set({ dashShop: state.shop });
    render();
  });

  $("summary").addEventListener("click", (e) => {
    const tile = e.target.closest(".tile");
    if (!tile) return;
    state.risk = state.risk === tile.dataset.risk ? "" : tile.dataset.risk;
    render();
  });

  $("viewSeg").addEventListener("click", (e) => {
    const seg = e.target.closest(".seg");
    if (!seg) return;
    state.view = seg.dataset.view;
    document.querySelectorAll("#viewSeg .seg").forEach((s) => s.classList.toggle("active", s === seg));
    render();
  });

  $("groupSeg").addEventListener("click", (e) => {
    const seg = e.target.closest(".seg");
    if (!seg) return;
    state.group = seg.dataset.group;
    state.selectedKey = "";
    chrome.storage.local.set({ dashGroup: state.group });
    render();
  });

  $("matrixView").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    state.selectedKey = state.selectedKey === chip.dataset.cell ? "" : chip.dataset.cell;
    render();
    if (state.selectedKey) $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  $("nudgeView").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const group = $("nudgeView")._groups[Number(btn.dataset.copy)];
    try {
      await navigator.clipboard.writeText(P.nudgeText(group));
      toast(`已复制给「${group.name}」的催办话术`);
    } catch (err) {
      toast("复制失败，请手动选择文字复制");
    }
  });

  // ---------- 启动 ----------

  chrome.storage.local.get(["fmsSnapshot", "dashOperator", "dashShop", "dashGroup"], (res) => {
    state.snapshot = res.fmsSnapshot || null;
    state.operator = res.dashOperator || "";
    state.shop = res.dashShop || "";
    state.group = res.dashGroup === "vendor" ? "vendor" : "brand";
    render();
    const stale = !state.snapshot || Date.now() - new Date(state.snapshot.syncedAt).getTime() > STALE_MS;
    if (stale) sync();
  });
})();
