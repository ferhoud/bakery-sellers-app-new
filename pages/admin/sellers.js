// pages/admin/sellers.js
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import { useAuth } from "../../lib/useAuth";

const API_CREATE = "/api/admin/create-seller";
const API_LIST   = "/api/admin/list-sellers";

// Icônes SVG (pas de polices = pas de glyphes bizarres)
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

export default function SellersAdminPage() {
  const { session, profile, loading } = useAuth();
  const router = useRouter();

  const [sellers, setSellers] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [full_name, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace("/login");
    if (profile && profile.role !== "admin") router.replace("/app");
  }, [session, profile, loading, router]);

  const loadSellers = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const res = await fetch(API_LIST, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Échec chargement vendeuses");
      setSellers(json.sellers || []);
    } catch (e) {
      setListError(e.message || "Erreur");
      setSellers([]);
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => { loadSellers(); }, [loadSellers]);

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

  // Placeholders (branche tes vraies routes si tu veux)
  const onRename = (s) => console.log("Renommer", s);
  const onDeactivate = (s) => console.log("Désactiver", s);
  const onHardDelete = (s) => console.log("Supprimer hard", s);

  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <button className="btn" onClick={() => router.push("/admin")}>
          Retour admin
        </button>
        <a className="btn" href="/logout">Se déconnecter</a>
      </div>

      <div className="hdr">Gérer les vendeuses</div>

      {/* --- LISTE EN HAUT --- */}
      <div className="card">
        <div className="hdr mb-2">Vendeuses existantes</div>
        {listLoading ? (
          <div className="text-sm text-gray-600">Chargement…</div>
        ) : listError ? (
          <div className="text-sm text-red-600">Erreur: {listError}</div>
        ) : sellers.length === 0 ? (
          <div className="text-sm text-gray-600">Aucune vendeuse enregistrée.</div>
        ) : (
          <ul className="space-y-2">
            {sellers.map((s) => (
              <li key={s.user_id || s.id} className="border rounded-2xl p-3 bg-white flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.full_name || "—"}</div>
                  <div className="text-sm text-gray-600">{s.user_id || s.id}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn" onClick={() => onRename(s)}>
                    <PencilIcon style={{ marginRight: 8 }} /> Modifier
                  </button>
                  <button className="btn" style={{ background: "#dc2626" }} onClick={() => onDeactivate(s)}>
                    Désactiver
                  </button>
                  <button className="btn" style={{ background: "#78350f" }} onClick={() => onHardDelete(s)}>
                    <TrashIcon style={{ marginRight: 8 }} /> Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* --- FORMULAIRE EN BAS --- */}
      <form onSubmit={onSubmit} className="space-y-3 border rounded-2xl p-4 bg-white">
        <div className="hdr mb-2">Ajouter une vendeuse</div>
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
    </div>
  );
}
