import { useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";

export default function Login() {
  const r = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function routeByRole(userId) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", userId)
        .single();
      if (error) throw error;
      if (data?.role === "admin") r.replace("/admin");
      else r.replace("/app");
    } catch {
      r.replace("/app");
    }
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      const userId = data?.user?.id;
      if (!userId) throw new Error("Utilisateur introuvable");
      await routeByRole(userId);
    } catch (e) {
      setError(e?.message || "Échec de connexion");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 20, fontWeight: 700 }}>Connexion</h1>
      <form onSubmit={onSubmit} style={{ marginTop: 12, maxWidth: 360 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <input type="email" placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} required
            style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb" }} />
          <input type="password" placeholder="Mot de passe" value={password}
            onChange={(e) => setPass(e.target.value)} required
            style={{ padding: 10, borderRadius: 8, border: "1px solid #e5e7eb" }} />
          <button type="submit" disabled={busy}
            style={{ padding: "10px 12px", borderRadius: 8, background: "#2563eb", color: "#fff" }}>
            {busy ? "Connexion…" : "Se connecter"}
          </button>
          {error ? <div style={{ color: "#b91c1c" }}>{error}</div> : null}
        </div>
      </form>
    </div>
  );
}
