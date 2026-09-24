import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ReaderPage from "../reader/ReaderPage.jsx";
import { Toasts } from "../ui/Toast.jsx";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/reader.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Toasts>
      <ReaderPage />
    </Toasts>
  </StrictMode>
);
