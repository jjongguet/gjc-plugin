import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>dashboard scaffold</h1>
      <p>
        <Link href="/dashboard">대시보드 열기</Link> (토큰 필요 — <Link href="/dashboard/login">로그인</Link>)
      </p>
    </main>
  );
}
