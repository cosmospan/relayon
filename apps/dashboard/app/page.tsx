import { NAV } from "../lib/nav";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Relayon</h1>
      <p className="mt-2 text-neutral-600">Dashboard scaffold. Sections arrive in the dashboard milestone.</p>
      <ul className="mt-6 grid grid-cols-2 gap-2">
        {NAV.map((n) => (
          <li key={n.href} className="rounded border border-neutral-200 px-3 py-2 text-sm">{n.label}</li>
        ))}
      </ul>
    </main>
  );
}
