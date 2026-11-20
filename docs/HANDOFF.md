# FMS付款助手 · 交接文档

> 写给接手开发的人。先读 README 的「词表」，再读这里。架构图：`docs/architecture.html`（用浏览器打开）。
> 最后更新：2026-11-20（v0.10.34）

## 1. 项目是什么

内部用的 Chrome MV3 扩展，替财务同事在 FMS（`fms-jf.wangoon.cn`）和 EH（`admin.engagehub.tsostech.com`）两个网站上点按钮：生成账单、补结算价、重新生成、清洗对账表、上传发票请款，并跟踪付款进度。同事们拿 zip 解压后「加载已解压的扩展程序」使用（不上架商店）。

两个网站都没有给我们开放接口，所以插件的全部工作方式是**模拟人在页面上操作，并旁听页面自己发出的请求**。

## 2. 最重要的设计原则（都是有意为之，改之前先问）

1. **不读取、不使用登录凭据**。插件从不拿 Authorization / token 自己去调接口，只点页面按钮、截取页面自己请求的返回。代价是慢、代码多；好处是插件最坏也只能做「页面上本来就能做的事」。
2. **写操作只做到草稿**。请款只保存费控单草稿，永远不点「提交」。导入基础数据前一定先让人看导入文件、再确认一次。
3. **写入前做确定性检查**（`FMSBaseData.checkRows`：重复行、缺 Brand SKU、同款价差 >3 倍），有警告就停下来问人。
4. **长任务放后台**（`background.js`），状态写 `chrome.storage.local`，侧边栏关了也不丢。例外：请款第 5、6 步还在侧边栏里直接跑（历史原因，见第 8 节）。

## 3. 架构

```
侧边栏 popup.js ──发消息──▶ background.js（长任务）──withTab 打开 FMS/EH 标签页──▶ PageRun.run 注入 src/*.js 里的函数
      ▲                              │
      └──── chrome.storage.local ◀───┘（任务进度：billFillJob / matchJob / genJob / regenJob …）
```

- **注入函数**：`src/billGen.js`、`fmsSync.js`、`fmsAutomation.js`、`baseDataSync.js` 里导出的函数会被整段注入网页执行。规矩写在 `src/pageRun.js` 开头：必须自包含、MAIN world、永不抛异常、返回 `{ok, ..., log}`。所以 `waitFor`、请求钩子这类小工具在每个注入函数里各有一份——**这是技术限制，不要合并到函数外面**。
- **纯函数模块**：`baseData.js`、`cleaner.js`、`progress.js` 不碰页面，可以在 Node 里测。
- **配置**：`src/config.js` 是唯一的业务配置来源（网址、店铺、品牌、EH 渠道/商户对应、Vendor 分组、看板操作人、起始月份）。
- **`withTab(url, name, fn, {foreground, quiet})`**（background.js）：开一个临时标签页跑完就关。`foreground:true` 是因为 Element Plus / Ant Design 的下拉、弹窗依赖动画，后台标签页里浏览器会暂停 rAF，导致点了没反应——**凡是要点下拉、弹窗的都用前台**。临时标签页登记在 `TEMP_TABS`，侧边栏找「用户的 FMS 页面」时要绕开它们（否则会误刷新一个正在关闭的标签页，报「页面刷新超时」）。

### 存储键

| 键 | 内容 |
|---|---|
| `billFillJob` | 请款第 3 步补充数据的任务（v0.10.34 前叫 `baseJob`，后台启动时会自动迁移） |
| `matchJob` | 全量匹配任务。`stage`：`""` → `queried`（第一步完成，`fms` 里存着缺价行）→ `matched`；`rows` 是能补的导入行；`unresolvedList` 是补不上的完整清单 |
| `matchForm` | 基础数据页上次选的品牌、店铺、是否两步一起做 |
| `genJob` / `regenJob` | 生成账单 / 重新生成的任务 |
| `flow`、`billNo`、`genForm`、`panelTab` | 请款流程的界面状态 |
| `fmsSnapshot`、`vendorBills`、`brandList` | 付款进度快照、Vendor 下的账单、品牌下拉清单 |
| `loop*` | Loop 自动化（默认关闭） |

### 消息（侧边栏 → 后台）

`bill:generate`、`bill:regenerate`、`bill:status`、`bill:siblings`、`brands:refresh`、`vendors:refresh`、`baseData:start`（补充数据）、`baseData:import`、`match:query`（全量匹配第一步，`auto:true` 时两步连着做）、`match:resolve`（第二步）、`tabs:temp`。

## 4. 业务规则

- **状态流转**：待确认（缺基础数据）→ 补数据 → 重新生成 → 待生成请款单 → 请款 → 待请款（有费控单草稿）→ 请款审批中 → 待付款 → 已付款；另有「无需结算」。
- **FMS 请款只会合并「待生成请款单」的账单**；已经「待请款」的挂着自己的费控单，不能再并入。状态混合时插件跳过无需结算、不并入已请款的，弹窗确认后只处理待生成请款单那批。
- 报账明细的**业务发生日期**填所开月份的第一天（多张取最早月份）。
- Justfab EU 对账表概览按「结算主体 → 站点 → 品牌」展开：TechStyle GmbH（DE+NL）、TechStyle Fashion Group Ltd.（UK，FMS 站点代码 GB）、TechStyle Fashion Group S.L.（ES+FR），按币种分开合计。
- 对账表文件名 `品牌 8.01-9.30结算明细YYYYMMDD.xlsx`；多月份标范围。
- **EH 成本**：取 `Cost(Active)`，没有再取 `Base Cost(Active)`；只有 Pending 的算「还没有成本」，不补。
- **FMS 品牌 ≠ EH 商户名**，而且可能一对多（TIJN → TIJN-consignment + TIJN-drop ship；Attraco / V for City / Attraco-B / Charmo → Attraco-Drop Ship + Attraco；Ecosusi → BAGSMART）。名字互相包含的品牌（Camel / Camel Crown）必须在 `EH_MERCHANTS` 里写精确对应。
- 只有 JUSTFAB、Justfab EU 有对应的 EH 渠道；shoedazzle 等店铺不处理。
- 补数据只补「结算价为空」的行，FMS 里已有价格的行不会出现在导入文件里。

## 5. 页面自动化的坑（都踩过）

**FMS（Vue 3 + Element Plus + VXE-Table）**
- 下拉要依次派发 mousedown / mouseup / click 才认；可见性用 `getClientRects().length > 0`（后台标签页尺寸为 0）。
- 月份面板要往输入框里敲字才会弹出；VXE 固定在右侧的操作列，按行号和主表对应。
- 切换「每页条数」不一定会重新查询（当前结果少时），不能死等。
- 页面加载时的默认查询会晚返回、盖掉筛选结果，要按请求参数认自己那次的返回。

**EH（React + Ant Design）**
- Channel 下拉、Merchant 下拉都是 Ant Select。**Merchant 下拉是虚拟列表**，只渲染看得见的几项，不在搜索框输入名字就找不到后面的商户。
- **Merchant 筛选实际按单选处理**：一个品牌对应多个商户时，插件逐个商户筛选、各导出一个文件，后台合并后再匹配。
- 「Export → Records matching your search → OK」导出的是当前筛选结果，生成 `admin_pricing-<id>.csv` 任务。任务列表只在右上角下载图标的弹层**刚打开**时刷新，所以每轮都要关了重开。
- 点任务的 Download 时页面会请求 `/api/common/export/download-url` 拿到 `file.engagehub.tsostech.com` 的签名地址并下载到本机；插件拦住本机下载，只截取地址，由后台 `fetch` 回来解析（manifest 里因此有这个域名的权限）。
- EH 页面渲染大列表时主线程会卡住几十秒，`waitFor` 在超时后要再检查一次条件。

**Chrome**
- 更新（刷新）扩展会关掉侧边栏，插件无法自动重新打开（必须用户手势），所以加了快捷键 `Alt+Shift+F`。
- `chrome.storage.local.get(cb)` 回调是异步的；`popup.js` 是一个大 IIFE，`const` 声明顺序有 TDZ 风险。

## 6. 测试

- `node tests/basedata-match.test.js`：全量匹配的纯函数和后台任务（假 chrome、假注入结果、假 CSV）。
- `node tests/fake-fms/server.js` → `http://localhost:5300/fake/index.html?page=bill` → 控制台 `await __runTests()`：在模拟的 FMS 页面（真实的 Vue3 + Element Plus + VXE-Table）上跑注入函数。覆盖生成 / 重新生成 / 导入 / 请款 / 多张请款 / 发票上传 / 业务发生日期；**不覆盖**账单明细页、下载、EH。浏览器标签页必须在前台；测试之间有状态残留，单条跑比连着跑稳。
- 以上都覆盖不到真实页面的细节。**改了页面自动化，必须在真实 FMS / EH 上验证**，并在提交说明里写清楚验证了什么、没验证什么。

## 7. 和用户合作的约定

- 每次发版：升 `manifest.json` 版本 → 打 zip（`Documents/FMS付款助手_YYYYMMDD_HHmm.zip`，删旧 zip；不含 `tests/`、`docs/`、`agent-hub/`）→ 发给用户 → `git add` / commit / push。
- **界面和视觉改动先做预览**（拿虚构数据渲染给用户看），用户说「合并」后才进真实插件；功能性小修可以直接改。
- 界面文字尽量少；不要左侧色条、红色角标；用语统一（账单编号、补充数据、清洗对账）。
- 对外展示的截图一律用虚构数据，真实店铺、品牌、人名打码。
- 每次汇报都说清楚哪些没在真实 FMS / EH 上验证过。
- 尽量把几处改动攒成一版发，减少同事更新次数。

## 8. 已知的历史包袱（可以重构，但要配合真实页面验证）

- **EH 成本有两条读法**：请款第 3 步和 Loop 用 `fetchEhCosts`（在 EH 页面上逐个搜 SKU，慢）；全量匹配用 `fetchEhExportLinks`（导出，快）。可以把前者也改成导出，再删掉 `fetchEhCosts`。
- **请款第 5、6 步在侧边栏里跑**，其余长任务在后台；侧边栏关掉会打断这两步。
- `popup.js` 是 1700 行的单个 IIFE；`background.js` 混着通用工具、各功能任务和约 450 行 Loop 代码。按标签页 / 功能拆分能明显降低理解成本。
- 样式两层：`popup.css` 从 v0.9.12 起没改过，之后的外观调整都在 `theme-premium.css` 里覆盖它（当时试过几套主题）。跟踪表 `dashboard.css` 还是旧的蓝色顶部。
- `matchJob.unresolved`（文字版）和 `popup.js` 里的 `unresolvedListOf` 推算，只为兼容 v0.10.28 之前跑出的旧结果，用户重跑一次后可删。
- Loop 的服务端 `agent-hub/` 不在 git 里，没有版本记录。

## 9. 待验证 / 开放问题

- 全量匹配：已在真实页面跑通 TIJN / JUSTFAB（146 缺价，36 能补）。还没验证：justfab-eu 渠道；整个渠道级的大导出；「两步一起做」的连跑。110 个「EH 搜不到」是否属实待用户在 EH 抽查。
- FMS：重新生成是否弹确认框、多张账单合并请款后的费控单行数、多附件上限、品牌下拉滚动时的刷新品牌。
