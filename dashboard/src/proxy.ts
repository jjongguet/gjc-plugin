// Dashboard access control — proxy.ts is the official Next 16 filename (middleware.ts is legacy).
// Compares a cookie/header token against the server-only DASHBOARD_TOKEN env. Unauthenticated → 401.
// The token is issued as an HttpOnly cookie by the input form at /dashboard/login.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const COOKIE = "dashboard_token";

export default function proxy(req: NextRequest) {
  const expected = process.env.DASHBOARD_TOKEN;
  const token = req.cookies.get(COOKIE)?.value ?? req.headers.get("x-dashboard-token");
  // Let the login form through (protecting the token entry path would make it unreachable).
  // The action itself is where the token comparison happens.
  if (req.nextUrl.pathname.startsWith("/dashboard/login")) return NextResponse.next();
  if (expected && token === expected) return NextResponse.next();
  return new NextResponse("Unauthorized", { status: 401 });
}

export const config = {
  // Protected: the dashboard and its server action routes (never expose cost-incurring POSTs publicly)
  matcher: ["/dashboard/:path*"],
};
