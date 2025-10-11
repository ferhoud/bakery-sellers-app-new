// pages/login.js
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const router = useRouter();
  const { session, profile, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Si déjà connecté + profil connu -> route selon le rôle
  useEffect(() => {
    if (loading) return;
    if (!session) return;
    // profil peut être null si la ligne manque -> on reste sur /login
    if (!profile) return;
    if (profile.role === "admin") router.replace("/admin");
    else router.replace("/app");
  }, [loading, session, profile, router]);

  const onLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setErr(error.message || "Échec de connexion");
    setBusy(false);
    // NE PAS router ici : on laisse useAuth capter la session et router via l'effet ci-dessus
  };

  return (
    <div style={{ maxWidth: 420, margin: "64px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Connexion</h1>
      <form onSubmit={onLogin} className="space-y-3">
        <div>
          <label className="block text-sm mb-1">Email</label>
          <input className="input w-full" type="email" value={email} onChange={(e)=>setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="block text-sm mb-1">Mot de passe</label>
          <input className="input w-full" type="password" value={password} onChange={(e)=>setPassword(e.target.value)} required />
        </div>
        {err && <div className="text-red-600 text-sm">{err}</div>}
        <button className="btn" type="submit" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</button>
      </form>
    </div>
  );
}
