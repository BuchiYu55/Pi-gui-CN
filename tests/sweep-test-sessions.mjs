/**
 * sweep-test-sessions.mjs —— 测试会话孤儿清扫器（2026-10-10）
 *
 * 背景：真会话驱动器（gate L3 验证类）每轮 createSession 留尸体；驱动器 cleanup 只清
 * 本轮注册的会话，上一轮崩溃/漏注册的成孤儿永留主实例侧栏（2026-10-10 实弹：gate-allow）。
 * 本工具是 backstop——**驱动器自清仍是第一道闸**（见 AGENTS.md 2026-10-10 规则）。
 *
 * 保守设计（防误删 owner 真会话，同「不做内容 grep」坑）：
 * - 只匹配会话【首条用户消息】（= 侧栏标题来源），锚定驱动器提示词签名，不全文 grep；
 * - 默认 dry-run 只列不删；--yes 才删；删除前打印首条消息供人工核对；
 * - mtime 在 30 分钟内的文件跳过（防误杀尚在跑的活跃驱动会话）；
 * - 新驱动器出现新提示词时，往 SIGNATURES 加行或用 --match "<regex>" 临时指定。
 *
 * 用法：
 *   node tests/sweep-test-sessions.mjs                 # dry-run，列出命中项
 *   node tests/sweep-test-sessions.mjs --yes           # 删除命中项
 *   node tests/sweep-test-sessions.mjs --match "正则" --yes
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SIGNATURES = [
  /^用 write 创建 docs\/gate-/, // gate L3 真会话驱动（2026-10-10 实弹形态）
  /^请用 write 工具创建文件 docs\/gate-/, // tmp-c2c3 早期形态（同日晨五尸体）
];

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const matchIdx = args.indexOf("--match");
const custom = matchIdx >= 0 ? new RegExp(args[matchIdx + 1]) : null;
const sigs = custom ? [custom, ...SIGNATURES] : SIGNATURES;
const MIN_AGE_MS = 30 * 60 * 1000;

const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
const now = Date.now();
const hits = [];

for (const dir of fs.readdirSync(sessionsRoot)) {
  const dp = path.join(sessionsRoot, dir);
  if (!fs.statSync(dp).isDirectory()) continue;
  for (const f of fs.readdirSync(dp)) {
    if (!f.endsWith(".jsonl")) continue;
    const fp = path.join(dp, f);
    const st = fs.statSync(fp);
    if (now - st.mtimeMs < MIN_AGE_MS) continue; // 活跃驱动保护
    let first = "";
    for (const line of fs.readFileSync(fp, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const msg = j.message || j;
        if ((msg.role || j.type) === "user") {
          let c = msg.content;
          if (Array.isArray(c)) c = c.map((p) => p.text || p.type || "").join(" ");
          first = String(c);
          break;
        }
      } catch { /* 坏行跳过 */ }
    }
    if (first && sigs.some((re) => re.test(first))) hits.push({ fp, mtime: st.mtime, first });
  }
}

if (!hits.length) {
  console.log("无命中（干净）。");
  process.exit(0);
}

for (const h of hits) {
  console.log(`${yes ? "[删]" : "[命中]"} ${h.fp}`);
  console.log(`       mtime ${h.mtime.toLocaleString()} | 首条: ${JSON.stringify(h.first.slice(0, 100))}`);
}

if (!yes) {
  console.log(`\n共 ${hits.length} 项。核对首条消息确认全是测试尸体后，加 --yes 重跑执行删除。`);
} else {
  for (const h of hits) fs.rmSync(h.fp);
  console.log(`\n已删除 ${hits.length} 个会话文件。提示：主实例侧栏是陈旧列表，reload/重启后才消失。`);
}
