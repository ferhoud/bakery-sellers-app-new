import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Me(){
  const [info, setInfo] = useState({ session: null, profile: null, error: null });
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const user = data?.session?.user || null;
        let profile = null;
        if (user) {
          const { data: prof } = await supabase.from("profiles").select("user_id, full_name, role").eq("user_id", user.id).single();
          profile = prof || null;
        }
        setInfo({ session: user, profile, error: null });
      } catch (e) {
        setInfo({ session: null, profile: null, error: String(e?.message || e) });
      }
    })();
  }, []);
  return <pre style={{padding:20,background:"#f3f4f6",borderRadius:8,fontFamily:"system-ui"}}>{JSON.stringify(info,null,2)}</pre>;
}

