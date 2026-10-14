/**
 * 随手问辅助对话 pane 验证（2026-10-08 计划书阶段三，自闭环）：
 * spawn 自带 PI_GUI_TEST_AUX=1 的无头实例（假会话零 token 全链路）：
 * ① pane 结构 + 空态引导；② UI 发问 → 用户气泡 + 假回复气泡 + busy 按钮往返；
 * ③ 附上下文开 → 主进程收到带标记的合成 prompt；④ 每工作区隔离（auxState 双 cwd）；
 * ⑤ 插入主输入框（不自动发送）；⑥ abort（__slow__ 假会话 4s 延迟）→（已停止）；
 * ⑦ reload → aux:state 恢复历史。
 * 用法：node tests/verify-aux.mjs（自带起实例 9263 + 杀清场）
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9263;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const userData = path.join(os.tmpdir(), "pi-gui-aux-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null, logs = [];

async function main() {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd"), PI_GUI_TEST_AUX: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));
  let ok = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) { ok = true; break; } } } catch {}
    await sleep(500);
  }
  check("实例启动（无头+TEST_AUX）", ok, ok ? "" : logs.join("").slice(-300));
  if (!ok) throw new Error("CDP 未就绪");

  const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  let n = 1;
  const call = (expr, ap = false) => new Promise((res, rej) => {
    const id = n++;
    const onMsg = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) { ws.removeEventListener("message", onMsg); res(d.result?.result?.value); } } catch {} };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: ap } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 30000);
  });

  for (let i = 0; i < 30; i++) {
    const st = await call(`window.pi && window.pi.getState().then((s) => !!s && !!s.cwd).catch(() => false)`, true).catch(() => false);
    if (st === true) break;
    await sleep(1000);
  }
  const cwd = await call(`window.pi.getState().then((s) => s.cwd)`, true);

  // ① pane 结构 + 空态
  const s1 = await call(`(() => JSON.stringify({
    pane: !!document.getElementById('aux-pane'),
    msgs: !!document.getElementById('aux-msgs'),
    input: !!document.getElementById('aux-input'),
    empty: document.getElementById('aux-msgs')?.textContent.slice(0, 20) ?? ""
  }))()`);
  const o1 = JSON.parse(s1);
  check("①pane 结构齐备", o1.pane && o1.msgs && o1.input, JSON.stringify(o1));

  // ② UI 发问全链路（假会话零 token）
  await call(`(() => {
    const i = document.getElementById('aux-input');
    i.value = "这是什么来着";
    document.getElementById('aux-send').click();
    return true;
  })()`);
  let r2 = "";
  for (let i = 0; i < 12; i++) {
    await sleep(600);
    r2 = String(await call(`document.getElementById('aux-msgs')?.textContent ?? ""`));
    if (r2.includes("测试回复：OK")) break;
  }
  check("②发问 → 用户气泡 + 假回复", r2.includes("这是什么来着") && r2.includes("测试回复：OK"), r2.slice(0, 80));
  const busyBack = await call(`(() => JSON.stringify({ sendHidden: document.getElementById('aux-send').classList.contains('hidden'), stopHidden: document.getElementById('aux-stop').classList.contains('hidden') }))()`);
  check("②busy 按钮复位", busyBack === '{"sendHidden":false,"stopHidden":true}', busyBack);

  // ③ 附上下文开关：合成 prompt 带标记（经 auxState 读主进程落的消息）
  await call(`document.getElementById('aux-ctx-on').click(); true`);
  await call(`(() => {
    const i = document.getElementById('aux-input');
    i.value = "带背景的问题";
    document.getElementById('aux-send').click();
    return true;
  })()`);
  let r3 = "";
  for (let i = 0; i < 12; i++) {
    await sleep(600);
    r3 = String(await call(`window.pi.auxState(${JSON.stringify(cwd)}).then((s) => JSON.stringify(s.messages)).catch(() => "")`, true));
    if (r3.includes("带背景的问题")) break;
  }
  check("③附上下文 → 合成 prompt 带标记", r3.includes("【以下是你没有参与的主对话最近内容") && r3.includes("带背景的问题"), r3.slice(0, 100));
  const off3 = await call(`window.pi.auxState(${JSON.stringify(cwd)}).then((s) => JSON.stringify(s.messages.find((m) => m.text.includes("这是什么来着")))).catch(() => "")`, true);
  check("③关开关时不带标记（首问）", !off3.includes("【以下是你没有参与的主对话"), "首问无标记");

  // ④ 每工作区隔离：另一 cwd 应为空
  const r4 = await call(`window.pi.auxState("E:\\\\pi-gui").then((s) => JSON.stringify({ n: s.messages.length })).catch((e) => "ERR")`, true);
  check("④每工作区隔离", r4 === '{"n":0}', r4);

  // ⑤ 插入主输入框（不自动发送）
  const insBtns = Number(await call(`document.querySelectorAll('.aux-ins').length`));
  await call(`(() => { const b = [...document.querySelectorAll('.aux-ins')].pop(); b.click(); return true; })()`);
  await sleep(300);
  const mainInput = String(await call(`document.getElementById('input').value`));
  check("⑤插入主输入框", insBtns >= 2 && mainInput.includes("测试回复：OK"), `btns=${insBtns} input=${mainInput.slice(0, 30)}`);
  await call(`document.getElementById('input').value = ""; true`);

  // ⑥ abort（__slow__ 假会话 4s 延迟）
  await call(`(() => {
    const i = document.getElementById('aux-input');
    i.value = "__slow__ 慢问题";
    document.getElementById('aux-send').click();
    return true;
  })()`);
  await sleep(700);
  const busyOn = await call(`!document.getElementById('aux-stop').classList.contains('hidden')`);
  await call(`document.getElementById('aux-stop').click(); true`);
  let r6 = "";
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    r6 = String(await call(`document.getElementById('aux-msgs')?.textContent ?? ""`));
    if (r6.includes("（已停止）")) break;
  }
  check("⑥abort →（已停止）+ busy 复位", busyOn === true && r6.includes("（已停止）"), `busyOn=${busyOn}`);

  // ⑦ reload → aux:state 恢复历史
  await call(`location.reload(); true`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const ready = await call(`document.readyState === 'complete' && !!document.getElementById('input')`);
      if (ready) break;
    } catch { /* 未就绪 */ }
  }
  let r7 = "";
  for (let i = 0; i < 12; i++) {
    await sleep(800);
    r7 = String(await call(`document.getElementById('aux-msgs')?.textContent ?? ""`));
    if (r7.includes("这是什么来着")) break;
  }
  check("⑦reload 恢复历史", r7.includes("这是什么来着") && r7.includes("测试回复：OK"), r7.slice(0, 60));
}

try {
  await main();
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
