// pages/admin/sellers.js
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../../lib/useAuth";

const API_CREATE = "/api/admin/create-seller";   // doit correspondre à pages/api/admin/create-seller.js
const API_LIST   = "/api/admin/list-sellers";    // NOUVEAU : liste côté serveur (service role)

async function createSellerAPI({ full_name, email, password }) {
  const r = await fetch(API_CREATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name, email, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Création échouée");
  return j;
}
const PencilIcon = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" stroke="currentColor" strokeWidth="1.5" fill="currentColor"/>
    <path d="M20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z" fill="currentColor"/>
  </svg>
);

const TrashIcon = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M6 7h12M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M8 7v12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V7" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
);

const ArrowLeftIcon = (props) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...props}>
    <path d="M19 12H5m0 0l6-6m-6 6l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function SellersAdminPage() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [full_name, setFullName] = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);

  const [sellers, setSellers]   = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError]     = useState(null);

  // Garde d'authentification
  useEffect(() => {
    if (loading) return;
    if (!session) r.replace("/login");
    if (profile && profile.role !== "admin") r.replace("/app");
  }, [session, profile, loading, r]);

  // Charge la liste via l'API route (service role côté serveur)
  const loadSellers = async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(API_LIST, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Échec chargement vendeuses");
      setSellers(json.sellers || []);
    } catch (e) {
      console.error("Load sellers failed:", e);
      setListError(e.message || "Erreur");
      setSellers([]);
    } finally {
      setListLoading(false);
    }
  };

  useEffect(() => {
    loadSellers();
  }, []);

  // Création d'une vendeuse + refresh liste
  const onSubmit = async (e) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      await createSellerAPI({ full_name, email, password });
      setMsg("Vendeuse créée !");
      setFullName(""); setEmail(""); setPassword("");
      await loadSellers();
    } catch (err) {
      setMsg(err?.message ?? "Erreur");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-6">
      <div className="hdr">Gérer les vendeuses</div>
      <div style={{ fontSize: 12, opacity: .6 }}>BUILD sellers.js (server-list)</div>

      <form onSubmit={onSubmit} className="space-y-3 border rounded-2xl p-4">
        <div>
          <label className="block text-sm mb-1">Nom complet</label>
          <input
            className="input w-full"
            value={full_name}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Email</label>
          <input
            className="input w-full"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="vendeuse@vendeuses.local"
          />
        </div>
        <div>
          <label className="block text-sm mb-1">Mot de passe</label>
          <input
            className="input w-full"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Création..." : "Créer la vendeuse"}
        </button>
        {msg && <div className="text-sm mt-2">{msg}</div>}
      </form>

      <div className="card">
        <div className="hdr mb-2">Vendeuses existantes</div>

        {listLoading ? (
          <div className="text-sm text-gray-600">Chargement…</div>
        ) : listError ? (
          <div className="text-sm text-red-600">
            Erreur lors du chargement : {listError}
          </div>
        ) : sellers.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
        ) : (
          <ul className="space-y-2">
            {sellers.map((s) => (
              <li key={s.user_id || s.id} className="border rounded-2xl p-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.full_name || "—"}</div>
                  <div className="text-sm text-gray-600">{s.user_id || s.id}</div>
                </div>
                <span
                  className="text-xs px-2 py-1 rounded-full"
                  style={{ backgroundColor: "#f3f4f6" }}
                >
                  {s.role || "seller"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
