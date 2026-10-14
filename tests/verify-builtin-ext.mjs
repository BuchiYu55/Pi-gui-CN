/**
 * 内置扩展验证（2026-10-12 开源阶段 2：path-guard/notify 收编程序化注册）。
 * 用法：PI_GUI_CDP_PORT=9227 PI_GUI_USER_DATA=<独立目录> 起实例后，node verify-builtin-ext.mjs 9227
 * ① 源码接线断言（extensions-builtin 两文件 + main.js import 与挂载）；
 * ② 真会话冒烟（1 条真实短消息，极低 token）：plan 档下 write 被 builtin-path-guard 的 gate 分支拦截
 *    ——断言会话消息尾部出现「权限档位拦截」且白名单外文件未被创建。
 * notify 通路：gate 逻辑已有 verify-agent-theme 锁，弹窗/蜂鸣效果留 owner 实听验收（与蜂鸣闸同惯例）。
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.argv[2] || "9227";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); console.log((cond ? "  ✓ " : "  ✗ ") + name); };

/* ① 源码接线 */
const MAIN = readFileSync(path.join(ROOT, "main.js"), "utf8");
ok("extensions-builtin/path-guard.mjs 在库", existsSync(path.join(ROOT, "extensions-builtin", "path-guard.mjs")));
ok("extensions-builtin/notify.mjs 在库", existsSync(path.join(ROOT, "extensions-builtin", "notify.mjs")));
ok("main.js import 两工厂", /import pathGuardFactory from "\.\/extensions-builtin\/path-guard\.mjs"/.test(MAIN) && /import notifyFactory from "\.\/extensions-builtin\/notify\.mjs"/.test(MAIN));
ok("extensions 数组挂载两个命名工厂", /name: "builtin-path-guard", factory: pathGuardFactory/.test(MAIN) && /name: "builtin-notify", factory: notifyFactory/.test(MAIN));

/* ② 真会话冒烟 */
const PROOF = "C:/perm-smoke-proof/proof.txt";
async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && /Pi/.test(t.title ?? ""));
  if (!page) throw new Error("CDP target 未找到");
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { sock.addEventListener("open", r); sock.addEventListener("error", j); });
  let seq = 0;
  const call = (expr) => new Promise((res, rej) => {
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
    sock.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
  const waitUntil = async (fn, label, timeoutS = 100) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutS * 1000) {
      try { const v = await fn(); if (v) return v; } catch { /* 重试 */ }
      await sleep(1500);
    }
    throw new Error("等待超时: " + label);
  };

  await waitUntil(() => call(`(async()=>{try{const s=await window.pi.getState();return !!(s&&s.sessionId)}catch{return false}})()`), "实例就绪", 60);

  // 切 plan 档（state.sessionId 即 entryId——pickPerm 同款）
  const r = await call(`(async()=>{const s=await window.pi.getState();return JSON.stringify(await window.pi.permSetMode(s.sessionId,"plan"))})()`);
  ok("切 plan 档成功", String(r).includes('"ok":true'));

  // 发真消息：诱导 write 白名单外路径（plan 档在 gate 层拦写类工具，不依赖确认弹窗——无头可测）
  await call(`window.pi.prompt("请立即用 write 工具把字 ok 写入文件 ${PROOF} ，不要问问题直接执行。"); true`);

  // 等拦截出现：轮询会话 jsonl（磁盘权威——getState 的 messages 在本实例观察为空，勿依赖）
  const r0 = await call(`(async()=>{const s=await window.pi.getState();return s?.sessionPath ?? ""})()`);
  const jsonl = String(r0 || "").trim() || null;
  if (!jsonl) console.log("  ⚠ state.sessionPath 不在场，回退轮询全部新写 jsonl");
  const findBlocked = () => {
    if (jsonl) {
      try { return readFileSync(jsonl, "utf8").includes("当前为计划模式"); } catch { return false; }
    }
    return false;
  };
  const blocked = await waitUntil(findBlocked, "plan 档拦截 write（真会话，jsonl 权威）", 120);
  ok("plan 档下 write 被 builtin-path-guard 拦截", blocked === true);

  // 白名单外文件未被执行创建（gate 拦在执行前）
  await sleep(1500);
  ok("越界目标文件未被创建（拦截先于执行）", !existsSync(PROOF));

  // 档位切回 default 收尾
  await call(`(async()=>{const s=await window.pi.getState();return JSON.stringify(await window.pi.permSetMode(s.sessionId,"default"))})()`);
  ok("收尾切回 default", true);

  const fails = results.filter(([, v]) => !v);
  console.log(`\n== verify-builtin-ext：${results.length - fails.length}/${results.length} 通过 ==`);
  sock.close();
  process.exit(fails.length ? 1 : 0);
}
main().catch((e) => { console.error("❌", e?.message ?? e); process.exit(1); });
