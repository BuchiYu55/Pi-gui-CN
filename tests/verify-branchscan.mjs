/**
 * D1 跨会话分支拾遗验证（2026-10-07 owner 拍板拓展现有分支面板）：
 *   手造多分支 jsonl fixture（v3 格式，m2 处分叉两叶）注入 sessions/--pi-gui-brfix-- →
 *   ①scanBranches({dir}) 定向扫出 1 会话 2 叶（preview 正确、active/弃用标注）
 *   ②navigateToBranch 跳弃用叶 → messages 含弃用支独有消息、不含 active 支独有消息
 *   ③（顺带）面板 UI：扫全部按钮存在（DOM 断言轻量，不真实点击导航——上面②已测链路）
 * 自闭环：独立 userData + 端口 9246；结束清 fixture。用法：node tests/verify-branchscan.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9246;
const FIX_DIR = "--pi-gui-brfix--";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture：cwd 真目录 + 多分支 jsonl ----
const fixCwd = path.join(os.tmpdir(), "pi-gui-brfix-cwd-" + Date.now());
fs.mkdirSync(fixCwd, { recursive: true });
const sessRoot = path.join(os.homedir(), ".pi/agent/sessions", FIX_DIR);
fs.mkdirSync(sessRoot, { recursive: true });
const fixFile = path.join(sessRoot, `2026-10-07T12-00-00-000Z_${randomUUID()}.jsonl`);
const lines = [
  { type: "session", version: 3, id: randomUUID(), timestamp: "2026-10-07T12:00:00.000Z", cwd: fixCwd },
  { type: "model_change", id: "e1", parentId: null, timestamp: "2026-10-07T12:00:00.000Z", provider: "zai-coding-cn", modelId: "glm-5.3-flash" },
  { type: "message", id: "m1", parentId: "e1", timestamp: "2026-10-07T12:00:01.000Z", message: { role: "user", content: "主干问题甲" } },
  { type: "message", id: "m2", parentId: "m1", timestamp: "2026-10-07T12:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "主干回答" }] } },
  { type: "message", id: "m3", parentId: "m2", timestamp: "2026-10-07T12:00:03.000Z", message: { role: "user", content: "B支问题乙" } },
  { type: "message", id: "m4", parentId: "m3", timestamp: "2026-10-07T12:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "B支回答" }] } },
  { type: "message", id: "m5", parentId: "m2", timestamp: "2026-10-07T12:00:05.000Z", message: { role: "user", content: "A支问题丙（弃用支独有）" } },
  { type: "message", id: "m6", parentId: "m5", timestamp: "2026-10-07T12:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "A支回答" }] } },
];
fs.writeFileSync(fixFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? `  [${info}]` : ""}`);
};

async function waitCDP(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) return true; }
    } catch { /* 未起 */ }
    await sleep(300);
  }
  return false;
}
async function pageEval(expr, { awaitPromise = false } = {}) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("无 page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const v = await new Promise((res, rej) => {
    const id = Date.now() % 1e6 + 1;
    ws.onmessage = (m) => {
      try { const d = JSON.parse(m.data); if (d.id === id) res(d.result?.result?.value); } catch { /* 忽略 */ }
    };
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise } }));
    setTimeout(() => rej(new Error("evaluate 超时")), 20000);
  });
  ws.close();
  return v;
}
function killInstance() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`],
      { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const pid = parseInt(line.trim(), 10);
      if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    }
  } catch { /* 已释放 */ }
}

const userData = path.join(os.tmpdir(), "pi-gui-brscan-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null;
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => {
    for (const line of String(d).split(/\r?\n/)) {
      if (line.includes("[navigateTo]") || line.includes("[session]")) console.log("  [instance]", line.trim());
    }
  });
  app.stderr.on("data", () => {});
  check("实例启动", await waitCDP());

  // ① 定向扫描 fixture 目录
  const scan = await pageEval(`window.pi.scanBranches({ dir: ${JSON.stringify(FIX_DIR)} })`, { awaitPromise: true });
  const s = (scan?.sessions ?? [])[0];
  check("①扫出 1 个多分支会话", (scan?.sessions ?? []).length === 1, `got ${(scan?.sessions ?? []).length}`);
  check("①leafCount=2", s?.leafCount === 2, String(s?.leafCount));
  const previews = (s?.leaves ?? []).map((l) => l.preview);
  check("①两叶 preview 正确（B支/A支）", previews.includes("B支问题乙") && previews.includes("A支问题丙（弃用支独有）"), previews.join("|"));
  check("①active 标注唯一", (s?.leaves ?? []).filter((l) => l.active).length === 1);

  // ② 跨会话跳转到弃用叶
  const target = (s?.leaves ?? []).find((l) => !l.active);
  check("②存在弃用叶可跳", !!target, JSON.stringify(target ?? null));
  if (target) {
    const r = await pageEval(`window.pi.navigateToBranch(${JSON.stringify(s.file)}, ${JSON.stringify(s.cwd)}, ${JSON.stringify(target.id)})`, { awaitPromise: true });
    console.log("  [diag] navigateToBranch 返回:", JSON.stringify(r).slice(0, 220));
    const texts = JSON.stringify(r?.messages ?? []);
    check("②跳转后 messages 含目标弃用支独有消息", texts.includes("B支问题乙"), "");
    check("②跳转后 messages 不含另一支独有消息", !texts.includes("A支问题丙"), "");
    check("②跳转后含主干消息", texts.includes("主干问题甲"));
  }

  // ③ 端到端：/分支 回车（本地拦截）→ 面板开+扫全部按钮 → 点扫全部 → 扫描视图 → 点弃用叶 → DOM 渲染目标分支
  const diag3 = await pageEval(`(async () => {
    const input = document.getElementById("input");
    input.value = "/分支";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
    return { hidden: document.getElementById("branch-list").classList.contains("hidden"), btn: !!document.querySelector(".branch-scan-btn") };
  })()`, { awaitPromise: true });
  check("③/分支回车打开面板+扫全部按钮", diag3?.hidden === false && diag3?.btn === true, JSON.stringify(diag3));

  if (diag3?.btn) {
    const scan3 = await pageEval(`(async () => {
      document.querySelector(".branch-scan-btn").click();
      for (let i = 0; i < 40; i++) { if (document.querySelector(".branch-scan-grp")) break; await new Promise(r => setTimeout(r, 300)); }
      const grp = document.querySelector(".branch-scan-grp");
      if (!grp) return { grp: false };
      const items = [...grp.querySelectorAll(".branch-item")];
      const target = items.find(el => el.textContent.includes("B支问题乙") && !el.classList.contains("active"));
      if (!target) return { grp: true, target: false, items: items.length };
      target.click();
      for (let i = 0; i < 40; i++) { if (document.querySelectorAll(".msg").length >= 3) break; await new Promise(r => setTimeout(r, 300)); }
      return { grp: true, target: true, msgs: document.querySelectorAll(".msg").length, preview: [...document.querySelectorAll(".msg")].map(m => m.textContent.slice(0, 10)).join("|") };
    })()`, { awaitPromise: true });
    console.log("  [diag3]", JSON.stringify(scan3));
    check("③扫描视图渲染会话组", scan3?.grp === true);
    check("③找到弃用叶可点", scan3?.target === true);
    check("③点击后 DOM 渲染目标分支（>=3 条）", (scan3?.msgs ?? 0) >= 3, String(scan3?.msgs));
    check("③目标分支含 B 支独有消息", String(scan3?.preview ?? "").includes("B支"));
  }
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app?.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  killInstance();
  try { fs.rmSync(sessRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(fixCwd, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
