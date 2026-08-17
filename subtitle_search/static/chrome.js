/* Bits every page needs: the theme toggle and the toasts. */

const THEME_KEY = "subtitle-search:theme";
const ORDER = ["auto", "light", "dark"];

//: How long a message stays. A warning outlives a confirmation, because one is
//: something to act on and the other is something to notice.
const LINGER = { info: 5000, warn: 11000, action: 15000 };

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

/**
 * Say something in the corner, then get out of the way.
 *
 * These used to be a full-width bar above the transcript, which pushed the text
 * down and stayed there -- a reading tool should not rearrange what you are
 * reading to tell you a file was saved. A toast leaves the page alone.
 *
 * ``key`` marks a message worth showing once ever: it stays until dismissed, and
 * dismissing it is remembered. Everything else fades on its own.
 *
 * ``action`` puts one button in the toast -- ``{ label, onAct }``. This is where an
 * undo belongs: the moment after doing something is when you know you did not mean
 * it, and a toast is already on screen saying what happened. A toast with an action
 * lingers longer, because dismissing it is the same as declining.
 */
export function notify(host, message, { kind = "info", key = null, action = null } = {}) {
  if (!host || (key && localStorage.getItem(key) === "dismissed")) return;

  const toast = document.createElement("div");
  toast.className = `toast toast--${kind === "warn" ? "warn" : "info"}`;
  toast.setAttribute("role", kind === "warn" ? "alert" : "status");
  toast.innerHTML =
    `<span class="toast__mark" aria-hidden="true"></span>` +
    `<span class="toast__text"></span>` +
    (action ? `<button class="toast__act" type="button"></button>` : "") +
    `<button class="toast__close" type="button" aria-label="Dismiss">✕</button>`;
  toast.querySelector(".toast__text").textContent = message;

  const close = () => {
    if (key) localStorage.setItem(key, "dismissed");
    toast.classList.add("toast--going");
    setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector(".toast__close").addEventListener("click", close);

  if (action) {
    const button = toast.querySelector(".toast__act");
    button.textContent = action.label;
    button.addEventListener("click", () => {
      // One press only: an undo pressed twice would work on whatever the first
      // press left behind.
      button.disabled = true;
      close();
      action.onAct();
    });
  }

  host.appendChild(toast);
  if (!key) {
    const timer = setTimeout(close, action ? LINGER.action : LINGER[kind] || LINGER.info);
    // Reading a message should not race a timer.
    toast.addEventListener("mouseenter", () => clearTimeout(timer));
  }
  return toast;
}
