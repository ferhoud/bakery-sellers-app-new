import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

async function nuke() {
  try { await supabase.auth.signOut(); } catch {}

  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") || k.includes("supabase"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (_) {}

  try {
    Object.keys(sessionStorage).forEach((k) => sessionStorage.removeItem(k));
  } catch (_) {}

  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch (_) {}

  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (_) {}
}

export default function Repair() {
  const [msg, setMsg] = useState("Réparation en cours…");

  useEffect(() => {
    (async () => {
      setMsg("Nettoyage session + cache…");
      await nuke();
      setMsg("Redirection vers /login…");
      window.location.replace("/login?repaired=1&ts=" + Date.now());
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-2">
        <div className="text-xl font-semibold">Repair</div>
        <div className="text-sm opacity-80">{msg}</div>
      </div>
    </div>
  );
}
