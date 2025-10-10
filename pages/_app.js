import "../styles/globals.css";
import { AuthProvider } from "@/lib/useAuth";

// Mode bypass : pas d'écran "Chargement…", on rend toujours la page.
// Les gardes d'accès restent dans /admin et /app.
function Shell({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

export default function MyApp(props) {
  return (
    <AuthProvider>
      <Shell {...props} />
    </AuthProvider>
  );
}
