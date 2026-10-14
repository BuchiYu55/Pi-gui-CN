/**
 * notify —— 任务完成通知（内置扩展，2026-10-12 开源阶段 2 收编自 ~/.pi/agent/extensions/notify.ts v5）
 * 收编精简说明：原 TS 版的三通路（Electron 桥 → PowerShell toast → OSC 777/99）里，后两者是裸 TUI
 * 场景的兜底——GUI 内置注册时 __piGuiNotify 桥恒在，全部走桥即可（桥返回 true = 已原生发出）。
 *
 * 事件链：message_end 缓存最后一条 assistant/user 消息 → agent_settled（重试/压缩/续跑不触发）。
 * 弹窗结构：标题 = Pi · <工作区名>，正文 = 任务摘要（助手消息标题行/首行，截 48 字）。
 * 蜂鸣闸：__piGuiNotifyGate 暴露与 toast 同一套决策（TEST_SILENT/总开关/勿扰+提示音），
 * SystemSounds.Asterisk 一声与 toast 解耦；SystemSounds 只经闸放行，勿扰不拦。
 * 强引用缓存防 GC——Notification 被 GC 会让 toast 闪没（既有坑，桥侧已处理，此处防的是兜底）。
 */
import { execFile } from "node:child_process";

let lastAssistantText = "";
let lastUserText = "";

function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  const parts = msg.parts ?? msg.content;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return "";
}

/** 从消息正文提炼任务名：优先 markdown 标题行，否则首行；清洗并截断 */
function cleanSummary(raw) {
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let line = lines.find((l) => /^#{1,6}\s+\S/.test(l)) ?? lines[0] ?? "";
  line = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>]+/g, "")
    .replace(/[：:；;，,]\s*$/, "")
    .trim();
  if (!line) line = "任务完成";
  return line.length > 48 ? line.slice(0, 48) + "…" : line;
}

function workspaceName(cwd) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** 声音与通知解耦：SystemSounds 一声（经蜂鸣闸放行才响） */
function playSound() {
  try {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-Command", "[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 400"],
      { windowsHide: true },
      () => {},
    );
  } catch {
    // 静默失败
  }
}

export default function (pi) {
  pi.on("message_end", (event) => {
    const msg = event?.message;
    if (!msg) return;
    if (msg.role === "assistant") lastAssistantText = extractText(msg);
    else if (msg.role === "user") lastUserText = extractText(msg);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const workspace = workspaceName(ctx?.cwd ?? "");
    const task = cleanSummary(lastAssistantText || lastUserText || "任务完成");
    const header = `Pi · ${workspace}`;

    // 蜂鸣闸：主进程桥暴露与 toast 同一套决策——SystemSounds 只经闸放行
    const gateBridge = globalThis.__piGuiNotifyGate;
    if (typeof gateBridge === "function") {
      const g = gateBridge();
      if (!g.silent && g.allowed && g.sound) playSound();
    } else {
      playSound(); // 无桥（防御性）：维持响声，GUI 内置注册时桥恒在
    }

    const bridge = globalThis.__piGuiNotify;
    if (typeof bridge === "function" && bridge(header, task)) return; // 主进程原生 Notification 已发出
    // 桥不可达（异常态）：内置版无 PowerShell/OSC 兜底，静默（日志在桥侧）
  });
}
