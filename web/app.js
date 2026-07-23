"use strict";

// ---------------------------------------------------------------------------
// state

const state = {
  projects: [],
  sessions: [],
  currentProject: null,
  currentSession: null,   // meta dict
  transcriptStart: 0,     // index of the first loaded item
  ws: null,
  wsBusy: false,
  liveSessionId: "",
  inSearch: false,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// utils

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Minimal markdown renderer (code fences / inline code / headings / bold /
// lists / links). The whole string is HTML-escaped first, so it is XSS-safe.
// Code fences are pulled out behind a private-use sentinel (written as an
// ASCII escape so the source file stays pure ASCII) and restored at the end.
const FENCE = "\uE000";  // U+E000 private-use sentinel; \uXXXX escape keeps this line pure ASCII
function renderMarkdown(src) {
  const fences = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return FENCE + (fences.length - 1) + FENCE;
  });
  let html = escapeHtml(src);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
                      '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = renderTables(html);
  // bullet lists
  html = html.replace(/((?:^[-*] .*(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split("\n").map(l => `<li>${l.replace(/^[-*] /, "")}</li>`).join("");
    return `<ul>${items}</ul>\n`;
  });
  html = html.replace(/((?:^\d+\. .*(?:\n|$))+)/gm, (m) => {
    const items = m.trim().split("\n").map(l => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("");
    return `<ol>${items}</ol>\n`;
  });
  // paragraphs (leave block elements as-is)
  html = html.split(/\n{2,}/).map(part => {
    if (/^\s*<(h\d|ul|ol|pre|table)/.test(part)) return part;
    return `<p>${part.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  html = html.replace(new RegExp(FENCE + "(\\d+)" + FENCE, "g"), (_, i) => fences[+i]);
  return html;
}

// GitHub-style pipe tables: a header row, a |---|---| separator, then body rows.
// Runs after inline formatting so cell contents keep their <code>/<strong>/<a>.
function _tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
}
function renderTables(html) {
  const lines = html.split("\n");
  const out = [];
  let i = 0;
  const rowRe = /^\s*\|(.+)\|\s*$/;
  const sepRe = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/;
  while (i < lines.length) {
    if (rowRe.test(lines[i]) && i + 1 < lines.length && sepRe.test(lines[i + 1])) {
      const header = _tableCells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && rowRe.test(lines[i]) && !sepRe.test(lines[i])) {
        rows.push(_tableCells(lines[i]));
        i++;
      }
      const thead = "<tr>" + header.map(c => `<th>${c}</th>`).join("") + "</tr>";
      const tbody = rows.map(r =>
        "<tr>" + header.map((_, k) => `<td>${r[k] || ""}</td>`).join("") + "</tr>"
      ).join("");
      out.push(`<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`);
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric",
                                     hour: "2-digit", minute: "2-digit" });
}

function timeAgo(iso) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtTokens(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function renderStats(s) {
  const st = [];
  const totTok = (s.inTokens || 0) + (s.outTokens || 0);
  if (s.assistantTurns) st.push(`💬 ${s.assistantTurns} replies`);
  if (totTok) st.push(`🎟 ${fmtTokens(totTok)} tokens · out ${fmtTokens(s.outTokens)}`);
  if (s.cacheReadTokens) st.push(`♻ ${fmtTokens(s.cacheReadTokens)} cache read`);
  if (s.models && s.models.length) st.push(`🤖 ${s.models.join(", ")}`);
  if (s.webSearches || s.webFetches) st.push(`🔎 web ${s.webSearches}/${s.webFetches}`);
  $("session-stats").innerHTML = st.map((x) => `<span class="stat">${escapeHtml(x)}</span>`).join("");
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// projects / sessions list

async function loadProjects() {
  state.projects = await api("/api/projects");
  const el = $("project-list");
  el.innerHTML = "";
  const dl = $("known-paths");
  dl.innerHTML = "";
  for (const p of state.projects) {
    const div = document.createElement("div");
    div.className = "project-item" +
      (state.currentProject === p.projectId ? " active" : "");
    div.innerHTML =
      `<div class="p-path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</div>` +
      `<div class="p-info">${p.sessionCount} sessions · ${timeAgo(p.lastActive)}</div>`;
    div.onclick = () => selectProject(p.projectId);
    el.appendChild(div);
    const opt = document.createElement("option");
    opt.value = p.path;
    dl.appendChild(opt);
  }
}

async function selectProject(projectId) {
  state.currentProject = projectId;
  document.querySelectorAll(".project-item").forEach(e => e.classList.remove("active"));
  loadProjects();
  state.sessions = await api(`/api/projects/${encodeURIComponent(projectId)}/sessions`);
  renderSessionList();
}

function renderSessionList() {
  const filter = $("session-filter").value.toLowerCase();
  const el = $("session-list");
  el.innerHTML = "";
  for (const s of state.sessions) {
    const hay = (s.title + " " + s.lastPrompt + " " + s.sessionId).toLowerCase();
    if (filter && !hay.includes(filter)) continue;
    const div = document.createElement("div");
    div.className = "session-item" +
      (state.currentSession && state.currentSession.sessionId === s.sessionId ? " active" : "");
    const branch = s.gitBranch ? `<span class="badge">⎇ ${escapeHtml(s.gitBranch)}</span>` : "";
    const pr = s.prUrl ? `<span class="badge">PR</span>` : "";
    const tag = s.tag ? `<span class="badge tag">🏷 ${escapeHtml(s.tag)}</span>` : "";
    const tok = (s.inTokens || 0) + (s.outTokens || 0);
    const tokSpan = tok ? `<span>${fmtTokens(tok)} tok</span>` : "";
    div.innerHTML =
      `<div class="s-title">${escapeHtml(s.title || "(untitled)")}</div>` +
      `<div class="s-info"><span>${timeAgo(s.lastTs)}</span>` +
      `<span>${s.userTurns} turns</span>${tokSpan}${branch}${pr}${tag}</div>` +
      `<button class="s-actions" title="Actions">⋯</button>`;
    div.onclick = () => selectSession(s);
    div.querySelector(".s-actions").onclick = (ev) => {
      ev.stopPropagation();
      openSessionMenu(ev, s);
    };
    el.appendChild(div);
  }
}

// ---------------------------------------------------------------------------
// transcript

async function selectSession(s) {
  disconnectChat();
  state.currentSession = s;
  renderSessionList();
  $("session-title").textContent = s.title || s.sessionId;
  const meta = [];
  if (s.cwd) meta.push(`📁 ${s.cwd}`);
  if (s.gitBranch) meta.push(`⎇ ${s.gitBranch}`);
  if (s.lastTs) meta.push(`🕒 ${fmtTime(s.lastTs)}`);
  meta.push(`${(s.sizeBytes / 1024).toFixed(0)} KB`);
  meta.push(s.sessionId.slice(0, 8));
  $("session-meta").innerHTML = meta.map(m => `<span>${escapeHtml(m)}</span>`).join("");
  renderStats(s);
  $("btn-resume").disabled = false;

  const t = $("transcript");
  t.innerHTML = '<div class="empty-state"><p>Loading…</p></div>';
  const data = await api(
    `/api/projects/${encodeURIComponent(s.projectId)}/sessions/${encodeURIComponent(s.sessionId)}`);
  t.innerHTML = "";
  state.transcriptStart = data.start || 0;
  if (state.transcriptStart > 0) t.appendChild(makeLoadMore());
  for (const item of data.items) t.appendChild(renderItem(item));
  t.scrollTop = t.scrollHeight;
}

function makeLoadMore() {
  const btn = document.createElement("button");
  btn.className = "load-more";
  btn.textContent = `▲ Load earlier (${state.transcriptStart} remaining)`;
  btn.onclick = async () => {
    const s = state.currentSession;
    const data = await api(
      `/api/projects/${encodeURIComponent(s.projectId)}/sessions/` +
      `${encodeURIComponent(s.sessionId)}?before=${state.transcriptStart}&limit=200`);
    const t = $("transcript");
    const prevHeight = t.scrollHeight;
    btn.remove();
    const frag = document.createDocumentFragment();
    state.transcriptStart = data.start || 0;
    if (state.transcriptStart > 0) frag.appendChild(makeLoadMore());
    for (const item of data.items) frag.appendChild(renderItem(item));
    t.prepend(frag);
    t.scrollTop = t.scrollHeight - prevHeight;
  };
  return btn;
}

function renderItem(item) {
  if (item.kind === "divider") {
    const d = document.createElement("div");
    d.className = "divider";
    d.textContent = item.text;
    return d;
  }
  const wrap = document.createElement("div");
  if (item.kind === "user" || item.kind === "assistant" || item.kind === "system") {
    const frag = document.createDocumentFragment();
    let bubble = null;
    for (const b of item.blocks) {
      if (b.t === "text") {
        if (!bubble) {
          bubble = document.createElement("div");
          bubble.className = `msg ${item.kind}` + (item.isError ? " error" : "");
          const who = item.kind === "user" ? "You" : (item.kind === "system" ? "System" : "Claude");
          bubble.innerHTML =
            `<div class="msg-head"><span class="who-${item.kind}">${who}</span>` +
            `<span>${fmtTime(item.ts)}</span>` +
            (item.model ? `<span>${escapeHtml(item.model)}</span>` : "") + `</div>` +
            `<div class="msg-body"></div>`;
          frag.appendChild(bubble);
        }
        bubble.querySelector(".msg-body").innerHTML += renderMarkdown(b.text);
      } else if (b.t === "thinking") {
        frag.appendChild(renderThinking(b.text));
      } else if (b.t === "tool_use") {
        frag.appendChild(renderToolUse(b));
      }
    }
    wrap.appendChild(frag);
  }
  return wrap;
}

function renderThinking(text) {
  const d = document.createElement("details");
  d.className = "thinking";
  d.innerHTML = `<summary>💭 thinking</summary>` +
                `<div class="code-box">${escapeHtml(text)}</div>`;
  return d;
}

function renderToolUse(b) {
  const d = document.createElement("details");
  d.className = "tool" + (b.isError ? " err" : "");
  let inner = `<summary>🔧 <span class="tool-name">${escapeHtml(b.name)}</span></summary>` +
              `<div class="code-box">${escapeHtml(b.input || "")}</div>`;
  if (b.result != null) {
    inner += `<div class="result-label">${b.isError ? "❌ Error" : "Result"}</div>` +
             `<div class="code-box">${escapeHtml(b.result)}</div>`;
  }
  d.innerHTML = inner;
  if (b.id) d.dataset.toolId = b.id;
  return d;
}

// ---------------------------------------------------------------------------
// live chat

function setChatStatus(text, mode) {
  $("chat-status-text").textContent = text;
  const dot = $("conn-dot");
  dot.className = "dot" + (mode === "on" ? " on" : mode === "busy" ? " busy" : "");
  $("btn-interrupt").classList.toggle("hidden", mode !== "busy");
  $("btn-disconnect").classList.toggle("hidden", mode === "off");
}

function openChat(startPayload) {
  disconnectChat();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/chat`);
  state.ws = ws;
  $("chat-bar").classList.remove("hidden");
  setChatStatus("Connecting…", "busy");

  ws.onopen = () => ws.send(JSON.stringify(startPayload));
  ws.onclose = () => { setChatStatus("Disconnected", "off"); state.ws = null; state.wsBusy = false; };
  ws.onerror = () => setChatStatus("Connection error", "off");
  ws.onmessage = (ev) => handleChatEvent(JSON.parse(ev.data));
}

let streamBubble = null;   // bubble for the in-progress delta stream
let streamText = "";

function ensureStreamBubble() {
  if (streamBubble) return streamBubble;
  const t = $("transcript");
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="msg-head"><span class="who-assistant">Claude</span>` +
                  `<span>live</span></div><div class="msg-body"></div>`;
  t.appendChild(div);
  streamBubble = div;
  streamText = "";
  return div;
}

function endStreamBubble() { streamBubble = null; streamText = ""; }

function handleChatEvent(e) {
  const t = $("transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 120;

  switch (e.event) {
    case "ready":
      setChatStatus("Connected — you can send a message", "on");
      break;
    case "init":
      state.liveSessionId = e.sessionId || "";
      if (e.sessionId) {
        setChatStatus(`Session ${e.sessionId.slice(0, 8)}… (${e.model || ""})`, "busy");
      }
      if (Array.isArray(e.skills)) {
        availableSkills = e.skills;
        loadSkills();          // ensure the description map is loaded
        rebuildSkillItems();   // now / autocomplete + Skills tab reflect this session
      }
      addMcpInfoLine(e.mcpServers);
      break;
    case "delta": {
      const b = ensureStreamBubble();
      streamText += e.text;
      b.querySelector(".msg-body").innerHTML = renderMarkdown(streamText);
      break;
    }
    case "assistant": {
      // once the full message arrives, replace the streaming bubble
      if (streamBubble) { streamBubble.remove(); endStreamBubble(); }
      for (const b of e.blocks) {
        if (b.t === "text") {
          const div = document.createElement("div");
          div.className = "msg assistant";
          div.innerHTML = `<div class="msg-head"><span class="who-assistant">Claude</span></div>` +
                          `<div class="msg-body">${renderMarkdown(b.text)}</div>`;
          t.appendChild(div);
        } else if (b.t === "thinking") {
          t.appendChild(renderThinking(b.text));
        }
      }
      break;
    }
    case "tool_use": {
      if (streamBubble) { endStreamBubble(); }
      t.appendChild(renderToolUse({ ...e, result: null }));
      break;
    }
    case "tool_result": {
      const el = t.querySelector(`details.tool[data-tool-id="${CSS.escape(e.id)}"]`);
      if (el) {
        if (e.isError) el.classList.add("err");
        el.insertAdjacentHTML("beforeend",
          `<div class="result-label">${e.isError ? "❌ Error" : "Result"}</div>` +
          `<div class="code-box">${escapeHtml(e.text || "")}</div>`);
      }
      break;
    }
    case "permission_request":
      showPermissionModal(e);
      break;
    case "result": {
      if (streamBubble) { streamBubble.remove(); endStreamBubble(); }
      state.wsBusy = false;
      state.liveSessionId = e.sessionId || state.liveSessionId;
      setChatStatus("Done — send another message anytime", "on");
      if (e.costUsd != null) {
        $("chat-cost").textContent =
          `$${e.costUsd.toFixed(4)} · ${e.numTurns ?? "?"} turns · ${((e.durationMs ?? 0) / 1000).toFixed(1)}s`;
      }
      loadProjects();  // a new JSONL has appeared, refresh the list
      if (state.currentProject) selectProject(state.currentProject);
      break;
    }
    case "error": {
      const div = document.createElement("div");
      div.className = "msg assistant error";
      div.innerHTML = `<div class="msg-head"><span class="who-assistant">Error</span></div>` +
                      `<div class="msg-body">${escapeHtml(e.message || "")}</div>`;
      t.appendChild(div);
      state.wsBusy = false;
      setChatStatus("Error", "on");
      break;
    }
  }
  if (nearBottom) t.scrollTop = t.scrollHeight;
}

function sendUserMessage() {
  const input = $("chat-input");
  const text = input.value.trim();
  if (!text || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: "user", text }));
  input.value = "";
  const t = $("transcript");
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="msg-head"><span class="who-user">You</span></div>` +
                  `<div class="msg-body">${renderMarkdown(text)}</div>`;
  t.appendChild(div);
  t.scrollTop = t.scrollHeight;
  state.wsBusy = true;
  setChatStatus("Claude is working…", "busy");
  $("chat-cost").textContent = "";
}

function disconnectChat() {
  if (state.ws) { try { state.ws.close(); } catch (_) {} }
  state.ws = null;
  state.wsBusy = false;
  endStreamBubble();
  $("chat-bar").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// permission modal

let permQueue = [];
let permActive = null;

function showPermissionModal(e) {
  permQueue.push(e);
  pumpPermission();
}

function pumpPermission() {
  if (permActive || permQueue.length === 0) return;
  permActive = permQueue.shift();
  $("perm-tool-name").textContent = permActive.tool;
  $("perm-tool-input").textContent = permActive.input || "";
  $("modal-permission").classList.remove("hidden");
}

function answerPermission(allow) {
  if (!permActive) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: "permission_response",
      requestId: permActive.requestId,
      allow,
    }));
  }
  permActive = null;
  $("modal-permission").classList.add("hidden");
  pumpPermission();
}

// ---------------------------------------------------------------------------
// wiring

$("btn-refresh").onclick = () => {
  loadProjects();
  if (state.currentProject) selectProject(state.currentProject);
};
$("session-filter").oninput = renderSessionList;

$("btn-send").onclick = sendUserMessage;
$("chat-input").addEventListener("keydown", (ev) => {
  if (skillMenuOpen()) {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      skillMenuIdx = (skillMenuIdx + 1) % skillMenuItems.length;
      renderSkillMenu();
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      skillMenuIdx = (skillMenuIdx - 1 + skillMenuItems.length) % skillMenuItems.length;
      renderSkillMenu();
      return;
    }
    if (ev.key === "Enter") { ev.preventDefault(); acceptSkill(skillMenuIdx, true); return; }
    if (ev.key === "Tab") { ev.preventDefault(); acceptSkill(skillMenuIdx, false); return; }
    if (ev.key === "Escape") { ev.preventDefault(); hideSkillMenu(); return; }
  }
  if (ev.key === "Enter") {
    const sendOnEnter = prefs.sendKey === "enter" && !ev.shiftKey;
    if (sendOnEnter || ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      sendUserMessage();
    }
  }
});
$("chat-input").addEventListener("input", updateSkillMenu);
$("chat-input").addEventListener("blur", () => setTimeout(hideSkillMenu, 120));
$("btn-interrupt").onclick = () => {
  if (state.ws) state.ws.send(JSON.stringify({ type: "interrupt" }));
};
$("btn-disconnect").onclick = disconnectChat;

// new session
$("btn-new-session").onclick = () => {
  const def = (state.currentSession && state.currentSession.cwd) ||
              prefs.defaultCwd ||
              (state.projects[0] && state.projects[0].path) || "";
  if (def) $("new-cwd").value = def;
  $("modal-new").classList.remove("hidden");
  $("new-cwd").focus();
};
$("btn-new-cancel").onclick = () => $("modal-new").classList.add("hidden");
$("btn-new-start").onclick = () => {
  const cwd = $("new-cwd").value.trim();
  if (!cwd) { $("new-cwd").focus(); return; }
  $("modal-new").classList.add("hidden");
  state.currentSession = null;
  renderSessionList();
  $("session-title").textContent = `New session — ${cwd}`;
  $("session-meta").innerHTML = "";
  $("session-stats").innerHTML = "";
  $("transcript").innerHTML = "";
  $("btn-resume").disabled = true;
  const model = $("new-model").value.trim();
  openChat({
    type: "start",
    cwd,
    permissionMode: $("new-permission-mode").value,
    ...(model ? { model } : {}),
    ...(prefs.cliPath ? { cliPath: prefs.cliPath } : {}),
  });
  $("chat-input").focus();
};

// resume
function showResumeModal(s) {
  if (!s) return;
  state.currentSession = s;
  $("resume-info").textContent = `${s.title || s.sessionId} @ ${s.cwd}`;
  $("modal-resume").classList.remove("hidden");
}
$("btn-resume").onclick = () => showResumeModal(state.currentSession);
$("btn-resume-cancel").onclick = () => $("modal-resume").classList.add("hidden");
$("btn-resume-start").onclick = () => {
  const s = state.currentSession;
  if (!s) return;
  $("modal-resume").classList.add("hidden");
  const model = $("resume-model").value.trim();
  openChat({
    type: "start",
    cwd: s.cwd,
    resume: s.sessionId,
    permissionMode: $("resume-permission-mode").value,
    ...(model ? { model } : {}),
    ...(prefs.cliPath ? { cliPath: prefs.cliPath } : {}),
  });
  $("chat-input").focus();
};

$("btn-perm-allow").onclick = () => answerPermission(true);
$("btn-perm-deny").onclick = () => answerPermission(false);

// ---------------------------------------------------------------------------
// toast

function toast(msg, isError) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isError ? "err show" : "show";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ""; }, 3200);
}

// ---------------------------------------------------------------------------
// generic input / confirm modals (promise-based)

let inputResolve = null;
function openInputModal({ title, label, value = "", placeholder = "", okLabel = "OK" }) {
  return new Promise((resolve) => {
    inputResolve = resolve;
    $("input-title").textContent = title;
    $("input-label").textContent = label;
    const f = $("input-field");
    f.value = value;
    f.placeholder = placeholder;
    $("btn-input-ok").textContent = okLabel;
    $("modal-input").classList.remove("hidden");
    setTimeout(() => { f.focus(); f.select(); }, 0);
  });
}
function closeInputModal(val) {
  $("modal-input").classList.add("hidden");
  const r = inputResolve;
  inputResolve = null;
  if (r) r(val);
}
$("btn-input-cancel").onclick = () => closeInputModal(null);
$("btn-input-ok").onclick = () => closeInputModal($("input-field").value);
$("input-field").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); closeInputModal($("input-field").value); }
  else if (ev.key === "Escape") closeInputModal(null);
});

let confirmResolve = null;
function openConfirm({ title, body, okLabel = "Delete" }) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body;
    $("btn-confirm-ok").textContent = okLabel;
    $("modal-confirm").classList.remove("hidden");
  });
}
function closeConfirm(val) {
  $("modal-confirm").classList.add("hidden");
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(val);
}
$("btn-confirm-cancel").onclick = () => closeConfirm(false);
$("btn-confirm-ok").onclick = () => closeConfirm(true);

// ---------------------------------------------------------------------------
// session action menu + operations

let menuTarget = null;

function openSessionMenu(ev, s) {
  menuTarget = s;
  const menu = $("session-menu");
  menu.classList.remove("hidden");
  let x = ev.clientX;
  let y = ev.clientY;
  if (x + 176 > window.innerWidth) x = window.innerWidth - 182;
  if (y + menu.offsetHeight + 8 > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 8;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
}
function closeSessionMenu() {
  $("session-menu").classList.add("hidden");
  menuTarget = null;
}
document.addEventListener("click", (ev) => {
  const menu = $("session-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(ev.target)) closeSessionMenu();
});
$("session-menu").querySelectorAll("button").forEach((btn) => {
  btn.onclick = async (ev) => {
    ev.stopPropagation();
    const act = btn.dataset.act;
    const s = menuTarget;
    closeSessionMenu();
    if (!s) return;
    if (act === "rename") doRename(s);
    else if (act === "fork") doFork(s);
    else if (act === "tag") doTag(s);
    else if (act === "resume") showResumeModal(s);
    else if (act === "delete") doDelete(s);
  };
});

function sessBase(s) {
  return `/api/projects/${encodeURIComponent(s.projectId)}/sessions/${encodeURIComponent(s.sessionId)}`;
}
async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}
async function apiDelete(path) {
  const res = await fetch(path, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

async function refreshCurrentList() {
  if (state.inSearch) { runSearch(); }
  if (state.currentProject) {
    state.sessions = await api(`/api/projects/${encodeURIComponent(state.currentProject)}/sessions`);
    renderSessionList();
  }
}

async function doRename(s) {
  const title = await openInputModal({
    title: "Rename session", label: "New title",
    value: s.title || "", okLabel: "Rename",
  });
  if (title == null || !title.trim()) return;
  try {
    await apiPost(sessBase(s) + "/rename", { title: title.trim() });
    await refreshCurrentList();
    if (state.currentSession && state.currentSession.sessionId === s.sessionId) {
      state.currentSession.title = title.trim();
      $("session-title").textContent = title.trim();
    }
    toast("Renamed");
  } catch (e) { toast("Rename failed: " + e.message, true); }
}

async function doTag(s) {
  const tag = await openInputModal({
    title: "Set tag", label: "Tag (leave empty to clear)",
    value: s.tag || "", placeholder: "e.g. review, wip, keep", okLabel: "Set",
  });
  if (tag == null) return;
  try {
    await apiPost(sessBase(s) + "/tag", { tag: tag.trim() });
    await refreshCurrentList();
    toast(tag.trim() ? "Tag set" : "Tag cleared");
  } catch (e) { toast("Tag failed: " + e.message, true); }
}

async function doFork(s) {
  try {
    const res = await apiPost(sessBase(s) + "/fork",
      { title: s.title ? s.title + " (fork)" : null });
    state.currentProject = s.projectId;
    const list = await api(`/api/projects/${encodeURIComponent(s.projectId)}/sessions`);
    state.sessions = list;
    renderSessionList();
    const nu = list.find((x) => x.sessionId === res.newSessionId);
    if (nu) selectSession(nu);
    toast("Forked into a new session");
  } catch (e) { toast("Fork failed: " + e.message, true); }
}

async function doDelete(s) {
  const ok = await openConfirm({
    title: "Delete session",
    body: `Permanently remove "${s.title || s.sessionId}"? The session JSONL will be deleted and cannot be recovered.`,
  });
  if (!ok) return;
  try {
    await apiDelete(sessBase(s));
    if (state.currentSession && state.currentSession.sessionId === s.sessionId) {
      state.currentSession = null;
      disconnectChat();
      $("session-title").textContent = "Select a session";
      $("session-meta").innerHTML = "";
      $("session-stats").innerHTML = "";
      $("transcript").innerHTML = '<div class="empty-state"><p>Session deleted.</p></div>';
      $("btn-resume").disabled = true;
    }
    await refreshCurrentList();
    loadProjects();
    toast("Deleted");
  } catch (e) { toast("Delete failed: " + e.message, true); }
}

// ---------------------------------------------------------------------------
// global full-text search

let searchTimer = null;
$("global-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("global-search").value.trim();
  if (q.length < 2) { exitSearch(); return; }
  searchTimer = setTimeout(runSearch, 220);
});
$("global-search").addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") { $("global-search").value = ""; exitSearch(); }
});
$("btn-search-clear").onclick = () => { $("global-search").value = ""; exitSearch(); };

async function runSearch() {
  const q = $("global-search").value.trim();
  if (q.length < 2) { exitSearch(); return; }
  state.inSearch = true;
  $("browse-pane").classList.add("hidden");
  $("search-pane").classList.remove("hidden");
  $("search-count").textContent = "Searching…";
  try {
    const results = await api(`/api/search?q=${encodeURIComponent(q)}&limit=80`);
    renderSearchResults(results, q);
  } catch (e) {
    $("search-count").textContent = "Search error";
    toast("Search failed: " + e.message, true);
  }
}

function exitSearch() {
  state.inSearch = false;
  $("search-pane").classList.add("hidden");
  $("browse-pane").classList.remove("hidden");
}

function renderSearchResults(results, q) {
  $("search-count").textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
  const el = $("search-results");
  el.innerHTML = "";
  if (results.length === 0) {
    el.innerHTML = '<div class="empty-state" style="margin-top:20%"><p>No matches.</p></div>';
    return;
  }
  for (const s of results) {
    const div = document.createElement("div");
    div.className = "search-result";
    div.innerHTML =
      `<div class="sr-title">${escapeHtml(s.title || "(untitled)")}</div>` +
      `<div class="sr-proj">${escapeHtml(s.cwd || s.projectId)} · ${timeAgo(s.lastTs)}` +
      ` · ${s.matchCount} hit${s.matchCount === 1 ? "" : "s"}</div>` +
      `<div class="sr-snip">${highlight(s.snippet || "", q)}</div>`;
    div.onclick = () => {
      state.currentProject = s.projectId;
      selectSession(s);
    };
    el.appendChild(div);
  }
}

function highlight(text, q) {
  const esc = escapeHtml(text);
  if (!q) return esc;
  const qq = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return esc.replace(new RegExp("(" + qq + ")", "gi"), "<mark>$1</mark>");
}

// ---------------------------------------------------------------------------
// auto-refresh: poll a lightweight state signature and refresh the sidebar
// when the underlying JSONL files change (e.g. sessions run from the CLI).

let lastStateVersion = null;
async function pollState() {
  if (state.wsBusy) return;  // the result handler refreshes after a live turn
  try {
    const { version } = await api("/api/state");
    if (lastStateVersion === null) { lastStateVersion = version; return; }
    if (version === lastStateVersion) return;
    lastStateVersion = version;
    await loadProjects();
    if (state.inSearch) {
      runSearch();
    } else if (state.currentProject) {
      state.sessions = await api(`/api/projects/${encodeURIComponent(state.currentProject)}/sessions`);
      renderSessionList();
    }
  } catch (_) { /* transient; try again next tick */ }
}
setInterval(pollState, 4000);

// ---------------------------------------------------------------------------
// sidebar tabs + skills

function switchTab(which) {
  for (const t of ["sessions", "skills", "mcp"]) {
    $("tab-" + t).classList.toggle("active", t === which);
    $(t + "-tab").classList.toggle("hidden", t !== which);
  }
  if (which === "skills") { loadSkills(); renderSkills(); }
  if (which === "mcp") onMcpTab();
}
$("tab-sessions").onclick = () => switchTab("sessions");
$("tab-skills").onclick = () => switchTab("skills");
$("tab-mcp").onclick = () => switchTab("mcp");

// The runnable skills are the ones the current session reports as available
// (init.skills — only these resolve via /name). Descriptions are enriched
// best-effort from /api/skills (installed SKILL.md files on disk).
let skillDescMap = {};    // name -> {description, source}
let availableSkills = []; // names from the session's init event
let skillItems = [];      // merged, runnable list
let skillsLoaded = false;

async function loadSkills() {
  if (skillsLoaded) return;
  skillsLoaded = true;
  try {
    const disk = await api("/api/skills");
    skillDescMap = {};
    for (const s of disk) skillDescMap[s.name] = { description: s.description, source: s.source };
  } catch (e) { /* descriptions are best-effort */ }
  rebuildSkillItems();
}

function rebuildSkillItems() {
  skillItems = (availableSkills || []).map((name) => {
    const d = skillDescMap[name] || {};
    return { name, command: "/" + name, description: d.description || "",
             source: d.source || "session" };
  }).sort((a, b) => a.name.localeCompare(b.name));
  renderSkills();
}

function renderSkills() {
  const el = $("skills-list");
  const filter = $("skill-search").value.toLowerCase();
  el.innerHTML = "";
  if (skillItems.length === 0) {
    el.innerHTML = '<div class="skills-empty">Start or resume a session to load its ' +
                   'available skills, then type / in the message box.</div>';
    return;
  }
  const items = skillItems.filter((s) =>
    !filter || (s.command + " " + s.description).toLowerCase().includes(filter));
  if (items.length === 0) { el.innerHTML = '<div class="skills-empty">No matches.</div>'; return; }
  for (const s of items) {
    const div = document.createElement("div");
    div.className = "skill-item";
    div.title = "Run " + s.command;
    div.innerHTML =
      `<div class="sk-head"><span class="sk-name">${escapeHtml(s.command)}</span>` +
      `<span class="badge sk-src">${escapeHtml(s.source)}</span></div>` +
      (s.description ? `<div class="sk-desc">${escapeHtml(s.description)}</div>` : "");
    div.onclick = () => runSkill(s);
    el.appendChild(div);
  }
}
$("skill-search").oninput = renderSkills;

function chatLive() {
  return state.ws && state.ws.readyState === WebSocket.OPEN;
}

// Put a command into the composer (and send it) via the normal send path.
function sendCommand(cmd) {
  $("chat-input").value = cmd;
  sendUserMessage();
}

// Clicking a skill in the Skills tab: run it in the live session, or nudge the
// user to open one (the casual path is typing / in the message box).
function runSkill(skill) {
  if (chatLive()) {
    sendCommand(skill.command);
    return;
  }
  $("chat-input").value = skill.command;
  toast("Start or resume a session, then type / in the message box to run skills", true);
}

// ---------------------------------------------------------------------------
// slash-command autocomplete in the composer (type / to pick a skill)

const skillMenu = $("skill-menu");
let skillMenuItems = [];
let skillMenuIdx = -1;

function currentSlashToken() {
  const el = $("chat-input");
  const val = el.value;
  // only when the whole input is a single /token (no spaces yet)
  const m = /^\/(\S*)$/.exec(val.trim());
  return m ? "/" + m[1] : null;
}

function updateSkillMenu() {
  const token = currentSlashToken();
  if (token === null) { hideSkillMenu(); return; }
  const q = token.slice(1).toLowerCase();
  // match on the command name (what the user is typing after /), not descriptions
  const matches = skillItems
    .filter((s) => s.command.toLowerCase().includes(q))
    .sort((a, b) => {
      // prefix matches first, then alphabetical
      const ap = a.command.toLowerCase().indexOf(q);
      const bp = b.command.toLowerCase().indexOf(q);
      return ap - bp || a.command.localeCompare(b.command);
    })
    .slice(0, 12);
  if (matches.length === 0) { hideSkillMenu(); return; }
  skillMenuItems = matches;
  skillMenuIdx = 0;
  renderSkillMenu();
  skillMenu.classList.remove("hidden");
}

function renderSkillMenu() {
  skillMenu.innerHTML = "";
  skillMenuItems.forEach((s, i) => {
    const div = document.createElement("div");
    div.className = "smi" + (i === skillMenuIdx ? " active" : "");
    div.innerHTML =
      `<div><span class="smi-cmd">${escapeHtml(s.command)}</span>` +
      `<span class="badge smi-src">${escapeHtml(s.source)}</span></div>` +
      (s.description ? `<div class="smi-desc">${escapeHtml(s.description)}</div>` : "");
    div.onmousedown = (ev) => { ev.preventDefault(); acceptSkill(i, true); };
    skillMenu.appendChild(div);
  });
}

function hideSkillMenu() {
  skillMenu.classList.add("hidden");
  skillMenuItems = [];
  skillMenuIdx = -1;
}

// accept a suggestion: send=true runs it now, send=false just fills for args
function acceptSkill(idx, send) {
  const s = skillMenuItems[idx];
  if (!s) return;
  hideSkillMenu();
  if (send) {
    sendCommand(s.command);
  } else {
    $("chat-input").value = s.command + " ";
    $("chat-input").focus();
  }
}

function skillMenuOpen() {
  return !skillMenu.classList.contains("hidden") && skillMenuItems.length > 0;
}

// ---------------------------------------------------------------------------
// MCP servers

// /mcp doesn't work over the SDK session, so show what actually loaded instead.
function addMcpInfoLine(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return;
  const parts = servers.map((s) => {
    const st = s.status ? ` (${escapeHtml(s.status)})` : "";
    return `<span class="mcp-status ${escapeHtml(s.status || "unknown")}">${escapeHtml(s.name)}</span>${st}`;
  });
  const div = document.createElement("div");
  div.className = "divider mcp-info-line";
  div.innerHTML = "🔌 MCP loaded: " + parts.join(", ");
  $("transcript").appendChild(div);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

let mcpData = { global: [], local: [], project: [] };
let mcpLive = [];
let mcpLiveState = "idle"; // idle | loading | done | error

function onMcpTab() {
  if (!$("mcp-cwd").value) {
    $("mcp-cwd").value = (state.currentSession && state.currentSession.cwd) ||
                         (state.projects[0] && state.projects[0].path) || "";
  }
  loadMcp();
}

async function loadMcp() {
  const cwd = $("mcp-cwd").value.trim();
  const el = $("mcp-list");
  el.innerHTML = '<div class="mcp-empty">Loading…</div>';
  mcpLive = [];
  mcpLiveState = "idle";
  try {
    mcpData = await api("/api/mcp" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""));
    renderMcp();
    loadMcpLive();  // annotate with health + claude.ai connectors (slower)
  } catch (e) {
    el.innerHTML = '<div class="mcp-empty">Failed to load MCP config.</div>';
  }
}

async function loadMcpLive() {
  const cwd = $("mcp-cwd").value.trim();
  mcpLiveState = "loading";
  renderMcp();
  try {
    const data = await api("/api/mcp/live" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""));
    mcpLive = data.servers || [];
    mcpLiveState = "done";
  } catch (e) {
    mcpLiveState = "error";
  }
  renderMcp();
}

function renderMcp() {
  const el = $("mcp-list");
  el.innerHTML = "";
  const hasDir = !!$("mcp-cwd").value.trim();
  const statusByName = {};
  for (const s of mcpLive) statusByName[s.name] = s;
  const fileNames = new Set();

  const groups = [
    ["Global — all projects", mcpData.global, "user", true],
    ["This directory — private", mcpData.local, "local", hasDir],
    ["This directory — shared (.mcp.json)", mcpData.project, "project", hasDir],
  ];
  for (const [title, list, scope, show] of groups) {
    if (!show) continue;
    const head = document.createElement("div");
    head.className = "mcp-group-head";
    head.textContent = title;
    el.appendChild(head);
    if (!list || list.length === 0) {
      const e = document.createElement("div");
      e.className = "mcp-empty";
      e.textContent = "No servers.";
      el.appendChild(e);
    } else {
      for (const s of list) {
        fileNames.add(s.name);
        el.appendChild(mcpRow(s, statusByName[s.name], true));
      }
    }
  }

  // servers `claude mcp list` reports that aren't in local files (claude.ai connectors)
  const extras = mcpLive.filter((s) => !fileNames.has(s.name));
  if (extras.length) {
    const head = document.createElement("div");
    head.className = "mcp-group-head";
    head.textContent = "From claude mcp list — managed on claude.ai";
    el.appendChild(head);
    for (const s of extras) {
      el.appendChild(mcpRow({ name: s.name, target: s.target, transport: "remote" }, s, false));
    }
  }

  if (mcpLiveState === "loading") {
    const n = document.createElement("div");
    n.className = "mcp-empty";
    n.textContent = "Checking status via claude mcp list…";
    el.appendChild(n);
  } else if (mcpLiveState === "error") {
    const n = document.createElement("div");
    n.className = "mcp-empty";
    n.textContent = "Could not run claude mcp list.";
    el.appendChild(n);
  }
}

const MCP_STATUS_LABEL = {
  connected: "● connected", "needs-auth": "● needs auth",
  failed: "● failed", unknown: "● unknown",
};

function mcpRow(s, live, removable) {
  const div = document.createElement("div");
  div.className = "mcp-item";
  const keys = [];
  if (s.env && s.env.length) keys.push("env: " + s.env.join(", "));
  if (s.headers && s.headers.length) keys.push("headers: " + s.headers.join(", "));
  let status = "";
  if (live) {
    status = ` <span class="mcp-status ${live.status}" title="${escapeHtml(live.statusText || "")}">` +
             `${escapeHtml(MCP_STATUS_LABEL[live.status] || live.status)}</span>`;
  }
  div.innerHTML =
    `<div class="mcp-main"><div class="mcp-name">${escapeHtml(s.name)} ` +
    `<span class="badge">${escapeHtml(s.transport || "remote")}</span>${status}</div>` +
    `<div class="mcp-target">${escapeHtml(s.target || "")}</div>` +
    (keys.length ? `<div class="mcp-keys">${escapeHtml(keys.join(" · "))}</div>` : "") +
    "</div>" +
    (removable ? "<button class=\"mcp-del\" title=\"Remove\">✕</button>" : "");
  if (removable) div.querySelector(".mcp-del").onclick = () => removeMcp(s);
  return div;
}

async function removeMcp(s) {
  const ok = await openConfirm({
    title: "Remove MCP server",
    body: `Remove "${s.name}" from ${s.scope} scope?`,
    okLabel: "Remove",
  });
  if (!ok) return;
  try {
    await apiPost("/api/mcp/remove", { name: s.name, scope: s.scope, cwd: $("mcp-cwd").value.trim() });
    toast(`Removed ${s.name}`);
    loadMcp();
  } catch (e) { toast("Remove failed: " + e.message, true); }
}

function mcpToggleFields() {
  const stdio = $("mcp-transport").value === "stdio";
  $("mcp-stdio-fields").classList.toggle("hidden", !stdio);
  $("mcp-http-fields").classList.toggle("hidden", stdio);
  $("mcp-cwd-row").classList.toggle("hidden", $("mcp-scope").value === "user");
}
$("mcp-transport").onchange = mcpToggleFields;
$("mcp-scope").onchange = mcpToggleFields;
$("btn-mcp-load").onclick = loadMcp;
$("mcp-cwd").addEventListener("keydown", (ev) => { if (ev.key === "Enter") loadMcp(); });

$("btn-new-mcp").onclick = () => {
  for (const id of ["mcp-name", "mcp-command", "mcp-args", "mcp-env", "mcp-url", "mcp-headers"]) {
    $(id).value = "";
  }
  $("mcp-scope").value = "user";
  $("mcp-transport").value = "stdio";
  $("mcp-modal-cwd").value = $("mcp-cwd").value.trim();
  mcpToggleFields();
  $("modal-mcp").classList.remove("hidden");
  $("mcp-name").focus();
};
$("btn-mcp-cancel").onclick = () => $("modal-mcp").classList.add("hidden");

// authenticate (OAuth) an MCP server by opening a real terminal for /mcp
$("btn-mcp-auth").onclick = () => {
  $("mcp-auth-cwd").value = $("mcp-cwd").value.trim();
  $("modal-mcp-auth").classList.remove("hidden");
};
$("btn-mcp-auth-cancel").onclick = () => $("modal-mcp-auth").classList.add("hidden");
$("btn-mcp-auth-open").onclick = async () => {
  try {
    await apiPost("/api/mcp/auth-terminal", { cwd: $("mcp-auth-cwd").value.trim() });
    $("modal-mcp-auth").classList.add("hidden");
    toast("Terminal opened — type /mcp there, finish the login, then start a new session");
  } catch (e) {
    toast("Couldn't open terminal: " + e.message, true);
  }
};

function parseLines(text) {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}
function parseKV(text, sep) {
  const out = {};
  for (const line of parseLines(text)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
}

$("btn-mcp-create").onclick = async () => {
  const name = $("mcp-name").value.trim();
  if (!name) { $("mcp-name").focus(); return; }
  const scope = $("mcp-scope").value;
  const body = {
    name, scope,
    transport: $("mcp-transport").value,
    cwd: $("mcp-modal-cwd").value.trim(),
    command: $("mcp-command").value.trim(),
    args: parseLines($("mcp-args").value),
    url: $("mcp-url").value.trim(),
    env: parseKV($("mcp-env").value, "="),
    headers: parseKV($("mcp-headers").value, ":"),
  };
  try {
    await apiPost("/api/mcp", body);
    $("modal-mcp").classList.add("hidden");
    if (scope !== "user" && body.cwd) $("mcp-cwd").value = body.cwd;
    toast(`Added ${name} — start a new session to use it`);
    loadMcp();
  } catch (e) { toast("Add failed: " + e.message, true); }
};

// ---------------------------------------------------------------------------
// create a personal skill

$("btn-new-skill").onclick = () => {
  $("skill-name").value = "";
  $("skill-desc").value = "";
  $("skill-body").value = "";
  $("modal-skill").classList.remove("hidden");
  $("skill-name").focus();
};
$("btn-skill-cancel").onclick = () => $("modal-skill").classList.add("hidden");
$("btn-skill-create").onclick = async () => {
  const name = $("skill-name").value.trim();
  if (!name) { $("skill-name").focus(); return; }
  try {
    const res = await apiPost("/api/skills/create", {
      name,
      description: $("skill-desc").value,
      body: $("skill-body").value,
    });
    $("modal-skill").classList.add("hidden");
    skillsLoaded = false;
    loadSkills();  // refresh the on-disk description map
    toast(`Created ${res.command} — start a new session to use it`);
  } catch (e) {
    toast("Create failed: " + e.message, true);
  }
};

// ---------------------------------------------------------------------------
// preferences (stored in localStorage, applied to the UI + session start)

const PREF_DEFAULTS = {
  model: "sonnet",
  permissionMode: "acceptEdits",
  sendKey: "ctrl-enter",
  defaultCwd: "",
  scale: "normal",
  cliPath: "",
};
let prefs = loadPrefs();

function loadPrefs() {
  try {
    return { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem("ccHomePrefs") || "{}") };
  } catch (e) {
    return { ...PREF_DEFAULTS };
  }
}

function applyPrefs() {
  $("new-model").value = prefs.model;
  $("resume-model").value = prefs.model;
  $("new-permission-mode").value = prefs.permissionMode;
  $("resume-permission-mode").value = prefs.permissionMode;
  document.body.style.zoom =
    prefs.scale === "small" ? "0.9" : prefs.scale === "large" ? "1.12" : "1";
  $("chat-input").placeholder = prefs.sendKey === "enter"
    ? "Type a message (Enter to send, Shift+Enter for newline) — type / for skills"
    : "Type a message (Ctrl+Enter to send) — type / for skills";
}

$("btn-settings").onclick = () => {
  $("set-model").value = prefs.model;
  $("set-permission").value = prefs.permissionMode;
  $("set-sendkey").value = prefs.sendKey;
  $("set-cwd").value = prefs.defaultCwd;
  $("set-scale").value = prefs.scale;
  $("set-clipath").value = prefs.cliPath;
  $("modal-settings").classList.remove("hidden");
};
$("btn-settings-cancel").onclick = () => $("modal-settings").classList.add("hidden");
$("btn-settings-save").onclick = () => {
  prefs = {
    model: $("set-model").value,
    permissionMode: $("set-permission").value,
    sendKey: $("set-sendkey").value,
    defaultCwd: $("set-cwd").value.trim(),
    scale: $("set-scale").value,
    cliPath: $("set-clipath").value.trim(),
  };
  localStorage.setItem("ccHomePrefs", JSON.stringify(prefs));
  applyPrefs();
  $("modal-settings").classList.add("hidden");
  toast("Settings saved");
};

// init
applyPrefs();
if (!skillsLoaded) loadSkills();  // preload so / autocomplete works right away
loadProjects().then(() => {
  if (state.projects.length > 0) selectProject(state.projects[0].projectId);
});
