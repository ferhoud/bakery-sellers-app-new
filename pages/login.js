/* pages/login.js */
import { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function LoginPage() {
  const router = useRouter();
  const { profile, loading } = useAuth(); // profile est mis à jour par AuthProvider
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Après connexion: route selon le rôle dès que profile est dispo
  useEffect(() => {
    if (loading) return;                 // attend la fin du chargement
    if (!profile) return;                // pas encore de profil -> attendre
    if (profile.role === "admin") router.replace("/admin");
    else router.replace("/app");         // page vendeuse
  }, [profile, loading, router]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrorMsg("");
    setSubmitting(true);
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password,
      });
      if (error) {
        setErrorMsg(error.message || "Échec de connexion.");
        return; // on laisse le bouton revenir à "Se connecter"
      }
      // Pas de redirection immédiate ici : on laisse useAuth détecter la session
      // puis faire la redirection dans le useEffect ci-dessus.
    } catch (err) {
      setErrorMsg(err?.message || "Erreur réseau.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>Connexion</title>
      </Head>

      <div className="min-h-screen flex items-center justify-center bg-[#f5f5f5] p-4">
        <form onSubmit={handleSubmit} className="w-full max-w-sm bg-white border rounded-2xl p-4 space-y-3">
          <div className="text-xl font-semibold">Se connecter</div>

          <label className="block">
            <div className="text-sm mb-1">Email</div>
            <input
              type="email"
              className="input w-full"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </label>

          <label className="block">
            <div className="text-sm mb-1">Mot de passe</div>
            <input
              type="password"
              className="input w-full"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>

          {errorMsg ? (
            <div className="text-sm text-red-600">{errorMsg}</div>
          ) : null}

          <button
            type="submit"
            className="btn w-full"
            disabled={submitting}
          >
            {submitting ? "Connexion…" : "Se connecter"}
          </button>

          {/* Petit debug non intrusif */}
          <div className="text-[11px] text-gray-500 mt-2">
            {loading ? "Chargement du profil…" : profile ? `Profil: ${profile.full_name} (${profile.role})` : "Non connecté"}
          </div>
        </form>
      </div>
    </>
  );
}
