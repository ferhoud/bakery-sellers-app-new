// pages/login.js — écran de connexion robuste (Supabase Email/Password)
// Touch: 2025-10-11
/* eslint-disable react/no-unescaped-entities */
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const r = useRouter();
  const { session, loading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Si déjà connecté -> route vendeuse (ou admin via redirection côté app)
  useEffect(() => {
    if (!loading && session) {
      const next = r.query.next ? String(r.query.next) : "/app";
      r.replace(next);
    }
  }, [session, loading, r]);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      // ✅ connexion email/password standard
      const { data, error: err } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      console.log("[login] signInWithPassword =>", { data, err });
      if (err) throw err;

      // Redirection réussie
      const next = r.query.next ? String(r.query.next) : "/app";
      r.replace(next);
    } catch (e) {
      // Affiche le message exact retourné par Supabase (utile pour diagnostiquer)
      console.error("[login] error:", e);
      setError(e?.message || "Échec de connexion");
      setSubmitting(false);
    }
  };

  // Aide debug: vérifier que les clés sont bien injectées
  useEffect(() => {
    if (typeof window !== "undefined") {
      console.log("[env] NEXT_PUBLIC_SUPABASE_URL:", process.env.NEXT_PUBLIC_SUPABASE_URL ? "ok" : "manquant");
      console.log("[env] NEXT_PUBLIC_SUPABASE_ANON_KEY:", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "ok" : "manquant");
    }
  }, []);

  if (loading) return <div className="p-4">Chargement…</div>;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm border rounded-2xl p-6 space-y-4">
        <div className="text-xl font-semibold">Connexion</div>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="text-sm">Email</label>
            <input
              type="email"
              required
              className="input w-full"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vous@example.com"
            />
          </div>
          <div>
            <label className="text-sm">Mot de passe</label>
            <input
              type="password"
              required
              className="input w-full"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          <button type="submit" className="btn w-full" disabled={submitting}>
            {submitting ? "Connexion…" : "Se connecter"}
          </button>
          {error && (
            <div className="text-sm" style={{ color: "#b91c1c" }}>
              {String(error)}
            </div>
          )}
        </form>

        <div className="text-xs text-gray-600">
          Astuces debug:
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Ouvre l’onglet <b>Réseau</b> (F12) et vérifie la requête <code>auth/v1/token?grant_type=password</code>.</li>
            <li>Si 401/400: email ou mot de passe invalides, ou règles de sécurité (RLS/policies) mal réglées.</li>
            <li>Vérifie que <code>NEXT_PUBLIC_SUPABASE_URL</code> et <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> sont bien définies.</li>
            <li>Dans le dashboard Supabase: Auth &gt; Settings &gt; Vérifie si la confirmation d’email est exigée.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
