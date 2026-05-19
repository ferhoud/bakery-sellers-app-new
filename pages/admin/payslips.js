/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";

const STORAGE_BUCKET = "employee-payslips";

function monthInputValue(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function payrollMonthIso(monthValue) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(monthValue || "").trim());
  if (!m) return "";
  return `${m[1]}-${m[2]}-01`;
}

function safeFileName(name) {
  const base = String(name || "bulletins.pdf")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "bulletins.pdf";
}

function randomPart() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch (_) {}
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function humanBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch (_) {
    return String(iso);
  }
}

function statusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "uploaded") return "PDF importé";
  if (s === "processing") return "Analyse en cours";
  if (s === "needs_review") return "À vérifier";
  if (s === "completed") return "Terminé";
  if (s === "failed") return "Erreur";
  return s || "—";
}

function statusBg(status) {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return "#16a34a";
  if (s === "processing") return "#2563eb";
  if (s === "needs_review") return "#f59e0b";
  if (s === "failed") return "#dc2626";
  return "#6b7280";
}

export default function AdminPayslipsPage() {
  const router = useRouter();
  const { session, profile, loading } = useAuth();

  const isAdmin = useMemo(() => {
    const email = session?.user?.email || "";
    return isAdminEmail(email) || String(profile?.role || "").toLowerCase() === "admin";
  }, [session?.user?.email, profile?.role]);

  const [month, setMonth] = useState(() => monthInputValue(new Date()));
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [imports, setImports] = useState([]);
  const [importsLoading, setImportsLoading] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace("/login?stay=1&next=/admin/payslips");
      return;
    }
    if (!isAdmin) {
      router.replace("/app");
    }
  }, [loading, session, isAdmin, router]);

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }, []);

  const loadImports = useCallback(async () => {
    if (!session || !isAdmin) return;
    setImportsLoading(true);
    setErr("");
    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/imports", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }
      setImports(Array.isArray(j?.rows) ? j.rows : []);
    } catch (e) {
      setImports([]);
      setErr(e?.message || "Impossible de charger les imports.");
    } finally {
      setImportsLoading(false);
    }
  }, [session, isAdmin, authToken]);

  useEffect(() => {
    loadImports();
  }, [loadImports]);

  const onSubmit = useCallback(async () => {
    setMsg("");
    setErr("");

    const monthIso = payrollMonthIso(month);
    if (!monthIso) {
      setErr("Choisis un mois de paie valide.");
      return;
    }

    if (!file) {
      setErr("Choisis le PDF global reçu du comptable.");
      return;
    }

    const fileName = String(file.name || "").toLowerCase();
    const isPdf = file.type === "application/pdf" || fileName.endsWith(".pdf");
    if (!isPdf) {
      setErr("Le fichier doit être un PDF.");
      return;
    }

    setBusy(true);
    try {
      const originalName = safeFileName(file.name || "bulletins.pdf");
      const storagePath = `original-imports/${month}/${randomPart()}-${originalName}`;

      const { error: uploadErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, file, {
        cacheControl: "3600",
        contentType: "application/pdf",
        upsert: false,
      });

      if (uploadErr) {
        throw new Error(uploadErr.message || "Upload Supabase Storage impossible.");
      }

      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/imports", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          payroll_month: monthIso,
          original_filename: file.name || originalName,
          original_storage_path: storagePath,
          original_file_size: Number(file.size || 0) || null,
          original_mime_type: file.type || "application/pdf",
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      setMsg("✅ PDF global importé. La base est prête pour la prochaine étape : reconnaissance des salariés et découpage automatique.");
      setFile(null);
      const input = document.getElementById("payslip-file-input");
      if (input) input.value = "";
      await loadImports();
    } catch (e) {
      setErr(e?.message || "Import impossible.");
    } finally {
      setBusy(false);
    }
  }, [month, file, authToken, loadImports]);

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-5">
      <Head>
        <title>Import fiches de paie</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="hdr">Import fiches de paie</div>
          <div className="text-sm text-gray-600">
            Étape 1 : déposer le PDF global reçu du comptable dans un stockage privé.
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link href="/admin" className="btn">
            Retour admin
          </Link>
          <Link href="/leaves" className="btn">
            Congés
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="hdr mb-2">Nouvel import mensuel</div>
        <div className="text-sm text-gray-600 mb-4">
          Pour l’instant, l’application conserve le PDF original en sécurité et enregistre le lot d’import.
          Dans l’étape suivante, elle analysera le PDF, reconnaîtra les salariés et générera leurs bulletins individuels.
        </div>

        <div className="grid md:grid-cols-2 gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Mois de paie</div>
            <input
              type="month"
              className="input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              disabled={busy}
            />
          </div>

          <div>
            <div className="text-sm mb-1">PDF global du comptable</div>
            <input
              id="payslip-file-input"
              type="file"
              accept="application/pdf,.pdf"
              className="input"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={busy}
            />
          </div>
        </div>

        {file ? (
          <div className="mt-3 text-sm text-gray-700">
            Fichier sélectionné : <span className="font-medium">{file.name}</span> · {humanBytes(file.size)}
          </div>
        ) : null}

        {err ? <div className="mt-3 text-sm text-red-600">{err}</div> : null}
        {msg ? <div className="mt-3 text-sm text-green-700">{msg}</div> : null}

        <div className="mt-4">
          <button type="button" className="btn" onClick={onSubmit} disabled={busy || !session || !isAdmin}>
            {busy ? "Import en cours..." : "Importer le PDF"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="hdr">Derniers imports</div>
            <div className="text-xs text-gray-500">
              Les futurs traitements de reconnaissance et de découpage partiront de cette liste.
            </div>
          </div>
          <button type="button" className="btn" onClick={loadImports} disabled={importsLoading}>
            {importsLoading ? "Chargement..." : "Rafraîchir"}
          </button>
        </div>

        {importsLoading ? (
          <div className="text-sm text-gray-600">Chargement...</div>
        ) : imports.length === 0 ? (
          <div className="text-sm text-gray-600">Aucun PDF de paie importé pour le moment.</div>
        ) : (
          <div className="space-y-2">
            {imports.map((row) => (
              <div key={row.id} className="border rounded-2xl p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div className="text-sm">
                  <div className="font-medium">{row.original_filename || "Bulletins de paie"}</div>
                  <div className="text-gray-600">
                    Mois : {String(row.payroll_month || "").slice(0, 7)} · Importé le {formatDateTime(row.created_at)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {humanBytes(row.original_file_size)} · {row.original_storage_path || "—"}
                  </div>
                </div>

                <span
                  className="text-xs px-2 py-1 rounded-full text-white self-start md:self-auto"
                  style={{ backgroundColor: statusBg(row.status) }}
                >
                  {statusLabel(row.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
