/**
 * 阶段化状态提示验证（2026-10-07）：doPrompt→agent_start→流式接管 的占位生命周期
 * 架构教训（两次实测踩坑）：页面端长驻 IIFE 轮询在冻结/后台窗口永不 resolve，
 * node 端 awaitPromise 干等到 bash 超时。正确姿势 = 轮询全在 node 侧，
 * 页面只执行一次性短表达式（evaluate 走 Inspector 通道，不受页面冻结影响）。
 *
 * 用法：PI_GUI_CDP_PORT=9225 PI_GUI_USER_DATA=... npm start &  →  node verify-phase.mjs 9225
 * 会真实发送一条极短消息（"1+1"，token 成本可忽略；PI_GUI_AUTOTEST 同例）
 */
const PORT = process.argv[2] || "9225";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/i.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId; // CDP 命令 id 必须整数（2026-10-06 坑②）
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/** 短表达式探针：绝不 awaitPromise（防页面冻结挂死 node 端）；返回值带异常捕获 */
async function probe(expr) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: false,
  });
  if (exceptionDetails) throw new Error("页面表达式异常: " + (exceptionDetails.text ?? ""));
  return result?.value;
}

const PROBE_STATE = `(() => {
  const p = document.querySelector("#phase-hint .phase-label");
  return JSON.stringify({
    phase: p ? p.textContent : null,
    has: !!document.querySelector("#phase-hint"),
    idle: document.querySelector("#status-dot") ? document.querySelector("#status-dot").classList.contains("idle") : null,
    asst: (document.querySelector(".msg-assistant .bubble") || { textContent: "" }).textContent.trim().length,
    chip: !!document.querySelector(".turn-chip"),
    userN: document.querySelectorAll(".msg-user").length,
  });
})()`;

async function main() {
  const target = await findTarget();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
    }
  };
  await send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});

  const r = { phaseAppeared: false, sawPrep: false, sawWait: false, gone: false, assistantCame: false, idleAgain: false };
  const t0 = Date.now();

  // 0. 干净起点：新会话，等 #welcome（视图重建完成信号）——盲等定长会被清 input 时序咬尾（实测踩坑）
  await probe(`(function(){const b=document.querySelector("#btn-new-session");if(b)b.click();return "clicked"})()`);
  let welcome = false;
  for (let i = 0; i < 75 && !welcome; i++) { await sleep(200); welcome = !!(await probe(`!!document.querySelector("#welcome")`)); }
  if (!welcome) throw new Error("新会话后 #welcome 未出现（15s）");

  // 1. 发送
  const SENT = `(function(){const i=document.querySelector("#input");i.value="1+1=? 只回答阿拉伯数字";`
    + `i.dispatchEvent(new Event("input",{bubbles:true}));`
    + `document.querySelector("#btn-send").click();return "sent"})()`;
  await probe(SENT);

  // 2. node 侧轮询状态机：抓 prep/wait → 等占位消失（上限 200s，glm-5.3 max 思考首响应慢）
  let settled = false;
  for (let i = 0; i < 1000 && !settled; i++) {
    await sleep(200);
    let st = {};
    try { st = JSON.parse(await probe(PROBE_STATE) ?? "{}"); } catch { /* 探针抖动，用空态重试 */ }
    if (st.phase) {
      r.phaseAppeared = true;
      if (String(st.phase).includes("准备")) r.sawPrep = true;
      if (String(st.phase).includes("等待响应")) r.sawWait = true;
    }
    if (!st.has) {
      if (r.phaseAppeared) settled = true;          // 占位出现后又消失 = 生命周期走完
      else if (Date.now() - t0 > 8000) throw new Error("发送后 8s 占位从未出现（send 未生效？userN=" + st.userN + "）");
    }
    if (Date.now() - t0 > 200000) throw new Error("200s 占位未撤除（模型首响应超时，phase=" + st.phase + "）");
  }

  // 3. 终态：assistant 内容接管 + 状态还原（等 settled 后再给 2s 缓冲收尾）
  await sleep(2000);
  let fin = {};
  try { fin = JSON.parse(await probe(PROBE_STATE) ?? "{}"); } catch { /* 同上 */ }
  r.assistantCame = fin.asst > 0 || fin.chip;
  r.idleAgain = fin.idle === true;

  let fail = 0;
  const check = (name, ok, detail = "") => {
    console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  — " + detail : ""));
    if (!ok) fail++;
  };
  check("A. 发送后阶段占位出现", r.phaseAppeared);
  check("B. 抓到 agent_start 后的「等待响应」阶段", r.sawWait);
  console.log(`INFO  本地「准备上下文」阶段采样${r.sawPrep ? "命中" : "未命中（本地段过短属正常，不计失败）"}`);
  check("C. 占位最终撤除且无残留", !fin.has);
  check("D. assistant 内容实际接管（非报错撤除）", r.assistantCame, "asstLen=" + fin.asst + " chip=" + fin.chip);
  check("E. 回合结束状态还原空闲", r.idleAgain);
  console.log(`INFO  全程 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  ws.close();
  console.log(fail === 0 ? "\n全部通过 ✓" : `\n${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("验证失败:", e.message); process.exit(1); });
