/**
 * path-guard —— 路径守卫（内置扩展，2026-10-12 开源阶段 2 收编自 ~/.pi/agent/extensions/path-guard.ts）
 * agent（bash/read/edit/write/ls/grep/find/powershell）访问白名单外路径时，
 * 经 GUI 桥（globalThis.__piGuardConfirm，main.js 挂载）弹原生确认，用户允许才放行；
 * 拒绝则 block 该次工具调用（reason 回给模型，可换工作区内路径重试）。
 *
 * 三档权限前置判定：tool_call 先问 __piGuardGate(sessionId, toolName)——
 *   {block} 直接拦截（计划模式拦写类工具）；{allow} 全放行（完全访问，跳过路径检查）；
 *   null 交回下方路径守卫（默认档 / 未登记会话）。归属钥匙 ctx.sessionManager.getSessionId()。
 *
 * 白名单 = 与 GUI fs 通道同源（globalThis.__piGuardRoots()：已登记工作区+收藏+主目录）。
 * 桥缺失语义：无 roots 桥 → 放行（防御性——GUI 内置注册时桥恒在）；有 roots 无 confirm → 保守 block。
 * 路径提取：文件类工具取 input.path(s)；bash/powershell 扫命令文本中的绝对路径
 * （盘符式 X:\ 与 git-bash 式 /x/；~/ 视为 home 内放行；相对路径按会话 cwd 语义放行；
 *  无盘符 unix 根路径（/tmp 等）= git-bash 虚拟层，放行降噪）。
 * ⚠️ 本文件只 import pi 的类型已去除（纯 JS）；桥协议变更须与 main.js 三桥同步。
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs"; // realpath 归一（符号链接越界判定）

function normalizeWin(p) {
  // git-bash 盘符挂载式 /e/xxx → e:\xxx
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toLowerCase()}:\\${m[2].replace(/\//g, "\\")}`;
  return p;
}

/** 提取一次工具调用涉及的绝对路径（已归一），相对路径与 home 内路径不产出。 */
function extractPaths(toolName, input) {
  const out = [];
  const push = (raw) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const s = raw.trim();
    // UNC/设备路径（\\server\share、\\?\）也算绝对路径：交给 outsideRoots 统一判越界
    const isAbs = /^[a-zA-Z]:[\\/]/.test(s) || /^\/[a-zA-Z]\//.test(s) || /^\\\\/.test(s);
    if (!isAbs) return; // 相对路径：按会话 cwd（工作区内）放行
    out.push(path.resolve(normalizeWin(s)));
  };
  const inp = input ?? {};
  if (toolName === "bash" || toolName === "powershell") {
    const cmd = String(inp.command ?? "");
    // 盘符式、git-bash 盘符挂载式与 UNC 式；~/ 跳过（home 在白名单）
    for (const m of cmd.matchAll(/(?:[a-zA-Z]:[\\/][^\s'"&|;,)）]+|\/[a-zA-Z]\/[^\s'"&|;,)）]+|\\\\[^\s'"&|;,)）]+)/g)) {
      const s = m[0].replace(/[.,;:]+$/, "");
      if (/^~\//.test(s)) continue;
      push(s);
    }
    return out;
  }
  push(inp.path);
  if (Array.isArray(inp.paths)) for (const p of inp.paths) push(p);
  return out;
}

/** realpath 归一（ENOENT 等失败回退归一值）——根内符号链接/junction 指向根外即越界 */
function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

function outsideRoots(paths, roots) {
  const home = os.homedir().toLowerCase();
  const realRoots = roots.map((r) => realPath(path.resolve(r)).toLowerCase());
  return paths.filter((p) => {
    if (/^\\\\/.test(p)) return true; // UNC/设备路径：白名单根全是盘符式，一律越界
    const lower = realPath(p).toLowerCase();
    if (lower === home || lower.startsWith(home + path.sep.toLowerCase())) return false;
    return !realRoots.some((rl) => lower === rl || lower.startsWith(rl + path.sep));
  });
}

export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      // 三档权限前置判定：计划模式拦写类 / 完全访问跳过路径检查
      const gateFn = globalThis.__piGuardGate;
      if (typeof gateFn === "function") {
        let sid;
        try { sid = ctx?.sessionManager?.getSessionId?.(); } catch { /* 无头兼容 */ }
        const verdict = gateFn(String(sid ?? ""), event.toolName);
        if (verdict && verdict.block) return { block: true, reason: verdict.reason ?? "权限档位拦截" };
        if (verdict && verdict.allow) return; // 完全访问：放行（跳过路径守卫）
        // null → 继续下方路径守卫（默认档 / 未登记会话维持现状语义）
      }
      const rootsFn = globalThis.__piGuardRoots;
      if (typeof rootsFn !== "function") return; // 无桥（防御性，内置注册时桥恒在）：放行
      const roots = rootsFn() ?? [];
      if (!roots.length) return;
      const paths = extractPaths(event.toolName, event.input);
      if (!paths.length) return;
      const outside = outsideRoots(paths, roots);
      if (!outside.length) return;
      const confirmFn = globalThis.__piGuardConfirm;
      if (typeof confirmFn !== "function") {
        console.log(`[path-guard] ${event.toolName} 越界 ${outside[0]} —— 无确认通道，保守拦截`);
        return { block: true, reason: "路径守卫：确认通道不可用，已拦截白名单外访问：" + outside.join(", ") };
      }
      const allowed = await confirmFn({ tool: event.toolName, paths: outside });
      if (!allowed) {
        return { block: true, reason: "用户拒绝了白名单外路径访问（如确需访问请先把目录登记为工作区/收藏）：" + outside.join(", ") };
      }
      return; // 允许：放行
    } catch (err) {
      console.log("[path-guard] 异常（放行并记录）:", String(err?.message ?? err));
      return; // 守卫自身故障不拦正常工作
    }
  });
}
