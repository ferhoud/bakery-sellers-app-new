// pages/login.js — version DIAGNOSTIC ++ (email/password + test OTP + logs détaillés)
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
  const [lastResp, setLastResp] = useState(null);

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
    setLastResp(null);

    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      console.log("[login] signInWithPassword =>", { data, err });
      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;

      const next = r.query.next ? String(r.query.next) : "/app";
      r.replace(next);
    } catch (e) {
      console.error("[login] error:", e);
      setError(formatErr(e));
      setSubmitting(false);
    }
  };

  // Option de secours: tester l'OTP (lien magique) pour vérifier la config Auth rapidement
  const onSendOtp = async () => {
    setError(null);
    setSubmitting(true);
    setLastResp(null);
    try {
      const { data, error: err } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + "/app" } });
      console.log("[login] signInWithOtp =>", { data, err });
      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;
      alert("Email envoyé (si le provider Email est activé). Ouvre le lien magique pour tester la session.");
    } catch (e) {
      console.error("[login][otp] error:", e);
      setError(formatErr(e));
    } finally {
      setSubmitting(false);
    }
  };

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
          <button type="button" className="btn w-full" onClick={onSendOtp} disabled={submitting}>
            Tester par lien magique (OTP)
          </button>

          {error && (
            <div className="text-sm" style={{ color: "#b91c1c", whiteSpace: "pre-wrap" }}>
              {String(error)}
            </div>
          )}
        </form>

        {lastResp && (
          <details className="text-xs mt-2">
            <summary>Debug (réponse brute)</summary>
            <pre className="mt-1 p-2 bg-gray-100 rounded">{JSON.stringify(lastResp, null, 2)}</pre>
          </details>
        )}

        <div className="text-xs text-gray-600">
          Astuces debug:
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Onglet <b>Réseau</b> (F12) → requête <code>auth/v1/token?grant_type=password</code> (200 attendu).</li>
            <li>Si 401/400: identifiants invalides, email non confirmé, provider Email/Password désactivé.</li>
            <li>Vérifie <code>NEXT_PUBLIC_SUPABASE_URL</code> et <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> (console affiche ok/manquant).</li>
            <li>Auth &gt; Settings: <b>Site URL</b> doit correspondre à ton domaine/localhost pour l’OTP.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function serializeErr(err) {
  if (!err) return null;
  return { name: err.name, message: err.message, status: err.status };
}
function formatErr(e) {
  const msg = e?.message || String(e);
  const status = e?.status ? ` (status ${e.status})` : "";
  return `${msg}${status}`;
}
