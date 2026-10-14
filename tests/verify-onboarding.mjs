/**
 * 引导向导验证（2026-10-12 开源阶段 1）：五步全流程 + 跳过 + custom 路径。
 * 用法：PI_GUI_CDP_PORT=9225 PI_GUI_USER_DATA=<独立目录> PI_GUI_TEST_ONBOARD=1 起实例后，node verify-onboarding.mjs 9225
 * PI_GUI_TEST_ONBOARD=1：主进程 onboard:test/save 零网络零写盘（test 恒成功返回 2 模型；save 直通返回）。
 * __obShow/__obState 渲染端钩子强制唤起（实例有 zai 环境变量时 models 非空不会自动弹——钩子绕过触发检测）。
 */
const PORT = process.argv[2] || "9225";
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
  const call = (expr, ap = true) => new Promise((res, rej) => {
    const id = ++seq;
    const onMsg = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id !== id) return;
      sock.removeEventListener("message", onMsg);
      if (d.error) rej(new Error(d.error.message));
      else {
        const v = d.result?.result?.value;
        if (v === undefined && d.result?.exceptionDetails) rej(new Error("页面表达式异常: " + (d.result.exceptionDetails.exception?.description ?? "").slice(0, 200)));
        else res(v);
      }
    };
    sock.addEventListener("message", onMsg);
    sock.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: ap, returnByValue: true } }));
  });
  const waitUntil = async (expr, label, timeoutS = 20) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutS * 1000) {
      try { if (await call(expr) === true) return true; } catch { /* 重试 */ }
      await sleep(600);
    }
    throw new Error("等待超时: " + label);
  };
  const vis = () => `!document.getElementById("onboard-overlay").classList.contains("hidden")`;
  const stepShown = (n) => `!document.getElementById("ob-p${n}").classList.contains("hidden")`;

  // 0) 就绪（重跑净化：reload 重置向导状态——上轮 key 输入/选中会残留）
  await waitUntil(`(async()=>{try{return !!(await window.pi.getState()) && typeof window.__obShow === "function"}catch{return false}})()`, "实例就绪", 60);
  await call(`location.reload(); true`, false).catch(() => {});
  await sleep(2500);
  await waitUntil(`(async()=>{try{return !!(await window.pi.getState()) && typeof window.__obShow === "function"}catch{return false}})()`, "reload 后就绪", 60);

  // 1) 唤起：步骤 1 欢迎
  await call(`window.__obShow(); true`);
  ok("唤起后向导可见", await call(vis()) === true);
  ok("初始落步骤 1（欢迎）", await call(stepShown(1)) === true);
  ok("步骤条 1 为 now", await call(`document.querySelector('.ob-step[data-s="1"]').classList.contains('now')`) === true);

  // 2) 开始配置 → 步骤 2：五张卡（4 家 + custom ghost）
  await call(`document.getElementById("ob-start").click(); true`);
  ok("步骤 2（选服务商）", await call(stepShown(2)) === true);
  ok("服务商卡 5 张（4 家 + 自定义）", await call(`document.querySelectorAll('.ob-prov').length`) === 5);
  ok("custom 卡为 ghost 虚线", await call(`document.querySelector('.ob-prov[data-p="custom"]').classList.contains('ghost')`) === true);
  ok("智谱卡默认选中", await call(`document.querySelector('.ob-prov[data-p="zhipu"]').classList.contains('sel')`) === true);

  // 3) 点 DeepSeek 卡 → 步骤 3 文案跟随
  await call(`document.querySelector('.ob-prov[data-p="deepseek"]').click(); true`);
  ok("点卡后落步骤 3（获取 Key）", await call(stepShown(3)) === true);
  ok("步骤 3 标题跟随 DeepSeek", await call(`document.getElementById("ob-p3-title").textContent.includes("DeepSeek")`) === true);
  ok("三步指引在位", await call(`document.querySelectorAll('#ob-s3list .ob-s3row').length`) === 3);
  ok("注册链接指向 platform.deepseek.com", await call(`document.getElementById("ob-reg-link").href.includes("platform.deepseek.com")`) === true);
  ok("custom 的 URL 输入行隐藏（deepseek 走预置）", await call(`document.getElementById("ob-custom-url-row").classList.contains("hidden")`) === true);

  // 4) 下一步 → 步骤 4：空 key 红提示 → 填 key 测试成功（TEST 钩子恒 ok）
  await call(`document.getElementById("ob-next").click(); true`);
  ok("步骤 4（验证连通）", await call(stepShown(4)) === true);
  await call(`document.getElementById("ob-testbtn").click(); true`);
  ok("空 Key 测试 → 红提示", await call(`document.getElementById("ob-testout").className === "ob-testout bad"`) === true);
  await call(`document.getElementById("ob-keyinput").value = "sk-test-12345678"; true`);
  await call(`document.getElementById("ob-testbtn").click(); true`);
  await waitUntil(`document.getElementById("ob-testout").className === "ob-testout ok"`, "测试成功绿提示");
  ok("测试成功绿提示 + 计数", await call(`document.getElementById("ob-testout").textContent.includes("检测到 2 个模型")`) === true);
  ok("通过后 next 亮出", await call(`!document.getElementById("ob-next").classList.contains("hidden")`) === true);

  // 5) 选默认模型 → 完成（TEST 钩子 save 直通不写盘）
  await call(`document.getElementById("ob-next").click(); true`);
  ok("步骤 5（选模型）", await call(stepShown(5)) === true);
  ok("DeepSeek 预置 2 模型", await call(`document.querySelectorAll('#ob-modelist .ob-mrow').length`) === 2);
  await call(`document.querySelectorAll('#ob-modelist .ob-mrow')[1].click(); true`);
  ok("选中切换到第二模型", await call(`document.querySelectorAll('#ob-modelist .ob-mrow')[1].classList.contains('sel')`) === true);
  await call(`document.getElementById("ob-next").click(); true`);
  await waitUntil(stepShown(6), "落步骤 6 完成页");
  ok("步骤 6 完成页文案含所选模型 id", await call(`document.getElementById("ob-fin-sub").textContent.includes("deepseek-reasoner")`) === true);
  await call(`document.getElementById("ob-finish").click(); true`);
  ok("进入主界面 → 向导隐藏", await call(`document.getElementById("onboard-overlay").classList.contains("hidden")`) === true);

  // 6) 跳过路径
  await call(`window.__obShow(); true`);
  await call(`document.getElementById("ob-skip").click(); true`);
  ok("跳过 → 向导隐藏", await call(`document.getElementById("onboard-overlay").classList.contains("hidden")`) === true);

  // 7) custom 路径：URL 输入行显示 + TEST 返回 ids 填模型列表
  await call(`window.__obShow(); true`);
  await call(`document.getElementById("ob-start").click(); true`);
  await call(`document.querySelector('.ob-prov[data-p="custom"]').click(); true`);
  ok("custom：落步骤 3", await call(stepShown(3)) === true);
  await call(`document.getElementById("ob-next").click(); true`);
  ok("custom：步骤 4 显示 URL 输入行", await call(`!document.getElementById("ob-custom-url-row").classList.contains("hidden")`) === true);
  await call(`document.getElementById("ob-baseurl").value = "https://demo.example.com/v1"; true`);
  ok("custom：无地址测试 → 红提示（含地址要求）", await call(`(async()=>{document.getElementById("ob-baseurl").value=""; document.getElementById("ob-keyinput").value="k"; document.getElementById("ob-testbtn").click(); await new Promise(r=>setTimeout(r,300)); return document.getElementById("ob-testout").textContent.includes("API 地址")})()`) === true);
  await call(`document.getElementById("ob-baseurl").value = "https://demo.example.com/v1"; true`);
  await call(`document.getElementById("ob-keyinput").value = "sk-custom-123456"; true`);
  await call(`document.getElementById("ob-testbtn").click(); true`);
  await waitUntil(`document.getElementById("ob-testout").className === "ob-testout ok"`, "custom 测试成功");
  await call(`document.getElementById("ob-next").click(); true`);
  ok("custom：模型列表来自端点返回（2 项）", await call(`document.querySelectorAll('#ob-modelist .ob-mrow').length`) === 2);
  ok("custom：首项为 demo-model-a", await call(`document.querySelector('#ob-modelist .ob-mrow .mn').textContent`) === "demo-model-a");

  const fails = results.filter(([, v]) => !v);
  for (const [n, v] of results) console.log((v ? "  ✓ " : "  ✗ ") + n);
  if (fails.length) throw new Error("断言失败: " + fails.map(([n]) => n).join(" / "));
  console.log(`\n== verify-onboarding：${results.length}/${results.length} 通过 ==`);
  ended = true;
} catch (err) {
  console.error("❌", err?.message ?? err);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 已关 */ }
  setTimeout(() => process.exit(ended ? 0 : 2), 100);
}
