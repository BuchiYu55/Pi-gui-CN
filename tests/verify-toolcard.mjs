/**
 * E1.3 长输出 elide + E1.2 收拢回归锁验证（2026-10-11 计划书）：
 * ① 完成即收拢回归锁（finishCard remove open，2026-10-05 既有形态——本批补断言锁防退化）；
 * ② 小输出全文直显无「展开全部」；③ >200 行输出截前 40 行+省略行+「展开全部」按钮；
 * ④ 点头部展开（open 回归）→ 点按钮全文还原按钮移除；⑤ CSSOM .tool-out-more 规则在位。
 * 零 token：__testToolcard 钩子 + __lastCard 引用，不发 prompt。
 * 用法：node tests/verify-toolcard.mjs [端口]（默认 9252，smoke 传独立端口）
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
  const page = (await list()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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

const BIG = Array.from({ length: 250 }, (_, i) => "row-" + i).join("\n");
const port = parseInt(process.argv[2] ?? "9252", 10);
const ud = path.join(os.tmpdir(), "pi-gui-toolcard-" + Date.now());
let s = null;
try {
  s = await launch(port, ud);
  check("实例启动（端口 " + port + "）", true);

  // ① 小输出：完成即收拢（回归锁）+ 全文直显 + 无展开按钮
  let r = JSON.parse(await s.call(`JSON.stringify(window.__testToolcard("line1\\nline2"))`));
  check("①完成即收拢（done 无 running/open）", r.cls.includes("done") && !r.cls.includes("running") && !r.cls.includes("open"), r.cls);
  check("①小输出全文直显", r.out === "line1\nline2", JSON.stringify(r.out));
  check("①小输出无展开按钮", r.hasMore === false);

  // ② 大输出（250 行）：截前 40 行 + 省略行 + 展开按钮
  r = JSON.parse(await s.call(`JSON.stringify(window.__testToolcard(${JSON.stringify(BIG)}))`));
  const outLines = r.out.split("\n");
  check("②大输出截前 40 行+省略提示", outLines.length === 41 && outLines[40].includes("共 250 行"), `lines=${outLines.length} tail=${outLines[40]}`);
  check("②大输出有展开按钮", r.hasMore === true);

  // ③ 点头部展开（open 回归）→ 按钮在 → 点按钮全文还原
  await s.call(`window.__lastCard.root.querySelector(".tool-head").click(); true`);
  let cls = await s.call(`window.__lastCard.root.className`);
  check("③点头部展开（open 回归）", cls.includes("open"), cls);
  await s.call(`window.__lastCard.root.querySelector(".tool-out-more").click(); true`);
  r = JSON.parse(await s.call(`JSON.stringify({ out: window.__lastCard.outEl.textContent, more: !!window.__lastCard.outMore })`));
  check("③点按钮全文还原（250 行）", r.out.split("\n").length === 250, `lines=${r.out.split("\n").length}`);
  check("③展开后按钮移除", r.more === false);

  // ④ CSSOM .tool-out-more 规则在位
  const css = await s.call(`(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules ?? []) {
        if (rule.cssText && rule.cssText.includes(".tool-out-more")) return rule.cssText;
      }
    }
    return "";
  })()`);
  check("④CSSOM .tool-out-more 规则在位", css.includes(".tool-out-more"), css.slice(0, 120));
} catch (err) {
  check("脚本执行", false, String(err?.message ?? err));
} finally {
  await stop(s?.app, port, ud);
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
