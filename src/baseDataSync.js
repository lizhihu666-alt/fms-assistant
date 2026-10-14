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

      const channelEls = () =>
        [...document.querySelectorAll("*")].filter((e) => e.offsetParent && e.children.length === 0 && /^justfab-[a-z]+$/.test(e.textContent.trim()));
      async function setChannel(name) {
        const cur = channelEls()[0];
        if (!cur) throw new Error("找不到 Channel 选择器");
        if (cur.textContent.trim() === name) return;
        const box = cur.closest(".ant-select"); // 在点击之前取，点击后原节点可能被重新渲染
        let el = cur;
        let opt = null;
        for (let depth = 0; el && depth < 6 && !opt; depth++, el = el.parentElement) {
          fire(el);
          await sleep(400);
          opt = channelEls().find((e) => e !== cur && e.textContent.trim() === name);
        }
        if (!opt) throw new Error(`EH 里没有 Channel: ${name}`);
        fire(opt);
        // 判断切换成功要只看 Channel 选择框自己显示的值。不能看页面上所有 justfab-xxx 文字：
        // 标签页在后台时下拉层的收起动画会卡住，下拉里没选中的选项一直留在页面上，
        // 「只剩目标 Channel」就永远不成立（表现为第一次点击总是超时）
        const switched = box
          ? () => (box.querySelector(".ant-select-selection-item") || box).textContent.includes(name)
          : () => channelEls().some((e) => e.textContent.trim() === name) && !channelEls().some((e) => e.textContent.trim() !== name);
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
                if (s.shop_name && s.shop_name !== job.channel) continue;
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

  return { FMS_ORIGIN, FMS_BILL_URL, FMS_BASEDATA_URL, EH_ORIGIN, EH_PRICING_URL, fetchMissingPriceRows, fetchEhCosts, importBaseDataFile };
})();
