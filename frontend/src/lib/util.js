/* The shared primitives. Ported unchanged from the hand-written frontend --
 * these were never the part that needed a framework.
 *
 * `$` and `escapeHtml` did not come with them: there is nothing to look up by id
 * any more, and JSX escapes text by construction. */

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      detail = (await response.json()).detail || detail;
    } catch (_) { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

/** Index of the last entry whose value is <= target, or 0. */
export function lastAtOrBefore(values, target) {
  let low = 0;
  let high = values.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (values[mid] <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Read a remembered preference, or fall back to the default.
 *
 * Reads throw for the same reasons writes do. A read that throws on load is worse
 * than a write that throws on click, because it takes the rest of the page's
 * setup with it -- so no stored preference is ever read directly.
 */
export function recall(key, fallback = null) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

/**
 * Write a preference down, and carry on if it cannot be written.
 *
 * Storage can be unavailable or full -- private windows, a full origin quota --
 * and ``setItem`` throws when it is. Remembering a choice is the least important
 * part of making it, so a failure here must never be able to stop the choice
 * itself from taking effect.
 */
export function remember(key, value) {
  try {
    localStorage.setItem(key, String(value));
    return true;
  } catch (_) {
    return false;
  }
}

/** Join class names, skipping anything falsy. */
export function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}
