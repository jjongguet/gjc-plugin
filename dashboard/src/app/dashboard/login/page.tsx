// Token entry route — the only way for a human to view the dashboard without a login flow.
// The server action verifies the token itself (prevents form abuse). On a match it issues an
// HttpOnly cookie and enters /dashboard. proxy.ts lets this path through unauthenticated.
// ("use server" is inlined in the action body — a page-module-level directive would also turn the
// default-exported page component into a server action and break the build.)
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

async function login(formData: FormData) {
  "use server";
  const token = String(formData.get("token") ?? "");
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) throw new Error("DASHBOARD_TOKEN is not set (fail-closed)");
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
        <button type="submit">Enter</button>
      </form>
    </main>
  );
}
