import { createRoot } from "react-dom/client";
import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import { Station } from "./Station";
import { Panel } from "./Panel";
import "./style.css";
import "./station.css";
import "./panel.css";
import { installMock } from "./mock";
import { CommerceDemo } from "./CommerceDemo";
import { isCommerceDemo } from "./commerce-mock";

installMock();
// `panel.html` trae data-surface="panel"; en `ui:dev` se abre con `?panel` (y `&demo` para el bot simulado).
const q = new URLSearchParams(location.search);
const panel = document.body.dataset.surface === "panel" || q.has("panel");
createRoot(document.getElementById("root")!).render(isCommerceDemo() ? <CommerceDemo /> : panel ? <Panel /> : <Station />);
