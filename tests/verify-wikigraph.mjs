/**
 * wiki 知识图谱验证（2026-10-08 owner 需求：项目框 📁/🕸 切换）：
 * ① 图谱按钮切换（wrap 可见/树隐藏/记忆）；② 真实数据出图（pi-gui wiki 9 页：mode 归属正确）；
 * ③ 点击节点 → 查看器 tab 打开该 md；④ 切回文件树。
 * 用法：node tests/verify-wikigraph.mjs（自带无头实例 9237 + TEST_CWD，零 token）
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9237;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const userData = path.join(os.tmpdir(), "pi-gui-wikigraph-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null, logs = [];
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));
  let ok = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) { ok = true; break; } } } catch {}
    await sleep(500);
  }
  check("实例启动（无头）", ok, ok ? "" : logs.join("").slice(-300));
  if (!ok) throw new Error("CDP 未就绪");

  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let n = 1;
  const call = (expr, awaitPromise = false) => new Promise((res, rej) => {
    const id = n++;
    const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener("message", onMsg); res(d.result?.result?.value); } } catch {} };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 20000);
  });

  // 会话就绪 + 登记 pi-gui 工作区（独立 userData 首次为空）
  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi.getState().then(s => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }
  await call(`window.pi.wsAdd("E:\\\\pi-gui").then(() => "ok").catch((e) => "ERR:" + e.message)`, true);
  const wsProbe = await call(`window.pi.wsList().then((r) => JSON.stringify((r.workspaces ?? []).map((w) => w.cwd))).catch((e) => "ERR:" + e.message)`, true);
  console.log("[diag] wsList:", String(wsProbe).slice(0, 200));
  await sleep(800);

  // ① 点图谱按钮 → wrap 可见、树隐藏
  await call(`document.getElementById('btn-tree-graph').click(); true`);
  let g = null;
  for (let i = 0; i < 15; i++) {
    await sleep(800);
    const v = await call(`window.__wikiGraph ? JSON.stringify(window.__wikiGraph) : null`).catch(() => null);
    if (v) { g = JSON.parse(v); break; }
  }
  const wrapVisible = await call(`!document.getElementById('wiki-graph-wrap').classList.contains('hidden')`);
  const treeHidden = await call(`document.getElementById('file-tree').classList.contains('hidden')`);
  check("①图谱视图可见 + 树隐藏", wrapVisible === true && treeHidden === true);

  // ② 真实数据：测试 cwd（钩子目录）不属于 pi-gui → 聚合总图，含 pi-gui wiki 全部页面
  const emptyText = await call(`document.getElementById('wiki-graph-empty')?.textContent ?? ""`).catch(() => "?");
  check("②聚合总图出图（8 页）", !!g && g.mode === "global" && g.count >= 8,
    g ? `mode=${g.mode} nodes=${g.count} edges=${g.edges}` : `无数据 empty="${String(emptyText).slice(0, 80)}" logs=${logs.join("").slice(-200)}`);
  check("②有链接边", !!g && g.edges >= 6, g ? String(g.edges) : "-");

  // ③ 点击节点 → 查看器打开该 md（阶段一后单击=mousedown/mouseup 且位移≤4px，钩子直接给屏幕坐标）
  const _tabs0 = Number(await call(`document.querySelectorAll('.vw-tab').length`).catch(() => 0)) || 0;
  const target = g?.nodes?.find((nd) => nd.path.endsWith("index.md")) ?? g?.nodes?.[0];
  if (target) {
    const rect = await call(`(() => { const r = document.getElementById('wiki-graph').getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top}); })()`);
    const r = JSON.parse(rect);
    const cx = r.l + target.sx, cy = r.t + target.sy;
    await call(`(() => { const c = document.getElementById('wiki-graph'); const o = { clientX: ${cx}, clientY: ${cy}, button: 0, bubbles: true }; c.dispatchEvent(new MouseEvent('mousedown', o)); c.dispatchEvent(new MouseEvent('mouseup', o)); return true; })()`);
    let opened = false, tabText = "";
    for (let i = 0; i < 8; i++) {
      await sleep(700);
      const t = await call(`(() => { const ts = [...document.querySelectorAll('.vw-tab')]; const last = ts[ts.length-1]; return last ? last.textContent : ""; })()`).catch(() => "");
      if (t) { opened = true; tabText = t; break; }
    }
    check("③点节点开查看器 tab", opened, tabText.slice(0, 30));
  } else {
    check("③点节点开查看器 tab", false, "无节点数据");
  }

  // ④ 切回树 + 记忆
  await call(`document.getElementById('btn-tree-graph').click(); true`);
  await sleep(300);
  const back = await call(`document.getElementById('file-tree').classList.contains('hidden') === false`);
  check("④切回文件树", back === true);
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 250));
} finally {
  try { app?.kill(); } catch {}
  await sleep(400);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch {}
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch {}
}
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
