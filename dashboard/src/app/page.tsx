import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>dashboard scaffold</h1>
      <p>
        <Link href="/dashboard">Open the dashboard</Link> (token required —{" "}
        <Link href="/dashboard/login">log in</Link>)
      </p>
    </main>
  );
}
