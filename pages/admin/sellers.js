import Link from "next/link";

export default function SellersPage() {
  return (
    <div style={{padding:24,fontFamily:"system-ui"}}>
      <h1 style={{fontSize:20,fontWeight:700}}>Gérer les vendeuses</h1>
      <p>Page en maintenance (résolution des conflits Git).</p>
      <p style={{marginTop:8}}><Link href="/admin">⬅ Retour admin</Link></p>
    </div>
  );
}
