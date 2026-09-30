// 대시보드 접근 통제(N1·V5) — Next 16 정식 파일명 proxy.ts(middleware.ts는 레거시 허용).
// 서버 전용 env DASHBOARD_TOKEN 대비 쿠키/헤더 토큰 검사. 미인증 401.
// 토큰은 /dashboard/login 입력 폼에서 HttpOnly 쿠키로 발급받는다(V9).
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE = "dashboard_token";

export default function proxy(req: NextRequest) {
  const expected = process.env.DASHBOARD_TOKEN;
  const token = req.cookies.get(COOKIE)?.value ?? req.headers.get("x-dashboard-token");
  // 로그인 폼은 통과(V9 — 토큰 입력 경로가 보호 대상이면 도달 불능). 액션 자체는 토큰 비교가 본체.
  if (req.nextUrl.pathname.startsWith("/dashboard/login")) return NextResponse.next();
  if (expected && token === expected) return NextResponse.next();
  return new NextResponse("Unauthorized", { status: 401 });
}

export const config = {
  // 보호 대상: 대시보드와 서버 액션 라우트(E2 — 비용 유발 POST의 live 공개 노출 금지)
  matcher: ["/dashboard/:path*"],
};
