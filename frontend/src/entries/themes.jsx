import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ThemesPage from "../themes/ThemesPage.jsx";
import { Toasts } from "../ui/Toast.jsx";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/themes.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Toasts>
      <ThemesPage />
    </Toasts>
  </StrictMode>
);
