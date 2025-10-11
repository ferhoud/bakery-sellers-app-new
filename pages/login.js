/* eslint-disable react/no-unescaped-entities */
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";

export default function LoginPage() {
  const r = useRouter();
  const { session, loading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [lastResp, setLastResp] = useState(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    const decide = async () => {
      if (loading || !session?.user?.id) return;
      setDeciding(true);
      try {
        // si email admin connu -> /admin direct (pas besoin de profil)
        if (isAdminEmail(session.user.email)) {
          r.replace("/admin");
          return;
        }
        // sinon essaie le profil
        const { data: prof } = await supabase
          .from("profiles")
          .select("role")
          .eq("user_id", session.user.id)
          .maybeSingle();
        if (prof?.role === "admin") {
          r.replace("/admin");
          return;
        }
        r.replace(r.query.next ? String(r.query.next) : "/app");
      } finally {
        setDeciding(false);
      }
    };
    decide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, loading]);

  async function ensureProfile(user) {
    if (!user?.id) return;
    // existe ?
    const { data: existing } = await supabase
      .from("profiles")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing) {
      const fullName =
        user.user_metadata?.full_name ||
        (user.email ? user.email.split("@")[0] : "Utilisateur");
      const role = isAdminEmail(user.email) ? "admin" : "seller";
      // nécessite la policy INSERT (voir section 3)
      await supabase.from("profiles").insert({
        user_id: user.id,
        full_name: fullName,
        role,
      });
    }
  }

  const redirectByRoleOrEmail = async (user) => {
    let next = r.query.next ? String(r.query.next) : "/app";

    if (isAdminEmail(user?.email)) {
      r.replace("/admin");
      return;
    }
    if (user?.id) {
      const { data: prof } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", user.id)
        .maybeSingle();
      if (prof?.role === "admin") {
        r.replace("/admin");
        return;
      }
    }
    r.replace(next);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLastResp(null);

    try {
      const { data, error: err } = await supabase.auth.signInWithPassword({ email, password });
      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;

      // 1) crée la ligne profil si manquante
      await ensureProfile(data?.user);
      // 2) redirige (email admin > profil.role > /app)
      await redirectByRoleOrEmail(data?.user);
    } catch (e2) {
      console.error("[login] error:", e2);
      setError(formatErr(e2));
      setSubmitting(false);
    }
  };

  const onSendOtp = async () => {
    setError(null);
    setSubmitting(true);
    setLastResp(null);
    try {
      const { data, error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: (typeof window !== "undefined" ? window.location.origin : "") + "/app" },
      });
      setLastResp({ data, err: serializeErr(err) });
      if (err) throw err;
      alert("Email envoyé.");
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

  if (loading || deciding) return <div className="p-4">Chargement…</div>;

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
              autoComplete="email"
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
              autoComplete="current-password"
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
