// 假 FMS：用真实的 Vue3 + Element Plus + VXE-Table 搭出跟真实页面相同的 DOM 结构，
// 数据和后端行为（生成账单、重新生成、导入基础数据）全部在内存里模拟。
// 目的：让插件里注入 FMS 页面的脚本能在不碰真实账单的情况下反复测试。
// 模拟的行为（真实行为未验证的部分用 config 开关两种都能测）：
//   regenConfirm：点「重新生成」后是否弹确认框
//   各种延迟：生成/重新生成/导入都是异步生效，跟真实一样
(() => {
  const { createApp, ref, reactive, computed, onMounted } = Vue;
  const { ElMessage, ElMessageBox } = ElementPlus;

  // ------------------------------------------------------------------
  // 内存数据库 + 模拟后端
  // ------------------------------------------------------------------
  const STATUS_LABEL = {
    PENDING_CONFIRM: "待确认",
    PENDING_GENERATE_REQUEST: "待生成请款单",
    PENDING_REQUEST: "待请款",
    REQUEST_APPROVING: "请款审批中",
    PENDING_PAYMENT: "待付款",
    PAID: "已付款",
  };
  const BRANDS = [
    "TIJN", "Pretty Garden", "Magnlens", "Attraco", "BAGSMART", "ECOSUSI", "V for City", "Attraco-B",
    "HASHMERE", "FINEAST", "Camel Crown", "Dorina", "TouchStone", "UBRAS", "PUYONG", "SEQWL",
    "Malow London", "Where's That From", "Imily Bela", "Lahome", "SOJOS", "CAMEL", "CHARMO",
  ];
  const SHOPS = ["JUSTFAB", "shoedazzle", "Justfab EU", "Fabkids"];
  const SITES = ["US", "ES", "FR", "GB", "NL", "DE", "IE", "PL", "TR", "SE", "IT", "BE", "DK"];

  const mkBill = (no, brand, shop, month, status, extra) =>
    Object.assign(
      {
        accountingMonth: month,
        settlementNo: no,
        brandName: brand,
        brandCompany: brand,
        siteCode: "US",
        shopCode: shop,
        settlementAmount: 1000,
        currency: "USD",
        settlementStatus: status,
        documentCode: "",
        generatedTime: "2026-10-01 08:00:00",
        requestPaymentTime: "",
        operator: "Leo.Hu",
        modifyTime: "2026-10-02 08:00:00",
      },
      extra || {}
    );

  function freshDb(overrides) {
    const db = {
      config: {
        regenConfirm: true, // 点「重新生成」后弹确认框
        regenDelayMs: 600, // 重新生成要多久后状态才变
        genDelayMs: 600, // 生成账单要多久后才出现在列表
        importDelayMs: 200,
        initialQueryDelayMs: 900, // 页面加载时自己发的那次默认查询的延迟（制造「默认查询晚返回、盖掉筛选结果」的竞态）
        mergeDocs: true, // 请款时同一批账单是否合并成一张费控单
        docLines: 1, // 费控单的报账明细里「第三方品牌结算」有几行
        docDelayMs: 600,
        initialBrandFilter: "", // 页面记住的上次筛选（真实 FMS 里生成账单后会把品牌条件留下）；筛出 0 条时分页组件不显示
        brandsWithMissing: ["Attraco"], // 这些品牌生成的账单缺基础数据 → 待确认
      },
      bills: [
        mkBill("SETA0001", "Imily Bela", "JUSTFAB", "2026-08", "PENDING_GENERATE_REQUEST"),
        mkBill("SETA0002", "Imily Bela", "JUSTFAB", "2026-09", "PENDING_CONFIRM"),
        mkBill("SETA0003", "Pretty Garden", "JUSTFAB", "2026-09", "PAID", { documentCode: "AJF2026090100001" }),
        mkBill("SETA0004", "Lahome", "Justfab EU", "2026-09", "PENDING_CONFIRM", { siteCode: "DE", currency: "EUR" }),
        mkBill("SETA0005", "Dorina", "JUSTFAB", "2026-09", "PENDING_GENERATE_REQUEST"),
        mkBill("SETA0006", "Tijn", "JUSTFAB", "2026-07", "PENDING_PAYMENT", { documentCode: "AJF2026080100002" }),
        mkBill("SETA0007", "SOJOS", "JUSTFAB", "2026-09", "REQUEST_APPROVING", { documentCode: "AJF2026100100003" }),
      ],
      missing: { SETA0002: ["IB-A-S1", "IB-A-S2"], SETA0004: ["LH-1"] }, // 账单 → 缺结算价的 SKU
      baseData: [], // 已导入的 MM SKU
      log: [], // 动作日志：测试用它断言「插件到底做了什么」
      seq: 100,
    };
    const { config, ...rest } = overrides || {};
    Object.assign(db, rest);
    if (config) Object.assign(db.config, config);
    return db;
  }

  let db = freshDb();
  const log = (action, detail) => db.log.push(Object.assign({ action }, detail || {}));

  // 账单缺的 SKU 都已导入基础数据 → 重新生成后状态才会变
  function regenerate(billNo) {
    const bill = db.bills.find((b) => b.settlementNo === billNo);
    if (!bill) return { success: false, responseDesc: "账单不存在" };
    log("regenerate", { billNo });
    setTimeout(() => {
      const miss = (db.missing[billNo] || []).filter((s) => !db.baseData.includes(s));
      if (!miss.length) bill.settlementStatus = "PENDING_GENERATE_REQUEST";
      log("regenerate:done", { billNo, stillMissing: miss, status: bill.settlementStatus });
    }, db.config.regenDelayMs);
    return { success: true, data: null };
  }

  function generate(body) {
    const dup = db.bills.find(
      (b) => b.brandName === body.brand && b.shopCode === body.shop && b.accountingMonth === body.month
    );
    log("generate", { brand: body.brand, shop: body.shop, month: body.month, site: body.site || "" });
    if (dup) return { success: false, responseDesc: "该品牌/店铺/月份的账单已存在" };
    setTimeout(() => {
      const no = "SETN" + String(++db.seq).padStart(4, "0");
      const missing = db.config.brandsWithMissing.includes(body.brand);
      db.bills.unshift(mkBill(no, body.brand, body.shop, body.month, missing ? "PENDING_CONFIRM" : "PENDING_GENERATE_REQUEST"));
      if (missing) db.missing[no] = [body.brand.slice(0, 2).toUpperCase() + "-1"];
      log("generate:done", { billNo: no });
    }, db.config.genDelayMs);
    return { success: true, data: null };
  }

  function importBaseData(body) {
    log("import", { fileName: body.fileName, skus: body.skus });
    if (!body.valid) return { success: false, responseDesc: body.reason || "文件格式不正确" };
    body.skus.forEach((s) => db.baseData.push(s));
    return { success: true, data: null };
  }

  function requestPayment(body) {
    const bills = (body.nos || []).map((no) => db.bills.find((b) => b.settlementNo === no));
    if (!bills.length || bills.some((b) => !b)) return { success: false, responseDesc: "账单不存在" };
    if (bills.some((b) => b.settlementStatus !== "PENDING_GENERATE_REQUEST")) return { success: false, responseDesc: "只有「待生成请款单」的账单才能请款" };
    log("request", { nos: body.nos.slice() });
    setTimeout(() => {
      const docNo = () => "AJF" + String(++db.seq).padStart(6, "0");
      const shared = db.config.mergeDocs ? docNo() : null;
      bills.forEach((b) => {
        b.documentCode = shared || docNo();
        b.settlementStatus = "PENDING_REQUEST";
      });
      log("request:done", { docs: [...new Set(bills.map((b) => b.documentCode))] });
    }, db.config.docDelayMs);
    return { success: true, data: null };
  }

  function saveInvoice(body) {
    log("invoice", { ajf: body.ajf, line: body.line, fileName: body.fileName, fileNames: body.fileNames, bizDate: body.bizDate });
    return { success: true, data: null };
  }

  function listBills(body) {
    let rows = db.bills.slice();
    if (body.settlementNo) {
      const nos = String(body.settlementNo).split(/[\s,，]+/).filter(Boolean);
      rows = rows.filter((b) => nos.includes(b.settlementNo));
    }
    if (body.shopCode) rows = rows.filter((b) => b.shopCode === body.shopCode);
    if (body.brandName) rows = rows.filter((b) => b.brandName === body.brandName);
    if (body.accountingMonth) rows = rows.filter((b) => b.accountingMonth === body.accountingMonth);
    const total = rows.length;
    const size = body.size || 100;
    const cur = body.current || 1;
    return { success: true, data: { records: JSON.parse(JSON.stringify(rows.slice((cur - 1) * size, cur * size))), total } };
  }

  const ROUTES = {
    "/finance/third-party-brands/settlement/summary/page": listBills,
    "/finance/third-party-brands/settlement/generate": generate,
    "/finance/third-party-brands/settlement/request": requestPayment,
    "/finance/third-party-brands/expense/invoice": saveInvoice,
    "/finance/third-party-brands/settlement/regenerate": (b) => regenerate(b.settlementNo),
    "/finance/third-party-brands/base-data/import": importBaseData,
  };

  // 页面用 XMLHttpRequest 发请求（跟真实 FMS 一样），插件靠挂钩 XHR 截取页面自己的请求返回。
  class FakeXHR {
    constructor() {
      this._l = {};
      this.status = 0;
      this.responseText = "";
      this.readyState = 0;
    }
    open(method, url) {
      this._url = String(url);
    }
    setRequestHeader() {}
    addEventListener(type, fn) {
      (this._l[type] = this._l[type] || []).push(fn);
    }
    send(body) {
      const handler = ROUTES[this._url.split("?")[0]];
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch (e) {}
      const delay = this._delay != null ? this._delay : 60;
      setTimeout(() => {
        const res = handler ? handler(payload) : { success: false, responseDesc: "404 " + this._url };
        this.status = handler ? 200 : 404;
        this.responseText = JSON.stringify(res);
        this.readyState = 4;
        (this._l.load || []).forEach((f) => f.call(this));
      }, delay);
    }
  }
  window.XMLHttpRequest = FakeXHR;

  function api(url, body, delay) {
    return new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x._delay = delay;
      x.open("POST", url);
      x.addEventListener("load", () => resolve(JSON.parse(x.responseText)));
      x.send(JSON.stringify(body));
    });
  }

  // ------------------------------------------------------------------
  // 页面（Element Plus + VXE-Table，DOM 结构尽量跟真实 FMS 一致）
  // ------------------------------------------------------------------
  const BillPage = {
    template: `
<div class="wrap" v-if="doc">
  <h4>报账申请 {{ doc.code }}</h4>
  <table border="1" cellspacing="0" cellpadding="6">
    <tr><th>费用类型</th><th>金额</th><th>操作</th></tr>
    <tr v-for="i in doc.lines" :key="i"><td>第三方品牌结算</td><td>1000</td><td><span class="link" @click="openEdit(i)">编辑</span></td></tr>
  </table>
  <el-dialog v-model="editOpen" title="报账明细" width="600px" center>
    <el-form label-position="right"><el-form-item label="业务发生日期"><el-date-picker v-model="bizDate" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" /></el-form-item></el-form>
    <el-upload ref="invUp" :auto-upload="false" multiple :limit="10" :on-change="onInvChange"><el-button type="primary">选择附件</el-button></el-upload>
    <template #footer>
      <el-button type="primary" @click="submitInvoice">确认</el-button>
      <el-button @click="editOpen=false">取消</el-button>
    </template>
  </el-dialog>
</div>
<div class="wrap" v-else>
  <el-tabs v-model="tab">
    <el-tab-pane label="账单总表" name="sum"></el-tab-pane>
    <el-tab-pane label="账单明细" name="detail"></el-tab-pane>
  </el-tabs>
  <div v-show="tab==='sum'">
    <el-form :inline="true" label-position="right">
      <el-form-item label="站点"><el-select v-model="form.site" multiple clearable style="width:200px"><el-option v-for="s in sites" :key="s" :label="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="店铺"><el-select v-model="form.shopCode" clearable style="width:200px"><el-option v-for="s in shops" :key="s" :label="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="品牌"><el-select v-model="form.brandName" clearable style="width:200px"><el-option v-for="s in brands" :key="s" :label="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="账单编号"><el-input v-model="form.settlementNo" type="textarea" :rows="1" placeholder="多个账单编号使用换行符分隔" style="width:300px"/></el-form-item>
      <el-form-item label="结算月份"><el-date-picker v-model="form.accountingMonth" type="month" value-format="YYYY-MM" placeholder="请选择"/></el-form-item>
      <el-button type="primary" @click="query">查询</el-button>
      <el-button @click="reset">重置</el-button>
    </el-form>
    <div class="toolbar">
      <el-button type="primary">导出</el-button>
      <el-button type="primary" @click="requestSelected">请款</el-button>
      <el-button type="primary" @click="openGen">账单生成</el-button>
      <el-button type="primary">任务日志</el-button>
    </div>
    <vxe-table ref="tbl" :data="rows" border height="360" :row-config="{keyField:'settlementNo'}" :checkbox-config="{}">
      <vxe-column type="checkbox" width="50" fixed="left"></vxe-column>
      <vxe-column type="seq" title="序号" width="60"></vxe-column>
      <vxe-column field="settlementNo" title="账单编号" width="160"></vxe-column>
      <vxe-column field="accountingMonth" title="结算月份" width="100"></vxe-column>
      <vxe-column field="brandName" title="品牌商" width="140"></vxe-column>
      <vxe-column field="shopCode" title="店铺" width="110"></vxe-column>
      <vxe-column field="siteCode" title="站点" width="70"></vxe-column>
      <vxe-column field="settlementAmount" title="结算金额" width="110"></vxe-column>
      <vxe-column field="settlementStatus" title="结算状态" width="120"><template #default="{row}">{{ label(row.settlementStatus) }}</template></vxe-column>
      <vxe-column field="documentCode" title="费控单据" width="160"><template #default="{row}"><span v-if="row.documentCode" class="link" @click="openDoc(row)">{{ row.documentCode }}</span></template></vxe-column>
      <vxe-column field="generatedTime" title="账单生成时间" width="260"></vxe-column>
      <vxe-column field="requestPaymentTime" title="请款时间" width="260"></vxe-column>
      <vxe-column field="modifyTime" title="修改时间" width="260"></vxe-column>
      <vxe-column field="operator" title="负责人" width="260"></vxe-column>
      <vxe-column title="操作" width="170" fixed="right">
        <template #default="{row}">
          <span class="link" @click="noop">查看明细</span>
          <span class="link" v-if="row.settlementStatus==='PENDING_CONFIRM'||row.settlementStatus==='PENDING_GENERATE_REQUEST'" @click="regen(row)">重新生成</span>
        </template>
      </vxe-column>
    </vxe-table>
    <el-pagination v-if="total>0" v-model:current-page="page" :page-size="pageSize" :page-sizes="[100,500,1000]" layout="sizes, prev, pager, next, total" :total="total" @size-change="onSize" @current-change="query" style="margin-top:10px"/>
  </div>
  <div v-show="tab==='detail'">账单明细（假 FMS 未实现）</div>

  <el-dialog v-model="genOpen" title="刷新" width="700px" center draggable>
    <el-form ref="genForm" :model="gen" :rules="genRules" label-width="100px" style="width:75%;margin:20px auto">
      <el-form-item label="品牌" prop="brand"><el-select v-model="gen.brand" style="flex:1"><el-option v-for="b in brands" :key="b" :label="b" :value="b"/></el-select></el-form-item>
      <el-form-item label="站点" prop="site"><el-select v-model="gen.site" filterable clearable style="flex:1"><el-option v-for="s in sites" :key="s" :label="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="店铺" prop="shop"><el-select v-model="gen.shop" filterable style="flex:1"><el-option v-for="s in shops" :key="s" :label="s" :value="s"/></el-select></el-form-item>
      <el-form-item label="结算月份" prop="month"><el-date-picker v-model="gen.month" type="month" value-format="YYYY-MM" placeholder="请选择" style="width:100%"/></el-form-item>
    </el-form>
    <template #footer>
      <el-button type="primary" @click="submitGen">确认</el-button>
      <el-button @click="genOpen=false">取消</el-button>
    </template>
  </el-dialog>
</div>`,
    setup() {
      const tab = ref("sum");
      const form = reactive({ site: ["US"], shopCode: "", brandName: db.config.initialBrandFilter || "", settlementNo: "", accountingMonth: "" });
      const rows = ref([]);
      const total = ref(0);
      const page = ref(1);
      const pageSize = ref(100);
      const genOpen = ref(false);
      const tbl = ref(null);
      const doc = ref(null);
      const editOpen = ref(false);
      const editLine = ref(0);
      const invUp = ref(null);
      let invFiles = [];
      const bizDate = ref("2026-10-09"); // FMS 默认填请款当天
      const gen = reactive({ brand: "", site: "", shop: "", month: "" });
      const genForm = ref(null);
      const genRules = {
        brand: [{ required: true, message: "请选择品牌", trigger: "change" }],
        shop: [{ required: true, message: "请选择店铺", trigger: "change" }],
        month: [{ required: true, message: "请选择结算月份", trigger: "change" }],
      };

      async function query(delay) {
        const res = await api(
          "/finance/third-party-brands/settlement/summary/page",
          { current: page.value, size: pageSize.value, settlementNo: form.settlementNo, shopCode: form.shopCode, brandName: form.brandName, accountingMonth: form.accountingMonth },
          typeof delay === "number" ? delay : undefined
        );
        // 后返回的覆盖先返回的——跟真实页面一样，所以「默认查询晚返回」会盖掉筛选结果
        if (res.success) {
          rows.value = res.data.records;
          total.value = res.data.total;
        }
      }
      function reset() {
        Object.assign(form, { shopCode: "", brandName: "", settlementNo: "", accountingMonth: "" });
        query();
      }
      // 切换每页条数会立刻按「旧的筛选条件」查一次（真实页面的行为）
      function onSize(v) {
        pageSize.value = v;
        query();
      }
      function openGen() {
        Object.assign(gen, { brand: "", site: "", shop: "", month: "" });
        genOpen.value = true;
      }
      async function submitGen() {
        const ok = await genForm.value.validate().catch(() => false);
        if (!ok) return;
        const res = await api("/finance/third-party-brands/settlement/generate", { brand: gen.brand, site: gen.site, shop: gen.shop, month: gen.month });
        if (res.success) {
          ElMessage.success("账单生成任务已提交");
          genOpen.value = false;
        } else {
          ElMessage.error(res.responseDesc);
        }
      }
      async function requestSelected() {
        const sel = tbl.value.getCheckboxRecords();
        if (!sel.length) return ElMessage.warning("请选择账单");
        try {
          await ElMessageBox.confirm("确认对选中的 " + sel.length + " 张账单请款？", "提示", { confirmButtonText: "确定", cancelButtonText: "取消" });
        } catch (e) {
          return;
        }
        const res = await api("/finance/third-party-brands/settlement/request", { nos: sel.map((s) => s.settlementNo) });
        res.success ? ElMessage.success("请款成功，费控单生成中") : ElMessage.error(res.responseDesc);
      }
      function onInvChange(f, list) {
        invFiles = (list || [f]).map((x) => x.raw);
      }
      function openDoc(row) {
        doc.value = { code: row.documentCode, lines: db.config.docLines };
      }
      function openEdit(i) {
        editLine.value = i;
        invFiles = [];
        editOpen.value = true;
      }
      async function submitInvoice() {
        if (!invFiles.length) return ElMessage.warning("请上传附件");
        const res = await api("/finance/third-party-brands/expense/invoice", { ajf: doc.value.code, line: editLine.value, fileName: invFiles[0].name, fileNames: invFiles.map((x) => x.name), bizDate: bizDate.value });
        if (res.success) {
          ElMessage.success("保存成功");
          editOpen.value = false;
        }
      }
      async function regen(row) {
        if (db.config.regenConfirm) {
          try {
            await ElMessageBox.confirm("确认重新生成账单 " + row.settlementNo + " ？", "提示", { confirmButtonText: "确定", cancelButtonText: "取消" });
          } catch (e) {
            return;
          }
        }
        const res = await api("/finance/third-party-brands/settlement/regenerate", { settlementNo: row.settlementNo });
        res.success ? ElMessage.success("操作成功") : ElMessage.error(res.responseDesc);
      }
      onMounted(() => query(db.config.initialQueryDelayMs)); // 页面加载时自己发的默认查询，可能比后面的筛选更晚返回
      return {
        bizDate, tbl, doc, editOpen, invUp, onInvChange, requestSelected, openDoc, openEdit, submitInvoice,
        tab, form, rows, total, page, pageSize, query, reset, onSize, genOpen, gen, genForm, genRules, openGen, submitGen, regen,
        label: (s) => STATUS_LABEL[s] || s, noop() {}, sites: SITES, shops: SHOPS, brands: BRANDS,
      };
    },
  };

  const DataPage = {
    template: `
<div class="wrap">
  <h4>基础数据</h4>
  <div class="toolbar">
    <el-button type="primary">查询</el-button>
    <el-button>重置</el-button>
    <el-button type="primary" @click="open=true">导入</el-button>
    <el-button type="primary">导出</el-button>
  </div>
  <div>已导入 SKU 数：{{ n }}</div>
  <el-dialog v-model="open" title="第三方基础配置导入" width="700px" center draggable>
    <el-upload ref="up" drag :auto-upload="false" :limit="1" accept=".xlsx" :on-change="onChange" :on-exceed="onExceed">
      <div class="el-upload__text">将文件拖到此处，<em>或点击上传</em></div>
    </el-upload>
    <div style="font-size:10px">1、导入文件结果，请前往导入导出任务查看进度；2、1个文件中存在1条错误，整个文件全部导入失败</div>
    <template #footer>
      <el-button type="primary" @click="submit">确认</el-button>
      <el-button @click="open=false">取消</el-button>
    </template>
  </el-dialog>
</div>`,
    setup() {
      const open = ref(false);
      const file = ref(null);
      const up = ref(null);
      const n = ref(db.baseData.length);
      const onChange = (f) => (file.value = f.raw);
      const onExceed = (files) => {
        up.value.clearFiles();
        up.value.handleStart(files[0]);
        file.value = files[0];
      };
      function readFile(f) {
        return new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsArrayBuffer(f);
        });
      }
      async function submit() {
        if (!file.value) return ElMessage.warning("请选择要导入的文件");
        const f = file.value;
        let valid = true, reason = "", skus = [];
        try {
          const wb = XLSX.read(await readFile(f), { type: "array" });
          const ws = wb.Sheets["数据页"];
          if (!ws) throw new Error("找不到「数据页」sheet");
          const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
          if (!rows.length || !("MM SKU" in rows[0])) throw new Error("表头不对，缺少 MM SKU 列");
          skus = rows.map((r) => String(r["MM SKU"])).filter(Boolean);
        } catch (e) {
          valid = false;
          reason = "文件解析失败：" + e.message;
        }
        const res = await api("/finance/third-party-brands/base-data/import", { fileName: f.name, valid, reason, skus }, db.config.importDelayMs);
        if (res.success) {
          ElMessage.success("导入任务已提交，请前往导入导出任务查看进度");
          open.value = false;
          n.value = db.baseData.length;
        } else {
          ElMessage.error(res.responseDesc);
        }
      }
      return { open, up, n, onChange, onExceed, submit };
    },
  };

  const Root = {
    template: `<component :is="route==='data' ? 'DataPage' : 'BillPage'" :key="route + nonce"/>`,
    components: { BillPage, DataPage },
    setup() {
      const route = ref(new URLSearchParams(location.search).get("page") || "bill");
      const nonce = ref(0);
      window.__fake.goto = (p) => {
        route.value = p;
        nonce.value++; // 重建页面，等价于路由切换后重新进入
      };
      return { route, nonce };
    },
  };

  window.__fake = {
    get db() {
      return db;
    },
    reset(overrides) {
      db = freshDb(overrides);
      return db;
    },
    config(patch) {
      Object.assign(db.config, patch);
    },
    ElMessage,
  };

  const app = createApp(Root);
  app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
  app.use(VXETable);
  app.mount("#app");
})();
