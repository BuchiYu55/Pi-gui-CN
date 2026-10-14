/**
 * 每周插件精选验证（2026-10-08 owner 拍板：双源周榜）：
 *   ①pkg:weekly IPC：真抓 pi.dev（默认页+sort=date）+ GitHub 高星 → 结构断言
 *     （items≤10、score 降序、source∈{community,github}、week=2026-Wxx、reason 非空）
 *   ②含 GitHub 源条目（stars>0）——api.github.com 出站可用性实测
 *   ③契合画像生效：Top10 里出现画像理由词（中文/任务/搜索/记忆/用量等）或热度入选
 *   ④设置面板：ext tab 打开 → #st-weekly 渲染行数>0、来源徽标、安装按钮存在
 *   ⑤红点：新周次 btn-settings 有 .footer-line-dot.on；拿到榜单后视为已读（下次开设置灭）
 * 自闭环：独立 userData + 端口 9251；缓存写测试 userData 不污染。用法：node tests/verify-pkgweekly.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9251;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function pageEval(expr, { awaitPromise = true } = {}) {
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
    setTimeout(() => rej(new Error("evaluate 超时")), 45000);
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

const userData = path.join(os.tmpdir(), "pi-gui-pkw-" + Date.now());
fs.mkdirSync(userData, { recursive: true });
let app = null;
try {
  app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT,
    env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (d) => { const s = String(d); if (s.includes("[pkg-weekly]")) console.log("  [inst]", s.trim().slice(0, 100)); });
  app.stderr.on("data", () => {});
  check("实例启动", await waitCDP());
  await pageEval(`document.readyState === "complete"`);

  // ① IPC 结构
  const data = await pageEval(`window.pi.pkgWeekly().then(r => JSON.stringify(r))`).catch(() => null);
  const parsed = data ? JSON.parse(data) : null;
  check("①pkg:weekly 返回", !!parsed?.items, data ? "" : "null");
  if (parsed?.items?.length) {
    check("①items ≤10", parsed.items.length <= 10, String(parsed.items.length));
    const sorted = parsed.items.every((it, i, a) => i === 0 || a[i - 1].score >= it.score);
    check("①score 降序", sorted);
    const srcOk = parsed.items.every((it) => it.source === "community" || it.source === "github");
    check("①source 合法", srcOk, [...new Set(parsed.items.map((i) => i.source))].join("+"));
    check("①week 格式", /^2\d{3}-W\d{2}$/.test(parsed.week ?? ""), parsed.week ?? "");
    check("①reason 非空", parsed.items.every((it) => !!it.reason));
    const gh = parsed.items.filter((it) => it.source === "github");
    check("②含 GitHub 源条目", gh.length > 0 && gh.some((it) => (it.stars ?? 0) > 0), gh.length ? `${gh[0].name} ${gh[0].stars}★` : "无");
    const fitWords = ["中文", "任务", "搜索", "记忆", "用量", "自动化", "内容运营", "桌面", "图像", "外观", "文档"];
    check("③契合理由出现", parsed.items.some((it) => fitWords.some((w) => it.reason.includes(w))), parsed.items.slice(0, 3).map((i) => i.reason).join(" / ").slice(0, 60));
    check("③负分词不进榜（遥测/运维）", !parsed.items.some((it) => /遥测|运维/.test(it.reason)));
  }

  // ④ 设置面板渲染（首次真抓 pi.dev 首字节 ~7s×2 页，轮询等 30s）
  await pageEval(`(() => { localStorage.setItem("pi-gui:pkg-weekly-seen", "2000-W01"); document.getElementById("btn-settings").click(); return true; })()`);
  let panel = null;
  for (let i = 0; i < 60; i++) {
    panel = await pageEval(`(() => ({ rows: document.querySelectorAll("#st-weekly .st-weekly-row").length }))`, { awaitPromise: false }).catch(() => null);
    if ((panel?.rows ?? 0) > 0) break;
    await sleep(600);
  }
  const panelFull = await pageEval(`(() => ({
    rows: document.querySelectorAll("#st-weekly .st-weekly-row").length,
    hasGitHub: [...document.querySelectorAll("#st-weekly .st-badge")].some(b => b.textContent === "GitHub"),
    hasInstall: !!document.querySelector("#st-weekly .st-act"),
  }))()`, { awaitPromise: false }).catch(() => panel);
  check("④面板渲染周榜行", (panelFull?.rows ?? 0) > 0, String(panelFull?.rows));
  check("④来源徽标含 GitHub", panelFull?.hasGitHub === true);
  check("④安装按钮存在", panelFull?.hasInstall === true);
  // ⑤ 红点：渲染后（seen=2000-W01≠本周）应亮 → 但拿到榜单即写 seen=本周，dot 应灭
  await sleep(300);
  const dot2 = await pageEval(`(() => {
    const seen = localStorage.getItem("pi-gui:pkg-weekly-seen");
    const dot = document.querySelector("#btn-settings .footer-line-dot");
    return JSON.stringify({ seen, on: dot ? dot.classList.contains("on") : null });
  })()`, { awaitPromise: false });
  const d2 = JSON.parse(dot2 || "{}");
  check("⑤已读周=本周（拿到榜单即视为已读）", /^2\d{3}-W\d{2}$/.test(d2.seen ?? "") && d2.seen === parsed?.week, `${d2.seen} vs ${parsed?.week}`);
  check("⑤已读后红点灭", d2.on === false, JSON.stringify(d2));
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
} finally {
  try { app?.kill(); } catch { /* 忽略 */ }
  await sleep(300);
  killInstance();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
}

const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
