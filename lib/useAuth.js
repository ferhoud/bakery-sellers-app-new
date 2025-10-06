
import { create } from "zustand";
import { supabase } from "./supabaseClient";

export const useAuth = create((set)=> ({
  session: null,
  profile: null,
  loading: true,
  setSession: (session)=> set({session}),
  setProfile: (profile)=> set({profile}),
  setLoading: (loading)=> set({loading}),

  init: async ()=>{
    const { data: { session } } = await supabase.auth.getSession();
    set({ session });
    if(session){
      const { data } = await supabase.from('profiles').select('*').eq('user_id', session.user.id).single();
      set({ profile: data });
    }
    set({ loading:false });
    supabase.auth.onAuthStateChange(async (_evt, sess)=>{
      set({ session: sess });
      if(sess){
        const { data } = await supabase.from('profiles').select('*').eq('user_id', sess.user.id).single();
        set({ profile: data });
      }else{
        set({ profile: null });
      }
    });
  },
}));
