// FMS "一键请款" 自动化模块 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
// 步骤函数会通过 chrome.scripting.executeScript 注入到 FMS 页面里执行，
// 运行环境是 FMS 页面本身（可以直接操作 document），不能引用这里的外部闭包变量——
// 每个注入函数必须是自包含的（所有用到的工具函数都定义在函数体内部），
// 而且必须自己 try/catch 兜底、总是返回一个普通对象——绝不能让异常抛出到
// chrome.scripting.executeScript 外面，否则拿不到任何诊断信息。

const FMSAutomation = (() => {
  const FMS_URL_PATTERN = "https://fms-jf.wangoon.cn/brand-payment/brand-bill";

  function isOnFmsBillPage(url) {
    return !!url && url.startsWith(FMS_URL_PATTERN);
  }

  /**
   * 环节一：根据账单编号，定位账单 -> 查看明细 -> 导出 -> 确认 -> 等待任务处理成功
   * -> 从"导入导出任务"列表里点下载 -> 拦截浏览器实际发起的 S3 预签名下载直链。
   *
   * 这个函数会被整体注入到 FMS 页面执行（chrome.scripting.executeScript 的 func）。
   * 返回 { ok, taskNo, downloadUrl, log, error }：
   *   - ok=true 时 taskNo/downloadUrl 有效
   *   - ok=false 时 error 是失败原因，log 是执行到哪一步的轨迹（方便排查）
   * 真正的文件字节由扩展自己的上下文 fetch(downloadUrl) 获取（FMS页面自己fetch这个S3链接
   * 会被CORS拦，扩展上下文因为在 manifest 里声明了对应 host_permissions 可以绕过）。
   *
   * 已在真实账单（SET202609170002）上手动验证过整条链路可以跑通。
   */
  async function downloadRawBillFile(billNo) {
    const log = [];
    const step = (msg) => {
      log.push(msg);
      console.log("[FMS一键请款]", msg);
    };

    try {
      function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
      }
      async function waitFor(fn, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时");
      }
      function findInputByLabel(labelText) {
        const items = [...document.querySelectorAll(".el-form-item")];
        const item = items.find((it) => {
          const lbl = it.querySelector(".el-form-item__label");
          return lbl && lbl.textContent.trim() === labelText;
        });
        return item ? item.querySelector("textarea, input") : null;
      }
      function clickVisibleButtonByText(text) {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === text && b.offsetParent !== null
        );
        if (!btn) throw new Error("按钮未找到: " + text);
        btn.click();
        return btn;
      }

      // 1. 在账单总表用账单编号筛选，点"查看明细"
      step("定位账单编号输入框");
      const input = await waitFor(() => findInputByLabel("账单编号"));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      function queryBillNo0() {
        setter.set.call(input, billNo);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        clickVisibleButtonByText("查询");
      }
      queryBillNo0();
      step("已查询账单号: " + billNo);
      await sleep(1000);

      // 安全校验：表格里显示的账单编号必须跟传入的完全一致才能继续，
      // 防止SPA页面缓存/状态没刷新导致误操作到别的账单（真实事故教训）。
      // 页面刚加载/切换过来时，FMS自己组件的初始默认查询（无筛选）有时会比我们主动点的
      // 这次"查询"更晚返回，把筛选结果盖掉——所以不是查一次就信，而是反复查询+校验，
      // 直到账单号真的对上，或者重试耗尽才报错。
      const headerWrapper0 = await waitFor(() =>
        document.querySelector(".vxe-table--header-wrapper.body--wrapper")
      );
      const headerCells0 = [...headerWrapper0.querySelectorAll("th")].map((th) => th.textContent.trim());
      const billColIdx0 = headerCells0.indexOf("账单编号");

      function readShownBillNo0() {
        const mainWrapper0 = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
        const mrow0 = mainWrapper0 && mainWrapper0.querySelector("tbody tr.vxe-body--row");
        if (!mrow0) return null;
        return [...mrow0.querySelectorAll("td")].map((td) => td.textContent.trim())[billColIdx0];
      }

      let shownBillNo = await waitFor(readShownBillNo0);
      for (let i = 0; i < 8 && shownBillNo !== billNo; i++) {
        step(`当前显示账单号(${shownBillNo})暂未匹配，重试查询…`);
        queryBillNo0();
        await sleep(1000);
        shownBillNo = readShownBillNo0();
      }
      if (shownBillNo !== billNo) {
        throw new Error(`查询结果的账单编号(${shownBillNo})跟要处理的账单号(${billNo})不一致，已中止`);
      }
      step("已校验账单编号一致: " + shownBillNo);

      const rightWrapper = await waitFor(() =>
        document.querySelector(".vxe-table--body-wrapper.fixed-right--wrapper")
      );
      const row = await waitFor(() => rightWrapper.querySelector("tbody tr.vxe-body--row"));
      const viewLink = [...row.querySelectorAll("span.link")].find(
        (s) => s.textContent.trim() === "查看明细"
      );
      if (!viewLink) throw new Error("未找到查看明细链接，账单号: " + billNo);
      viewLink.click();
      step("已点击查看明细");
      await sleep(800);

      // 2. 账单明细页：点导出 -> 弹窗确认
      clickVisibleButtonByText("导出");
      step("已点击导出");
      await sleep(300);
      clickVisibleButtonByText("确认");
      step("已点击导出弹窗的确认");

      // 3. 从"已生成导出任务编号XXX"提示里抓取任务编号
      const taskNo = await waitFor(() => {
        const notif = [...document.querySelectorAll("*")].find(
          (el) => el.children.length === 0 && /已生成导出任务编号/.test(el.textContent || "")
        );
        if (!notif) return null;
        const m = notif.textContent.match(/DC\d+/);
        return m ? m[0] : null;
      }, 8000);
      step("拿到导出任务编号: " + taskNo);

      // 4. 跳转到 任务列表 -> 导入导出任务，轮询直到该任务"处理成功"
      const taskListSpan = await waitFor(() =>
        [...document.querySelectorAll("span")].find((el) => el.textContent.trim() === "任务列表")
      );
      taskListSpan.closest("li, div[class*=menu]").click();
      await sleep(300);
      const importExportSpan = await waitFor(() =>
        [...document.querySelectorAll("span")].find((el) => el.textContent.trim() === "导入导出任务")
      );
      importExportSpan.click();
      step("已跳转到导入导出任务列表");
      await sleep(800);

      function readTaskRows() {
        const bodyWrapper = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
        return bodyWrapper
          ? [...bodyWrapper.querySelectorAll("tbody tr.vxe-body--row")]
          : [...document.querySelectorAll("tr")];
      }

      let taskRowIndex = -1;
      let taskRows = [];
      for (let i = 0; i < 20; i++) {
        taskRows = readTaskRows();
        taskRowIndex = taskRows.findIndex(
          (r) => r.textContent.includes(taskNo) && r.textContent.includes("处理成功")
        );
        if (taskRowIndex !== -1) break;
        const queryBtn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === "查询" && b.offsetParent !== null
        );
        queryBtn && queryBtn.click();
        await sleep(1000);
      }
      if (taskRowIndex === -1) throw new Error("导出任务未处理成功或未在列表中找到: " + taskNo);
      step("任务已处理成功: " + taskNo);

      // VXE Table 把"操作"这种固定在右侧的列渲染在单独的DOM子树（fixed-right--wrapper）里，
      // 跟任务编号/状态所在的主体列不是同一个<tr>（跟"查看明细"那里是同样的坑）——
      // "下载"链接在操作列，得去 fixed-right 那棵树里按同样的行号取对应行才能找到。
      const taskRightWrapper = document.querySelector(".vxe-table--body-wrapper.fixed-right--wrapper");
      const taskRightRows = taskRightWrapper
        ? [...taskRightWrapper.querySelectorAll("tbody tr.vxe-body--row")]
        : [];
      const taskRow = taskRightRows[taskRowIndex] || taskRows[taskRowIndex];
      if (!taskRow) throw new Error("找到了任务但定位不到对应的操作列行: " + taskNo);

      // 5. 点"下载"，拦截页面用 appendChild(a) 触发的 S3 预签名直链（不直接在页面里fetch，会被CORS挡）
      let capturedHref = null;
      const origAppend = Node.prototype.appendChild;
      Node.prototype.appendChild = function (child) {
        if (child && child.tagName === "A" && child.href) {
          capturedHref = child.href;
        }
        return origAppend.call(this, child);
      };
      try {
        const dlSpan = [...taskRow.querySelectorAll("span")].find((s) => s.textContent.trim() === "下载");
        if (!dlSpan) throw new Error("未找到下载按钮");
        dlSpan.click();
        await sleep(800);
      } finally {
        Node.prototype.appendChild = origAppend;
      }
      if (!capturedHref) throw new Error("未捕获到下载链接");
      step("捕获到下载直链");

      return { ok: true, taskNo, downloadUrl: capturedHref, log };
    } catch (err) {
      console.error("[FMS一键请款] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * 环节二：勾选账单 -> 请款 -> 确认 -> 等待10秒 -> 刷新查询 -> 结算状态变为"待请款"
   * -> 点费控单据链接 -> 编辑报账明细 -> 上传发票附件 -> 点确认。
   *
   * 安全红线：这个函数绝对不会点击"提交"。到"确认"为止，报账单停留在"草稿"状态，
   * 必须由人工核查后手动提交。任何情况下都不要在这个函数里加对"提交"按钮的点击。
   *
   * invoiceBase64 是发票文件的 base64 编码内容（不带 data: 前缀），由扩展的popup
   * 读取用户在插件里选的发票文件后转换传入。
   *
   * 已在真实账单（SET202609170002 / AJF2026091700012）上手动验证过整条链路可以跑通。
   */
  async function submitInvoiceAndConfirm(billNo, invoiceFileName, invoiceMimeType, invoiceBase64) {
    const log = [];
    const step = (msg) => {
      log.push(msg);
      console.log("[FMS一键请款]", msg);
    };

    try {
      function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
      }
      async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }
      function findInputByLabel(labelText) {
        const items = [...document.querySelectorAll(".el-form-item")];
        const item = items.find((it) => {
          const lbl = it.querySelector(".el-form-item__label");
          return lbl && lbl.textContent.trim() === labelText;
        });
        return item ? item.querySelector("textarea, input") : null;
      }
      function clickVisibleButtonByText(text) {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === text && b.offsetParent !== null
        );
        if (!btn) throw new Error("按钮未找到: " + text);
        btn.click();
        return btn;
      }

      // 0. 环节二总是由 popup 在调用前先把这个tab硬刷新回账单总表页（见popup.js），
      // 不依赖SPA内部导航——避免keep-alive缓存的旧页面状态导致操作到错误的账单
      // （真实事故：曾经因为这里用侧边栏点击"软"导航，缓存复用了之前测试账单的数据，
      // 结果对错误的账单点了请款）。这里只需要确认输入框确实在。

      // 1. 定位账单
      const input = await waitFor(() => findInputByLabel("账单编号"), "账单编号输入框");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      function queryBillNo() {
        setter.set.call(input, billNo);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        clickVisibleButtonByText("查询");
      }
      queryBillNo();
      step("已查询账单号: " + billNo);
      await sleep(1000);

      // 2. 读表头拿到"账单编号"/"结算状态"/"费控单据"列位置，读当前行数据——
      // 账单可能已经在之前的运行里点过请款了，不能无脑再点一次，要先判断当前处于哪个状态。
      const headerWrapper = await waitFor(
        () => document.querySelector(".vxe-table--header-wrapper.body--wrapper"),
        "账单表格表头"
      );
      const headerCells = [...headerWrapper.querySelectorAll("th")].map((th) => th.textContent.trim());
      const billColIdx = headerCells.indexOf("账单编号");
      const statusColIdx = headerCells.indexOf("结算状态");
      const feikongColIdx = headerCells.indexOf("费控单据");

      function readCurrentRow() {
        const mainWrapper = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
        const mrow = mainWrapper && mainWrapper.querySelector("tbody tr.vxe-body--row");
        if (!mrow) return null;
        const cells = [...mrow.querySelectorAll("td")].map((td) => td.textContent.trim());
        return { billNo: cells[billColIdx], status: cells[statusColIdx], ajfNo: cells[feikongColIdx] };
      }

      // 页面刚硬刷新完时，FMS自己组件的初始默认查询（无筛选，显示全部账单）有时会比
      // 我们主动点的这次"查询"更晚返回，把筛选结果盖掉——所以这里不是查一次就信，
      // 而是反复查询+校验，直到账单号真的对上，或者重试耗尽才报错（真实发生过的竞态，
      // 之前这里的安全校验曾正确拦下过一次因为这个原因导致的误判）。
      let current = readCurrentRow();
      for (let i = 0; i < 8 && (!current || current.billNo !== billNo); i++) {
        step(`当前显示账单号(${current && current.billNo})暂未匹配，重试查询…`);
        queryBillNo();
        await sleep(1000);
        current = readCurrentRow();
      }

      if (!current || current.billNo !== billNo) {
        throw new Error(`查询结果的账单编号(${current && current.billNo})跟要处理的账单号(${billNo})不一致，已中止`);
      }
      step("已校验账单编号一致，当前结算状态: " + current.status);

      let ajfNo;
      if (current.status === "待请款" && current.ajfNo) {
        // 之前已经点过请款了，直接复用已生成的费控单据，不再重复点请款
        ajfNo = current.ajfNo;
        step("账单已处于待请款状态，跳过请款步骤，复用费控单据: " + ajfNo);
      } else if (current.status === "待生成请款单") {
        // 3. 勾选该行 -> 点请款 -> 确认弹窗
        const leftWrapper = await waitFor(
          () =>
            document.querySelector(".vxe-table--body-wrapper.fixed-left--wrapper") ||
            document.querySelector(".vxe-table--body-wrapper.body--wrapper"),
          "账单列表表格"
        );
        const row = await waitFor(() => leftWrapper.querySelector("tbody tr.vxe-body--row"), "账单行");
        const checkboxSpan = row.querySelector(".vxe-cell--checkbox");
        if (!checkboxSpan) throw new Error("未找到账单勾选框");
        checkboxSpan.click();
        step("已勾选账单");
        await sleep(300);

        clickVisibleButtonByText("请款");
        step("已点击请款");
        await sleep(300);
        clickVisibleButtonByText("确定");
        step("已点击请款确认弹窗的确定");

        // 4. 等待约10秒（请款单生成中），再刷新查询，轮询直到状态变为"待请款"
        await sleep(10000);
        let statusText = "";
        for (let i = 0; i < 10; i++) {
          clickVisibleButtonByText("查询");
          await sleep(1000);
          const c = readCurrentRow();
          if (!c || c.billNo !== billNo) continue;
          statusText = c.status;
          ajfNo = c.ajfNo;
          if (statusText === "待请款" && ajfNo) break;
        }
        if (statusText !== "待请款" || !ajfNo) {
          throw new Error("请款后状态未变为待请款，当前状态: " + statusText);
        }
        step("结算状态已变为待请款，费控单据: " + ajfNo);
      } else {
        throw new Error("账单当前状态不是「待生成请款单」或「待请款」，无法自动处理，当前状态: " + current.status);
      }

      // 5. 点费控单据链接，进入查看报账申请（再校验一次账单编号，多一道保险）
      const finalRow = readCurrentRow();
      if (!finalRow || finalRow.billNo !== billNo) {
        throw new Error(`点击费控单据前再次校验失败，当前显示账单号(${finalRow && finalRow.billNo})跟要处理的账单号(${billNo})不一致`);
      }
      const mainWrapper2 = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
      const mrow2 = mainWrapper2.querySelector("tbody tr.vxe-body--row");
      const feikongCell = mrow2.querySelectorAll("td")[feikongColIdx];
      const ajfLink = feikongCell.querySelector("span.link, a");
      if (!ajfLink) throw new Error("未找到费控单据链接");
      ajfLink.click();
      step("已点击费控单据链接: " + ajfNo);
      await sleep(800);

      // 6. 等待报账申请页面加载，点报账明细里"第三方品牌结算"那一行的"编辑"
      await waitFor(
        () => [...document.querySelectorAll("span.link, a")].some((l) => l.textContent.trim() === "编辑"),
        "报账申请页面的编辑按钮"
      );
      const editLinks = [...document.querySelectorAll("span.link, a")].filter(
        (l) => l.textContent.trim() === "编辑"
      );
      const editTarget = editLinks.find(
        (l) => l.closest("tr") && l.closest("tr").textContent.includes("第三方品牌结算")
      );
      if (!editTarget) throw new Error("未找到报账明细的编辑按钮");
      editTarget.click();
      step("已点击报账明细编辑");
      await sleep(500);

      // 7. 等待编辑弹窗，把发票文件塞进弹窗内的文件输入框
      // 取所有可见且含"报账明细"的弹窗中的最后一个（最新弹出的），避免之前失败的
      // 自动化运行残留在DOM里的旧弹窗被误当成这次要操作的弹窗。
      const dialog = await waitFor(() => {
        const candidates = [...document.querySelectorAll(".el-dialog")].filter(
          (d) => d.offsetParent !== null && d.textContent.includes("报账明细")
        );
        return candidates.length ? candidates[candidates.length - 1] : null;
      }, "报账明细编辑弹窗");
      const fileInput = await waitFor(() => dialog.querySelector('input[type="file"]'), "弹窗内的文件输入框");

      const byteChars = atob(invoiceBase64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: invoiceMimeType || "application/octet-stream" });
      const file = new File([blob], invoiceFileName, { type: invoiceMimeType || "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      step("已上传发票文件: " + invoiceFileName);

      // 文件名出现在列表里 ≠ 文件真的传到服务器了——中间还有一段异步上传时间。
      // 真实发生过：文件名已经显示，但服务器还没接收完，这时候点确认导致最终附件是空的。
      // 所以要等到：文件名出现，而且列表项里再也没有"上传中/进度条/百分比"这类还在
      // 处理的迹象，且这个"已完成"状态连续两次检查（间隔1秒）都保持住，才算真的传完。
      await waitFor(() => dialog.textContent.includes(invoiceFileName), "附件出现在弹窗列表里", 15000);
      step("附件已出现在列表里，等待上传到服务器完成…");

      function attachmentStillUploading() {
        if (!dialog.textContent.includes(invoiceFileName)) return true; // 文件名都不见了，肯定没好
        if (dialog.textContent.includes("正在上传")) return true; // FMS明确提示："文件正在上传至服务器..."
        return [...dialog.querySelectorAll("*")].some((el) => {
          const cls = String(el.className || "");
          if (/uploading|progress|loading/i.test(cls)) return true;
          if (el.children.length === 0 && /^\d{1,3}\s*%$/.test(el.textContent.trim())) return true;
          return false;
        });
      }

      let stableCount = 0;
      const uploadStart = Date.now();
      while (Date.now() - uploadStart < 60000 && stableCount < 2) {
        if (attachmentStillUploading()) {
          stableCount = 0;
        } else {
          stableCount++;
        }
        await sleep(1000);
      }
      if (attachmentStillUploading()) {
        throw new Error("等待发票上传到服务器完成超时，已中止，未点击确认，请人工检查附件上传状态");
      }
      step("附件已上传完成且状态稳定，确认上传成功");

      // 8. 点"确认"——仅保存草稿。这个函数到此为止，绝不点击"提交"。
      const confirmBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "确认");
      if (!confirmBtn) throw new Error("未找到确认按钮");
      confirmBtn.click();
      step("已点击确认（草稿已保存，未提交，等待人工核查）");

      // 不要无脑相信点击成功：等待这个弹窗真的关闭/从DOM消失，才算确认生效。
      await waitFor(
        () => dialog.offsetParent === null || !document.body.contains(dialog),
        "弹窗关闭确认保存成功",
        8000
      );
      step("弹窗已关闭，确认保存成功");

      return { ok: true, ajfNo, log };
    } catch (err) {
      console.error("[FMS一键请款] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  /**
   * 环节二（多张账单版）：同一个 vendor 下的多个品牌，一起勾选 -> 请款 -> 生成一张费控单 -> 上传一份发票 -> 确认保存草稿。
   * 单张账单仍然走 submitInvoiceAndConfirm（那条链路已经在真实账单上验证过，不动它）。
   *
   * 安全红线跟单张版一样：绝对不点「提交」，只保存草稿。
   * 额外的保险：
   *  - 查询后表格里显示的账单必须跟要处理的完全一致（不多不少），否则中止——请款是按勾选的行生成费控单的，
   *    勾错一行就会把别的账单并进来；
   *  - 请款后如果 FMS 没有把它们合并成同一张费控单，中止并说明，不替用户猜怎么处理；
   *  - 报账明细里如果有多行「第三方品牌结算」，发票只附在第一行，并把行数返回，让界面提醒人工核对。
   */
  async function submitInvoiceMulti(billNos, invoiceFileName, invoiceMimeType, invoiceBase64) {
    const log = [];
    const step = (msg) => {
      log.push(msg);
      console.log("[FMS一键请款·多账单]", msg);
    };

    try {
      function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
      }
      async function waitFor(fn, label, timeoutMs = 15000, intervalMs = 200) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const v = fn();
          if (v) return v;
          await sleep(intervalMs);
        }
        throw new Error("等待超时: " + label);
      }
      function findInputByLabel(labelText) {
        const item = [...document.querySelectorAll(".el-form-item")].find((it) => {
          const lbl = it.querySelector(".el-form-item__label");
          return lbl && lbl.textContent.trim() === labelText;
        });
        return item ? item.querySelector("textarea, input") : null;
      }
      function clickVisibleButtonByText(text) {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text && b.offsetParent !== null);
        if (!btn) throw new Error("按钮未找到: " + text);
        btn.click();
        return btn;
      }

      const wanted = [...new Set(billNos)].sort();
      if (wanted.length < 2) throw new Error("多账单版至少要 2 张账单");

      // 1. 一次性查出这几张账单（账单编号框支持换行分隔多个）
      const input = await waitFor(() => findInputByLabel("账单编号"), "账单编号输入框");
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      function queryBills() {
        setter.set.call(input, wanted.join("\n"));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        clickVisibleButtonByText("查询");
      }
      queryBills();
      step("已查询账单: " + wanted.join(", "));
      await sleep(1000);

      const headerWrapper = await waitFor(() => document.querySelector(".vxe-table--header-wrapper.body--wrapper"), "账单表格表头");
      const headerCells = [...headerWrapper.querySelectorAll("th")].map((th) => th.textContent.trim());
      const billCol = headerCells.indexOf("账单编号");
      const statusCol = headerCells.indexOf("结算状态");
      const feikongCol = headerCells.indexOf("费控单据");
      if (billCol < 0 || statusCol < 0 || feikongCol < 0) throw new Error("表头里找不到「账单编号」「结算状态」「费控单据」列");

      function readRows() {
        const main = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
        if (!main) return [];
        return [...main.querySelectorAll("tbody tr.vxe-body--row")].map((tr) => {
          const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
          return { billNo: cells[billCol], status: cells[statusCol], ajfNo: cells[feikongCol] };
        });
      }
      const sameSet = (rows) => {
        const shown = rows.map((r) => r.billNo).sort();
        return shown.length === wanted.length && shown.every((b, i) => b === wanted[i]);
      };

      // 页面自己的默认查询可能更晚返回、盖掉筛选结果，所以反复查询 + 校验到「显示的正好是这几张」
      let rows = readRows();
      for (let i = 0; i < 8 && !sameSet(rows); i++) {
        step("当前显示 " + rows.length + " 行（" + rows.map((r) => r.billNo).join(",") + "）跟要处理的账单不一致，重试查询…");
        queryBills();
        await sleep(1000);
        rows = readRows();
      }
      if (!sameSet(rows)) {
        throw new Error("查询结果（" + rows.map((r) => r.billNo).join(",") + "）跟要处理的账单（" + wanted.join(",") + "）不一致，已中止");
      }
      step("已校验显示的正好是这 " + wanted.length + " 张账单");

      // 2. 判断当前状态：全部待生成请款单 → 请款；全部已待请款且同一张费控单 → 复用
      const allIn = (st) => rows.every((r) => r.status === st);
      let ajfNo = "";
      if (allIn("待请款") && rows.every((r) => r.ajfNo)) {
        const ajfs = [...new Set(rows.map((r) => r.ajfNo))];
        if (ajfs.length !== 1) throw new Error("这几张账单已经请过款，但对应了 " + ajfs.length + " 张不同的费控单（" + ajfs.join(",") + "），需要人工处理");
        ajfNo = ajfs[0];
        step("账单已处于待请款状态，复用费控单据: " + ajfNo);
      } else if (allIn("待生成请款单")) {
        const leftWrapper = await waitFor(
          () => document.querySelector(".vxe-table--body-wrapper.fixed-left--wrapper") || document.querySelector(".vxe-table--body-wrapper.body--wrapper"),
          "账单列表表格"
        );
        const leftRows = await waitFor(() => {
          const l = [...leftWrapper.querySelectorAll("tbody tr.vxe-body--row")];
          return l.length === rows.length ? l : null;
        }, "账单勾选列的行数跟账单行数一致");
        leftRows.forEach((row, i) => {
          const box = row.querySelector(".vxe-cell--checkbox");
          if (!box) throw new Error("第 " + (i + 1) + " 行未找到勾选框");
          box.click();
        });
        await sleep(400);
        const isChecked = (row) => /checked/i.test(String((row.querySelector(".vxe-cell--checkbox") || {}).className || "") + " " + String(row.className || ""));
        const checked = leftRows.filter(isChecked).length;
        if (checked !== rows.length) throw new Error("勾选后只有 " + checked + "/" + rows.length + " 行是选中状态，已中止（没有点请款）");
        step("已勾选全部 " + rows.length + " 张账单");

        clickVisibleButtonByText("请款");
        step("已点击请款");
        await sleep(300);
        clickVisibleButtonByText("确定");
        step("已点击请款确认弹窗的确定");

        // 等费控单生成，再刷新查询，直到全部变成待请款
        await sleep(10000);
        let now = [];
        for (let i = 0; i < 12; i++) {
          queryBills();
          await sleep(1200);
          now = readRows();
          if (sameSet(now) && now.every((r) => r.status === "待请款" && r.ajfNo)) break;
        }
        if (!(sameSet(now) && now.every((r) => r.status === "待请款" && r.ajfNo))) {
          throw new Error("请款后这几张账单没有全部变成待请款：" + now.map((r) => r.billNo + "=" + r.status).join("，"));
        }
        const ajfs = [...new Set(now.map((r) => r.ajfNo))];
        if (ajfs.length !== 1) {
          throw new Error("FMS 没有把这几张账单合并成一张费控单，而是生成了 " + ajfs.length + " 张（" + ajfs.join(",") + "）。已停止，没有上传发票，请人工处理");
        }
        ajfNo = ajfs[0];
        rows = now;
        step("全部变成待请款，合并成一张费控单: " + ajfNo);
      } else {
        throw new Error("这几张账单的状态不一致或不是「待生成请款单」/「待请款」：" + rows.map((r) => r.billNo + "=" + r.status).join("，"));
      }

      // 3. 点费控单据链接（再校验一次显示的还是这几张）
      if (!sameSet(readRows())) throw new Error("点击费控单据前再次校验失败：显示的账单变了，已中止");
      const main2 = document.querySelector(".vxe-table--body-wrapper.body--wrapper");
      const firstRow = main2.querySelector("tbody tr.vxe-body--row");
      const ajfLink = firstRow.querySelectorAll("td")[feikongCol].querySelector("span.link, a");
      if (!ajfLink) throw new Error("未找到费控单据链接");
      ajfLink.click();
      step("已点击费控单据链接: " + ajfNo);
      await sleep(800);

      // 4. 报账申请页：点「第三方品牌结算」那一行的编辑
      await waitFor(() => [...document.querySelectorAll("span.link, a")].some((l) => l.textContent.trim() === "编辑"), "报账申请页面的编辑按钮");
      const editLinks = [...document.querySelectorAll("span.link, a")].filter((l) => l.textContent.trim() === "编辑");
      const lines = editLinks.filter((l) => l.closest("tr") && l.closest("tr").textContent.includes("第三方品牌结算"));
      if (!lines.length) throw new Error("未找到报账明细的编辑按钮");
      step("报账明细里有 " + lines.length + " 行「第三方品牌结算」，发票附在第一行");
      lines[0].click();
      await sleep(500);

      const dialog = await waitFor(() => {
        const c = [...document.querySelectorAll(".el-dialog")].filter((d) => d.offsetParent !== null && d.textContent.includes("报账明细"));
        return c.length ? c[c.length - 1] : null;
      }, "报账明细编辑弹窗");
      const fileInput = await waitFor(() => dialog.querySelector('input[type="file"]'), "弹窗内的文件输入框");

      const byteChars = atob(invoiceBase64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: invoiceMimeType || "application/octet-stream" });
      const file = new File([blob], invoiceFileName, { type: invoiceMimeType || "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      step("已上传发票文件: " + invoiceFileName);

      await waitFor(() => dialog.textContent.includes(invoiceFileName), "附件出现在弹窗列表里", 15000);
      function attachmentStillUploading() {
        if (!dialog.textContent.includes(invoiceFileName)) return true;
        if (dialog.textContent.includes("正在上传")) return true;
        return [...dialog.querySelectorAll("*")].some((el) => {
          if (/uploading|progress|loading/i.test(String(el.className || ""))) return true;
          return el.children.length === 0 && /^\d{1,3}\s*%$/.test(el.textContent.trim());
        });
      }
      let stable = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000 && stable < 2) {
        stable = attachmentStillUploading() ? 0 : stable + 1;
        await sleep(1000);
      }
      if (attachmentStillUploading()) throw new Error("等待发票上传到服务器完成超时，已中止，未点击确认，请人工检查附件上传状态");
      step("附件已上传完成且状态稳定");

      // 5. 点「确认」——仅保存草稿，绝不点「提交」。
      const confirmBtn = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "确认");
      if (!confirmBtn) throw new Error("未找到确认按钮");
      confirmBtn.click();
      step("已点击确认（草稿已保存，未提交，等待人工核查）");
      await waitFor(() => dialog.offsetParent === null || !document.body.contains(dialog), "弹窗关闭确认保存成功", 8000);
      step("弹窗已关闭，确认保存成功");

      return { ok: true, ajfNo, lineCount: lines.length, billCount: wanted.length, log };
    } catch (err) {
      console.error("[FMS一键请款·多账单] 失败:", err);
      return { ok: false, error: (err && err.message) || String(err), log };
    }
  }

  return { FMS_URL_PATTERN, isOnFmsBillPage, downloadRawBillFile, submitInvoiceAndConfirm, submitInvoiceMulti };
})();
