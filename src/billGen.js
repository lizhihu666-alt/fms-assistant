// 在 FMS「账单总表」生成账单 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 等价于人工点「账单生成」→ 选品牌/店铺/结算月份 → 点「确认」。这是写入动作，
// 只在用户在插件里明确点了「生成账单」之后才会执行。
// 注入函数会被整体注入页面（MAIN world），所以必须自包含、自己 try/catch、总是返回普通对象。

const BillGen = (() => {
  const BRANDS = [
    "TIJN", "Pretty Garden", "Magnlens", "Attraco", "BAGSMART", "ECOSUSI", "V for City", "Attraco-B",
    "HASHMERE", "FINEAST", "Camel Crown", "Dorina", "TouchStone", "UBRAS", "PUYONG", "SEQWL",
    "Malow London", "Where's That From", "Imily Bela", "Lahome", "SOJOS", "CAMEL", "CHARMO",
  ];
  const SHOPS = ["JUSTFAB", "Justfab EU"];

  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, "");

  /** 在账单列表里找 品牌+店铺+结算月份 对应的账单（同一组合可能有多张，比如 EU 多个站点）。 */
  function findBills(records, brand, shop, month) {
    return (records || []).filter(
      (r) => norm(r.brandName) === norm(brand) && norm(r.shopCode) === norm(shop) && String(r.accountingMonth) === month
    );
  }

  /**
   * 页面注入：打开「账单生成」弹窗，读品牌下拉里的全部选项，然后关掉弹窗（不提交、不改任何数据）。
   * 返回 { ok, brands, log }。
   */
  async function listBrands() {
    const log = [];
    const step = (m) => log.push(m);
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }
      const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const fire = (el) =>
        ["mousedown", "mouseup", "click"].forEach((t) =>
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
        );
      const labelOf = (dlg, text) =>
        [...dlg.querySelectorAll(".el-form-item")].find((f) => {
          const l = f.querySelector("label");
          return l && l.textContent.trim() === text;
        });

      const genBtn = await waitFor(
        () => [...document.querySelectorAll("button")].find((b) => visible(b) && b.textContent.trim() === "账单生成"),
        "账单生成按钮"
      );
      genBtn.click();
      const dlg = await waitFor(() => {
        const d = [...document.querySelectorAll(".el-dialog")].filter(visible).pop();
        return d && labelOf(d, "品牌") ? d : null;
      }, "账单生成弹窗");
      step("已打开账单生成弹窗");

      fire(labelOf(dlg, "品牌").querySelector(".el-select__wrapper"));
      const items = () => [...document.querySelectorAll(".el-select-dropdown__item")].filter(visible);
      await waitFor(() => items().length > 0, "品牌下拉选项");
      await sleep(400); // 选项可能分批渲染，稍等一下再读
      const brands = [...new Set(items().map((o) => o.textContent.trim()).filter(Boolean))];
      step("读到 " + brands.length + " 个品牌");

      // 收起下拉、关弹窗：点弹窗的取消/关闭，什么都不提交
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await sleep(300);
      const cancel =
        [...dlg.querySelectorAll(".el-dialog__footer button")].find((b) => /取消|关闭/.test(b.textContent.trim())) ||
        dlg.querySelector(".el-dialog__headerbtn");
      if (cancel) cancel.click();
      return { ok: true, brands, log };
    } catch (err) {
      console.error("[读取品牌] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * 页面注入：点「账单生成」→ 填品牌/店铺/结算月份 → 点「确认」。
   * 返回 { ok, messages, log }；账单编号由调用方再去列表里查。
   */
  async function generateBill(brand, shop, month) {
    const log = [];
    const step = (m) => log.push(m);
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }
      // 判断「有没有显示出来」不能看元素尺寸：标签页在后台时浏览器暂停动画帧，
      // 下拉/弹层会一直卡在「刚出现、缩放为 0」的状态，尺寸是 0 但其实已经可以操作
      const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      const fire = (el) =>
        ["mousedown", "mouseup", "click"].forEach((t) =>
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
        );
      const visibleOptions = () => [...document.querySelectorAll(".el-select-dropdown__item")].filter(visible);
      const labelOf = (dlg, text) =>
        [...dlg.querySelectorAll(".el-form-item")].find((f) => {
          const l = f.querySelector("label");
          return l && l.textContent.trim() === text;
        });

      const genBtn = await waitFor(
        () => [...document.querySelectorAll("button")].find((b) => visible(b) && b.textContent.trim() === "账单生成"),
        "账单生成按钮"
      );
      genBtn.click();
      const dlg = await waitFor(() => {
        const d = [...document.querySelectorAll(".el-dialog")].filter(visible).pop();
        return d && labelOf(d, "品牌") && labelOf(d, "店铺") && labelOf(d, "结算月份") ? d : null;
      }, "账单生成弹窗");
      step("已打开账单生成弹窗");

      async function pickOption(item, wanted, name) {
        const wrapper = item.querySelector(".el-select__wrapper");
        fire(wrapper);
        const opt = await waitFor(
          () => visibleOptions().find((o) => o.textContent.trim() === wanted),
          name + "选项「" + wanted + "」（下拉里没有这个选项）"
        );
        opt.click();
        await sleep(500);
        if (!item.textContent.includes(wanted)) throw new Error(name + "选择未生效: " + wanted);
        step("已选" + name + " " + wanted);
      }

      await pickOption(labelOf(dlg, "品牌"), brand, "品牌");
      await sleep(800); // 选完品牌页面会去加载对应的站点/店铺
      await pickOption(labelOf(dlg, "店铺"), shop, "店铺");

      // 结算月份：打开月份面板，翻到对应年份，点月份
      const [yy, mm] = month.split("-").map(Number);
      const monthItem = labelOf(dlg, "结算月份");
      const inp = monthItem.querySelector("input");
      // 光点击/聚焦这个输入框不一定弹出面板（实测刚选完店铺时不弹），但往里输入内容一定会弹，
      // 所以先输入 YYYY-MM 把面板唤出来，再点面板里的月份，走页面自己的选择逻辑。
      inp.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, month);
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      const panel = await waitFor(() => [...document.querySelectorAll(".el-picker-panel")].filter(visible).pop(), "月份面板");
      for (let i = 0; i < 12; i++) {
        const cur = parseInt((panel.querySelector(".el-date-picker__header-label").textContent.match(/\d{4}/) || [0])[0], 10);
        if (cur === yy) break;
        const btn = panel.querySelector(cur > yy ? 'button[aria-label="前一年"]' : 'button[aria-label="后一年"]');
        if (!btn) throw new Error("月份面板找不到翻年按钮");
        btn.click();
        await sleep(200);
      }
      const cell = panel.querySelector('td[aria-label="' + mm + ' 月"]');
      if (!cell) throw new Error("月份面板找不到 " + mm + " 月");
      cell.click();
      // 不能等面板收起来再判断（后台标签页的收起动画会卡住），直接看输入框有没有变成目标月份
      await waitFor(() => inp.value === month, "月份选择生效", 3000).catch(() => {});
      if (inp.value !== month) throw new Error("结算月份选择未生效，当前是「" + inp.value + "」");
      step("已选结算月份 " + month);

      // 收集页面弹出的提示（ElMessage）
      const messages = [];
      const seen = new Set();
      const collect = () =>
        document.querySelectorAll(".el-message").forEach((m) => {
          if (seen.has(m)) return;
          seen.add(m);
          const t = m.textContent.trim();
          if (t) messages.push(t);
        });
      const ok = [...dlg.querySelectorAll(".el-dialog__footer button")].find((b) => b.textContent.trim() === "确认");
      if (!ok) throw new Error("没找到账单生成弹窗里的确认按钮");
      ok.click();
      step("已点击确认");
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        collect();
      }
      const errs = [...dlg.querySelectorAll(".el-form-item.is-error")].map((f) => f.textContent.trim());
      if (visible(dlg) && errs.length) throw new Error("表单校验未通过: " + errs.join("；"));
      return { ok: true, messages, log };
    } catch (err) {
      console.error("[生成账单] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * 页面注入：在账单总表按账单编号筛选 → 点这张账单操作列的「重新生成」。
   * 只处理状态为「待确认」的账单；如果点完弹出确认框就点确认；如果弹出的是需要填写内容的表单，
   * 不替用户填，直接报错。返回 { ok, messages, dialogText, log }。
   */
  async function regenerateBill(billNo) {
    const log = [];
    const step = (m) => log.push(m);
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }
      // 判断「有没有显示出来」不能看元素尺寸：标签页在后台时浏览器暂停动画帧，
      // 下拉/弹层会一直卡在「刚出现、缩放为 0」的状态，尺寸是 0 但其实已经可以操作
      const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";

      const item = await waitFor(
        () =>
          [...document.querySelectorAll(".el-form-item")].find((it) => {
            const l = it.querySelector(".el-form-item__label");
            return l && l.textContent.trim() === "账单编号";
          }),
        "账单编号筛选框"
      );
      const input = item.querySelector("textarea, input");
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const doQuery = () => {
        setter.call(input, billNo);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const btn = [...document.querySelectorAll("button")].find((b) => visible(b) && b.textContent.trim() === "查询");
        if (!btn) throw new Error("按钮未找到: 查询");
        btn.click();
      };
      doQuery();
      await sleep(1000);

      const header = await waitFor(() => document.querySelector(".vxe-table--header-wrapper.body--wrapper"), "账单表头");
      const heads = [...header.querySelectorAll("th")].map((th) => th.textContent.trim());
      const billCol = heads.indexOf("账单编号");
      const statusCol = heads.indexOf("结算状态");
      if (billCol < 0 || statusCol < 0) throw new Error("表头里找不到「账单编号」或「结算状态」列");
      const readRow = () => {
        const main = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
        const tr = main && main.querySelector("tbody tr.vxe-body--row");
        if (!tr) return null;
        const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
        return { no: cells[billCol], status: cells[statusCol] };
      };
      // 页面自己的默认查询可能比我们的筛选更晚返回，所以反复查询+校验，对上了才继续
      let cur = await waitFor(readRow, "账单行");
      for (let i = 0; i < 8 && cur.no !== billNo; i++) {
        step("当前显示账单编号(" + cur.no + ")暂未匹配，重试查询…");
        doQuery();
        await sleep(1000);
        cur = readRow() || cur;
      }
      if (cur.no !== billNo) throw new Error("查询结果的账单编号(" + cur.no + ")跟要处理的账单编号(" + billNo + ")不一致，已中止");
      if (cur.status !== "待确认") throw new Error("这张账单当前状态是「" + cur.status + "」，不是「待确认」，不需要重新生成");
      step("已校验账单编号一致，状态待确认");

      const right = await waitFor(() => document.querySelector(".vxe-table--body-wrapper.fixed-right--wrapper"), "操作列");
      const row = await waitFor(() => right.querySelector("tbody tr.vxe-body--row"), "操作列的账单行");
      const link = [...row.querySelectorAll("span.link, a, button")].find((s) => s.textContent.trim() === "重新生成");
      if (!link) throw new Error("这张账单的操作列里没有「重新生成」");

      const messages = [];
      const seen = new Set();
      const collect = () =>
        document.querySelectorAll(".el-message").forEach((m) => {
          if (seen.has(m)) return;
          seen.add(m);
          const t = m.textContent.trim();
          if (t) messages.push(t);
        });
      link.click();
      step("已点击重新生成");
      await sleep(1500);

      let dialogText = "";
      const box = [...document.querySelectorAll(".el-message-box, .el-dialog")].filter(visible).pop();
      if (box) {
        dialogText = box.innerText.replace(/\s+/g, " ").trim();
        // Element Plus 的确认框里本来就带一个隐藏的输入框（用于 prompt 类型），只数看得见的输入控件
        if ([...box.querySelectorAll("input:not([type=hidden]), textarea, .el-select")].some(visible)) {
          throw new Error("重新生成弹出了需要填写内容的窗口，插件不会代填：" + dialogText.slice(0, 80));
        }
        const ok = [...box.querySelectorAll("button")].find((b) => /^(确认|确定)$/.test(b.textContent.trim()));
        if (!ok) throw new Error("重新生成弹出了窗口但找不到确认按钮：" + dialogText.slice(0, 80));
        ok.click();
        step("已点击确认：" + dialogText.slice(0, 40));
      }
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        collect();
      }
      return { ok: true, messages, dialogText, log };
    } catch (err) {
      console.error("[重新生成] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  return { BRANDS, SHOPS, findBills, generateBill, regenerateBill, listBrands };
})();

if (typeof module !== "undefined" && module.exports) module.exports = BillGen;
