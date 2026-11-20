// 在网页里执行一个「注入函数」· Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 插件操作 FMS / EH 的方式：用 chrome.scripting.executeScript 把 src/ 里的某个函数整段注入页面执行，
// 由它去点按钮、选下拉、等页面自己发请求并截取返回（不读取、不使用登录凭据）。
//
// 写注入函数的规矩（违反了就会出各种怪问题）：
//  1. 必须自包含：浏览器只把函数源码拷进页面执行，函数外面的变量、import、模块里的其它函数都用不了。
//     所以 waitFor、请求钩子这类小工具在每个注入函数里都各写了一份——这是技术限制，不要合并到函数外面。
//  2. 必须在 MAIN world 执行，才能和页面自己的代码共用 XMLHttpRequest / Node 原型（截请求、触发 Vue 事件都靠这个）。
//  3. 永远不要抛异常：自己 try/catch，总是返回 { ok, ..., log }。抛出去的话这里只能拿到 undefined，没有任何诊断信息。
//  4. log 是一路记下的「执行轨迹」，出错时会拼进报错信息，排查时最有用。

const PageRun = (() => {
  async function run(tabId, func, args, label) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "MAIN" });
    const r = res && res.result;
    if (!r) throw new Error(`${label}：没有拿到页面的执行结果（可能是页面被刷新或关闭了）`);
    if (!r.ok) {
      const trace = (r.log || []).join(" → ");
      throw new Error(`${label}失败：${r.error}` + (trace ? `\n执行轨迹：${trace}` : ""));
    }
    return r;
  }
  return { run };
})();

if (typeof module !== "undefined") module.exports = PageRun;
