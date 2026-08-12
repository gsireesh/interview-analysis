/* Bits every page needs: the theme toggle and the notice strip. */

const THEME_KEY = "subtitle-search:theme";
const ORDER = ["auto", "light", "dark"];

export function applyStoredTheme() {
  document.documentElement.dataset.theme = localStorage.getItem(THEME_KEY) || "auto";
}

export function bindThemeToggle(button) {
  if (!button) return;
  button.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "auto";
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  });
}

export function notify(host, message, { kind = "info", timeout = 4000 } = {}) {
  if (!host) return;
  const notice = document.createElement("div");
  notice.className = `notice${kind === "warn" ? " notice--warn" : ""}`;
  notice.innerHTML =
    `<span class="notice__label">${kind === "warn" ? "Check" : "Note"}</span>` +
    `<span></span><button type="button" aria-label="Dismiss">✕</button>`;
  notice.querySelector("span:nth-child(2)").textContent = message;
  notice.querySelector("button").addEventListener("click", () => notice.remove());
  host.appendChild(notice);
  if (timeout) setTimeout(() => notice.remove(), timeout);
}
