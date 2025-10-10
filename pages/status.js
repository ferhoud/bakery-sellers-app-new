
// touch: 2025-10-10 runtime status page (env/auth/sw/db ping)

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function StatusPage() {
  const [env, setEnv] = useState({ url: null, key: null });
  const [auth, setAuth] = useState({ user: null, error: null });
  const [db, setDb] = useState({ ok: null, error: null });
  const [sw, setSw] = useState({ controlled: false, regs: 0 });

  useEffect(() => {
    setEnv({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL || null,
      key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "present" : null,
    });

    (async () => {
      try {
        const { data, error } = await supabase.auth.getSession();
        if (error) setAuth({ user: null, error: error.message });
        else setAuth({ user: data?.session?.user || null, error: null });
      } catch (e) {
        setAuth({ user: null, error: String(e?.message || e) });
      }

      try {
        // very light ping: request that should be allowed by RLS (or gracefully fail)
        const { error: dbErr } = await supabase.rpc("list_sellers");
        if (dbErr) setDb({ ok: false, error: dbErr.message });
        else setDb({ ok: true, error: null });
      } catch (e) {
        setDb({ ok: false, error: String(e?.message || e) });
      }

      try {
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          setSw({ controlled: !!navigator.serviceWorker.controller, regs: regs.length });
        }
      } catch {}
    })();
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Runtime Status</h1>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Env</h2>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
{JSON.stringify(env, null, 2)}
        </pre>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Auth</h2>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
{JSON.stringify(auth, null, 2)}
        </pre>
        <div style={{ marginTop: 8 }}>
          <a href="/login" style={{ color: "#2563eb", textDecoration: "underline" }}>Aller au login</a>
        </div>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>DB</h2>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
{JSON.stringify(db, null, 2)}
        </pre>
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Service Worker</h2>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8 }}>
{JSON.stringify(sw, null, 2)}
        </pre>
        <button
          onClick={async () => {
            if (!("serviceWorker" in navigator)) return;
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map(r => r.update().catch(() => {})));
            location.reload();
          }}
          style={{ marginTop: 8, padding: "8px 12px", borderRadius: 8, background: "#2563eb", color: "#fff" }}
        >
          Forcer mise à jour SW + Reload
        </button>
      </section>
    </div>
  );
}
