/**
 * spawn_subagent preset 档位验证（2026-10-08，替代 verify-readonly-sub.mjs）：
 *   general=全工具 / explore=只读（read/grep/find/ls，旧 readOnly:true 等价别名）/ verify=裁判档（另加 bash）
 * ① SDK 级：inMemory 会话逐档 setActiveToolsByName 后断言工具表（零 token，不 prompt）；
 * ② 接线级：main.js 源码断言（SUB_PRESETS 表 / createEphemeralSession 第三参 / 解析映射行 / 透传链 / schema 枚举与 readOnly 弃用标注）。
 * 端到端（真模型派发各档子代理）留 owner 日常使用覆盖——批次1/2/4 的桥级链路已全绿。
 * 用法：node tests/verify-subpreset.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

/* ① SDK 白名单行为（逐档） */
try {
  const pi = await import(import.meta.resolve("@earendil-works/pi-coding-agent")); // 本地依赖（2026-10-12 开源改造：SDK 已进 dependencies；import.meta.resolve 与 ESM import 同解析器——pi 的 exports 是非法数组形态，createRequire().resolve 会拒绝）
  const loader = new pi.DefaultResourceLoader({
    cwd: ROOT,
    agentDir: pi.getAgentDir(),
    extensionFactories: [],
  });
  await loader.reload();
  const created = await pi.createAgentSession({
    cwd: ROOT,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(),
  });
  const s = created.session;
  const full = s.getActiveToolNames();
  check("①会话建立且有内置工具", Array.isArray(full) && full.length > 0, `tools=${full.length}`);
  check("①general 档基准：全量含 bash/write/edit", ["bash", "write", "edit"].every((t) => full.includes(t)));

  s.setActiveToolsByName(["read", "grep", "find", "ls"]);
  const explore = s.getActiveToolNames();
  check("①explore 档仅白名单四件", explore.length === 4 && ["read", "grep", "find", "ls"].every((t) => explore.includes(t)), JSON.stringify(explore));
  check("①explore 档写类与执行类均被剔除", !explore.includes("bash") && !explore.includes("write") && !explore.includes("edit"));

  s.setActiveToolsByName(["read", "bash", "grep", "find", "ls"]);
  const verify = s.getActiveToolNames();
  check("①verify 档五件含 bash", verify.length === 5 && verify.includes("bash") && ["read", "grep", "find", "ls"].every((t) => verify.includes(t)), JSON.stringify(verify));
  check("①verify 档 write/edit 仍被剔除", !verify.includes("write") && !verify.includes("edit"));
  try { s.dispose(); } catch { /* 忽略 */ }
} catch (err) {
  check("①SDK 级白名单行为", false, String(err?.message ?? err).slice(0, 200));
}

/* ② 接线断言（源码级） */
try {
  const src = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  check("②SUB_PRESETS 三档表在位",
    /const SUB_PRESETS = \{/.test(src) &&
    /general: null/.test(src) &&
    /explore: \["read", "grep", "find", "ls"\]/.test(src) &&
    /verify: \["read", "bash", "grep", "find", "ls"\]/.test(src));
  check("②createEphemeralSession 第三参 preset（缺省 general）",
    /createEphemeralSession\(modelRef, noTools = false, preset = "general"\)/.test(src));
  check("②解析映射：合法 preset 优先 / readOnly:true 兼容 explore / 兜底 general",
    /Object\.hasOwn\(SUB_PRESETS, params\?\.preset\) \? params\.preset : \(params\?\.readOnly === true \? "explore" : "general"\)/.test(src));
  check("②透传链：runSingleSubagent 承转 preset",
    /runSingleSubagent\(task, modelRef, preset, signal/.test(src) &&
    /createEphemeralSession\(modelRef, false, preset\)/.test(src));
  check("②schema 含 preset 枚举三值", /preset:\s*\{[\s\S]*?enum: \["general", "explore", "verify"\]/.test(src));
  check("②schema 标注 readOnly 弃用与兼容语义",
    /readOnly: \{ type: "boolean", description: "已弃用：等价 preset=\\"explore\\"/.test(src));
  check("②旧 readOnly 硬编码白名单已移除（防双源漂移）",
    !/setActiveToolsByName\(\["read", "grep", "find", "ls"\]\)/.test(src));
} catch (err) {
  check("②接线断言", false, String(err?.message ?? err).slice(0, 200));
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
