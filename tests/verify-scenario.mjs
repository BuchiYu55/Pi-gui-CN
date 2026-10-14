/* 场景档位分段控件验证（2026-10-10 owner 拍板；2026-10-12 开源改造后形态：三档跟随默认模型只切档位）：
 * 断言：初始落档（默认模型 glm-5.3+high → 工作）→ 点日常/深想的档位联动与高亮（模型不变）→
 * 旁路换模型亮「自定」→ 自定跳设置中心模型页 → 模型回默认 + chips 逃生门回档。全程零 token（setModel/setThinkingLevel 不触网）。 */
const PORT = process.argv[2] || "9226";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

let ended = false;
let ws = null;
const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); if (!cond) console.log("  ✗ " + name); };

try {
  const page = await findTarget();
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  ws = sock;
  await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
  let seq = 0;
  const pending = new Map();
  sock.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res } = pending.get(m.id); pending.delete(m.id); res(m); }
  });
  function send(method, params) {
    const id = ++seq;
    return new Promise((res) => { pending.set(id, { res }); sock.send(JSON.stringify({ id, method, params })); });
  }
  async function call(expression, ap = true) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: !!ap, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error("页面表达式异常: " + JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text));
    return r.result?.result?.value;
  }
  // node 侧轮询（坑账：页面端长轮询在无头节流下永不 resolve）
  async function waitUntil(expr, desc, tries = 30, gap = 500) {
    for (let i = 0; i < tries; i++) {
      let v; try { v = await call(expr); } catch { /* 中间态 */ }
      if (v) return v;
      await sleep(gap);
    }
    throw new Error("等待超时: " + desc);
  }
  const sceneOn = (k) => `!!document.querySelector('#scene-seg .scene-btn[data-scene="${k}"].on')`;
  const sceneCustomHidden = () => `document.querySelector('#scene-seg .scene-custom').hidden`;
  const modelInfo = () => `(async()=>{const s=await window.pi.getState();return s&&s.model?s.model.provider+'|'+s.model.id+'@'+(s.thinkingLevel??"medium"):""})()`;

  // 0) 就绪：会话在 + 控件在
  await waitUntil(`(async()=>{try{return !!(await window.pi.getState()) && !!document.getElementById("scene-seg")}catch{return false}})()`, "实例就绪", 60);
  ok("分段控件在位（3+1 键）", await call(`document.querySelectorAll("#scene-seg .scene-btn").length`) === 4);
  ok("旧下拉已移除", await call(`!document.getElementById("model-select") && !document.getElementById("thinking-select")`));

  // 0.5) 重跑净化：会话模型/档位在主进程，reload 不重置——先点「工作」归位到默认模型+high（2026-10-12 改造后档位跨轮残留）
  await call(`document.querySelector('#scene-seg .scene-btn[data-scene="work"]').click()`, false);
  await waitUntil(`(async()=>{const s=await window.pi.getState();return s&&s.model&&s.model.id==="glm-5.3"&&(s.thinkingLevel??"medium")==="high"})()`, "归位：默认模型+high", 30);

  // 1) 初始态：settings 默认 glm-5.3+high → 「工作」高亮、无自定（refreshScenes 异步就绪，轮询防抢跑）
  const initModel = await call(modelInfo());
  ok("初始=默认模型 glm-5.3+high（" + initModel + "）", initModel === "zai-coding-cn|glm-5.3@high");
  await waitUntil(sceneOn("work"), "初始工作高亮（SCENES 就绪）");
  ok("初始高亮=工作", await call(sceneOn("work")));
  ok("初始无自定键", await call(sceneCustomHidden()));

  // 2) 点「日常」→ 模型不变（默认模型）+ low，高亮切换（2026-10-12 开源改造：三档只切档位不换模型）
  await call(`document.querySelector('#scene-seg .scene-btn[data-scene="chat"]').click()`, false);
  await waitUntil(`(async()=>{const s=await window.pi.getState();return s&&s.model&&s.model.id==="glm-5.3"&&(s.thinkingLevel??"medium")==="low"})()`, "日常档落地");
  ok("日常档=默认模型+low（不换模型）", true);
  await waitUntil(sceneOn("chat"), "日常高亮");
  ok("日常高亮且工作灭", await call(sceneOn("chat")) && !await call(sceneOn("work")));
  ok("日常档无自定键", await call(sceneCustomHidden()));

  // 3) 点「深想」→ 默认模型+max（若被 clamp 则回读非 max，此时应亮自定——行为一致性两态皆合法，先严格断言）
  await call(`document.querySelector('#scene-seg .scene-btn[data-scene="deep"]').click()`, false);
  await waitUntil(`(async()=>{const s=await window.pi.getState();return s&&s.model&&s.model.id==="glm-5.3"&&(s.thinkingLevel??"medium")==="max"})()`, "深想档落地");
  const deepModel = await call(modelInfo());
  if (deepModel === "zai-coding-cn|glm-5.3@max") {
    ok("深想档=glm-5.3+max", true);
    await waitUntil(sceneOn("deep"), "深想高亮");
    ok("深想高亮", await call(sceneOn("deep")));
  } else {
    ok("深想档被 clamp（实际 " + deepModel + "），亮自定", !await call(sceneCustomHidden()));
  }

  // 4) 真实旁路：设置中心模型页点 flash 行换模型（三档跟随默认模型，换模型即出档）→ 亮「自定」、三档全灭
  //    （2026-10-12 改造注：原「点低档 chip 亮自定」已不成立——low=日常档在档内，GLM 真实域三档全被占满，旁路只能走换模型）
  await call(`document.getElementById("btn-settings").click()`, false);
  await waitUntil(`!document.getElementById("settings-overlay").classList.contains("hidden")`, "设置中心打开");
  await call(`document.querySelector('.st-nav-item[data-tab="models"]').click()`, false);
  await waitUntil(`document.querySelectorAll("#st-models-list .st-model").length > 1`, "模型页渲染");
  await call(`(() => { const r = [...document.querySelectorAll('#st-models-list .st-model')].find(x => /flash/i.test(x.textContent)); if (r) r.click(); return !!r; })()`, false) && await waitUntil(`!` + sceneCustomHidden(), "自定键亮出");
  await waitUntil(`!` + sceneCustomHidden(), "自定键亮出");
  ok("旁路换模型亮自定（flash 不在默认模型三档内）", !await call(sceneCustomHidden()));
  ok("旁路换模型后三档全灭", !await call(sceneOn("work")) && !await call(sceneOn("deep")) && !await call(sceneOn("chat")));

  // 5) 点「自定」→ 设置中心模型页 + 逃生门 chips 在位
  await call(`document.getElementById("st-close").click()`, false);
  await call(`document.querySelector('#scene-seg .scene-custom').click()`, false);
  await waitUntil(`!document.getElementById("settings-overlay").classList.contains("hidden")`, "自定跳设置中心");
  ok("自定跳设置中心且 models tab active", await call(`document.querySelector('.st-nav-item[data-tab="models"].active') !== null`));
  await waitUntil(`document.querySelectorAll(".st-think-row .chip").length === 3`, "逃生门 chips 在位");
  ok("思考档逃生门 chips 在位（3 真实档：GLM 仅 low/high/max 生效）", await call(`document.querySelectorAll(".st-think-row .chip").length`) === 3);

  // 6) 逃生门：模型点回默认 glm-5.3 + chips 点「高」→ 回「工作」高亮（行显示名大小写不敏感匹配）
  await waitUntil(`(() => { const r = [...document.querySelectorAll('#st-models-list .st-model')].find(x => /^GLM-5\\.3$/i.test((x.querySelector('.st-row-name')?.textContent ?? '').trim())); if (r) { r.click(); return true; } return false; })()`, "点回默认模型行", 30);
  await waitUntil(`(async()=>{const s=await window.pi.getState();return s&&s.model&&s.model.id==="glm-5.3"})()`, "模型回默认");
  await call(`[...document.querySelectorAll('.st-think-row .chip')].find(c=>c.textContent==="高").click()`, false);
  await waitUntil(sceneOn("work"), "回工作档高亮");
  ok("chips 调档回工作档", await call(modelInfo()) === "zai-coding-cn|glm-5.3@high");

  const fails = results.filter(([, v]) => !v);
  for (const [n] of results) console.log("  ✓ " + n);
  if (fails.length) throw new Error("断言失败: " + fails.map(([n]) => n).join(" / "));
  console.log(`\n== verify-scenario：${results.length}/${results.length} 通过 ==`);
  ended = true;
} catch (err) {
  console.error("❌", err?.message ?? err);
  for (const [n, v] of results) console.log((v ? "  ✓ " : "  ✗ ") + n);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  process.exit(ended ? 0 : 2);
}
