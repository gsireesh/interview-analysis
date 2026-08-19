/* Bits every page needs: the theme toggle and the toasts. */

import { recall, remember } from "./util.js";

const THEME_KEY = "subtitle-search:theme";
const ORDER = ["auto", "light", "dark"];

//: How long a message stays. A warning outlives a confirmation, because one is
//: something to act on and the other is something to notice.
const LINGER = { info: 5000, warn: 11000, action: 15000 };

export function applyStoredTheme() {
  document.documentElement.dataset.theme = recall(THEME_KEY, "auto");
}

export function bindThemeToggle(button) {
  if (!button) return;
  button.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "auto";
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
    document.documentElement.dataset.theme = next;
    remember(THEME_KEY, next);
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
 *
 * ``sticky`` leaves it on screen until the caller takes it away. For work that
 * takes seconds -- anything that has to read the audio -- since an action with no
 * sign of progress is indistinguishable from one that did nothing.
 */
export function notify(
  host,
  message,
  { kind = "info", key = null, action = null, sticky = false } = {}
) {
  if (!host || (key && recall(key) === "dismissed")) return;

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
    // Dismissing comes first: remembering that it was dismissed is the part that
    // is allowed to fail, not the dismissing.
    toast.classList.add("toast--going");
    if (key) remember(key, "dismissed");
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
  if (!key && !sticky) {
    const timer = setTimeout(close, action ? LINGER.action : LINGER[kind] || LINGER.info);
    // Reading a message should not race a timer.
    toast.addEventListener("mouseenter", () => clearTimeout(timer));
  }
  return toast;
}


/**
 * Say that something is happening, and hand back the way to stop saying it.
 *
 * The first caption aligned in a session waits on the model loading, which is
 * seconds. Without this the interface simply goes quiet, and quiet is exactly what
 * doing nothing looks like.
 */
export function working(host, message) {
  const toast = notify(host, message, { sticky: true });
  if (toast) toast.classList.add("toast--working");
  return () => toast?.remove();
}
