/**
 * design-gate 扩展验证（2026-10-09 设计共识批次 C）：
 * 外部实例型（PI_GUI_TEST_GATE=1 由 smoke/手动起实例注入），零 token 探针式：
 * ① 扩展已加载（gate:probe 有应答）；② 作用域判定：docs/x.md✓、名称含关键词✓、代码✗、
 *    WORKLOG.md✗、wiki✗（gate 不触发面）；③ 信源段判定：有「## 信源」✓ /「## Sources」✓ / 无✗；
 * ④ 桥在位且 headless 记录+自动放行（gate:calls 可读回模拟调用）；
 * ⑤ allowlist（2026-10-10 owner 拍板四选「一直允许」）：add/has/持久化文件/clear 复原。
 * L3 verify 痕迹与真实卡片交互属 pi 二次验收人工项（见双重验收清单）。
 * 用法：PI_GUI_CDP_PORT=9223 PI_GUI_TEST_GATE=1 起无头实例后 node tests/verify-designgate.mjs 9223
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = process.argv[2] || "9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
      if (page) return page;
    } catch { /* 未就绪 */ }
    await sleep(1000);
  }
  throw new Error("CDP target 未找到");
}

const nextId = { n: 1 };
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function main() {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  const call = (expression, ap = false) =>
    new Promise((resolve, reject) => {
      const id = nextId.n++;
      const onMsg = (ev) => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.id !== id) return;
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result?.result?.value);
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: ap } }));
    });

  // 会话就绪（扩展随 resourceLoader 加载，会话建立后注册）
  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }
  await sleep(1500); // 扩展加载 grace

  const probe = (kind, arg) => call(`window.pi.gateProbe(${JSON.stringify(kind)}, ${JSON.stringify(arg)}).then((r) => JSON.stringify(r)).catch((e) => "ERR:" + e.message)`, true);

  // ① 扩展加载
  const r1 = JSON.parse(await probe("scope", "docs/a.md"));
  check("①design-gate 扩展已加载", r1.loaded === true, JSON.stringify(r1));

  // ② 作用域判定
  const cases = [
    ["E:\\proj\\docs\\玩法设计.md", true, "docs 路径"],
    ["E:\\proj\\docs\\notes\\anything.md", true, "docs 深层"],
    ["E:\\proj\\超级史莱姆-数值方案.md", true, "文件名含关键词"],
    ["docs/a.md", true, "docs 相对路径（2026-10-10 验收修）"],
    ["docsx/a.md", false, "docsx 非 docs"],
    ["E:\\proj\\src\\app.js", false, "代码"],
    ["E:\\proj\\WORKLOG.md", false, "WORKLOG"],
    ["E:\\proj\\wiki\\entities\\x.md", false, "wiki 自身"],
    ["E:\\proj\\平衡性\\plan.mjs", false, "关键词但非 md"],
  ];
  for (const [p, want, label] of cases) {
    const r = JSON.parse(await probe("scope", p));
    check(`②作用域:${label}`, r.result === want, `${p} → ${r.result}（期望 ${want}）`);
  }

  // ③ 信源段判定
  const srcCases = [
    ["# 标题\n\n## 信源\n\n| a | b |\n|---|---|\n", true, "标准信源段"],
    ["# T\n\n## Sources\n\n- url\n", true, "英文 Sources"],
    ["# 标题\n\n正文无信源\n", false, "无信源段"],
    ["文中提到信源两个字但没有标题段", false, "正文提及不算"],
  ];
  for (const [c, want, label] of srcCases) {
    const r = JSON.parse(await probe("src", c));
    check(`③信源段:${label}`, r.result === want, `→ ${r.result}`);
  }

  // ④ 桥在位 + headless 记录（经 gate:probe 无法直达桥——桥在主进程；用 gate:calls 读记录验证注册过的模拟调用）
  //    直接模拟一次：headless 下桥自动放行且 TEST_GATE 记录。经渲染端无入口，改由探针脚本预置：
  //    这里断言 gate:calls IPC 通道在位（PI_GUI_TEST_GATE 实例注册过即可）。
  const r4 = await call(`window.pi.gateCalls().then((r) => JSON.stringify(Array.isArray(r))).catch((e) => "ERR:" + e.message)`, true);
  check("④桥测试钩子通道在位（gate:calls）", r4 === "true", String(r4));

  // ⑤ allowlist（四选「一直允许」）：add → 命中 → 持久化文件真值 → clear 复原（收尾必清，防污染真实 allowlist）
  const TESTP = "E:\\proj\\docs\\allow-gate测试.md";
  await probe("allowAdd", TESTP);
  const has1 = JSON.parse(await probe("allowHas", TESTP));
  const lst = JSON.parse(await probe("allowList", ""))?.result ?? [];
  const normHit = Array.isArray(lst) && lst.some((p) => p === "e:/proj/docs/allow-gate测试.md"); // 归一化：反斜杠→正斜杠+小写
  let persistOk = false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "extensions", "design-gate-allowlist.json"), "utf8"));
    persistOk = (raw.paths ?? []).some((p) => p.includes("allow-gate测试.md"));
  } catch { /* 文件不存在 */ }
  await probe("allowClear", "");
  const has2 = JSON.parse(await probe("allowHas", TESTP));
  check("⑤allowlist 加/查/归一化/持久化/清", has1?.result === true && normHit === true && persistOk === true && has2?.result === false, JSON.stringify({ has1: has1?.result, normHit, persistOk, has2: has2?.result }));
}

async function run() {
  try {
    await main();
  } catch (err) {
    check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 250));
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
run();
