/* eslint-disable react/no-unescaped-entities */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";
import { useAuth } from "../../lib/useAuth";
import { fmtISODate } from "@/lib/date";
import { isAdminEmail } from "../../lib/admin";

const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function monthStartISO(d) {
  return fmtISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

export default function AdminMonthlyHours() {
  const { session, profile, loading } = useAuth();
  const r = useRouter();

  const [monthStart, setMonthStart] = useState(() => {
    const now = new Date();
    const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const prev = new Date(firstThis);
    prev.setMonth(prev.getMonth() - 1);
    return monthStartISO(prev);
  });

  const monthLabel = useMemo(() => {
    const d = new Date(monthStart + "T00:00:00");
    return capFirst(d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }));
  }, [monthStart]);

  const monthOptions = useMemo(() => {
    const now = new Date();
    const res = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      d.setMonth(d.getMonth() - i);
      res.push(monthStartISO(d));
    }
    return res;
  }, []);

  // Auth admin
  const isAdmin = useMemo(() => {
    const role = profile?.role || "seller";
    const email = session?.user?.email || "";
    return role === "admin" || isAdminEmail(email);
  }, [profile?.role, session?.user?.email]);

  useEffect(() => {
    if (loading) return;
    if (!session) { r.replace("/login"); return; }
    if (!isAdmin) { r.replace("/app"); }
  }, [loading, session, isAdmin, r]);

  const [rows, setRows] = useState([]);
  const [names, setNames] = useState({});
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState("");
  const [err, setErr] = useState("");

  const loadNames = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc("list_active_seller_names");
      if (!error && Array.isArray(data)) {
        const map = {};
        data.forEach((x) => { if (x?.user_id) map[x.user_id] = x.full_name || ""; });
        setNames(map);
      }
    } catch (_) {}
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setErr("");
    try {
      const { data, error } = await supabase
        .from("monthly_hours_attestations")
        .select("id,seller_id,month_start,computed_hours,seller_status,seller_confirmed_at,seller_correction_hours,seller_comment,admin_status,admin_decision_at,admin_comment,final_hours,updated_at")
        .eq("month_start", monthStart)
        .order("updated_at", { ascending: false });

      if (error) throw error;
      setRows(data || []);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Impossible de charger les validations mensuelles.");
      setRows([]);
    } finally {
      setBusy(false);
    }
  }, [session, monthStart]);

  useEffect(() => {
    if (!session || !isAdmin) return;
    loadNames();
    load();
  }, [session, isAdmin, loadNames, load]);

  // Realtime: une vendeuse valide/corrige → refresh + message
  useEffect(() => {
    if (!session || !isAdmin) return;

    const ch = supabase
      .channel("monthly_hours_admin_" + monthStart)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "monthly_hours_attestations", filter: `month_start=eq.${monthStart}` },
        (payload) => {
          const row = payload?.new;
          if (!row) return;

          if (payload.eventType === "UPDATE" && row.seller_status && row.seller_status !== "pending") {
            const nm = names[row.seller_id] || row.seller_id?.slice?.(0, 8) || "Une vendeuse";
            setFlash(`${nm} a ${row.seller_status === "accepted" ? "validé" : "proposé une correction"} de ses heures.`);
            setTimeout(() => setFlash(""), 6000);
          }

          // Refresh simple
          load();
        }
      )
      .subscribe();

    return () => supabase.removeChannel(ch);
  }, [session, isAdmin, monthStart, names, load]);

  const decide = useCallback(async (rowId, decision) => {
    setErr("");
    const note = window.prompt(decision === "approve" ? "Commentaire admin (optionnel) :" : "Motif du refus (optionnel) :") || null;

    const { data, error } = await supabase.rpc("admin_monthly_hours_decide", {
      p_row_id: rowId,
      p_decision: decision,
      p_comment: note,
    });

    if (error) {
      alert(error.message || "Échec");
      return;
    }

    // Update local
    setRows((prev) => prev.map((x) => (x.id === rowId ? { ...(x || {}), ...(data || {}) } : x)));
  }, []);

  const pendingCount = useMemo(() => rows.filter((r) => r.admin_status === "pending").length, [rows]);

  if (loading || !session || !isAdmin) return <div className="p-4">Chargement…</div>;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="hdr">Validation heures mensuelles</div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => r.push("/admin")}>Retour admin</button>
          <button className="btn" onClick={() => supabase.auth.signOut().then(() => r.replace("/login"))}>Se déconnecter</button>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="hdr mb-1">{monthLabel}</div>
            <div className="text-sm text-gray-600">{pendingCount} en attente</div>
          </div>

          <div className="flex items-center gap-2">
            <select className="input" value={monthStart} onChange={(e) => setMonthStart(e.target.value)}>
              {monthOptions.map((ms) => (
                <option key={ms} value={ms}>
                  {capFirst(new Date(ms + "T00:00:00").toLocaleDateString("fr-FR", { month: "long", year: "numeric" }))}
                </option>
              ))}
            </select>
            <button className="btn" onClick={load} disabled={busy}>
              Rafraîchir
            </button>
          </div>
        </div>

        {flash && (
          <div className="mt-3 text-sm border rounded-xl p-2" style={{ backgroundColor: "#ecfeff", borderColor: "#67e8f9" }}>
            {flash}
          </div>
        )}

        {err && (
          <div className="mt-3 text-sm border rounded-xl p-2" style={{ backgroundColor: "#fef2f2", borderColor: "#fecaca" }}>
            {err}
          </div>
        )}

        <div className="mt-4 space-y-3">
          {busy && <div className="text-sm text-gray-600">Chargement…</div>}

          {!busy && rows.length === 0 && (
            <div className="text-sm text-gray-600">Aucune validation pour ce mois.</div>
          )}

          {!busy && rows.map((row) => {
            const nm = names[row.seller_id] || row.seller_id.slice(0, 8);
            const computed = Number(row.computed_hours || 0).toFixed(2);
            const corr = row.seller_correction_hours != null ? Number(row.seller_correction_hours || 0).toFixed(2) : null;
            const final = row.final_hours != null ? Number(row.final_hours || 0).toFixed(2) : null;

            return (
              <div key={row.id} className="border rounded-2xl p-3" style={{ borderColor: "#e5e7eb" }}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                  <div>
                    <div className="font-semibold">{nm}</div>
                    <div className="text-sm text-gray-700 mt-1">
                      Calculé: <span className="font-medium">{computed} h</span>
                      {" — "}
                      Réponse vendeuse:{" "}
                      {row.seller_status === "pending" && <span className="font-medium">en attente</span>}
                      {row.seller_status === "accepted" && <span className="font-medium">validé ✅</span>}
                      {row.seller_status === "disputed" && (
                        <span className="font-medium">
                          correction ✍️ ({corr} h){row.seller_comment ? ` — ${row.seller_comment}` : ""}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-600 mt-1">
                      Statut admin:{" "}
                      {row.admin_status === "pending" && <span className="font-medium">à traiter</span>}
                      {row.admin_status === "approved" && <span className="font-medium">approuvé ✅ (final: {final} h)</span>}
                      {row.admin_status === "rejected" && <span className="font-medium">refusé ❌ (final: {final} h)</span>}
                    </div>
                  </div>

                  <div className="flex gap-2">
                    <button
                      className="btn"
                      disabled={row.admin_status !== "pending"}
                      onClick={() => decide(row.id, "approve")}
                      style={{ backgroundColor: row.admin_status === "pending" ? "#16a34a" : undefined, color: row.admin_status === "pending" ? "#fff" : undefined, borderColor: "transparent" }}
                    >
                      Approuver
                    </button>
                    <button
                      className="btn"
                      disabled={row.admin_status !== "pending"}
                      onClick={() => decide(row.id, "reject")}
                      style={{ backgroundColor: row.admin_status === "pending" ? "#ef4444" : undefined, color: row.admin_status === "pending" ? "#fff" : undefined, borderColor: "transparent" }}
                    >
                      Refuser
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="text-xs text-gray-500 mt-4">
          Astuce: les vendeuses voient cette demande dans l'app vendeuse. Une fois validé/corrigé, tu reçois l'info ici en temps réel.
        </div>
      </div>
    </div>
  );
}
