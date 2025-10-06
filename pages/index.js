import { useEffect } from "react";
import { useRouter } from "next/router";
import { useAuth } from "@/lib/useAuth";

export default function Index(){
  const r = useRouter();
  const { session, profile, loading } = useAuth();

  useEffect(()=>{
    if (loading) return;                // attendre init()
    if (!session) { r.replace("/login"); return; }
    if (!profile) return;               // attendre le profil
    if (profile.role === "admin") r.replace("/admin");
    else r.replace("/app");
  }, [session, profile, loading, r]);

  return <div className="p-6">Chargement…</div>;
}
