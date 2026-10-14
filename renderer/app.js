/**
 * Pi 桌面版 —— 渲染进程逻辑
 * 职责：订阅 pi 事件流 → 渲染流式对话/工具卡片；输入 → IPC → 主进程会话。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import json from "highlight.js/lib/languages/json";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("json", json);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("java", java);
hljs.registerLanguage("go", go);

marked.setOptions({ breaks: true, gfm: true });

/* ================= 工具函数 ================= */

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/* 键盘可达统一绑定（2026-10-12 审计键盘批）：div/span 交互元素补 tabindex+role+Enter/Space 触发。
   action 通常传 () => elm.click()（复用既有 click 语义，双击/右键等鼠标手势不在此覆盖） */
function bindKbd(elm, action, role = "button") {
  elm.tabIndex = 0;
  elm.setAttribute("role", role);
  elm.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      action();
    }
  });
}

function md(text) {
  return DOMPurify.sanitize(marked.parse(text ?? ""));
}
/** 安全 HTML 注入统一入口：DOMPurify 消毒为文档片段后整体替换子节点（无 innerHTML；
 *  md() 已消毒的输入二次消毒幂等，静态常量首过消毒） */
function setHtml(node, html) {
  node.replaceChildren(DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true }));
}

function highlightIn(root) {
  root.querySelectorAll("pre code:not([data-hl])").forEach((c) => {
    try { hljs.highlightElement(c); } catch { /* 未知语言跳过 */ }
    c.dataset.hl = "1";
  });
}

/* ================= 全局状态 ================= */

const chat = $("chat");
const input = $("input");

let state = null; // {cwd, model, thinkingLevel, tools, messageCount}
let running = false;
let curMsg = null; // 正在流式输出的 assistant 容器
let hydrating = false; // 历史重建中（R3）：入场动画只挂实时消息，renderHistory 期间不加 .enter
let historyGen = 0; // 切换微卡（2026-10-07）：历史分段渲染代际——重渲/切走即作废旧的 idle 补齐批次
let lastUsage = null;
let sendMode = "queue"; // 运行中发消息的方式：queue=排队 | steer=插话
let changedFiles = []; // 本会话 write/edit 触碰过的文件
let turnStart = 0; // 本轮 agent 起始时间（轮末 chip 计时，R3）
let draftSaveTimer = null; // 草稿防抖落库定时器（2026-10-05）
const unreadPaths = new Set(); // 后台会话「完成未查看」的落盘路径（完成强提示：置顶/整行态/组头徽标/标题/任务栏角标，查看即消）
const pendingArgs = {}; // toolCallId → args（tool_execution_end 不带 args，从这取）

/* ---- 任务清单 pane（2026-10-05）：渲染 rpiv-todo 的快照 ----
 * rpiv-todo 每次成功的 todo 工具调用，result.details.tasks 就是全量任务快照（它的
 * 持久化机制正是“每个调用带全量快照，从会话分支回放”）。GUI 侧不需要实现 extension
 * UI 协议：实时路径监听 tool_execution_end，历史路径扫 role=toolResult 的最后一条。
 * 语义对齐：deleted 墓碑不展示；completed 行轮内保持可见、下一轮 agent_start 退场。
 * 同日晚迁入右栏替换决策树占位 pane（tree-view 从未被代码写入）：pane 常驻不隐藏，
 * 空快照落 pane-empty 引导（对齐右栏空态模式）；面板入场动画随形态迁移取消。 */
const todoBySession = new Map(); // sessionId → Task[]（最近一次快照，已滤 deleted）
let todoTurnActive = false; // true=正在跑一轮：completed 行隐藏（对齐 rpiv “完成行下一轮退场”）
let todoCollapsed = localStorage.getItem("pi-gui:todo-collapsed") === "1";

function todoVisibleRows(sessionId) {
  const all = (todoBySession.get(sessionId) ?? []).filter((t) => t && t.status !== "deleted");
  const rows = todoTurnActive ? all.filter((t) => t.status !== "completed") : all;
  return { all, rows };
}

function todoRowClass(status) {
  if (status === "completed") return "todo-row done";
  if (status === "in_progress") return "todo-row active";
  return "todo-row";
}

function todoGlyph(status) {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "●";
  return "○";
}

function renderTodoPanel() {
  const panel = $("todo-panel");
  if (!panel) return;
  panel.classList.toggle("collapsed", todoCollapsed);
  $("todo-head").setAttribute("aria-expanded", todoCollapsed ? "false" : "true");
  const count = $("todo-count");
  const body = $("todo-body");
  body.innerHTML = "";
  if (!state?.sessionId || !todoBySession.has(state.sessionId)) {
    // 无快照：pane 常驻 + pane-empty 引导（迁入右栏后不再自动隐藏）
    count.classList.add("hidden");
    count.textContent = "";
    count.removeAttribute("title");
    const empty = el("div", "pane-empty");
    empty.textContent = "agent 规划任务后此处显示清单";
    body.appendChild(empty);
    return;
  }
  const { all, rows } = todoVisibleRows(state.sessionId);
  const shown = rows.length ? rows : all; // 轮内 rows 为空 = 全部完成：回退展示全部完成行
  const done = all.filter((t) => t.status === "completed").length;
  count.classList.remove("hidden");
  count.textContent = `${done}/${all.length}`;
  count.title = `已完成 ${done} / 共 ${all.length}`;
  if (!todoCollapsed) {
    for (const t of shown) {
      const r = el("div", todoRowClass(t.status));
      r.setAttribute("role", "listitem");
      const g = el("span", "t-glyph");
      g.textContent = todoGlyph(t.status);
      const s = el("span", "t-subject");
      s.textContent = t.subject + (t.status === "in_progress" && t.activeForm ? `（${t.activeForm}）` : "");
      r.append(g, s);
      const tip = [t.description, t.blockedBy?.length ? `被阻塞于：#${t.blockedBy.join(" #")}` : ""]
        .filter(Boolean).join("　");
      if (tip) r.title = tip;
      body.appendChild(r);
    }
    if (shown.length < all.length) {
      const more = el("div", "todo-more");
      more.textContent = `＋${all.length - shown.length} 个已完成已收起（下一轮退场）`;
      body.appendChild(more);
    }
  }
}

function todoApplySnapshot(sessionId, tasks) {
  if (!sessionId || !Array.isArray(tasks)) return;
  todoBySession.set(sessionId, tasks.filter((t) => t && typeof t === "object" && t.status !== "deleted"));
  todoTurnActive = false; // 轮内快照到达：completed 行保持可见到轮末
  if (sessionId === state?.sessionId) renderTodoPanel();
}

function todoCollectFromMessages(messages) {
  let snap = null;
  for (const m of messages ?? []) {
    if (m?.role === "toolResult" && m.toolName === "todo" && !m.isError && Array.isArray(m.details?.tasks)) {
      snap = m.details.tasks; // 顺序扫描取最后一条 = 当前分支权威快照
    }
  }
  return snap;
}

/* ---- 会话草稿（2026-10-05 owner 反馈：输入框文字并非每个任务独立；同日二轮：附件一并独立） ----
 * 每个 sessionId 独立保存输入框草稿 {t: 文字, a: 附件}，切换会话时保存/恢复，互不串。
 * localStorage 持久化（重启 GUI 也能找回），Map 插入序 ≈ 最近使用序，超 40 条裁最旧；
 * 附件是 base64 体积大，持久化总量超 ~1.5MB 时退化为只存文字（附件仍留内存，切会话照常独立）。 */
const draftStore = (() => {
  const migrate = (v) => {
    if (typeof v === "string") return { t: v, a: [] }; // 旧版纯文字草稿
    if (v && typeof v === "object") return { t: String(v.t ?? ""), a: Array.isArray(v.a) ? v.a : [] };
    return { t: "", a: [] };
  };
  try {
    const raw = JSON.parse(localStorage.getItem("pi-gui:drafts") ?? "{}");
    return new Map(Object.entries(raw).map(([k, v]) => [k, migrate(v)]));
  } catch { return new Map(); }
})();
function persistDrafts() {
  try {
    const pack = (withAtts) => {
      const obj = {};
      for (const [k, v] of [...draftStore].slice(-40)) obj[k] = withAtts ? v : { t: v.t, a: [] };
      return JSON.stringify(obj);
    };
    let s = pack(true);
    if (s.length > 1500000) s = pack(false); // 附件总量超限：退化为只持久化文字
    localStorage.setItem("pi-gui:drafts", s);
  } catch { /* 存储异常不阻塞切换 */ }
}
function saveDraft() {
  if (!state?.sessionId) return;
  const t = input.value;
  const a = attachments.map((x) => ({ ...x })); // 克隆快照：后续增删不影响已存记录
  draftStore.delete(state.sessionId);
  if (t || a.length) draftStore.set(state.sessionId, { t, a });
  persistDrafts();
  window.__draftTrace?.push({ op: "save", sid: state.sessionId, len: t.length, atts: a.length });
}
// 防抖落库（输入/贴图/删图共用）：应用中途被杀也不丢。触发时会话已换（sid 变）则跳过——
// 切换路径的同步 saveDraft 已兑底，避免把旧会话的内容误写进新会话键下
function scheduleDraftSave() {
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  const sid = state?.sessionId;
  draftSaveTimer = setTimeout(() => { if (state?.sessionId === sid) saveDraft(); }, 500);
}
function restoreDraft(preSwitch) {
  const rec = draftStore.get(state?.sessionId) ?? { t: "", a: [] };
  // 竞态防护：createSession IPC 慢时用户可能已在切换期间敲字/贴图（内容 ≠ 切换开始值），
  // 此时不用目标会话的旧草稿覆盖——以用户当前所见为准，避免“打字/贴图被吞”
  if (preSwitch && (input.value !== preSwitch.input || attachments !== preSwitch.atts || attachments.length !== preSwitch.attsLen)) {
    autoResize();
    updateSlashMenu();
    window.__draftTrace?.push({ op: "restore-skip", sid: state?.sessionId, len: input.value.length, atts: attachments.length });
    return;
  }
  input.value = rec.t;
  attachments = rec.a.map((x) => ({ ...x })); // 克隆：与会话记录脱钩，改一处不牵另一处
  autoResize();
  updateSlashMenu(); // 恢复的草稿以 / 开头时同步菜单显隐
  renderAttachments();
  window.__draftTrace?.push({ op: "restore", sid: state?.sessionId, len: rec.t.length, atts: rec.a.length });
}

/* ---- 图片附件（粘贴/拖拽/文件选择） ---- */
let attachments = []; // {id, base64, mime, name, thumb}
let attachSeq = 0;

function addAttachment(base64, mime, name) {
  if (attachments.length >= 6) { showNotice("最多 6 张图", true); return; }
  attachments.push({
    id: "att" + (++attachSeq),
    base64, mime,
    name: name || ("图片" + attachSeq),
    thumb: `data:${mime};base64,${base64}`,
  });
  renderAttachments();
  scheduleDraftSave(); // 贴图也是草稿的一部分，防抖落库
}

function addImageFile(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(",")[1];
    if (base64) addAttachment(base64, file.type, file.name);
  };
  reader.readAsDataURL(file);
}

function renderAttachments() {
  const strip = $("attachments");
  strip.innerHTML = "";
  strip.classList.toggle("hidden", !attachments.length);
  for (const a of attachments) {
    const item = el("div", "att-item");
    item.title = a.name;
    const img = document.createElement("img");
    img.src = a.thumb;
    const rm = el("span", "att-rm");
    rm.textContent = "×";
    rm.setAttribute("aria-label", "移除图片");
    bindKbd(rm, () => rm.click()); // 键盘批：附件删除 Enter 可达
    rm.addEventListener("click", () => {
      attachments = attachments.filter((x) => x.id !== a.id);
      renderAttachments();
      scheduleDraftSave(); // 删图同步进草稿库
    });
    item.append(img, rm);
    strip.appendChild(item);
  }
}

/* ================= 通知条 ================= */

let noticeTimer = null;
function showNotice(text, isError = false, sticky = false) {
  const n = $("notice");
  n.textContent = text;
  n.classList.toggle("error", isError);
  n.classList.remove("hidden");
  clearTimeout(noticeTimer);
  if (!sticky) noticeTimer = setTimeout(() => n.classList.add("hidden"), 5000);
}
function hideNotice() {
  clearTimeout(noticeTimer);
  $("notice").classList.add("hidden");
}

/* ================= 聊天渲染 ================= */

function hideWelcome() {
  const w = $("welcome");
  if (w) w.remove();
}

function nearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140;
}
/* 用户滚动意图感知（owner 2026-10-07：生成期间想回看上文被反复拉底）：
 * scroll 事件实时判定 userPinned——用户上翻即停跟随，滚回底部自动恢复；
 * 程序滚动后 scrollTop 必在底部，事件回填 true 无副作用，无需区分事件源 */
let userPinned = true;
chat.addEventListener("scroll", () => { userPinned = nearBottom(); }, { passive: true });
function scrollBottom(force = false) {
  if (!force && !userPinned) return; // 用户上翻中：非强制不拉（强制仅限用户发消息/历史加载）
  chat.scrollTop = chat.scrollHeight;
}

/* ---- 欢迎页（三处复用：index.html 静态 / renderHistory / startSession）——极简：只留标识 ---- */
const WELCOME_HTML = '<div class="welcome-logo">pi<span>.</span></div>';

function mountWelcome() {
  const old = $("welcome");
  if (old) old.remove();
  const w = el("div", "welcome");
  w.id = "welcome";
  setHtml(w, WELCOME_HTML);
  chat.appendChild(w);
}

// 快捷入口已移除（2026-10-03 极简化：welcome 只留 pi. 标识）；grill-me 走 / 菜单，对比走 composer 按钮

/* ---- 阶段化状态提示（2026-10-07）：首响应真空期体感优化 ----
 * prep=本地组装上下文（IPC 发出前即挂）→ wait=agent_start 已到（请求进入模型，等 TTFT）
 * → 任何 assistant 内容开始（beginAssistant）即撤、流式接管；settled/host_error/兜底解锁时清理。 */
const PHASE_TEXT = { prep: "正在准备上下文…", wait: "已提交模型，等待响应…" };
function showPhase(kind) {
  let h = document.getElementById("phase-hint");
  if (!h) {
    h = el("div", "phase-hint");
    h.id = "phase-hint";
    h.append(el("span", "phase-dot"), el("span", "phase-label"));
    chat.appendChild(h);
  }
  h.querySelector(".phase-label").textContent = PHASE_TEXT[kind] ?? "";
  scrollBottom(false); // 跟随式：用户上翻中不拉
}
function hidePhase() {
  document.getElementById("phase-hint")?.remove();
}

function addUserBubble(text, images, into) {
  hideWelcome();
  looseLive = []; // 新用户消息开新段：间隙判定重置（E1.1）
  const div = el("div", "msg msg-user");
  const b = el("div", "bubble");
  if (!hydrating) b.classList.add("enter"); // R3：入场动画只挂实时消息，历史重建不回放
  if (images?.length) {
    // 文本只加一次（此前 textContent + insertBefore 双写导致带图消息文字重复）
    if (text) {
      const t = el("div");
      t.textContent = text;
      b.appendChild(t);
    }
    const wrap = el("div", "bubble-imgs");
    for (const im of images) {
      const img = document.createElement("img");
      img.src = `data:${im.mimeType};base64,${im.data}`;
      wrap.appendChild(img);
    }
    b.appendChild(wrap);
  } else if (text) {
    b.textContent = text;
  }
  div.appendChild(b);
  // owner 文字底下的复制按钮（2026-10-06 修正：复制的是 owner 自己写的内容，不是回复）
  if (text) {
    const row = el("div", "user-copy-row");
    const btn = el("button", "msg-copy-btn");
    btn.type = "button";
    btn.title = "复制这段文字";
    btn.setAttribute("aria-label", "复制我的这段发言");
    btn.appendChild(mcpFormIconSvg("i-copy"));
    btn.addEventListener("click", async () => {
      try {
        await window.pi.writeClipboard(text);
        btn.classList.add("ok");
        btn.title = "已复制";
        setTimeout(() => { btn.classList.remove("ok"); btn.title = "复制这段文字"; }, 1200);
      } catch { showNotice("复制失败", true); }
    });
    row.appendChild(btn);
    div.appendChild(row);
  }
  (into ?? chat).appendChild(div);
  if (!into) scrollBottom(true); // 分段补齐渲染到 frag 时不动滚动（历史重建也不该逐条拉底）
}

function beginAssistant(into) {
  hideWelcome();
  hidePhase(); // 阶段占位撤除：assistant 内容开始即由流式接管
  const div = el("div", "msg msg-assistant");
  const av = el("div", "avatar");
  av.textContent = "π";
  const b = el("div", "bubble");
  if (!hydrating) b.classList.add("enter"); // R3：同上
  div.append(av, b);
  (into ?? chat).appendChild(div);
  curMsg = { bubble: b, blocks: new Map(), cards: new Map(), sawAgent: false };
  if (!into) scrollBottom(false); // 跟随式：用户上翻中不拉（曾 force 拉底，owner 回看被反复拽回，2026-10-07）
  return curMsg;
}

/* ---- 流式文本/思考块 ---- */

let renderQueued = false;
function scheduleRender(blk) {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!blk.container.isConnected) return;
    if (blk.kind === "text") {
      setHtml(blk.el, md(blk.text) + '<span class="cursor"></span>');
      // 流式期间不做 hljs 高亮（O(n²) 每帧重高亮是长回卡顿根因，P1 修复 2026-10-10 审计）——定稿由 finalizeAssistant 一次高亮
    } else {
      blk.el.textContent = blk.text;
      if (blk.streamEl) {
        blk.streamEl.textContent = blk.text; // 思考流单行横向同步（对齐策略由 CSS 承担，零 JS 滚动）
        syncThinkCut(blk.streamEl); // 溢出才挂 cut：左缘渐隐只在头部被裁时出现，未满一行时首字从左缘清晰可见
      }
    }
    scrollBottom(false);
  });
}

/* 思考块构建（2026-10-10 zcode 式改版）：折叠态=单行横向流式（▸ + ticker，尾部可见），
   点开=完整框（thinking-body 全文 pre-wrap）。streaming 与 finalize 两路共用。 */
function mkThinking() {
  const d = document.createElement("details");
  d.className = "thinking";
  const sum = document.createElement("summary");
  const lab = el("span", "think-label");
  lab.textContent = "思考过程";
  const stream = el("div", "think-stream");
  const txt = el("span", "think-txt");
  stream.appendChild(txt);
  sum.append(lab, stream);
  const body = el("div", "thinking-body");
  d.append(sum, body);
  return { d, txt, body };
}
window.__mkThinking = mkThinking; // CDP 验证钩子（生产无害）
/* CDP 验证钩子（生产无害，同 __mkThinking 惯例）：E1.1 间隙弱化 / E1.3 长输出 elide / E2.1 /approve 零 token 断言用 */
window.__testUser = (t) => addUserBubble(t ?? "u");
window.__testAssistant = (content) => { beginAssistant(); finalizeAssistant({ role: "assistant", content }); };
window.__testHistory = (msgs) => renderHistory(msgs);
window.__testToolcard = (bigText) => {
  beginAssistant();
  const card = getCard("__t1", "bash");
  setCardArgs(card, { command: "echo hi" });
  appendCardOutput(card, bigText);
  finishCard(card, bigText, false, undefined, 1500);
  window.__lastCard = card; // 卡片引用留给 CDP 侧点击展开/收拢断言
  return { cls: card.root.className, out: card.outEl.textContent, hasMore: !!card.outMore };
};

/* 思考 ticker 溢出判定：溢出时挂 cut（左缘渐隐 mask + 交还容器 flex-end 尾部锚定），
   未溢出时首字从左缘进入、向右自然增长（2026-10-10 owner 拍板）。txt.scrollWidth=文本全宽
   （nowrap 不收缩），容器左溢不计 scrollWidth（首版踩坑），故用 txt 对容器宽比较。 */
function syncThinkCut(txtEl) {
  const box = txtEl?.parentElement; // .think-stream 容器
  if (box) box.classList.toggle("cut", txtEl.scrollWidth > box.clientWidth);
}
window.__syncThinkCut = syncThinkCut; // CDP 验证钩子（生产无害）

/* E1.1 间隙弱化（2026-10-11 计划书，形态 A）：本轮（相邻 user 消息之间）已渲染的 text 块元素，
   toolCall 到达时统一打 .loose——位于后续工具调用之前的文本即「间隙消息」，回合最终消息不受影响 */
let looseLive = [];
function markLooseNow() {
  for (const w of looseLive) w.classList.add("loose");
}

function ensureBlock(idx, kind) {
  if (!curMsg) beginAssistant();
  let blk = curMsg.blocks.get(idx);
  if (!blk) {
    blk = { kind, text: "" };
    if (kind === "thinking") {
      const { d, txt, body } = mkThinking();
      curMsg.bubble.appendChild(d); // 折叠态单行横向流式（2026-10-10 owner 拍板 zcode 式），点开看全文
      blk.el = body;
      blk.streamEl = txt;
      blk.container = d;
    } else {
      const w = el("div", "md");
      curMsg.bubble.appendChild(w);
      blk.el = w;
      blk.container = w;
      looseLive.push(w);
    }
    curMsg.blocks.set(idx, blk);
  }
  return blk;
}

/* ---- 工具卡片 ---- */

function makeCard(_callId, toolName, parent) {
  const root = el("div", "tool-card running open");
  if (!hydrating) root.classList.add("enter"); // R3：同上
  root.innerHTML = `
    <div class="tool-head">
      <span class="tool-chevron">▶</span>
      <span class="tool-icon"><svg class="ic ic-s"><use href="#i-tool"/></svg></span>
      <span class="tool-name"></span>
      <span class="tool-summary"></span>
      <span class="tool-status">准备中…</span>
    </div>
    <div class="tool-body">
      <pre class="tool-args"></pre>
      <pre class="tool-output hidden"></pre>
    </div>`;
  root.querySelector(".tool-name").textContent = toolName;
  root.querySelector(".tool-head").addEventListener("click", () => root.classList.toggle("open"));
  parent.appendChild(root);
  return {
    root,
    toolName,
    statusEl: root.querySelector(".tool-status"),
    argsEl: root.querySelector(".tool-args"),
    outEl: root.querySelector(".tool-output"),
    summaryEl: root.querySelector(".tool-summary"),
    argsSet: false,
    startedAt: hydrating ? 0 : Date.now(), // 实时卡记起点：durationMs 缺失时兑底自算（1.1.0 官方值优先）
  };
}

function getCard(callId, toolName) {
  if (!curMsg) beginAssistant();
  markLooseNow(); // E1.1：工具调用到达，本轮此前文本全是间隙
  let card = curMsg.cards.get(callId);
  if (!card) {
    card = makeCard(callId, toolName ?? "tool", curMsg.bubble);
    curMsg.cards.set(callId, card);
  }
  return card;
}

function toolSummaryLine(_name, args) {
  if (!args) return "";
  const pick =
    args.command ?? args.path ?? args.file_path ?? args.query ??
    args.pattern ?? args.url ?? args.skill ?? args.collectionName;
  let s = typeof pick === "string" ? pick : JSON.stringify(args);
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

/* ---- 文件路径点击跳转：把 Windows 绝对路径变成可点击链接 ---- */
const WIN_PATH_RE = /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[A-Za-z0-9._\-]+/g;

function linkifyFilePaths(root) {
  if (!root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("a,.file-link") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.textContent;
    WIN_PATH_RE.lastIndex = 0;
    if (!WIN_PATH_RE.test(text)) continue;
    WIN_PATH_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = WIN_PATH_RE.exec(text))) {
      let p = m[0].replace(/\.+$/, "");
      if (p.length <= 3) continue; // 只有盘符的不算
      frag.append(document.createTextNode(text.slice(last, m.index)));
      const span = el("span", "file-link");
      span.textContent = p;
      span.dataset.path = p;
      frag.append(span);
      last = m.index + m[0].length;
    }
    frag.append(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}

function setCardArgs(card, args) {
  if (card.argsSet || !args) return;
  card.argsSet = true;
  card.argsEl.textContent = JSON.stringify(args, null, 2);
  linkifyFilePaths(card.argsEl);
  const s = toolSummaryLine(card.toolName, args);
  if (s) card.summaryEl.textContent = s;
  card.summaryEl.title = s;
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  return (content.content ?? content)
    .filter?.((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n") ?? "";
}

/* E1.3 长输出 elide（2026-10-11 计划书）：超阈值只显前段 + 卡内「展开全部」就地补全
   （查看器按文件路径寻址而工具输出非文件，故用卡内展开承接「全文」诉求） */
const OUTPUT_MAX_LINES = 200, OUTPUT_KEEP_LINES = 40;
function setCardOutput(card, text) {
  const lines = text.split("\n");
  card.fullOutput = text;
  if (lines.length > OUTPUT_MAX_LINES) {
    card.outEl.textContent = lines.slice(0, OUTPUT_KEEP_LINES).join("\n") + `\n…（共 ${lines.length} 行，已省略）`;
    if (!card.outMore) {
      const btn = el("button", "tool-out-more");
      btn.type = "button";
      btn.textContent = `展开全部 ${lines.length} 行`;
      btn.addEventListener("click", () => {
        card.outEl.textContent = card.fullOutput;
        linkifyFilePaths(card.outEl);
        btn.remove();
        card.outMore = null;
      });
      card.outEl.after(btn);
      card.outMore = btn;
    }
  } else {
    card.outEl.textContent = text;
    if (card.outMore) { card.outMore.remove(); card.outMore = null; }
  }
  linkifyFilePaths(card.outEl);
}

function appendCardOutput(card, partialResult) {
  const t = extractText(partialResult);
  if (t) {
    card.outEl.classList.remove("hidden");
    setCardOutput(card, t);
  }
}

/* 工具耗时格式化（2026-10-08 Q2/Q8）：官方 durationMs 优先，兑底自算 */
function fmtToolDur(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = ms / 1000;
  if (s >= 60) return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return s >= 10 ? Math.round(s) + "s" : s.toFixed(1) + "s";
}

function finishCard(card, result, isError, statusText, durationMs) {
  card.root.classList.remove("running");
  card.root.classList.add(isError ? "error" : "done");
  const t = extractText(result);
  if (t) {
    card.outEl.classList.remove("hidden");
    setCardOutput(card, t);
  }
  const base = statusText ?? (isError ? "失败" : t ? "完成" : "完成（无输出）");
  const dur = fmtToolDur(durationMs);
  card.statusEl.textContent = dur ? `${base} · ${dur}` : base;
  card.root.classList.remove("open"); // 完成后折叠
}

/* ---- 消息定稿（message_end 权威重绘） ---- */

function finalizeAssistant(msg, looseIdx) {
  if (!curMsg) beginAssistant();
  const { bubble, cards } = curMsg;
  // P2 修复：流式中用户点开的思考折叠态，message_end 权威重绘后保持（原样重建会强制折叠）
  const openThink = new Set();
  const loosePrev = new Set(); // E1.1：流式中已被标 loose 的 text 块，权威重绘保持
  for (const [idx, blk] of curMsg.blocks) {
    if (blk.kind === "thinking" && blk.container?.open) openThink.add(idx);
    else if (blk.kind === "text" && blk.el?.classList.contains("loose")) loosePrev.add(idx);
  }
  bubble.innerHTML = "";
  curMsg.blocks.clear();

  // 空回合清理（如 steer 送达后模型回的空消息）：移除整个头像+气泡，不留孤印（2026-10-03）
  const hasContent = (msg.content ?? []).some((b) =>
    (b.type === "text" && b.text?.trim()) || b.type === "thinking" || b.type === "toolCall");
  if (!hasContent) {
    bubble.parentElement?.remove();
    curMsg = null;
    return;
  }

  let blockIdx = -1;
  for (const block of msg.content ?? []) {
    blockIdx++;
    if (block.type === "text") {
      if (!block.text?.trim()) continue;
      const w = el("div", "md");
      if (loosePrev.has(blockIdx) || looseIdx?.has(blockIdx)) w.classList.add("loose"); // E1.1 间隙弱化（历史回放走 looseIdx 预算集）
      setHtml(w, md(block.text));
      highlightIn(w);
      linkifyFilePaths(w);
      bubble.appendChild(w);
      looseLive.push(w); // 同轮后续消息的 toolCall 仍可将其标为间隙
    } else if (block.type === "thinking") {
      const { d, txt, body } = mkThinking();
      txt.textContent = block.thinking ?? ""; // 折叠态单行也留思考尾部（一眼可辨末尾思路）
      body.textContent = block.thinking ?? "";
      if (openThink.has(blockIdx)) d.open = true; // 用户流式中展开过：重绘保持展开
      bubble.appendChild(d);
      syncThinkCut(txt); // append 后再测宽（clientWidth 需已在布局树，历史回放长文本同样溢出渐隐）
    } else if (block.type === "toolCall") {
      markLooseNow(); // E1.1：重建路径同样按块序标记（此前的 text 已登记，后面的还没登记）
      const id = block.id ?? block.callId;
      const card = cards.get(id) ?? makeCard(id, block.toolName ?? block.name ?? "tool", bubble);
      cards.set(id, card);
      bubble.appendChild(card.root);
      setCardArgs(card, block.arguments ?? block.args ?? {});
    }
  }

  // 消息级元信息：模型角标 + token 用量（owner 2026-10-06，修正版）——assistant 消息自带 provider/model/usage，
  // 历史回放同源准确；复制按钮在 owner 自己的发言底下（addUserBubble），不在此处
  if (msg.model && (msg.content ?? []).some((b) => b.type === "text" && b.text?.trim())) {
    const meta = el("div", "msg-meta");
    const badge = el("span", "msg-model-badge");
    badge.textContent = msg.model;
    badge.title = msg.provider + "/" + msg.model + (msg.responseModel && msg.responseModel !== msg.model ? " → " + msg.responseModel : "");
    meta.appendChild(badge);
    // 思考强度（owner 2026-10-07：模型与 token 中间，英文档名）：assistant 消息自带 thinkingLevel
    if (msg.thinkingLevel) {
      const th = el("span", "msg-think-badge");
      th.textContent = msg.thinkingLevel;
      th.title = "thinking: " + msg.thinkingLevel;
      meta.appendChild(th);
    }
    if (msg.usage) {
      const tk = el("span", "msg-tokens");
      tk.textContent = `↑${msg.usage.input ?? 0} ↓${msg.usage.output ?? 0}`;
      tk.title = `input ${msg.usage.input ?? 0}\ncacheRead ${msg.usage.cacheRead ?? 0}\ncacheWrite ${msg.usage.cacheWrite ?? 0}\noutput ${msg.usage.output ?? 0}`;
      meta.appendChild(tk);
    }
    bubble.appendChild(meta);
  }

  const u = msg.usage;
  if (u) {
    lastUsage = u;
    // 每条回复的 token 用量已改在消息元信息行呈现（2026-10-06）；此处仅驱动 ContextRing
    updateCtxRing();
  }
  scrollBottom(false);
}

/* ---- ContextRing：上下文用量环（R3 质感，2026-10-04）----
 * 估算 = 最近一次请求 input + cacheRead + cacheWrite 占当前模型 contextWindow 比例。
 * 静态语义色：常态墨灰，≥70% 琥珀，≥90% 朱砂（owner 反馈闪烁烦人，无循环动效） */
function updateCtxRing() {
  const ring = $("ctx-ring");
  if (!ring) return;
  const cw = state?.model?.contextWindow;
  const u = lastUsage;
  if (!cw || !u) { ring.classList.add("hidden"); return; }
  const ctx = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const pct = Math.max(0, Math.min(1, ctx / cw));
  const C = 2 * Math.PI * 6;
  const prog = ring.querySelector(".cr-prog");
  prog.style.strokeDasharray = String(C);
  prog.style.strokeDashoffset = String(C * (1 - pct));
  prog.classList.toggle("warn", pct >= 0.7 && pct < 0.9);
  prog.classList.toggle("hot", pct >= 0.9);
  ring.classList.remove("hidden");
  ring.querySelector(".cr-num").textContent = pct >= 0.005 ? Math.round(pct * 100) + "%" : "";
  ring.title = `上下文约 ${ctx.toLocaleString()} / ${cw.toLocaleString()} tokens（${(pct * 100).toFixed(1)}%，接近上限会自动压缩）`;
}


/* ================= 运行状态 ================= */

let runGen = 0;

function setRunning(v) {
  running = v;
  $("btn-send").classList.toggle("hidden", v);
  $("btn-abort").classList.toggle("hidden", !v);
  input.disabled = false; // 运行中仍可输入（走 followUp 排队）
  const st = $("status-state");
  st.textContent = v ? "运行中…" : "空闲";
  st.classList.toggle("busy", v);
  $("status-dot").className = "st-dot " + (v ? "busy" : "idle");
}

async function doPrompt(text, images) {
  const gen = ++runGen;
  setRunning(true);
  showPhase("prep");
  if (curMsg) curMsg.sawAgent = false;
  try {
    await window.pi.prompt(text, images);
  } catch (err) {
    showNotice(String(err?.message ?? err), true);
    hidePhase();
  }
  // 兜底：若该输入被扩展命令/模板直接处理（无 agent_start），延迟解锁
  setTimeout(() => {
    if (gen === runGen && running && !curMsg?.sawAgent) { setRunning(false); hidePhase(); }
  }, 1500);
}

/* ================= 事件处理 ================= */

function handleEvent(evt) {
  if (!evt || typeof evt !== "object") return;
  // Todo 面板：任何会话（含后台）的 todo 结果都进快照缓存，仅当前会话驱动渲染——
  // 必须放在下面的多会话过滤器之前，否则后台会话的快照丢失
  if (evt.type === "tool_execution_end" && evt.toolName === "todo" && !evt.isError) {
    todoApplySnapshot(evt.sessionId, evt.result?.details?.tasks ?? evt.result?.tasks);
  }
  // 多会话：非当前会话的事件只刷新侧栏运行标记，不渲染内容（后台会话任务继续跑，互不干扰）
  if (evt.sessionId !== undefined && state?.sessionId && evt.sessionId !== state.sessionId) {
    // R3 状态语义：后台会话完成且未查看 → 绿点徽标（查看即消；重新开跑即清）
    if (evt.type === "agent_settled" && evt.sessionPath) unreadPaths.add(evt.sessionPath);
    else if (evt.type === "agent_start" && evt.sessionPath) unreadPaths.delete(evt.sessionPath);
    if (evt.type === "agent_start" || evt.type === "agent_settled") renderSidebarTreeSoon();
    return;
  }

  switch (evt.type) {
    case "agent_start": {
      runGen++;
      setRunning(true);
      renderSidebarTree(); // 新会话首条消息已落盘（prompt 先追加 user 消息再起 agent），立刷侧栏让其出现（2026-10-10 owner 报障：此前要点其他会话才出现）
      turnStart = Date.now(); // 轮末 chip 计时起点（R3）
      if (curMsg) curMsg.sawAgent = true;
      hideNotice();
      showPhase("wait"); // 阶段推进：请求已进入模型，等待首 token（TTFT）
      renderSidebarTreeSoon(); // 当前会话起跑：轻刷运行标记（戊批防抖——多会话并行时一轮 start+settle 合并一次重建）
      // Todo 面板：新一轮开始，completed 行退场（对齐 rpiv-todo 语义）；本轮有新快照会自动恢复
      if (todoBySession.has(state?.sessionId)) {
        todoTurnActive = true;
        renderTodoPanel();
      }
      break;
    }

    case "message_start": {
      if (evt.message?.role === "assistant") beginAssistant();
      break;
    }

    case "message_update": {
      const e = evt.assistantMessageEvent;
      if (!e) break;
      if (e.type === "text_delta") {
        const blk = ensureBlock(e.contentIndex, "text");
        blk.text += e.delta;
        scheduleRender(blk);
      } else if (e.type === "thinking_delta") {
        const blk = ensureBlock(e.contentIndex, "thinking");
        blk.text += e.delta;
        scheduleRender(blk);
      } else if (e.type === "toolcall_start") {
        getCard(e.id, e.toolName);
      } else if (e.type === "toolcall_end") {
        const tc = e.toolCall ?? {};
        const id = tc.id ?? e.id;
        const card = getCard(id, tc.toolName ?? tc.name);
        setCardArgs(card, tc.arguments ?? tc.args ?? {});
      }
      // text_end / thinking_end 等中间快照交给 message_end 权威重绘
      break;
    }

    case "tool_execution_start": {
      pendingArgs[evt.toolCallId] = evt.args;
      const card = getCard(evt.toolCallId, evt.toolName);
      setCardArgs(card, evt.args);
      card.statusEl.textContent = "运行中…";
      break;
    }

    case "tool_execution_update": {
      const card = curMsg?.cards.get(evt.toolCallId);
      if (card) appendCardOutput(card, evt.partialResult);
      break;
    }

    case "tool_execution_end": {
      const card = curMsg?.cards.get(evt.toolCallId);
      // 1.1.0 官方 durationMs 优先（剔除了 wall-clock 噪音）；缺失时兑底自算（Q2/Q8 拍板）
      if (card) {
        const dur = typeof evt.durationMs === "number" ? evt.durationMs : (card.startedAt ? Date.now() - card.startedAt : undefined);
        finishCard(card, evt.result, evt.isError, undefined, dur);
      }
      if (evt.toolName === "write" || evt.toolName === "edit") {
        recordChange(evt.toolName, pendingArgs[evt.toolCallId] ?? {}, evt.isError);
      }
      delete pendingArgs[evt.toolCallId];
      break;
    }

    case "message_end": {
      const m = evt.message;
      if (m?.role === "assistant") finalizeAssistant(m);
      break;
    }

    case "agent_end":
      break;

    case "agent_settled": {
      setRunning(false);
      hidePhase(); // 阶段占位清理（兜底：无 assistant 输出的回合也撤）
      renderSidebarTreeSoon(); // 当前会话侧栏刷新（戊批防抖，同上；落盘竞态由 150ms 后的全量刷兜底）
      refreshCtxBar(); // 任务结束往往动过文件，刷新上下文条 git 态
      scheduleTreeRefresh(); // 树自动刷新已展开目录（2026-10-06 设计轮：树须反映真实磁盘）
      // R3 轮末 chip：耗时 + 本轮变更文件数与行数增减；1.1.0 aborted 字段区分取消轮（Q1/Q7）
      if (turnStart && curMsg) renderTurnChip(Date.now() - turnStart, evt.aborted === true);
      turnStart = 0;
      // 兜底：中途打断时把仍在运行的卡片标记为已停止（附已运行时长）
      if (curMsg) {
        for (const card of curMsg.cards.values()) {
          if (card.root.classList.contains("running")) {
            finishCard(card, null, false, "已停止", card.startedAt ? Date.now() - card.startedAt : undefined);
          }
        }
      }
      break;
    }

    case "host_error": {
      showNotice("错误：" + evt.message, true);
      setRunning(false);
      hidePhase();
      break;
    }

    case "cmp_event": {
      cmpHandleEvent(evt);
      break;
    }

    case "aux_event": {
      auxHandleEvent(evt); // 无 sessionId 全局事件，自带 cwd 归属过滤
      break;
    }

    case "web_event": {
      // 浏览器 tab 状态推送（无 sessionId，全局事件）：更新 tab 名/地址栏/导航按钮态
      const wtab = vwTabs.find((t) => t.webId === evt.tabId);
      if (!wtab) break;
      if (evt.title) wtab.name = evt.title;
      if (evt.url) wtab.url = evt.url;
      wtab.data = { loading: !!evt.loading };
      const isActive = activeVwTab() === wtab;
      if (isActive) renderVwTabs();
      if (isActive && wtab.path === vwActivePath) {
        const urlInput = document.getElementById("vw-web-url");
        if (urlInput && document.activeElement !== urlInput) urlInput.value = evt.url && evt.url !== "about:blank" ? evt.url : "";
        const bar = document.getElementById("vw-web-bar");
        if (bar) {
          const bb = bar.querySelector(".vw-web-back");
          const fb = bar.querySelector(".vw-web-fwd");
          if (bb) bb.disabled = !evt.canBack;
          if (fb) fb.disabled = !evt.canFwd;
          const rb = bar.querySelector(".vw-web-reload");
          if (rb) rb.title = evt.loading ? "刷新（加载中点击=停止）· 加载中…" : "刷新";
        }
      }
      break;
    }

    case "subagent_status": {
      // 面板已删（2026-10-08 owner 拍板）：事件无人消费，直接忽略（工具层推送链保留，零成本）
      break;
    }

    case "cmp_done": {
      if (cmpActive && evt.cmpId === cmpActive.id) {
        cmpActive.finished = true;
        $("cmp-status").textContent = `完成，耗时 ${((evt.ms ?? 0) / 1000).toFixed(1)}s`;
        $("cmp-run").disabled = false;
      }
      break;
    }

    default: {
      // 防御式处理压缩/重试类事件（不同版本命名可能不同）；手动 /压缩 期间不插手（迟到的压缩事件会 hideNotice 干掉结果反馈，2026-10-07 实测）
      const t = String(evt.type);
      if (t.includes("compaction")) {
        if (!manualCompact) {
          if (t.includes("start")) showNotice("上下文接近上限，正在压缩…", false, true);
          else hideNotice();
        }
      } else if (t.includes("retry") && t.includes("start")) {
        showNotice("模型请求失败，自动重试中…", false, true);
      } else if (t.includes("retry") && t.includes("end")) {
        hideNotice();
      }
    }
  }
  scrollBottom(false);
}

/* ================= 右栏：文件树 / 变更 ================= */

$("btn-hide-rightbar").addEventListener("click", () => {
  document.body.classList.add("rightbar-collapsed");
  $("btn-show-rightbar").classList.remove("hidden");
});
$("btn-show-rightbar").addEventListener("click", () => {
  document.body.classList.remove("rightbar-collapsed");
  $("btn-show-rightbar").classList.add("hidden");
});

/* ---- 右栏宽度可拖（2026-10-08 计划书阶段一）：主区与右栏间拖条，260–520px，localStorage 记忆 ----
 * 交互照抄 viewer-split 拖条（mousedown/move/up 挂 document）；拖动结束落库并通知图谱 refit
 * （图谱侧由 ResizeObserver 监听 wrap 尺寸自愈，此处无需直呼）。 */
const rightbarEl = $("rightbar");
const RB_W_MIN = 260;
const RB_W_MAX = 520;
function applyRbWidth(w) {
  const clamped = Math.min(RB_W_MAX, Math.max(RB_W_MIN, Math.round(w)));
  rightbarEl.style.width = clamped + "px";
  window.__rbWidth = clamped; // 验证钩子
  return clamped;
}
(function initRbWidth() {
  const saved = Number(localStorage.getItem("pi-gui:rbw"));
  if (Number.isFinite(saved) && saved >= RB_W_MIN && saved <= RB_W_MAX) applyRbWidth(saved);
})();
$("rightbar-split").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  const splitEl = e.currentTarget;
  splitEl.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  const startX = e.clientX;
  const startW = rightbarEl.getBoundingClientRect().width;
  let lastW = Math.round(startW); // move 累积值落库：无头/隐藏窗口 rect 读数滞后（布局节流），mouseup 不回读 rect
  const move = (ev) => { lastW = applyRbWidth(startW + (startX - ev.clientX)); };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    splitEl.classList.remove("dragging");
    document.body.style.cursor = "";
    localStorage.setItem("pi-gui:rbw", String(lastW));
    window.__rbWidth = lastW;
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

/* ---- 发送模式（排队/插话）：按钮已删，用 /排队 /插话 切换（2026-10-03） ---- */

/* ---- 场景档位（2026-10-10 owner 拍板；2026-10-12 开源改造）：一键切思考强度 ----
 * 三档跟随 settings 默认模型（R4-3 权威源）只切档位——工作=high/深想=max/日常=low（GLM 真实域三档，
 * 原硬编码 zai glm-5.3 对无智谱凭据的用户必坏；他模型缺档由 setThinkingLevel 静默 clamp 到最近真实档）。
 * 默认模型未配置（全新用户）→ SCENES 空，三钮全灭走「自定」态，点击仍跳设置模型页。
 * 当前组合不在档内（设置中心切模型/带图自动切视觉模型等）→ 亮出灰色「自定」。
 * 顺序铁律：先 setModel 再 setThinkingLevel（换模型会重置思考档，反序会被吃掉）。
 * 刷新时机：init 与设置页改默认模型后（refreshScenes）。 */
let SCENES = [];
async function refreshScenes() {
  try {
    const d = await window.pi.settingsDefaultModel("get");
    if (d?.provider && d?.model) {
      const ref = d.provider + "|" + d.model;
      // 三档值按当前模型真实可用档位动态选取（2026-10-13：不同端点能力不同——如智谱兼容端点仅
      // off/low/medium/high 无 max，硬编码会被静默 clamp 出假故障；语义固定、值自适应）
      let levels = [];
      try { levels = (await window.pi.sessionThinkingLevels()) ?? []; } catch { levels = []; }
      const strong = ["max", "xhigh", "high", "medium", "low", "minimal"].filter((l) => levels.includes(l));
      const workLv = strong.includes("high") ? "high" : (strong[strong.length - 1] ?? "low");
      const deepLv = strong[0] ?? workLv;
      const chatLv = strong.includes("low") ? "low" : (strong[strong.length - 1] ?? workLv);
      SCENES = [
        { key: "work", label: "工作", ref, level: workLv },
        { key: "deep", label: "深想", ref, level: deepLv },
        { key: "chat", label: "日常", ref, level: chatLv },
      ];
    } else {
      SCENES = [];
    }
    syncSceneSeg();
  } catch { /* 设置读取失败保持现状 */ }
}
function sceneOf(st) {
  if (!st?.model) return null;
  const ref = st.model.provider + "|" + st.model.id;
  const lv = st.thinkingLevel ?? "medium"; // 对齐 getState 的缺省语义
  return SCENES.find((s) => s.ref === ref && s.level === lv) ?? null;
}
function syncSceneSeg() {
  const hit = sceneOf(state);
  const deepSameAsWork = SCENES.length > 0 && SCENES[1].level === SCENES[0].level; // 模型最高档=high 时深想与工作重合
  for (const btn of document.querySelectorAll("#scene-seg .scene-btn")) {
    if (btn.dataset.scene === "_custom") btn.hidden = !!hit;
    else {
      btn.classList.toggle("on", hit?.key === btn.dataset.scene);
      const dis = btn.dataset.scene === "deep" && deepSameAsWork;
      btn.disabled = dis;
      btn.title = dis ? "当前模型最高思考档即 high，与「工作」相同" : "";
    }
  }
}
async function applyScene(sc) {
  const [provider, id] = sc.ref.split("|");
  visionAutoPrev = ""; // 手动切换即接管，清除视觉自动回切状态（沿用旧 model-select 语义）
  try {
    state = await window.pi.setModel(provider, id);
    await window.pi.setThinkingLevel(sc.level);
    state = await window.pi.getState();
    // 回读兜底（2026-10-13 三档锁死 bug 教训）：模型缺 reasoning 声明等情况下 setThinkingLevel 会被
    // 静默 clamp/忽略——回读不符给红条明示，不再无声无息
    if (state.thinkingLevel !== sc.level) {
      showNotice(`思考档未切到「${{ high: "高", max: "最大", low: "低" }[sc.level] ?? sc.level}」（当前 ${state.thinkingLevel}）——模型可能不支持该档，可到 设置 → 模型与提供商 手调`, true);
    }
  } catch (err) {
    showNotice("场景切换失败：" + (err?.message ?? err), true);
  }
  syncSceneSeg();
  renderSidebar();
  updateCtxRing(); // 模型换了 contextWindow 可能变，环基数同步（R3）
  void refreshScenes(); // 切换后重算三档：换模型/档位可能改变可用档集合（动态适配）
}
for (const btn of document.querySelectorAll("#scene-seg .scene-btn")) {
  btn.addEventListener("click", () => {
    if (btn.dataset.scene === "_custom") {
      stTab = "models"; // 先定目标 tab，让 openSettings 内部单次 stSwitchTab 渲染——连续两次 stRenderModels 异步并发会交错追加/冲掉尾部 chips（2026-10-10 实测复现）
      openSettings();
      return;
    }
    const sc = SCENES.find((s) => s.key === btn.dataset.scene);
    if (sc) void applyScene(sc);
    else { stTab = "models"; openSettings(); } // 默认模型未配置（SCENES 空）——引导去设置
  });
}

/* ---- 项目树（2026-10-06 设计轮重构）：定位 + 结构化主职责 ----
 * 多根：工作区根（专属色轮转，点名切换）+ 收藏目录根（任意文件夹，纯浏览不建会话）；
 * 单击文件=@引用、双击=查看器 tab、右键菜单、过滤（含未展开目录）+ 显示隐藏开关、
 * agent_settled 后自动刷新已展开目录；路径定位展开+闪烁（chip/路径点击共用）。 */
const fileTreeEl = $("file-tree");
const treeResultsEl = $("tree-results");
const filterRowEl = $("tree-filter-row");
const filterInputEl = $("tree-filter-input");
const ctxMenuEl = $("ctx-menu");
const WS_COLOR_KEYS = ["cinnabar", "indigo", "pine", "ochre", "plum", "umber"];

let treeRoots = []; // [{kind:'ws'|'fav', id, cwd, name, color?}]
const treeExpanded = new Set(); // 展开的目录绝对路径（运行内，不跨重启）
const dirCache = new Map(); // path → entries[] | null（不可读）；showHidden 变更/ settled 刷新时清
let showHidden = localStorage.getItem("pi-gui:tree-hidden") === "1";
let treeDataSeq = 0; // 数据代际：隐藏开关/刷新后作废在途懒加载

function fullPath(dir, name) {
  return dir.replace(/[\\/]+$/, "") + "\\" + name;
}
function parentOf(p) {
  const i = String(p).lastIndexOf("\\");
  return i > 0 ? String(p).slice(0, i) : String(p);
}
function isUnder(p, root) {
  return (
    typeof p === "string" && typeof root === "string" && p.length > root.length + 1 &&
    p.toLowerCase().startsWith(root.toLowerCase()) && "\\/".includes(p[root.length])
  );
}
const cssEscape = (s) => CSS.escape(String(s));

function insertAtCursor(text) {
  const s = input.selectionStart ?? input.value.length;
  const epos = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, s) + text + input.value.slice(epos);
  input.selectionStart = input.selectionEnd = s + text.length;
}

/* 文件行手势（2026-10-06 owner 拍板对调）：单击=查看器 tab（同路径去重聚焦），双击=@ 引用。
 * 单/双击靠 230ms 定时器判别：双击的前两下 click 撤销定时器、不开查看器；
 * 也根治旧版反向手势下「双击查看反被两下单击连插两个 @」的重复引用。 */
function bindFileGestures(row, full) {
  let clickTimer = 0;
  row.addEventListener("click", () => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0; return; } // 第二击：交给 dblclick
    clickTimer = setTimeout(() => { clickTimer = 0; openViewerTab(full); }, 230);
  });
  row.addEventListener("dblclick", (e) => {
    e.preventDefault();
    insertAtCursor("@" + full + " ");
    input.focus();
  });
}

async function readDirCached(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  const r = await window.pi.readDir(dir, showHidden);
  const v = r.error ? null : r.entries;
  dirCache.set(dir, v);
  return v;
}

function svgUse(href, cls) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", href);
  svg.appendChild(use);
  return svg;
}

/* 树行图标 span（DOM 构建替代 innerHTML 拼静态 SVG） */
function iconSpan(cls, href, hidden) {
  const s = el("span", "t-icon " + cls);
  if (hidden) s.style.visibility = "hidden";
  s.append(svgUse(href, "ic ic-s"));
  return s;
}

/* 展开态渲染：同步 DOM 开合 + 箭头旋转 + 文件夹开/合两态图标（收藏根书签图标不变） */
function setExpanded(children, open) {
  children.classList.toggle("hidden", !open);
  const headRow = children.previousElementSibling; // .tree-row 或 .proj-head
  const chev = headRow?.querySelector(":scope > .t-chevron svg, :scope > .t-icon.t-chevron svg");
  if (chev) chev.style.transform = open ? "rotate(90deg)" : "";
  const fu = headRow?.querySelector(".t-ficon use, .proj-ic use");
  if (fu && fu.getAttribute("href") !== "#i-bookmark") {
    fu.setAttribute("href", open ? "#i-folder-open" : "#i-folder");
  }
}

async function ensureChildrenLoaded(children, dir) {
  if (children.dataset.loaded === "1") return;
  children.dataset.loaded = "1";
  const seq = treeDataSeq;
  const loading = el("div", "tree-loading");
  loading.textContent = "加载中…";
  children.replaceChildren(loading);
  const entries = await readDirCached(dir);
  if (seq !== treeDataSeq || !children.isConnected) {
    children.dataset.loaded = ""; // 代际已换：作废本次结果，待下次展开重读
    children.replaceChildren();
    return;
  }
  children.replaceChildren();
  if (!entries) {
    const e = el("div", "tree-loading");
    e.textContent = "（目录不可读）";
    children.appendChild(e);
    return;
  }
  if (!entries.length) {
    const e = el("div", "tree-loading");
    e.textContent = "（空目录）";
    children.appendChild(e);
    return;
  }
  for (const ent of entries) children.appendChild(makeEntryNode(ent, dir));
}

async function toggleDir(children) {
  const dir = children.dataset.path;
  const willOpen = children.classList.contains("hidden");
  if (willOpen) {
    treeExpanded.add(dir);
    await ensureChildrenLoaded(children, dir);
  } else {
    treeExpanded.delete(dir);
  }
  setExpanded(children, willOpen);
}

function containerByPath(p) {
  return fileTreeEl.querySelector(`.tree-children[data-path="${cssEscape(p)}"]`);
}

/* 目录/文件行：单击目录=展开、单击文件=@；双击文件=查看器；右键=菜单 */
function makeEntryNode(ent, parentDir) {
  const full = fullPath(parentDir, ent.name);
  const node = el("div", "tree-node");
  const row = el("div", "tree-row");
  row.dataset.dir = ent.dir ? "1" : "0";
  row.dataset.full = full;
  if (ent.dir) {
    row.append(iconSpan("t-chevron", "#i-chev-r"), iconSpan("t-ficon", "#i-folder"), el("span", "t-name"));
    const children = el("div", "tree-children hidden");
    children.dataset.path = full;
    row.title = full + "\n单击/双击：展开　右键：更多";
    row.addEventListener("click", () => void toggleDir(children));
    row.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (!treeExpanded.has(full)) void toggleDir(children); // 双击与单击等效：归一到展开态
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showDirMenu(e, full, false, null);
    });
    node.append(row, children);
    if (treeExpanded.has(full)) {
      setExpanded(children, true);
      void ensureChildrenLoaded(children, full);
    }
  } else {
    row.append(iconSpan("t-chevron", "#i-chev-r", true), iconSpan("t-ficon", "#i-file"), el("span", "t-name"));
    row.title = full + "\n单击：查看　双击：@ 引用　右键：更多";
    bindFileGestures(row, full);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showFileMenu(e, full);
    });
    node.appendChild(row);
  }
  row.querySelector(".t-name").textContent = ent.name;
  bindKbd(row, () => row.click(), "option"); // 键盘批：树行 Enter=单击语义（展开/查看）
  return node;
}

/* 根节点：工作区=点名切换（恢复最近会话）；收藏目录=点名展开；均为右键菜单 */
function makeRootGroup(root) {
  const isWs = root.kind === "ws";
  const active = isWs && root.cwd === state?.cwd;
  const group = el(
    "div",
    "proj-group" + (isWs ? " wc-" + root.color : "") + (active ? " active" : "")
  );
  group.dataset.kind = root.kind;
  group.dataset.wsId = root.id;
  group.dataset.cwd = root.cwd;
  const head = el("div", "proj-head");
  head.title =
    root.cwd + "\n" +
    (isWs ? "点击：切换到此工作区（恢复最近会话，无则不动；进行中任务不受影响）" : "点击：展开/折叠目录树（收藏目录，纯浏览不建会话）") +
    "\n箭头：展开/折叠　右键：开新会话/换色等更多";
  const chevSpan = el("span", "t-icon t-chevron");
  const chev = svgUse("#i-chev-r", "ic ic-s"); // chevron 旋转靠这个 svg 的 transform
  chevSpan.appendChild(chev);
  const rootIc = svgUse(isWs ? "#i-folder" : "#i-bookmark", "ic ic-s proj-ic");
  const nameSpan = el("span", "proj-name");
  nameSpan.textContent = root.name;
  head.append(chevSpan, rootIc, nameSpan);
  const children = el("div", "tree-children hidden");
  children.dataset.path = root.cwd;
  chevSpan.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleDir(children);
  });
  head.addEventListener("click", async () => {
    if (!isWs) {
      void toggleDir(children);
      return;
    }
    if (root.cwd === state?.cwd) return; // 已在此工作区
    try {
      // 恢复该工作区最近会话（排序与左栏一致）；无会话不自动新建（2026-10-06 owner 拍板），右键「在此开新会话」
      const data = await window.pi.wsSessions(root.cwd).catch(() => ({ sessions: [] }));
      const latest = (data.sessions ?? [])[0];
      if (!latest) return; // 无会话不新建也不弹条（2026-10-06 owner 拍板：黄色弹窗永远不要）；右键开新会话
      await window.pi.wsSetActive(root.id);
      await startSession(root.cwd, latest.path);
    } catch (err) {
      showNotice("切换工作区失败：" + (err?.message ?? err), true);
    }
  });
  head.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showDirMenu(e, root.cwd, true, root);
  });
  group.append(head, children);
  if (treeExpanded.has(root.cwd)) {
    setExpanded(children, true);
    void ensureChildrenLoaded(children, root.cwd);
  }
  return group;
}

/* ================= wiki 知识图谱（2026-10-08 owner 需求；同日阶段一交互重设计） =================
 * 项目框 📁/🕸 切换：工作区会话看本工作区 wiki/ 双链图，自由会话/未登记目录看全部工作区聚合总图。
 * 数据源主进程 wiki:graph（md 相对链接 + [[wikilink]]）；同步 300 步力导向（无持续动画，对齐 no-anim 纪律）。
 * 视图变换层（owner 实测痛点：无法拖拽缩放、节点出界）：布局产出 world 坐标，
 * screen = 画布中心 + world×scale + pan；空白拖拽平移、滚轮以光标为中心缩放（0.3–3x）、
 * 节点拖拽固定（位移 ≤4px 判单击开查看器）、加载后自动 fit 全部可见、工具条 fit 复位 + 缩放指示；
 * 容器尺寸变化（右栏拖宽等）经 ResizeObserver refit 自愈。 */
let graphMode = localStorage.getItem("pi-gui:graph-mode") === "1";
const graphWrap = $("wiki-graph-wrap");
const graphCanvas = $("wiki-graph");
const graphEmpty = $("wiki-graph-empty");
const graphZoomEl = $("graph-zoom");
let graphNodes = null; // [{path,name,group,deg,wx,wy}]（world 坐标）
let graphEdges = null; // [[i,j]]（索引）
let graphAdj = null; // i -> Set(j)
let graphView = { scale: 1, tx: 0, ty: 0 }; // screen = center + world×scale + t
let graphUserTouched = false; // 用户手动缩放/平移过（wheel/pan 置位；fit 按钮/数据重载复位）——RO 尺寸回调据此停用自动 refit
let graphHover = -1;
let graphTip = null;
let graphReloadTimer = 0;
let graphSeq = 0; // 代际：切会话/切图竞态作废旧绘制
let graphDrag = null; // {kind:'node'|'pan', i?, startX, startY, moved, origT?}
let graphHookMeta = { mode: null, host: null }; // 验证钩子用的数据归属（workspace|global）
let graphDataSig = ""; // 数据签名：未变时跳过重排版（保用户视图，防后台推送打回 fit）
const GRAPH_SCALE_MIN = 0.3;
const GRAPH_SCALE_MAX = 3;
const GRAPH_WORLD = 260; // 布局世界尺寸（px）：归一化力导向坐标 × 该值，与画布实际尺寸解耦

function scheduleGraphReload() {
  clearTimeout(graphReloadTimer);
  graphReloadTimer = setTimeout(() => void loadWikiGraph(), 400);
}

function setGraphMode(on) {
  graphMode = on;
  localStorage.setItem("pi-gui:graph-mode", on ? "1" : "0");
  $("btn-tree-graph").classList.toggle("graph-on", on);
  graphWrap.classList.toggle("hidden", !on);
  fileTreeEl.classList.toggle("hidden", on);
  if (on) {
    if (filterOn) setFilterRow(false); // 树专属功能，图模式下收起
    void loadWikiGraph();
  }
}

async function loadWikiGraph() {
  if (!graphMode || !state) return;
  const seq = ++graphSeq;
  let data = null;
  try { data = await window.pi.wikiGraph(state.cwd ?? null); } catch { data = null; }
  if (seq !== graphSeq || !graphMode) return; // 已切走/旧请求
  graphTip?.remove();
  graphTip = null;
  if (!data || data.mode === "error" || !Array.isArray(data.nodes) || !data.nodes.length) {
    graphNodes = null;
    graphEmpty.classList.remove("hidden");
    graphEmpty.textContent = !data || data.mode === "error" ? "图谱加载失败（" + (data?.error ?? "IPC") + "）" : "当前无 wiki：工作区根建 wiki/ 目录并按 SCHEMA.md 落页后此处出图";
    return;
  }
  graphEmpty.classList.add("hidden");
  graphHookMeta = { mode: data.mode, host: data.host ?? null };
  // 数据签名未变（后台 pi:state 推送反复触发重载）→ 跳过重排版：保留用户的缩放/平移与节点位置，
  // 不然 MCP 轮询期每次推送都把视图打回 fit 态（2026-10-08 verify-graph ② 实测暴露）
  const sig = data.nodes.map((n) => n.path).join("|") + "#" + (data.edges ?? []).map((e) => e[0] + ">" + e[1]).join("|");
  if (graphNodes && graphDataSig === sig) {
    drawGraph();
    publishGraphHook();
    return;
  }
  graphDataSig = sig;
  // 索引化：edges 路径对 → 索引对；度数；邻接表
  const idx = new Map(data.nodes.map((n, i) => [n.path, i]));
  graphNodes = data.nodes.map((n) => ({ ...n, deg: 0, wx: 0, wy: 0 }));
  graphEdges = [];
  graphAdj = graphNodes.map(() => new Set());
  for (const [a, b] of data.edges ?? []) {
    const i = idx.get(a), j = idx.get(b);
    if (i === undefined || j === undefined) continue;
    graphEdges.push([i, j]);
    graphAdj[i].add(j); graphAdj[j].add(i);
  }
  for (const e of graphEdges) { graphNodes[e[0]].deg++; graphNodes[e[1]].deg++; }
  forceLayout();
  graphFitView(); // settle 后自动 fit：全部节点钳进可视区（出界修复）
  graphUserTouched = false; // 新数据新布局：用户视图态作废，RO 自动 refit 恢复
  drawGraph();
  publishGraphHook();
}

function forceLayout() {
  const n = graphNodes.length;
  // 初始：环形随机化避免重叠共点
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
    graphNodes[i].x = 0.5 + Math.cos(a) * 0.35 + (Math.random() - 0.5) * 0.05;
    graphNodes[i].y = 0.5 + Math.sin(a) * 0.35 + (Math.random() - 0.5) * 0.05; // 归一化坐标，绘制时乘画布尺寸
  }
  const ITER = 300, REP = 0.012, SPR = 0.02, GRAV = 0.008, DAMP = 0.92;
  for (let t = 0; t < ITER; t++) {
    const k = 1 - t / ITER; // 退火
    for (let i = 0; i < n; i++) {
      const a = graphNodes[i];
      let fx = 0, fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = graphNodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1e-6) { dx = (Math.random() - 0.5) * 1e-3; dy = (Math.random() - 0.5) * 1e-3; d2 = dx * dx + dy * dy; }
        const f = REP * k / d2;
        fx += f * dx / Math.sqrt(d2); fy += f * dy / Math.sqrt(d2);
      }
      fx += (0.5 - a.x) * GRAV; fy += (0.5 - a.y) * GRAV; // 向心
      a.fx = fx; a.fy = fy;
    }
    for (const [i, j] of graphEdges) {
      const a = graphNodes[i], b = graphNodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1e-4);
      const f = SPR * k * (d - 0.22); // 弹簧自然长 0.22
      const ux = f * dx / d, uy = f * dy / d;
      a.fx += ux; a.fy += uy; b.fx -= ux; b.fy -= uy;
    }
    for (const nd of graphNodes) {
      nd.vx = (nd.vx ?? 0) * DAMP + (nd.fx ?? 0) * 0.5;
      nd.vy = (nd.vy ?? 0) * DAMP + (nd.fx ?? 0) * 0.5;
      nd.x += nd.vx * k; nd.y += nd.vy * k;
    }
  }
  // 终态换算 world 坐标（视图层唯一数据源；归一化布局与画布尺寸解耦）
  for (const nd of graphNodes) {
    nd.wx = (nd.x - 0.5) * GRAPH_WORLD;
    nd.wy = (nd.y - 0.5) * GRAPH_WORLD;
    delete nd.fx; delete nd.fy;
  }
}

/* world→screen 与 fit：视图变换层核心（screen = 画布中心 + world×scale + pan） */
function graphScreenOf(nd) {
  const w = graphCanvas.clientWidth || 300, h = graphCanvas.clientHeight || 200;
  return { x: w / 2 + nd.wx * graphView.scale + graphView.tx, y: h / 2 + nd.wy * graphView.scale + graphView.ty };
}
function graphWorldAt(mx, my) {
  const w = graphCanvas.clientWidth || 300, h = graphCanvas.clientHeight || 200;
  return { x: (mx - w / 2 - graphView.tx) / graphView.scale, y: (my - h / 2 - graphView.ty) / graphView.scale };
}
/* fit：全部节点钳进可视区（pad 含节点半径+标签），scale 夹取 [0.3, 3]，内容居中 */
function graphFitView() {
  if (!graphNodes?.length) return;
  const w = graphCanvas.clientWidth || 300, h = graphCanvas.clientHeight || 200;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const nd of graphNodes) {
    if (nd.wx < x0) x0 = nd.wx;
    if (nd.wx > x1) x1 = nd.wx;
    if (nd.wy < y0) y0 = nd.wy;
    if (nd.wy > y1) y1 = nd.wy;
  }
  const pad = 46; // 节点半径 + 标签空间
  const bw = Math.max(x1 - x0, 8), bh = Math.max(y1 - y0, 8);
  const scale = Math.min(GRAPH_SCALE_MAX, Math.max(GRAPH_SCALE_MIN, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh)));
  graphView.scale = scale;
  graphView.tx = -((x0 + x1) / 2) * scale;
  graphView.ty = -((y0 + y1) / 2) * scale;
  updateGraphZoom();
}
function updateGraphZoom() {
  if (graphZoomEl) graphZoomEl.textContent = Math.round(graphView.scale * 100) + "%";
}

function drawGraph() {
  if (!graphNodes || !graphMode) return;
  const dpr = window.devicePixelRatio || 1;
  const w = graphCanvas.clientWidth || 300, h = graphCanvas.clientHeight || 200;
  graphCanvas.width = Math.max(1, Math.round(w * dpr));
  graphCanvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = graphCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 边：hover 时非邻接淡出
  const hi = graphHover >= 0 ? graphHover : -1;
  ctx.lineWidth = 1;
  for (const [i, j] of graphEdges) {
    const a = graphScreenOf(graphNodes[i]);
    const b = graphScreenOf(graphNodes[j]);
    const dim = hi >= 0 && i !== hi && j !== hi;
    ctx.strokeStyle = dim ? "rgba(120,110,95,.12)" : "rgba(120,110,95,.35)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.font = "10.5px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (let i = 0; i < graphNodes.length; i++) {
    const nd = graphNodes[i];
    const p = graphScreenOf(nd);
    const r = 4 + Math.min(nd.deg, 8) * 0.9;
    const dim = hi >= 0 && i !== hi && !graphAdj[i].has(hi);
    ctx.globalAlpha = dim ? 0.25 : 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === hi ? "#B4483C" : nd.group ? "#8a7a63" : "#b0a48f";
    ctx.fill();
    ctx.fillStyle = "rgba(60,52,40,.85)";
    ctx.fillText(nd.name, p.x, p.y + r + 11);
    ctx.globalAlpha = 1;
  }
  publishGraphHook(); // 活钩子：视图/节点坐标随每次重绘刷新（verify 交互断言读实时态）
}

/* 命中检测：鼠标 → world 反算，按「半径+5px 容差」匹配（容差随缩放反算回世界系） */
function graphHit(ev) {
  if (!graphNodes) return -1;
  const rect = graphCanvas.getBoundingClientRect();
  const m = graphWorldAt(ev.clientX - rect.left, ev.clientY - rect.top);
  let best = -1, bd = Infinity;
  for (let i = 0; i < graphNodes.length; i++) {
    const nd = graphNodes[i];
    const dx = nd.wx - m.x, dy = nd.wy - m.y;
    const hitR = (4 + Math.min(nd.deg, 8) * 0.9 + 5) / graphView.scale;
    const d = dx * dx + dy * dy;
    if (d < hitR * hitR && d < bd) { bd = d; best = i; }
  }
  return best;
}

function publishGraphHook() {
  // 验证钩子（CDP 用，生产无害）：节点屏幕坐标 + 视图态，供交互断言
  window.__wikiGraph = graphNodes ? {
    mode: graphHookMeta.mode,
    host: graphHookMeta.host,
    count: graphNodes.length,
    edges: graphEdges.length,
    view: { ...graphView },
    canvas: { w: graphCanvas.clientWidth || 300, h: graphCanvas.clientHeight || 200 },
    nodes: graphNodes.map((n) => {
      const p = graphScreenOf(n);
      return { path: n.path, name: n.name, wx: n.wx, wy: n.wy, sx: p.x, sy: p.y };
    }),
  } : null;
}

/* 拖拽：节点=移动固定（≤4px 判单击开查看器）；空白=平移视图。move/up 挂 window（拖出画布也跟随） */
/* 验证钩子（CDP 用，生产无害）：web tab 走真实 UI 路径（openWebTab 内部逻辑含 tab 容量/去重） */
window.__openWebTab = (url) => void openWebTab(url);

function graphDragMove(ev) {
  if (!graphDrag) return;
  const dx = ev.clientX - graphDrag.startX, dy = ev.clientY - graphDrag.startY;
  if (graphDrag.kind === "pan") {
    if (Math.abs(dx) + Math.abs(dy) > 3) graphDrag.moved = true;
    graphView.tx = graphDrag.origT.tx + dx;
    graphView.ty = graphDrag.origT.ty + dy;
    if (graphDrag.moved) graphUserTouched = true; // 用户手动平移同上
  } else {
    if (Math.abs(dx) + Math.abs(dy) > 4) graphDrag.moved = true;
    const rect = graphCanvas.getBoundingClientRect();
    const m = graphWorldAt(ev.clientX - rect.left, ev.clientY - rect.top);
    const nd = graphNodes?.[graphDrag.i];
    if (nd) { nd.wx = m.x; nd.wy = m.y; }
  }
  drawGraph();
}
function graphDragUp() {
  const d = graphDrag;
  graphDrag = null;
  graphCanvas.style.cursor = graphHover >= 0 ? "pointer" : "grab";
  if (d?.kind === "node" && !d.moved && graphNodes?.[d.i]) openViewerTab(graphNodes[d.i].path);
}

if (graphCanvas) {
  graphCanvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0 || !graphNodes) return;
    ev.preventDefault();
    const h = graphHit(ev);
    graphDrag = h >= 0
      ? { kind: "node", i: h, startX: ev.clientX, startY: ev.clientY, moved: false }
      : { kind: "pan", startX: ev.clientX, startY: ev.clientY, moved: false, origT: { tx: graphView.tx, ty: graphView.ty } };
    graphCanvas.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (ev) => {
    if (graphDrag) { graphDragMove(ev); return; }
    if (!graphMode || !graphNodes) return;
    if (ev.target !== graphCanvas) {
      if (graphHover !== -1) { graphHover = -1; graphCanvas.style.cursor = "grab"; drawGraph(); }
      return;
    }
    const h = graphHit(ev);
    if (h !== graphHover) {
      graphHover = h;
      graphCanvas.style.cursor = h >= 0 ? "pointer" : "grab";
      drawGraph();
    }
    graphTip?.remove();
    if (h >= 0) {
      const nd = graphNodes[h];
      graphTip = el("div", "wiki-graph-tip");
      graphTip.textContent = nd.name + " · " + nd.deg + " 链接" + (graphNodes.length > 1 && graphAdj[h].size ? " · " + [...graphAdj[h]].length + " 邻居" : "");
      graphTip.title = nd.path;
      graphWrap.appendChild(graphTip);
    }
  });
  window.addEventListener("mouseup", graphDragUp);
  graphCanvas.addEventListener("mouseleave", () => {
    if (!graphDrag && graphHover !== -1) { graphHover = -1; graphCanvas.style.cursor = "grab"; drawGraph(); }
    graphTip?.remove(); graphTip = null;
  });
  // 滚轮缩放：以光标为中心（光标下的 world 点缩放前后不动），夹取 [0.3, 3]
  graphCanvas.addEventListener("wheel", (ev) => {
    if (!graphNodes) return;
    ev.preventDefault();
    const rect = graphCanvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const w = graphCanvas.clientWidth || 300, h = graphCanvas.clientHeight || 200;
    const wx = (mx - w / 2 - graphView.tx) / graphView.scale;
    const wy = (my - h / 2 - graphView.ty) / graphView.scale;
    const ns = Math.min(GRAPH_SCALE_MAX, Math.max(GRAPH_SCALE_MIN, graphView.scale * Math.exp(-ev.deltaY * 0.0015)));
    graphView.tx = mx - w / 2 - wx * ns;
    graphView.ty = my - h / 2 - wy * ns;
    graphView.scale = ns;
    graphUserTouched = true; // 用户手动缩放：RO 尺寸回调不再自动 refit 打回（verify-graph ② 根因修复）
    updateGraphZoom();
    drawGraph();
  }, { passive: false });
}
if ($("btn-graph-fit")) {
  $("btn-graph-fit").addEventListener("click", () => {
    if (!graphNodes) return;
    graphFitView();
    graphUserTouched = false; // 显式回 fit 态：RO 自动 refit 恢复
    drawGraph();
  });
}
if ($("btn-tree-graph")) {
  $("btn-tree-graph").addEventListener("click", () => setGraphMode(!graphMode));
  if (graphMode) setGraphMode(true); // 启动恢复上次视图
}
// 容器尺寸变化（右栏拖宽/窗口调整）→ refit 重绘：节点始终钳回可视区（2026-10-08 阶段一）。
// 用户手动缩放/平移后不再自动 refit（graphUserTouched，2026-10-12 verify-graph ② 根因修复）——
// 此前迟到 RO 回调把用户视图打回 fit；「数据签名未变不重排版」条款的 RO 路径补锁
if (window.ResizeObserver && graphWrap) {
  new ResizeObserver(() => {
    if (!graphMode || !graphNodes || graphUserTouched) return;
    graphFitView();
    drawGraph();
  }).observe(graphWrap);
}

async function renderFileRoot() {
  let cfg;
  try { cfg = await window.pi.wsList(); } catch { return; }
  const wss = (cfg.workspaces ?? [])
    .filter((w) => w.cwd !== cfg.homeDir) // 主目录不属于任何工作区（自由会话区专用），不进项目树（2026-10-06 owner 拍板）
    .map((w) => ({
    kind: "ws",
    id: String(w.id),
    cwd: w.cwd,
    name: w.name || String(w.cwd).split(/[\\/]/).pop(),
    color: WS_COLOR_KEYS.includes(w.color) ? w.color : "cinnabar",
  }));
  const favs = (cfg.favorites ?? []).map((f) => ({
    kind: "fav",
    id: String(f.id),
    cwd: f.cwd,
    name: f.name || String(f.cwd).split(/[\\/]/).pop(),
  }));
  const roots = [...wss, ...favs]; // 工作区根在前、收藏根在后
  treeRoots = roots;
  const structSig = roots.map((r) => `${r.kind}:${r.id}:${r.cwd}:${r.color ?? ""}`).join("|");
  const sig = structSig + "#" + (state?.cwd ?? "");
  if (fileTreeEl.dataset.sig === sig) return;
  if (fileTreeEl.dataset.structSig === structSig && fileTreeEl.childElementCount) {
    // 结构未变：只刷高亮（DOM 不重建，展开态保留）；顺带把新活跃根展开一层（对齐整树重建分支）
    for (const g of fileTreeEl.querySelectorAll(".proj-group")) {
      g.classList.toggle("active", g.dataset.kind === "ws" && g.dataset.cwd === state?.cwd);
    }
    const ar = roots.find((r) => r.kind === "ws" && r.cwd === state?.cwd);
    if (ar && !treeExpanded.has(ar.cwd)) {
      const c = containerByPath(ar.cwd);
      if (c) void toggleDir(c);
    }
    fileTreeEl.dataset.sig = sig;
    return;
  }
  fileTreeEl.dataset.structSig = structSig;
  fileTreeEl.dataset.sig = sig;
  fileTreeEl.replaceChildren();
  if (!roots.length) {
    const e = el("div", "tree-loading");
    e.textContent = "（暂无工作区，左侧「添加工作区」后在此展示）";
    fileTreeEl.appendChild(e);
    return;
  }
  for (const r of roots) fileTreeEl.appendChild(makeRootGroup(r));
  // 默认展开当前工作区一层（此前未展开过时；重建后展开态由 treeExpanded 恢复）
  const activeRoot = roots.find((r) => r.kind === "ws" && r.cwd === state?.cwd);
  if (activeRoot && !treeExpanded.has(activeRoot.cwd)) {
    const children = containerByPath(activeRoot.cwd);
    if (children) void toggleDir(children);
  }
}

/* 数据刷新（settled 后/隐藏开关切换）：清缓存重读已展开目录，展开态保留 */
async function refreshTreeData() {
  dirCache.clear();
  treeDataSeq++;
  const openPaths = [...fileTreeEl.querySelectorAll(".tree-children:not(.hidden)")].map((c) => c.dataset.path);
  for (const c of fileTreeEl.querySelectorAll(".tree-children")) c.dataset.loaded = "";
  for (const p of openPaths) {
    const c = containerByPath(p);
    if (c) await ensureChildrenLoaded(c, p);
  }
}
let treeRefreshTimer = null;
function scheduleTreeRefresh() {
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => {
    if (filterOn) return; // 过滤态按需搜索，无需刷新
    void refreshTreeData();
  }, 400);
}

/* ---- 过滤（含未展开目录）+ 显示隐藏开关 ---- */
let filterOn = false;
let filterTimer = null;
let filterSeq = 0;

function setFilterRow(show) {
  filterOn = show;
  filterRowEl.classList.toggle("hidden", !show);
  $("btn-tree-filter").classList.toggle("active", show);
  if (show) {
    filterInputEl.focus();
  } else {
    filterInputEl.value = "";
    filterSeq++; // 作废在途搜索
    treeResultsEl.classList.add("hidden");
    treeResultsEl.replaceChildren();
    fileTreeEl.classList.remove("hidden");
  }
}
$("btn-tree-filter").addEventListener("click", () => setFilterRow(!filterOn));
filterInputEl.addEventListener("input", () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => void runFilter(), 250);
});
filterInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.stopPropagation();
    setFilterRow(false);
  } else if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(filterTimer);
    void runFilter();
  }
});

function resultNote(t) {
  const e = el("div", "tree-results-note");
  e.textContent = t;
  return e;
}

function makeResultRow(hit, root) {
  const row = el("div", "tree-result-row");
  row.dataset.full = hit.path;
  row.title = hit.path + (hit.dir ? "" : "\n单击：查看　双击：@ 引用");
  bindKbd(row, () => row.click(), "option"); // 键盘批：过滤结果 Enter=单击语义
  const rel = hit.path.slice(root.cwd.length + 1);
  const dirPart = hit.dir ? rel : rel.slice(0, rel.lastIndexOf("\\"));
  const name = el("div", "tr-name");
  const ficon = el("span", "t-icon t-ficon");
  ficon.append(svgUse(hit.dir ? "#i-folder" : "#i-file", "ic ic-s"));
  const txt = el("span", "tr-text");
  txt.textContent = hit.name;
  name.append(ficon, txt);
  const p = el("div", "tr-path");
  p.textContent = dirPart ? root.name + "\\" + dirPart : root.name;
  row.append(name, p);
  if (hit.dir) {
    row.addEventListener("dblclick", () => void locateInTree(hit.path));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showDirMenu(e, hit.path, false, null);
    });
  } else {
    bindFileGestures(row, hit.path);
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showFileMenu(e, hit.path);
    });
  }
  return row;
}

async function runFilter() {
  const q = filterInputEl.value.trim().toLowerCase();
  if (!q) {
    filterSeq++;
    treeResultsEl.classList.add("hidden");
    treeResultsEl.replaceChildren();
    fileTreeEl.classList.remove("hidden");
    return;
  }
  const seq = ++filterSeq;
  fileTreeEl.classList.add("hidden");
  treeResultsEl.classList.remove("hidden");
  treeResultsEl.replaceChildren(resultNote("搜索中…"));
  const roots = treeRoots.length ? treeRoots : [];
  const lists = await Promise.all(
    roots.map((r) => window.pi.searchFiles(r.cwd, q, showHidden).catch(() => ({ results: [] })))
  );
  if (seq !== filterSeq) return; // 过期响应丢弃
  treeResultsEl.replaceChildren();
  let count = 0;
  outer: for (let i = 0; i < roots.length; i++) {
    for (const hit of lists[i].results ?? []) {
      treeResultsEl.appendChild(makeResultRow(hit, roots[i]));
      if (++count >= 150) break outer;
    }
  }
  if (!count) treeResultsEl.appendChild(resultNote("无匹配（含未展开目录）"));
  else if (lists.some((l) => l.truncated)) {
    treeResultsEl.appendChild(resultNote("结果过多已截断，试试更具体的关键字"));
  }
}

function applyHiddenBtn() {
  $("btn-tree-hidden").classList.toggle("active", showHidden);
}
$("btn-tree-hidden").addEventListener("click", async () => {
  showHidden = !showHidden;
  localStorage.setItem("pi-gui:tree-hidden", showHidden ? "1" : "0");
  applyHiddenBtn();
  if (filterInputEl.value.trim()) {
    void runFilter();
    return;
  }
  await refreshTreeData();
});
applyHiddenBtn();

/* ---- 右键菜单（固定条目集，无用户输入拼接，图标 href 白名单） ---- */
function hideCtxMenu() {
  ctxMenuEl.classList.add("hidden");
  ctxMenuEl.replaceChildren();
}
function showCtxMenu(x, y, items) {
  ctxMenuEl.replaceChildren();
  for (const it of items) {
    if (it.sep) {
      ctxMenuEl.appendChild(el("div", "ctx-sep"));
      continue;
    }
    if (it.swatches) {
      const box = el("div", "ctx-swatches");
      const lab = el("span", "ctx-sw-label");
      lab.textContent = "颜色";
      box.appendChild(lab);
      for (const key of WS_COLOR_KEYS) {
        const b = el("button", "ctx-swatch" + (it.current === key ? " cur" : ""));
        b.style.background = `var(--wc-${key})`;
        b.title = key;
        b.addEventListener("click", () => {
          hideCtxMenu();
          it.onPick(key);
        });
        box.appendChild(b);
      }
      ctxMenuEl.appendChild(box);
      continue;
    }
    const b = el("button", "ctx-item" + (it.danger ? " danger" : ""));
    if (it.icon) b.append(svgUse(it.icon, "ic ic-s"));
    const s = el("span");
    s.textContent = it.label;
    b.appendChild(s);
    b.addEventListener("click", () => {
      hideCtxMenu();
      it.act();
    });
    ctxMenuEl.appendChild(b);
  }
  ctxMenuEl.classList.remove("hidden");
  ctxMenuEl.style.left = "0px";
  ctxMenuEl.style.top = "0px";
  const r = ctxMenuEl.getBoundingClientRect();
  const maxX = window.innerWidth - r.width - 6;
  const maxY = window.innerHeight - r.height - 6;
  ctxMenuEl.style.left = Math.max(6, Math.min(x, maxX)) + "px";
  ctxMenuEl.style.top = Math.max(6, Math.min(y, maxY)) + "px";
}
document.addEventListener(
  "mousedown",
  (e) => {
    // e.target 可能不是 Element（如以 document/window 为目标的合成事件）——closest 前必须验型，
    // 否则 capture 阶段抛 TypeError（2026-10-06 验证轮实测：探针向 document 派发 mousedown 即中招）
    if (!ctxMenuEl.classList.contains("hidden") && !(e.target instanceof Element && e.target.closest(".ctx-menu"))) hideCtxMenu();
  },
  true
);
window.addEventListener("blur", hideCtxMenu);

function copyPathAct(p) {
  window.pi.writeClipboard(p).catch(() => {});
}
function showFileMenu(e, full) {
  showCtxMenu(e.clientX, e.clientY, [
    {
      label: "@ 引用",
      icon: "#i-clip",
      act: () => {
        insertAtCursor("@" + full + " ");
        input.focus();
      },
    },
    { label: "复制路径", icon: "#i-copy", act: () => copyPathAct(full) },
    { label: "系统打开", icon: "#i-external", act: () => void window.pi.openPath(full) },
    { sep: true },
    { label: "在树中定位", icon: "#i-locate", act: () => void locateInTree(full) },
  ]);
}
/* 压缩档工作区级菜单（2026-10-09 设计共识批次B3）：作用域=该工作区新会话；标准=清除覆盖回落全局档 */
const WS_KEEP_OPTS = [[32000, "压缩档:保守"], [20000, "压缩档:标准"], [12000, "压缩档:激进"]];
function wsKeepMenuItems(cwd) {
  const cur = wsKeepByCwd[cwd];
  return WS_KEEP_OPTS.map(([v, label]) => ({
    label: (cur === v ? "✓ " : "") + label,
    icon: "#i-gear",
    act: async () => {
      try {
        await window.pi.wsSetKeep(cwd, v === 20000 ? null : v); // 标准=清除覆盖（回落 settings.json 全局档）
        showNotice(v === 20000 ? "压缩档：标准（清除覆盖，回落全局档）——本工作区新会话生效" : label.slice(4) + "（本工作区新会话生效）");
        renderSidebarTree();
      } catch (err) {
        showNotice("压缩档设置失败：" + String(err?.message ?? err), true);
      }
    },
  }));
}

function showDirMenu(e, dirPath, isRoot, root) {
  const items = [];
  if (isRoot && root?.kind === "ws") {
    // 工作区根：开新会话置顶（2026-10-06 owner 拍板：会话入口收进右键，点击不再自动新建）
    items.push(
      { label: "在此开新会话", icon: "#i-pencil", act: () => void newSessionHere(dirPath) },
      { sep: true },
      { label: "复制路径", icon: "#i-copy", act: () => copyPathAct(dirPath) },
      { label: "系统打开", icon: "#i-external", act: () => void window.pi.openPath(dirPath) },
      { sep: true },
      { swatches: true, current: root.color, onPick: (c) => void recolorRoot(root, c) },
      { sep: true },
      ...wsKeepMenuItems(dirPath),
      { sep: true },
      { label: "移除工作区（不删文件）", icon: "#i-trash", danger: true, act: () => void removeWsRoot(root) }
    );
  } else if (isRoot) {
    // 收藏目录根：纯浏览不建会话（2026-10-06 设计轮拍板维持）
    items.push(
      { label: "复制路径", icon: "#i-copy", act: () => copyPathAct(dirPath) },
      { label: "系统打开", icon: "#i-external", act: () => void window.pi.openPath(dirPath) },
      { sep: true },
      { label: "从树中移除（不删文件）", icon: "#i-trash", danger: true, act: () => void removeFavRoot(root) }
    );
  } else {
    // 子目录：同款开新会话（未登记目录自动登记为工作区，否则会话挂在目录 cwd 下左栏看不到）
    items.push(
      { label: "在此目录开新会话", icon: "#i-pencil", act: () => void newSessionHere(dirPath) },
      { sep: true },
      { label: "复制路径", icon: "#i-copy", act: () => copyPathAct(dirPath) },
      { label: "系统打开", icon: "#i-external", act: () => void window.pi.openPath(dirPath) },
      { sep: true },
      { label: "收藏此目录", icon: "#i-bookmark", act: () => void addFavDir(dirPath) },
      { label: "在树中定位", icon: "#i-locate", act: () => void locateInTree(dirPath) }
    );
  }
  showCtxMenu(e.clientX, e.clientY, items);
}

/* 右键开新会话（2026-10-06 owner 拍板：项目树点击不自动新建）：
 * 目录未登记为工作区时先登记（会话挂在目录 cwd 下，不登记则左栏分组不可见），主目录除外（自由会话区）。 */
async function newSessionHere(dir) {
  try {
    if (dir !== state?.cwd) {
      const cfg = await window.pi.wsList();
      const isHome = !!cfg.homeDir && cfg.homeDir.toLowerCase() === dir.toLowerCase();
      let ws = (cfg.workspaces ?? []).find((w) => w.cwd.toLowerCase() === dir.toLowerCase());
      if (!ws && !isHome) {
        const c2 = await window.pi.wsAdd(dir); // 静默登记：新根+左栏分组立即可见，无需黄条（2026-10-06 owner 拍板）
        ws = (c2.workspaces ?? []).find((w) => w.cwd.toLowerCase() === dir.toLowerCase());
      }
      if (ws) await window.pi.wsSetActive(ws.id);
    }
    await startSession(dir); // 不弹通知条（对齐左栏「+」，2026-10-06 拍板）
  } catch (err) {
    showNotice("开新会话失败：" + (err?.message ?? err), true);
  }
}

/* 树上移除工作区：语义与左栏分组头 × 一致（仅摘登记，不动文件与会话） */
async function removeWsRoot(root) {
  if (!confirm(`移除工作区「${root.name}」？\n（仅从列表移除，不会删除磁盘文件和会话记录）`)) return;
  try {
    const c2 = await window.pi.wsRemove(root.id);
    treeExpanded.delete(root.cwd);
    await renderSidebarTree();
    await renderFileRoot();
    const act = c2.workspaces.find((x) => x.id === c2.activeId) ?? c2.workspaces[0];
    if (act && state?.cwd !== act.cwd) await startSession(act.cwd);
  } catch (err) {
    showNotice("移除失败：" + (err?.message ?? err), true);
  }
}

async function addFavDir(dir) {
  try {
    await window.pi.wsFavAdd(dir);
    await renderFileRoot();
  } catch (err) {
    showNotice("收藏失败：" + (err?.message ?? err), true);
  }
}
async function removeFavRoot(root) {
  try {
    await window.pi.wsFavRemove(root.id);
    treeRoots = treeRoots.filter((r) => r.id !== root.id);
    treeExpanded.delete(root.cwd);
    await renderFileRoot();
  } catch (err) {
    showNotice("移除失败：" + (err?.message ?? err), true);
  }
}
async function recolorRoot(root, color) {
  try {
    await window.pi.wsSetColor(root.id, color);
    await renderFileRoot();
  } catch (err) {
    showNotice("换色失败：" + (err?.message ?? err), true);
  }
}

$("btn-tree-fav").addEventListener("click", async () => {
  try {
    const dir = await window.pi.pickFolder();
    if (!dir) return;
    await addFavDir(dir);
  } catch (err) {
    showNotice("收藏失败：" + (err?.message ?? err), true);
  }
});

/* ---- 路径定位：展开到目标 + 滚动 + 闪烁（chip/路径点击/在树中定位共用） ---- */
function ensureRightbarVisible() {
  document.body.classList.remove("rightbar-collapsed");
  $("btn-show-rightbar").classList.add("hidden");
}

async function expandPathStep(dirPath) {
  treeExpanded.add(dirPath);
  const c = containerByPath(dirPath);
  if (!c) return false;
  await ensureChildrenLoaded(c, dirPath);
  setExpanded(c, true);
  return true;
}

async function locateInTree(filePath) {
  if (!filePath) return;
  if (filterOn) setFilterRow(false); // 退出过滤态回树
  ensureRightbarVisible();
  const root = treeRoots.find((r) => isUnder(filePath, r.cwd));
  if (!root) {
    showNotice("该路径不在已登记的工作区/收藏目录内");
    return;
  }
  const kind = await window.pi.pathKind(filePath).catch(() => null);
  const target = kind === "dir" ? filePath : parentOf(filePath);
  await expandPathStep(root.cwd);
  let cur = root.cwd;
  const rel = target.slice(root.cwd.length + 1);
  for (const seg of rel.split("\\")) {
    if (!seg) continue;
    cur = fullPath(cur, seg);
    const ok = await expandPathStep(cur);
    if (!ok) break; // 中途目录不可见（可能被过滤），尽力而为
  }
  const row =
    fileTreeEl.querySelector(`.tree-row[data-full="${cssEscape(filePath)}"]`) ??
    fileTreeEl.querySelector(`.tree-row[data-full="${cssEscape(target)}"]`);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
    setTimeout(() => row.classList.remove("flash"), 1300);
  }
}

/* ================= 文件查看器（2026-10-06 设计轮）：主区分栏 + 多 tab，永久只读 =================
 * 入口：树/过滤结果双击、消息与工具卡路径点击；重复打开聚焦已有 tab，上限 8 超出聚焦最旧；
 * 文本=高亮+行号+复制；图片=等比/1:1；HTML/md=默认渲染视图⇄源码；二进制/超大=系统打开兜底。 */
const viewerEl = $("viewer");
const vwTabsEl = $("vw-tabs");
const vwBodyEl = $("vw-body");
const splitEl = $("viewer-split");
const mainEl = $("main");
const VW_TAB_CAP = 8;

let vwTabs = []; // {path, name, type: 'text'|'image'|'html'|'md', mode: 'render'|'source', data}
let vwActivePath = null;
let vwOpen = false;
let vwWidthPct = 50; // 内存态比例

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const HTML_EXT_RE = /\.x?html?$/i;
const MD_EXT_RE = /\.(md|markdown)$/i;

function vwTypeOf(p) {
  if (IMAGE_EXT_RE.test(p)) return "image";
  if (HTML_EXT_RE.test(p)) return "html";
  if (MD_EXT_RE.test(p)) return "md";
  return "text";
}
function fileUrlOf(p) {
  return (
    "file:///" +
    encodeURI(String(p).replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F")
  );
}

function activeVwTab() {
  return vwTabs.find((t) => t.path === vwActivePath) ?? null;
}

function applyVwWidth() {
  viewerEl.style.width = vwWidthPct + "%";
}

function openVwShell() {
  vwOpen = true;
  splitEl.classList.remove("hidden");
  viewerEl.classList.remove("hidden");
  applyVwWidth();
}

function closeVwShell() {
  vwOpen = false;
  // web tab 一并关闭：原生视图销毁，不留悬空覆盖层（2026-10-08 阶段二）
  for (const t of vwTabs) {
    if (t.type === "web") void window.pi.webClose(t.webId).catch(() => {});
  }
  vwTabs = [];
  vwActivePath = null;
  splitEl.classList.add("hidden");
  viewerEl.classList.add("hidden");
  vwTabsEl.replaceChildren();
  vwBodyEl.replaceChildren();
  void window.pi.webSetBounds({ tabId: null }).catch(() => {});
}

function openViewerTab(path) {
  const p = String(path);
  const exist = vwTabs.find((t) => t.path === p);
  if (exist) {
    activateVwTab(p);
    return;
  }
  if (vwTabs.length >= VW_TAB_CAP) {
    activateVwTab(vwTabs[0].path); // 上限：不开新 tab，聚焦最旧
    return;
  }
  const name = p.split(/[\\/]/).pop() || p;
  const tab = { path: p, name, type: vwTypeOf(p), mode: "render", data: null };
  vwTabs.push(tab);
  activateVwTab(p);
  void loadVwTab(tab);
}

function activateVwTab(path) {
  vwActivePath = path;
  if (!vwOpen) openVwShell();
  renderVwTabs();
  renderVwBody();
}

function closeVwTab(path) {
  const idx = vwTabs.findIndex((t) => t.path === path);
  if (idx < 0) return;
  const closed = vwTabs.splice(idx, 1)[0];
  if (closed.type === "web") void window.pi.webClose(closed.webId).catch(() => {});
  if (!vwTabs.length) {
    closeVwShell();
    return;
  }
  if (vwActivePath === path) {
    const next = vwTabs[Math.min(idx, vwTabs.length - 1)];
    activateVwTab(next.path);
  } else {
    renderVwTabs();
  }
}

async function loadVwTab(tab) {
  if (tab.type === "web") return; // web tab 内容在原生视图，无需读文件（2026-10-08 阶段二）
  const r = await window.pi.readFile(tab.path).catch((err) => ({
    kind: "error",
    error: String(err?.message ?? err),
  }));
  tab.data = r;
  if (vwActivePath === tab.path) renderVwBody();
}

/* ---- web tab（2026-10-08 计划书阶段二）：查看器内自由浏览器 ---- */
let vwWebRO = null; // 占位区尺寸观察（窗口缩放/拖条 → bounds 重报）
let vwWebBoundsTimer = 0;

function scheduleWebBounds() {
  clearTimeout(vwWebBoundsTimer);
  vwWebBoundsTimer = setTimeout(syncWebBounds, 120);
}

async function syncWebBounds() {
  const tab = activeVwTab();
  const host = document.getElementById("vw-web-host");
  if (!tab || tab.type !== "web" || !host || !vwOpen) {
    void window.pi.webSetBounds({ tabId: null }).catch(() => {});
    return;
  }
  const r = host.getBoundingClientRect();
  void window.pi.webSetBounds({ tabId: tab.webId, x: r.x, y: r.y, w: r.width, h: r.height }).catch(() => {});
}

async function openWebTab(url) {
  try {
    const r = await window.pi.webOpen(String(url || "about:blank"));
    const exist = vwTabs.find((t) => t.webId === r.tabId);
    if (exist) {
      activateVwTab(exist.path);
      return;
    }
    if (vwTabs.length >= VW_TAB_CAP) {
      activateVwTab(vwTabs[0].path);
      return;
    }
    const tab = { path: "web:" + r.tabId, webId: r.tabId, name: r.title || "新标签页", type: "web", mode: "render", url: r.url, data: null };
    vwTabs.push(tab);
    activateVwTab(tab.path);
  } catch (err) {
    showNotice("浏览器打开失败：" + (err?.message ?? err), true);
  }
}

/* 🌐 网页按钮（2026-10-08 owner 报「自由浏览器在哪」）：查看器 tab 栏尾常驻（含查看器未开时——
 * 需要时随 openVwShell 一并显示），点击弹地址输入条，回车开新 web tab；Esc/失焦收起。
 * main 元素级常显（查看器 hidden 也可见），放主区顶右悬浮位与 btn-show-rightbar 同排。 */
const webNewBtn = $("btn-web-new");
const webNewInput = $("web-new-input");

function webNewToggle(show) {
  webNewBtn.classList.toggle("hidden", !show);
  webNewInput.classList.toggle("hidden", !show);
  if (show) {
    webNewInput.value = "";
    setTimeout(() => webNewInput.focus(), 30);
  }
}

webNewBtn.addEventListener("click", () => {
  if (!vwOpen) openVwShell(); // 查看器未开：连壳一起开（renderVwTabs 首轮空 tab 栏正常）
  webNewToggle(true);
});
webNewInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    const v = webNewInput.value.trim();
    if (!v) return;
    webNewToggle(false);
    void openWebTab(/^https?:\/\//i.test(v) ? v : "https://" + v);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    webNewToggle(false);
  }
});
webNewInput.addEventListener("blur", () => webNewToggle(false));
// 启动即常显按钮（初始 hidden 由 JS 摘除；HTML 里 hidden 兼顾无 JS 骨架）
webNewBtn.classList.remove("hidden");

// 侧栏全局浏览器入口（2026-10-12 owner 需求：查看器未开时壳内 🌐 钮随壳隐藏，主界面零入口）——
// 行为与查看器内 🌐 完全同源（click handler 自带「未开连壳一起开 + 弹地址条」）。
// null 守卫：托盘驻留下「新 bundle 撞旧 HTML」时元素不存在，不可让 TypeError 炸断 init 尾部接线
const webOpenBtn = $("btn-web-open");
if (webOpenBtn) webOpenBtn.addEventListener("click", () => webNewBtn.click());

function renderVwTabs() {
  vwTabsEl.replaceChildren();
  for (const t of vwTabs) {
    const b = el("button", "vw-tab" + (t.path === vwActivePath ? " active" : ""));
    b.type = "button";
    b.title = t.path;
    const nm = el("span", "vw-name");
    nm.textContent = t.name;
    const x = el("span", "vw-x");
    x.textContent = "×";
    x.setAttribute("role", "button");
    x.setAttribute("aria-label", "关闭 " + t.name);
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      closeVwTab(t.path);
    });
    b.append(nm, x);
    b.addEventListener("click", () => activateVwTab(t.path));
    vwTabsEl.appendChild(b);
  }
}

/* 文本视图：行号槽 + 高亮代码（hljs 复用聊天配置） */
function vwTextContent(content, tab) {
  const wrap = el("div", "vw-code");
  const text = String(tab.data.text ?? "");
  const lines = text.split("\n");
  const gutter = el("div", "vw-gutter");
  gutter.textContent = lines.map((_, i) => i + 1).join("\n");
  const pre = el("pre", "vw-pre");
  const code = el("code");
  code.textContent = text;
  const ext = (tab.name.split(".").pop() ?? "").toLowerCase();
  const langMap = { js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript", py: "python", json: "json", md: "markdown", html: "html", htm: "html", xml: "xml", css: "css", sh: "bash", ps1: "powershell", yaml: "yaml", yml: "yaml", sql: "sql", java: "java", go: "go" };
  if (langMap[ext]) code.classList.add("language-" + langMap[ext]);
  pre.appendChild(code);
  wrap.append(gutter, pre);
  content.appendChild(wrap);
  try {
    hljs.highlightElement(code);
  } catch { /* 未知语言跳过 */ }
}

function vwEmptyContent(content, msg, path) {
  const box = el("div", "vw-empty");
  const t = el("div");
  t.textContent = msg;
  box.appendChild(t);
  if (path) {
    const btn = el("button", "vw-tool-btn");
    btn.type = "button";
    btn.innerHTML = '<svg class="ic ic-s"><use href="#i-external"/></svg><span>系统打开</span>';
    btn.addEventListener("click", () => void window.pi.openPath(path));
    box.appendChild(btn);
  }
  content.appendChild(box);
}

function renderVwBody() {
  const tab = activeVwTab();
  vwBodyEl.replaceChildren();
  setTimeout(syncWebBounds, 0); // 所有早退路径统一覆盖：非 web tab 摘除原生视图，web tab 等 DOM 就位后重报 bounds
  if (!tab) return;

  /* web tab：浏览器工具条 + 原生视图占位区（2026-10-08 阶段二） */
  if (tab.type === "web") {
    const wbar = el("div", "vw-web-bar");
    wbar.id = "vw-web-bar";
    const mkBtn = (cls, href, title, act) => {
      const b = el("button", "vw-tool-btn " + cls);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.append(svgUse(href, "ic ic-s")); // DOM 构建替代 innerHTML（2026-10-10，同批 svgUse 惯例）
      b.addEventListener("click", act);
      return b;
    };
    const backBtn = mkBtn("vw-web-back", "#i-chev-r", "后退", () => void window.pi.webAction(tab.webId, "back").catch(() => {}));
    backBtn.style.transform = "rotate(180deg)";
    const fwdBtn = mkBtn("vw-web-fwd", "#i-chev-r", "前进", () => void window.pi.webAction(tab.webId, "fwd").catch(() => {}));
    const reloadBtn = mkBtn("vw-web-reload", "#i-locate", "刷新（加载中点击=停止）", () => void window.pi.webAction(tab.webId, tab.data?.loading ? "stop" : "reload").catch(() => {}));
    const urlInput = el("input", "vw-web-url");
    urlInput.id = "vw-web-url";
    urlInput.spellcheck = false;
    urlInput.placeholder = "输入网址，回车跳转…";
    urlInput.value = tab.url && tab.url !== "about:blank" ? tab.url : "";
    const go = () => {
      let v = urlInput.value.trim();
      if (!v) return;
      if (!/^https?:\/\//i.test(v)) v = "https://" + v;
      tab.url = v;
      void window.pi.webNavigate(tab.webId, v).catch((err) => showNotice("导航失败：" + (err?.message ?? err), true));
    };
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        go();
      }
      if (e.key === "Escape") { e.stopPropagation(); e.target.blur(); } // P2 修复：Esc 原地无动作，现退出地址栏编辑
    });
    const goBtn = el("button", "vw-tool-btn");
    goBtn.type = "button";
    goBtn.textContent = "前往";
    goBtn.addEventListener("click", go);
    const extBtn = mkBtn("vw-web-ext", "#i-external", "在系统浏览器打开", () => void window.pi.webAction(tab.webId, "external").catch(() => {}));
    const devBtn = mkBtn("vw-web-dev", "#i-tool", "开发者工具", () => void window.pi.webAction(tab.webId, "devtools").catch(() => {}));
    wbar.append(backBtn, fwdBtn, reloadBtn, urlInput, goBtn, extBtn, devBtn);
    vwBodyEl.appendChild(wbar);
    const host = el("div", "vw-web-host");
    host.id = "vw-web-host";
    vwBodyEl.appendChild(host);
    if (vwWebRO) vwWebRO.disconnect();
    vwWebRO = new ResizeObserver(scheduleWebBounds);
    vwWebRO.observe(host);
    syncWebBounds();
    return;
  }

  // 工具行：渲染/源码切换（html/md）· 复制 · 系统打开
  const bar = el("div", "vw-toolbar");
  if (tab.type === "html" || tab.type === "md") {
    const seg = el("div", "vw-seg");
    const bR = el("button");
    bR.type = "button";
    bR.textContent = "渲染";
    bR.classList.toggle("cur", tab.mode === "render");
    const bS = el("button");
    bS.type = "button";
    bS.textContent = "源码";
    bS.classList.toggle("cur", tab.mode === "source");
    bR.addEventListener("click", () => {
      if (tab.mode !== "render") {
        tab.mode = "render";
        renderVwBody();
      }
    });
    bS.addEventListener("click", () => {
      if (tab.mode !== "source") {
        tab.mode = "source";
        renderVwBody();
      }
    });
    seg.append(bR, bS);
    bar.appendChild(seg);
  }
  bar.appendChild(el("span", "spacer"));
  const hasText = tab.data?.kind === "text";
  if (hasText) {
    const cp = el("button", "vw-tool-btn");
    cp.type = "button";
    cp.innerHTML = '<svg class="ic ic-s"><use href="#i-copy"/></svg><span>复制</span>';
    cp.addEventListener("click", () => {
      window.pi
        .writeClipboard(String(tab.data.text ?? ""))
        .then(() => {
          cp.style.color = "var(--ok)";
          setTimeout(() => (cp.style.color = ""), 1200);
        })
        .catch(() => {});
    });
    bar.appendChild(cp);
  }
  const ext2 = el("button", "vw-tool-btn");
  ext2.type = "button";
  ext2.innerHTML = '<svg class="ic ic-s"><use href="#i-external"/></svg><span>系统打开</span>';
  ext2.addEventListener("click", () => void window.pi.openPath(tab.path));
  bar.appendChild(ext2);
  vwBodyEl.appendChild(bar);

  const content = el("div", "vw-content");
  vwBodyEl.appendChild(content);

  const d = tab.data;
  if (!d) {
    vwEmptyContent(content, "加载中…", null);
    return;
  }
  if (d.kind === "error") {
    vwEmptyContent(content, "读取失败：" + (d.error ?? "未知错误"), tab.path);
    return;
  }
  if (d.kind === "dir") {
    vwEmptyContent(content, "这是目录，不在查看器里展开（树内浏览）", null);
    return;
  }
  if (d.kind === "binary") {
    vwEmptyContent(content, "二进制文件（" + Math.ceil((d.size ?? 0) / 1024) + " KB），不支持预览", tab.path);
    return;
  }
  if (d.kind === "toobig") {
    vwEmptyContent(content, "图片过大（" + Math.ceil((d.size ?? 0) / 1024 / 1024) + " MB），不支持预览", tab.path);
    return;
  }
  if (d.kind === "image") {
    const wrap = el("div", "vw-img-wrap");
    const img = document.createElement("img");
    img.src = d.dataUrl;
    img.alt = tab.name;
    img.title = "点击切换 等比 ⇄ 原始尺寸";
    wrap.addEventListener("click", () => wrap.classList.toggle("natural"));
    wrap.appendChild(img);
    content.appendChild(wrap);
    return;
  }
  // text
  if (d.truncated) {
    const note = el("div", "tree-results-note");
    note.textContent = `文件较大（${(d.size / 1024 / 1024).toFixed(1)} MB），已截取首尾展示`;
    note.style.padding = "6px 12px";
    content.appendChild(note);
  }
  if (tab.type === "html" && tab.mode === "render") {
    const frame = document.createElement("iframe");
    frame.className = "vw-frame";
    // allow-same-origin 必须给：本地设计稿常带相对引用的 css/js/图片，沙箱不给同源时
    // file:// 子资源全被「Not allowed to load local resource」拦掉（2026-10-06 验证轮实测）；
    // 沙箱仍隔 popup/form/顶层导航，且 file: 页面间互不可访（Chromium file 隔离），只读查看场景够用
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-forms");
    frame.setAttribute("referrerPolicy", "no-referrer");
    frame.src = fileUrlOf(tab.path);
    content.appendChild(frame);
    return;
  }
  if (tab.type === "md" && tab.mode === "render") {
    const box = el("div", "md vw-md");
    setHtml(box, md(d.text));
    content.appendChild(box);
    highlightIn(box);
    return;
  }
  vwTextContent(content, tab);
}

/* tab × / 整体关闭 / Esc / 拖条 */
$("vw-close").addEventListener("click", closeVwShell);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (e.defaultPrevented) return; // 已被更内层消费者处理（如 slash 菜单 Esc），不叠发
  if (!ctxMenuEl.classList.contains("hidden")) {
    hideCtxMenu();
    return;
  }
  if (document.querySelector(".st-overlay:not(.hidden)")) return; // 设置弹层有自己的 capture 层 Esc
  if (document.querySelector(".cmp-overlay:not(.hidden)")) { // P2 修复：对比弹窗是唯一没 Esc 的弹层（关闭含未完成中止语义，复用 cmp-close 按钮）
    e.preventDefault();
    $("cmp-close").click();
    return;
  }
  if (!$("search-pop").classList.contains("hidden")) { // P2 修复：焦点不在搜索输入框时 Esc 无响应
    e.preventDefault();
    spClose();
    return;
  }
  if (!$("branch-list").classList.contains("hidden")) { // P2 修复：分支列表面板无 Esc
    e.preventDefault();
    $("branch-list").classList.add("hidden");
    return;
  }
  if (!$("slash-menu").classList.contains("hidden")) return; // slash 菜单自己处理 Esc
  if (vwOpen && vwActivePath) {
    e.preventDefault();
    closeVwTab(vwActivePath);
  }
});

splitEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  splitEl.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  const move = (ev) => {
    const rect = mainEl.getBoundingClientRect();
    if (rect.width <= 0) return;
    let pct = ((ev.clientX - rect.left) / rect.width) * 100;
    const minPct = (320 / rect.width) * 100;
    const maxPct = ((rect.width - 420 - 5) / rect.width) * 100;
    vwWidthPct = Math.min(maxPct, Math.max(minPct, pct));
    applyVwWidth();
  };
  const up = () => {
    splitEl.classList.remove("dragging");
    document.body.style.cursor = "";
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

/* ---- 变更追踪 ---- */

function recordChange(toolName, args, isError) {
  const p = args?.path ?? args?.file_path ?? args?.absolute_path;
  if (!p) return;
  const d = isError ? { plus: 0, del: 0 } : changeDelta(toolName, args);
  changedFiles.unshift({ tool: toolName, path: String(p), isError: !!isError, time: new Date(), ...d });
  // 变更栏已砍（2026-10-06 设计轮）：changedFiles 仅供轮末 chip 与树内定位用，无 UI 即时渲染
}

/* 行数增减估算（轮末 chip 用）：write=全新增；edit=逐条 oldText/newText 非空行数差 */
function changeDelta(toolName, args) {
  if (toolName === "write") {
    const c = String(args?.content ?? "");
    return { plus: c ? c.split("\n").length : 0, del: 0 };
  }
  if (toolName === "edit") {
    const edits = Array.isArray(args?.edits) ? args.edits : (args?.oldText != null ? [args] : []);
    let plus = 0, del = 0;
    for (const e of edits) {
      del += String(e?.oldText ?? "").split("\n").filter((l) => l.trim()).length;
      plus += String(e?.newText ?? "").split("\n").filter((l) => l.trim()).length;
    }
    return { plus, del };
  }
  return { plus: 0, del: 0 };
}

/* R3 轮末 chip：耗时 + 本轮触碰文件数与增减行数；点击展开右栏变更面板并闪烁定位
 * aborted=true 时灰化 + 前缀「已取消」（1.1.0 agent_settled.aborted，Q1/Q7 拍板：中断前耗时与变更仍有回看价值） */
function renderTurnChip(ms, aborted = false) {
  const files = new Map(); // path → {plus, del}
  for (const c of changedFiles) {
    if (c.time.getTime() < turnStart) break; // 头插序，遇到早于本轮起点即止
    if (c.isError) continue;
    const e = files.get(c.path) ?? { plus: 0, del: 0 };
    e.plus += c.plus ?? 0; e.del += c.del ?? 0;
    files.set(c.path, e);
  }
  let plus = 0, del = 0;
  for (const e of files.values()) { plus += e.plus; del += e.del; }
  const secs = Math.round(ms / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : secs + "s";
  const chip = el("button", "turn-chip");
  chip.type = "button";
  if (aborted) {
    chip.classList.add("aborted");
    chip.title = "本轮被取消（停止/插话打断）";
    const pre = el("span", "tc-aborted");
    pre.textContent = "已取消 · ";
    chip.appendChild(pre);
  }
  const t = el("span", "tc-time");
  t.textContent = dur;
  chip.appendChild(t);
  if (files.size || plus || del) {
    const f = el("span");
    f.textContent = ` · ${files.size} 文件`;
    const s = el("span", "tc-stats");
    if (plus) { const a = el("span", "add"); a.textContent = "+" + plus; s.appendChild(a); }
    if (del) { const d = el("span", "del"); d.textContent = "−" + del; s.appendChild(d); }
    f.appendChild(s);
    chip.appendChild(f);
    // P2 修复：aborted 轮的「本轮被取消」标题不被文件清单覆盖（有清单则并列展示）
    chip.title = aborted ? "本轮被取消（停止/插话打断）" + (files.size ? "\n" + [...files.keys()].join("\n") : "") : [...files.keys()].join("\n");
  } else {
    chip.classList.add("plain");
  }
  chip.addEventListener("click", () => {
    // 变更栏已砍（2026-10-06 设计轮）：chip 点击 → 树内定位本轮最近改动文件并闪烁
    ensureRightbarVisible();
    const first = files.size ? [...files.keys()][0] : null;
    if (first) void locateInTree(first);
  });
  chat.appendChild(chip);
  scrollBottom(false);
}

/* ================= 随手问：辅助对话 pane（2026-10-08 计划书阶段三） =================
 * 每工作区独立小会话（主进程 auxSessions in-memory）；默认 noTools + 默认模型 low 档（2026-10-12 开源改造随默认模型）。
 * aux_event 必带 cwd 归属，只处理当前工作区（pi:event 共享通道防串台）；
 * assistant 气尾「插入主输入框」只写 composer 不自动发送。 */
let auxCollapsed = localStorage.getItem("pi-gui:aux-collapsed") === "1";
const auxMsgsByCwd = new Map(); // cwd → [{role, text, streaming?}]（渲染层权威，aux:state 兜底恢复）
const auxBusyByCwd = new Map(); // cwd → bool。P0 修复（2026-10-10 审计）：原全局 auxBusy 被 cwd 归属过滤
// 吞掉终态事件（流式中切走工作区→busy 永卡、按钮锁死），改为按归属落账、仅渲染层看当前工作区

function auxRenderMsgs() {
  const box = $("aux-msgs");
  if (!box) return;
  const cwd = state?.cwd ?? "";
  const list = auxMsgsByCwd.get(cwd) ?? [];
  box.replaceChildren();
  if (!list.length) {
    const e = el("div", "aux-empty");
    e.textContent = "顺手问一句，不打断主对话；勾「附上下文」带最近背景。";
    box.appendChild(e);
    return;
  }
  for (const m of list) {
    const row = el("div", "aux-row" + (m.role === "user" ? " me" : ""));
    const b = el("div", "aux-bubble" + (m.streaming ? " streaming" : ""));
    b.textContent = m.text;
    row.appendChild(b);
    if (m.role === "assistant" && m.text && !m.streaming) {
      const ins = el("button", "aux-ins mini-ic");
      ins.type = "button";
      ins.title = "插入主输入框（不自动发送）";
      ins.setAttribute("aria-label", "插入主输入框");
      ins.appendChild(svgUse("#i-pencil", "ic ic-s"));
      ins.addEventListener("click", () => {
        insertAtCursor(m.text);
        input.focus();
      });
      row.appendChild(ins);
    }
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

async function auxLoadState() {
  const cwd = state?.cwd;
  if (!cwd || auxMsgsByCwd.has(cwd)) { auxRenderMsgs(); return; }
  try {
    const r = await window.pi.auxState(cwd);
    auxMsgsByCwd.set(cwd, (r?.messages ?? []).map((m) => ({ role: m.role, text: m.text })));
    auxBusyByCwd.set(cwd, !!r?.busy); // 主进程真值（reload 找回时在跑的回合按钮态正确）
  } catch { auxMsgsByCwd.set(cwd, []); }
  auxSetBusy(auxBusyByCwd.get(cwd) ?? false);
  auxRenderMsgs();
}

function auxSetBusy(v) {
  if (state?.cwd) auxBusyByCwd.set(state.cwd, v);
  $("aux-send").classList.toggle("hidden", v);
  $("aux-stop").classList.toggle("hidden", !v);
}

async function auxSend() {
  const cwd = state?.cwd;
  const inp = $("aux-input");
  const text = inp.value.trim();
  if (!text || !cwd || (auxBusyByCwd.get(cwd) ?? false)) return;
  inp.value = "";
  auxSetBusy(true);
  const list = auxMsgsByCwd.get(cwd) ?? [];
  list.push({ role: "user", text });
  auxMsgsByCwd.set(cwd, list);
  auxRenderMsgs();
  try {
    await window.pi.auxSend(cwd, text, $("aux-ctx-on").checked);
  } catch (err) {
    list.push({ role: "assistant", text: "（发送失败）" + String(err?.message ?? err) });
    auxSetBusy(false);
    auxRenderMsgs();
  }
}

function auxHandleEvent(evt) {
  // P0 修复（2026-10-10 审计）：落账与渲染分层——终态事件（done/error）按事件自带 cwd 落账，
  // 切走的工作区也照常结账（busy 复位、气泡定稿），只有渲染和按钮作用于当前工作区。
  const cwd = evt.cwd;
  if (!cwd) return;
  const isCurrent = cwd === state?.cwd;
  const e = evt.event ?? {};
  const list = auxMsgsByCwd.get(cwd) ?? [];
  if (e.type === "delta") {
    const last = list[list.length - 1];
    if (last && last.role === "assistant" && last.streaming) last.text += e.text ?? "";
    else list.push({ role: "assistant", text: e.text ?? "", streaming: true });
  } else if (e.type === "done") {
    const finalText = e.stopped && !e.text ? "（已停止）" : (e.text || "（空回复）");
    const last = list[list.length - 1];
    if (last && last.role === "assistant" && last.streaming) { last.text = finalText; delete last.streaming; }
    else list.push({ role: "assistant", text: finalText });
  } else if (e.type === "error") {
    list.push({ role: "assistant", text: "（出错）" + (e.message ?? "") });
  } else {
    return;
  }
  auxMsgsByCwd.set(cwd, list);
  auxBusyByCwd.set(cwd, e.type === "delta"); // delta=进行中；done/error=结束
  if (isCurrent) {
    auxSetBusy(e.type === "delta");
    auxRenderMsgs();
  }
}

$("aux-head").addEventListener("click", () => {
  auxCollapsed = !auxCollapsed;
  localStorage.setItem("pi-gui:aux-collapsed", auxCollapsed ? "1" : "0");
  $("aux-pane").classList.toggle("collapsed", auxCollapsed);
  $("aux-head").setAttribute("aria-expanded", auxCollapsed ? "false" : "true");
});
$("aux-pane").classList.toggle("collapsed", auxCollapsed);
$("aux-send").addEventListener("click", () => void auxSend());
$("aux-stop").addEventListener("click", () => { void window.pi.auxAbort(state?.cwd).catch(() => {}); });
$("aux-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void auxSend(); }
  if (e.key === "Escape") e.stopPropagation();
});

/* ================= 侧栏 ================= */

function renderSidebar() {
  if (!state) return;
  syncSceneSeg(); // 场景档位高亮随会话/模型态刷新（2026-10-10 替代 composer 模型下拉）
  if (graphMode) scheduleGraphReload(); // 图谱模式：会话/工作区切换后重拉归属图（防抖，2026-10-08）
  void auxLoadState(); // 随手问：工作区切换跟随（带缓存，重入安全）
}

let models = [];

/* ---- 视觉模型自动切换（2026-10-05 owner 需求）：能力驱动 ----
 * 带图发送且当前模型 input 不含 image → 自动 setModel 到配置目标（目录里真实支持图片的模型），
 * 记住原模型；无图发送且仍停在自动目标上 → 回切。手动切模型即接管，清自动状态。
 * 限制：回切后历史里的图片内容能否被纯文本模型容忍取决于服务端（GLM 通常忽略/过滤），出错可手动切回。 */
function visionCfgLoad() {
  try {
    const c = JSON.parse(localStorage.getItem("pi-gui:vision-auto") ?? "");
    if (c && typeof c === "object" && typeof c.on === "boolean") {
      return { on: c.on, target: typeof c.target === "string" ? c.target : "" };
    }
  } catch { /* 坏配置回默认 */ }
  return { on: true, target: "" };
}
function visionCfgSave(cfg) {
  localStorage.setItem("pi-gui:vision-auto", JSON.stringify(cfg));
}
let visionAutoPrev = ""; // 自动切换前的模型 ref（provider|id），空 = 无待回切
async function maybeVisionSwitch(imgs) {
  if (!state?.model) return;
  const cur = state.model;
  const curRef = cur.provider + "|" + cur.id;
  const cfg = visionCfgLoad();
  if (imgs?.length) {
    if (Array.isArray(cur.input) && cur.input.includes("image")) return; // 当前模型就能看图
    if (!cfg.on) return;
    // target 空时自动落到可用视觉模型（2026-10-07：此前 target 空静默不切——零配置也应生效）
    let targetRef = cfg.target;
    if (!targetRef) {
      const fallback = models.find((m) => Array.isArray(m.input) && m.input.includes("image"));
      if (fallback) targetRef = fallback.provider + "|" + fallback.id;
    }
    if (!targetRef) return;
    const target = models.find((m) => m.provider + "|" + m.id === targetRef);
    if (!target || !Array.isArray(target.input) || !target.input.includes("image")) {
      showNotice("视觉自动切换：目标模型不可用（" + targetRef + "）", true);
      return;
    }
    try {
      state = await window.pi.setModel(target.provider, target.id);
      visionAutoPrev = curRef;
      syncSceneSeg();
    } catch (err) {
      showNotice("视觉模型切换失败：" + String(err?.message ?? err), true);
    }
    return;
  }
  // 无图：若因自动切换停留在目标模型上，回切原模型
  if (visionAutoPrev && curRef === cfg.target && curRef !== visionAutoPrev) {
    try {
      const [p, id] = visionAutoPrev.split("|");
      state = await window.pi.setModel(p, id);
      visionAutoPrev = "";
      syncSceneSeg();
    } catch { /* 回切失败不打断发送，留在当前模型 */ }
  }
}
function stRenderVisionRow() {
  const box = $("st-vision-target");
  if (!box) return;
  const cfg = visionCfgLoad();
  const vis = models.filter((m) => Array.isArray(m.input) && m.input.includes("image"));
  box.innerHTML = "";
  if (!vis.length) {
    box.disabled = true;
    box.title = "目录中暂无支持图片输入的模型";
    const o = document.createElement("option");
    o.textContent = "（无视觉模型）";
    box.appendChild(o);
  } else {
    box.disabled = false;
    box.title = "视觉目标模型（仅列支持图片输入的模型）";
    if (!vis.some((m) => m.provider + "|" + m.id === cfg.target)) {
      // 默认目标：优先 flash 系（轻量省钱惯例，如 glm-5.3-flash/kimi-flash），否则首个视觉模型
      const prefer = vis.find((m) => /flash/i.test(m.id)) ?? vis[0];
      cfg.target = prefer.provider + "|" + prefer.id;
    }
    for (const m of vis) {
      const o = document.createElement("option");
      const ref = m.provider + "|" + m.id;
      o.value = ref;
      o.textContent = m.provider + " / " + m.name;
      if (ref === cfg.target) o.selected = true;
      box.appendChild(o);
    }
    cfg.target = box.value;
  }
  $("st-vision-on").checked = cfg.on;
  visionCfgSave(cfg);
}
$("st-vision-on").addEventListener("change", () => {
  const cfg = visionCfgLoad();
  cfg.on = $("st-vision-on").checked;
  visionCfgSave(cfg);
});
$("st-vision-target").addEventListener("change", () => {
  const cfg = visionCfgLoad();
  cfg.target = $("st-vision-target").value;
  visionCfgSave(cfg);
});

async function loadModels() {
  models = await window.pi.getModels();
  // models 加载日志已删（P2：每次切会话刷主进程 stdout 噪音；排障时按需临时加回）
  syncSceneSeg();
  stRenderVisionRow(); // 视觉目标下拉随目录刷新（默认填第一个视觉模型）
}

/* ---------- 引导向导（2026-10-12 开源阶段 1：首启动配置环境；交互稿 design/onboarding-wizard-20261012.html） ----------
 * 触发：init 完成时无可用模型（全新用户）→ 全屏占屏；跳过仅本次会话不弹（下次启动无模型仍弹）。
 * 完成链：onboard:save 写 models.json+settings 默认 → loadModels 主动重拉（绕开「保存后无人刷新下拉」既有缺口）+ refreshScenes。
 * PI_GUI_TEST_ONBOARD=1（主进程侧）时 test/save 零网络零写盘；渲染端 __obShow 钩子供 verify 强制唤起。 */
let OB_PRESETS = null;
let obStep = 1;
let obPicked = null;
let obModelPicked = 0;
let obCustomModels = [];
let obTestPassed = false;

const OB_ICONS = { zhipu: ["智", "#3B82F6"], deepseek: ["D", "#4A6FA5"], kimi: ["K", "#10A37F"], openrouter: ["O", "#7C3AED"], custom: ["＋", "#8A8073"] };

function obBuildProvGrid() {
  const grid = $("ob-prov-grid");
  grid.innerHTML = "";
  if (!OB_PRESETS) { grid.textContent = "服务商预置加载失败——重启应用重试，或在设置 → 模型与提供商 手动配置。"; return; }
  for (const key of Object.keys(OB_PRESETS)) {
    const P = OB_PRESETS[key];
    const card = el("div", "ob-prov" + (key === "custom" ? " ghost" : "") + (key === "zhipu" ? " sel" : ""));
    card.dataset.p = key;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", "选择 " + P.label);
    if (key !== "custom") {
      const nm = el("div", "nm");
      const ic = el("span", "ic");
      ic.style.background = OB_ICONS[key][1];
      ic.textContent = OB_ICONS[key][0];
      nm.append(ic, Object.assign(el("span"), { textContent: P.label }));
      card.appendChild(nm);
      const tags = el("div", "tags");
      P.tags.forEach((t, i) => { const tg = el("span", "tag" + (i === 0 && key === "zhipu" ? " hot" : "")); tg.textContent = t; tags.appendChild(tg); });
      card.appendChild(tags);
      card.appendChild(Object.assign(el("div", "ds"), { textContent: P.desc }));
      const ck = el("span", "ck");
      ck.textContent = "✓";
      card.appendChild(ck);
    } else {
      const nm = el("div", "nm");
      nm.style.justifyContent = "center";
      nm.textContent = "＋ " + P.label;
      card.appendChild(nm);
      const ds = el("div", "ds");
      ds.style.textAlign = "center";
      ds.style.marginTop = "6px";
      ds.textContent = P.desc;
      card.appendChild(ds);
    }
    const pick = () => obPickProv(key, card);
    card.addEventListener("click", pick);
    card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    grid.appendChild(card);
  }
}

function obPickProv(key, card) {
  document.querySelectorAll(".ob-prov").forEach((p) => p.classList.remove("sel"));
  card.classList.add("sel");
  obPicked = key;
  obTestPassed = false;
  obCustomModels = [];
  const P = OB_PRESETS[key];
  $("ob-p3-title").textContent = P.label + "：获取 API Key";
  const list = $("ob-s3list");
  list.innerHTML = "";
  P.steps.forEach((s, i) => {
    const row = el("div", "ob-s3row");
    row.appendChild(Object.assign(el("span", "ob-s3n"), { textContent: String(i + 1) }));
    const tx = el("div", "tx");
    tx.textContent = s;
    const sm = el("small");
    sm.textContent = i === 0 ? P.regHost : i === 1 ? "新账户通常附赠免费额度" : "Key 只显示一次，注意保存";
    tx.appendChild(sm);
    row.appendChild(tx);
    list.appendChild(row);
  });
  const link = $("ob-reg-link");
  if (P.regUrl) { link.classList.remove("hidden"); link.href = P.regUrl; }
  else link.classList.add("hidden");
  $("ob-custom-url-row").classList.toggle("hidden", key !== "custom");
  obGo(3);
}

function obGo(n) {
  obStep = Math.max(1, Math.min(6, n));
  for (let i = 1; i <= 6; i++) $("ob-p" + i).classList.toggle("hidden", i !== obStep);
  document.querySelectorAll(".ob-step").forEach((s) => {
    const sn = +s.dataset.s;
    s.classList.toggle("now", sn === obStep || (obStep === 6 && sn === 5));
    s.classList.toggle("done", sn < obStep || obStep === 6);
  });
  document.querySelectorAll(".ob-bar").forEach((b) => b.classList.toggle("done", +b.dataset.b < obStep));
  $("ob-prev").classList.toggle("hidden", obStep === 1 || obStep === 6);
  const nb = $("ob-next");
  nb.classList.add("hidden");
  if (obStep === 3) { nb.classList.remove("hidden"); nb.textContent = "我已拿到 Key →"; }
  if (obStep === 4 && obTestPassed) { nb.classList.remove("hidden"); nb.textContent = "选择默认模型 →"; }
  if (obStep === 5) { nb.classList.remove("hidden"); nb.textContent = "完成 ✓"; obRenderModels(); }
  $("ob-foot").style.visibility = obStep === 6 ? "hidden" : "visible";
}

async function obTestConn() {
  const out = $("ob-testout");
  const btn = $("ob-testbtn");
  const key = $("ob-keyinput").value.trim();
  const base = $("ob-baseurl").value.trim();
  if (!key) { out.className = "ob-testout bad"; out.textContent = "请先粘贴 API Key"; return; }
  if (obPicked === "custom" && !/^https?:\/\//i.test(base)) { out.className = "ob-testout bad"; out.textContent = "请先填写 API 地址（http(s):// 开头）"; return; }
  btn.disabled = true;
  btn.textContent = "测试中…";
  out.className = "ob-testout";
  const sp = el("span", "spin");
  out.textContent = "";
  out.append(sp, "正在连接 " + (OB_PRESETS[obPicked]?.label ?? "") + " …");
  try {
    const r = await window.pi.onboardTest(obPicked, base, key);
    if (r?.ok) {
      obTestPassed = true;
      obCustomModels = Array.isArray(r.ids) ? r.ids.filter(Boolean) : [];
      out.className = "ob-testout ok";
      out.textContent = "✓ 连接成功——检测到 " + (r.count ?? 0) + " 个模型。点击右下「选择默认模型」继续。";
      $("ob-next").classList.remove("hidden");
      $("ob-next").textContent = "选择默认模型 →";
    } else {
      out.className = "ob-testout bad";
      out.textContent = "✗ " + (r?.error ?? "未知错误");
    }
  } catch (e) {
    out.className = "ob-testout bad";
    out.textContent = "✗ " + String(e?.message ?? e);
  } finally {
    btn.disabled = false;
    btn.textContent = "测试连接";
  }
}

function obRenderModels() {
  const box = $("ob-modelist");
  box.innerHTML = "";
  let list = [];
  if (obPicked === "custom") {
    list = obCustomModels.map((id) => ({ id, name: id, desc: "（来自端点模型列表）", badge: null }));
    if (!list.length) list = [{ id: "", name: "未检测到模型", desc: "请返回上一步完成测试连接", badge: null }];
  } else {
    list = OB_PRESETS[obPicked]?.models ?? [];
  }
  list.forEach((m, i) => {
    const r = el("div", "ob-mrow" + (i === obModelPicked ? " sel" : ""));
    r.tabIndex = 0;
    r.setAttribute("role", "radio");
    r.setAttribute("aria-label", "默认模型 " + (m.name ?? m.id));
    r.appendChild(el("span", "radio"));
    const mid = el("div");
    mid.appendChild(Object.assign(el("div", "mn"), { textContent: m.name ?? m.id }));
    mid.appendChild(Object.assign(el("div", "md"), { textContent: m.desc ?? "" }));
    r.appendChild(mid);
    if (m.badge) r.appendChild(Object.assign(el("span", "badge"), { textContent: m.badge }));
    const pick = () => { obModelPicked = i; obRenderModels(); };
    r.addEventListener("click", pick);
    r.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    box.appendChild(r);
  });
  box.dataset.count = String(list.length);
  box.dataset.pickedId = list[obModelPicked]?.id ?? "";
}

async function obFinish() {
  const modelId = obPicked === "custom" ? obCustomModels[obModelPicked] : OB_PRESETS[obPicked]?.models?.[obModelPicked]?.id;
  if (!modelId) { alert("请先选择默认模型"); return; }
  try {
    const r = await window.pi.onboardSave(obPicked, {
      baseUrl: $("ob-baseurl").value.trim(),
      apiKey: $("ob-keyinput").value.trim(),
      modelId,
      models: obPicked === "custom" ? obCustomModels : undefined,
    });
    $("ob-fin-sub").textContent = (OB_PRESETS[obPicked]?.label ?? r?.provider) + " · " + modelId + " 已设为默认模型";
    // 主动重拉：models.json 已写、主进程 runtime 已刷新，渲染端下拉立即跟上（既有「保存后无人刷新」缺口在此绕开）
    await loadModels();
    void refreshScenes();
    obGo(6);
  } catch (e) {
    alert("保存失败：" + String(e?.message ?? e));
  }
}

async function obInit() {
  OB_PRESETS = await window.pi.onboardPresets().catch(() => null);
  obBuildProvGrid();
  $("ob-start").addEventListener("click", () => obGo(2));
  $("ob-prev").addEventListener("click", () => obGo(obStep - 1));
  $("ob-next").addEventListener("click", () => { if (obStep === 5) void obFinish(); else obGo(obStep + 1); });
  $("ob-skip").addEventListener("click", () => { $("onboard-overlay").classList.add("hidden"); input.focus(); });
  $("ob-finish").addEventListener("click", () => { $("onboard-overlay").classList.add("hidden"); input.focus(); });
  $("ob-testbtn").addEventListener("click", () => void obTestConn());
  $("ob-eye").addEventListener("click", () => {
    const inp = $("ob-keyinput");
    inp.type = inp.type === "password" ? "text" : "password";
  });
}
function obShow() { $("onboard-overlay").classList.remove("hidden"); obGo(1); }
window.__obShow = obShow; // verify 钩子（IIFE 内函数 CDP 不可达——显式挂 window 惯例）
window.__obState = () => JSON.stringify({ step: obStep, picked: obPicked, testPassed: obTestPassed, modelPicked: obModelPicked });

$("btn-new-session").addEventListener("click", async () => {
  // 不再弹确认：新会话保留旧会话在侧栏、不打断运行中任务，误点零成本（2026-10-04 owner 需求）
  const home = homeDir ?? (await window.pi.wsList().catch(() => ({}))).homeDir;
  if (home) homeDir = home;
  await startSession(home ?? state?.cwd); // 自由会话：cwd=主目录，不登记为工作区
});

/* ---- 会话分支：查看/切换（找回弃用分支） ---- */

function renderHistory(messages) {
  const __t0 = performance.now(); // [perf] 切换热点拆分（2026-10-07 优化计划：数据说话）
  // R3 水合门控：标志位 + .enter 类（rAF 方案在后台窗口永不触发、卡死，已废弃）
  hydrating = true;
  hidePhase(); // 切会话/重渲染不留上一会话的阶段占位
  const segmented = (messages ?? []).length > 240; // 切换微卡（2026-10-07）：超大会话分段——实测 433 条全量 1145ms 主热点
  try {
    chat.innerHTML = "";
    curMsg = null;
    looseLive = []; // E1.1：整棵重建，间隙登记清零（预扫集接管标记）
    historyGen++; // 代际+1：作废上一轮可能仍在跑的 idle 补齐
    const gen = historyGen;
    const msgs = messages ?? [];
    // 1.1.0 toolResult 落盘带 durationMs（Q2/Q8）：预扫一遍建 toolCallId → {durationMs, isError} 映射，
    // 供 renderOne 收尾卡片回填耗时（旧会话无此字段 → undefined → 维持「历史」无耗时）；后写覆盖前写，重试取最新
    const toolResultMap = new Map();
    for (const m of msgs) {
      if (m?.role === "toolResult" && m.toolCallId) {
        toolResultMap.set(m.toolCallId, { durationMs: m.durationMs, isError: m.isError === true });
      }
    }
    // E1.1 间隙弱化预扫（2026-10-11 计划书）：分段补齐批乱序到达，live 标记会漏跨批——
    // 按会话语序预扫 "消息序号:块序号" 集合：本轮（相邻 user 消息之间）位于后续 toolCall 之前的 text 块
    const looseKeys = new Set();
    {
      const pend = [];
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (m?.role === "user") { pend.length = 0; continue; }
        if (m?.role !== "assistant") continue; // toolResult 等不重置段
        const content = m.content ?? [];
        for (let j = 0; j < content.length; j++) {
          const b = content[j];
          if (b?.type === "text" && b.text?.trim()) pend.push(i + ":" + j);
          else if (b?.type === "toolCall") { for (const k of pend) looseKeys.add(k); pend.length = 0; }
        }
      }
    }
    // 单条渲染（i=msgs 序号供 looseKeys 定位；into=frag 用于前部补齐批；默认 chat 尾部 append）
    const renderOne = (m, i, into) => {
      if (m.role === "user") {
        const c = m.content;
        let text = "";
        const imgs = [];
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b?.type === "text") text += (text ? " " : "") + b.text;
            else if (b?.type === "image") imgs.push({ type: "image", data: b.data, mimeType: b.mimeType });
          }
        }
        addUserBubble(text, imgs, into);
      } else if (m.role === "assistant") {
        beginAssistant(into);
        const looseIdx = new Set();
        const content = m.content ?? [];
        for (let j = 0; j < content.length; j++) if (looseKeys.has(i + ":" + j)) looseIdx.add(j);
        finalizeAssistant(m, looseIdx);
        if (curMsg) {
          // 空回合已被 finalizeAssistant 移除（curMsg=null），跳过卡片收尾，否则中断整个历史渲染（2026-10-03 实测坑）
          // 1.1.0 toolResult 落盘带 durationMs（Q2/Q8）：按 toolCallId 映射回填卡片耗时；旧会话无此字段则维持「历史」
          for (const [cid, card] of curMsg.cards) {
            const tr = toolResultMap.get(cid);
            finishCard(card, null, tr?.isError === true, "历史", tr?.durationMs);
          }
        }
        curMsg = null;
      }
    };
    // 尾部收尾（todo 快照用全量 messages 数据，不依赖 DOM 分段进度）
    const finalize = () => {
      const todoSnap = todoCollectFromMessages(messages);
      if (todoSnap) todoBySession.set(state?.sessionId, todoSnap.filter((t) => t && t.status !== "deleted"));
      todoTurnActive = false;
      renderTodoPanel();
      renderAskCards(); // ask 待答/已答卡重挂（2026-10-08 对话内卡片：#chat 重建后找回）
      if (!chat.children.length) mountWelcome();
      scrollBottom(true);
    };
    if (segmented) {
      // 先同步渲尾部 120 条（可见窗口+当前轮，输入框尽快可交互），前部 idle 分批插最前（保序）。
      // rIC 仅在可见窗口触发（AGENTS 账），切换场景天然可见；补齐期间重渲/切走由代际作废
      const TAIL = 40, IDLE_BATCH = 24; // 实测：assistant ≈16ms/条（md+hljs），user ≈0.1ms——
      // 尾段 40 条（~20 asst ≈ 320ms）同步可控；idle 批 24 条（~190ms/批）防 rIC 回调本身长卡
      let __tu = 0, __ta = 0;
      const tailStart = msgs.length - TAIL;
      msgs.slice(-TAIL).forEach((m, k) => {
        const __s = performance.now();
        renderOne(m, tailStart + k);
        const __d = performance.now() - __s;
        if (m.role === "user") __tu += __d; else __ta += __d;
      });
      const __tTail = performance.now();
      finalize();
      console.log(`[perf] renderHistory 尾段渲染 ${Math.round(__tTail - __t0)}ms（user=${Math.round(__tu)} asst=${Math.round(__ta)}，尾 ${TAIL} 条）`);
      let idx = msgs.length - TAIL;
      const pump = () => {
        if (gen !== historyGen) return; // 代际已换：旧补齐作废
        const from = Math.max(0, idx - IDLE_BATCH);
        if (from < idx) {
          hydrating = true; // 补齐批属历史水合：不加 .enter（R3 零回放）
          try {
            const frag = document.createDocumentFragment();
            for (let i = from; i < idx; i++) renderOne(msgs[i], i, frag);
            chat.insertBefore(frag, chat.firstChild); // 整批插最前，全局顺序保持
          } finally { hydrating = false; }
          idx = from;
        }
        if (idx > 0) requestIdleCallback(pump);
        else {
          const dom = chat.querySelectorAll(".msg");
          console.log(`[perf] renderHistory 补齐完成 ${Math.round(performance.now() - __t0)}ms（输入 ${msgs.length} 条：user=${msgs.filter(m=>m.role==="user").length} asst=${msgs.filter(m=>m.role==="assistant").length}；DOM .msg=${dom.length} user=${chat.querySelectorAll(".msg-user").length} asst=${chat.querySelectorAll(".msg-assistant").length}）`);
        }
      };
      requestIdleCallback(pump);
    } else {
      msgs.forEach((m, i) => renderOne(m, i));
      finalize();
    }
  } finally {
    hydrating = false;
    console.log(`[perf] renderHistory 同步段 ${Math.round(performance.now() - __t0)}ms（${(messages ?? []).length} 条${segmented ? "，分段：尾部同步+前部 idle 补齐" : ""}）`);
  }
}

/** D1 扫描视图：全库多分支（弃用）会话列表，点击叶=跨会话导航 */
async function renderBranchScanView(list) {
  list.innerHTML = '<div class="branch-empty">扫描中…</div>';
  let data;
  try {
    data = await window.pi.scanBranches();
  } catch (err) {
    list.innerHTML = "";
    const e = el("div", "branch-empty");
    e.textContent = "扫描失败：" + String(err?.message ?? err);
    list.appendChild(e);
    return;
  }
  list.innerHTML = "";
  const back = el("button", "branch-scan-back");
  back.type = "button";
  back.textContent = "← 本会话分支";
  back.addEventListener("click", () => toggleBranchList(true)); // 重新打开本会话视图
  list.appendChild(back);
  const head = el("div", "branch-scan-head");
  head.textContent = data.sessions.length
    ? `含弃用分支的会话 ${data.sessions.length} 个（点分支即跳转）`
    : "全部会话都没有弃用分支";
  list.appendChild(head);
  for (const s of data.sessions) {
    const grp = el("div", "branch-scan-grp");
    const gh = el("div", "branch-scan-grp-head");
    gh.title = s.file;
    gh.textContent = `${s.name} · ${s.leafCount} 分支 · ${s.cwd || "(cwd 未知)"}`;
    grp.appendChild(gh);
    for (const lf of s.leaves) {
      if (lf.active && s.leafCount > 1) {
        // 默认恢复分支也列出（标注），可跳非默认
      }
      const item = el("div", "branch-item" + (lf.active ? " active" : ""));
      const prev = el("div", "branch-preview");
      prev.textContent = lf.preview;
      const meta = el("div", "branch-meta");
      meta.textContent = (lf.active ? "▶ 默认分支" : lf.onActive ? "主线上" : "弃用分支") + (lf.time ? " · " + lf.time : "");
      item.append(prev, meta);
      if (!lf.active) {
        item.addEventListener("click", async () => {
          try {
            const r = await window.pi.navigateToBranch(s.file, s.cwd, lf.id);
            if (!r || r.cancelled) return;
            state = r.state;
            renderSidebar();
            renderHistory(r.messages ?? []);
            list.classList.add("hidden");
          } catch (err) {
            showNotice("跳转失败：" + String(err?.message ?? err), true);
          }
        });
      }
      bindKbd(item, () => item.click(), "option"); // 键盘批：分支条目 Enter=单击语义（active 项 click 无绑定，安全）
      grp.appendChild(item);
    }
    list.appendChild(grp);
  }
}

async function toggleBranchList(forceReopen) {
  const list = $("branch-list");
  if (!forceReopen && !list.classList.contains("hidden")) {
    list.classList.add("hidden");
    return;
  }
  try {
    const data = await window.pi.branches();
    list.innerHTML = "";
    list.classList.remove("hidden");
    const scanBtn = el("button", "branch-scan-btn");
    scanBtn.type = "button";
    scanBtn.textContent = "扫全部会话的弃用分支";
    scanBtn.title = "扫描 sessions 目录，找出所有含未在用分支（弃用/主线外）的会话，点击可跳转";
    scanBtn.addEventListener("click", () => renderBranchScanView(list));
    list.appendChild(scanBtn);
    if (!data.leaves.length) {
      const e = el("div", "branch-empty");
      e.textContent = "本会话还没有分支";
      list.appendChild(e);
      return;
    }
    for (const lf of data.leaves) {
      const item = el("div", "branch-item" + (lf.active ? " active" : ""));
      const prev = el("div", "branch-preview");
      prev.textContent = lf.preview || "（无用户消息）";
      const meta = el("div", "branch-meta");
      meta.textContent = (lf.active ? "▶ 当前分支" : lf.onActive ? "主线上" : "弃用分支") + (lf.time ? " · " + lf.time : "");
      item.append(prev, meta);
      if (!lf.active) {
        item.addEventListener("click", async () => {
          const r = await window.pi.navigateBranch(lf.id);
          if (!r || r.cancelled) return;
          state = r.state;
          renderSidebar();
          renderHistory(r.messages ?? []);
          list.classList.add("hidden");
        });
      } else {
        item.addEventListener("click", () => list.classList.add("hidden"));
      }
      list.appendChild(item);
    }
  } catch (err) {
    showNotice("读取分支失败：" + (err?.message ?? err), true);
  }
}
/* ---- Todo 面板：点击标题行折叠/展开（持久化到 localStorage，同外观设置套路） ---- */
$("todo-head").addEventListener("click", () => {
  todoCollapsed = !todoCollapsed;
  localStorage.setItem("pi-gui:todo-collapsed", todoCollapsed ? "1" : "0");
  renderTodoPanel();
});

/* 子代理任务面板已删（2026-10-08 owner 拍板：非刚需且挤占右栏）——
 * spawn_subagent 工具与 fan-out/readOnly 参数保留（main.js 工具层自洽，结果照回对话），
 * subagent_status 事件推送链保留但渲染端不再消费（handleEvent 忽略分支）。 */

/* ---- 双模型同题对比 ---- */

let cmpActive = null; // {id, sides:{a:{buf,think,done,usage,tools}, b:{...}}}
let cmpRenderQueued = false;

function cmpFillSelects() {
  for (const id of ["cmp-model-a", "cmp-model-b"]) {
    $(id).replaceChildren(...models.map((m) => new Option(m.name, m.provider + "|" + m.id)));
  }
  const cur = state?.model ? `${state.model.provider}|${state.model.id}` : null;
  if (cur) {
    $("cmp-model-a").value = cur;
    const other = models.find((m) => `${m.provider}|${m.id}` !== cur);
    if (other) $("cmp-model-b").value = `${other.provider}|${other.id}`;
  }
}

function cmpColumn(side) {
  return cmpActive?.sides?.[side] ?? null;
}

function cmpScheduleRender() {
  if (cmpRenderQueued || !cmpActive) return;
  cmpRenderQueued = true;
  requestAnimationFrame(() => {
    cmpRenderQueued = false;
    for (const side of ["a", "b"]) {
      const col = cmpColumn(side);
      if (!col) continue;
      const body = $("cmp-body-" + side);
      let html = "";
      if (col.think) html += `<details class="thinking"><summary>思考过程</summary><div class="thinking-body"></div></details>`;
      html += md(col.buf);
      setHtml(body, html);
      if (col.think) body.querySelector(".thinking-body").textContent = col.think; // 2026-10-08 晚恢复
      highlightIn(body);
      body.scrollTop = body.scrollHeight;
    }
  });
}

function cmpHandleEvent(evt) {
  if (!cmpActive || evt.cmpId !== cmpActive.id) return;
  const col = cmpColumn(evt.side);
  if (!col) return;
  const e = evt.event ?? {};
  if (e.type === "text_delta") col.buf += e.delta;
  else if (e.type === "thinking_delta") col.think += e.delta;
  else if (e.type === "tool_used") col.tools++;
  else if (e.type === "settled") {
    col.done = true;
    if (e.usage) col.usage = e.usage;
  } else if (e.type === "cmp_error") {
    col.buf += "\n\n[错误] " + (e.message ?? "");
    col.done = true;
  }
  const meta = $("cmp-meta-" + evt.side);
  if (meta) {
    const bits = [];
    if (col.tools) bits.push("工具×" + col.tools);
    if (col.usage) bits.push(`↑${col.usage.input ?? 0} ↓${col.usage.output ?? 0}`); // $ 已删：MAX 包月按量费用无意义（2026-10-03）
    if (col.done) bits.unshift("✓");
    meta.textContent = bits.join(" · ");
  }
  cmpScheduleRender();
}

function openCompare() {
  cmpFillSelects();
  $("cmp-overlay").classList.remove("hidden");
}

$("cmp-close").addEventListener("click", async () => {
  if (cmpActive && !cmpActive.finished) await window.pi.cmpAbort();
  $("cmp-overlay").classList.add("hidden");
  cmpActive = null;
});

$("cmp-run").addEventListener("click", async () => {
  const question = $("cmp-question").value.trim();
  if (!question) { showNotice("先输入要对比的问题"); return; }
  try {
    // 直接传 "provider|modelId"，主进程双字段匹配，避免同 id 不同 provider 撞车
    const { cmpId } = await window.pi.cmpStart({
      question,
      modelA: $("cmp-model-a").value,
      modelB: $("cmp-model-b").value,
    });
    cmpActive = {
      id: cmpId,
      finished: false,
      sides: {
        a: { buf: "", think: "", done: false, tools: 0 },
        b: { buf: "", think: "", done: false, tools: 0 },
      },
    };
    for (const side of ["a", "b"]) $("cmp-body-" + side).innerHTML = "";
    $("cmp-meta-a").textContent = ""; $("cmp-meta-b").textContent = "";
    $("cmp-grid").classList.remove("hidden");
    $("cmp-status").textContent = "对比中…";
    $("cmp-run").disabled = true;
  } catch (err) {
    showNotice("对比启动失败：" + (err?.message ?? err), true);
  }
});

async function startSession(cwd, sessionPath) {
  const __t0 = performance.now(); // [perf] 切换热点拆分：ipc（含主进程 open 解析/序列化）vs render vs tail
  if (sessionPath) unreadPaths.delete(String(sessionPath)); // R3：打开即视为已读，清绿点
  const preSwitch = { input: input.value, atts: attachments, attsLen: attachments.length }; // 切换开始瞬间的输入框/附件（防切换期间敲字贴图被 restoreDraft 抹掉）
  saveDraft(); // 切走前保存当前会话的输入框草稿（文字+附件，2026-10-05）
  try {
    state = await window.pi.createSession(cwd ?? null, sessionPath ?? null);
    console.log(`[perf] startSession ipc ${Math.round(performance.now() - __t0)}ms`);
  } catch (err) {
    showNotice("会话创建失败：" + (err?.message ?? err), true);
    return;
  }
  localStorage.setItem("pi-gui:cwd", state.cwd ?? "");
  curMsg = null;
  lastUsage = null;
  changedFiles = [];
  for (const k of Object.keys(pendingArgs)) delete pendingArgs[k]; // P2 修复：toolCallId 参数缓存跨会话残留（旧会话 id 撞新会话时摘要错源）
  updateCtxRing(); // 新会话无 lastUsage → 上下文环归隐
  if (state.messages?.length) {
    renderHistory(state.messages);
  } else {
    chat.innerHTML = "";
    mountWelcome();
  }
  renderTodoPanel(); // 新空会话无快照 → pane-empty 引导；有快照的会话由上面的 renderHistory 恢复
  setRunning(!!state.running); // 切回正在后台跑的会话时恢复运行态 UI
  restoreDraft(preSwitch); // 恢复本会话自己的输入框草稿（文字+附件，2026-10-05）
  renderSidebar();
  await loadModels();
  await renderFileRoot();
  renderSidebarTree();
  renderFooter();
  await loadCommands();
  console.log(`[perf] startSession total ${Math.round(performance.now() - __t0)}ms`);
}

/* ---- 侧栏树（2026-10-03 重构，对标 zcode：工作区=项目分组在顶部，会话挂在各自分组下） ---- */

const wsCollapsed = {}; // wsId → 是否折叠（内存态，重启重置）
let wsKeepByCwd = {}; // cwd → compactionKeep（2026-10-09 批次B3：右键压缩档菜单的当前值标记）
let showArchived = false;
let homeDir = null; // 自由会话的 cwd（主目录，ws:list 返回）
let sessionIndex = []; // 全工作区活跃会话索引（搜索用，renderSidebarTree 时刷新）

/* 会话条目（工作区分组与自由区共用，2026-10-03 提取）：点击打开。
   （拖拽跨工作区已删：2026-10-05 owner 实测拖不动且判定不好用） */
function makeSessionItem(s, ctx) {
  const unread = isUnread(s); // 必须先于一切使用（2026-10-07 修 TDZ：原稿声明在使用之后，侧栏首条目渲染即炸，整棵树中断）
  const item = el("div", "session-item" + (s.current ? " current" : ""));
  if (!unread) item.title = s.name + (s.running ? "（任务运行中，切走不中断）" : "");
  const name = el("div", "session-name");
  name.textContent = s.name;
  // 完成强提示（2026-10-07 owner 拍板）：整行完成态替代 R3 裸绿点（静态视觉，不做循环动效）
  if (unread) {
    item.classList.add("unread");
    item.title = s.name + "（后台任务已完成，点开查看）";
  }
  const meta = el("div", "session-meta");
  // 运行中 = 朱砂点（静态色语义，不用文字●）
  if (s.running) meta.append(el("span", "run-dot"), document.createTextNode("运行中 · "));
  else if (unread) {
    const done = el("span", "done-tag");
    done.textContent = "✓ 已完成";
    meta.append(done, document.createTextNode(" · "));
  }
  meta.append(document.createTextNode(`${s.modified.slice(5)} · ${s.messageCount}条`));
  if (s.running) meta.classList.add("running");
  const arc = el("span", "session-arc");
  arc.textContent = showArchived ? "还原" : "归档";
  arc.title = showArchived ? "取消归档" : "归档（从列表隐藏，不删除）";
  arc.addEventListener("click", async (e) => {
    e.stopPropagation();
    await window.pi.wsArchive(s.path, !showArchived);
    renderSidebarTree();
  });
  // UI 级关闭：仅内存中实例（inMemory）显示；关闭=卸载内存实例（运行中任务中止），文件保留
  const closeBtn = s.inMemory ? el("span", "session-close") : null;
  if (closeBtn) {
    closeBtn.textContent = "×";
    closeBtn.title = "关闭：从内存卸载该会话" + (s.running ? "（运行中任务将中止）" : "") + "，文件保留可重新打开";
    closeBtn.setAttribute("aria-label", "关闭会话（卸载内存实例）");
    closeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (s.running && !confirm("该会话有任务正在运行，关闭将中止它。继续？")) return;
      try {
        const r = await window.pi.closeSession(s.path);
        if (r.closed && r.wasCurrent) {
          if (r.state) await startSession(r.state.cwd, r.state.sessionPath ?? null);
          else await startSession(state?.cwd ?? null);
        } else {
          renderSidebarTree();
        }
      } catch (err) {
        showNotice("关闭失败：" + (err?.message ?? err), true);
      }
    });
  }
  item.addEventListener("click", async () => {
    if (s.current) return; // 切换不再中止任务：旧会话在后台继续跑（多会话并行）
    if (!ctx.free && !ctx.isActiveWs) await window.pi.wsSetActive(ctx.wsId);
    await startSession(ctx.cwd, s.path);
    // owner 2026-10-06：切换会话不再弹通知条（黄底文字）
  });
  bindKbd(item, () => item.click(), "option"); // 键盘批：会话条目 Enter/Space 切换
  bindKbd(arc, () => arc.click());
  if (closeBtn) bindKbd(closeBtn, () => closeBtn.click());
  item.append(name, meta, ...(closeBtn ? [closeBtn] : []), arc);
  return item;
}

/* 会话未读判定：后台任务完成未查看（完成强提示 2026-10-07：置顶/整行态/组头徽标共用） */
const isUnread = (s) => !s.current && unreadPaths.has(s.path);
// 未读优先置顶（组内 stable sort，保持 modified 相对序；查看后自动回时间序）
const unreadFirst = (arr) => [...arr].sort((a, b) => (isUnread(b) ? 1 : 0) - (isUnread(a) ? 1 : 0));

function syncUnreadUI() {
  // 标题前缀 + 任务栏角标：计数只算侧栏现存会话（sessionIndex），关闭/归档的残留不虚高
  const items = sessionIndex.filter(isUnread);
  const n = items.length;
  document.title = n ? `✓${n} · Pi 桌面版` : "Pi 桌面版";
  if (n <= 0) {
    window.pi.setOverlayIcon(null);
    return;
  }
  // 32×32 绿圆白数字（DPI 缩放下清晰），主进程 nativeImage 落任务栏角标
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#3e7d50";
  g.beginPath();
  g.arc(16, 16, 14, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.font = "bold 15px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(n > 9 ? "9+" : String(n), 16, 17);
  window.pi.setOverlayIcon(c.toDataURL("image/png"));
}

/* 戊批（2026-10-12 审计）：侧栏全量重建是渲染端最大性能热点（innerHTML 清空+每工作区 wsSessions IPC 扇出），
   后台多会话并行时每轮 start/settle 各触发一次。renderSidebarTreeSoon=150ms 尾沿防抖合并——
   事件驱动路径（运行标记/未读徽标类高频刷）走它；await 依赖 DOM 态的调用方（切换/归档/增删）保持原函数不动 */
let sidebarTreeTimer = null;
function renderSidebarTreeSoon() {
  clearTimeout(sidebarTreeTimer);
  sidebarTreeTimer = setTimeout(() => {
    sidebarTreeTimer = null;
    void renderSidebarTree();
  }, 150);
}
window.__renderSidebarTreeSoon = renderSidebarTreeSoon; // CDP 验证钩子（IIFE 内函数外部不可达，verify-sidebarecon 用）

async function renderSidebarTree() {
  window.__sideRenders = (window.__sideRenders ?? 0) + 1; // 防抖合并断言用（verify-sidebarecon，生产无害）
  const box = $("ws-groups");
  if (!box) return;
  let cfg;
  try {
    cfg = await window.pi.wsList();
  } catch { return; }
  box.innerHTML = "";
  const workspaces = cfg.workspaces ?? [];
  wsKeepByCwd = {}; // 压缩档菜单当前值（批次B3）
  for (const w of workspaces) if (w.compactionKeep) wsKeepByCwd[w.cwd] = w.compactionKeep;
  // 并行拉各工作区会话列表（每个返回 {sessions, archived}）
  const lists = await Promise.all(workspaces.map(async (w) => {
    try { return await window.pi.wsSessions(w.cwd); } catch { return { sessions: [], archived: [] }; }
  }));
  let archivedTotal = lists.reduce((a, d) => a + (d.archived?.length ?? 0), 0);

  // 会话搜索索引（活跃列表，与归档态无关；2026-10-05 搜索浮层数据源）
  sessionIndex = [];
  workspaces.forEach((w, i) => {
    for (const s of (lists[i].sessions ?? [])) sessionIndex.push({ ...s, cwd: w.cwd, wsName: w.name, wsId: w.id });
  });

  workspaces.forEach((w, i) => {
    const data = lists[i];
    const sessions = unreadFirst(showArchived ? (data.archived ?? []) : (data.sessions ?? []));
    const isActiveWs = w.id === cfg.activeId;
    const group = el("div", "ws-group" + (isActiveWs ? " active" : "") + (wsCollapsed[w.id] ? " collapsed" : ""));
    group.dataset.wsId = w.id;

    // 组头：chevron + 文件夹 + 名称 + ＋新增会话 + 移除×（2026-10-03 owner 需求）
    const head = el("div", "ws-head");
    head.title = w.cwd + "（点击展开/折叠；切到其它工作区不中断当前会话）";
    const chev = el("span", "ws-chev");
    chev.append(svgUse("#i-chev-r", "ic ic-s"));
    const wname = el("span", "ws-name");
    wname.textContent = w.name;
    head.append(chev, svgUse("#i-folder", "ic ic-s"), wname);
    const badgeN = sessions.filter(isUnread).length; // 组头未读计数徽标（组折叠时信号不丢）
    if (badgeN) {
      const badge = el("span", "ws-badge");
      badge.textContent = String(badgeN);
      badge.title = `${badgeN} 个会话任务已完成未查看`;
      head.appendChild(badge);
    }
    const addBtn = el("span", "ws-add");
    addBtn.textContent = "+";
    addBtn.title = "在此工作区开新会话";
    addBtn.setAttribute("aria-label", "在此工作区开新会话");
    addBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.pi.wsSetActive(w.id);
      await startSession(w.cwd);
      // owner 2026-10-06：开新会话不再弹通知条（简洁为主）
    });
    head.appendChild(addBtn);
    const rm = el("span", "ws-rm");
    rm.textContent = "×";
    rm.title = "从侧栏移除该工作区（不删文件）";
    rm.setAttribute("aria-label", "移除工作区");
    rm.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`移除工作区「${w.name}」？\n（仅从列表移除，不会删除磁盘文件和会话记录）`)) return;
      const c2 = await window.pi.wsRemove(w.id);
      delete wsCollapsed[w.id];
      await renderSidebarTree();
      await renderFileRoot(); // 移除非活跃工作区不走 startSession，右栏项目树需主动刷新
      const act = c2.workspaces.find((x) => x.id === c2.activeId) ?? c2.workspaces[0];
      if (act && state?.cwd !== act.cwd) await startSession(act.cwd);
    });
    head.appendChild(rm);
    bindKbd(head, () => head.click(), "button"); // 键盘批：组头 Enter 折叠/切换
    head.addEventListener("click", async () => {
      wsCollapsed[w.id] = !wsCollapsed[w.id];
      group.classList.toggle("collapsed", wsCollapsed[w.id]);
      if (!isActiveWs) {
        await window.pi.wsSetActive(w.id); // 新会话按钮作用于活跃工作区
        await renderSidebarTree(); // 刷新 active 高亮
      }
    });

    // 组体：会话列表（点击 → 中间区打开完整历史并可继续对话）
    const body = el("div", "ws-sessions");
    if (!sessions.length) {
      const empty = el("div", "session-empty");
      empty.textContent = showArchived ? "无已归档会话" : "暂无会话";
      body.appendChild(empty);
    }
    for (const s of sessions) body.appendChild(makeSessionItem(s, { cwd: w.cwd, wsId: w.id, isActiveWs }));

    group.append(head, body);
    box.appendChild(group);
  });

  // 尾部：添加工作区
  const add = el("div", "ws-add-row");
  add.innerHTML = '<svg class="ic ic-s"><use href="#i-folder"/></svg><span>添加工作区</span>';
  add.addEventListener("click", async () => {
    const dir = await window.pi.pickFolder();
    if (!dir) return;
    await window.pi.wsAdd(dir);
    await renderSidebarTree();
    await startSession(dir);
  });
  bindKbd(add, () => add.click());
  box.appendChild(add);

  // 自由会话固定区（不属于任何工作区，cwd=主目录；2026-10-03 owner 需求）
  homeDir = cfg.homeDir || null;
  const freeBox = $("free-sessions");
  if (freeBox && homeDir) {
    freeBox.innerHTML = "";
    freeBox.classList.remove("hidden");
    let freeData = { sessions: [], archived: [] };
    try { freeData = await window.pi.wsSessions(homeDir); } catch { /* 主目录不可读 */ }
    const fSessions = unreadFirst(showArchived ? (freeData.archived ?? []) : (freeData.sessions ?? []));
    archivedTotal += freeData.archived?.length ?? 0;
    for (const s of (freeData.sessions ?? [])) sessionIndex.push({ ...s, cwd: homeDir, wsName: "自由会话", free: true });
    const group = el("div", "ws-group");
    const head = el("div", "ws-head");
    head.title = "不属于任何工作区的会话（目录：" + homeDir + "）";
    const fChev = el("span", "ws-chev");
    fChev.style.visibility = "hidden";
    fChev.append(svgUse("#i-chev-r", "ic ic-s"));
    const fName = el("span", "ws-name");
    fName.textContent = "自由会话";
    head.append(fChev, svgUse("#i-file", "ic ic-s"), fName);
    const fBadgeN = fSessions.filter(isUnread).length;
    if (fBadgeN) {
      const badge = el("span", "ws-badge");
      badge.textContent = String(fBadgeN);
      badge.title = `${fBadgeN} 个会话任务已完成未查看`;
      head.appendChild(badge);
    }
    const fAdd = el("span", "ws-add");
    fAdd.textContent = "+";
    fAdd.title = "开新自由会话（不属于任何工作区）";
    fAdd.setAttribute("aria-label", "开新自由会话");
    fAdd.addEventListener("click", async (e) => {
      e.stopPropagation();
      await startSession(homeDir);
    });
    head.appendChild(fAdd);
    const body = el("div", "ws-sessions");
    if (!fSessions.length) {
      const empty = el("div", "session-empty");
      empty.textContent = "暂无自由会话";
      body.appendChild(empty);
    }
    for (const s of fSessions) body.appendChild(makeSessionItem(s, { cwd: homeDir, free: true }));
    group.append(head, body);
    freeBox.appendChild(group);
  }

  // footer 已归档 toggle（2026-10-05：入口在设置行右侧；归档态朱砂高亮）
  const tg = $("btn-toggle-archived");
  tg.classList.toggle("hidden", archivedTotal === 0 && !showArchived);
  tg.classList.toggle("as-back", showArchived);
  tg.textContent = showArchived ? "← 返回会话列表" : `已归档 ${archivedTotal}`;
  syncUnreadUI(); // 标题前缀 + 任务栏角标随未读集合刷新
}

/* ---- 会话搜索浮层（2026-10-05 方案⑤）：全工作区+自由会话名过滤，跨区跳转 ---- */
let spOpen = false;

function spRender() {
  const list = $("sp-list");
  const q = $("sp-input").value.trim().toLowerCase();
  list.innerHTML = "";
  const hits = (!q ? sessionIndex : sessionIndex.filter((s) => (s.name ?? "").toLowerCase().includes(q))).slice(0, 30);
  if (!hits.length) {
    const empty = el("div", "pane-empty");
    empty.textContent = q ? "无匹配会话" : "暂无会话";
    list.appendChild(empty);
    return;
  }
  for (const s of hits) {
    const item = el("div", "sp-item");
    item.setAttribute("role", "option");
    item.title = (s.name ?? "") + "\n" + s.cwd;
    const name = el("div", "sp-name");
    const n = s.name ?? "";
    const idx = q ? n.toLowerCase().indexOf(q) : -1;
    if (q && idx >= 0) {
      // 命中段朱砂高亮（分段 DOM 构建，不拼 HTML 防注入）
      name.append(n.slice(0, idx));
      const mk = el("mark");
      mk.textContent = n.slice(idx, idx + q.length);
      name.append(mk, n.slice(idx + q.length));
    } else {
      name.textContent = n;
    }
    const meta = el("div", "sp-meta");
    meta.textContent = (s.running ? "运行中 · " : "") + `${s.wsName} · ${String(s.modified ?? "").slice(5)} · ${s.messageCount ?? 0}条`;
    item.append(name, meta);
    item.addEventListener("click", () => spJump(s));
    bindKbd(item, () => spJump(s), "option"); // 键盘批：搜索结果 Enter 直达
    list.appendChild(item);
  }
}

async function spJump(s) {
  spClose();
  try {
    if (s.wsId && s.cwd !== state?.cwd) await window.pi.wsSetActive(s.wsId);
    await startSession(s.cwd, s.path);
  } catch (err) {
    showNotice("打开会话失败：" + (err?.message ?? err), true);
  }
}

function spOpenLayer() {
  spOpen = true;
  $("search-pop").classList.remove("hidden");
  $("sp-input").value = "";
  spRender();
  setTimeout(() => $("sp-input").focus(), 30);
}

function spClose() {
  spOpen = false;
  $("search-pop").classList.add("hidden");
  $("btn-search").focus(); // 焦点归还锚点（键盘批：Esc/选中后焦点不落地）
}

$("btn-search").addEventListener("click", (e) => {
  e.stopPropagation();
  if (spOpen) spClose(); else spOpenLayer();
});
// Ctrl+K 唤起/收起搜索浮层（全局，输入框聚焦时也可用）
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (spOpen) spClose(); else spOpenLayer();
  }
});
$("sp-input").addEventListener("input", spRender);
$("sp-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.stopPropagation(); spClose(); return; }
  // 键盘批：方向键在结果列表间移动焦点，Enter 直达（无焦点项时点首个）
  const items = [...$("sp-list").querySelectorAll(".sp-item")];
  if (!items.length) return;
  const cur = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); (items[cur + 1] ?? items[0]).focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); (items[cur - 1] ?? items[items.length - 1]).focus(); }
  else if (e.key === "Enter" && cur === -1) { e.preventDefault(); items[0].click(); }
  // Enter 且焦点已在某项上：bindKbd 的 keydown 处理器接管（sp-item 自身监听）
});
document.addEventListener("click", (e) => {
  if (!spOpen) return;
  const pop = $("search-pop");
  const btn = $("btn-search");
  if (!pop.contains(e.target) && !btn.contains(e.target)) spClose();
});

/* ---- 侧栏底部：智谱套餐微条 + composer 上下文条（2026-10-05 重排） ---- */

function limitTag(item) {
  // unit: 1=天 3=小时 5=月 6=周（quota/limit 接口编码，社区监控工具实测）
  if (item.type === "TIME_LIMIT") return "MCP";
  if (item.unit === 3) return (item.number === 1 ? "1h" : item.number + "h");
  if (item.unit === 6 || (item.unit === 1 && item.number === 7)) return "周";
  if (item.unit === 5) return "月";
  if (item.unit === 1) return item.number + "天";
  return item.type;
}

/* 上下文条：当前会话的工作区名 + git 状态，贴输入框（点击打开目录）
   三形态：git 仓 = 名称+分支±↑↓ / 非 git 工作区 = 名称+非 git 目录 / 自由会话 = 🏠主目录 */
async function refreshCtxBar() {
  const bar = $("ctx-bar");
  if (!bar) return;
  const cwd = state?.cwd;
  if (!cwd) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  let name = "";
  let isHome = false;
  try {
    const cfg = await window.pi.wsList();
    isHome = !!cfg.homeDir && cwd === cfg.homeDir;
    const w = (cfg.workspaces ?? []).find((x) => x.cwd === cwd);
    name = isHome ? "主目录" : (w ? w.name : (cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd)); // 主目录语义优先于同名工作区登记
  } catch { name = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd; }
  $("ctx-ws").textContent = name;
  $("ctx-icon").setAttribute("href", isHome ? "#i-home" : "#i-folder");
  const gitEl = $("ctx-git");
  try {
    const g = await window.pi.gitStatus(cwd);
    if (g && g.branch) {
      const bits = [g.branch];
      if (g.dirty) bits.push(g.dirty + "±");
      if (g.ahead || g.behind) bits.push(`↑${g.ahead}↓${g.behind}`);
      gitEl.textContent = "· " + bits.join(" · ");
    } else {
      gitEl.textContent = isHome ? "" : "· 非 git 目录";
    }
  } catch { gitEl.textContent = ""; }
  bar.title = cwd + "（点击打开目录）";
}

async function refreshZaiFooter() {
  const zaiEl = $("footer-zai-text");
  if (!zaiEl) return;
  const zaiWrap = $("footer-zai");
  try {
    const z = await window.pi.zaiUsage();
    zaiEl.textContent = ""; // 清空旧内容（含降级文案）
    if (z?.items?.length) {
      if (zaiWrap) zaiWrap.style.display = ""; // 有数据恢复显示（上次无 key 隐藏后的复位）
      const lv = el("span", "zc-lv");
      lv.textContent = "智谱" + (z.level ? z.level.toUpperCase() : "");
      zaiEl.appendChild(lv);
      for (const it of z.items) {
        if (it.type === "TIME_LIMIT") continue; // MCP 限时条不显示（owner 2026-10-10 拍板：只留套餐额度段）
        // 微条三段（2026-10-10 改：去「剩」前缀防侧栏窄时被裁切，完整信息在 tooltip）：标签 + 24×4px 胶囊（填充=剩余额度，越用越短）+ 剩余%；<30% 琥珀 <10% 朱砂
        const remainPct = Math.max(0, Math.min(100, 100 - it.pct));
        const seg = el("span", "zc-seg");
        const lab = el("span", "zc-lab");
        lab.textContent = limitTag(it);
        const meter = el("span", "zc-meter");
        const fill = el("span", "zc-fill" + (remainPct < 10 ? " danger" : remainPct < 30 ? " warn" : ""));
        fill.style.width = remainPct + "%";
        meter.appendChild(fill);
        const pct = el("span", "zc-pct");
        pct.textContent = remainPct + "%";
        if (it.nextReset) {
          const t = new Date(it.nextReset).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
          seg.title = `剩余 ${remainPct}%（已用 ${it.pct}%）· ${t} 重置`;
        }
        seg.append(lab, meter, pct);
        zaiEl.appendChild(seg);
      }
      const detail = z.items.filter((it) => it.type !== "TIME_LIMIT").map((it) => {
        const t = it.nextReset
          ? new Date(it.nextReset).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
          : "";
        const rp = Math.max(0, Math.min(100, 100 - it.pct));
        return `${limitTag(it)}：剩余 ${rp}%（已用 ${it.pct}%${it.remaining != null ? `，剩 ${it.remaining}/${it.usage}` : ""}）${t ? ` · ${t} 重置` : ""}`;
      }).join("\n");
      $("footer-zai").title = detail + "\n（点击打开官方用量页）";
    } else {
      zaiEl.textContent = "智谱用量：无数据"; // 保底文案（textContent 断言依赖）；开源用户无 zai key 时整行收起不占位（2026-10-12 UI 审查）
      if (zaiWrap) zaiWrap.style.display = "none";
      $("footer-zai").title = "未检测到 ZAI_API Key 或接口不可达";
    }
  } catch {
    zaiEl.textContent = "智谱用量：加载失败";
    if (zaiWrap) zaiWrap.style.display = "none";
  }
}

function renderFooter() {
  refreshCtxBar();
  refreshZaiFooter();
}

$("ctx-bar").addEventListener("click", () => {
  if (state?.cwd) window.pi.openPath(state.cwd).catch(() => {});
});
$("footer-zai").addEventListener("click", () => window.pi.openExternal("https://bigmodel.cn/coding-plan/personal/usage"));

$("btn-toggle-archived").addEventListener("click", () => {
  showArchived = !showArchived;
  renderSidebarTree();
});

/* ================= 输入区 ================= */

function autoResize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

/* ================= 设置中心（2026-10-04 R1：pi.dev 扩展社区） ================= */

const stCatalog = { query: "", type: "", page: 0, items: [], total: 0, loading: false, loadingMore: false, error: null, seq: 0 };
let stConfigured = new Map(); // npm 包名 → { source, scope }
let stInstalling = new Set(); // 安装中的包名（UI spinner）
let stSearchTimer = null;

/* "npm:@scope/name@1.0.0" → "@scope/name"（与目录包名对齐；仅 npm: 源能对上目录） */
function npmSourceToName(source) {
  if (!source.startsWith("npm:")) return null;
  let name = source.slice(4);
  const at = name.lastIndexOf("@");
  if (at > 0) name = name.slice(0, at); // 保留 @scope 前导的 @
  return name || null;
}

function fmtDownloads(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M/月";
  if (n >= 1e3) return Math.round(n / 1e3) + "k/月";
  return n ? n + "/月" : "";
}

function fmtAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 36e5) return "刚刚";
  if (d < 864e5) return Math.floor(d / 36e5) + "小时前";
  if (d < 30 * 864e5) return Math.floor(d / 864e5) + "天前";
  return Math.floor(d / (30 * 864e5)) + "个月前";
}

const ST_TYPE_LABEL = { extension: "扩展", skill: "技能", prompt: "模板", theme: "主题", package: "包" };

let stPiVersion = ""; // 版本号从侧栏撤到设置弹层（2026-10-05）
let stUpdateStatus = ""; // 更新检测状态（2026-10-08）：已最新/可更新 vX/检测失败，显示在同行尾部
function stRefreshFoot() {
  const parts = [];
  if (stConfigured.size) parts.push(`已装 ${stConfigured.size} 个包`);
  if (stPiVersion) parts.push(stPiVersion);
  if (stUpdateStatus) parts.push(stUpdateStatus);
  $("st-installed-count").textContent = parts.join(" · ");
}

async function stRefreshConfigured() {
  try {
    const r = await window.pi.pkgList();
    stConfigured = new Map();
    for (const p of r.packages ?? []) {
      const name = npmSourceToName(p.source);
      if (name && !stConfigured.has(name)) stConfigured.set(name, p);
    }
    stRefreshFoot();
  } catch { /* 下次打开重试 */ }
}

async function stSearch(loadMore = false) {
  const seq = ++stCatalog.seq;
  if (loadMore) stCatalog.loadingMore = true;
  else { stCatalog.loading = true; stCatalog.page = 0; stCatalog.items = []; stCatalog.error = null; }
  stRenderList();
  const r = await window.pi.catalogSearch(stCatalog.query, stCatalog.type, stCatalog.page + 1).catch((err) => ({ error: String(err?.message ?? err) }));
  if (seq !== stCatalog.seq) return; // 过期响应丢弃（防搜索连打旧结果覆盖新结果）
  if (loadMore) stCatalog.loadingMore = false; else stCatalog.loading = false;
  if (r.error) { stCatalog.error = r.error; stRenderList(); return; }
  stCatalog.page = r.page;
  stCatalog.items.push(...(r.packages ?? []));
  stCatalog.total = r.total ?? stCatalog.items.length;
  stRenderList();
}

function stActionBtn(pkg) {
  const name = pkg.name;
  const conf = stConfigured.get(name);
  const btn = el("button", "st-act");
  if (stInstalling.has(name)) {
    btn.className = "st-act busy";
    btn.disabled = true;
    btn.textContent = "安装中…";
  } else if (conf) {
    btn.className = "st-act installed";
    btn.title = `卸载 ${conf.source}（${conf.scope === "project" ? "项目级" : "用户级"}）`;
    btn.textContent = "卸载";
    btn.addEventListener("click", () => stRemove(pkg, conf));
  } else {
    btn.textContent = "安装";
    btn.addEventListener("click", () => stInstall(pkg));
  }
  return btn;
}

function stRenderList() {
  const list = $("st-catalog");
  list.innerHTML = "";
  if (stCatalog.loading) {
    list.appendChild(el("div", "pane-empty")).textContent = "正在请求 pi.dev…";
  } else if (stCatalog.error) {
    const box = el("div", "st-error");
    box.textContent = "目录加载失败：" + stCatalog.error;
    const retry = el("button", "btn");
    retry.textContent = "重试";
    retry.addEventListener("click", () => stSearch(false));
    box.appendChild(retry);
    list.appendChild(box);
  } else if (!stCatalog.items.length) {
    list.appendChild(el("div", "pane-empty")).textContent = "没有匹配的包";
  } else {
    for (const pkg of stCatalog.items) {
      const row = el("div", "st-row");
      const main = el("div", "st-row-main");
      const head = el("div", "st-row-head");
      const name = el("span", "st-row-name");
      name.textContent = pkg.name;
      head.appendChild(name);
      for (const t of pkg.types.slice(0, 2)) {
        const b = el("span", "st-badge");
        b.textContent = ST_TYPE_LABEL[t] ?? t;
        head.appendChild(b);
      }
      const meta = el("span", "st-row-meta");
      meta.textContent = [pkg.author, fmtDownloads(pkg.downloads), fmtAgo(pkg.updatedAt)].filter(Boolean).join(" · ");
      head.appendChild(meta);
      const desc = el("div", "st-row-desc");
      desc.textContent = pkg.description || "（无描述）";
      main.append(head, desc);
      row.append(main, stActionBtn(pkg));
      list.appendChild(row);
    }
  }
  $("st-more").classList.toggle("hidden", !(stCatalog.total > stCatalog.items.length));
  if (!$("st-more").classList.contains("hidden")) {
    $("st-more").textContent = `加载更多（还剩 ${stCatalog.total - stCatalog.items.length}）`;
    $("st-more").disabled = stCatalog.loadingMore;
  }
}

async function stInstall(pkg) {
  stInstalling.add(pkg.name);
  stRenderList();
  try {
    await window.pi.pkgInstall(pkg.name);
    await stRefreshConfigured();
    showNotice(`已安装 ${pkg.name}，空闲会话已热重载`);
  } catch (err) {
    showNotice(`安装失败 ${pkg.name}：` + String(err?.message ?? err), true);
  } finally {
    stInstalling.delete(pkg.name);
    stRenderList();
  }
}

async function stRemove(pkg, conf) {
  stInstalling.add(pkg.name); // 复用 spinner 态
  stRenderList();
  try {
    await window.pi.pkgRemove(conf.source, conf.scope);
    await stRefreshConfigured();
    showNotice(`已卸载 ${pkg.name}`);
  } catch (err) {
    showNotice(`卸载失败 ${pkg.name}：` + String(err?.message ?? err), true);
  } finally {
    stInstalling.delete(pkg.name);
    stRenderList();
  }
}

/* ---- 每周插件精选（2026-10-08 owner 拍板：双源周榜——pi.dev 社区×GitHub 高星×契合画像） ---- */
const WEEKLY_URL_ALLOW = [/^https:\/\/github\.com\//, /^https:\/\/pi\.dev\//, /^https:\/\/www\.npmjs\.com\//]; // 开仓链接仅信官方域（并过 setWindowOpenHandler 的系统浏览器链路）
async function stRenderWeekly(refresh) {
  const box = $("st-weekly");
  const sub = $("st-weekly-sub");
  const ph = el("div", "pane-empty");
  ph.textContent = refresh ? "刷新中…" : "本周榜单加载中…"; // replaceChildren 返回 undefined 不能链（无头诊断 TypeError 实证）
  box.replaceChildren(ph);
  let data = null;
  try { data = await window.pi.pkgWeekly(refresh ? { refresh: true } : undefined); } catch { /* 保持提示 */ }
  if (!data?.items?.length) {
    const ph2 = el("div", "pane-empty");
    ph2.textContent = "榜单暂不可用（网络失败可点右上刷新重试）";
    box.replaceChildren(ph2);
    return;
  }
  if (sub) sub.textContent = `${data.week} 周 · 双源：pi.dev 社区热度×本周新发 + GitHub 高星，按契合度加权`;
  localStorage.setItem("pi-gui:pkg-weekly-seen", data.week); // 拿到榜单即视为已读
  updateSettingsDot(data.week);
  const installed = new Set([...stConfigured.keys()].map((s) => s.toLowerCase())); // 已装=stConfigured（pkgList 异步刷新，可能未就绪——空集只是不显示已装标）
  box.replaceChildren();
  let rank = 0;
  for (const it of data.items) {
    rank++;
    const row = el("div", "st-weekly-row");
    const rk = el("span", "st-weekly-rank");
    rk.textContent = String(rank);
    const head = el("div", "st-row-head");
    const name = el("span", "st-row-name");
    name.textContent = it.name;
    head.appendChild(name);
    const src = el("span", "st-badge" + (it.source === "github" ? " proj" : ""));
    src.textContent = it.source === "github" ? "GitHub" : "社区";
    head.appendChild(src);
    for (const t of (it.types ?? []).slice(0, 1)) {
      const b = el("span", "st-badge dim");
      b.textContent = ST_TYPE_LABEL[t] ?? t;
      head.appendChild(b);
    }
    const heat = el("span", "st-row-meta");
    heat.textContent = it.source === "github" ? `${it.stars ?? 0} ★` : fmtDownloads(it.downloads);
    head.appendChild(heat);
    const why = el("span", "st-weekly-why");
    why.textContent = it.reason;
    head.appendChild(why);
    const desc = el("div", "st-row-desc");
    desc.textContent = it.description || "（无描述）";
    const main = el("div", "st-row-main");
    main.append(head, desc);
    row.append(rk, main);
    const npmName = it.npmName || it.name;
    if (installed.has(npmName.toLowerCase())) {
      const done = el("span", "st-weekly-installed");
      done.textContent = "已安装";
      row.appendChild(done);
    } else {
      const btn = el("button", "st-act");
      btn.textContent = "安装";
      btn.title = `pi install npm:${npmName}`;
      btn.addEventListener("click", async () => {
        btn.disabled = true; btn.textContent = "安装中…";
        try { await window.pi.pkgInstall(npmName); btn.textContent = "已安装"; }
        catch (err) { btn.disabled = false; btn.textContent = "安装"; showNotice("安装失败：" + String(err?.message ?? err), true); }
      });
      row.appendChild(btn);
    }
    if (it.url) {
      row.title = it.url;
      row.addEventListener("click", (e) => {
        if (e.target !== row) return;
        if (WEEKLY_URL_ALLOW.some((re) => re.test(it.url))) void window.pi.openExternal?.(it.url); // 域白名单前置，走主进程系统浏览器链路
      });
    }
    box.appendChild(row);
  }
}
/* 设置齿轮红点：榜单有新周次且未读时提示（启动/拉榜后刷新） */
function updateSettingsDot(week) {
  let d = document.querySelector("#btn-settings .footer-line-dot");
  if (!d) { d = el("span", "footer-line-dot"); $("btn-settings").prepend(d); }
  const seen = localStorage.getItem("pi-gui:pkg-weekly-seen");
  const wk = week ?? localStorage.getItem("pi-gui:pkg-weekly-last");
  d.classList.toggle("on", !!wk && wk !== seen);
  if (week) localStorage.setItem("pi-gui:pkg-weekly-last", week);
}

function openSettings() {
  $("settings-overlay").classList.remove("hidden");
  document.querySelector(".st-modal").scrollTop = 0; // 兜底归零：模态层不该有可滚余量（右栏自滚后 scrollHeight=620，此处防历史脏态）
  $("st-search").value = stCatalog.query;
  stRefreshConfigured();
  stSwitchTab(stTab); // 回到上次停留的 tab 并刷新内容（ext 的目录首拉已并入 stSwitchTab）
  if (stTab === "ext") setTimeout(() => $("st-search").focus(), 50);
  if (stTab === "ext") void stRenderWeekly(false); // 本周精选（缓存命中秒回）
  updateSettingsDot(null); // 打开设置即视为已读（红点灭）
}
$("st-weekly-refresh")?.addEventListener("click", () => void stRenderWeekly(true));

function closeSettings() {
  $("settings-overlay").classList.add("hidden");
  $("btn-settings").focus(); // 焦点归还锚点（键盘批）
}

$("btn-settings").addEventListener("click", openSettings);
$("st-close").addEventListener("click", closeSettings);
$("settings-overlay").addEventListener("click", (e) => {
  if (e.target === $("settings-overlay")) closeSettings(); // 点遮罩关闭
});
$("st-search").addEventListener("input", (e) => {
  stCatalog.query = e.target.value.trim();
  clearTimeout(stSearchTimer);
  stSearchTimer = setTimeout(() => stSearch(false), 400);
});
$("st-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || chip.classList.contains("active")) return;
  for (const c of $("st-chips").children) c.classList.toggle("active", c === chip);
  stCatalog.type = chip.dataset.type;
  clearTimeout(stSearchTimer); // 取消 pending 的搜索防抖，避免双发（seq 兕底之外的双保险）
  stSearch(false);
});
$("st-more").addEventListener("click", () => stSearch(true));

// CDP 验证钩子：读目录状态（无副作用的只读快照）
window.__stState = () => ({
  seq: stCatalog.seq,
  loading: stCatalog.loading,
  total: stCatalog.total,
  count: stCatalog.items.length,
  query: stCatalog.query,
  type: stCatalog.type,
  installing: [...stInstalling],
  configured: [...stConfigured.keys()],
});

/* ---- 设置中心 R2：Skills / MCP / 模型 / 外观（2026-10-04） ---- */

let stTab = "models"; // 默认落模型页（2026-10-12 开源 UI 审查：原默认 ext 首开设置即拉全量社区目录，泛用户信息过载且长列表挤爆可达性树）

function stSwitchTab(name) {
  stTab = name;
  document.querySelectorAll(".st-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const t of ["ext", "skills", "mcp", "models", "agent", "appearance", "logs"]) {
    $("st-tab-" + t).classList.toggle("hidden", t !== name);
  }
  if (name === "ext") {
    // 进入社区 tab 才拉目录（默认 tab 改 models 后用户主动进来——加载时机跟随用户意图；openSettings 的旧自动拉已并入此处）
    if (stCatalog.page === 0 && !stCatalog.loading) stSearch(false);
  }
  else if (name === "skills") stRenderSkills();
  else if (name === "mcp") stRenderMcp();
  else if (name === "models") { stRenderProvList(); stRenderModels(); }
  else if (name === "agent") stRenderAgent();
  else if (name === "appearance") stRenderAppearance();
  else if (name === "logs") stRenderLogs();
}
document.querySelectorAll(".st-nav-item").forEach((b) => b.addEventListener("click", () => stSwitchTab(b.dataset.tab)));

/* 技能面板：name + 来源徽标 + 描述，点名称打开所在目录 */
async function stRenderSkills() {
  const box = $("st-skills-list");
  let data;
  try { data = await window.pi.listCommands(); } catch { data = { skills: [], prompts: [] }; }
  box.innerHTML = "";
  const skills = data.skills ?? [];
  if (!skills.length) {
    box.innerHTML = '<div class="pane-empty">无已加载技能</div>';
    return;
  }
  for (const s of skills) {
    const row = el("div", "st-row");
    const top = el("div", "st-row-top");
    const name = el("button", "st-row-name");
    name.textContent = s.name;
    name.title = "打开技能目录：" + (s.path || "未知");
    name.addEventListener("click", () => { if (s.path) window.pi.openPath(s.path).catch(() => {}); });
    top.appendChild(name);
    const badge = el("span", "st-badge" + (s.scope === "project" ? " proj" : ""));
    badge.textContent = s.scope === "project" ? "项目级" : "用户级";
    top.appendChild(badge);
    const desc = el("div", "st-row-desc");
    desc.textContent = s.description || "（无描述）";
    desc.title = s.description || "";
    row.append(top, desc);
    box.appendChild(row);
  }
}

/* MCP 面板：配置（mcp.json）× 实时挂载工具数（当前会话 activeToolNames）；R4 增删改表单化 */
async function stRenderMcp() {
  const box = $("st-mcp-list");
  let data;
  try { data = await window.pi.mcpList(); } catch (err) { data = { servers: [], errors: [String(err?.message ?? err)], configPath: "" }; }
  // 按 mcp__<server>__<tool> 聚出每 server 挂载工具数（当前会话真实状态）
  const byServer = new Map();
  for (const t of state?.tools ?? []) {
    const s = String(t);
    if (!s.startsWith("mcp__")) continue;
    const srv = s.split("__")[1];
    if (srv) byServer.set(srv, (byServer.get(srv) ?? 0) + 1);
  }
  box.innerHTML = "";
  for (const e of data.errors ?? []) {
    const er = el("div", "st-row st-err");
    er.textContent = "配置错误：" + e;
    box.appendChild(er);
  }
  if (!data.servers?.length) {
    const empty = el("div", "pane-empty");
    empty.textContent = "未配置 MCP 服务器";
    box.appendChild(empty);
    return;
  }
  for (const s of data.servers) {
    const n = byServer.get(s.name) ?? 0;
    const deferred = s.enabled && s.exposure === "deferred"; // B4：按需暴露——永不主动挂载是设计行为非故障
    const row = el("div", "st-row");
    const top = el("div", "st-row-top");
    const dot = el("span", "st-mdot" + (!s.enabled ? " off" : deferred ? " on-demand" : n > 0 ? " ok" : ""));
    const name = el("span", "st-row-name as-text");
    name.textContent = s.name;
    top.append(dot, name);
    const badge = el("span", "st-badge" + (s.scope === "project" ? " proj" : ""));
    badge.textContent = s.scope === "project" ? "项目级" : "全局";
    top.appendChild(badge);
    if (!s.enabled) {
      const b2 = el("span", "st-badge dim");
      b2.textContent = "已停用";
      top.appendChild(b2);
    }
    const count = el("span", "st-count");
    count.textContent = !s.enabled ? "—" : deferred ? "按需" : n > 0 ? n + " 工具" : "未挂载";
    count.title = !s.enabled
      ? "已停用"
      : deferred
        ? "按需暴露（deferred）：工具不进模型声明，agent 判断需要时经 tool_search 自动连接——「按需」≠未挂载/故障"
        : n > 0
          ? "当前会话已挂载 " + n + " 个工具"
          : "配置存在但本会话未挂载工具（可能连接失败或仍在启动）";
    top.appendChild(count);
    // R4：全局服务器行内操作（项目级只读，在仓库 .pi/mcp.json 手改）
    if (s.scope !== "project") {
      const acts = el("span", "st-acts");
      const btnEdit = el("button", "st-mini");
      btnEdit.type = "button";
      btnEdit.title = "编辑";
      btnEdit.setAttribute("aria-label", "编辑 " + s.name);
      btnEdit.appendChild(mcpFormIconSvg("i-pencil"));
      btnEdit.addEventListener("click", () => mcpFormOpen(s));
      const btnToggle = el("button", "st-mini st-mini-txt");
      btnToggle.type = "button";
      btnToggle.textContent = s.enabled ? "停用" : "启用";
      btnToggle.title = s.enabled ? "停用（保留配置）" : "启用";
      btnToggle.setAttribute("aria-label", (s.enabled ? "停用 " : "启用 ") + s.name);
      btnToggle.addEventListener("click", async () => {
        try {
          await window.pi.mcpSave("toggle", s.name, !s.enabled);
          showNotice("已" + (s.enabled ? "停用 " : "启用 ") + s.name + "（空闲会话已热重载）");
          await stRenderMcp();
        } catch (err) { showNotice("保存失败：" + String(err?.message ?? err), true); }
      });
      const btnDel = el("button", "st-mini");
      btnDel.type = "button";
      btnDel.title = "删除";
      btnDel.setAttribute("aria-label", "删除 " + s.name);
      btnDel.appendChild(mcpFormIconSvg("i-trash"));
      btnDel.addEventListener("click", async () => {
        if (!confirm("删除服务器 " + s.name + "？此操作写盘不可撤销。")) return;
        try {
          await window.pi.mcpSave("delete", s.name);
          showNotice("已删除 " + s.name);
          await stRenderMcp();
        } catch (err) { showNotice("删除失败：" + String(err?.message ?? err), true); }
      });
      acts.append(btnEdit, btnToggle, btnDel);
      top.appendChild(acts);
    }
    const tp = el("div", "st-row-desc st-transport");
    tp.textContent = s.transport;
    tp.title = s.transport;
    row.append(top, tp);
    box.appendChild(row);
  }
}

$("st-mcp-open").addEventListener("click", async () => {
  try {
    const data = await window.pi.mcpList();
    if (data.configPath) await window.pi.openPath(data.configPath);
  } catch { /* 忽略 */ }
});

/* ---- MCP 表单：新增/编辑（R4，2026-10-05）----
 * 编辑回填用 mcp:list 透传的原始 config（${VAR} 引用原样展示，不解析不展开）；
 * 保存走主进程 mcp:save 权威变更函数（保留缩进与未知字段）。改名 = 写新键删旧键。 */
function mcpKVToLines(obj) {
  if (!obj || typeof obj !== "object") return "";
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n");
}
function mcpLinesToKV(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) throw new Error("键值行格式应为 KEY=value：" + t);
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
function mcpFormClose() {
  $("st-tab-mcp").classList.remove("editing"); // 替换视图收起（批次①：表单占满 tab 区，不再挤压列表）
}
let mcpFormOrigName = ""; // 正在编辑的服务器原名（空=新增）；改名时保存后删旧键
function mcpFormIconSvg(iconId) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ic ic-s");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#" + iconId);
  svg.appendChild(use);
  return svg;
}
function mcpFormOpen(server) {
  // server=null 新增；否则用列表里的原始 config 回填
  const c = server?.config ?? {};
  mcpFormOrigName = server?.name ?? "";
  const isUrl = typeof c.url === "string" && c.url;
  $("st-mcp-form-title").textContent = server ? "编辑：" + server.name : "新增服务器";
  $("st-mf-name").value = server?.name ?? "";
  $("st-mf-type").value = isUrl ? "url" : "stdio";
  $("st-mf-command").value = c.command ?? "";
  $("st-mf-args").value = Array.isArray(c.args) ? c.args.join("\n") : "";
  $("st-mf-env").value = mcpKVToLines(c.env);
  $("st-mf-url").value = c.url ?? "";
  $("st-mf-headers").value = mcpKVToLines(c.headers);
  $("st-mf-desc").value = c.description ?? "";
  $("st-mf-exposure").value = c.exposure === "direct" || c.exposure === "codemode" ? c.exposure : "deferred";
  $("st-mf-enabled").checked = c.enabled !== false;
  mcpFormSyncType();
  const view = $("st-mcp-form");
  $("st-tab-mcp").classList.add("editing");
  view.scrollTop = 0;
  $("st-mf-name").focus();
}
function mcpFormSyncType() {
  const isUrl = $("st-mf-type").value === "url";
  $("st-mf-stdio-wrap").classList.toggle("hidden", isUrl);
  $("st-mf-url-wrap").classList.toggle("hidden", !isUrl);
}
$("st-mf-type").addEventListener("change", mcpFormSyncType);
$("st-mcp-add").addEventListener("click", () => mcpFormOpen(null));
$("st-mf-cancel").addEventListener("click", mcpFormClose);
$("st-mf-save").addEventListener("click", async () => {
  const name = $("st-mf-name").value.trim();
  try {
    const cfg = {
      type: $("st-mf-type").value,
      description: $("st-mf-desc").value,
      exposure: $("st-mf-exposure").value,
      enabled: $("st-mf-enabled").checked,
      __origName: mcpFormOrigName,
    };
    if (cfg.type === "url") {
      cfg.url = $("st-mf-url").value;
      cfg.headers = mcpLinesToKV($("st-mf-headers").value);
    } else {
      cfg.command = $("st-mf-command").value;
      cfg.args = String($("st-mf-args").value ?? "").split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "");
      cfg.env = mcpLinesToKV($("st-mf-env").value);
    }
    await window.pi.mcpSave("set", name, cfg);
    showNotice("已保存 " + name + "（空闲会话已热重载）");
    mcpFormClose();
    await stRenderMcp();
  } catch (err) {
    showNotice("保存失败：" + String(err?.message ?? err), true);
  }
});

/* 模型面板：按提供商分组，点击切换（与 composer 下拉同一链路） */
/* ---- 自定义提供商（R4-2，2026-10-05）：读写 ~/.pi/agent/models.json，兼容端点接入 ---- */
async function stRenderProvList() {
  const box = $("st-prov-list");
  let data;
  try { data = await window.pi.modelsCustomList(); } catch (err) { data = { providers: {}, error: String(err?.message ?? err) }; }
  box.innerHTML = "";
  if (data.error) {
    const er = el("div", "st-row st-err");
    er.textContent = "models.json 解析失败：" + data.error + "（修复后重试，表单不会覆盖坏文件）";
    box.appendChild(er);
    return;
  }
  const entries = Object.entries(data.providers ?? {});
  if (!entries.length) {
    const empty = el("div", "pane-empty");
    empty.textContent = "未配置自定义提供商";
    box.appendChild(empty);
    return;
  }
  for (const [key, cfg] of entries) {
    const row = el("div", "st-row");
    const top = el("div", "st-row-top");
    const name = el("span", "st-row-name as-text");
    name.textContent = key;
    top.appendChild(name);
    const badge = el("span", "st-badge");
    badge.textContent = cfg?.api ?? "openai-completions";
    top.appendChild(badge);
    const count = el("span", "st-count");
    count.textContent = (cfg?.models?.length ?? 0) + " 模型";
    top.appendChild(count);
    const acts = el("span", "st-acts");
    const btnEdit = el("button", "st-mini");
    btnEdit.type = "button";
    btnEdit.title = "编辑";
    btnEdit.setAttribute("aria-label", "编辑 " + key);
    btnEdit.appendChild(mcpFormIconSvg("i-pencil"));
    btnEdit.addEventListener("click", () => provFormOpen(key, cfg));
    const btnDel = el("button", "st-mini");
    btnDel.type = "button";
    btnDel.title = "删除";
    btnDel.setAttribute("aria-label", "删除 " + key);
    btnDel.appendChild(mcpFormIconSvg("i-trash"));
    btnDel.addEventListener("click", async () => {
      if (!confirm("删除自定义提供商 " + key + "？将从 models.json 移除（不可撤销）。")) return;
      try {
        await window.pi.modelsCustomSave("delete", key);
        showNotice("已删除提供商 " + key);
        await stRenderProvList();
        await loadModels();
        stRenderModels();
      } catch (err) { showNotice("删除失败：" + String(err?.message ?? err), true); }
    });
    acts.append(btnEdit, btnDel);
    top.appendChild(acts);
    const tp = el("div", "st-row-desc st-transport");
    tp.textContent = cfg?.baseUrl ?? "";
    tp.title = cfg?.baseUrl ?? "";
    row.append(top, tp);
    box.appendChild(row);
  }
}

let provFormOrigName = "";
function provFormClose() {
  $("st-tab-models").classList.remove("editing");
}
function provModelsToLines(models) {
  return (Array.isArray(models) ? models : [])
    .map((m) => [m?.id, m?.name, m?.contextWindow].filter((x) => x !== undefined && x !== null && x !== "").join("|"))
    .join("\n");
}
function provLinesToModels(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("|").map((x) => x.trim());
    const m = { id: parts[0] };
    if (parts[1]) m.name = parts[1];
    if (parts[2]) {
      const cw = Number(parts[2]);
      if (!Number.isFinite(cw) || cw <= 0) throw new Error("contextWindow 必须是正整数：" + parts[2]);
      m.contextWindow = Math.round(cw);
    }
    out.push(m);
  }
  return out;
}
function provFormOpen(key, cfg) {
  // key=null 新增；否则回填
  provFormOrigName = key ?? "";
  const c = cfg ?? {};
  $("st-prov-form-title").textContent = key ? "编辑提供商：" + key : "新增提供商";
  $("st-pf-name").value = key ?? "";
  $("st-pf-display").value = c.name ?? "";
  $("st-pf-api").value = c.api ?? "openai-completions";
  $("st-pf-baseurl").value = c.baseUrl ?? "";
  $("st-pf-apikey").value = c.apiKey ?? "";
  $("st-pf-models").value = provModelsToLines(c.models);
  const view = $("st-prov-form");
  $("st-tab-models").classList.add("editing");
  view.scrollTop = 0;
  $("st-pf-name").focus();
}
$("st-prov-add").addEventListener("click", () => provFormOpen(null));
$("st-pf-cancel").addEventListener("click", provFormClose);
$("st-prov-open").addEventListener("click", async () => {
  try {
    const data = await window.pi.modelsCustomList();
    await window.pi.openPath(data.path); // 文件不存在时 openPath 可能失败——先无感忽略（表单保存会创建）
  } catch { /* 忽略 */ }
});
$("st-pf-save").addEventListener("click", async () => {
  const name = $("st-pf-name").value.trim();
  try {
    let models;
    try {
      models = provLinesToModels($("st-pf-models").value);
    } catch (err) {
      showNotice(String(err?.message ?? err), true);
      return;
    }
    if (!models.length) {
      showNotice("至少配置一个模型（每行一个 id）", true);
      return;
    }
    const cfg = {
      name: $("st-pf-display").value,
      api: $("st-pf-api").value,
      baseUrl: $("st-pf-baseurl").value,
      apiKey: $("st-pf-apikey").value,
      models,
      __origName: provFormOrigName,
    };
    await window.pi.modelsCustomSave("set", name, cfg);
    showNotice("已保存提供商 " + name + "（模型列表已刷新）");
    provFormClose();
    await stRenderProvList();
    await loadModels();
    stRenderModels();
  } catch (err) {
    showNotice("保存失败：" + String(err?.message ?? err), true);
  }
});

function fmtCtx(w) {
  if (!w) return "";
  if (w >= 1e6) return (w / 1e6).toFixed(w % 1e6 ? 1 : 0) + "M ctx";
  return Math.round(w / 1e3) + "K ctx";
}

async function stRenderModels() {
  const box = $("st-models-list");
  box.innerHTML = "";
  if (!models.length) {
    box.innerHTML = '<div class="pane-empty">无可用模型——点击上方「添加自定义提供商」接入模型服务（填 API 地址与 Key 即可）</div>';
    return;
  }
  // R4-3：当前默认模型（新会话使用）——settings.json 权威值
  let defRef = "";
  try {
    const d = await window.pi.settingsDefaultModel("get");
    if (d?.provider && d?.model) defRef = d.provider + "|" + d.model;
  } catch { /* 取不到时只不显示徽标，不阻塞面板 */ }
  const curRef = state?.model ? state.model.provider + "|" + state.model.id : "";
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  for (const [provider, list] of groups) {
    const head = el("div", "st-group-head");
    head.textContent = provider;
    box.appendChild(head);
    for (const m of list) {
      const ref = m.provider + "|" + m.id;
      const row = el("button", "st-row st-model" + (ref === curRef ? " current" : ""));
      const top = el("div", "st-row-top");
      const name = el("span", "st-row-name as-text");
      name.textContent = m.name;
      top.appendChild(name);
      if (ref === curRef) {
        const cur = el("span", "st-badge cur");
        cur.textContent = "当前";
        top.appendChild(cur);
      }
      if (ref === defRef) {
        const def = el("span", "st-badge def");
        def.textContent = "默认";
        def.title = "新会话默认使用此模型";
        top.appendChild(def);
      }
      const ctx = el("span", "st-count");
      ctx.textContent = fmtCtx(m.contextWindow);
      top.appendChild(ctx);
      row.appendChild(top);
      row.addEventListener("click", async () => {
        if (ref === curRef) return;
        try {
          state = await window.pi.setModel(m.provider, m.id);
          visionAutoPrev = ""; // 手动切换即接管，清除自动回切状态
          syncSceneSeg();
          stRenderModels();
          // 成功不弹 notice（同上，owner 保持简洁）；失败仍提示
        } catch (err) {
          showNotice("切换模型失败：" + (err?.message ?? err), true);
        }
      });
      // R4-3：行尾星标——设为新会话默认（button 内不能嵌 button，行改 wrap 容器）
      const wrap = el("div", "st-model-wrap");
      const star = el("button", "st-mini st-star" + (ref === defRef ? " on" : ""));
      star.type = "button";
      star.title = ref === defRef ? "已是默认（新会话使用）" : "设为新会话默认";
      star.setAttribute("aria-label", "设为默认：" + m.provider + "/" + m.id);
      star.appendChild(mcpFormIconSvg("i-star"));
      star.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await window.pi.settingsDefaultModel("set", m.provider, m.id);
          showNotice("已设为新会话默认：" + m.provider + "/" + m.id);
          void refreshScenes(); // 场景三档跟随默认模型，改默认后立即对齐
          await stRenderModels();
        } catch (err) {
          showNotice("设默认失败：" + String(err?.message ?? err), true);
        }
      });
      wrap.append(row, star);
      box.appendChild(wrap);
    }
  }
  // 场景化后 composer 两个下拉已移除：当前会话思考档逃生门收这里（2026-10-10；「默认思考强度」在 Agent 页管新会话）
  const thHead = el("div", "st-group-head");
  thHead.textContent = "当前会话思考强度";
  box.appendChild(thHead);
  const thWrap = el("div", "st-think-row");
  // GLM-5.3 实测档位映射（2026-10-10 CDP 实测）：off/minimal→low、medium→high、xhigh→max，真实生效仅 low/high/max 三档
  // （中间档点击会跳档，列了误导）；场景三档恰好全在生效域。模型更换后如档位集变化，改这里。
  for (const [val, name] of [["low", "低"], ["high", "高"], ["max", "最大"]]) {
    const b = el("button", "chip" + ((state?.thinkingLevel ?? "medium") === val ? " active" : ""));
    b.textContent = name;
    b.addEventListener("click", async () => {
      try {
        state = await window.pi.setThinkingLevel(val);
        syncSceneSeg();
        stRenderModels();
      } catch (err) {
        showNotice("设置失败：" + (err?.message ?? err), true);
      }
    });
    thWrap.appendChild(b);
  }
  box.appendChild(thWrap);
}

/* 外观面板：主题 / 字号 / 列宽 / 动效，全部真实生效 + localStorage 持久化 */
const appearance = {
  theme: localStorage.getItem("pi-gui:theme") ?? "paper",
  size: localStorage.getItem("pi-gui:msize") ?? "mid",
  width: localStorage.getItem("pi-gui:colw") ?? "std",
  motion: localStorage.getItem("pi-gui:motion") ?? "full",
};
const APPEARANCE_DEFS = [
  {
    key: "size", label: "正文字号",
    options: ["small", "mid", "large"],
    names: { small: "小", mid: "标准", large: "大" },
    apply: (v) => document.documentElement.style.setProperty("--md-size", { small: "13px", mid: "14px", large: "15.5px" }[v] ?? "14px"),
    store: "pi-gui:msize",
  },
  {
    key: "width", label: "消息列宽",
    options: ["std", "wide", "full"],
    names: { std: "标准", wide: "宽", full: "通栏" },
    apply: (v) => document.documentElement.style.setProperty("--col-w", { std: "860px", wide: "1080px", full: "100%" }[v] ?? "860px"),
    store: "pi-gui:colw",
  },
  {
    key: "motion", label: "动效",
    options: ["full", "reduced"],
    names: { full: "正常", reduced: "减弱" },
    apply: (v) => document.documentElement.classList.toggle("no-anim", v === "reduced"),
    store: "pi-gui:motion",
  },
  {
    // 主题行固定尾插（verify-r2 按 chips()[0..2] 断言前三行，勿挪）
    key: "theme", label: "主题",
    options: ["paper", "qingci"],
    names: { paper: "宣纸", qingci: "青瓷" },
    apply: (v) => {
      const qingci = v === "qingci";
      if (qingci) document.documentElement.dataset.theme = "qingci";
      else delete document.documentElement.dataset.theme;
      // BrowserWindow 底色 CSS 够不着，切主题时同步主进程（白名单色）
      try { window.pi.setThemeBg(qingci ? "#f4f7ef" : "#faf8f4"); } catch { /* 旧实例无此方法 */ }
    },
    store: "pi-gui:theme",
  },
];

function applyAppearance() {
  for (const d of APPEARANCE_DEFS) d.apply(appearance[d.key]);
}

function stRenderAppearance() {
  const box = $("st-appearance");
  box.innerHTML = "";
  APPEARANCE_DEFS.forEach((d, i) => {
    const row = el("div", "st-row st-app-row" + (i === APPEARANCE_DEFS.length - 1 ? " no-line" : "")); // 尾行去线由 JS 标类（:last-of-type 陷阱）
    const lab = el("span", "st-app-label");
    lab.textContent = d.label;
    row.appendChild(lab);
    const chips = el("div", "st-chips");
    for (const opt of d.options) {
      const c = el("button", "chip" + (appearance[d.key] === opt ? " active" : ""));
      c.textContent = d.names[opt];
      c.addEventListener("click", () => {
        appearance[d.key] = opt;
        localStorage.setItem(d.store, opt);
        applyAppearance();
        stRenderAppearance();
      });
      chips.appendChild(c);
    }
    row.appendChild(chips);
    box.appendChild(row);
  });
  const hint = el("div", "st-hint");
  hint.textContent = "主题「宣纸 / 青瓷」即时切换全窗生效；减弱动效同时响应系统的减少动态效果偏好。";
  box.appendChild(hint);
}

applyAppearance(); // 启动时应用持久化设置

/* ---- 代理 tab（批次②）：权限/思考/压缩/通知，全部真实读写 ---- */

const AGENT_KEEP = [
  [32000, "保守"],
  [20000, "平衡"],
  [12000, "激进"],
];
const THINK_OPTS = [
  ["", "跟随模型"],
  ["minimal", "极简"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "超高"],
  ["max", "最大"],
];

async function stRenderAgent() {
  const box = $("st-agent");
  box.innerHTML = "";
  let permCur = "default";
  let ag = { thinking: null, keep: 20000 };
  let nt = { enabled: true, sound: false, dndStart: "", dndEnd: "", gate: null };
  try { permCur = (await window.pi.permGetDefault()) ?? "default"; } catch { /* 保持默认 */ }
  try { Object.assign(ag, await window.pi.agentGet()); } catch { /* 保持默认 */ }
  try { Object.assign(nt, await window.pi.notifyGet()); } catch { /* 保持默认 */ }
  const fail = (err) => showNotice("保存失败：" + String(err?.message ?? err), true);
  const mkRow = (label) => {
    const r = el("div", "st-row st-app-row");
    const l = el("span", "st-app-label");
    l.textContent = label;
    r.appendChild(l);
    box.appendChild(r);
    return r;
  };
  const mkChips = (r, opts, cur, onPick) => {
    const c = el("div", "st-chips");
    for (const [val, name] of opts) {
      const b = el("button", "chip" + (val === cur ? " active" : ""));
      b.textContent = name;
      b.addEventListener("click", async () => {
        try { await onPick(val); stRenderAgent(); } catch (err) { fail(err); }
      });
      c.appendChild(b);
    }
    r.appendChild(c);
  };
  mkChips(mkRow("默认权限档"), [["plan", "计划"], ["default", "默认"], ["full", "完全"]], permCur,
    async (v) => { await window.pi.permSetDefault(v); permDefaultMode = v; });
  mkChips(mkRow("默认思考强度"), THINK_OPTS, ag.thinking ?? "",
    async (v) => { await window.pi.agentSetThinking(v === "" ? null : v); });
  mkChips(mkRow("上下文压缩"), AGENT_KEEP, ag.keep,
    async (v) => { await window.pi.agentSetKeep(v); });
  mkChips(mkRow("任务通知"), [["on", "开"], ["off", "关"]], nt.enabled ? "on" : "off",
    async (v) => { await window.pi.notifySet({ enabled: v === "on" }); });
  mkChips(mkRow("通知提示音"), [["on", "开"], ["off", "关"]], nt.sound ? "on" : "off",
    async (v) => { await window.pi.notifySet({ sound: v === "on" }); });
  const dndRow = mkRow("勿扰时段");
  const dnd = el("div", "st-f st-ag-dnd");
  const mkTime = (id, val) => {
    const t = el("input");
    t.type = "time";
    t.id = id;
    t.value = val ?? "";
    return t;
  };
  const s = mkTime("st-ag-dnd-s", nt.dndStart);
  const e2 = mkTime("st-ag-dnd-e", nt.dndEnd);
  const to = el("span", "st-ag-dnd-to");
  to.textContent = "至";
  const saveDnd = () => window.pi.notifySet({ dndStart: s.value, dndEnd: e2.value }).catch(fail);
  s.addEventListener("change", saveDnd);
  e2.addEventListener("change", saveDnd);
  dnd.append(s, to, e2);
  dndRow.appendChild(dnd);
  const hint = el("div", "st-hint");
  hint.textContent = "勿扰留空或起止相同 = 不启用，跨零点支持（如 22:00 至 08:00）"
    + (nt.gate && !nt.gate.allowed ? "；当前：" + (nt.gate.reason === "dnd" ? "勿扰中，通知已抑制" : "通知已关闭") : "");
  box.appendChild(hint);
}

/* 日志 tab（2026-10-10 owner 拍板）：原启动顶部「上次运行有异常」提醒条迁入。
   未确认 fatal 高亮提醒 + 查看（打开并 ack）/标记已读/打开目录 + tail 预览。 */
async function stRenderLogs() {
  const box = $("st-logs");
  box.innerHTML = "";
  let info;
  try { info = await window.pi.fatalInfo(); } catch { info = { has: false, error: "IPC 失败" }; }
  const status = el("div", "st-row st-app-row");
  const lab = el("span", "st-app-label");
  const acts = el("div", "st-acts");
  const mkAct = (text, fn) => {
    const b = el("button", "st-mini st-mini-txt");
    b.textContent = text;
    b.addEventListener("click", async () => { try { await fn(); stRenderLogs(); } catch { /* 静默：下次进 tab 重查 */ } });
    return b;
  };
  if (info?.has) {
    const unacked = info.unacked ?? false;
    lab.textContent = (unacked ? "上次运行有异常记录" : "最近异常（已确认）") + "：" + info.kind + " @ " + info.time;
    if (unacked) status.classList.add("st-log-warn");
    acts.append(
      mkAct("查看日志", async () => { await window.pi.openFatalLog(); }), // 打开文件（兑底资源管理器定位）并 ack
      mkAct("标记已读", async () => { await window.pi.ackFatalLog(); }),
    );
  } else {
    lab.textContent = "无异常记录";
    if (info?.dir) acts.append(mkAct("打开日志目录", async () => { await window.pi.openPath(info.dir); }));
  }
  status.append(lab, acts);
  box.appendChild(status);
  if (info?.tail) {
    const pre = el("pre", "st-log-tail");
    pre.textContent = info.tail;
    box.appendChild(pre);
  }
  if (info?.error) {
    const errEl = el("div", "st-hint");
    errEl.textContent = "读取失败：" + info.error;
    box.appendChild(errEl);
  }
}

/* ---- / 命令菜单：skills + prompt templates + GUI 动作 ---- */

let slashCommands = []; // 全量：{kind, label, insert, desc}
let slashItems = []; // 当前过滤结果
let slashActive = -1;

/* 命令使用权重（2026-10-05 owner 需求）：选中次数 + 时效加成排序，常用的稳居顶部
   存储：localStorage pi-gui:cmdstats = { [label]: {n: 次数, t: 最近使用 ms} }
   score = n + (24h 内 +2 / 7d 内 +1)；同分保持构建原序（稳定排序）；过滤结果同样适用 */
let cmdStats = {};
try { cmdStats = JSON.parse(localStorage.getItem("pi-gui:cmdstats") ?? "{}") || {}; } catch { cmdStats = {}; }

function cmdScore(label) {
  const s = cmdStats[label];
  if (!s || !s.n) return 0;
  const age = Date.now() - (s.t ?? 0);
  return s.n + (age < 864e5 ? 2 : age < 6048e5 ? 1 : 0);
}

function bumpCmd(label) {
  const s = cmdStats[label] ?? { n: 0, t: 0 };
  s.n += 1;
  s.t = Date.now();
  cmdStats[label] = s;
  try { localStorage.setItem("pi-gui:cmdstats", JSON.stringify(cmdStats)); } catch { /* 配额满不影响排序 */ }
}

async function loadCommands() {
  try {
    const data = await window.pi.listCommands();
    slashCommands = [
      ...(data.skills ?? []).map((s) => ({
        kind: "skill",
        label: "/skill:" + s.name,
        insert: "/skill:" + s.name + " ",
        desc: s.description || "技能",
      })),
      ...(data.prompts ?? []).map((p) => ({
        kind: "prompt",
        label: "/" + p.name,
        insert: "/" + p.name + " ",
        desc: (p.description || "提示模板") + (p.argumentHint ? " " + p.argumentHint : ""),
      })),
      { kind: "action", label: "/compare", insert: null, desc: "双模型同题对比" },
      { kind: "action", label: "/compact", insert: null, desc: "压缩会话上下文（Jev verbatim 剪枝，上下文过长时也自动触发）" },
      { kind: "action", label: "/分支", insert: null, desc: "查看/切换本会话分支（可找回中断重试的弃用分支）" },
      { kind: "action", label: "/rename", insert: "/rename ", desc: "整理任务历史并改名当前会话（无参数=自动起名）" },
      { kind: "action", label: "/approve", insert: null, desc: "批准计划：切回默认档并自动发送「按计划执行」（计划档产出方案后用）" },
      { kind: "action", label: "/排队", insert: null, desc: "发送模式：运行中发送排队等待" },
      { kind: "action", label: "/插话", insert: null, desc: "发送模式：运行中发送插入对话流" },
    ];
  } catch { /* 主进程不可用时无菜单 */ }
}

function slashToken() {
  // 命令须位于输入开头（作为整条消息的第一个 token）才触发；
  // 一旦出现空白（用户已开始输入参数），菜单关闭——否则继续打参数时菜单复活，
  // 回车会被 pickSlash 拦截并把输入重置回命令本身，参数内容凭空消失
  const v = input.value;
  if (!v.startsWith("/")) return null;
  if (/\s/.test(v)) return null;
  return v.match(/^\/\S*/)?.[0] ?? null;
}

function updateSlashMenu() {
  const menu = $("slash-menu");
  const tok = slashToken();
  if (!tok) {
    hideSlashMenu();
    return;
  }
  const q = tok.slice(1).toLowerCase();
  slashItems = slashCommands.filter(
    (c) => !q || c.label.toLowerCase().includes(q) || (c.desc ?? "").toLowerCase().includes(q)
  );
  if (!slashItems.length) {
    hideSlashMenu();
    return;
  }
  slashActive = Math.min(slashActive < 0 ? 0 : slashActive, slashItems.length - 1);
  // 权重排序：常用在前（稳定排序保原相对顺序）；过滤后的候选同样适用
  slashItems = slashItems.slice().sort((a, b) => cmdScore(b.label) - cmdScore(a.label));
  slashActive = Math.min(slashActive, slashItems.length - 1);
  menu.innerHTML = "";
  slashItems.forEach((c, i) => {
    const item = el("div", "slash-item" + (i === slashActive ? " active" : ""));
    const lab = el("span", "slash-label");
    lab.textContent = c.label;
    const desc = el("span", "slash-desc");
    desc.textContent = c.desc ?? "";
    item.append(lab, desc);
    item.addEventListener("click", () => pickSlash(i));
    menu.appendChild(item);
  });
  menu.classList.remove("hidden");
}

function pickSlash(i) {
  const c = slashItems[i];
  if (!c) return;
  hideSlashMenu();
  bumpCmd(c.label); // 使用权重 +1（菜单选中：回车/方向键/点击同路）
  if (c.insert != null) {
    input.value = c.insert;
    input.selectionStart = input.selectionEnd = c.insert.length;
    autoResize();
  } else {
    // GUI 动作：清空输入直接执行
    input.value = "";
    autoResize();
    if (c.label === "/compare") openCompare();
    else if (c.label === "/compact") doCompact();
    else if (c.label === "/分支") toggleBranchList();
    else if (c.label === "/排队") { sendMode = "queue"; showNotice("发送模式：排队（运行中发送将等待当前任务完成）"); }
    else if (c.label === "/插话") { sendMode = "steer"; showNotice("发送模式：插话（运行中发送将插入当前对话流）"); }
    else if (c.label === "/approve") doApprove();
  }
  input.focus();
}

function hideSlashMenu() {
  $("slash-menu").classList.add("hidden");
  slashItems = [];
  slashActive = -1;
}

/* ---- /approve：批准计划（2026-10-11 计划书 E2.1，交互对照 ZCode plan 审批流）----
 * plan 档产出方案 → /approve 切回 default 档 + 自动发送「按计划执行」首条（运行中走插话、空闲走新任务）。
 * 非计划档调用零动作只提示；验证经 __approveTestHook 截流自动首条（零 token，见 verify-approve）。 */
async function doApprove() {
  if (!state?.sessionId) return;
  // 档位以主进程权威态为准（渲染端缓存 state 可能滞后于刚发生的切档推送时序）
  let curMode = null;
  try { curMode = (await window.pi.getState())?.permMode ?? null; } catch { /* IPC 失败回落缓存 */ }
  if ((curMode ?? state?.permMode ?? "default") !== "plan") {
    showNotice("/approve 用于计划档：当前不在计划档，未执行", true);
    return;
  }
  bumpCmd("/approve");
  try {
    const r = await window.pi.permSetMode(state.sessionId, "default");
    if (!r?.ok) { showNotice("切档失败：" + (r?.error ?? "未知错误"), true); return; }
    applyPermMode("default");
  } catch (err) {
    showNotice("切档失败：" + (err?.message ?? err), true);
    return;
  }
  const follow = "按计划执行，从步骤 1 开始。";
  if (typeof window.__approveTestHook === "function") { window.__approveTestHook(follow); return; } // 验证截流
  doSend(follow);
}

/* ---- /rename：整理任务历史并改名当前会话（2026-10-04 owner 需求） ----
 * 带参数：/rename 新名字 → 直接改名
 * 无参数：临时会话（noTools）读当前会话历史自动起名，不进主对话、不污染上下文 */
/* ---- /压缩：主进程 session.compact()（2026-10-07）----
 * pi 内置命令只有 TUI 解析，SDK prompt 会当普通文本——必须走主进程 IPC。
 * fast-jev 接管时返回 engine=fast-jev-compaction；小会话/减重不足回落内置摘要。
 * 压缩会 abort 运行中任务，运行中禁止触发。 */
let manualCompact = false; // /压缩 手动流程进行中：压缩事件兑底分支不插手 notice（避免迟到事件 hideNotice 干掉结果反馈）
async function doCompact() {
  manualCompact = true;
  try {
    showNotice("正在压缩会话上下文…");
    const r = await window.pi.compact();
    if (r?.ok) showNotice("压缩完成（" + r.engine + "）");
    else showNotice("压缩未执行：" + (r?.error ?? "会话太小或减重不足，已保留原样"), true);
  } catch (err) {
    showNotice("压缩失败：" + String(err?.message ?? err), true);
  } finally {
    // 延迟清除：压缩事件流（compaction_start/结束）经 IPC 转发可能晚于 invoke 返回值到达渲染端，
    // 立即清标志会让兑底分支的 hideNotice 在同一毫秒干掉结果反馈（2026-10-07 MutationObserver 实测）；800ms 给事件流排空
    setTimeout(() => { manualCompact = false; }, 800);
  }
}

async function handleRename(text) {
  const arg = text.replace(/^\/rename\s*/i, "").trim();
  bumpCmd("/rename"); // 本地命令路径计数（不走菜单 pickSlash）
  try {
    if (arg) {
      const r = await window.pi.renameSession(arg);
      showNotice("会话已改名：" + r.name);
    } else {
      showNotice("正在整理任务历史，生成会话名…", false, true);
      const r = await window.pi.autoNameSession();
      hideNotice();
      showNotice("已按任务历史改名：" + r.name);
    }
    renderSidebarTree();
  } catch (err) {
    hideNotice();
    showNotice("/rename 失败：" + String(err?.message ?? err), true);
  }
}

function send() {
  const text = input.value.trim();
  const imgs = attachments.map((a) => ({ type: "image", data: a.base64, mimeType: a.mime }));
  if ((!text && !imgs.length) || !state) return;
  // 视觉自动切换（异步预处理）：带图且当前模型看不了图 → 切视觉模型；无图且自动切换过 → 回切
  maybeVisionSwitch(imgs).finally(() => doSend(text, imgs));
}

function doSend(text, imgs) {
  // GUI 动作命令本地拦截（owner 习惯直接输入回车；不拦截会被当普通文本发给模型——内置命令只有 TUI 解析，2026-10-07 实测）
  if (/^\/compact\s*$/i.test(text)) {
    input.value = "";
    attachments = [];
    saveDraft();
    renderAttachments();
    autoResize();
    doCompact();
    return;
  }
  // /分支：同款本地拦截（2026-10-07 D1 补齐——此前只能从菜单点选，直接回车会把命令发给模型烧 token）
  if (/^\/分支\s*$/i.test(text)) {
    input.value = "";
    attachments = [];
    saveDraft();
    renderAttachments();
    autoResize();
    toggleBranchList();
    return;
  }
  // /rename 是 GUI 动作：本地处理，不发给模型（运行中也可改名，setSessionName 只追加 session_info 记录）
  if (/^\/rename(\s|$)/i.test(text)) {
    input.value = "";
    attachments = [];
    saveDraft(); // 已发出/已消费，同步清掉该会话存库草稿（文字+附件，否则重启会被当草稿还原）
    renderAttachments();
    autoResize();
    handleRename(text);
    return;
  }
  // /approve：批准计划（2026-10-11 计划书 E2.1）——plan 档产出方案后一键切回默认档并自动发执行首条
  if (/^\/approve\s*$/i.test(text)) {
    input.value = "";
    attachments = [];
    saveDraft();
    renderAttachments();
    autoResize();
    doApprove();
    return;
  }
  addUserBubble(text, imgs);
  input.value = "";
  attachments = [];
  saveDraft(); // 同上：已发送即清存库草稿（文字+附件）
  renderAttachments();
  autoResize();
  if (running) {
    if (text.startsWith("/")) {
      // 命令文本走 prompt 通道：SDK 在流式中也立即处理扩展命令/展开模板（steer 不解析命令）
      window.pi.prompt(text, [], { streamingBehavior: sendMode === "queue" ? "followUp" : "steer" })
        .then(() => showNotice("命令已提交" + (sendMode === "queue" ? "（排队至当前任务后执行）" : "")))
        .catch((err) => showNotice(String(err?.message ?? err), true));
    } else {
      const call = sendMode === "steer" ? window.pi.steer(text, imgs) : window.pi.followUp(text, imgs);
      call.then((r) => {
        // 主进程在空闲时会自动把 steer 转为新任务（死信防护），反馈给用户
        if (r === "prompted") showNotice("发送时已空闲，已作为新任务执行");
        else if (sendMode === "steer") showNotice("已插话，将在当前步骤结束后送达");
        else showNotice("已排队，当前任务完成后自动发送");
      }).catch((err) => showNotice(String(err?.message ?? err), true));
    }
  } else {
    doPrompt(text, imgs);
  }
}

input.addEventListener("input", () => {
  autoResize();
  updateSlashMenu();
  scheduleDraftSave(); // 草稿随输入防抖落库（500ms），应用中途被杀/崩溃也不丢
});
// 设置弹层 ESC 关闭（document 级，优先于输入框的 slash 菜单 Esc）；表单替换视图打开时先收表单再关弹层
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("settings-overlay").classList.contains("hidden")) {
    e.preventDefault();
    e.stopPropagation();
    const editing = document.querySelector(".st-tab.editing");
    if (editing) { editing.classList.remove("editing"); return; }
    closeSettings();
  }
}, true);
input.addEventListener("keydown", (e) => {
  const menuOpen = !$("slash-menu").classList.contains("hidden");
  if (menuOpen && !e.isComposing) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashActive = (slashActive + 1) % slashItems.length;
      updateSlashMenu();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashActive = (slashActive - 1 + slashItems.length) % slashItems.length;
      updateSlashMenu();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickSlash(slashActive);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideSlashMenu();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#composer")) hideSlashMenu();
});
$("btn-send").addEventListener("click", send);
$("btn-abort").addEventListener("click", () => window.pi.abort());

/* ---- 图片附件交互：粘贴 / 文件选择 / 拖拽 ---- */
input.addEventListener("paste", (e) => {
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) { addImageFile(f); e.preventDefault(); }
    }
  }
});
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
  for (const f of e.target.files ?? []) addImageFile(f);
  e.target.value = "";
});
for (const zone of [$("composer"), chat]) {
  zone.addEventListener("dragover", (e) => e.preventDefault());
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    for (const f of e.dataTransfer?.files ?? []) addImageFile(f);
  });
}

/* 点击文件路径 → 入壳（2026-10-06 设计轮：文件开查看器 tab、目录定位到树；系统打开退右键）
 * http 链接（2026-10-08 阶段二）：左键=浏览器面板打开（GUI 内聚，owner 拍板自由浏览器入口）；
 * 右键菜单给「系统浏览器打开/复制链接」退路。此前 http 链接点击被 will-navigate 拦截属死链。 */
chat.addEventListener("click", async (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href^="http"]') : null;
  if (a) {
    e.preventDefault();
    void openWebTab(a.href);
    return;
  }
  const link = e.target instanceof Element ? e.target.closest(".file-link") : null;
  if (!link) return;
  const p = link.dataset.path;
  const kind = await window.pi.pathKind(p).catch(() => null);
  if (kind === "file") {
    openViewerTab(p);
  } else if (kind === "dir") {
    void locateInTree(p);
  } else {
    showNotice("路径不存在：" + p);
  }
});

chat.addEventListener("contextmenu", (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href^="http"]') : null;
  if (!a) return;
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, [
    { label: "在面板打开（浏览器 tab）", icon: "#i-external", act: () => void openWebTab(a.href) },
    { label: "系统浏览器打开", icon: "#i-external", act: () => void window.pi.openExternal(a.href) },
    { label: "复制链接", icon: "#i-copy", act: () => copyPathAct(a.href) },
  ]);
});

/* ================= 启动 ================= */

console.log("[app.js] module loaded");
window.addEventListener("error", (e) => console.error("[app.js] uncaught:", e.message));

window.pi.onEvent(handleEvent);
// 主进程推送状态（MCP 工具后台就位后刷新芯片等）
if (window.pi.onState) {
	window.pi.onState((s) => {
		if (!s) return;
		state = s;
		renderSidebar();
		applyPermMode(s.permMode); // 三档权限：切会话/切档推送同步胶囊（2026-10-08 批次1）
	});
}

/* ================= 三档权限胶囊（2026-10-08 zcode 套用批次1） =================
 * composer 左下档位胶囊（对标 zcode 位置排布）：plan=只读探索 / default=路径守卫现状 / full=全放行。
 * 作用域=当前会话（state.sessionId）；切档即时生效（主进程 entry.permMode，下次 tool_call 即中）。
 * 菜单复用 showCtxMenu；「新会话默认档」写 pi-gui-config.json。 */
const PERM_MODES = {
	plan: { label: "计划", icon: "#i-plan", cls: "plan", desc: "只读探索，拦写文件/命令" },
	default: { label: "默认", icon: "#i-shield", cls: "default", desc: "白名单内放行，越界弹窗" },
	full: { label: "完全", icon: "#i-bolt", cls: "full", desc: "全放行（跳过路径守卫）" },
};
let permDefaultMode = "default";

function applyPermMode(mode) {
	const m = PERM_MODES[mode] ?? PERM_MODES.default;
	const pill = $("perm-pill");
	if (!pill) return;
	$("perm-pill-icon").setAttribute("href", m.icon);
	$("perm-pill-text").textContent = m.label;
	pill.className = "perm-pill " + m.cls;
	pill.title = "权限档位（当前会话）：" + m.label + " — " + m.desc;
}

async function pickPerm(key) {
	if (!state?.sessionId) return;
	try {
		const r = await window.pi.permSetMode(state.sessionId, key);
		if (r?.ok) applyPermMode(key);
		else showNotice("切档失败：" + (r?.error ?? "未知错误"), true);
	} catch (err) {
		showNotice("切档失败：" + (err?.message ?? err), true);
	}
}

function openPermDefaultMenu(anchor) {
	const items = Object.entries(PERM_MODES).map(([key, m]) => ({
		icon: m.icon,
		label: (key === permDefaultMode ? "✓ " : "") + m.label + " — " + m.desc,
		act: async () => {
			try {
				const r = await window.pi.permSetDefault(key);
				if (r?.ok) permDefaultMode = key;
			} catch { /* 保持原值 */ }
		},
	}));
	const r = anchor.getBoundingClientRect();
	showCtxMenu(r.left, r.bottom + 4, items);
}

$("perm-pill").addEventListener("click", (e) => {
	try {
		const anchor = e.currentTarget;
		const cur = state?.permMode ?? "default";
		const modeItems = Object.entries(PERM_MODES).map(([key, m]) => ({
			icon: m.icon,
			label: (key === cur ? "✓ " : "") + m.label + " — " + m.desc,
			act: () => void pickPerm(key),
		}));
		showCtxMenu(anchor.getBoundingClientRect().left, anchor.getBoundingClientRect().bottom + 4, [
			...modeItems,
			{ sep: true },
			{ label: "新会话默认档…", icon: "#i-gear", act: () => openPermDefaultMenu(anchor) },
		]);
	} catch (err) {
		showNotice("打开权限菜单失败：" + (err?.message ?? err), true);
	}
});

// 初始默认档（新会话首推 state 前胶囊先按默认档渲染）
window.pi.permGetDefault().then((d) => { if (PERM_MODES[d]) permDefaultMode = d; }).catch(() => {});

/* ================= ask_user 提问卡（2026-10-08 批次2；同日晚 owner 反馈改对话内卡片） =================
 * owner 反馈：模态弹窗遮挡对话流，看不到 assistant 的分析就无法决策——改为对话流内非模态卡片：
 * ask:request 推送 → 卡片追加 #chat 尾部（推荐项排首+徽标；点选/Other 自由作答 → ask:answer 回传）。
 * 无限等待不超时；不遮挡可回翻上下文；renderHistory 重建后 renderAskCards() 重挂；
 * 页面重载经 ask:pendingList 找回（ask:request 只推一次不重放）；ask-bar 常驻提醒，点击滚动定位+闪烁。 */
const askReqs = new Map(); // toolCallId -> { ...payload, status: "pending"|"answered"|"expired", cardEl }

function askBarUpdate() {
  const pend = [...askReqs.values()].some((r) => r.status === "pending" && r.sessionId === state?.sessionId);
  $("ask-bar").classList.toggle("hidden", !pend);
}

function askSettleCard(req, status, text) {
  req.status = status;
  const card = req.cardEl;
  if (!card) return;
  card.classList.remove("pending");
  card.classList.add(status === "answered" ? "answered" : "expired");
  const st = card.querySelector(".ask-state");
  if (st) st.textContent = status === "answered" ? "已作答" : "已失效";
  card.querySelector(".ask-options")?.remove();
  card.querySelector(".ask-other")?.remove();
  if (text) {
    const d = el("div", "ask-done");
    const k = el("span", "k");
    k.textContent = status === "answered" ? "已选" : "说明";
    d.append(k, document.createTextNode(text));
    card.append(d);
  }
  askBarUpdate();
}

async function answerAsk(req, text) {
  if (!req || req.status !== "pending" || !String(text ?? "").trim()) return;
  try {
    const r = await window.pi.askAnswer(req.sessionId, req.toolCallId, String(text).trim());
    if (r?.ok) askSettleCard(req, "answered", String(text).trim());
    else askSettleCard(req, "expired", r?.error ?? "问题已失效（任务可能已中止）");
  } catch (err) {
    showNotice("作答失败：" + String(err?.message ?? err), true);
  }
}

function buildAskCard(req) {
  const card = el("div", "ask-card pending");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "agent 提问");
  const head = el("div", "ask-head");
  head.append(svgUse("#i-help", "ic ic-s"));
  const ht = el("span");
  ht.textContent = "agent 提问";
  head.append(ht);
  const st = el("span", "ask-state");
  st.textContent = "待答";
  head.append(st);
  card.append(head);
  const q = el("div", "ask-question");
  q.textContent = req.question;
  card.append(q);
  if (req.context) {
    const c = el("div", "ask-context");
    c.textContent = req.context;
    card.append(c);
  }
  const box = el("div", "ask-options");
  card.append(box);
  // 推荐项排首并标注（共识：推荐答案标注+排首位），其余保持原序
  const opts = [...(req.options ?? [])];
  if (typeof req.recommended === "number" && req.recommended >= 0 && req.recommended < opts.length) {
    const rec = opts.splice(req.recommended, 1)[0];
    opts.unshift({ ...rec, recommended: true });
  }
  for (const o of opts) {
    const b = el("button", "ask-opt" + (o.recommended ? " recommended" : ""));
    b.type = "button";
    if (o.recommended) {
      const badge = el("span", "ask-rec-badge");
      badge.textContent = "推荐";
      b.append(badge);
    }
    const lab = el("span", "ask-opt-label");
    lab.textContent = o.label;
    b.append(lab);
    if (o.description) {
      const d = el("span", "ask-opt-desc");
      d.textContent = o.description;
      b.append(d);
    }
    b.addEventListener("click", () => void answerAsk(req, o.label));
    box.appendChild(b);
  }
  const other = el("div", "ask-other");
  const inp = el("input", "ask-other-input");
  inp.type = "text";
  inp.placeholder = "或自由作答（Other）…";
  inp.spellcheck = false;
  const send = el("button", "btn btn-primary");
  send.type = "button";
  send.textContent = "作答";
  send.addEventListener("click", () => void answerAsk(req, inp.value));
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void answerAsk(req, inp.value);
    }
  });
  other.append(inp, send);
  card.append(other);
  req.cardEl = card;
  return card;
}

function registerAsk(req) {
  if (!req?.toolCallId) return;
  const r = { ...req, status: "pending" };
  askReqs.set(String(req.toolCallId), r);
  buildAskCard(r);
  if (r.sessionId === state?.sessionId) {
    if (!hydrating) r.cardEl.classList.add("enter"); // 历史重挂零回放（R3 纪律）
    chat.appendChild(r.cardEl);
    scrollBottom(); // 尊重用户滚动意图：上翻阅读分析时不强行拉底（owner 2026-10-07 同源需求）
  }
  askBarUpdate();
}

function renderAskCards() {
  // renderHistory 重建 #chat 后重挂当前会话的卡片（待答+已答都挂，保对话流记录）
  for (const r of askReqs.values()) {
    if (r.cardEl && r.sessionId === state?.sessionId && !r.cardEl.isConnected) chat.appendChild(r.cardEl);
  }
  askBarUpdate(); // 2026-10-10 验收修：reload 找回链 pendingList 跑在模块加载层（state 尚 null，bar 判 hidden），重挂后必须同步 bar 态——否则卡在但提醒条永不亮
}

$("ask-bar").addEventListener("click", () => {
  const r = [...askReqs.values()].find((x) => x.status === "pending" && x.sessionId === state?.sessionId);
  if (!r?.cardEl) return;
  r.cardEl.scrollIntoView({ behavior: "smooth", block: "center" });
  r.cardEl.classList.add("flash");
  setTimeout(() => { r.cardEl?.classList.remove("flash"); }, 1200);
});

if (window.pi.onAsk) {
  window.pi.onAsk((req) => registerAsk(req));
  // 页面重载/冷启找回主进程仍在等待的问题（ask:request 只推一次不重放）
  window.pi.askPendingList?.().then((list) => { for (const req of list ?? []) registerAsk(req); }).catch(() => {});
}

/* design-gate 通知式提示（owner 2026-10-10 拍板：不弹卡，对话流一嘴）——浅色行、无需作答、一次性 */
if (window.pi.onGateNotice) {
  window.pi.onGateNotice((n) => {
    if (n?.sessionId && state?.sessionId && n.sessionId !== state.sessionId) return; // 只渲染当前会话
    const row = el("div", "gate-notice");
    row.append(svgUse("#i-help", "ic ic-s"));
    const t = el("span", "gate-notice-text");
    t.textContent = String(n?.text ?? "design-gate 提示");
    row.append(t);
    row.classList.add("enter");
    chat.appendChild(row); // 一次性通知：不进消息历史，renderHistory 重建后消失（时效短可接受）
    scrollBottom(false); // 尊重用户滚动意图
  });
}



/* ================= 更新提示胶囊（2026-10-08） =================
 * 主进程 npm 检测推送驱动；点击复制升级命令（复制后短哲显示已复制，不弹通知条）。 */
const updatePill = $("update-pill");
let updatePillTimer = null;

function cmpVersion(a, b) {
  const num = (v) => String(v || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const x = num(a), y = num(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

function renderUpdatePill(s) {
  if (!updatePill || !s) return;
  const has = !!(s.latest && s.current && cmpVersion(s.latest, s.current) > 0);
  // 同步设置弹层状态（2026-10-08）：latest 有值=检测成功；null+非 pending=检测失败，不再静默无凭据
  if (s.pending) {
    stUpdateStatus = "更新检测中…";
  } else if (has) {
    stUpdateStatus = "可更新 v" + s.latest;
  } else if (s.latest) {
    stUpdateStatus = "已最新";
  } else {
    stUpdateStatus = "更新检测失败";
  }
  stRefreshFoot();
  if (!has) {
    updatePill.classList.add("hidden");
    return;
  }
  updatePill.classList.remove("hidden");
  updatePill.querySelector(".update-pill-ver").textContent = "v" + s.latest;
  updatePill.dataset.cmd = "npm install -g @earendil-works/pi-coding-agent@" + s.latest;
  updatePill.title = `pi 有新版本 v${s.current} → v${s.latest}，点击复制升级命令（升级后需重启 GUI 生效）`;
}

if (updatePill) {
  updatePill.addEventListener("click", async () => {
    const cmd = updatePill.dataset.cmd;
    if (!cmd) return;
    try {
      await window.pi.writeClipboard(cmd);
      const span = updatePill.querySelector(".update-pill-ver");
      const old = "v" + cmd.split("@").pop();
      updatePill.classList.add("copied");
      span.textContent = "已复制升级命令";
      clearTimeout(updatePillTimer);
      updatePillTimer = setTimeout(() => {
        span.textContent = old;
        updatePill.classList.remove("copied");
      }, 1600);
    } catch { /* 剪贴板失败静默，胶囊状态不变 */ }
  });
  if (window.pi.onUpdateState) window.pi.onUpdateState(renderUpdatePill);
  // init 兜底拉一次：防主进程推送早到（渲染端还没绑监听）时丢事件
  window.pi.getUpdateState().then(renderUpdatePill).catch(() => {});
}

(async function init() {
  console.log("[app.js] init start");
  // 启动自检：pi 是否加载成功 + 版本 + 环境变量
  try {
    const sc = await window.pi.selfcheck();
    if (!sc.piLoaded) {
      showNotice("pi 加载失败：" + sc.piLoadError + " —— 请在应用目录执行 npm install 重装依赖后重启", true, true);
    } else if (sc.piVersion) {
      stPiVersion = "pi v" + sc.piVersion;
      stRefreshFoot();
    }
    if (sc.envKeysPresent?.length) {
      console.log("[app.js] 环境变量在场：", sc.envKeysPresent.join(", "));
    } else {
      console.warn("[app.js] 未检测到任何模型/云 API 环境变量");
    }
  } catch { /* 自检失败不阻塞启动 */ }

  let lastCwd = localStorage.getItem("pi-gui:cwd") || "";
  // 工作区：优先上次活跃的；没有则把当前目录登记为首个工作区
  try {
    const ws = await window.pi.wsList();
    const active = ws.workspaces.find((w) => w.id === ws.activeId) ?? ws.workspaces[0];
    if (active) lastCwd = active.cwd;
  } catch { /* 工作区加载失败按无处理 */ }
  // 渲染端 reload 后优先认领主进程现存会话（刷新不丢对话、不打断运行中任务）
  try {
    const attached = await window.pi.attachSession();
    if (attached?.cwd) {
      state = attached;
      console.log("[app.js] attached to live session:", state.sessionPath ?? "(unsaved)", "msgs:", state.messages?.length ?? 0);
    }
  } catch { /* attach 失败走新建 */ }
  if (!state) {
    try {
      state = await window.pi.createSession(lastCwd || null);
      console.log("[app.js] createSession ok:", JSON.stringify(state));
    } catch (err) {
      console.error("[app.js] createSession failed:", err);
      showNotice("会话创建失败：" + (err?.message ?? err), true);
      return;
    }
  }
  localStorage.setItem("pi-gui:cwd", state.cwd ?? "");
  // 认领现存会话时恢复运行态与历史显示（费用/tokens 由 renderHistory→finalizeAssistant 自动重算）
  if (state.running) setRunning(true);
  renderHistory(state.messages ?? []);
  // 变更栏已砍：changedFiles 不再有 pane 渲染，chip/树定位按需消费
  restoreDraft(); // 重启/认领会话后恢复该会话自己的草稿（2026-10-05）
  {
    // 首次目录自动登记为工作区（主目录除外：那是自由会话区，不属于任何工作区，2026-10-06 owner 重申）。
    // homeDir 此时尚未由 renderSidebarTree 填充，需自取——旧写法拿 null 比对导致主目录被误登记成工作区
    const wsCfg0 = await window.pi.wsList().catch(() => ({}));
    const homeDir0 = homeDir ?? wsCfg0.homeDir;
    if (state.cwd && state.cwd !== homeDir0 && !(wsCfg0.workspaces ?? []).some((w) => w.cwd === state.cwd)) {
      await window.pi.wsAdd(state.cwd);
    }
  }
  await renderSidebarTree();
  renderSidebar();
  syncSceneSeg();
  // reload/崩溃自愈孤儿视图兜底（2026-10-12 甲批）：本进程 web 视图注册表在主进程，渲染端 vwTabs
  // 已随 reload 清零——init 即全关，防旧 WebContentsView 按旧 bounds 盖在新界面上方挡点击
  try { await window.pi.webDetachAll(); } catch { /* 老版本主进程无此通道则忽略 */ }
  await loadModels();
  await renderFileRoot();
  await renderSidebarTree();
  renderFooter();
  setInterval(renderFooter, 60_000); // git/用量定期刷新（主进程侧各有限流/缓存）
  await loadCommands();
  void refreshScenes(); // 场景三档跟随默认模型（异步不挡 init；完成时 syncSceneSeg 自动对齐）
  void obInit().then(() => { if (!models.length) obShow(); }); // 引导向导：无可用模型（全新用户）→ 全屏配置环境（2026-10-12 开源阶段 1）
  console.log("[app.js] init done, models:", models.length);
  input.focus();
})();
