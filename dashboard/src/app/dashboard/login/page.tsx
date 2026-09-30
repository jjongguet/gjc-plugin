// 토큰 입력 경로(V9) — 로그인 플로우 없이 사람이 대시보드를 보는 유일한 경로.
// 서버 액션은 자체 토큰 검사를 한다(E2 — 폼 악용 방지). 일치 시 HttpOnly 쿠키
// 발급 후 /dashboard로 진입한다. proxy.ts가 이 경로를 예외 통과시킨다.
// ("use server"는 액션 함수 본문에 인라인 — 페이지 모듈 전역 지시문은 기본
// export 페이지 컴포넌트까지 서버 액션으로 만들어 빌드가 깨진다.)
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function login(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) throw new Error("DASHBOARD_TOKEN 미설정(fail-closed)");
  if (token !== expected) return;
  const jar = await cookies();
  jar.set("dashboard_token", token, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/dashboard");
}

export default function LoginPage() {
  return (
    <main>
      <h1>dashboard login</h1>
      <form action={login}>
        <input type="password" name="token" placeholder="DASHBOARD_TOKEN" autoComplete="off" />
        <button type="submit">입장</button>
      </form>
    </main>
  );
}
