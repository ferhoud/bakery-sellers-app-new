// pages/admin/sellers.js
import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

export default function SellersPage() {
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  const [rows, setRows] = useState([]);     // {user_id, full_name, active, role}
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // sécurité : redirige vers /login si pas de session, /app si pas admin
  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }
    if (profile && profile.role !== "admin") { r.replace("/app"); return; }
  }, [session, profile, loading, r]);

  const load = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      // utilise la RPC déjà en place (list_sellers) — plus fiable côté RLS
      const { data, error } = await supabase.rpc("list_sellers");
      if (error) throw error;
      // on s’attend à: [{ user_id, full_name, active, role }]
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setMsg(e?.message || "Impossible de charger la liste.");
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const t = (q || "").toLowerCase().trim();
    if (!t) return rows;
    return rows.filter(x =>
      (x.full_name || "").toLowerCase().includes(t) ||
      (x.user_id || "").toLowerCase().includes(t)
    );
  }, [rows, q]);

  async function saveName(user_id, full_name) {
    setBusy(true); setMsg("");
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name })
        .eq("user_id", user_id);
      if (error) throw error;
      setRows(prev => prev.map(r => r.user_id === user_id ? { ...r, full_name } : r));
      setMsg("Nom mis à jour.");
    } catch (e) {
      setMsg(e?.message || "Échec de mise à jour du nom.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user_id, active) {
    setBusy(true); setMsg("");
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ active })
        .eq("user_id", user_id);
      if (error) throw error;
      setRows(prev => prev.map(r => r.user_id === user_id ? { ...r, active } : r));
      setMsg(active ? "Vendeuse activée." : "Vendeuse désactivée.");
    } catch (e) {
      setMsg(e?.message || "Échec de modification de l’état.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Gérer les vendeuses</h1>
        <Link className="btn" href="/admin" style={btnStyle}>⬅ Retour admin</Link>
      </div>

      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Rechercher par nom ou ID…"
          style={inputStyle}
        />
        {busy ? <div style={{ fontSize: 14, color: "#6b7280" }}>Chargement…</div> : null}
        {msg ? <div style={{ fontSize: 14, color: "#2563eb" }}>{msg}</div> : null}
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 14, color: "#6b7280" }}>Aucune vendeuse.</div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {filtered.map((s) => (
            <SellerRow
              key={s.user_id}
              seller={s}
              onSaveName={saveName}
              onToggleActive={toggleActive}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SellerRow({ seller, onSaveName, onToggleActive }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(seller.full_name || "");

  return (
    <div style={rowStyle}>
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ fontWeight: 600 }}>{seller.full_name || "—"}</div>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          ID: <code>{seller.user_id}</code> · Rôle: {seller.role || "—"}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          fontSize: 12, padding: "2px 8px", borderRadius: 999,
          color: "#fff", background: seller.active ? "#16a34a" : "#dc2626"
        }}>
          {seller.active ? "Active" : "Inact ive"}
        </span>

        {!editing ? (
          <button style={btnStyle} onClick={() => { setVal(seller.full_name || ""); setEditing(true); }}>
            ✏️ Renommer
          </button>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              value={val}
              onChange={e => setVal(e.target.value)}
              style={inputStyleSm}
              placeholder="Nouveau nom"
            />
            <button
              style={btnStylePrimary}
              onClick={() => { onSaveName(seller.user_id, (val || "").trim()); setEditing(false); }}
              disabled={!val.trim()}
            >
              Enregistrer
            </button>
            <button style={btnStyle} onClick={() => setEditing(false)}>Annuler</button>
          </div>
        )}

        <button
          style={seller.active ? btnStyleDanger : btnStylePrimary}
          onClick={() => onToggleActive(seller.user_id, !seller.active)}
        >
          {seller.active ? "Désactiver" : "Activer"}
        </button>
      </div>
    </div>
  );
}

/* Styles simples */
const rowStyle = {
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 12,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
const btnStyle = {
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  background: "#fff",
  cursor: "pointer",
};
const btnStylePrimary = {
  ...btnStyle,
  background: "#2563eb",
  color: "#fff",
  borderColor: "transparent",
};
const btnStyleDanger = {
  ...btnStyle,
  background: "#dc2626",
  color: "#fff",
  borderColor: "transparent",
};
const inputStyle = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
};
const inputStyleSm = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
};
