import Link from "next/link";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-5 py-6 sm:px-8">
      <header className="flex items-center justify-between border-b border-line pb-5">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-foreground text-sm font-bold text-white">M</span>
          <span className="font-semibold tracking-tight">Mnemosyne</span>
        </div>
        <Badge className="bg-teal-soft text-teal"><LockKeyhole className="mr-1.5 size-3.5" /> private preview</Badge>
      </header>
      <section className="grid flex-1 items-center gap-12 py-16 md:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="mb-5 text-sm font-semibold uppercase tracking-[0.18em] text-teal">Personal operations ledger</p>
          <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-[-0.04em] sm:text-6xl">기억을 저장하는 대신, 흐름을 안전하게 이어갑니다.</h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-muted">Mnemosyne은 개인 Wiki와 업무 상태를 소유자 전용으로 조회하는 privacy-first operating surface입니다.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link className="inline-flex min-h-10 items-center justify-center rounded-md bg-teal px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-teal/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2" href="/login">소유자 로그인 <ArrowRight className="ml-2 size-4" /></Link>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-sm">
          <div className="flex items-center justify-between border-b border-line pb-4">
            <span className="text-sm font-semibold">운영 상태</span>
            <Badge className="bg-teal-soft text-teal">synthetic</Badge>
          </div>
          <div className="space-y-5 pt-5">
            <div className="flex gap-3"><ShieldCheck className="mt-0.5 size-5 text-teal" /><div><p className="text-sm font-semibold">데이터 경계가 기본 거부입니다</p><p className="mt-1 text-sm leading-6 text-muted">인증·snapshot·sync 계약이 연결되기 전에는 실제 개인 데이터가 렌더링되지 않습니다.</p></div></div>
            <div className="rounded-lg bg-teal-soft/60 p-4 text-sm leading-6 text-foreground">현재 화면은 실제 Wiki를 읽지 않는 synthetic shell입니다.</div>
          </div>
        </div>
      </section>
    </main>
  );
}
