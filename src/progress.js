// FMS 付款进度核心逻辑 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 纯函数：输入「账单列表 + 审批链 + 当前时间」，输出每个「品牌×月份」处于哪个阶段、
// 卡在谁手上、停留多久、风险等级。不依赖DOM和chrome.*，所以可以在Node里直接测试。
//
// 业务规则：
//  - M月的款，最早在 M+1 月 10 号才能在系统里生成准确的明细（availableDate）；
//  - 合同要求 M+1 月月末前付完（dueDate）；
//  - 财务每周四付款，审批必须在周四之前走完，所以真正的死线是月末前的最后一个周四；
//  - 「还剩几个付款周四」= 今天之后（严格晚于今天，也晚于可请款日）到最后一个周四之间的周四数。

const FMSProgress = (() => {
  const DEFAULTS = {
    minMonth: "2026-06", // 只关注这个结算月及以后的账单，更早的是历史遗留
    stayWarnDays: 3, // 审批节点/我方环节停留超过这么多天标橙
    paymentStaleDays: 7, // 审批通过后超过这么多天还没付款标橙（财务每周付一次）
    payWeekday: 4, // 付款日：周四
    availableDay: 10, // 次月几号起可请款
    // 看板只覆盖这几位操作人负责的账单（FMS 里能看到所有人的，但这里只关心团队自己的）
    operators: ["Leo.Hu", "Estela.Liu", "Zita.Ye", "Remy.He", "Diven.Xu"],
    // 店铺筛选项（只是筛选下拉里列出的选项；「全部」不限店铺）
    shops: ["JUSTFAB", "Justfab EU"],
    // 手动指定「同一个 vendor」：这些店铺下的这几个品牌，在「按 Vendor」视图里并成一行
    // （FMS 的品牌商公司字段没填成同一个时，靠这里补）。品牌名/店铺名不区分大小写和空格。
    vendorGroups: [{ shop: "Justfab EU", brands: ["Imily Bela", "Runcati"], vendor: "vendor:Justfab EU:Imily Bela+Runcati" }],
  };

  // "Leo Hu" / "leo.hu" / "Leo.Hu" 都算同一个人
  const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /** 这张账单属于哪个 vendor：手动指定的分组优先，否则用 FMS 的「品牌商公司」 */
  function vendorOf(bill, opts) {
    for (const g of opts.vendorGroups || []) {
      if (normName(g.shop) === normName(bill.shopCode) && g.brands.some((b) => normName(b) === normName(bill.brandName))) return g.vendor;
    }
    return bill.brandCompany ? String(bill.brandCompany) : "";
  }

  function inScope(bill, opts) {
    if (!opts.operators || !opts.operators.length) return true;
    const allowed = opts.operators.map(normName);
    return allowed.includes(normName(bill.operator));
  }

  const DAY = 86400000;

  const STATUS_LABEL = {
    PENDING_CONFIRM: "待确认",
    PENDING_GENERATE_REQUEST: "待生成请款单",
    PENDING_REQUEST: "待请款",
    REQUEST_APPROVING: "请款审批中",
    PENDING_PAYMENT: "待付款",
    PAID: "已付款",
    NO_SETTLEMENT_REQUIRED: "无需结算",
  };

  const STAGE_ORDER = {
    PENDING_CONFIRM: 0,
    PENDING_GENERATE_REQUEST: 1,
    PENDING_REQUEST: 2,
    REQUEST_APPROVING: 3,
    PENDING_PAYMENT: 4,
    PAID: 5,
    NO_SETTLEMENT_REQUIRED: 6,
  };

  const RISK_RANK = { overdue: 4, warn: 3, ok: 2, pending: 1, done: 0 };
  const RISK_LABEL = { overdue: "已逾期", warn: "关注", ok: "正常", pending: "待出账", done: "已付款" };

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function parseTime(s) {
    if (!s) return null;
    const d = new Date(String(s).replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtDate(d) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtMoney(byCurrency) {
    return Object.entries(byCurrency)
      .map(([cur, amt]) => `${amt.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`)
      .join(" + ");
  }

  /** 结算月 "2026-08" 对应的可请款日、付款死线、最后一个付款周四、剩余可赶的付款周四数 */
  function monthTiming(accountingMonth, now, opts) {
    const [y, m] = accountingMonth.split("-").map(Number);
    const availableDate = new Date(y, m, opts.availableDay); // JS月份从0开始，所以 m 正好是次月
    const dueDate = new Date(y, m + 1, 0); // 次月最后一天
    const lastPayThursday = new Date(dueDate);
    while (lastPayThursday.getDay() !== opts.payWeekday) lastPayThursday.setDate(lastPayThursday.getDate() - 1);

    const today = startOfDay(now);
    const from = today > availableDate ? today : availableDate;
    let remainingRuns = 0;
    for (const t = new Date(lastPayThursday); t > from; t.setDate(t.getDate() - 7)) remainingRuns++;

    return {
      availableDate,
      dueDate,
      lastPayThursday,
      remainingRuns,
      beforeAvailable: today < availableDate,
      overdueDays: today > dueDate ? Math.round((today - dueDate) / DAY) : 0,
    };
  }

  /**
   * 从审批链里找当前待审批节点、审批人、本节点开始等待的时间。
   * 审批链里可能有「撤回/退回后重新提交」的历史（同一个节点出现多次，状态不是0/1，比如5=撤回），
   * 所以不能取「第一个没通过的节点」，要取「最后一次通过/提交之后」的第一个待处理节点。
   * 同时记录首次提交时间：重新提交会让停留天数清零，但真实等待是从首次提交开始的。
   */
  function analyzeChain(chain) {
    if (!chain || chain.error || !Array.isArray(chain.records)) return null;
    const recs = chain.records;
    let lastDone = -1;
    recs.forEach((r, i) => {
      if (r.status === "1") lastDone = i;
    });
    const pending = recs.slice(lastDone + 1).find((r) => r.status === "0" && r.node !== "结束");
    const firstDone = recs.find((r) => r.status === "1" && parseTime(r.time));
    return {
      node: pending ? pending.node : "",
      approvers: pending ? pending.who : [],
      since: lastDone >= 0 ? parseTime(recs[lastDone].time) : null,
      firstSubmitted: firstDone ? parseTime(firstDone.time) : null,
    };
  }

  function describeStage(status, hasDoc, chain, bill, now) {
    const generated = parseTime(bill.generatedTime);
    const requested = parseTime(bill.requestPaymentTime);
    const modified = parseTime(bill.modifyTime);
    switch (status) {
      case "PENDING_CONFIRM":
        return { stageLabel: "待确认·缺基础数据", ownerKind: "me", ownerNames: [], node: "", since: generated };
      case "PENDING_GENERATE_REQUEST":
        return { stageLabel: "待生成请款单", ownerKind: "me", ownerNames: [], node: "", since: generated };
      case "PENDING_REQUEST":
        return {
          stageLabel: hasDoc ? "草稿待提交" : "待请款",
          ownerKind: "me",
          ownerNames: [],
          node: "",
          since: requested || modified,
        };
      case "REQUEST_APPROVING": {
        const a = analyzeChain(chain);
        if (a && a.node) {
          return {
            stageLabel: `审批中·${a.node}`,
            ownerKind: "approver",
            ownerNames: a.approvers,
            node: a.node,
            since: a.since || requested,
            firstSubmitted: a.firstSubmitted,
          };
        }
        return { stageLabel: "请款审批中", ownerKind: "approver", ownerNames: [], node: "", since: requested };
      }
      case "PENDING_PAYMENT":
        return { stageLabel: "待付款", ownerKind: "finance", ownerNames: ["财务"], node: "", since: modified };
      case "PAID":
        return { stageLabel: "已付款", ownerKind: "none", ownerNames: [], node: "", since: modified };
      default:
        return { stageLabel: STATUS_LABEL[status] || status, ownerKind: "none", ownerNames: [], node: "", since: modified };
    }
  }

  function assessRisk(item, timing, opts) {
    const lastThu = fmtDate(timing.lastPayThursday);
    if (item.status === "PAID") return { risk: "done", reason: "" };
    // 待确认 = 基础数据缺失，运营必须手动补传后重新生成账单。这不是等时间能解决的，
    // 所以即使还没到可请款日也要提醒（标橙），不能当成灰色的"待出账"。
    if (item.status === "PENDING_CONFIRM" && timing.beforeAvailable) {
      return {
        risk: "warn",
        reason: `基础数据缺失，需补传后重新生成账单（${fmtDate(timing.availableDate)} 起正式出账，趁早补齐）`,
      };
    }
    if (timing.beforeAvailable) {
      return { risk: "pending", reason: `${fmtDate(timing.availableDate)} 起才能请款（账单明细此前不准确）` };
    }
    if (timing.overdueDays > 0) {
      return { risk: "overdue", reason: `已超付款死线 ${fmtDate(timing.dueDate)}，逾期 ${timing.overdueDays} 天` };
    }

    const runs = timing.remainingRuns;
    const beforeApproved = STAGE_ORDER[item.status] < STAGE_ORDER.PENDING_PAYMENT;
    if (beforeApproved && runs <= 1) {
      // 归入「关注」，但打上 urgent 标记：排序靠前、计入图标角标
      return {
        risk: "warn",
        urgent: true,
        reason:
          runs === 0
            ? `本月已无付款周四可赶（最后一个是 ${lastThu}），需要特批加急`
            : `只剩最后 1 个付款周四（${lastThu}），必须在此之前审批完成`,
      };
    }

    const stay = item.stayDays;
    if (item.status === "PENDING_PAYMENT") {
      if (stay != null && stay >= opts.paymentStaleDays) {
        return { risk: "warn", reason: `审批通过已 ${stay} 天仍未付款，确认财务是否漏付` };
      }
    } else if (stay != null && stay >= opts.stayWarnDays) {
      return { risk: "warn", reason: `${item.stageLabel}已停留 ${stay} 天（超过 ${opts.stayWarnDays} 天）` };
    } else if (beforeApproved && item.ownerKind === "me" && runs <= 2) {
      return { risk: "warn", reason: `只剩 ${runs} 个付款周四（最后 ${lastThu}），尽快推进` };
    }
    return { risk: "ok", reason: `还剩 ${runs} 个付款周四（最后 ${lastThu}）` };
  }

  /**
   * 把账单列表转成「条目」：同一品牌、同一结算月、同一张费控单（或同一个未请款账单）算一个条目。
   * chains 是 { [AJF号]: 审批链 }。
   */
  function buildItems(bills, chains, now, userOpts) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    const groups = new Map();
    for (const b of bills) {
      if (!b.accountingMonth || b.accountingMonth < opts.minMonth) continue;
      if (b.settlementStatus === "NO_SETTLEMENT_REQUIRED") continue;
      if (!inScope(b, opts)) continue;
      const key = [b.brandName, b.accountingMonth, b.documentCode || b.settlementNo].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    const items = [];
    for (const [key, list] of groups) {
      const first = list.reduce((a, b) =>
        (STAGE_ORDER[b.settlementStatus] ?? 99) < (STAGE_ORDER[a.settlementStatus] ?? 99) ? b : a
      );
      const status = first.settlementStatus;
      const docCode = first.documentCode || "";
      const stage = describeStage(status, !!docCode, chains && chains[docCode], first, now);
      const amounts = {};
      for (const b of list) {
        amounts[b.currency] = Math.round(((amounts[b.currency] || 0) + Number(b.settlementAmount || 0)) * 100) / 100;
      }
      const timing = monthTiming(first.accountingMonth, now, opts);
      const item = {
        key,
        brandName: first.brandName,
        company: vendorOf(first, opts), // vendor：默认取 FMS 的品牌商公司（同一个vendor的多个品牌会合并成一张费控单），也可手动指定
        month: first.accountingMonth,
        status,
        docCode,
        settlementNos: list.map((b) => b.settlementNo),
        operators: [...new Set(list.map((b) => b.operator).filter(Boolean))],
        shops: [...new Set(list.map((b) => b.shopCode).filter(Boolean))],
        amounts,
        timing,
        ...stage,
        stayDays: stage.since ? Math.max(0, Math.floor((now - stage.since) / DAY)) : null,
        totalDays: stage.firstSubmitted ? Math.max(0, Math.floor((now - stage.firstSubmitted) / DAY)) : null,
        resubmitted: !!(stage.firstSubmitted && stage.since && stage.since - stage.firstSubmitted > DAY),
      };
      Object.assign(item, assessRisk(item, timing, opts));
      items.push(item);
    }
    return items;
  }

  /** 需要去读审批链的单据号：范围内、处于「请款审批中」的费控单 */
  function docsToFetch(bills, userOpts) {
    const opts = Object.assign({}, DEFAULTS, userOpts);
    return [
      ...new Set(
        bills
          .filter(
            (b) =>
              b.settlementStatus === "REQUEST_APPROVING" &&
              b.documentCode &&
              b.accountingMonth >= opts.minMonth &&
              inScope(b, opts)
          )
          .map((b) => b.documentCode)
      ),
    ];
  }

  function filterItems(items, filter) {
    return items.filter((it) => {
      if (filter && filter.operator && !it.operators.some((o) => normName(o) === normName(filter.operator))) return false;
      if (filter && filter.shop && !it.shops.some((s) => normName(s) === normName(filter.shop))) return false;
      if (filter && filter.risk && it.risk !== filter.risk) return false;
      return true;
    });
  }

  function summarize(items) {
    const counts = { overdue: 0, warn: 0, ok: 0, pending: 0, done: 0 };
    for (const it of items) counts[it.risk]++;
    return counts;
  }

  function sortByRisk(a, b) {
    return (RISK_RANK[b.risk] - RISK_RANK[a.risk]) || (!!b.urgent - !!a.urgent) || ((b.stayDays || 0) - (a.stayDays || 0));
  }

  /** 同一格里属于同一张费控单的条目合并成一个（vendor 视图下，多个品牌共用一张单） */
  function mergeByDoc(sortedItems) {
    const out = [];
    const seen = new Map();
    for (const it of sortedItems) {
      if (!it.docCode) {
        out.push(it);
        continue;
      }
      const k = it.month + "|" + it.docCode;
      if (!seen.has(k)) {
        const merged = Object.assign({}, it, { brandNames: [it.brandName], amounts: Object.assign({}, it.amounts) });
        seen.set(k, merged);
        out.push(merged);
        continue;
      }
      const m = seen.get(k);
      if (!m.brandNames.includes(it.brandName)) m.brandNames.push(it.brandName);
      m.settlementNos = m.settlementNos.concat(it.settlementNos);
      m.operators = [...new Set(m.operators.concat(it.operators))];
      m.shops = [...new Set(m.shops.concat(it.shops))];
      for (const [cur, amt] of Object.entries(it.amounts)) m.amounts[cur] = Math.round(((m.amounts[cur] || 0) + amt) * 100) / 100;
      m.brandName = m.brandNames.join(" / ");
    }
    return out;
  }

  /**
   * 矩阵：行=品牌 或 vendor（mode = "brand" | "vendor"），风险最高的排前面，列=结算月，格子=条目。
   * vendor 以 FMS 的「品牌商公司」字段为准，同一 vendor 下的品牌放在同一行。
   */
  function buildMatrix(items, mode) {
    const byVendor = mode === "vendor";
    const months = [...new Set(items.map((i) => i.month))].sort();
    const byRow = new Map();
    for (const it of items) {
      const key = byVendor ? it.company || "brand:" + it.brandName : it.brandName;
      if (!byRow.has(key)) byRow.set(key, []);
      byRow.get(key).push(it);
    }
    const rows = [...byRow].map(([key, list]) => {
      const sorted = list.slice().sort(sortByRisk);
      const cells = {};
      for (const it of byVendor ? mergeByDoc(sorted) : sorted) (cells[it.month] = cells[it.month] || []).push(it);
      const label = byVendor
        ? [...new Set(list.map((i) => i.brandName))].sort((x, y) => x.localeCompare(y)).join(" / ")
        : key;
      const worst = list.reduce((w, it) => Math.max(w, RISK_RANK[it.risk]), 0);
      return { key, label, cells, worst };
    });
    rows.sort((x, y) => y.worst - x.worst || x.label.localeCompare(y.label));
    return { months, rows };
  }

  /** 催办视图：按「卡点的人」分组；同一张费控单合并成一行 */
  function buildNudges(items) {
    const groups = new Map();
    const add = (name, kind, it) => {
      const key = kind + "|" + name;
      if (!groups.has(key)) groups.set(key, { name, kind, items: [] });
      groups.get(key).items.push(it);
    };
    for (const it of items) {
      if (it.risk === "done" || it.ownerKind === "none") continue;
      if (it.ownerKind === "approver") {
        const names = it.ownerNames.length ? it.ownerNames : ["审批人未知"];
        for (const n of new Set(names)) add(n, "approver", it);
      } else if (it.ownerKind === "finance") {
        add("财务付款（每周四）", "finance", it);
      } else {
        add("我方待办", "me", it);
      }
    }

    const result = [];
    for (const g of groups.values()) {
      const docs = new Map();
      for (const it of g.items) {
        const k = it.docCode || it.key;
        if (!docs.has(k)) {
          docs.set(k, { docCode: it.docCode, brands: [], months: [], amounts: {}, stageLabel: it.stageLabel, stayDays: it.stayDays, totalDays: it.totalDays, resubmitted: it.resubmitted, risk: it.risk, reason: it.reason, timing: it.timing, ownerKind: it.ownerKind });
        }
        const d = docs.get(k);
        if (!d.brands.includes(it.brandName)) d.brands.push(it.brandName);
        if (!d.months.includes(it.month)) d.months.push(it.month);
        for (const [cur, amt] of Object.entries(it.amounts)) d.amounts[cur] = Math.round(((d.amounts[cur] || 0) + amt) * 100) / 100;
        if (RISK_RANK[it.risk] > RISK_RANK[d.risk]) {
          d.risk = it.risk;
          d.reason = it.reason;
        }
      }
      const docList = [...docs.values()].sort(sortByRisk);
      result.push({
        name: g.name,
        kind: g.kind,
        docs: docList,
        worstRisk: docList[0].risk,
        maxStay: docList.reduce((m, d) => Math.max(m, d.stayDays || 0), 0),
      });
    }
    result.sort((a, b) => {
      if ((a.kind === "me") !== (b.kind === "me")) return a.kind === "me" ? 1 : -1; // 我方待办放最后
      return (RISK_RANK[b.worstRisk] - RISK_RANK[a.worstRisk]) || (b.maxStay - a.maxStay);
    });
    return result;
  }

  /** 费控单详情页链接（审批人点开就能直接处理） */
  function docUrl(code) {
    return `https://fms-jf.wangoon.cn/expense-control/center/edit-account?step=other&code=${encodeURIComponent(code)}&op=1&origin=center`;
  }

  /** 催办话术（只生成文字，由用户自己复制发送） */
  function nudgeText(group) {
    if (group.kind === "me") return "";
    const urls = group.docs.filter((d) => d.docCode).map((d) => docUrl(d.docCode));
    if (!urls.length) return "";
    const intro = urls.length === 1 ? "Hello 麻烦加急处理一下这笔付款：" : "Hello 麻烦加急处理一下这几笔付款：";
    return [intro, ...urls, "感谢！"].join("\n");
  }

  /** 图标角标：逾期 + 紧急（只剩最后一个付款周四仍未审批完）的数量 */
  function badgeCount(items) {
    return items.filter((i) => i.risk === "overdue" || i.urgent).length;
  }

  return {
    DEFAULTS,
    STATUS_LABEL,
    RISK_RANK,
    RISK_LABEL,
    monthTiming,
    buildItems,
    docsToFetch,
    filterItems,
    summarize,
    buildMatrix,
    buildNudges,
    nudgeText,
    badgeCount,
    fmtDate,
    fmtMoney,
  };
})();

if (typeof module !== "undefined") module.exports = FMSProgress;
