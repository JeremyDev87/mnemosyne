import { useEffect, useState, type FormEvent } from "react";
import { BookOpenText, CalendarDays, CheckCircle2, Inbox, Search, ShieldCheck } from "lucide-react";
import type { DocumentResult, HealthResult, PersonalOpsResult, SearchResult } from "../electron/contracts";

const EMPTY_HEALTH: HealthResult = { status: "unavailable", snapshotState: "unavailable", documentCount: 0, message: "Local Wiki 확인 중" };

export function App() {
  const [health, setHealth] = useState<HealthResult>(EMPTY_HEALTH);
  const [ops, setOps] = useState<PersonalOpsResult | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [document, setDocument] = useState<DocumentResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([window.mnemosyne.health(), window.mnemosyne.personalOps()]).then(([healthResult, opsResult]) => {
      if (!active) return;
      if (healthResult.status === "fulfilled") setHealth(healthResult.value);
      if (opsResult.status === "fulfilled") setOps(opsResult.value);
    });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDocument(null);
    try {
      setResults(await window.mnemosyne.search({ query, limit: 10 }));
    } catch {
      setResults(null);
      setError("검색을 완료하지 못했습니다. 로컬 Wiki 상태를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function openDocument(documentId: string) {
    setBusy(true);
    setError(null);
    try {
      setDocument(await window.mnemosyne.getDocument({ documentId }));
    } catch {
      setError("검증된 문서 bytes를 읽지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Mnemosyne 탐색">
        <div className="brand"><span className="brand-mark">M</span><div><strong>Mnemosyne</strong><small>Local Personal Ops</small></div></div>
        <nav>
          <a className="nav-item active" href="#dashboard"><ShieldCheck aria-hidden="true" />대시보드</a>
          <a className="nav-item" href="#search"><Search aria-hidden="true" />Wiki 검색</a>
          <a className="nav-item" href="#document"><BookOpenText aria-hidden="true" />문서</a>
        </nav>
        <div className={`status-card ${health.status}`}>
          <span className="status-dot" aria-hidden="true" />
          <div><strong>{health.status === "ok" ? "Local Wiki 연결됨" : "Local Wiki 확인 필요"}</strong><small>{health.documentCount.toLocaleString()}개 검증 문서</small></div>
        </div>
      </aside>

      <main className="workspace" id="dashboard">
        <header className="topbar"><div><p className="eyebrow">PRIVATE · READ ONLY</p><h1>오늘의 운영 상태</h1></div><span className="security-pill"><ShieldCheck aria-hidden="true" />검증된 snapshot</span></header>

        <section className="ops-grid" aria-label="Personal Ops 요약">
          <article><CheckCircle2 aria-hidden="true" /><div><span>할 일</span><strong>{ops?.tasks.total ?? "—"}</strong><small>{ops ? Object.entries(ops.tasks.byStatus).map(([key, value]) => `${key} ${value}`).join(" · ") || "항목 없음" : "확인 중"}</small></div></article>
          <article><CalendarDays aria-hidden="true" /><div><span>일정</span><strong>{ops?.schedule.total ?? "—"}</strong><small>{ops ? Object.entries(ops.schedule.byStatus).map(([key, value]) => `${key} ${value}`).join(" · ") || "항목 없음" : "확인 중"}</small></div></article>
          <article><Inbox aria-hidden="true" /><div><span>Inbox</span><strong>{ops?.inbox.open ?? "—"}</strong><small>{ops ? `전체 ${ops.inbox.total} · 확인 필요 ${ops.issueCount}` : "확인 중"}</small></div></article>
        </section>

        <section className="search-panel" id="search">
          <div className="section-heading"><div><p className="eyebrow">AUTHORITY-AWARE SEARCH</p><h2>Wiki 검색</h2></div><span>{health.snapshotState}</span></div>
          <form onSubmit={submit} className="search-form">
            <label className="sr-only" htmlFor="wiki-query">Wiki 검색어</label>
            <Search aria-hidden="true" />
            <input id="wiki-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="일정, 프로젝트, 결정 사항을 검색하세요" maxLength={200} required />
            <button type="submit" disabled={busy || !query.trim()}>{busy ? "검색 중" : "검색"}</button>
          </form>
          {error && <p className="error" role="alert">{error}</p>}
          {results && <div className="result-list" aria-live="polite">
            {results.hits.length === 0 ? <p className="empty">검증된 결과가 없습니다.</p> : results.hits.map((hit) => (
              <button type="button" key={hit.documentId} onClick={() => void openDocument(hit.documentId)}>
                <span className="authority">{hit.authority}</span><span className="result-copy"><strong>{hit.title}</strong><small className="excerpt">{hit.excerpt || "본문 미리보기가 없습니다."}</small></span><small>{hit.domain ?? "Wiki"}</small>
              </button>
            ))}
          </div>}
        </section>

        <section className="document-panel" id="document" aria-live="polite">
          {document ? <><div className="section-heading"><div><p className="eyebrow">VERIFIED DOCUMENT</p><h2>{document.title}</h2></div><span>{document.authority}</span></div><pre>{document.body}</pre></> : <div className="document-empty"><BookOpenText aria-hidden="true" /><h2>문서를 선택하세요</h2><p>검색 결과의 opaque capability를 통해 검증된 Markdown만 표시합니다.</p></div>}
        </section>
      </main>
    </div>
  );
}
