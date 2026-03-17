// pages/admin/checkins.js
import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState, useCallback } from "react";

import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";

function monthValueFromDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabelFr(monthValue) {
  try {
    const [y, m] = String(monthValue || "").split("-").map(Number);
    if (!y || !m) return monthValue || "-";
    return new Date(y, m - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  } catch {
    return monthValue || "-";
  }
}

function fmtMinutes(mins) {
  const n = Number(mins || 0) || 0;
  if (!n) return "0 min";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h && m) return `${sign}${h}h${String(m).padStart(2, "0")}`;
  if (h) return `${sign}${h}h`;
  return `${sign}${m} min`;
}

function statusStyle(status) {
  const s = String(status || "").toLowerCase();
  if (s.includes("non pointé") || s.includes("non pointe")) {
    return { bg: "#fef2f2", border: "#fecaca", text: "#b91c1c" };
  }
  if (s.includes("hors planning")) {
    return { bg: "#fff7ed", border: "#fdba74", text: "#c2410c" };
  }
  if (s.includes("à venir") || s.includes("a venir")) {
    return { bg: "#eff6ff", border: "#bfdbfe", text: "#1d4ed8" };
  }
  if (s.includes("code émis") || s.includes("code emis")) {
    return { bg: "#fff7ed", border: "#fdba74", text: "#c2410c" };
  }
  return { bg: "#ecfdf5", border: "#a7f3d0", text: "#047857" };
}

function cardStyle() {
  return {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 16,
    padding: 16,
    boxShadow: "0 8px 30px rgba(15,23,42,0.06)",
  };
}

function rowTint(row) {
  if (!row) return {};
  if (row.is_missing) {
    return { background: "#fff5f5" };
  }
  if (Number(row.late_minutes || 0) > 0) {
    return { background: "#fff7ed" };
  }
  if (row.status_code === "confirmed") {
    return { background: "#f0fdf4" };
  }
  if (row.status_code === "upcoming") {
    return { background: "#eff6ff" };
  }
  return {};
}

function miniBadgeStyle(kind) {
  if (kind === "missing") {
    return { background: "#fef2f2", border: "#fecaca", color: "#b91c1c" };
  }
  if (kind === "late") {
    return { background: "#fff7ed", border: "#fdba74", color: "#c2410c" };
  }
  if (kind === "ok") {
    return { background: "#ecfdf5", border: "#a7f3d0", color: "#047857" };
  }
  return { background: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8" };
}

export default function AdminCheckinsPage() {
  const router = useRouter();
  const { session, profile, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace("/login");
      return;
    }
    if (isAdminEmail(session.user?.email)) return;
    if (profile?.role !== "admin") router.replace("/app");
  }, [session, profile, loading, router]);

  const [month, setMonth] = useState(monthValueFromDate(new Date()));
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [sellerId, setSellerId] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [data, setData] = useState({ rows: [], sellers: [], summary: null, month: monthValueFromDate(new Date()) });
  const [sellerList, setSellerList] = useState([]);
  const [sellerErr, setSellerErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const loadSellerList = useCallback(async () => {
    if (!session?.access_token) return;
    setSellerErr("");

    let rows = [];

    // 1) Même logique que la page admin principale : RPC list_sellers
    try {
      const { data, error } = await supabase.rpc("list_sellers");
      if (!error && Array.isArray(data) && data.length) rows = data;
    } catch {}

    // 2) Fallback direct sur profiles (seller)
    if (rows.length === 0) {
      try {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name, role, active")
          .eq("role", "seller");
        if (Array.isArray(profs) && profs.length) {
          rows = profs.map(({ user_id, full_name, active }) => ({
            user_id,
            full_name: full_name || user_id,
            active,
          }));
        }
      } catch {}
    }

    // 3) Dernier fallback sur l'API admin existante si besoin
    if (rows.length === 0) {
      try {
        const res = await fetch('/api/admin/sellers/list', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const json = await res.json().catch(() => ({}));
        const apiRows = Array.isArray(json?.sellers)
          ? json.sellers
          : Array.isArray(json?.rows)
            ? json.rows
            : Array.isArray(json?.items)
              ? json.items
              : [];
        if (res.ok && json?.ok && apiRows.length) rows = apiRows;
      } catch {}
    }

    const normalized = (rows || [])
      .map((s) => ({
        id: s?.id || s?.user_id || s?.seller_id || "",
        full_name: s?.full_name || s?.name || s?.label || s?.id || s?.user_id || "",
        is_active: s?.is_active !== false && s?.active !== false,
      }))
      .filter((s) => s.id)
      .sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr", { sensitivity: "base" }));

    setSellerList(normalized);
    if (!normalized.length) {
      setSellerErr("Aucune vendeuse trouvée pour remplir le filtre.");
    }
  }, [session?.access_token]);

  const loadHistory = useCallback(async () => {
    if (!session?.access_token) return;
    setBusy(true);
    setErr("");
    try {
      const qs = new URLSearchParams({ month });
      if (day) qs.set("day", day);
      if (sellerId) qs.set("seller_id", sellerId);
      const res = await fetch(`/api/admin/checkins/history?${qs.toString()}`, {
        headers: {
          Authorization: `Bearer ${session.access_token}`,
        },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.ok) throw new Error(json?.error || "Impossible de charger l'historique de pointage.");
      setData({
        rows: Array.isArray(json.rows) ? json.rows : [],
        sellers: Array.isArray(json.sellers) ? json.sellers : [],
        summary: json.summary || null,
        month: json.month || month,
      });
    } catch (e) {
      setErr(e?.message || "Impossible de charger l'historique de pointage.");
      setData((prev) => ({ ...prev, rows: [], summary: null }));
    } finally {
      setBusy(false);
    }
  }, [session?.access_token, month, day, sellerId]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadSellerList();
  }, [loadSellerList]);

  const filteredRows = useMemo(() => {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!onlyMissing) return rows;
    return rows.filter((r) => !!r.is_missing);
  }, [data.rows, onlyMissing]);

  const visibleSummary = useMemo(() => {
    const rows = filteredRows;
    const out = {
      displayed: rows.length,
      scheduled: 0,
      confirmed: 0,
      missing: 0,
      upcoming: 0,
      lateMinutes: 0,
      earlyMinutes: 0,
    };
    rows.forEach((r) => {
      if (r.is_scheduled) out.scheduled += 1;
      if (r.status_code === "confirmed") out.confirmed += 1;
      if (r.is_missing) out.missing += 1;
      if (r.status_code === "upcoming") out.upcoming += 1;
      out.lateMinutes += Number(r.late_minutes || 0) || 0;
      out.earlyMinutes += Number(r.early_minutes || 0) || 0;
    });
    return out;
  }, [filteredRows]);

  const sellerOptions = useMemo(() => {
    if (Array.isArray(sellerList) && sellerList.length) return sellerList;
    const direct = Array.isArray(data.sellers) ? data.sellers : [];
    if (direct.length) return direct;
    const map = new Map();
    for (const r of Array.isArray(data.rows) ? data.rows : []) {
      if (!r?.seller_id) continue;
      if (!map.has(r.seller_id)) map.set(r.seller_id, { id: r.seller_id, full_name: r.seller_name || r.seller_id });
    }
    return Array.from(map.values()).sort((a, b) => String(a.full_name || "").localeCompare(String(b.full_name || ""), "fr"));
  }, [data.sellers, data.rows, sellerList]);

  const sellerChips = useMemo(() => sellerOptions || [], [sellerOptions]);

  const scheduledRows = useMemo(
    () => filteredRows.filter((r) => r.is_scheduled),
    [filteredRows]
  );

  const todayRoster = useMemo(() => {
    return scheduledRows
      .map((row) => {
        let kind = "upcoming";
        if (row.is_missing) kind = "missing";
        else if (Number(row.late_minutes || 0) > 0) kind = "late";
        else if (row.status_code === "confirmed") kind = "ok";
        return {
          key: row.key,
          seller_name: row.seller_name || "-",
          shift_label: row.shift_label || "-",
          planned_time: row.planned_time || "-",
          actual_time: row.actual_time || "",
          late_minutes: Number(row.late_minutes || 0) || 0,
          status_label: row.status_label || "-",
          kind,
        };
      })
      .sort((a, b) => String(a.seller_name).localeCompare(String(b.seller_name), "fr", { sensitivity: "base" }));
  }, [scheduledRows]);

  return (
    <>
      <Head>
        <title>Admin • Historique pointage</title>
      </Head>

      <div style={{ minHeight: "100vh", background: "#f8fafc", padding: 16 }}>
        <div style={{ maxWidth: 1500, margin: "0 auto", display: "grid", gap: 16 }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a" }}>Historique pointage</div>
              <div style={{ color: "#475569", marginTop: 4 }}>
                Voir qui a pointé, à quelle heure, et repérer immédiatement les pointages manquants.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Link href="/admin" legacyBehavior>
                <a className="btn" style={{ textDecoration: "none" }}>← Retour admin</a>
              </Link>
              <button className="btn" type="button" onClick={loadHistory} disabled={busy}>
                {busy ? "Chargement..." : "Rafraîchir"}
              </button>
            </div>
          </div>

          <div style={{ ...cardStyle(), display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", alignItems: "end" }}>
              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Mois / année</span>
                <input
                  type="month"
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #cbd5e1", background: "#fff" }}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Jour précis (optionnel)</span>
                <input
                  type="date"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #cbd5e1", background: "#fff" }}
                />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "#334155" }}>Vendeuse</span>
                <select
                  value={sellerId}
                  onChange={(e) => setSellerId(e.target.value)}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #cbd5e1", background: "#fff" }}
                >
                  <option value="">Toutes les vendeuses</option>
                  {sellerOptions.map((s) => (
                    <option key={s.id} value={s.id}>{s.full_name || s.id}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 10 }}>
                <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
                <span style={{ fontSize: 14, fontWeight: 700, color: "#334155" }}>Afficher seulement les non pointés</span>
              </label>
            </div>

            <div style={{ color: "#64748b", fontSize: 14 }}>
              Période affichée : <strong style={{ color: "#0f172a" }}>{day || monthLabelFr(data.month || month)}</strong>
              {day ? <span style={{ marginLeft: 8 }}>(jour précis)</span> : <span style={{ marginLeft: 8 }}>(mois complet)</span>}
            </div>
            {err ? <div style={{ color: "#b91c1c", fontWeight: 700 }}>{err}</div> : null}
            {!err && sellerErr ? <div style={{ color: "#c2410c", fontWeight: 700 }}>{sellerErr}</div> : null}
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 13, color: "#64748b" }}>
                Vendeuses chargées : <strong style={{ color: "#0f172a" }}>{sellerChips.length}</strong>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setSellerId("")}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 999,
                    border: sellerId ? "1px solid #cbd5e1" : "1px solid #16a34a",
                    background: sellerId ? "#fff" : "#f0fdf4",
                    color: sellerId ? "#0f172a" : "#166534",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  Toutes
                </button>
                {sellerChips.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSellerId(s.id)}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      border: sellerId === s.id ? "1px solid #16a34a" : "1px solid #cbd5e1",
                      background: sellerId === s.id ? "#f0fdf4" : "#fff",
                      color: sellerId === s.id ? "#166534" : "#0f172a",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    {s.full_name || s.id}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>Lignes affichées</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a" }}>{visibleSummary.displayed}</div>
            </div>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>{day ? "Prévues ce jour" : "Shifts planifiés"}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#0f172a" }}>{visibleSummary.scheduled}</div>
            </div>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>{day ? "Ont pointé" : "Pointages confirmés"}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#047857" }}>{visibleSummary.confirmed}</div>
            </div>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>{day ? "Manquantes" : "Non pointés"}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#b91c1c" }}>{visibleSummary.missing}</div>
            </div>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>Retard cumulé</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#c2410c" }}>{fmtMinutes(visibleSummary.lateMinutes)}</div>
            </div>
            <div style={cardStyle()}>
              <div style={{ fontSize: 13, color: "#64748b" }}>Avance cumulée</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: "#1d4ed8" }}>{fmtMinutes(visibleSummary.earlyMinutes)}</div>
            </div>
          </div>


          {day ? (
            <div style={{ ...cardStyle(), display: "grid", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#0f172a" }}>Vendeuses prévues le {day}</div>
                  <div style={{ color: "#64748b", fontSize: 14, marginTop: 4 }}>
                    Vue rapide du jour : pointées, en retard, ou encore manquantes.
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#64748b" }}>
                  Total prévues : <strong style={{ color: "#0f172a" }}>{todayRoster.length}</strong>
                </div>
              </div>

              {todayRoster.length === 0 ? (
                <div style={{ color: "#64748b", fontSize: 14 }}>
                  Aucune vendeuse planifiée pour cette journée avec les filtres actuels.
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {todayRoster.map((item) => {
                    const badge = miniBadgeStyle(item.kind);
                    return (
                      <div
                        key={item.key}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          flexWrap: "wrap",
                          padding: 12,
                          borderRadius: 14,
                          border: `1px solid ${badge.border}`,
                          background: badge.background,
                        }}
                      >
                        <div style={{ display: "grid", gap: 4 }}>
                          <div style={{ fontWeight: 800, color: "#0f172a" }}>{item.seller_name}</div>
                          <div style={{ color: "#475569", fontSize: 14 }}>
                            {item.shift_label} • prévu {item.planned_time}
                            {item.actual_time ? ` • pointé ${item.actual_time}` : ""}
                          </div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {item.late_minutes > 0 ? (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                padding: "6px 10px",
                                borderRadius: 999,
                                border: "1px solid #fdba74",
                                background: "#fff7ed",
                                color: "#c2410c",
                                fontWeight: 800,
                              }}
                            >
                              Retard {fmtMinutes(item.late_minutes)}
                            </span>
                          ) : null}
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              padding: "6px 10px",
                              borderRadius: 999,
                              border: `1px solid ${badge.border}`,
                              background: "#fff",
                              color: badge.color,
                              fontWeight: 800,
                            }}
                          >
                            {item.status_label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          <div style={{ ...cardStyle(), padding: 0, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: "1px solid #e5e7eb", fontWeight: 800, color: "#0f172a" }}>
              Tableau pointage
            </div>
            <div style={{ overflowX: "auto" }}>
              <div style={{ padding: "0 16px 12px", color: "#64748b", fontSize: 14 }}>
                {day ? "Le tableau ci-dessous affiche uniquement la journée sélectionnée." : "Le tableau ci-dessous affiche tout le mois sélectionné."}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: "#f8fafc", textAlign: "left" }}>
                    <th style={th}>Date</th>
                    <th style={th}>Vendeuse</th>
                    <th style={th}>Shift</th>
                    <th style={th}>Heure prévue</th>
                    <th style={th}>Pointé à</th>
                    <th style={th}>Statut</th>
                    <th style={th}>Retard</th>
                    <th style={th}>Avance</th>
                    <th style={th}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} style={{ padding: 24, textAlign: "center", color: "#64748b" }}>
                        Aucun pointage à afficher pour ce filtre.
                      </td>
                    </tr>
                  ) : filteredRows.map((row) => {
                    const badge = statusStyle(row.status_label);
                    return (
                      <tr key={row.key} style={{ borderTop: "1px solid #eef2f7", ...rowTint(row) }}>
                        <td style={tdStrong}>{row.date_label}</td>
                        <td style={td}>{row.seller_name || "-"}</td>
                        <td style={td}>{row.shift_label || "-"}</td>
                        <td style={td}>{row.planned_time || "-"}</td>
                        <td style={td}>{row.actual_time || "-"}</td>
                        <td style={td}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 6,
                              padding: "6px 10px",
                              borderRadius: 999,
                              border: `1px solid ${badge.border}`,
                              background: badge.bg,
                              color: badge.text,
                              fontWeight: 800,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {row.status_label}
                          </span>
                        </td>
                        <td style={td}>{Number(row.late_minutes || 0) ? fmtMinutes(row.late_minutes) : "-"}</td>
                        <td style={td}>{Number(row.early_minutes || 0) ? fmtMinutes(row.early_minutes) : "-"}</td>
                        <td style={td}>{row.source_label || "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        .btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 10px 14px;
          border-radius: 12px;
          border: 1px solid #cbd5e1;
          background: #fff;
          color: #0f172a;
          font-weight: 700;
          cursor: pointer;
        }
        .btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
      `}</style>
    </>
  );
}

const th = {
  padding: "12px 14px",
  fontSize: 13,
  fontWeight: 800,
  color: "#334155",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};

const td = {
  padding: "12px 14px",
  color: "#0f172a",
  verticalAlign: "top",
};

const tdStrong = {
  ...td,
  fontWeight: 700,
};
