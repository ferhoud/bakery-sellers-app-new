import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Login(){
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        setLoading(false);
        return;
      }
      // Redirection immédiate : l’index décidera /admin ou /app
      window.location.assign("/");
    } catch (err) {
      setError(err?.message || "Erreur inconnue");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="card w-full max-w-md">
        <h1 className="hdr mb-2">Connexion</h1>
        <p className="sub mb-6">Identifiant et mot de passe fournis par l’administrateur.</p>
        <form onSubmit={onSubmit} className="space-y-3">
          <input
            className="input"
            placeholder="Email"
            value={email}
            onChange={(e)=> setEmail(e.target.value)}
            autoComplete="username"
          />
          <input
            type="password"
            className="input"
            placeholder="Mot de passe"
            value={password}
            onChange={(e)=> setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <button className="btn w-full" disabled={loading}>
            {loading ? "Connexion…" : "Se connecter"}
          </button>
        </form>
      </div>
    </div>
  );
}
