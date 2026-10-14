/**
 * E1.1 间隙文本弱化验证（2026-10-11 计划书，owner 拍板形态 A=降透明度+缩字号）：
 * 同轮内位于后续 toolCall 之前的 assistant text 块挂 .md.loose；回合最终消息正常渲染。
 * ① 同消息：[text, toolCall, text] → 前弱化后正常；② 纯文本消息不弱化；
 * ③ 跨消息：text-only 消息后随工具消息 → 前者弱化；④ 新 user 消息重置判定；
 * ⑤ 历史回放（renderHistory 预扫集）：跨消息/同消息/末条三形态；⑥ CSSOM .md.loose 规则在位。
 * 零 token：全走 __testUser/__testAssistant/__testHistory 钩子，不发 prompt。
 * 用法：node tests/verify-loose.mjs [端口]（默认 9251，smoke 传独立端口）
 */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function waitCDP(port, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; }
    } catch { /* 未起 */ }
    await sleep(400);
  }
  return false;
}

async function launch(port, userData) {
  fs.mkdirSync(userData, { recursive: true });
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(port), PI_GUI_USER_DATA: userData, PI_GUI_TEST_CWD: path.join(os.tmpdir(), "pi-gui-test-cwd") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  app.stdout.on("data", (d) => logs.push(String(d)));
  app.stderr.on("data", (d) => logs.push(String(d)));
  if (!(await waitCDP(port))) throw new Error("CDP 未就绪：" + logs.join("").slice(-400));
  const list = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const page = (list ? await list() : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws open 失败")); });
  let n = 1;
  const call = (expr, awaitPromise = false) => new Promise((res, rej) => {
    const id = n++;
    const onMsg = (m) => {
      try {
        const d = JSON.parse(m.data);
        if (d.id !== id) return;
        ws.removeEventListener("message", onMsg);
        res(d.result?.result?.value);
      } catch { /* 忽略坏帧 */ }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => { ws.removeEventListener("message", onMsg); rej(new Error("evaluate 超时")); }, 20000);
  });
  return { app, call, logs };
}

async function stop(app, port, userData) {
  try { app?.kill(); } catch { /* 端口法兜底 */ }
  await sleep(400);
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 端口已释放即目标态 */ }
  await sleep(300);
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

/** 取当前 #chat 内全部 .msg-assistant 的 .md 块 loose 态（文档序） */
const MD_STATES = `(() => JSON.stringify([...document.querySelectorAll("#chat .msg-assistant .md")].map(w => w.classList.contains("loose"))))()`;

const port = parseInt(process.argv[2] ?? "9251", 10);
const ud = path.join(os.tmpdir(), "pi-gui-loose-" + Date.now());
let s = null;
try {
  s = await launch(port, ud);
  check("实例启动（端口 " + port + "）", true);

  // ① 钩子在位
  const hooks = await s.call(`JSON.stringify([typeof window.__testUser, typeof window.__testAssistant, typeof window.__testHistory])`);
  check("①__testUser/__testAssistant/__testHistory 钩子在位", hooks === JSON.stringify(["function", "function", "function"]), hooks);

  // ② 同消息 [text, toolCall, text]：前弱化后正常
  await s.call(`window.__testAssistant([
    { type: "text", text: "让我先看看这个文件。" },
    { type: "toolCall", id: "L1", toolName: "read", arguments: { path: "a.ts" } },
    { type: "text", text: "看完了，结论如下。" }
  ]); true`);
  let st = JSON.parse(await s.call(MD_STATES));
  check("②同消息前文本弱化", st[0] === true, JSON.stringify(st));
  check("②同消息末文本正常", st[1] === false, JSON.stringify(st));

  // ③ 纯文本消息不弱化
  await s.call(`window.__testAssistant([{ type: "text", text: "独立一条完整回复。" }]); true`);
  st = JSON.parse(await s.call(MD_STATES));
  check("③纯文本消息不弱化", st[2] === false, JSON.stringify(st));

  // ④ 跨消息：text-only 消息后随工具消息 → 前者弱化
  await s.call(`window.__testAssistant([{ type: "text", text: "先说一句，接下来动手。" }]); true`);
  await s.call(`window.__testAssistant([{ type: "toolCall", id: "L2", toolName: "bash", arguments: { command: "ls" } }]); true`);
  st = JSON.parse(await s.call(MD_STATES));
  check("④跨消息 text-only 被后续工具弱化", st[3] === true, JSON.stringify(st));

  // ⑤ 新 user 消息重置判定
  await s.call(`window.__testUser("新的一轮"); true`);
  await s.call(`window.__testAssistant([{ type: "text", text: "新回合的首条结论。" }]); true`);
  st = JSON.parse(await s.call(MD_STATES));
  check("⑤user 消息重置后新文本不弱化", st[4] === false, JSON.stringify(st));

  // ⑥ 历史回放（renderHistory 预扫集）：wipes chat 后重渲
  await s.call(`window.__testHistory([
    { role: "assistant", content: [{ type: "text", text: "历史间隙一。" }] },
    { role: "assistant", content: [
      { type: "text", text: "历史同消息前段。" },
      { type: "toolCall", id: "H1", toolName: "read", arguments: { path: "b.ts" } },
      { type: "text", text: "历史末条完整结论。" }
    ] },
    { role: "user", content: "继续" },
    { role: "assistant", content: [{ type: "text", text: "新回合最终答复。" }] }
  ]); true`);
  st = JSON.parse(await s.call(MD_STATES));
  check("⑥历史：跨消息 text 弱化", st[0] === true, JSON.stringify(st));
  check("⑥历史：同消息前段弱化", st[1] === true, JSON.stringify(st));
  check("⑥历史：末条正常", st[2] === false, JSON.stringify(st));
  check("⑥历史：user 后新回合正常", st[3] === false, JSON.stringify(st));

  // ⑦ CSSOM .md.loose 规则在位（cssText 读值——selectorText 读不到属性，坑账在案）
  const css = await s.call(`(() => {
    for (const sheet of document.styleSheets) {
      for (const r of sheet.cssRules ?? []) {
        if (r.cssText && r.cssText.includes(".md.loose") && r.cssText.includes("opacity")) return r.cssText;
      }
    }
    return "";
  })()`);
  check("⑦CSSOM .md.loose 规则在位（含 opacity）", css.includes("opacity"), css.slice(0, 120));
} catch (err) {
  check("脚本执行", false, String(err?.message ?? err));
} finally {
  await stop(s?.app, port, ud);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
