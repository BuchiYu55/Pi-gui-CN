/**
 * 安全①②验证（2026-10-07 owner 拍板）：
 *   ① fs 通道白名单（GUI 实例）：工作区/主目录内可读，C:\Windows 等越界被拒（readDir error / readFile error kind / pathKind null）
 *   ② path-guard 扩展（无头单元，Node24 原生 strip-types 导入扩展 + 假桥 mock）：
 *      无桥放行 / 有 roots 无 confirm 保守 block / confirm 拒绝 block / confirm 允许放行 /
 *      白名单内不弹 / bash 命令盘符提取正确 / git-bash 白名单内路径放行
 * 真弹窗交互（GUI 集成）留 owner 人工验收。用法：node tests/verify-guard.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9247;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const G = globalThis;

const checks = [];
const check = (name, pass, info = "") => {
  checks.push({ name, pass });
  console.log(`${pass ? "✅" : "❌"} ${name}${info ? `  [${info}]` : ""}`);
};

/* ---------- ② 无头单元：mock 桥 + strip-types 导入扩展 ---------- */
async function unitGuard() {
  let handler = null;
  const fakePi = { on: (type, h) => { if (type === "tool_call") handler = h; } };
  const mod = await import(pathToFileURL(path.join(os.homedir(), ".pi/agent/extensions/path-guard.ts")).href);
  mod.default(fakePi);
  if (typeof handler !== "function") throw new Error("扩展未注册 tool_call 处理器");

  const HOME = os.homedir();
  const roots = [path.join(ROOT), path.join(HOME, "Documents")];
  let confirmCalls = [];
  const install = (rootsVal, confirmImpl) => {
    delete G.__piGuardRoots; delete G.__piGuardConfirm;
    confirmCalls = [];
    if (rootsVal !== undefined) G.__piGuardRoots = () => rootsVal;
    if (confirmImpl !== undefined) G.__piGuardConfirm = confirmImpl;
  };
  const call = (toolName, input) => handler({ toolName, input, toolCallId: "t" });

  // a) 无桥（裸 TUI）→ 放行（undefined）
  install(undefined, undefined);
  check("②a 无桥放行", (await call("read", { path: "C:\\Windows\\system.ini" })) === undefined);

  // b) 有 roots 无 confirm → 保守 block
  install(roots, undefined);
  const rb = await call("read", { path: "C:\\Windows\\system.ini" });
  check("②b 无确认通道保守拦截", rb?.block === true && String(rb.reason).includes("路径守卫"));

  // c) confirm 拒绝 → block
  install(roots, async () => false);
  const rc = await call("read", { path: "C:\\Windows\\system.ini" });
  check("②c owner 拒绝→block", rc?.block === true && String(rc.reason).includes("拒绝"));

  // d) confirm 允许 → 放行
  install(roots, async () => true);
  check("②d owner 允许→放行", (await call("read", { path: "C:\\Windows\\system.ini" })) === undefined);

  // e) 白名单内路径 → 不弹确认
  install(roots, async (p) => { confirmCalls.push(p); return true; });
  await call("read", { path: path.join(ROOT, "package.json") });
  check("②e 白名单内不弹确认", confirmCalls.length === 0);

  // f) bash 命令盘符提取：命令含越界路径 → confirm 收到该路径
  await call("bash", { command: `cat C:\\Windows\\system.ini && echo done` });
  check("②f bash 盘符路径提取", confirmCalls.length === 1 && String(confirmCalls[0]?.paths?.[0] ?? "").toLowerCase().includes("windows"));

  // g) git-bash 白名单内路径（/e/pi-gui）→ 不新增确认（相对 f 的基线）
  const baseG = confirmCalls.length;
  await call("bash", { command: `cat /e/pi-gui/package.json && ls /e/pi-gui/tests` });
  check("②g git-bash 白名单路径放行", confirmCalls.length === baseG, `+${confirmCalls.length - baseG}`);

  // h) 相对路径 → 不新增确认
  const baseH = confirmCalls.length;
  await call("bash", { command: `cat package.json` });
  check("②h 相对路径放行", confirmCalls.length === baseH, `+${confirmCalls.length - baseH}`);
  delete G.__piGuardRoots; delete G.__piGuardConfirm;
}

/* ---------- ① GUI 实例四通道 ---------- */
async function guiFs() {
  const userData = path.join(os.tmpdir(), "pi-gui-guard-" + Date.now());
  fs.mkdirSync(userData, { recursive: true });
  const app = spawn(process.execPath, [path.join(ROOT, "node_modules", "electron", "cli.js"), "."], {
    cwd: ROOT, env: { ...process.env, PI_GUI_CDP_PORT: String(PORT), PI_GUI_USER_DATA: userData }, stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", () => {}); app.stderr.on("data", () => {});
  try {
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < 30000) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json`); if (r.ok) { const t = await r.json(); if (t.some((x) => x.type === "page")) { ok = true; break; } } } catch { /* 未起 */ }
      await sleep(300);
    }
    check("①实例启动", ok);
    const evalp = async (expr) => {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
      const v = await new Promise((res, rej) => {
        const id = Date.now() % 1e6 + 1;
        ws.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.id === id) res(d.result?.result?.value); } catch { /* 忽略 */ } };
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        setTimeout(() => rej(new Error("evaluate 超时")), 15000);
      });
      ws.close();
      return v;
    };
    await evalp(`document.readyState === "complete"`);
    await evalp(`window.pi.wsAdd(${JSON.stringify(ROOT)})`); // 登记工作区（白名单根）
    const inDir = await evalp(`window.pi.readDir(${JSON.stringify(ROOT)}, false)`);
    check("①工作区内 readDir 正常", Array.isArray(inDir?.entries) && inDir.entries.length > 0, `${inDir?.entries?.length ?? 0} 项`);
    // 归一化断言（2026-10-07 图裂排查发现的两误杀：正斜杠/git-bash 式路径、大小写不一致）
    const slashDir = await evalp(`window.pi.readDir(${JSON.stringify(ROOT.replace(/\\/g, "/"))}, false)`);
    check("①正斜杠路径同源放行", Array.isArray(slashDir?.entries) && slashDir.entries.length > 0, JSON.stringify(String(slashDir?.error ?? "")).slice(0, 40));
    const caseFile = await evalp(`window.pi.readFile(${JSON.stringify(ROOT.toUpperCase() + "\\package.json")})`);
    check("①大小写不敏感放行", caseFile?.kind !== "error", String(caseFile?.error ?? caseFile?.kind).slice(0, 30));
    const homeDir = await evalp(`window.pi.readDir(${JSON.stringify(os.homedir())}, false)`);
    check("①主目录 readDir 正常（白名单根）", Array.isArray(homeDir?.entries));
    const outDir = await evalp(`window.pi.readDir("C:\\\\Windows", false)`);
    check("①C:\\Windows readDir 被拒", !!outDir?.error && String(outDir.error).includes("不在允许范围"), String(outDir?.error ?? "").slice(0, 40));
    const outFile = await evalp(`window.pi.readFile("C:\\\\Windows\\\\win.ini")`);
    check("①越界 readFile 返回 error", outFile?.kind === "error", String(outFile?.error ?? "").slice(0, 40));
    const outKind = await evalp(`window.pi.pathKind("C:\\\\Windows")`);
    check("①越界 pathKind 返回 null", outKind === null);
    const search = await evalp(`window.pi.searchFiles("C:\\\\Windows", "notepad", false)`);
    check("①越界 searchFiles 空结果+error", Array.isArray(search?.results) && search.results.length === 0 && !!search?.error);
  } finally {
    try { app.kill(); } catch { /* 忽略 */ }
    await sleep(300);
    try {
      const out = execFileSync("powershell", ["-NoProfile", "-Command",
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -Unique`], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) { const pid = parseInt(line.trim(), 10); if (pid > 0) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
    } catch { /* 已释放 */ }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* 句柄延迟 */ }
  }
}

try {
  await unitGuard();
  await guiFs();
} catch (err) {
  check("执行链路无未捕获异常", false, String(err?.stack ?? err).slice(0, 200));
}
const pass = checks.filter((c) => c.pass).length;
console.log(`\n==== ${pass}/${checks.length} 通过 ====${pass === checks.length ? "" : "  ❌ 有失败项"}`);
process.exit(pass === checks.length ? 0 : 1);
