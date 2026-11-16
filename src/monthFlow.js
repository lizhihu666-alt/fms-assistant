// 月结流程的「演练」计划 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 演练 = 只读：读一遍账单列表，看某个「品牌 × 店铺 × 结算月份」现在处于哪一步，
// 说出「如果真做，我打算做什么」，但不点任何会改 FMS 数据的按钮。
// 纯函数、不依赖 chrome.*，可以在 Node 里直接测。

const MonthFlow = (() => {
  const STATUS = {
    PENDING_CONFIRM: "待确认",
    PENDING_GENERATE_REQUEST: "待生成请款单",
    PENDING_REQUEST: "待请款",
    REQUEST_APPROVING: "请款审批中",
    PENDING_PAYMENT: "待付款",
    PAID: "已付款",
    NO_SETTLEMENT_REQUIRED: "无需结算",
  };
  // 每种状态下，流程里「下一步」是什么
  const NEXT = {
    PENDING_CONFIRM: "缺基础数据：生成基础数据模板、复查后导入，再重新生成账单",
    PENDING_GENERATE_REQUEST: "基础数据完整：清洗对账表，然后等你上传发票并请款",
    PENDING_REQUEST: "已经请过款：等你核对草稿后自己提交",
    REQUEST_APPROVING: "审批中：不用做什么",
    PENDING_PAYMENT: "审批已通过：等财务付款",
    PAID: "已付款：不用做什么",
    NO_SETTLEMENT_REQUIRED: "无需结算：不用做什么",
  };

  // dryrun：只读账单列表；cleandry：再下载明细并清洗，但不保存任何文件
  const MODES = ["dryrun", "cleandry"];

  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");

  /** 上个月，格式 YYYY-MM（按调用方给的本地时间） */
  function previousMonth(now) {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  /**
   * 规则里的 prompt 写成 JSON：{"mode":"dryrun","brand":"Pretty Garden","shop":"JUSTFAB","month":"2026-10"}。
   * month 不写就取上个月。品牌和店铺必须在插件认识的清单里，否则拒绝，不猜。
   * 目前只支持 dryrun。
   */
  function parseConfig(text, brands, shops, now) {
    let c;
    try {
      c = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: "规则里的参数不是合法的 JSON" };
    }
    if (!c || typeof c !== "object") return { ok: false, error: "规则里没有参数" };
    if (!MODES.includes(c.mode)) return { ok: false, error: "目前只支持演练模式（mode 要写 " + MODES.join(" 或 ") + "），不会执行写入" };
    const brand = (brands || []).find((b) => norm(b) === norm(c.brand));
    if (!brand) return { ok: false, error: "品牌「" + c.brand + "」不在插件认识的清单里" };
    const shop = (shops || []).find((s) => norm(s) === norm(c.shop));
    if (!shop) return { ok: false, error: "店铺「" + c.shop + "」不在插件认识的清单里" };
    const month = c.month == null || c.month === "" ? previousMonth(now || new Date()) : String(c.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return { ok: false, error: "结算月份「" + month + "」格式不对，应为 YYYY-MM" };
    return { ok: true, brand, shop, month, mode: c.mode };
  }

  /** records：账单列表；findBills：BillGen.findBills（从外面传进来，方便测试） */
  function plan(records, cfg, findBills) {
    const label = cfg.brand + " / " + cfg.shop + " / " + cfg.month;
    const bills = findBills(records, cfg.brand, cfg.shop, cfg.month);
    const tail = "（演练，没有点任何按钮）";
    if (!bills.length) {
      return { state: "none", bills: [], summary: "演练：" + label + " 还没有账单 → 计划：在 FMS 生成这个月的账单" + tail };
    }
    const parts = bills.map((b) => {
      const st = STATUS[b.settlementStatus] || b.settlementStatus;
      return b.settlementNo + (b.siteCode ? "（" + b.siteCode + "）" : "") + "，" + st + " → " + (NEXT[b.settlementStatus] || "状态不认识，不处理");
    });
    return {
      state: "exists",
      bills: bills.map((b) => ({ billNo: b.settlementNo, status: b.settlementStatus })),
      summary: "演练：" + label + " 账单已存在 " + bills.length + " 张：" + parts.join("；") + tail,
    };
  }

  /** 清洗只处理「待生成请款单」（基础数据完整）的账单；只要有一张还「待确认」就不清洗，因为数据不全。 */
  function pickCleanable(records, cfg, findBills) {
    const bills = findBills(records, cfg.brand, cfg.shop, cfg.month);
    if (!bills.length) return { ok: false, reason: "还没有账单，没法清洗" };
    if (bills.some((b) => b.settlementStatus === "PENDING_CONFIRM")) return { ok: false, reason: "还有账单是「待确认」（缺基础数据），先补数据再清洗" };
    const ready = bills.filter((b) => b.settlementStatus === "PENDING_GENERATE_REQUEST");
    if (!ready.length) return { ok: false, reason: "没有「待生成请款单」的账单，不需要清洗" };
    return { ok: true, billNos: ready.map((b) => b.settlementNo) };
  }

  return { STATUS, NEXT, MODES, previousMonth, parseConfig, plan, pickCleanable };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MonthFlow;
