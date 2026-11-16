// Loop 接单模块（可选，默认关闭）· Created by Leo Hu
// 内部工具，仅限公司内部使用，请勿外传。
//
// 让这个插件在后台以「接单程序」的身份连上本机的 Loop 中台（agent-autoloop）：
// 往外长轮询领活，一次只做一件，做完把回执交回去。插件不开任何端口，只往外连本机地址。
//
// 本模块自己不碰 FMS：真正干活的函数由调用方通过 handlers 传进来（事件类型 → 处理函数）。
// 不认识的事件类型一律「什么都不做」，绝不猜着执行。
// 纯逻辑、不依赖 chrome.*，fetch 等都可以注入，所以能在 Node 里直接测。

const LoopWorker = (() => {
  const uid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

  function create(opts) {
    const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
    const getSettings = opts.getSettings;
    const setStatus = opts.setStatus || (() => {});
    const handlers = opts.handlers || {};
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const waitSec = opts.waitSec == null ? 20 : opts.waitSec; // 没活时最多等这么多秒（后台脚本空闲太久会被浏览器回收，所以不要等太久）
    const heartbeatMs = opts.heartbeatMs || 15000;

    let loopRunning = false;
    let stopFlag = false;
    const active = new Map(); // run -> { cancelled }

    function explain(e) {
      const m = (e && e.message) || String(e);
      if (/Failed to fetch|NetworkError|fetch failed|ECONNREFUSED/i.test(m)) return "连不上 Loop（中台没开，或地址不对）";
      return m;
    }

    async function http(s, method, path, token, body) {
      const res = await fetchImpl(s.url.replace(/\/+$/, "") + path, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = {};
      try {
        json = text ? JSON.parse(text) : {};
      } catch (e) {
        json = { raw: text };
      }
      if (res.status === 401 || res.status === 403) throw new Error("接单密钥不对，或已被收回");
      if (!res.ok) throw new Error("Loop 返回 " + res.status + (json.error ? "：" + json.error : ""));
      return json;
    }

    async function poll(s, claim, o) {
      const capacity = o && o.capacity != null ? o.capacity : active.size ? 0 : 1;
      const wait = o && o.wait != null ? o.wait : waitSec;
      const running = [...active.keys()].join(",");
      return http(s, "GET", "/v1/work?claim=" + encodeURIComponent(claim) + "&wait=" + wait + "&running=" + running + "&capacity=" + capacity, s.key);
    }

    function markCancels(res) {
      for (const run of (res && res.cancel) || []) if (active.has(run)) active.get(run).cancelled = true;
    }

    async function handleJob(s, job) {
      const state = { cancelled: false };
      active.set(job.run, state);
      // 做事期间每隔一会儿报个到（同时问有没有要停的），不然中台会以为这一轮丢了
      const beat = setInterval(() => {
        poll(s, uid(), { wait: 0, capacity: 0 }).then(markCancels).catch(() => {});
      }, heartbeatMs);
      let result;
      try {
        try {
          await http(s, "POST", "/v1/runs/" + job.run + "/started", job.token, {});
        } catch (e) {
          // 报告「开始了」失败不影响干活，结果交回时会再核对
        }
        const ev = (job.context && job.context.events && job.context.events[0]) || {};
        // 先按事件类型找；定时触发的事件没有固定类型，就按规则名找（"rule:规则名"）。都没登记就什么都不做。
        const handler = handlers[ev.type] || handlers["rule:" + ((job.rule && job.rule.name) || "")];
        if (!handler) {
          result = { outcome: "nothing", summary: "没事可做：不认识的任务类型「" + (ev.type || "空") + "」，什么都没做" };
        } else {
          try {
            result = await handler(job, ev, { isCancelled: () => state.cancelled });
            if (state.cancelled && result && result.outcome !== "cancelled") result = { outcome: "cancelled", summary: "已按要求停止" };
          } catch (e) {
            result = { outcome: "failed", error: (e && e.message) || String(e), summary: "没跑成：" + ((e && e.message) || e) };
          }
        }
        if (!result || !result.outcome) result = { outcome: "failed", error: "处理函数没有返回结果", summary: "没跑成：处理函数没有返回结果" };
        await http(s, "POST", "/v1/runs/" + job.run + "/result", job.token, result);
      } finally {
        clearInterval(beat);
        active.delete(job.run);
      }
      return result;
    }

    async function loop() {
      if (loopRunning) return;
      loopRunning = true;
      stopFlag = false;
      let claim = null; // 响应丢了就用同一个编号再来一次，拿回的是同一份活
      let backoff = 1000;
      try {
        while (!stopFlag) {
          const s = await getSettings();
          if (!s || !s.enabled || !s.url || !s.key) {
            setStatus({ state: "off", text: "未启用", at: Date.now() });
            break;
          }
          try {
            claim = claim || uid();
            const res = await poll(s, claim);
            claim = null;
            backoff = 1000;
            markCancels(res);
            setStatus({ state: "on", text: "已连接", at: Date.now() });
            if (res.job) {
              const r = await handleJob(s, res.job);
              setStatus({ state: "on", text: "已连接，上一件：" + (r.summary || r.outcome), at: Date.now() });
            }
          } catch (e) {
            setStatus({ state: "error", text: explain(e), at: Date.now() });
            await sleep(backoff);
            backoff = Math.min(backoff * 2, 30000);
          }
        }
      } finally {
        loopRunning = false;
      }
    }

    return {
      start: () => loop(),
      stop: () => {
        stopFlag = true;
      },
      isRunning: () => loopRunning,
      // 测试用
      _handleJob: handleJob,
      _poll: poll,
    };
  }

  return { create };
})();

if (typeof module !== "undefined" && module.exports) module.exports = LoopWorker;
