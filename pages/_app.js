// pages/_app.js
import '../styles/globals.css'; // ajuste le chemin si besoin

export default function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
