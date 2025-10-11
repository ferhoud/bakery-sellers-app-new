// pages/_app.js — baseline sûr

import '../styles/globals.css'; // ajuste le chemin si besoin

function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

export default MyApp;
