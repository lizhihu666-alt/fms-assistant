# FMS付款助手

Chrome / Edge 浏览器扩展（Manifest V3），在侧边栏里把 FMS「品牌商账单」的付款流程串成一条线：生成账单 → 补充数据 → 重新生成 → 清洗对账 → 上传发票并请款；另有「付款进度」跟踪表，和「基础数据」页按品牌把 FMS 缺的结算价一次性从 EH 补齐。

> 内部工具，仅限公司内部使用，请勿外传。作者：Leo Hu
>
> **接手开发先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)**，整体架构图见 [`docs/architecture.html`](docs/architecture.html)（下载后用浏览器打开）：业务规则、架构、每个「为什么这样写」和踩过的坑都在那里。

## 功能

**请款流程**（按账单当前状态自动分叉，步骤按顺序解锁）

1. **生成账单**：按品牌，或按 Vendor（同一品牌商公司下的多个品牌一次生成），月份可多选。
2. **账单状态验证**：输入一张或多张账单编号，自动读取状态。
3. **补充数据**：账单为「待确认」（缺结算价）时，读出缺价 SKU，到 EH 查成本生成导入文件，复查后一键导入 FMS。
4. **重新生成账单**：导入后自动点「重新生成」，等待状态变化。
5. **下载并清洗对账表**：中文版和 English 两个版本；同一 Vendor 的多张账单合并成一份。
6. **上传发票并请款**：发票可多选；只保存为草稿，不会点「提交」。

**基础数据**：选品牌和店铺，① 查出 FMS 基础数据里缺结算价的 SKU，② 到 EH 导出成本并匹配，生成导入文件，一键导入。两步可分开做，也可勾选一起做。

**付款进度**：账单概况、需要处理的账单，以及完整跟踪表（`dashboard.html`）。

## 安装（未打包扩展）

1. 拿到 `FMS付款助手_日期_时间.zip` 后解压（或下载本仓库）。
2. 浏览器打开 `chrome://extensions`，打开「开发者模式」，点「加载已解压的扩展程序」，选择解压后的文件夹。
3. 点工具栏的插件图标（或按 `Alt+Shift+F`）打开侧边栏。

更新版本：用新文件覆盖旧文件夹，在 `chrome://extensions` 里点插件卡片上的刷新按钮。版本号看侧边栏右上角。

## 使用前提

- 浏览器里已登录 FMS（`fms-jf.wangoon.cn`）；补数据还需要已登录 EH（`admin.engagehub.tsostech.com`）。
- 插件会打开 FMS / EH 页面代为点击，运行期间请不要关闭这些标签页；写入类操作会短暂切到前台标签页。
- 插件只操作页面、旁听页面自己的请求，**不读取、不保存账号密码和登录令牌**。

## 词表（同一个东西在 FMS、EH、代码里叫法不同）

| 词 | 含义 |
|---|---|
| 品牌（brand / brandName） | FMS 账单上的品牌，如 TIJN、Attraco |
| 品牌商公司（brandCompany） | FMS 里品牌背后的公司；同一公司在不同店铺下编号可能不同 |
| Vendor | 付款对象 = 品牌商公司 + 店铺。公司字段不统一时，靠 `src/config.js` 的 `VENDOR_GROUPS` 手动并成一个 |
| 店铺（shop / shopCode） | FMS 的店铺：`JUSTFAB`、`Justfab EU`（还有 shoedazzle 等不处理的） |
| 站点（site / siteCode） | US、DE、GB…（EU 店铺下有多个站点） |
| Channel（EH） | EH 的渠道，对应 FMS 店铺：JUSTFAB → `justfab-us`，Justfab EU → `justfab-eu` |
| Merchant（EH） | EH 的商户，对应 FMS 品牌，但名字不同、可能一对多（TIJN → TIJN-consignment + TIJN-drop ship）。对应关系在 `src/config.js` 的 `EH_MERCHANTS` |
| 基础数据 / 结算价 | FMS「基础数据」页里每个 SKU 的结算单价。缺了账单就停在「待确认」 |
| 补充数据（billFill） | 请款第 3 步：从**一张账单**出发补它缺的结算价 |
| 全量匹配（match） | 「基础数据」页：按**品牌**把 FMS 基础数据里所有缺价的 SKU 一次补齐 |
| 成本（cost） | EH 里的商品成本，就是要搬到 FMS 的结算价。取 `Cost(Active)`，没有再取 `Base Cost(Active)` |

## 目录结构

```
manifest.json        扩展清单（权限、侧边栏入口、快捷键）
background.js        Service Worker：长任务（生成、补数据、重新生成、全量匹配、导入、Loop）在这里跑，状态存 chrome.storage.local
popup.html/js        侧边栏界面（付款进度 / 请款流程 / 基础数据 三个标签）
popup.css            基础样式；theme-premium.css 叠在它上面做外观（两层是历史原因，见 docs/HANDOFF.md）
dashboard.html/js/css  付款进度跟踪表
options.html/js      Loop 自动化的设置页（默认关闭）
src/
  config.js          业务配置：网址、店铺、品牌、EH 渠道/商户对应、Vendor 分组、看板操作人和起始月份
  pageRun.js         在网页里执行注入函数（runStep）——写注入函数的规矩在它的开头
  billGen.js         FMS：生成账单、重新生成、读品牌下拉
  fmsSync.js         FMS：读账单列表、审批链
  fmsAutomation.js   FMS：下载原始账单、请款并上传发票
  baseDataSync.js    FMS 账单缺价明细 / 基础数据缺价行 / 导入基础数据；EH 按 SKU 查成本 / 导出成本
  baseData.js        纯函数：缺价行 → 计划 → 和 EH 成本匹配 → 导入模板；EH 导出 CSV 解析
  cleaner.js         纯函数：账单清洗与对账表生成（中文 / 英文、多品牌、EU 主体/站点、多月份）
  progress.js        纯函数：付款进度、风险、催办
  monthFlow.js、loopWorker.js  Loop 自动化（默认关闭）
libs/                第三方库：ExcelJS、SheetJS
tests/               单元测试 + 假 FMS 页面（见下）
docs/HANDOFF.md      交接文档
```

## 开发

- 纯静态扩展，没有构建步骤，改完在 `chrome://extensions` 刷新即可。
- **单元测试**：`node tests/basedata-match.test.js`（全量匹配的纯函数和后台任务，用假 chrome，不连真实系统）。
- **假 FMS 页面**：`node tests/fake-fms/server.js`，打开 `http://localhost:5300/fake/index.html?page=bill`，控制台 `await __runTests()`。详见 `tests/fake-fms/README.md`。浏览器标签页必须在前台跑。
- 两种测试都覆盖不到真实 FMS / EH 的页面细节，改了页面自动化必须在真实页面上验证。
- 发版：升级 `manifest.json` 的 `version`，打 zip（不含 `tests/`、`docs/`、`agent-hub/`）。
