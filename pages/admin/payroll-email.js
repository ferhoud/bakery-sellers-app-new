/* eslint-disable react/no-unescaped-entities */

import Head from "next/head";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";
import { isAdminEmail } from "@/lib/admin";

function currentMonthValue(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function statusPill(text, bg, color = "#fff") {
  return (
    <span
      className="text-xs px-2 py-1 rounded-full"
      style={{ backgroundColor: bg, color, fontWeight: 800 }}
    >
      {text}
    </span>
  );
}

function summaryValue(n) {
  const x = Number(n || 0) || 0;
  return x.toLocaleString("fr-FR");
}


function formatIsoDateFr(value) {
  const iso = String(value || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}


function formatDateTimeFr(value) {
  if (!value) return "";
  try {
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("fr-FR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

export default function AdminPayrollEmailPage() {
  const router = useRouter();
  const { session: hookSession, profile: hookProfile } = useAuth();

  // Même stratégie robuste que les pages /app et /leaves :
  // on relit directement la session Supabase pour éviter un hook auth parfois vide au premier rendu.
  const [sbSession, setSbSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!alive) return;
        setSbSession(data?.session ?? null);
      } finally {
        if (alive) setAuthChecked(true);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, nextSession) => {
      setSbSession(nextSession ?? null);
      setAuthChecked(true);
    });

    return () => {
      alive = false;
      try {
        sub?.subscription?.unsubscribe?.();
      } catch (_) {}
    };
  }, []);

  const session = sbSession ?? hookSession ?? null;
  const userId = session?.user?.id || null;
  const userEmail = session?.user?.email || "";

  // Fallback profil direct pour lire le rôle admin si le hook profil n'est pas encore prêt.
  const [profileFallback, setProfileFallback] = useState(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      if (!userId) {
        if (alive) setProfileFallback(null);
        return;
      }

      if (hookProfile?.user_id === userId) {
        if (alive) setProfileFallback(null);
        return;
      }

      try {
        const { data } = await supabase
          .from("profiles")
          .select("user_id, full_name, role")
          .eq("user_id", userId)
          .maybeSingle();

        if (!alive) return;
        setProfileFallback(data || null);
      } catch (_) {
        if (alive) setProfileFallback(null);
      }
    })();

    return () => {
      alive = false;
    };
  }, [userId, hookProfile]);

  const profile = hookProfile ?? profileFallback ?? null;

  const isAdmin = useMemo(() => {
    return isAdminEmail(userEmail) || String(profile?.role || "").toLowerCase() === "admin";
  }, [userEmail, profile?.role]);

  const [month, setMonth] = useState(() => currentMonthValue());
  const [preview, setPreview] = useState(null);
  const [savedDraft, setSavedDraft] = useState(null);

  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [bodyManuallyEdited, setBodyManuallyEdited] = useState(false);

  const [notesByEmployee, setNotesByEmployee] = useState({});
  const [noteBusyByEmployee, setNoteBusyByEmployee] = useState({});

  const [loadingPreview, setLoadingPreview] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [gmailDraftBusy, setGmailDraftBusy] = useState(false);
  const [robotRefreshBusy, setRobotRefreshBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");


  const [newEmployee, setNewEmployee] = useState({
    full_name: "",
    base_line: "",
    employment_start_date: "",
    employment_end_date: "",
  });
  const [employeeCreateBusy, setEmployeeCreateBusy] = useState(false);

  useEffect(() => {
    if (!authChecked) return;

    if (!userId) {
      if (typeof window !== "undefined") {
        window.location.replace("/login?stay=1&next=/admin/payroll-email");
      }
      return;
    }

    if (!isAdmin) {
      router.replace("/app");
    }
  }, [authChecked, userId, isAdmin, router]);

  const authToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || session?.access_token || "";
  }, [session?.access_token]);

  const loadPayrollEmail = useCallback(
    async (targetMonth, { keepEditedBody = false, forceRegenerateBody = false } = {}) => {
      if (!authChecked) {
        setErr("Vérification de la session en cours. Réessaie dans une seconde.");
        setMsg("");
        return;
      }

      if (!userId) {
        setErr("Session admin introuvable. Recharge la page puis reconnecte-toi si besoin.");
        setMsg("");
        return;
      }

      if (!isAdmin) {
        setErr("Le rôle administrateur n'est pas détecté sur cette page.");
        setMsg("");
        return;
      }

      setErr("");
      setMsg("");
      setLoadingPreview(true);

      try {
        const token = await authToken();
        if (!token) {
          throw new Error("Jeton de session introuvable. Recharge la page puis réessaie.");
        }

        const qs = new URLSearchParams({ month: targetMonth });
        const [previewResp, draftResp] = await Promise.all([
          fetch(`/api/admin/payroll-email/preview?${qs.toString()}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          }),
          fetch(`/api/admin/payroll-email/draft?${qs.toString()}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
            cache: "no-store",
          }),
        ]);

        const previewJson = await previewResp.json().catch(() => ({}));
        const draftJson = await draftResp.json().catch(() => ({}));

        if (!previewResp.ok || previewJson?.ok === false) {
          throw new Error(previewJson?.error || `Erreur aperçu (${previewResp.status})`);
        }
        if (!draftResp.ok || draftJson?.ok === false) {
          throw new Error(draftJson?.error || `Erreur brouillon (${draftResp.status})`);
        }

        setPreview(previewJson);
        setSavedDraft(draftJson?.row || null);

        const nextNotes = {};
        (previewJson?.employees || []).forEach((employee) => {
          nextNotes[String(employee?.id || "")] = String(employee?.manual_note || "");
        });
        setNotesByEmployee(nextNotes);

        const row = draftJson?.row || null;

        // Le mail reste "vivant" : par défaut, son texte repart toujours
        // de la version automatique la plus récente (absences, congés, notes, salariés).
        // On ne conserve un texte tapé à la main que pendant l'édition en cours,
        // sauf si l'utilisateur force explicitement une régénération.
        const preserveCurrentManualBody = keepEditedBody && bodyManuallyEdited && !forceRegenerateBody;

        if (!preserveCurrentManualBody) {
          setToEmail(String(previewJson?.to_email || row?.to_email || ""));
          setSubject(String(previewJson?.subject || row?.subject || ""));
          setBody(String(previewJson?.body || ""));
          setBodyManuallyEdited(false);
        }

        if (row?.id && preserveCurrentManualBody) {
          setMsg("Les données automatiques ont été rafraîchies. Le texte manuel en cours a été conservé.");
        } else if (row?.id) {
          setMsg("Brouillon automatiquement remis à jour avec les données les plus récentes du mois.");
        }
      } catch (e) {
        setPreview(null);
        setSavedDraft(null);
        setErr(e?.message || "Impossible de préparer le mail de paie.");
      } finally {
        setLoadingPreview(false);
      }
    },
    [authChecked, userId, isAdmin, authToken]
  );

  useEffect(() => {
    if (!authChecked || !userId || !isAdmin) return;
    loadPayrollEmail(month);
  }, [authChecked, userId, isAdmin, month, loadPayrollEmail]);

  const regenerateAutomaticBody = useCallback(() => {
    if (!preview) return;
    setToEmail(String(preview?.to_email || ""));
    setSubject(String(preview?.subject || ""));
    setBody(String(preview?.body || ""));
    setBodyManuallyEdited(false);
    setMsg("Texte automatique régénéré depuis les absences, congés, notes et salariés actuellement enregistrés.");
    setErr("");
  }, [preview]);

  const saveMonthlyNote = useCallback(
    async (employeeId) => {
      const id = String(employeeId || "").trim();
      if (!id) return;

      setErr("");
      setMsg("");
      setNoteBusyByEmployee((prev) => ({ ...(prev || {}), [id]: true }));

      try {
        const token = await authToken();
        if (!token) throw new Error("Jeton de session introuvable.");

        const resp = await fetch("/api/admin/payroll-email/notes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            month,
            employee_id: id,
            note: String(notesByEmployee?.[id] || ""),
          }),
        });

        const j = await resp.json().catch(() => ({}));
        if (!resp.ok || j?.ok === false) {
          throw new Error(j?.error || `Erreur note (${resp.status})`);
        }

        setMsg(j?.deleted ? "Note mensuelle supprimée." : "Note mensuelle enregistrée.");
        await loadPayrollEmail(month, { forceRegenerateBody: true });
      } catch (e) {
        setErr(e?.message || "Impossible d'enregistrer la note.");
      } finally {
        setNoteBusyByEmployee((prev) => ({ ...(prev || {}), [id]: false }));
      }
    },
    [authToken, loadPayrollEmail, month, notesByEmployee]
  );

  const saveDraftInApp = useCallback(async () => {
    setErr("");
    setMsg("");
    setSavingDraft(true);

    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const resp = await fetch("/api/admin/payroll-email/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          month,
          to_email: toEmail,
          subject,
          body,
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur sauvegarde (${resp.status})`);
      }

      setSavedDraft(j?.row || null);
      setMsg("Brouillon sauvegardé dans l'application.");
    } catch (e) {
      setErr(e?.message || "Impossible de sauvegarder le brouillon.");
    } finally {
      setSavingDraft(false);
    }
  }, [authToken, body, month, subject, toEmail]);

  const createOrUpdateGmailDraft = useCallback(async () => {
    setErr("");
    setMsg("");
    setGmailDraftBusy(true);

    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const saveResp = await fetch("/api/admin/payroll-email/draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          month,
          to_email: toEmail,
          subject,
          body,
        }),
      });
      const saveJson = await saveResp.json().catch(() => ({}));
      if (!saveResp.ok || saveJson?.ok === false) {
        throw new Error(saveJson?.error || `Erreur sauvegarde (${saveResp.status})`);
      }

      const gmailResp = await fetch("/api/admin/payroll-email/gmail-draft", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          month,
          to_email: toEmail,
          subject,
          body,
        }),
      });

      const gmailJson = await gmailResp.json().catch(() => ({}));
      if (!gmailResp.ok || gmailJson?.ok === false) {
        throw new Error(gmailJson?.error || `Erreur Gmail (${gmailResp.status})`);
      }

      setSavedDraft(gmailJson?.row || saveJson?.row || null);
      setMsg(
        gmailJson?.action === "updated"
          ? "Brouillon Gmail mis à jour. Tu peux le relire puis l'envoyer."
          : "Brouillon Gmail créé. Tu peux le relire puis l'envoyer."
      );
    } catch (e) {
      setErr(e?.message || "Impossible de créer le brouillon Gmail.");
    } finally {
      setGmailDraftBusy(false);
    }
  }, [authToken, body, month, subject, toEmail]);


  const refreshRobotTracking = useCallback(async () => {
    setErr("");
    setMsg("");
    setRobotRefreshBusy(true);

    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const resp = await fetch("/api/admin/payroll-email/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ month }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur actualisation (${resp.status})`);
      }

      setSavedDraft(j?.row || null);
      setMsg(
        j?.changed
          ? "Suivi automatique mis à jour : des changements ont été détectés et le mail repasse à vérifier."
          : "Suivi automatique vérifié : aucun changement détecté depuis la dernière version."
      );

      await loadPayrollEmail(month, { forceRegenerateBody: true });
    } catch (e) {
      setErr(e?.message || "Impossible d'actualiser le suivi automatique.");
    } finally {
      setRobotRefreshBusy(false);
    }
  }, [authToken, loadPayrollEmail, month]);

  const markPayrollEmailReviewed = useCallback(async () => {
    setErr("");
    setMsg("");
    setReviewBusy(true);

    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const resp = await fetch("/api/admin/payroll-email/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          month,
          to_email: toEmail,
          subject,
          body,
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur validation (${resp.status})`);
      }

      setSavedDraft(j?.row || null);
      setMsg("Mail marqué comme vérifié. Il reste prêt à être envoyé depuis l’application.");
    } catch (e) {
      setErr(e?.message || "Impossible de marquer le mail comme vérifié.");
    } finally {
      setReviewBusy(false);
    }
  }, [authToken, body, month, subject, toEmail]);

  const sendPayrollEmailNow = useCallback(async () => {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Envoyer maintenant ce mail au comptable ? L'application bloquera tout deuxième envoi pour ce mois."
      );
      if (!ok) return;
    }

    setErr("");
    setMsg("");
    setSendBusy(true);

    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const resp = await fetch("/api/admin/payroll-email/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          month,
          to_email: toEmail,
          subject,
          body,
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur envoi (${resp.status})`);
      }

      setSavedDraft(j?.row || null);
      setMsg("Mail envoyé au comptable depuis l’application. Aucun doublon ne sera autorisé pour ce mois.");
    } catch (e) {
      setErr(e?.message || "Impossible d'envoyer le mail au comptable.");
    } finally {
      setSendBusy(false);
    }
  }, [authToken, body, month, subject, toEmail]);

  const createPayrollEmployee = useCallback(async () => {
    const fullName = String(newEmployee?.full_name || "").trim();
    const baseLine = String(newEmployee?.base_line || "").trim();
    const employmentStartDate = String(newEmployee?.employment_start_date || "").trim();
    const employmentEndDate = String(newEmployee?.employment_end_date || "").trim();

    setErr("");
    setMsg("");

    if (!fullName) {
      setErr("Le nom du salarié est obligatoire.");
      return;
    }
    if (!baseLine) {
      setErr("La mention de contrat est obligatoire, par exemple : smic ou contrat de 20h.");
      return;
    }
    if (!employmentStartDate) {
      setErr("La date d'entrée est obligatoire pour savoir à partir de quel mois inclure le salarié.");
      return;
    }
    if (employmentEndDate && employmentEndDate < employmentStartDate) {
      setErr("La date de sortie ne peut pas être avant la date d'entrée.");
      return;
    }

    setEmployeeCreateBusy(true);
    try {
      const token = await authToken();
      if (!token) throw new Error("Jeton de session introuvable.");

      const resp = await fetch("/api/admin/payroll-email/employees", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          full_name: fullName,
          base_line: baseLine,
          employment_start_date: employmentStartDate,
          employment_end_date: employmentEndDate || null,
        }),
      });

      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.ok === false) {
        throw new Error(j?.error || `Erreur ajout salarié (${resp.status})`);
      }

      setNewEmployee({
        full_name: "",
        base_line: "",
        employment_start_date: "",
        employment_end_date: "",
      });

      setMsg(
        `Salarié ajouté : ${fullName}. Il apparaît automatiquement dans les mails couvrant sa période de contrat.`
      );
      await loadPayrollEmail(month);
    } catch (e) {
      setErr(e?.message || "Impossible d'ajouter le salarié.");
    } finally {
      setEmployeeCreateBusy(false);
    }
  }, [authToken, loadPayrollEmail, month, newEmployee]);

  const summary = preview?.summary || {};
  const employees = Array.isArray(preview?.employees) ? preview.employees : [];
  const robotRow = savedDraft || null;
  const robotAlreadySent = !!robotRow?.sent_at;
  const robotNeedsReview = !!robotRow?.needs_review && !robotAlreadySent;
  const robotReviewed = !!robotRow?.reviewed_at && !robotNeedsReview && !robotAlreadySent;

  return (
    <div className="p-4 max-w-6xl mx-auto space-y-5">
      <Head>
        <title>Mail de paie comptable</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="hdr">Mail de paie pour le comptable</div>
          <div className="text-sm text-gray-600">
            L'application assemble les salariés, les absences approuvées et les congés approuvés du mois choisi.
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/admin" className="btn">
            Retour admin
          </Link>
          <Link href="/admin/payslips" className="btn">
            Fiches de paie
          </Link>
        </div>
      </div>

      <div className="card space-y-3">
        <div className="grid md:grid-cols-[220px_1fr] gap-3 items-end">
          <div>
            <div className="text-sm mb-1">Mois de paie</div>
            <input
              type="month"
              className="input"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              disabled={loadingPreview}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn"
              onClick={() => loadPayrollEmail(month, { forceRegenerateBody: true })}
              disabled={loadingPreview || !authChecked}
              style={{
                backgroundColor: loadingPreview ? "#9ca3af" : "#2563eb",
                color: "#fff",
                borderColor: "transparent",
              }}
            >
              {loadingPreview ? "Préparation..." : "Préparer / rafraîchir"}
            </button>

            <button
              type="button"
              className="btn"
              onClick={regenerateAutomaticBody}
              disabled={!preview || loadingPreview}
            >
              Régénérer le texte automatique
            </button>
          </div>
        </div>

        <div className="text-xs text-gray-500">
          Session : {authChecked ? (userId ? "connectée" : "absente") : "vérification en cours"} · Admin :{" "}
          {isAdmin ? "oui" : "non"}
        </div>

        {preview ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Salariés dans le mail</div>
              <div className="text-xl font-semibold">{summaryValue(summary?.employees_count)}</div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Liés à l'app vendeuses</div>
              <div className="text-xl font-semibold">{summaryValue(summary?.linked_employees_count)}</div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Lignes enrichies automatiquement</div>
              <div className="text-xl font-semibold">{summaryValue(summary?.employees_with_auto_notes_count)}</div>
            </div>
            <div className="border rounded-2xl p-3">
              <div className="text-xs text-gray-500">Notes manuelles du mois</div>
              <div className="text-xl font-semibold">{summaryValue(summary?.employees_with_manual_notes_count)}</div>
            </div>
          </div>
        ) : null}

        {err ? <div className="text-sm text-red-600">{err}</div> : null}
        {msg ? <div className="text-sm text-green-700">{msg}</div> : null}
      </div>

      <div className="card space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="hdr">Suivi automatique du mail mensuel</div>
            <div className="text-sm text-gray-600">
              L’application garde un seul mail de paie par mois, détecte les changements et empêche un deuxième envoi involontaire.
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {robotAlreadySent
              ? statusPill("Envoyé", "#16a34a")
              : robotNeedsReview
                ? statusPill("À vérifier", "#dc2626")
                : robotReviewed
                  ? statusPill("Vérifié", "#2563eb")
                  : statusPill("Suivi prêt", "#6b7280")}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-3">
          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Dernière vérification automatique</div>
            <div className="text-sm font-medium">
              {formatDateTimeFr(robotRow?.last_auto_refresh_at) || "Pas encore initialisée"}
            </div>
          </div>

          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Dernier changement détecté</div>
            <div className="text-sm font-medium">
              {formatDateTimeFr(robotRow?.last_auto_change_at) || "Aucun changement enregistré"}
            </div>
          </div>

          <div className="border rounded-2xl p-3">
            <div className="text-xs text-gray-500">Dernière validation manuelle</div>
            <div className="text-sm font-medium">
              {formatDateTimeFr(robotRow?.reviewed_at) || "Pas encore validé"}
            </div>
          </div>
        </div>

        {robotAlreadySent ? (
          <div className="text-sm text-green-700">
            Envoyé le {formatDateTimeFr(robotRow?.sent_at) || "—"}. Le système bloque tout nouvel envoi pour ce même mois.
          </div>
        ) : robotNeedsReview ? (
          <div className="text-sm text-red-700">
            Le contenu automatique a changé depuis la dernière version suivie. Vérifie le mail avant l’envoi.
          </div>
        ) : (
          <div className="text-sm text-gray-600">
            Ce suivi sera rafraîchi automatiquement une fois par jour par le cron. Tu peux aussi forcer une actualisation ici.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={refreshRobotTracking}
            disabled={robotRefreshBusy}
            style={{
              backgroundColor: robotRefreshBusy ? "#9ca3af" : "#475569",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {robotRefreshBusy ? "Actualisation..." : "Actualiser le suivi"}
          </button>

          <button
            type="button"
            className="btn"
            onClick={markPayrollEmailReviewed}
            disabled={reviewBusy || !preview || robotAlreadySent}
            style={{
              backgroundColor: reviewBusy || robotAlreadySent ? "#9ca3af" : "#2563eb",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {reviewBusy ? "Validation..." : "Marquer comme vérifié"}
          </button>

          <button
            type="button"
            className="btn"
            onClick={sendPayrollEmailNow}
            disabled={sendBusy || !preview || robotAlreadySent}
            style={{
              backgroundColor: sendBusy || robotAlreadySent ? "#9ca3af" : "#16a34a",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {sendBusy ? "Envoi..." : robotAlreadySent ? "Déjà envoyé" : "Envoyer maintenant"}
          </button>
        </div>
      </div>

      <div className="card space-y-4">
        <div>
          <div className="hdr">Ajouter un salarié au mail de paie</div>
          <div className="text-sm text-gray-600">
            Utile pour une nouvelle embauche. La date d'entrée permet à l'application de l'inclure seulement à partir du bon mois.
          </div>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <div className="text-sm mb-1">Nom complet</div>
            <input
              className="input"
              value={newEmployee.full_name}
              onChange={(e) =>
                setNewEmployee((prev) => ({ ...(prev || {}), full_name: e.target.value }))
              }
              placeholder="Ex. Ali Ben Salem"
            />
          </div>

          <div>
            <div className="text-sm mb-1">Mention de contrat</div>
            <input
              className="input"
              value={newEmployee.base_line}
              onChange={(e) =>
                setNewEmployee((prev) => ({ ...(prev || {}), base_line: e.target.value }))
              }
              placeholder="Ex. contrat de 20h"
            />
          </div>

          <div>
            <div className="text-sm mb-1">Date d'entrée</div>
            <input
              type="date"
              className="input"
              value={newEmployee.employment_start_date}
              onChange={(e) =>
                setNewEmployee((prev) => ({ ...(prev || {}), employment_start_date: e.target.value }))
              }
            />
          </div>

          <div>
            <div className="text-sm mb-1">Date de sortie, facultative</div>
            <input
              type="date"
              className="input"
              value={newEmployee.employment_end_date}
              onChange={(e) =>
                setNewEmployee((prev) => ({ ...(prev || {}), employment_end_date: e.target.value }))
              }
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={createPayrollEmployee}
            disabled={employeeCreateBusy}
            style={{
              backgroundColor: employeeCreateBusy ? "#9ca3af" : "#7c3aed",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {employeeCreateBusy ? "Ajout..." : "Ajouter le salarié"}
          </button>

          <div className="text-xs text-gray-500">
            S'il commence pendant le mois choisi, le mail ajoute automatiquement une mention du type « début de contrat le 18 mai 2026 ».
          </div>
        </div>
      </div>

      <div className="card space-y-4">
        <div>
          <div className="hdr">Brouillon du mail</div>
          <div className="text-sm text-gray-600">
            Le texte se met à jour automatiquement avec les absences, congés, notes et salariés du mois. Tu peux encore le retoucher à la main juste avant de le valider ou de l’envoyer depuis l’application.
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <div className="text-sm mb-1">Destinataire comptable</div>
            <input className="input" value={toEmail} onChange={(e) => setToEmail(e.target.value)} />
          </div>

          <div>
            <div className="text-sm mb-1">Objet</div>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
        </div>

        <div>
          <div className="text-sm mb-1 flex flex-wrap items-center gap-2">
            <span>Contenu du mail</span>
            {bodyManuallyEdited ? (
              <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: "#fef3c7", color: "#92400e", fontWeight: 800 }}>
                Modifié à la main dans cette session
              </span>
            ) : (
              <span className="text-xs px-2 py-1 rounded-full" style={{ backgroundColor: "#dcfce7", color: "#166534", fontWeight: 800 }}>
                Version automatique à jour
              </span>
            )}
          </div>
          <textarea
            className="input"
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setBodyManuallyEdited(true);
            }}
            rows={18}
            style={{ minHeight: 360, whiteSpace: "pre-wrap" }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={saveDraftInApp}
            disabled={savingDraft || !preview}
            style={{
              backgroundColor: savingDraft ? "#9ca3af" : "#0f766e",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {savingDraft ? "Sauvegarde..." : "Sauvegarder dans l'application"}
          </button>

          <button
            type="button"
            className="btn"
            onClick={createOrUpdateGmailDraft}
            disabled={gmailDraftBusy || !preview}
            style={{
              backgroundColor: gmailDraftBusy ? "#9ca3af" : "#16a34a",
              color: "#fff",
              borderColor: "transparent",
            }}
          >
            {gmailDraftBusy ? "Création Gmail..." : "Créer / mettre à jour le brouillon Gmail"}
          </button>

          {savedDraft?.gmail_draft_id
            ? statusPill("Brouillon Gmail prêt", "#16a34a")
            : savedDraft?.id
              ? statusPill("Brouillon sauvegardé dans l'app", "#2563eb")
              : statusPill("Pas encore sauvegardé", "#6b7280")}
        </div>
      </div>

      <div className="card space-y-3">
        <div>
          <div className="hdr">Détail salarié par salarié</div>
          <div className="text-sm text-gray-600">
            Les absences et congés approuvés sont ajoutés automatiquement pour les salariés reliés à l'application.
            Tu peux ajouter une remarque mensuelle exceptionnelle pour compléter la ligne.
          </div>
        </div>

        {!preview && !loadingPreview ? (
          <div className="text-sm text-gray-600">Aucun aperçu chargé.</div>
        ) : loadingPreview ? (
          <div className="text-sm text-gray-600">Chargement des lignes salariés...</div>
        ) : (
          <div className="space-y-3">
            {employees.map((employee) => {
              const employeeId = String(employee?.id || "");
              const noteBusy = !!noteBusyByEmployee?.[employeeId];

              return (
                <div key={employeeId} className="border rounded-2xl p-3 space-y-2">
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-2">
                    <div>
                      <div className="font-medium">{employee?.full_name || "—"}</div>
                      <div className="text-sm text-gray-700">
                        Ligne générée : <span className="font-medium">{employee?.line || "—"}</span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {employee?.seller_resolved_id
                          ? `Relié à l'app vendeuses : ${employee?.seller_resolved_name || "compte vendeur détecté"}`
                          : "Pas relié à l'app vendeuses pour le moment."}
                      </div>
                      {employee?.employment_start_date || employee?.employment_end_date ? (
                        <div className="text-xs text-gray-500 mt-1">
                          {employee?.employment_start_date
                            ? `Entrée : ${formatIsoDateFr(employee.employment_start_date)}`
                            : "Entrée : non renseignée"}
                          {employee?.employment_end_date
                            ? ` · Sortie : ${formatIsoDateFr(employee.employment_end_date)}`
                            : ""}
                        </div>
                      ) : null}
                      {employee?.automatic_note ? (
                        <div className="text-xs mt-1" style={{ color: "#166534", fontWeight: 700 }}>
                          Automatique : {employee.automatic_note}
                        </div>
                      ) : null}
                    </div>

                    {employee?.seller_resolved_id
                      ? statusPill("Auto actif", "#16a34a")
                      : statusPill("Ligne fixe", "#6b7280")}
                  </div>

                  <div className="grid lg:grid-cols-[1fr_auto] gap-2 items-end">
                    <div>
                      <div className="text-sm mb-1">Note manuelle uniquement pour ce mois</div>
                      <input
                        className="input"
                        value={notesByEmployee?.[employeeId] || ""}
                        onChange={(e) =>
                          setNotesByEmployee((prev) => ({
                            ...(prev || {}),
                            [employeeId]: e.target.value,
                          }))
                        }
                        placeholder="Ex. congé sans solde, fiche de paie 0, départ anticipé..."
                      />
                    </div>

                    <button
                      type="button"
                      className="btn"
                      onClick={() => saveMonthlyNote(employeeId)}
                      disabled={noteBusy}
                    >
                      {noteBusy ? "Enregistrement..." : "Enregistrer la note"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
