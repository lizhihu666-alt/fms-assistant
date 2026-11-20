// 给假 FMS 加上「请款 → 生成费控单 → 打开费控单 → 编辑报账明细 → 上传发票 → 确认」这条链路
const fs = require("fs");
const f = __dirname + "\\app.js";
let a = fs.readFileSync(f, "utf8");
const r = (x, y) => {
  if (!a.includes(x)) throw new Error("missing " + x.slice(0, 60));
  a = a.replace(x, () => y);
};

// 配置
r("        initialBrandFilter:", "        mergeDocs: true, // 请款时同一批账单是否合并成一张费控单\n        docLines: 1, // 费控单的报账明细里「第三方品牌结算」有几行\n        docDelayMs: 600,\n        initialBrandFilter:");

// 后端：请款 / 上传发票
r(
  "  function listBills(body) {",
  `  function requestPayment(body) {
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
    log("invoice", { ajf: body.ajf, line: body.line, fileName: body.fileName });
    return { success: true, data: null };
  }

  function listBills(body) {`
);
r('    "/finance/third-party-brands/settlement/regenerate":', '    "/finance/third-party-brands/settlement/request": requestPayment,\n    "/finance/third-party-brands/expense/invoice": saveInvoice,\n    "/finance/third-party-brands/settlement/regenerate":');

// 页面：请款按钮、费控单据链接
r('<el-button type="primary">请款</el-button>', '<el-button type="primary" @click="requestSelected">请款</el-button>');
r(
  '<vxe-table :data="rows" border height="360"',
  '<vxe-table ref="tbl" :data="rows" border height="360"'
);
r(
  '<vxe-column field="documentCode" title="费控单据" width="160"></vxe-column>',
  '<vxe-column field="documentCode" title="费控单据" width="160"><template #default="{row}"><span v-if="row.documentCode" class="link" @click="openDoc(row)">{{ row.documentCode }}</span></template></vxe-column>'
);

// 费控单页面（报账申请）+ 编辑报账明细弹窗：放在账单总表之前，用 v-if 切换
r(
  '<div class="wrap">\n  <el-tabs v-model="tab">',
  `<div class="wrap" v-if="doc">
  <h4>报账申请 {{ doc.code }}</h4>
  <table border="1" cellspacing="0" cellpadding="6">
    <tr><th>费用类型</th><th>金额</th><th>操作</th></tr>
    <tr v-for="i in doc.lines" :key="i"><td>第三方品牌结算</td><td>1000</td><td><span class="link" @click="openEdit(i)">编辑</span></td></tr>
  </table>
  <el-dialog v-model="editOpen" title="报账明细" width="600px" center>
    <el-upload ref="invUp" :auto-upload="false" :limit="1" :on-change="(f) => (invFile = f.raw)"><el-button type="primary">选择附件</el-button></el-upload>
    <template #footer>
      <el-button type="primary" @click="submitInvoice">确认</el-button>
      <el-button @click="editOpen=false">取消</el-button>
    </template>
  </el-dialog>
</div>
<div class="wrap" v-else>
  <el-tabs v-model="tab">`
);

// setup：状态与方法
r("      const genOpen = ref(false);", "      const genOpen = ref(false);\n      const tbl = ref(null);\n      const doc = ref(null);\n      const editOpen = ref(false);\n      const editLine = ref(0);\n      const invUp = ref(null);\n      let invFile = null;");
r(
  "      async function regen(row) {",
  `      async function requestSelected() {
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
      function openDoc(row) {
        doc.value = { code: row.documentCode, lines: db.config.docLines };
      }
      function openEdit(i) {
        editLine.value = i;
        invFile = null;
        editOpen.value = true;
      }
      async function submitInvoice() {
        if (!invFile) return ElMessage.warning("请上传附件");
        const res = await api("/finance/third-party-brands/expense/invoice", { ajf: doc.value.code, line: editLine.value, fileName: invFile.name });
        if (res.success) {
          ElMessage.success("保存成功");
          editOpen.value = false;
        }
      }
      async function regen(row) {`
);
r("        tab, form, rows, total,", "        tbl, doc, editOpen, invUp, requestSelected, openDoc, openEdit, submitInvoice,\n        tab, form, rows, total,");
fs.writeFileSync(f, a);
console.log("patched");
