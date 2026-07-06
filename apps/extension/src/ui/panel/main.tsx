import "../brand.css";
import { createRoot } from "react-dom/client";
import { Panel } from "./Panel.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<Panel />);
}
