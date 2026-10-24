import { createRoot } from "react-dom/client";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import { SimpleStation } from "./Simple";
import { MapOnly } from "./MapOnly";
import "./style.css";
import "./panel.css";

// La estación (lista, mapas, mensajes) sirve `estacion.html`; el panel de cada bot (`panel.html`, o `?mapa` en dev) es solo su mapa.
const q = new URLSearchParams(location.search);
const botPanel = document.body.dataset.surface === "panel" || q.has("panel") || q.has("mapa");
createRoot(document.getElementById("root")!).render(botPanel ? <MapOnly /> : <SimpleStation />);
