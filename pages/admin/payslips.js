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

function matchStatusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "matched") return "Compte trouvé";
  if (s === "needs_review") return "À vérifier";
  if (s === "unmatched") return "Non rattaché";
  return s || "En attente";
}

function matchStatusBg(status) {
  const s = String(status || "").toLowerCase();
  if (s === "matched") return "#16a34a";
  if (s === "needs_review") return "#f59e0b";
  if (s === "unmatched") return "#6b7280";
  return "#64748b";
}

function fmtNum(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n - Math.round(n)) < 1e-9 ? String(Math.round(n)) : n.toFixed(2);
}

function leaveBalanceSummary(balance) {
  const b = balance || null;
  if (!b) return "Non détecté";
  const remN1 = fmtNum(b.cp_remaining_n1);
  const remN = fmtNum(b.cp_remaining_n);
  return `Solde N-1 : ${remN1} j · Solde N : ${remN} j`;
}


function individualPdfLabel(storagePath) {
  return storagePath ? "PDF individuel créé" : "PDF individuel à créer";
}


function leaveBalanceCorrectionSummary(balance) {
  const b = balance || null;
  if (!b) return "Compteurs de congés non détectés.";
  return `Solde N-1 : ${fmtNum(b.cp_remaining_n1)} j · Solde N : ${fmtNum(b.cp_remaining_n)} j`;
}

function confidenceLabel(score) {
  const n = Number(score || 0);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${Math.round(n)}%`;
}


function leaveBalanceSyncStatusLabel(status) {
  const s = String(status || "").toLowerCase();
  if (s === "up_to_date") return "Déjà à jour";
  if (s === "current_newer") return "Solde actuel plus récent";
  if (s === "missing_balance") return "À créer";
  if (s === "needs_update") return "À mettre à jour";
  return "À vérifier";
}

function leaveBalanceSyncStatusStyle(status) {
  const s = String(status || "").toLowerCase();
  if (s === "up_to_date") return { backgroundColor: "#16a34a", color: "#fff" };
  if (s === "current_newer") return { backgroundColor: "#6b7280", color: "#fff" };
  if (s === "missing_balance") return { backgroundColor: "#2563eb", color: "#fff" };
  if (s === "needs_update") return { backgroundColor: "#f59e0b", color: "#111827" };
  return { backgroundColor: "#64748b", color: "#fff" };
}

function fmtLeaveBalanceCompact(balance) {
  const b = balance || null;
  if (!b) return "—";
  return `N-1 ${fmtNum(b.cp_remaining_n1)} j · N ${fmtNum(b.cp_remaining_n)} j`;
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
  const [autoProcessStep, setAutoProcessStep] = useState("");

  const [analysisByBatch, setAnalysisByBatch] = useState({});
  const [analysisBusyByBatch, setAnalysisBusyByBatch] = useState({});
  const [analysisErrByBatch, setAnalysisErrByBatch] = useState({});

  const [splitBusyByBatch, setSplitBusyByBatch] = useState({});
  const [splitErrByBatch, setSplitErrByBatch] = useState({});
  const [splitMsgByBatch, setSplitMsgByBatch] = useState({});

  const [openBusyByPayslip, setOpenBusyByPayslip] = useState({});

  const [correctionFile, setCorrectionFile] = useState(null);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [correctionConfirmBusy, setCorrectionConfirmBusy] = useState(false);
  const [correctionErr, setCorrectionErr] = useState("");
  const [correctionMsg, setCorrectionMsg] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState(null);

  const [leaveBalanceRows, setLeaveBalanceRows] = useState([]);
  const [leaveBalanceLoading, setLeaveBalanceLoading] = useState(false);
  const [leaveBalanceErr, setLeaveBalanceErr] = useState("");
  const [leaveBalanceMsg, setLeaveBalanceMsg] = useState("");
  const [leaveBalanceApplyBusy, setLeaveBalanceApplyBusy] = useState({});
  const [leaveBalanceApplyAllBusy, setLeaveBalanceApplyAllBusy] = useState(false);

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
    if (!session) return;
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

  const loadLeaveBalanceSuggestions = useCallback(async () => {
    if (!session) return;
    setLeaveBalanceErr("");
    setLeaveBalanceLoading(true);

    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/leave-balances", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      setLeaveBalanceRows(Array.isArray(j?.rows) ? j.rows : []);
    } catch (e) {
      setLeaveBalanceRows([]);
      setLeaveBalanceErr(e?.message || "Impossible de charger les soldes issus des bulletins.");
    } finally {
      setLeaveBalanceLoading(false);
    }
  }, [session, authToken]);

  useEffect(() => {
    loadLeaveBalanceSuggestions();
  }, [loadLeaveBalanceSuggestions]);

  const applyLeaveBalanceFromPayslip = useCallback(
    async (sellerId) => {
      const seller_id = String(sellerId || "").trim();
      if (!seller_id) return;

      setLeaveBalanceErr("");
      setLeaveBalanceMsg("");
      setLeaveBalanceApplyBusy((prev) => ({ ...(prev || {}), [seller_id]: true }));

      try {
        const token = await authToken();
        const resp = await fetch("/api/admin/payslips/leave-balances", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ seller_id }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        const applied = Number(j?.applied_count || 0) || 0;
        setLeaveBalanceMsg(
          applied > 0
            ? "✅ Solde de congés mis à jour depuis le dernier bulletin disponible."
            : "ℹ️ Aucun changement à appliquer."
        );

        await loadLeaveBalanceSuggestions();
      } catch (e) {
        setLeaveBalanceErr(e?.message || "Impossible de mettre à jour ce solde.");
      } finally {
        setLeaveBalanceApplyBusy((prev) => ({ ...(prev || {}), [seller_id]: false }));
      }
    },
    [authToken, loadLeaveBalanceSuggestions]
  );

  const applyAllLeaveBalancesFromPayslips = useCallback(async () => {
    const candidates = (leaveBalanceRows || []).filter((row) => row?.can_apply === true);
    if (!candidates.length) {
      setLeaveBalanceMsg("ℹ️ Aucun solde à appliquer.");
      return;
    }

    if (typeof window !== "undefined") {
      const ok = window.confirm(
        `Appliquer les soldes de congés lus sur les derniers bulletins pour ${candidates.length} vendeuse${candidates.length > 1 ? "s" : ""} ?`
      );
      if (!ok) return;
    }

    setLeaveBalanceErr("");
    setLeaveBalanceMsg("");
    setLeaveBalanceApplyAllBusy(true);

    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/leave-balances", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ apply_all: true }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      const applied = Number(j?.applied_count || 0) || 0;
      setLeaveBalanceMsg(
        applied > 0
          ? `✅ ${applied} solde${applied > 1 ? "s" : ""} de congés mis à jour depuis les derniers bulletins.`
          : "ℹ️ Aucun changement à appliquer."
      );

      await loadLeaveBalanceSuggestions();
    } catch (e) {
      setLeaveBalanceErr(e?.message || "Impossible d'appliquer les soldes détectés.");
    } finally {
      setLeaveBalanceApplyAllBusy(false);
    }
  }, [leaveBalanceRows, authToken, loadLeaveBalanceSuggestions]);

  const onSubmit = useCallback(async () => {
    setMsg("");
    setErr("");
    setAutoProcessStep("");

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

      const batchId = String(j?.row?.id || "").trim();
      if (!batchId) {
        throw new Error("Import enregistré, mais identifiant du lot introuvable.");
      }

      setImports((prev) => {
        const current = Array.isArray(prev) ? prev : [];
        const withoutSame = current.filter((x) => String(x?.id || "") !== batchId);
        return [j.row, ...withoutSame];
      });

      setAutoProcessStep("Analyse automatique du PDF en cours…");
      setMsg("✅ PDF global importé. Analyse automatique en cours…");

      const analyzeResp = await fetch("/api/admin/payslips/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ batch_id: batchId }),
      });
      const analyzeJson = await analyzeResp.json().catch(() => ({}));
      if (!analyzeResp.ok || analyzeJson?.ok === false) {
        throw new Error(
          `PDF importé, mais l’analyse automatique a échoué : ${analyzeJson?.error || `Erreur API (${analyzeResp.status})`}`
        );
      }

      setAnalysisByBatch((prev) => ({
        ...(prev || {}),
        [batchId]: Array.isArray(analyzeJson?.items) ? analyzeJson.items : [],
      }));

      setAutoProcessStep("Création des PDF individuels en cours…");
      setMsg("✅ Analyse terminée. Création automatique des fiches individuelles…");

      const splitResp = await fetch("/api/admin/payslips/split", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ batch_id: batchId }),
      });
      const splitJson = await splitResp.json().catch(() => ({}));
      if (!splitResp.ok || splitJson?.ok === false) {
        throw new Error(
          `PDF analysé, mais la création des fiches individuelles a échoué : ${splitJson?.error || `Erreur API (${splitResp.status})`}`
        );
      }

      if (Array.isArray(splitJson?.items)) {
        setAnalysisByBatch((prev) => ({
          ...(prev || {}),
          [batchId]: splitJson.items,
        }));
      }

      const created = Number(splitJson?.created_count || 0) || 0;
      const skipped = Number(splitJson?.skipped_count || 0) || 0;
      const analyzed = Array.isArray(analyzeJson?.items) ? analyzeJson.items.length : 0;

      setMsg(
        `✅ Import terminé automatiquement : ${analyzed} fiche${analyzed > 1 ? "s" : ""} analysée${analyzed > 1 ? "s" : ""}, ${created} PDF individuel${created > 1 ? "s" : ""} créé${created > 1 ? "s" : ""}${skipped ? `, ${skipped} déjà présent${skipped > 1 ? "s" : ""}` : ""}.`
      );

      setFile(null);
      const input = document.getElementById("payslip-file-input");
      if (input) input.value = "";
      await Promise.all([loadImports(), loadLeaveBalanceSuggestions()]);
    } catch (e) {
      setErr(e?.message || "Import impossible.");
    } finally {
      setBusy(false);
      setAutoProcessStep("");
    }
  }, [month, file, authToken, loadImports, loadLeaveBalanceSuggestions]);

  const runAnalysis = useCallback(
    async (batchId) => {
      const id = String(batchId || "");
      if (!id) return;

      setAnalysisBusyByBatch((prev) => ({ ...(prev || {}), [id]: true }));
      setAnalysisErrByBatch((prev) => ({ ...(prev || {}), [id]: "" }));

      try {
        const token = await authToken();
        const resp = await fetch("/api/admin/payslips/analyze", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ batch_id: id }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        setAnalysisByBatch((prev) => ({
          ...(prev || {}),
          [id]: Array.isArray(j?.items) ? j.items : [],
        }));

        await Promise.all([loadImports(), loadLeaveBalanceSuggestions()]);
      } catch (e) {
        setAnalysisErrByBatch((prev) => ({
          ...(prev || {}),
          [id]: e?.message || "Analyse impossible.",
        }));
      } finally {
        setAnalysisBusyByBatch((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken, loadImports, loadLeaveBalanceSuggestions]
  );

  const loadExistingAnalysis = useCallback(
    async (batchId) => {
      const id = String(batchId || "");
      if (!id) return;

      setAnalysisBusyByBatch((prev) => ({ ...(prev || {}), [id]: true }));
      setAnalysisErrByBatch((prev) => ({ ...(prev || {}), [id]: "" }));

      try {
        const token = await authToken();
        const qs = new URLSearchParams({ batch_id: id });
        const resp = await fetch(`/api/admin/payslips/analyze?${qs.toString()}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        setAnalysisByBatch((prev) => ({
          ...(prev || {}),
          [id]: Array.isArray(j?.items) ? j.items : [],
        }));
      } catch (e) {
        setAnalysisErrByBatch((prev) => ({
          ...(prev || {}),
          [id]: e?.message || "Impossible de charger l’analyse.",
        }));
      } finally {
        setAnalysisBusyByBatch((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken]
  );


  const createIndividualPdfs = useCallback(
    async (batchId) => {
      const id = String(batchId || "");
      if (!id) return;

      setSplitBusyByBatch((prev) => ({ ...(prev || {}), [id]: true }));
      setSplitErrByBatch((prev) => ({ ...(prev || {}), [id]: "" }));
      setSplitMsgByBatch((prev) => ({ ...(prev || {}), [id]: "" }));

      try {
        const token = await authToken();
        const resp = await fetch("/api/admin/payslips/split", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ batch_id: id }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        const created = Number(j?.created_count || 0) || 0;
        const skipped = Number(j?.skipped_count || 0) || 0;
        setSplitMsgByBatch((prev) => ({
          ...(prev || {}),
          [id]: `✅ ${created} PDF individuel${created > 1 ? "s" : ""} créé${created > 1 ? "s" : ""}${skipped ? ` · ${skipped} déjà présent${skipped > 1 ? "s" : ""}` : ""}.`,
        }));

        if (Array.isArray(j?.items)) {
          setAnalysisByBatch((prev) => ({
            ...(prev || {}),
            [id]: j.items,
          }));
        } else {
          await loadExistingAnalysis(id);
        }

        await Promise.all([loadImports(), loadLeaveBalanceSuggestions()]);
      } catch (e) {
        setSplitErrByBatch((prev) => ({
          ...(prev || {}),
          [id]: e?.message || "Découpage impossible.",
        }));
      } finally {
        setSplitBusyByBatch((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken, loadExistingAnalysis, loadImports]
  );

  const openPayslipPdf = useCallback(
    async (payslipId) => {
      const id = String(payslipId || "");
      if (!id) return;

      setErr("");
      setOpenBusyByPayslip((prev) => ({ ...(prev || {}), [id]: true }));

      try {
        const token = await authToken();
        const resp = await fetch("/api/payslips/open", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ payslip_id: id }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur API (${resp.status})`);
        }

        const url = String(j?.url || "").trim();
        if (!url) throw new Error("Lien PDF introuvable.");

        const popup = window.open(url, "_blank", "noopener,noreferrer");
        if (!popup) {
          window.location.href = url;
        }
      } catch (e) {
        setErr(e?.message || "Impossible d'ouvrir le PDF.");
      } finally {
        setOpenBusyByPayslip((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken]
  );


  const previewCorrectedPayslip = useCallback(async () => {
    setCorrectionErr("");
    setCorrectionMsg("");
    setCorrectionPreview(null);

    if (!correctionFile) {
      setCorrectionErr("Choisis le PDF corrigé reçu du comptable.");
      return;
    }

    const fileName = String(correctionFile.name || "").toLowerCase();
    const isPdf = correctionFile.type === "application/pdf" || fileName.endsWith(".pdf");
    if (!isPdf) {
      setCorrectionErr("Le fichier corrigé doit être un PDF.");
      return;
    }

    setCorrectionBusy(true);

    try {
      const originalName = safeFileName(correctionFile.name || "fiche-corrigee.pdf");
      const storagePath = `correction-drafts/${randomPart()}-${originalName}`;

      const { error: uploadErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, correctionFile, {
        cacheControl: "3600",
        contentType: "application/pdf",
        upsert: false,
      });

      if (uploadErr) {
        throw new Error(uploadErr.message || "Upload du PDF corrigé impossible.");
      }

      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/corrections/preview", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          storage_path: storagePath,
          original_filename: correctionFile.name || originalName,
          original_file_size: Number(correctionFile.size || 0) || null,
          original_mime_type: correctionFile.type || "application/pdf",
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      setCorrectionPreview(j?.preview || null);
      setCorrectionMsg("✅ Fiche corrigée analysée. Vérifie puis confirme son remplacement.");
    } catch (e) {
      setCorrectionErr(e?.message || "Analyse du PDF corrigé impossible.");
    } finally {
      setCorrectionBusy(false);
    }
  }, [correctionFile, authToken]);

  const confirmCorrectedPayslip = useCallback(async () => {
    const preview = correctionPreview || null;
    if (!preview?.storage_path) {
      setCorrectionErr("Aucune fiche corrigée prête à valider.");
      return;
    }

    if (!preview?.employee_user_id) {
      setCorrectionErr("La salariée n'a pas été reconnue avec assez de certitude. Confirmation bloquée pour éviter une mauvaise attribution.");
      return;
    }

    const existingCount = Number(preview?.existing_count || 0) || 0;
    const person = preview?.matched_profile_name || preview?.employee_display_name || "ce salarié";
    const monthLabel = preview?.payroll_month_label || preview?.payroll_month || "ce mois";

    if (typeof window !== "undefined") {
      const text = existingCount > 0
        ? `Une fiche existe déjà pour ${person} (${monthLabel}). La version corrigée deviendra celle visible dans son espace. Continuer ?`
        : `Importer cette fiche corrigée pour ${person} (${monthLabel}) ?`;
      const ok = window.confirm(text);
      if (!ok) return;
    }

    setCorrectionErr("");
    setCorrectionMsg("");
    setCorrectionConfirmBusy(true);

    try {
      const token = await authToken();
      const resp = await fetch("/api/admin/payslips/corrections/confirm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          storage_path: preview.storage_path,
          original_filename: preview.original_filename,
          original_file_size: preview.original_file_size,
          original_mime_type: preview.original_mime_type,
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur API (${resp.status})`);
      }

      const importedName = j?.result?.matched_profile_name || person;
      const importedMonth = j?.result?.payroll_month_label || monthLabel;
      const replaced = Number(j?.result?.existing_count_before || 0) > 0;

      setCorrectionMsg(
        replaced
          ? `✅ Fiche corrigée importée pour ${importedName} (${importedMonth}). Elle devient la version affichée dans son espace salarié.`
          : `✅ Fiche de paie importée pour ${importedName} (${importedMonth}).`
      );

      setCorrectionPreview(null);
      setCorrectionFile(null);
      const input = document.getElementById("corrected-payslip-file-input");
      if (input) input.value = "";

      await loadImports();
    } catch (e) {
      setCorrectionErr(e?.message || "Validation de la fiche corrigée impossible.");
    } finally {
      setCorrectionConfirmBusy(false);
    }
  }, [correctionPreview, authToken, loadImports, loadLeaveBalanceSuggestions]);


  return (
    <div className="p-4 max-w-6xl mx-auto space-y-5">
      <Head>
        <title>Import fiches de paie</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="hdr">Import fiches de paie</div>
          <div className="text-sm text-gray-600">
            Import intelligent : un seul clic suffit pour analyser le PDF global et créer automatiquement les bulletins individuels.
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
          Dépose le PDF global reçu du comptable. L’application l’importe, l’analyse et crée automatiquement les fiches individuelles. Les boutons manuels restent disponibles plus bas pour relancer un ancien lot.
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
        {autoProcessStep ? (
          <div
            className="mt-3 text-sm"
            style={{
              padding: "10px 12px",
              borderRadius: 14,
              border: "1px solid #bfdbfe",
              background: "#eff6ff",
              color: "#1d4ed8",
              fontWeight: 600,
            }}
          >
            {autoProcessStep}
          </div>
        ) : null}

        <div className="mt-4">
          <button
            type="button"
            className="btn"
            onClick={onSubmit}
            disabled={busy}
            style={{
              backgroundColor: busy ? "#9ca3af" : "#16a34a",
              color: "#fff",
              borderColor: "transparent",
              opacity: busy ? 0.75 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Import en cours..." : "Importer le PDF"}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="hdr mb-2">Importer une fiche corrigée</div>
        <div className="text-sm text-gray-600 mb-4">
          À utiliser si le comptable renvoie une fiche de paie isolée après correction.
          L’application détecte automatiquement le salarié et le mois indiqués sur le bulletin,
          puis te demande confirmation avant de rendre cette version prioritaire.
        </div>

        <div className="grid md:grid-cols-2 gap-3 items-end">
          <div className="md:col-span-2">
            <div className="text-sm mb-1">PDF corrigé isolé</div>
            <input
              id="corrected-payslip-file-input"
              type="file"
              accept="application/pdf,.pdf"
              className="input"
              onChange={(e) => {
                setCorrectionFile(e.target.files?.[0] || null);
                setCorrectionErr("");
                setCorrectionMsg("");
                setCorrectionPreview(null);
              }}
              disabled={correctionBusy || correctionConfirmBusy}
            />
          </div>
        </div>

        {correctionFile ? (
          <div className="mt-3 text-sm text-gray-700">
            Fichier sélectionné : <span className="font-medium">{correctionFile.name}</span> · {humanBytes(correctionFile.size)}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={previewCorrectedPayslip}
            disabled={correctionBusy || correctionConfirmBusy}
            style={{
              backgroundColor: correctionBusy ? "#9ca3af" : "#7c3aed",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {correctionBusy ? "Analyse..." : "Analyser la fiche corrigée"}
          </button>
        </div>

        {correctionErr ? <div className="mt-3 text-sm text-red-600">{correctionErr}</div> : null}
        {correctionMsg ? <div className="mt-3 text-sm text-green-700">{correctionMsg}</div> : null}

        {correctionPreview ? (
          <div
            className="mt-4 border rounded-2xl p-3"
            style={{ background: "#faf5ff", borderColor: "#e9d5ff" }}
          >
            <div className="font-medium text-sm mb-2">Résultat détecté</div>

            <div className="grid md:grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-gray-500">Salarié lu sur le bulletin</div>
                <div className="font-medium">{correctionPreview.employee_display_name || "—"}</div>
              </div>

              <div>
                <div className="text-xs text-gray-500">Compte proposé dans l’application</div>
                <div className="font-medium">{correctionPreview.matched_profile_name || "Aucun compte reconnu"}</div>
              </div>

              <div>
                <div className="text-xs text-gray-500">Mois détecté</div>
                <div className="font-medium">{correctionPreview.payroll_month_label || correctionPreview.payroll_month || "—"}</div>
              </div>

              <div>
                <div className="text-xs text-gray-500">Confiance de rapprochement</div>
                <div className="font-medium">{confidenceLabel(correctionPreview.match_confidence)}</div>
              </div>

              <div className="md:col-span-2">
                <div className="text-xs text-gray-500">Congés lus sur le bulletin</div>
                <div className="font-medium">{leaveBalanceCorrectionSummary(correctionPreview.extracted_leave_balance)}</div>
              </div>
            </div>

            <div className="mt-3 text-sm">
              {Number(correctionPreview.existing_count || 0) > 0 ? (
                <span style={{ color: "#b45309", fontWeight: 600 }}>
                  Une fiche existe déjà pour ce salarié et ce mois. Cette correction deviendra la version visible dans son espace, sans supprimer l’archive.
                </span>
              ) : (
                <span style={{ color: "#166534", fontWeight: 600 }}>
                  Aucune fiche existante détectée pour ce salarié sur ce mois. Elle sera ajoutée.
                </span>
              )}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn"
                onClick={confirmCorrectedPayslip}
                disabled={correctionConfirmBusy || !correctionPreview.employee_user_id}
                style={{
                  backgroundColor: correctionConfirmBusy || !correctionPreview.employee_user_id ? "#9ca3af" : "#16a34a",
                  color: "#fff",
                  borderColor: "transparent",
                }}
              >
                {correctionConfirmBusy ? "Validation..." : "Valider l’import corrigé"}
              </button>

              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCorrectionPreview(null);
                  setCorrectionMsg("");
                  setCorrectionErr("");
                }}
                disabled={correctionConfirmBusy}
              >
                Annuler
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-3">
          <div>
            <div className="hdr">Soldes de congés à valider</div>
            <div className="text-sm text-gray-600">
              L’application prend le dernier bulletin disponible de chaque vendeuse reconnue,
              compare le solde lu sur la fiche avec le solde actuellement affiché dans le module Congés,
              puis te laisse valider l’écriture. Rien n’est remplacé sans ton accord.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button className="btn" type="button" onClick={loadLeaveBalanceSuggestions} disabled={leaveBalanceLoading || leaveBalanceApplyAllBusy}>
              {leaveBalanceLoading ? "Chargement..." : "Rafraîchir"}
            </button>
            <button
              className="btn"
              type="button"
              onClick={applyAllLeaveBalancesFromPayslips}
              disabled={leaveBalanceApplyAllBusy || !(leaveBalanceRows || []).some((row) => row?.can_apply === true)}
              style={{
                backgroundColor: leaveBalanceApplyAllBusy ? "#9ca3af" : "#16a34a",
                color: "#fff",
                borderColor: "transparent",
              }}
            >
              {leaveBalanceApplyAllBusy ? "Application..." : "Tout appliquer"}
            </button>
          </div>
        </div>

        {leaveBalanceErr ? <div className="text-sm text-red-600 mb-2">{leaveBalanceErr}</div> : null}
        {leaveBalanceMsg ? <div className="text-sm text-green-700 mb-2">{leaveBalanceMsg}</div> : null}

        {leaveBalanceLoading ? (
          <div className="text-sm text-gray-600">Chargement des soldes détectés…</div>
        ) : !leaveBalanceRows.length ? (
          <div className="text-sm text-gray-600">
            Aucun solde de congés exploitable n’a encore été détecté dans les fiches importées.
          </div>
        ) : (
          <div className="space-y-3">
            {leaveBalanceRows.map((row) => {
              const sellerId = String(row?.seller_id || "");
              const busy = !!leaveBalanceApplyBusy?.[sellerId];
              const statusStyle = leaveBalanceSyncStatusStyle(row?.status);
              return (
                <div key={sellerId} className="border rounded-2xl p-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="text-sm">
                    <div className="font-medium">{row?.full_name || "Vendeuse"}</div>
                    <div className="text-gray-600">
                      Dernier bulletin : {row?.payroll_month_label || row?.payroll_month || "—"} · Solde lu : {fmtLeaveBalanceCompact(row?.payslip_balance)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Solde actuellement affiché : {fmtLeaveBalanceCompact(row?.current_balance)}
                      {row?.current_balance?.as_of ? ` · au ${row.current_balance.as_of}` : ""}
                    </div>
                    {row?.status === "current_newer" ? (
                      <div className="text-xs mt-1" style={{ color: "#6b7280", fontWeight: 700 }}>
                        Le solde actuellement affiché est plus récent que ce bulletin. Aucune écriture automatique proposée.
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs px-2 py-1 rounded-full" style={statusStyle}>
                      {leaveBalanceSyncStatusLabel(row?.status)}
                    </span>

                    {row?.can_apply ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => applyLeaveBalanceFromPayslip(sellerId)}
                        disabled={busy || leaveBalanceApplyAllBusy}
                        style={{
                          backgroundColor: busy ? "#9ca3af" : "#2563eb",
                          color: "#fff",
                          borderColor: "transparent",
                        }}
                      >
                        {busy ? "Application..." : "Appliquer"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <div className="hdr">Derniers imports</div>
            <div className="text-xs text-gray-500">
              Lance l’analyse sur le lot d’avril importé. L’application repère les pages, les noms et les compteurs de congés.
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
          <div className="space-y-3">
            {imports.map((row) => {
              const batchId = String(row.id || "");
              const analysis = Array.isArray(analysisByBatch?.[batchId]) ? analysisByBatch[batchId] : null;
              const analysisBusy = !!analysisBusyByBatch?.[batchId];
              const analysisErr = String(analysisErrByBatch?.[batchId] || "");
              const splitBusy = !!splitBusyByBatch?.[batchId];
              const splitErr = String(splitErrByBatch?.[batchId] || "");
              const splitMsg = String(splitMsgByBatch?.[batchId] || "");

              return (
                <div key={row.id} className="border rounded-2xl p-3 space-y-3">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div className="text-sm">
                      <div className="font-medium">{row.original_filename || "Bulletins de paie"}</div>
                      <div className="text-gray-600">
                        Mois : {String(row.payroll_month || "").slice(0, 7)} · Importé le {formatDateTime(row.created_at)}
                      </div>
                      <div className="text-xs text-gray-500">
                        {humanBytes(row.original_file_size)} · {row.original_storage_path || "—"}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="text-xs px-2 py-1 rounded-full text-white self-start md:self-auto"
                        style={{ backgroundColor: statusBg(row.status) }}
                      >
                        {statusLabel(row.status)}
                      </span>

                      <button
                        type="button"
                        className="btn"
                        onClick={() => runAnalysis(batchId)}
                        disabled={analysisBusy}
                        style={{
                          backgroundColor: analysisBusy ? "#9ca3af" : "#2563eb",
                          color: "#fff",
                          borderColor: "transparent",
                        }}
                      >
                        {analysisBusy ? "Analyse..." : "Analyser le PDF"}
                      </button>

                      <button
                        type="button"
                        className="btn"
                        onClick={() => loadExistingAnalysis(batchId)}
                        disabled={analysisBusy || splitBusy}
                      >
                        Voir l’analyse
                      </button>

                      <button
                        type="button"
                        className="btn"
                        onClick={() => createIndividualPdfs(batchId)}
                        disabled={analysisBusy || splitBusy}
                        style={{
                          backgroundColor: splitBusy ? "#9ca3af" : "#7c3aed",
                          color: "#fff",
                          borderColor: "transparent",
                        }}
                      >
                        {splitBusy ? "Création..." : "Créer les PDF individuels"}
                      </button>
                    </div>
                  </div>

                  {analysisErr ? <div className="text-sm text-red-600">{analysisErr}</div> : null}
                  {splitErr ? <div className="text-sm text-red-600">{splitErr}</div> : null}
                  {splitMsg ? <div className="text-sm text-green-700">{splitMsg}</div> : null}

                  {analysis ? (
                    <div className="border rounded-2xl p-3 bg-gray-50">
                      <div className="font-medium text-sm mb-2">
                        Résultat de l’analyse : {analysis.length} page{analysis.length > 1 ? "s" : ""} détectée{analysis.length > 1 ? "s" : ""}
                      </div>

                      {analysis.length === 0 ? (
                        <div className="text-sm text-gray-600">Aucune fiche analysée pour ce lot.</div>
                      ) : (
                        <div className="space-y-2">
                          {analysis.map((it) => (
                            <div
                              key={it.id || `${batchId}-${it.original_page_start}`}
                              className="bg-white border rounded-2xl p-3 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3"
                            >
                              <div className="text-sm">
                                <div className="font-medium">
                                  Page {it.original_page_start || "?"} · {it.employee_display_name || "Nom non détecté"}
                                </div>
                                <div className="text-gray-600">
                                  Compte proposé : {it.matched_profile_name || "Aucun compte existant détecté"}
                                </div>
                                <div className="text-xs text-gray-500">
                                  {it.job_title ? `Emploi : ${it.job_title} · ` : ""}
                                  {leaveBalanceSummary(it.extracted_leave_balance)}
                                </div>
                                <div className="text-xs" style={{ color: it.storage_path ? "#15803d" : "#64748b" }}>
                                  {individualPdfLabel(it.storage_path)}
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className="text-xs px-2 py-1 rounded-full text-white"
                                  style={{ backgroundColor: matchStatusBg(it.match_status) }}
                                >
                                  {matchStatusLabel(it.match_status)}
                                </span>
                                <span className="text-xs text-gray-500">
                                  Confiance : {fmtNum(it.match_confidence)}%
                                </span>
                                {it.storage_path ? (
                                  <button
                                    type="button"
                                    className="btn"
                                    onClick={() => openPayslipPdf(it.id)}
                                    disabled={!!openBusyByPayslip?.[String(it.id || "")]}
                                    style={{
                                      backgroundColor: "#0f766e",
                                      color: "#fff",
                                      borderColor: "transparent",
                                    }}
                                  >
                                    {openBusyByPayslip?.[String(it.id || "")] ? "Ouverture..." : "Voir PDF"}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
