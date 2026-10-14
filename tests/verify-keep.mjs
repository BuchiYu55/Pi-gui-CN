/**
 * 压缩档工作区级覆盖验证（2026-10-09 设计共识批次 B3）：
 * ① wsSetKeep 落配置（wsList 可读）；② 覆盖档下新会话创建成功（inMemory settings 路径不炸）；
 * ③ 工作区根右键出现三档 + 当前档 ✓；④ reload 持久；⑤ 标准=清除覆盖（✓ 移到标准）。
 * 用法：PI_GUI_CDP_PORT=9223 起无头实例后 node tests/verify-keep.mjs 9223
 */
import fs from "node:fs";
import os from "node:os";
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

  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }

  const TMP = os.tmpdir().replace(/\\/g, "/") + "/pi-gui-keep-test"; // 正斜杠：绕开多层转义坑，Windows fs API 通吃
  fs.mkdirSync(TMP, { recursive: true });
  await call(`window.pi.wsAdd(${JSON.stringify(TMP)}).catch(() => "ok")`, true);

  // ① 设置保守档 → 配置可读
  await call(`window.pi.wsSetKeep(${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}, 32000).then(() => "ok").catch((e) => "ERR:" + e.message)`, true);
  const r1 = await call(`window.pi.wsList().then((c) => { const w = (c.workspaces ?? []).find((x) => x.cwd === ${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}); return JSON.stringify({ keep: w && w.compactionKeep }); }).catch((e) => "ERR:" + e.message)`, true);
  check("①wsSetKeep 落配置", r1 === '{"keep":32000}', r1);

  // 刷新树渲染（2026-10-10 验收修：原用归档按钮双击 hack 触发 renderSidebarTree，但 wsAdd 的 IPC 不刷 DOM，
  // 冷实例首树渲染未完时双击刷到的是空列表，keep-test 组永远不出现（25s 轮询耗尽假红）；reload 后 init 从 wsList 重渲染，组必在）
  await call(`location.reload(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const ready = await call(`document.readyState === "complete" && !!document.getElementById("input") && !!window.pi`);
      if (ready) break;
    } catch { /* 未就绪 */ }
  }

  // ② 覆盖档下新会话创建成功（inMemory settings 注入路径）
  const r2 = await call(`window.pi.createSession(${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}).then((s) => JSON.stringify({ ok: !!s && !!s.cwd, cwd: s && s.cwd })).catch((e) => "ERR:" + e.message)`, true);
  check("②覆盖档新会话创建成功", String(r2).includes('"ok":true'), String(r2).slice(0, 80));

  // ③ 工作区根右键三档 + ✓ 在保守（精确指向 TMP 根——第一个根可能是别的已登记工作区；轮询等树渲染完）
  let headFound = false;
  for (let i = 0; i < 50; i++) { // 2026-10-10 验收加固：冷实例树渲染在 smoke 连跑多实例下可达 10s+，轮询拉到 25s
    headFound = await call(`!!document.querySelector('#file-tree .proj-group[data-kind="ws"][data-cwd="${TMP}"] .proj-head')`);
    if (headFound === true) break;
    await sleep(500);
  }
  const disp = await call(`(() => {
    const head = document.querySelector('#file-tree .proj-group[data-kind="ws"][data-cwd="${TMP}"] .proj-head');
    if (!head) return "NO-HEAD";
    head.dispatchEvent(new MouseEvent('contextmenu', { clientX: 300, clientY: 300, bubbles: true, cancelable: true }));
    return "ok";
  })()`);
  if (disp !== "ok") {
    check("③工作区根树渲染就绪", false, "轮询 10s 未出 head（冷实例树慢）——后续菜单断言跳过");
    check("③右键三档 + ✓保守", false, "前置失败");
  } else {
    await sleep(400);
  const r3 = await call(`(() => {
    const items = [...document.querySelectorAll('#ctx-menu .ctx-item')].map((b) => b.textContent.trim());
    const keep = items.filter((t) => t.includes("压缩档"));
    return JSON.stringify({ keep, checked: keep.find((t) => t.startsWith("✓")) ?? null });
  })()`);
  const o3 = JSON.parse(r3);
  check("③右键三档 + ✓保守", o3.keep.length === 3 && /保守/.test(o3.checked ?? ""), r3);
  await call(`document.dispatchEvent(new MouseEvent('mousedown', { clientX: 1, clientY: 1, bubbles: true })); true`);
  }

  // ④ reload 持久
  await call(`location.reload(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const ready = await call(`document.readyState === 'complete' && !!document.getElementById('input')`);
      if (ready) break;
    } catch { /* 未就绪 */ }
  }
  const r4 = await call(`window.pi.wsList().then((c) => { const w = (c.workspaces ?? []).find((x) => x.cwd === ${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}); return JSON.stringify({ keep: w && w.compactionKeep }); }).catch((e) => "ERR")`, true);
  check("④reload 持久", r4 === '{"keep":32000}', r4);

  // ⑤ 标准=清除覆盖
  await call(`window.pi.wsSetKeep(${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}, null).then(() => "ok").catch(() => "ERR")`, true);
  const r5 = await call(`window.pi.wsList().then((c) => { const w = (c.workspaces ?? []).find((x) => x.cwd === ${JSON.stringify(TMP).replace(/\\\\/g, "\\\\")}); return JSON.stringify({ keep: w && (w.compactionKeep ?? null) }); }).catch((e) => "ERR")`, true);
  check("⑤标准=清除覆盖", r5 === '{"keep":null}', r5);
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
