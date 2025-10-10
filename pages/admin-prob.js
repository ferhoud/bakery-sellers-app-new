import Head from "next/head";
import { useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient"; // ajuste si besoin

// *** CHANGE THIS STRING EVERY TIME YOU TEST ***
const BUILD_TAG = "ADMIN-PROBE PAGE — 10/10/2025 16:45 Europe/Paris";

export default function AdminProbePage() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log("%c[ADMIN-PROBE]", "font-weight:bold;color:#1976d2", "BUILD_TAG:", BUILD_TAG, "time:", new Date().toISOString());
      document.title = `Admin Probe • ${BUILD_TAG}`;
    }
  }, []);

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
      router.push("/login");
    } catch (e) {
      alert("Erreur de déconnexion: " + (e?.message || e));
      console.error(e);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fffbe6", color: "#111", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" }}>
      <Head>
        <title>Admin Probe • {BUILD_TAG}</title>
        <meta name="robots" content="noindex,nofollow"/>
      </Head>

      <div style={{ padding: "12px 16px", background: "#111", color: "#fff", fontWeight: 800, letterSpacing: 0.3 }}>
        ✅ PAGE DE TEST ACTIVE: {BUILD_TAG}
      </div>

      <div style={{ padding: 16 }}>
        <p style={{ marginBottom: 12 }}>
          Cette page <strong>/admin-probe</strong> est indépendante de <code>/admin</code>. Elle sert uniquement à vérifier que le déploiement et le cache fonctionnent.
        </p>

        <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
          <button
            onClick={() => location.reload(true)}
            style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
            title="Hard reload"
          >
            🔄 Recharger la page (forcer)
          </button>

          <button
            onClick={handleSignOut}
            style={{ padding: "10px 14px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer", background: "#ffeaea" }}
            title="Se déconnecter"
          >
            🚪 Se déconnecter
          </button>
        </div>

        <details style={{ marginTop: 16 }}>
          <summary>Debug rapide</summary>
          <ul>
            <li>Vérifier que ce fichier est bien dans <code>pages/admin-probe.js</code>.</li>
            <li>Si PWA/service worker: DevTools → Application → Service Workers → Unregister + Clear storage, puis hard reload.</li>
            <li>Sur Vercel, ouvrir l’URL de prévisualisation du déploiement et comparer avec l’URL de prod.</li>
          </ul>
        </details>
      </div>
    </div>
  );
}
