import { useEffect } from "react";
import { useRouter } from "next/router";
import { supabase } from "@/lib/supabaseClient";

export default function Home() {
  const r = useRouter();
  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const user = data?.session?.user;
      if (!user) { r.replace("/login"); return; }
      try {
        const { data: prof } = await supabase
          .from("profiles")
          .select("role")
          .eq("user_id", user.id)
          .single();
        if (prof?.role === "admin") r.replace("/admin");
        else r.replace("/app");
      } catch {
        r.replace("/app");
      }
    })();
  }, [r]);
  return <div style={{padding:20,fontFamily:"system-ui"}}>Redirection…</div>;
}

