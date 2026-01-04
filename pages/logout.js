import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

async function clearAuthStorageAndCaches() {
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

export default function LogoutPage() {
  const [msg, setMsg] = useState("Déconnexion…");

  useEffect(() => {
    (async () => {
      try {
        await supabase.auth.signOut();
      } catch (_) {}
      await clearAuthStorageAndCaches();
      window.location.replace("/login?ts=" + Date.now());
    })();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-3">
        <div className="text-xl font-semibold">{msg}</div>
        <div className="text-sm opacity-80">Si ça reste bloqué, clique ci-dessous.</div>
        <button className="btn w-full" onClick={() => window.location.replace("/login?ts=" + Date.now())}>
          Aller à /login
        </button>
      </div>
    </div>
  );
}
