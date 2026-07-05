import "@leadwolf/ui/tokens.css";
import { createRoot } from "react-dom/client";
import { Popup } from "./Popup.tsx";

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<Popup />);
}
