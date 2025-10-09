// pages/admin/sellers.tsx
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabaseClient";

type Seller = { user_id: string; full_name: string; role?: string };

async function createSellerAPI({ full_name, email, password }: {
  full_name: string; email: string; password: string;
}) {
  const r = await fetch("/api/admin/create-seller", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name, email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Création échouée");
  return j;
}

export default function SellersAdminPage() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [full_name, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sellers, setSellers] = useState<Seller[]>([]);

  // Guard admin
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  const loadSellers = async () => {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, full_name, role")
      .order("full_name", { ascending: true });
    if (!error) setSellers((data || []) as Seller[]);
  };

  useEffect(() => { loadSellers(); }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await createSellerAPI({ full_name, email, password });
      setMsg("Vendeuse créée !");
      setFullName(""); setEmail(""); setPassword("");
      await loadSellers();
    } catch (err: any) {
      setMsg(err?.message ?? "Erreur");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <div className="hdr">Gérer les vendeuses</div>

      <form onSubmit={onSubmit} className="space-y-3 border rounded-2xl p-4">
        <div>
          <label className="block text-sm mb-1">Nom complet</label>
          <input className="input w-full" value={full_name}
                 onChange={(e) => setFullName(e.target.value)} required />
        </div>
        <div>
          <label className="block text-sm mb-1">Email</label>
          <input className="input w-full" type="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} required
                 placeholder="vendeuse@vendeuses.local" />
        </div>
        <div>
          <label className="block text-sm mb-1">Mot de passe</label>
          <input className="input w-full" type="password" value={password}
                 onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Création..." : "Créer la vendeuse"}
        </button>
        {msg && <div className="text-sm mt-2">{msg}</div>}
      </form>

      <div className="card">
        <div className="hdr mb-2">Vendeuses existantes</div>
        {sellers.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
        ) : (
          <ul className="space-y-2">
            {sellers.map((s) => (
              <li key={s.user_id} className="border rounded-2xl p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.full_name || "—"}</div>
                  <div className="text-sm text-gray-600">{s.user_id}</div>
                </div>
                <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: "#f3f4f6" }}>{s.role || "seller"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
