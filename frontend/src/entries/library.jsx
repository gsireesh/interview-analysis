import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LibraryPage from "../library/LibraryPage.jsx";
import { Toasts } from "../ui/Toast.jsx";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/library.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Toasts>
      <LibraryPage />
    </Toasts>
  </StrictMode>
);
