const content = document.querySelector("#content");
const localHeaders = location.hostname === "127.0.0.1" || location.hostname === "localhost"
  ? { "x-mnemosyne-test-user": "local@mnemosyne.invalid" }
  : {};

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...localHeaders, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({ error: "응답을 읽을 수 없습니다." }));
  if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload });
  return payload;
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

/** Escape untrusted wiki text, then restore only FTS highlight markers. */
function formatExcerpt(value = "") {
  const withPlaceholders = String(value)
    .replace(/<\/?mark>/gi, (tag) => (tag.toLowerCase() === "<mark>" ? "\u0000MARK_OPEN\u0000" : tag.toLowerCase() === "</mark>" ? "\u0000MARK_CLOSE\u0000" : tag));
  return escapeHtml(withPlaceholders)
    .replaceAll("\u0000MARK_OPEN\u0000", "<mark>")
    .replaceAll("\u0000MARK_CLOSE\u0000", "</mark>");
}

function setActiveNav() {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const href = link.getAttribute("href");
    link.toggleAttribute("aria-current", href === location.pathname || (href === "/" && location.pathname === ""));
  });
}

function errorPanel(error, retry) {
  content.innerHTML = `<section class="state-panel"><span class="eyebrow">확인 필요</span><h1>정보를 불러오지 못했습니다.</h1><p>${escapeHtml(error.message)}</p><button class="button" id="retry">다시 시도</button></section>`;
  document.querySelector("#retry")?.addEventListener("click", retry);
}

function count(summary, status) { return summary.tasks.byStatus[status] || 0; }

async function renderDashboard() {
  content.innerHTML = `<div class="loading" role="status">운영 상태를 컴파일하는 중…</div>`;
  try {
    const summary = await api("/api/ops/summary");
    const active = summary.tasks.rows.filter((row) => ["todo", "doing", "blocked", "waiting"].includes(row["상태"]));
    const upcoming = summary.schedule.rows.filter((row) => !["done", "cancelled"].includes(row["상태"]));
    content.innerHTML = `
      <header class="page-header"><div><span class="eyebrow">Personal operations control plane</span><h1>오늘의 운영 상태</h1><p>지식의 근거와 실행 상태를 한 화면에서 확인합니다.</p></div><time>${new Intl.DateTimeFormat("ko-KR", { dateStyle: "full" }).format(new Date())}</time></header>
      <section class="metric-grid" aria-label="핵심 지표">
        <article class="metric"><small>열린 할 일</small><strong>${count(summary, "todo") + count(summary, "doing") + count(summary, "blocked") + count(summary, "waiting")}</strong><span>${count(summary, "doing")} doing · ${count(summary, "blocked")} blocked</span></article>
        <article class="metric"><small>예정 일정</small><strong>${upcoming.length}</strong><span>확정·잠정 일정</span></article>
        <article class="metric"><small>Inbox</small><strong>${summary.inbox.open}</strong><span>분류 대기</span></article>
        <article class="metric ${summary.issues.length ? "metric-alert" : ""}"><small>확인 필요</small><strong>${summary.issues.length}</strong><span>정합성 규칙 결과</span></article>
      </section>
      <div class="split-grid">
        <section class="panel"><div class="panel-heading"><div><span class="eyebrow">Action ledger</span><h2>진행할 일</h2></div><a href="/ops" data-nav>편집 열기 →</a></div>
          <div class="ledger">${active.length ? active.slice(0, 8).map((row) => `<article><span class="scope">${escapeHtml(row.Scope)}</span><div><h3>${escapeHtml(row["할일"])}</h3><p>${escapeHtml(row["다음 액션"] || "다음 액션 확인 필요")}</p></div><span class="pill pill-${escapeHtml(row["상태"])}">${escapeHtml(row["상태"])}</span></article>`).join("") : `<p class="empty">열린 할 일이 없습니다.</p>`}</div>
        </section>
        <aside class="panel signal-panel"><span class="eyebrow">Integrity signals</span><h2>확인 필요</h2>${summary.issues.length ? `<ul>${summary.issues.slice(0, 6).map((issue) => `<li><strong>${escapeHtml(issue.code)}</strong><span>${escapeHtml(issue.detail)}</span></li>`).join("")}</ul>` : `<p class="empty">정합성 경고가 없습니다.</p>`}</aside>
      </div>`;
    bindNavigation();
  } catch (error) { errorPanel(error, renderDashboard); }
}

async function renderWiki() {
  content.innerHTML = `
    <header class="page-header"><div><span class="eyebrow">Authority-aware retrieval</span><h1>Wiki 탐색</h1><p>검색 순위가 아니라 Brain authority와 canonical source를 함께 봅니다.</p></div></header>
    <section class="search-panel"><form id="search-form"><label for="wiki-query">Wiki 검색어</label><div class="search-row"><input id="wiki-query" name="q" type="search" autocomplete="off" placeholder="예: 주간 계획, Personal Ops" required /><button class="button" type="submit">검색</button></div></form><div id="search-results" aria-live="polite"><p class="empty">질문이나 키워드를 입력해 주세요.</p></div></section>`;
  document.querySelector("#search-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("q");
    const target = document.querySelector("#search-results");
    target.innerHTML = `<div class="loading" role="status">근거를 찾는 중…</div>`;
    try {
      const payload = await api("/api/wiki/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
      target.innerHTML = payload.results.length ? `<div class="result-list">${payload.results.map((result) => `<article><div class="result-meta"><span class="authority authority-${escapeHtml(result.authorityKind)}">${escapeHtml(result.authorityKind)}</span><code>${escapeHtml(result.path)}</code></div><h2>${escapeHtml(result.title)}</h2><p>${formatExcerpt(result.excerpt) || "본문 미리보기 없음"}</p>${result.answerableAsCurrent ? "" : `<small>현재 진실로 직접 답변할 수 없는 evidence/alias입니다.</small>`}</article>`).join("")}</div>` : `<p class="empty">일치하는 문서가 없습니다. 다른 표현으로 검색해 주세요.</p>`;
    } catch (error) { target.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`; }
  });
}

const paths = {
  tasks: "brain/P6_prefrontal/personal-ops/tasks.md",
  schedule: "domains/personal-ops/schedule.md",
  inbox: "domains/personal-ops/inbox.md"
};
let editorDocument = null;

async function loadEditor(key) {
  const status = document.querySelector("#editor-status");
  status.textContent = "문서를 불러오는 중…";
  try {
    editorDocument = await api(`/api/ops/doc?path=${encodeURIComponent(paths[key])}`);
    document.querySelector("#markdown-editor").value = editorDocument.content;
    document.querySelector("#diff-output").textContent = "변경 전 검증이 필요합니다.";
    document.querySelector("#save-button").disabled = true;
    status.textContent = `ETag ${editorDocument.etag.slice(0, 12)} · shadow source`;
  } catch (error) { status.textContent = error.message; }
}

async function renderOps() {
  let health = { writes: false };
  try { health = await api("/api/health"); } catch { /* rendered below */ }
  content.innerHTML = `
    <header class="page-header"><div><span class="eyebrow">Guarded write surface</span><h1>Personal Ops 편집</h1><p>허용된 세 ledger만 diff·규칙·ETag 검증 후 저장합니다.</p></div><span class="mode-badge">${health.writes ? "Write enabled" : "Shadow · read only"}</span></header>
    <section class="editor-layout"><div class="editor-main"><label for="document-select">편집 문서</label><select id="document-select"><option value="tasks">Tasks</option><option value="schedule">Schedule</option><option value="inbox">Inbox</option></select><p id="editor-status" class="microcopy"></p><label for="markdown-editor">Markdown 편집기</label><textarea id="markdown-editor" spellcheck="false"></textarea><div class="action-row"><button class="button button-secondary" id="validate-button">변경 검증</button><button class="button" id="save-button" ${health.writes ? "disabled" : "disabled title='Write gate가 비활성화되어 있습니다.'"}>저장</button></div></div><aside class="diff-panel"><span class="eyebrow">Proposed patch</span><h2>변경 검증</h2><pre id="diff-output">문서를 불러오는 중…</pre></aside></section>`;
  document.querySelector("#document-select")?.addEventListener("change", (event) => loadEditor(event.target.value));
  document.querySelector("#validate-button")?.addEventListener("click", async () => {
    if (!editorDocument) return;
    const editor = document.querySelector("#markdown-editor");
    const output = document.querySelector("#diff-output");
    try {
      const payload = await api("/api/ops/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: editorDocument.path, content: editor.value, baseEtag: editorDocument.etag }) });
      if (!payload.changed) output.textContent = "변경 사항이 없습니다.";
      else if (!payload.validation.valid) output.textContent = payload.validation.errors.map((error) => `[${error.code}] ${error.message}`).join("\n");
      else output.textContent = payload.patch;
      document.querySelector("#save-button").disabled = !health.writes || !payload.changed || !payload.validation.valid;
    } catch (error) { output.textContent = error.message; }
  });
  document.querySelector("#save-button")?.addEventListener("click", async () => {
    if (!editorDocument || !health.writes) return;
    const editor = document.querySelector("#markdown-editor");
    const result = await api("/api/ops/doc", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: editorDocument.path, content: editor.value, baseEtag: editorDocument.etag }) });
    document.querySelector("#diff-output").textContent = result.state === "saved" ? `저장 완료 · ${result.changeId}` : `저장 완료 · index pending · ${result.changeId}`;
    await loadEditor(document.querySelector("#document-select").value);
  });
  await loadEditor("tasks");
}

const routes = { "/": renderDashboard, "/wiki": renderWiki, "/ops": renderOps };
async function render() { setActiveNav(); await (routes[location.pathname] || renderDashboard)(); content.focus({ preventScroll: true }); }
function bindNavigation() {
  document.querySelectorAll("[data-nav]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); history.pushState({}, "", link.getAttribute("href")); render(); }));
}
window.addEventListener("popstate", render);
bindNavigation();
render();
