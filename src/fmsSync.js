// FMS 付款进度同步模块 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 全部只读：不点任何会修改数据的按钮，也不读取/使用任何登录凭据。
// 做法是让FMS页面自己发请求（切换每页条数、路由跳转到单据详情页），
// 插件只截取页面自己发出的请求的返回内容。
//
// 每个注入函数都会被 chrome.scripting.executeScript 整体注入到 FMS 页面（MAIN world）里执行，
// 所以必须自包含（不能引用这里的外部变量），并且自己 try/catch、总是返回普通对象。

const FMSSync = (() => {
  const FMS_ORIGIN = "https://fms-jf.wangoon.cn";
  const FMS_BILL_URL = FMS_ORIGIN + "/brand-payment/brand-bill";

  /**
   * 在品牌商账单页，把每页条数切到1000并截取列表接口返回，拿到全部账单。
   * 返回 { ok, records, log } 或 { ok:false, error, log }。
   */
  async function fetchBillList() {
    const log = [];
    const step = (msg) => {
      log.push(msg);
      console.log("[FMS同步]", msg);
    };

    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }

      const capKey = "__fmsSyncCap";
      window[capKey] = [];
      if (!window.__fmsSyncHooked) {
        window.__fmsSyncHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__syncInfo = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const info = this.__syncInfo;
          if (info) {
            info.body = typeof body === "string" ? body : "";
            this.addEventListener("load", () => {
              (window[capKey] || []).push({
                url: info.url,
                body: info.body,
                status: this.status,
                text: this.responseText,
              });
            });
          }
          return origSend.apply(this, arguments);
        };
      }

      function parseBody(c) {
        try {
          return JSON.parse(c.body);
        } catch (e) {
          return {};
        }
      }

      const isVisible = (e) => e.offsetParent !== null;
      const findBtn = (text) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text && isVisible(b));

      // 0. 先点「重置」：页面会记住上次的筛选（比如刚生成过某个品牌的账单后，品牌/站点条件会留着），
      //    不清掉的话读到的只是被筛过的一部分，筛出 0 条时还会连分页组件都不显示
      await waitFor(() => findBtn("查询"), "查询按钮");
      const resetBtn = findBtn("重置");
      if (resetBtn) {
        resetBtn.click();
        step("已重置筛选条件");
        await sleep(1200);
      }

      // 1. 每页条数切到 1000。分页组件只在有数据时才显示；没有就跳过（结果为空或很少）
      step("等待分页组件");
      let pagination = null;
      try {
        pagination = await waitFor(
          () => [...document.querySelectorAll(".el-pagination")].find((p) => isVisible(p) && p.querySelector(".el-pagination__sizes .el-select__wrapper")),
          "账单列表分页组件",
          10000
        );
      } catch (e) {
        step("没有分页组件，按当前页读取");
      }
      if (pagination) {
        const sizeWrapper = pagination.querySelector(".el-pagination__sizes .el-select__wrapper");
        if (!/1000/.test(sizeWrapper.textContent)) {
          sizeWrapper.click();
          const option = await waitFor(
            () => [...document.querySelectorAll(".el-select-dropdown__item")].find((li) => isVisible(li) && li.textContent.trim() === "1000条/页"),
            "每页1000条选项"
          );
          option.click();
          step("已切换为每页1000条");
          await sleep(300);
        }
      }

      // 2. 点查询，截取页面自己发出的列表请求。点击可能被页面正在进行的加载吞掉，所以隔几秒没动静就再点一次
      window[capKey].length = 0;
      const wantHit = () =>
        window[capKey]
          .filter((c) => /settlement\/summary\/page/.test(c.url) && (!pagination || parseBody(c).size === 1000))
          .pop();
      let hit = null;
      for (let attempt = 0; attempt < 4 && !hit; attempt++) {
        const queryBtn = findBtn("查询");
        if (!queryBtn) throw new Error("按钮未找到: 查询");
        queryBtn.click();
        try {
          hit = await waitFor(wantHit, "账单列表接口返回", attempt === 3 ? 20000 : 7000);
        } catch (e) {
          if (attempt === 3) throw e;
          step("查询没有响应，重新点击");
        }
      }
      const json = JSON.parse(hit.text);
      if (!json.success || !json.data || !Array.isArray(json.data.records)) {
        throw new Error("账单列表接口返回异常: " + (json.responseDesc || hit.status));
      }
      const { records, total } = json.data;
      if (total > records.length) {
        throw new Error(`账单总数(${total})超过单页上限(${records.length})，同步逻辑需要升级成分页读取`);
      }
      step(`已读取 ${records.length} 条账单`);

      const keep = [
        "accountingMonth",
        "settlementNo",
        "brandName",
        "brandCompany",
        "siteCode",
        "shopCode",
        "settlementAmount",
        "currency",
        "settlementStatus",
        "documentCode",
        "generatedTime",
        "requestPaymentTime",
        "operator",
        "modifyTime",
      ];
      return {
        ok: true,
        records: records.map((r) => Object.fromEntries(keep.map((k) => [k, r[k] == null ? "" : r[k]]))),
        log,
      };
    } catch (err) {
      console.error("[FMS同步] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * 逐张读取费控单据的审批链：用页面自己的路由跳转到单据详情页，截取详情接口返回。
   * 单张失败（比如没权限）只记录该张的 error，不影响其他单据。
   * 返回 { ok, chains: { [AJF号]: { records, currentNodeUserIds, processStatus } | { error } }, log }。
   */
  async function fetchApprovalChains(codes) {
    const log = [];
    const step = (msg) => {
      log.push(msg);
      console.log("[FMS同步]", msg);
    };

    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }

      const capKey = "__fmsSyncCap";
      window[capKey] = [];
      if (!window.__fmsSyncHooked) {
        window.__fmsSyncHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__syncInfo = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const info = this.__syncInfo;
          if (info) {
            info.body = typeof body === "string" ? body : "";
            this.addEventListener("load", () => {
              (window[capKey] || []).push({
                url: info.url,
                body: info.body,
                status: this.status,
                text: this.responseText,
              });
            });
          }
          return origSend.apply(this, arguments);
        };
      }

      const appEl = await waitFor(() => document.querySelector("#app") && document.querySelector("#app").__vue_app__, "FMS前端应用");
      const router = appEl.config.globalProperties.$router;
      if (!router) throw new Error("找不到页面路由，FMS前端结构可能变了");

      const chains = {};
      for (const code of codes) {
        try {
          window[capKey].length = 0;
          await router.push({
            path: "/expense-control/center/edit-account",
            query: { step: "other", code, op: "1", origin: "brandPayment" },
          });
          const hit = await waitFor(
            () => window[capKey].find((c) => c.url.includes("/document/detail/" + code)),
            "单据详情: " + code,
            20000
          );
          const json = JSON.parse(hit.text);
          if (!json.success || !json.data) throw new Error(json.responseDesc || "接口返回异常");
          const d = json.data;
          chains[code] = {
            processStatus: String(d.processStatus == null ? "" : d.processStatus),
            currentNodeUserIds: d.currentNodeUserIds || [],
            records: (d.approvalRecords || []).map((r) => ({
              node: r.nodeName || "",
              who: (r.operators || []).map((o) => o.name),
              time: r.approvalTime || "",
              status: String(r.approvalStatus == null ? "" : r.approvalStatus),
            })),
          };
          step("已读取审批链: " + code);
        } catch (err) {
          chains[code] = { error: (err && err.message) || String(err) };
          step(`读取失败 ${code}: ${chains[code].error}`);
        }
      }

      try {
        await router.push({ path: "/brand-payment/brand-bill" });
      } catch (e) {
        // 回到账单页只是为了不把页面留在详情页，失败无所谓
      }
      return { ok: true, chains, log };
    } catch (err) {
      console.error("[FMS同步] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  return { FMS_ORIGIN, FMS_BILL_URL, fetchBillList, fetchApprovalChains };
})();
