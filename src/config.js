// 业务配置 · Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 改品牌、店铺、EH 渠道/商户对应、Vendor 分组、看板操作人和起始月份，都只改这一个文件。
// 必须最先加载：popup.html / dashboard.html 里排在其它 src/*.js 前面，background.js 里第一个 importScripts。

const FMSConfig = (() => {
  const FMS_ORIGIN = "https://fms-jf.wangoon.cn";
  const EH_ORIGIN = "https://admin.engagehub.tsostech.com";

  return {
    // ---- 网址 ----
    FMS_ORIGIN,
    FMS_BILL_URL: FMS_ORIGIN + "/brand-payment/brand-bill", // 品牌商账单（账单列表 / 明细 / 请款都从这里进）
    FMS_BASEDATA_URL: FMS_ORIGIN + "/brand-payment/brand-data", // 基础数据（结算价）
    EH_ORIGIN,
    EH_PRICING_URL: EH_ORIGIN + "/pricing", // EH Product Pricing（成本）

    // ---- 店铺和品牌 ----
    // FMS 里的店铺（shopCode）
    SHOPS: ["JUSTFAB", "Justfab EU"],
    // 品牌下拉的默认清单；侧边栏「刷新品牌」会从 FMS 读最新的覆盖它
    BRANDS: [
      "TIJN", "Pretty Garden", "Magnlens", "Attraco", "BAGSMART", "ECOSUSI", "V for City", "Attraco-B",
      "HASHMERE", "FINEAST", "Camel Crown", "Dorina", "TouchStone", "UBRAS", "PUYONG", "SEQWL",
      "Malow London", "Where's That From", "Imily Bela", "Lahome", "SOJOS", "CAMEL", "CHARMO",
    ],

    // ---- FMS ↔ EH 对应 ----
    // FMS 店铺 → EH Channel（键是去掉大小写、空格和符号后的店铺名）。不在这里的店铺（如 shoedazzle）不去 EH 查
    SHOP_TO_CHANNEL: { justfab: "justfab-us", justfabeu: "justfab-eu" },
    // FMS 品牌 → EH Merchant（精确匹配，键同上规则）。没列在这里的品牌，按「EH 商户名包含品牌名」处理
    // （如 TIJN 会匹配 TIJN-consignment 和 TIJN-drop ship，Pretty Garden 会匹配 Pretty Garden US）。
    // 品牌名互相包含时（Camel / Camel Crown）一定要写在这里，否则会多选。
    EH_MERCHANTS: {
      attraco: ["Attraco-Drop Ship", "Attraco"],
      vforcity: ["Attraco-Drop Ship", "Attraco"],
      attracob: ["Attraco-Drop Ship", "Attraco"],
      charmo: ["Attraco-Drop Ship", "Attraco"],
      ecosusi: ["BAGSMART"],
      camel: ["Camel"],
      camelcrown: ["Camel Crown"],
    },

    // ---- 付款进度看板 ----
    MIN_MONTH: "2026-06", // 只看这个结算月及以后的账单，更早的不进看板
    // 看板只覆盖这几位操作人负责的账单
    OPERATORS: ["Leo.Hu", "Estela.Liu", "Zita.Ye", "Remy.He", "Diven.Xu"],
    // 手动指定「同一个 Vendor」：这些店铺下的这几个品牌，在「按 Vendor」视图里并成一行
    // （FMS 的品牌商公司字段没填成同一个时，靠这里补）。品牌名/店铺名不区分大小写和空格。
    VENDOR_GROUPS: [
      { shop: "Justfab EU", brands: ["Imily Bela", "Runcati"], vendor: "vendor:Justfab EU:Imily Bela+Runcati" },
      { shop: "JUSTFAB", brands: ["Runcati", "Haloumoning", "Cicy Bell", "Saodimallsu", "YOUSIFY", "Wenrine", "Aoysky", "Imily Bela"], vendor: "vendor:JUSTFAB:Runcati+Haloumoning+Cicy Bell+Saodimallsu+YOUSIFY+Wenrine+Aoysky+Imily Bela" },
    ],
  };
})();

if (typeof module !== "undefined") module.exports = FMSConfig;
