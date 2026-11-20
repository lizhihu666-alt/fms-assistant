// 基础数据补充：在 FMS / EH 页面里读数据的注入函数 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 全部只读：只做筛选/搜索，不点任何会修改数据的按钮，也不读取/使用登录凭据——
// 让页面自己发请求，插件只截取页面自己发出的请求的返回内容（跟付款进度同步一个思路）。
// 每个注入函数会被整体注入页面（MAIN world），所以必须自包含、自己 try/catch、总是返回普通对象。

const BaseDataSync = (() => {
  const FMS_ORIGIN = "https://fms-jf.wangoon.cn";
  const FMS_BILL_URL = FMS_ORIGIN + "/brand-payment/brand-bill";
  const FMS_BASEDATA_URL = FMS_ORIGIN + "/brand-payment/brand-data";
  const EH_ORIGIN = "https://admin.engagehub.tsostech.com";
  const EH_PRICING_URL = EH_ORIGIN + "/pricing";

  /**
   * FMS「账单明细」页：按账单编号筛选，读出全部明细，返回「结算金额为空」的行。
   * 返回 { ok, total, missing: [...], log }。
   */
  async function fetchMissingPriceRows(billNo) {
    const log = [];
    const step = (m) => log.push(m);
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

      const capKey = "__bdCap";
      window[capKey] = [];
      if (!window.__bdHooked) {
        window.__bdHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__bd = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const info = this.__bd;
          if (info) {
            info.body = typeof body === "string" ? body : "";
            this.addEventListener("load", () => {
              (window[capKey] || []).push({ url: info.url, body: info.body, text: this.responseText });
            });
          }
          return origSend.apply(this, arguments);
        };
      }
      const bodyOf = (c) => {
        try {
          return JSON.parse(c.body);
        } catch (e) {
          return {};
        }
      };

      // 1. 切到「账单明细」页签
      const tab = await waitFor(
        () => [...document.querySelectorAll(".el-tabs__item")].find((t) => t.textContent.trim() === "账单明细"),
        "账单明细页签"
      );
      tab.click();
      await sleep(800);
      step("已切到账单明细");

      // 2. 先把每页条数切到 1000，并等页面自己的那次加载结束
      //   （切换条数会让页面立刻按旧条件查一次；紧接着点「查询」会被页面忽略，所以要先等它）
      const pagination = await waitFor(
        () =>
          [...document.querySelectorAll(".el-pagination")].find(
            (p) => p.offsetParent !== null && p.querySelector(".el-pagination__sizes .el-select__wrapper")
          ),
        "账单明细分页组件"
      );
      const sizeWrapper = pagination.querySelector(".el-pagination__sizes .el-select__wrapper");
      if (!/1000/.test(sizeWrapper.textContent)) {
        window[capKey].length = 0;
        sizeWrapper.click();
        const option = await waitFor(
          () =>
            [...document.querySelectorAll(".el-select-dropdown__item")].find(
              (li) => li.offsetParent !== null && li.textContent.trim() === "1000条/页"
            ),
          "每页1000条选项"
        );
        option.click();
        await waitFor(
          () => window[capKey].some((c) => /settlement\/page/.test(c.url) && bodyOf(c).size === 1000),
          "切换每页条数后的加载",
          30000
        );
        await sleep(500);
      }

      // 3. 展开搜索条件（账单编号默认是收起的），填账单编号
      const findBillInput = () => {
        const item = [...document.querySelectorAll(".el-form-item")].find((i) => {
          const l = i.querySelector(".el-form-item__label");
          return l && l.textContent.trim() === "账单编号" && i.offsetParent;
        });
        return item ? item.querySelector("textarea, input") : null;
      };
      if (!findBillInput()) {
        const expand = [...document.querySelectorAll("button, span, a")].find(
          (e) => e.offsetParent && /^展开/.test(e.textContent.trim()) && e.children.length < 3
        );
        if (expand) expand.click();
      }
      const input = await waitFor(findBillInput, "账单编号输入框（账单明细页）");
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(input, billNo);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(300);

      // 4. 查询，并截取这个账单编号、每页1000条的返回（逐页翻完）
      const isMine = (c, page) => {
        const b = bodyOf(c);
        return (
          /settlement\/page/.test(c.url) &&
          b.size === 1000 &&
          b.current === page &&
          Array.isArray(b.settlementNoList) &&
          b.settlementNoList.length === 1 &&
          b.settlementNoList[0] === billNo
        );
      };
      window[capKey].length = 0;
      const queryBtn = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "查询" && b.offsetParent !== null
      );
      if (!queryBtn) throw new Error("按钮未找到: 查询");
      queryBtn.click();

      let records = [];
      let total = 0;
      for (let page = 1; ; page++) {
        const hit = await waitFor(() => window[capKey].filter((c) => isMine(c, page)).pop(), `账单明细第${page}页`, 30000);
        const json = JSON.parse(hit.text);
        if (!json.success || !json.data || !Array.isArray(json.data.records)) {
          throw new Error("账单明细接口返回异常: " + (json.responseDesc || ""));
        }
        records = records.concat(json.data.records);
        total = json.data.total;
        step(`已读取第${page}页，累计 ${records.length}/${total}`);
        if (records.length >= total) break;
        const next = pagination.querySelector(".btn-next");
        if (!next || next.disabled) throw new Error("明细没读完但没有下一页");
        window[capKey].length = 0;
        next.click();
      }
      if (records.length !== total) throw new Error(`明细条数不一致: 读到${records.length}，总数${total}`);
      const wrong = records.find((r) => r.settlementNo !== billNo);
      if (wrong) throw new Error(`读到了别的账单的明细（${wrong.settlementNo}），已中止`);

      const missing = records
        .filter((r) => r.settlementAmount === null || r.settlementAmount === undefined || r.settlementAmount === "")
        .map((r) => ({
          settlementNo: r.settlementNo,
          sku: r.sku,
          style: r.style,
          color: r.color,
          size: r.size,
          shopCode: r.shopCode,
          siteCode: r.siteCode,
          brandName: r.brandName,
          currency: r.currency,
        }));
      step(`缺结算价的明细 ${missing.length} 行`);
      return { ok: true, total, missing, log };
    } catch (err) {
      console.error("[基础数据] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * EH「Pricing」页：把搜索类型切到 SKU，按 MM SKU 搜，读 Seller SKU 和 Cost。
   * jobs: [{ channel: "justfab-us", skus: [mmSku, ...] }]
   * 搜一个 SKU 会返回它所在商品下的全部 SKU，已经覆盖到的就不再重复搜。
   * 返回 { ok, results: { [channel]: { skus: { [mm]: { seller, cost, currency } }, notFound: [mm], error? } }, log }。
   */
  async function fetchEhCosts(jobs) {
    const log = [];
    const step = (m) => log.push(m);
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
      const fire = (el) => {
        for (const t of ["mousedown", "mouseup", "click"]) {
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        }
      };

      const capKey = "__bdEhCap";
      window[capKey] = [];
      if (!window.__bdEhHooked) {
        window.__bdEhHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__bd = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const info = this.__bd;
          if (info) {
            this.addEventListener("load", () => {
              (window[capKey] || []).push({ url: info.url, text: this.responseText });
            });
          }
          return origSend.apply(this, arguments);
        };
      }

      // 搜索类型切到 SKU（默认是 Model）
      const typeSelect = await waitFor(
        () => document.querySelector(".ant-input-group-addon .ant-select .ant-select-selector"),
        "搜索类型下拉"
      );
      const typeLabel = () => {
        const el = document.querySelector(".ant-input-group-addon .ant-select .ant-select-selection-item");
        return el ? el.textContent.trim() : "";
      };
      if (typeLabel() !== "SKU") {
        fire(typeSelect);
        const opt = await waitFor(
          () => [...document.querySelectorAll(".ant-select-item-option")].find((o) => o.offsetParent && o.getAttribute("title") === "SKU"),
          "SKU选项"
        );
        fire(opt);
        await waitFor(() => typeLabel() === "SKU", "搜索类型切换为SKU");
        step("搜索类型已切换为 SKU");
      }

      const keywordInput = await waitFor(
        () => [...document.querySelectorAll("input")].find((i) => i.offsetParent && /SKU|SPU|Barcode/i.test(i.placeholder) && !/Title/i.test(i.placeholder)),
        "关键词输入框"
      );

      // Channel 名形如 justfab-us；页面刚加载时选择器可能还没渲染，所以下面会等它出现。
      // 大小写、下划线/空格、字母数字混合都认，比较时统一转小写。
      const chanRe = /^justfab[-_ ]?[a-z0-9]+$/i;
      const sameCh = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
      const channelEls = () =>
        [...document.querySelectorAll("*")].filter((e) => e.getClientRects().length > 0 && e.children.length === 0 && chanRe.test(e.textContent.trim()));
      const selectTexts = () => [...document.querySelectorAll(".ant-select-selection-item")].map((e) => e.textContent.trim()).filter(Boolean).join(" / ");
      async function setChannel(name) {
        let cur;
        try {
          cur = await waitFor(() => channelEls()[0], "Channel 选择器", 15000);
        } catch (e) {
          throw new Error("找不到 Channel 选择器（页面上的下拉当前显示：" + (selectTexts() || "无") + "）");
        }
        if (sameCh(cur.textContent, name)) return;
        const box = cur.closest(".ant-select"); // 在点击之前取，点击后原节点可能被重新渲染
        let el = cur;
        let opt = null;
        for (let depth = 0; el && depth < 6 && !opt; depth++, el = el.parentElement) {
          fire(el);
          await sleep(400);
          opt = channelEls().find((e) => e !== cur && sameCh(e.textContent, name));
        }
        if (!opt) throw new Error(`EH 里没有 Channel: ${name}`);
        fire(opt);
        // 判断切换成功要只看 Channel 选择框自己显示的值。不能看页面上所有 justfab-xxx 文字：
        // 标签页在后台时下拉层的收起动画会卡住，下拉里没选中的选项一直留在页面上，
        // 「只剩目标 Channel」就永远不成立（表现为第一次点击总是超时）
        const switched = box
          ? () => (box.querySelector(".ant-select-selection-item") || box).textContent.toLowerCase().includes(name.toLowerCase())
          : () => channelEls().some((e) => sameCh(e.textContent, name)) && !channelEls().some((e) => !sameCh(e.textContent, name));
        await waitFor(switched, "切换Channel: " + name);
        await sleep(600);
        step("已切换 Channel: " + name);
      }

      async function searchSku(mm) {
        window[capKey].length = 0;
        const proto = HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(keywordInput, mm);
        keywordInput.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(200);
        for (const t of ["keydown", "keypress", "keyup"]) {
          keywordInput.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
        }
        const enc = encodeURIComponent(mm);
        const hit = await waitFor(
          () => window[capKey].filter((c) => /pricing\/selling\/list/.test(c.url) && c.url.includes("keyword=" + enc + "&") && /keyword_type=Sku/i.test(c.url)).pop(),
          "EH搜索结果: " + mm,
          20000
        );
        const json = JSON.parse(hit.text);
        if (json.code !== 0 || !json.data) throw new Error("EH接口返回异常: " + (json.message || json.code));
        return json.data.list || [];
      }

      const results = {};
      for (const job of jobs) {
        const res = { skus: {}, notFound: [] };
        results[job.channel] = res;
        try {
          await setChannel(job.channel);
          for (const mm of job.skus) {
            if (res.skus[mm]) continue; // 已被前面的搜索覆盖
            const spus = await searchSku(mm);
            for (const spu of spus) {
              for (const s of spu.skus || []) {
                if (s.shop_name && !sameCh(s.shop_name, job.channel)) continue;
                const markets = Array.isArray(s.markets) ? s.markets : typeof s.markets === "string" ? JSON.parse(s.markets) : [];
                const m = markets.find((x) => x && x.cost_amount != null && x.cost_amount !== "") || markets[0] || {};
                res.skus[s.mm_sku_code] = { seller: s.seller_sku_code || "", cost: m.cost_amount == null ? "" : m.cost_amount, currency: m.cost_currency || m.currency || "" };
              }
            }
            if (!res.skus[mm]) res.notFound.push(mm);
            step(`${job.channel} 搜索 ${mm}：${res.skus[mm] ? "找到" : "未找到"}`);
          }
        } catch (err) {
          res.error = (err && err.message) || String(err);
          step(`${job.channel} 失败: ${res.error}`);
        }
      }
      return { ok: true, results, log };
    } catch (err) {
      console.error("[基础数据] EH失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * FMS「基础数据」页：点「导入」→ 选中 xlsx → 等上传完成 → 点「确认」。
   * 这是写入动作，只在用户人工复查后明确点了「一键导入」才会被调用。
   * 返回 { ok, messages, log }；导入的最终结果（成功/失败）以「导入导出任务」里的为准。
   */
  async function importBaseDataFile(fileName, base64) {
    const log = [];
    const step = (m) => log.push(m);
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
      const visible = (e) => e && e.offsetParent !== null;
      const lastDialog = () => [...document.querySelectorAll(".el-dialog")].filter(visible).pop();

      const importBtn = await waitFor(
        () => [...document.querySelectorAll("button")].find((b) => visible(b) && b.textContent.trim() === "导入"),
        "导入按钮"
      );
      importBtn.click();
      step("已点击导入");

      const dialog = await waitFor(() => {
        const d = lastDialog();
        return d && d.querySelector("input[type=file]") ? d : null;
      }, "导入弹窗");

      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], fileName, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = dialog.querySelector("input[type=file]");
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      step("已选择文件 " + fileName);

      // 这个弹窗是「选好文件 → 点确认才真正上传」，选完后文件状态是 is-ready
      await waitFor(() => dialog.querySelector(".el-upload-list__item"), "上传文件列表");
      step("文件已就绪");

      // 收集页面弹出的提示（ElMessage），确认后几秒内的都记下来
      const messages = [];
      const seen = new Set();
      const collect = () =>
        document.querySelectorAll(".el-message").forEach((m) => {
          if (seen.has(m)) return;
          seen.add(m);
          const t = m.textContent.trim();
          if (t) messages.push(t);
        });
      const ok = [...dialog.querySelectorAll(".el-dialog__footer button")].find((b) => b.textContent.trim() === "确认");
      if (!ok) throw new Error("没找到导入弹窗里的确认按钮");
      ok.click();
      step("已点击确认");
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        collect();
      }
      return { ok: true, messages, dialogClosed: !visible(dialog), log };
    } catch (err) {
      console.error("[基础数据] 导入失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * FMS「基础数据」页：按品牌（+店铺）筛选，把该品牌的基础数据全量读出来（每页 1000 条），
   * 返回其中「没有结算价」的行（数据状态一般是「待确认」）。全程只做筛选/翻页，让页面自己发请求，插件只截取返回内容。
   * brand：品牌名（和页面「品牌商」下拉里的写法一致）；shops：要看的店铺（空 = 该品牌下所有店铺）。
   * 返回 { ok, total, missing: [...], byShop: { 店铺: { total, missing } }, log }。
   */
  async function fetchFmsBaseDataMissing(brand, shops) {
    const log = [];
    const step = (m) => log.push(m);
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        const last = fn(); // 页面被卡住期间条件可能已经满足，过了期限也要再看一眼
        if (last) return last;
        throw new Error("等待超时: " + label);
      }
      const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const fire = (el) => {
        for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      };

      const capKey = "__bdFmsCap";
      window[capKey] = [];
      if (!window.__bdFmsHooked) {
        window.__bdFmsHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__bf = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
          const info = this.__bf;
          if (info) {
            info.body = typeof body === "string" ? body : "";
            this.addEventListener("load", () => {
              (window[capKey] || []).push({ url: info.url, body: info.body, text: this.responseText });
            });
          }
          return origSend.apply(this, arguments);
        };
      }
      const bodyOf = (c) => {
        try {
          return JSON.parse(c.body);
        } catch (e) {
          return {};
        }
      };
      const isList = (c) => /base-data\/page/.test(c.url);

      const formItem = (label) =>
        [...document.querySelectorAll(".el-form-item")].find((i) => {
          const l = i.querySelector(".el-form-item__label");
          return l && l.textContent.trim() === label && vis(i);
        });
      // 在多选下拉里选一个选项，选完点空白处收起下拉
      async function pickMulti(label, wanted) {
        const item = await waitFor(() => formItem(label), "筛选项「" + label + "」");
        fire(item.querySelector(".el-select__wrapper"));
        await sleep(500);
        const opt = await waitFor(
          () => [...document.querySelectorAll(".el-select-dropdown__item")].filter(vis).find((o) => o.textContent.trim() === wanted),
          label + "选项「" + wanted + "」（下拉里没有这个选项）"
        );
        opt.click();
        await sleep(300);
        fire(document.body);
        await sleep(500);
        // 选了多个时下拉可能把标签折叠成「+N」，所以看到「+N」也算选上了
        const tags = [...item.querySelectorAll(".el-tag")].map((t) => t.textContent.trim());
        if (!tags.includes(wanted) && !tags.some((t) => /^\+\s*\d+$/.test(t))) throw new Error(label + "选择未生效: " + wanted);
        step("已选" + label + " " + wanted);
      }

      // 1. 先把每页条数切到 1000，等页面自己的那次加载结束（切换条数会让页面立刻查一次）
      const pagination = await waitFor(
        () => [...document.querySelectorAll(".el-pagination")].find((p) => vis(p) && p.querySelector(".el-pagination__sizes .el-select__wrapper")),
        "分页组件"
      );
      const sizeWrapper = pagination.querySelector(".el-pagination__sizes .el-select__wrapper");
      if (!/1000/.test(sizeWrapper.textContent)) {
        window[capKey].length = 0;
        fire(sizeWrapper);
        const option = await waitFor(
          () => [...document.querySelectorAll(".el-select-dropdown__item")].filter(vis).find((li) => li.textContent.trim() === "1000条/页"),
          "每页1000条选项"
        );
        option.click();
        // 页面不一定会因为切换条数重新查询（例如当前结果很少），等不到就继续，后面点「查询」会自己发请求
        try {
          await waitFor(() => window[capKey].some((c) => isList(c) && bodyOf(c).size === 1000), "切换每页条数后的加载", 8000);
        } catch (e) {
          step("切换每页条数后页面没有重新加载，继续");
        }
        await sleep(800);
      }

      // 2. 选品牌、店铺，查询
      await pickMulti("品牌商", brand);
      const wantShops = Array.isArray(shops) ? shops : [];
      for (const s of wantShops) await pickMulti("店铺", s);
      const sameSet = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
      const isMine = (c, page) => {
        const b = bodyOf(c);
        return isList(c) && b.size === 1000 && b.current === page && sameSet(b.brandNameList, [brand]) && sameSet(b.shopCodeList, wantShops);
      };
      window[capKey].length = 0;
      const queryBtn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "查询" && vis(b));
      if (!queryBtn) throw new Error("按钮未找到: 查询");
      queryBtn.click();

      // 3. 逐页读完
      let records = [];
      let total = 0;
      for (let page = 1; ; page++) {
        let hit;
        try {
          hit = await waitFor(() => window[capKey].filter((c) => isMine(c, page)).pop(), "基础数据第" + page + "页", page === 1 ? 15000 : 40000);
        } catch (e) {
          if (page !== 1) throw e;
          // 第一次点「查询」可能被页面忽略（页面还在处理上一次加载），再点一次
          step("第一次查询没有响应，再点一次");
          queryBtn.click();
          hit = await waitFor(() => window[capKey].filter((c) => isMine(c, page)).pop(), "基础数据第" + page + "页", 40000);
        }
        const json = JSON.parse(hit.text);
        if (!json.success || !json.data || !Array.isArray(json.data.records)) throw new Error("基础数据接口返回异常: " + (json.responseDesc || ""));
        records = records.concat(json.data.records);
        total = json.data.total;
        step("已读取第" + page + "页，累计 " + records.length + "/" + total);
        if (records.length >= total) break;
        const next = pagination.querySelector(".btn-next");
        if (!next || next.disabled) throw new Error("基础数据没读完但没有下一页");
        window[capKey].length = 0;
        next.click();
      }
      if (records.length !== total) throw new Error("基础数据条数不一致: 读到" + records.length + "，总数" + total);
      const wrong = records.find((r) => r.brandName !== brand);
      if (wrong) throw new Error("读到了别的品牌的数据（" + wrong.brandName + "），已中止");

      const noPrice = (r) => r.settlementPrice === null || r.settlementPrice === undefined || r.settlementPrice === "";
      const byShop = {};
      for (const r of records) {
        const e = (byShop[r.shopCode] = byShop[r.shopCode] || { total: 0, missing: 0 });
        e.total++;
        if (noPrice(r)) e.missing++;
      }
      const missing = records.filter(noPrice).map((r) => ({
        siteCode: r.siteCode,
        shopCode: r.shopCode,
        brandName: r.brandName,
        sku: r.sku,
        brandSku: r.brandSku,
        style: r.style,
        color: r.color,
        size: r.size,
        currency: r.settlementCurrency,
        dataStatus: r.dataStatus,
      }));
      step("缺结算价 " + missing.length + " 行（共 " + total + " 行）");
      return { ok: true, total, missing, byShop, log };
    } catch (err) {
      console.error("[基础数据全量匹配] 读 FMS 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }


  /**
   * EH「Pricing」页：对每个 Channel 点右上角 Export →「匹配当前搜索」→ OK，等导出任务完成，
   * 再点任务列表里的 Download，只截取页面自己请求到的下载地址（不下载到本机、不读取任何登录信息）。
   * 导出前先在 Merchant 筛选里选中名字和品牌对得上的商户（只导出这个品牌，不导出整个渠道）；
   * 返回 { ok, results: { [channel]: { url, fileName, error? } }, log }；CSV 由后台用该地址取回。
   */
  async function fetchEhExportLinks(channels, brand, exactMerchants) {
    const log = [];
    const step = (m) => log.push(m);
    const restore = [];
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        const last = fn();
        if (last) return last;
        throw new Error("等待超时: " + label);
      }
      const vis = (e) => e.getClientRects().length > 0;
      const fire = (el) => {
        for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      };

      const capKey = "__bdEhExpCap";
      window[capKey] = [];
      if (!window.__bdEhExpHooked) {
        window.__bdEhExpHooked = true;
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
          this.__be = { url: String(url) };
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function () {
          const info = this.__be;
          if (info) {
            this.addEventListener("load", () => {
              (window[capKey] || []).push({ url: info.url, text: this.responseText });
            });
          }
          return origSend.apply(this, arguments);
        };
      }
      // 点 Download 时页面会自己把文件下载到本机，这里拦住，只要地址
      const isFileUrl = (u) => /file\.engagehub\./i.test(String(u || ""));
      const aClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (isFileUrl(this.href)) return;
        return aClick.apply(this, arguments);
      };
      restore.push(() => { HTMLAnchorElement.prototype.click = aClick; });
      const wOpen = window.open;
      window.open = function (u) {
        if (isFileUrl(u)) return null;
        return wOpen.apply(this, arguments);
      };
      restore.push(() => { window.open = wOpen; });

      const chanRe = /^justfab[-_ ]?[a-z0-9]+$/i;
      const sameCh = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
      const channelEls = () => [...document.querySelectorAll("*")].filter((e) => vis(e) && e.children.length === 0 && chanRe.test(e.textContent.trim()));
      async function setChannel(name) {
        const cur = await waitFor(() => channelEls()[0], "Channel 选择器", 15000);
        if (sameCh(cur.textContent, name)) return false;
        const box = cur.closest(".ant-select");
        let el = cur;
        let opt = null;
        for (let depth = 0; el && depth < 6 && !opt; depth++, el = el.parentElement) {
          fire(el);
          await sleep(400);
          opt = channelEls().find((e) => e !== cur && sameCh(e.textContent, name));
        }
        if (!opt) throw new Error("EH 里没有 Channel: " + name);
        fire(opt);
        const switched = box
          ? () => (box.querySelector(".ant-select-selection-item") || box).textContent.toLowerCase().includes(name.toLowerCase())
          : () => channelEls().some((e) => sameCh(e.textContent, name));
        await waitFor(switched, "切换Channel: " + name);
        await sleep(600);
        return true;
      }

      const parse = (c) => {
        try { return JSON.parse(c.text); } catch (e) { return null; }
      };
      const taskIcon = () => [...document.querySelectorAll(".anticon-download")].find((e) => vis(e) && e.getBoundingClientRect().top < 60);
      const taskItems = () => [...document.querySelectorAll('[class*="_filename_"]')].filter(vis);
      const exportBtn = () => [...document.querySelectorAll("button")].find((b) => vis(b) && /^\s*Export\s*$/.test(b.textContent) && b.getBoundingClientRect().top < 200);

      // 在 Merchant 筛选里选中名字含品牌名的商户（EH 的商户名和 FMS 品牌名不完全一样，如 Attraco 对 Attraco-Drop Ship），
      // 取消其它已选的商户，保证「匹配当前搜索」导出的只是这个品牌
      const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      // ---- Merchant 筛选：一次只选一个商户，一个商户导出一个文件（单选、多选的下拉都适用） ----
      const merchantSel = async () => {
        const leaf = await waitFor(
          () => [...document.querySelectorAll(".ant-select *")].find((e) => vis(e) && e.children.length === 0 && /^Merchant$/.test(e.textContent.trim())),
          "Merchant 筛选",
          15000
        );
        return leaf.closest(".ant-select");
      };
      const optEls = () => [...document.querySelectorAll(".ant-select-item-option")].filter(vis);
      const isSel = (o) => /selected/.test(o.className);
      const optByName = (nm) => optEls().find((e) => e.textContent.trim() === nm);
      // 点选后页面可能把下拉收起，所以每一步前都确认下拉是开着的
      async function ensureOpen(sel) {
        if (optEls().length) return;
        fire(sel.querySelector(".ant-select-selector") || sel);
        await sleep(800);
        await waitFor(() => optEls().length, "Merchant 下拉选项", 10000);
      }
      async function closeDropdown() {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        fire(document.body);
        await sleep(1500); // 收起后页面按新商户重新查询
      }
      const idsOf = (c) => {
        try {
          const p = new URL(c.url, location.origin).searchParams;
          const out = [];
          for (const [k, v] of p) if (/^merchant/i.test(k)) out.push(...String(v).split(",").filter(Boolean));
          return out;
        } catch (e) {
          return [];
        }
      };

      // 找出名字对得上的 EH 商户（有指定对应关系就精确匹配，没有就按「商户名包含品牌名」）
      async function findMerchants(brandName, exact) {
        const want = normName(brandName);
        if (!want) throw new Error("没有品牌名，不能筛选 EH 商户");
        const exactSet = new Set((exact || []).map(normName));
        const isMatch = (o) => {
          const n = normName(o.textContent);
          if (!n) return false;
          return exactSet.size ? exactSet.has(n) : n.includes(want);
        };
        const sel = await merchantSel();
        await ensureOpen(sel);
        if (!exactSet.size) await searchIn(sel, brandName);
        let matches = optEls().filter(isMatch);
        if (!matches.length) {
          await searchIn(sel, (exact && exact[0]) || brandName);
          matches = optEls().filter(isMatch);
        }
        if (!matches.length) throw new Error("EH 的 Merchant 里找不到" + (exactSet.size ? "商户 " + exact.join("、") : "名字含「" + brandName + "」的商户"));
        let names = [...new Set(matches.map((o) => o.textContent.trim()))];
        if (exactSet.size && names.length < exactSet.size) {
          for (const nm of exact) {
            if (names.some((x) => normName(x) === normName(nm))) continue;
            await searchIn(sel, nm);
            const hit = optEls().find((o) => normName(o.textContent) === normName(nm));
            if (hit) names.push(hit.textContent.trim());
          }
        }
        await closeDropdown();
        return names;
      }

      // 在下拉的搜索框里输入名字：下拉是虚拟列表，只渲染看得见的几项，不搜就找不到排在后面的商户
      async function searchIn(sel, text) {
        const input = sel.querySelector("input");
        if (!input) return;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await sleep(900);
      }
      // 筛选框里当前选中的商户（多选时是一个个标签，单选时是一个选中项；「+N」表示还有折叠的）
      const tagEls = (sel) => [...sel.querySelectorAll(".ant-select-selection-item")].filter(vis);
      const isRest = (e) => /^\+\s*\d+/.test(e.textContent.trim());
      const selectedNames = (sel) => tagEls(sel).filter((e) => !isRest(e)).map((e) => (e.getAttribute("title") || e.textContent).trim()).filter(Boolean);
      const hasRest = (sel) => tagEls(sel).some(isRest);

      // 只选这一个商户：先去掉别的标签，再搜出这个商户点上，最后看筛选框里是否只剩它
      async function selectOnly(name) {
        const sel = await merchantSel();
        window[capKey].length = 0;
        for (let attempt = 0; attempt < 6; attempt++) {
          const cur = selectedNames(sel);
          if (cur.length === 1 && cur[0] === name && !hasRest(sel)) break;
          // 多选：点标签上的 × 去掉别的商户
          const other = tagEls(sel).find((e) => !isRest(e) && (e.getAttribute("title") || e.textContent).trim() !== name);
          const rm = other && other.querySelector(".ant-select-selection-item-remove");
          if (rm) {
            fire(rm);
            await sleep(1500);
            continue;
          }
          if (cur.includes(name) && !hasRest(sel)) break;
          // 选上这个商户（单选时会直接替换掉原来的）
          await ensureOpen(sel);
          let o = optByName(name);
          if (!o) {
            await searchIn(sel, name);
            o = optByName(name);
          }
          if (!o) throw new Error("Merchant 下拉里搜不到 " + name);
          if (!isSel(o)) o.click();
          await sleep(1500);
          await closeDropdown();
        }
        const cur = selectedNames(sel);
        // 辅助信号：页面发出过恰好带 1 个商户的列表请求
        const reqOk = window[capKey].some((c) => /pricing\/selling\/list/.test(c.url) && idsOf(c).length === 1);
        const ok = cur.length === 1 && cur[0] === name && !hasRest(sel);
        if (!ok && !(reqOk && cur.includes(name))) {
          throw new Error("Merchant 选择未生效（应只选 " + name + "，筛选框里现在是：" + (cur.join("、") || "空") + (hasRest(sel) ? " 等" : "") + "）");
        }
        if (optEls().length) await closeDropdown();
      }

      // ---- 导出当前筛选结果，返回下载地址 ----
      const usedTaskIds = new Set();
      async function exportCurrent(label) {
        const startSec = Math.floor(Date.now() / 1000) - 30;
        window[capKey].length = 0;
        const eb = await waitFor(exportBtn, "Export 按钮", 15000);
        eb.click();
        const radio = await waitFor(() => [...document.querySelectorAll("label")].filter(vis).find((l) => /Records matching your search/i.test(l.textContent)), "导出范围选项", 10000);
        const input = radio.querySelector("input");
        if (input && !input.checked) radio.click();
        const ok = await waitFor(() => [...document.querySelectorAll("button")].filter(vis).find((b) => /^\s*OK\s*$/.test(b.textContent)), "OK 按钮", 10000);
        ok.click();
        const created = await waitFor(() => window[capKey].find((c) => /pricing\/selling\/export/.test(c.url)), "创建导出任务", 30000);
        const cj = parse(created);
        if (!cj || cj.code !== 0) throw new Error("创建导出任务失败: " + ((cj && (cj.message || cj.code)) || "无返回"));
        step(label + " 已创建导出任务");

        // 打开任务列表，等这次点出来的任务完成（已经取过的任务不再认）
        let item = null;
        const deadline = Date.now() + 240000;
        const isTaskList = (c) => /export\/list/.test(c.url);
        while (Date.now() < deadline && !item) {
          // 任务列表只在弹层打开时刷新：已经开着就先关上，再打开，让页面重新拉一次列表
          const before = window[capKey].length;
          const icon = await waitFor(taskIcon, "导出任务图标", 10000);
          const btn = icon.closest("button") || icon;
          if (taskItems().length) {
            fire(btn);
            await sleep(700);
          }
          fire(btn);
          let got = null;
          try {
            got = await waitFor(() => window[capKey].slice(before).filter(isTaskList).pop(), "导出任务列表", 12000);
          } catch (e) {
            step(label + " 任务列表没有刷新，再试一次");
            await sleep(1500);
            continue;
          }
          const lj = parse(got);
          const list = (lj && lj.data && lj.data.list) || [];
          const latest = list.filter((t) => t.export_type === "admin_pricing" && t.created_at >= startSec && !usedTaskIds.has(t.id))[0];
          if (latest && latest.status === 2) {
            item = latest;
          } else if (latest && latest.status !== 1 && latest.status !== 0) {
            throw new Error("导出任务状态异常: " + (latest.status_name || latest.status) + (latest.failure_reason ? "（" + latest.failure_reason + "）" : ""));
          } else {
            step(label + " 导出生成中…");
            await sleep(4000);
          }
        }
        if (!item) throw new Error("导出任务 4 分钟内没有完成");
        usedTaskIds.add(item.id);

        // 点这条任务的 Download，截取下载地址
        window[capKey].length = 0;
        if (!taskItems().length) fire((await waitFor(taskIcon, "导出任务图标", 10000)).closest("button") || taskIcon());
        const nameEl = await waitFor(() => taskItems().find((e) => e.textContent.trim() === item.file_name), "任务列表里的 " + item.file_name, 10000);
        let box = nameEl;
        let dl = null;
        for (let i = 0; i < 6 && box && !dl; i++, box = box.parentElement) {
          dl = [...box.querySelectorAll("span,button,a")].find((e) => vis(e) && /^\s*Download\s*$/.test(e.textContent) && e.children.length === 0);
        }
        if (!dl) throw new Error("找不到 Download 按钮");
        (dl.closest("button") || dl).click();
        const hit = await waitFor(() => window[capKey].find((c) => /export\/download-url/.test(c.url)), "下载地址", 30000);
        const dj = parse(hit);
        const url = dj && dj.data && dj.data.url;
        if (!url) throw new Error("没有拿到下载地址");
        // 收起任务列表
        const icon2 = taskIcon();
        if (icon2 && taskItems().length) fire(icon2.closest("button") || icon2);
        await sleep(500);
        return { url, fileName: item.file_name };
      }

      const results = {};
      for (const ch of channels) {
        const res = { files: [] };
        results[ch] = res;
        try {
          const switched = await setChannel(ch);
          step("Channel: " + ch + (switched ? "（已切换）" : "（当前）"));
          await sleep(1500);
          const names = await findMerchants(brand, exactMerchants);
          step("EH 商户: " + names.join("、") + "（逐个导出）");
          for (const nm of names) {
            await selectOnly(nm);
            step("已筛选商户 " + nm);
            await sleep(1500);
            const f = await exportCurrent(ch + "/" + nm);
            f.merchant = nm;
            res.files.push(f);
            step(ch + "/" + nm + " 导出文件已生成: " + f.fileName);
          }
        } catch (err) {
          res.error = (err && err.message) || String(err);
          step(ch + " 失败: " + res.error);
        }
      }
      return { ok: true, results, log };
    } catch (err) {
      console.error("[基础数据全量匹配] 导出 EH 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    } finally {
      restore.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
    }
  }

  return { FMS_ORIGIN, FMS_BILL_URL, FMS_BASEDATA_URL, EH_ORIGIN, EH_PRICING_URL, fetchMissingPriceRows, fetchEhCosts, importBaseDataFile, fetchFmsBaseDataMissing, fetchEhExportLinks };
})();
