// pages/push-setup.js
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/useAuth";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY; // Assure-toi qu'elle est définie

async function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = typeof window !== "undefined" ? window.atob(base64) : Buffer.from(base64, "base64").toString("binary");
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

export default function PushSetup() {
  const { session, profile, loading } = useAuth();
  const [status, setStatus] = useState("Prêt");
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) setStatus("Veuillez vous connecter en tant qu’admin.");
  }, [loading, session]);

  const ensureSW = async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service Worker non supporté par ce navigateur.");
    }
    // Ton SW doit déjà être disponible à /sw.js (ou via Next PWA si tu l'utilises)
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return reg;
  };

  const handleEnable = async () => {
    try {
      setStatus("Vérification du navigateur…");

      const reg = await ensureSW();

      if (!("Notification" in window)) {
        throw new Error("Notifications non supportées.");
      }

      let perm = Notification.permission;
      if (perm !== "granted") {
        setStatus("Demande d’autorisation…");
        perm = await Notification.requestPermission();
      }
      if (perm !== "granted") {
        throw new Error("Autorisation refusée.");
      }

      if (!VAPID_PUBLIC_KEY) {
        throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY manquante.");
      }

      setStatus("Création de l’abonnement…");
      const key = await urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });

      const endpoint = subscription.endpoint;
      const rawKey = subscription.getKey("p256dh");
      const rawAuth = subscription.getKey("auth");
      const p256dh = btoa(String.fromCharCode.apply(null, new Uint8Array(rawKey)));
      const auth = btoa(String.fromCharCode.apply(null, new Uint8Array(rawAuth)));

      // Sauvegarde/Upsert dans Supabase
      setStatus("Enregistrement côté serveur…");
      const { error } = await supabase
        .from("push_subscriptions")
        .upsert(
          {
            user_id: profile?.user_id || session?.user?.id,
            endpoint,
            p256dh,
            auth,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "endpoint" }
        );

      if (error) throw error;

      setSubscribed(true);
      setStatus("✅ Notifications activées !");
    } catch (err) {
      console.error(err);
      setStatus(`❌ ${err.message || err}`);
    }
  };

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4">
      <div className="hdr">Activer les notifications</div>
      <div className="card">
        <p className="text-sm mb-3">
          Appuie sur le bouton ci-dessous pour autoriser les notifications et enregistrer ton appareil.
        </p>
        <button className="btn" onClick={handleEnable}>🔔 Activer les notifications</button>
        <div className="text-sm text-gray-600 mt-3">État : {status}</div>
        {subscribed && (
          <div className="text-sm mt-2">
            Tu peux maintenant recevoir des notifications. Ouvre la page <code>/admin</code> et teste une alerte.
          </div>
        )}
      </div>

      <style jsx>{`
        code {
          background: #f3f4f6;
          padding: 0.2rem 0.4rem;
          border-radius: 0.4rem;
        }
      `}</style>
    </div>
  );
}
