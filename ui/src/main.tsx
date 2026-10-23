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
import { installMock } from "./mock";

installMock();
createRoot(document.getElementById("root")!).render(
  document.body.dataset.surface === "panel" ? <Panel /> : <Station />,
);
