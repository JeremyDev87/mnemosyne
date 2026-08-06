import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <section className="w-full max-w-md rounded-2xl border border-line bg-surface p-7 shadow-sm">
        <div className="mb-8 flex items-center gap-3"><span className="grid size-9 place-items-center rounded-lg bg-foreground text-sm font-bold text-white">M</span><span className="font-semibold">Mnemosyne</span></div>
        <h1 className="text-2xl font-semibold tracking-tight">소유자 로그인</h1>
        <p className="mt-3 text-sm leading-6 text-muted">보호된 개인 운영 데이터는 허용된 GitHub account ID에만 열립니다.</p>
        <Alert className="mt-6 bg-amber-soft/60 text-sm leading-6"><strong>준비 중</strong><br />OAuth provider와 외부 account 설정은 별도 승인 lane입니다. 현재는 실제 로그인 요청을 보내지 않습니다.</Alert>
        <Button className="mt-6 w-full" disabled><LockKeyhole className="mr-2 size-4" /> GitHub로 계속하기</Button>
        <Link className="mt-5 block text-center text-sm text-muted underline underline-offset-4" href="/">돌아가기</Link>
      </section>
    </main>
  );
}
