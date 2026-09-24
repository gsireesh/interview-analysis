/* Is the study finished, and what refuses to group with anything.
 *
 * Two readings of the corpus rather than of your codebook: whether new
 * interviews are still turning up new tags, and which quotes sit furthest from
 * everything else. Negative cases are where a theme's real boundary is, and they
 * are the easiest thing to lose, because nothing groups them.
 *
 * Nothing here files anything. Every ranking is a proposal a person accepts.
 */

import { $, api, escapeHtml } from "./util.js";

let ctx = null;
let semantics = null;

export function initSemantics(context) {
  ctx = context;
  $("signals-neural").addEventListener("change", () => renderSignals());
}

/* ------------------------------------------------------------ fetching -- */

async function ensureSemantics() {
  const neural = $("signals-neural").checked;
  if (semantics && semantics.neural === neural) return semantics;

  $("signals-note").textContent = neural
    ? "encoding with the language model\u2026"
    : "reading word overlap\u2026";
  const data = await api(`/api/library/signals?neural=${neural ? 1 : 0}`);
  semantics = { ...data, neural };

  // Offering a switch that cannot be flipped is worse than not offering it: say
  // what is missing rather than letting the click do nothing.
  if (!data.neural_available) {
    $("signals-neural").checked = false;
    $("signals-neural").disabled = true;
    $("signals-neural-label").textContent =
      "use the language model \u2014 needs pip install -e '.[neural]'";
  }
  $("signals-note").textContent =
    data.backend === "neural" ? "compared by meaning" : "compared by word overlap";
  return semantics;
}

/* ------------------------------------------------------------- signals -- */

export async function renderSignals() {
  try {
    await ensureSemantics();
  } catch (error) {
    $("signals-note").textContent = "";
    $("saturation").innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
    return;
  }

  const points = semantics.saturation.points;
  const host = $("saturation");
  if (!points.length) {
    host.innerHTML = '<p class="empty">No recordings.</p>';
    return;
  }

  const width = 720;
  const height = 220;
  const pad = 34;
  const top = Math.max(1, semantics.saturation.total_tags);
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const at = (point, index) => [
    pad + index * stepX,
    height - pad - (point.total / top) * (height - pad * 2),
  ];

  const line = points.map((p, i) => at(p, i).map((n) => n.toFixed(1)).join(",")).join(" ");
  const bars = points
    .map((point, index) => {
      const [x] = at(point, index);
      const barHeight = (point.new / top) * (height - pad * 2);
      return `<rect class="sat__bar" x="${(x - 7).toFixed(1)}" y="${(height - pad - barHeight).toFixed(1)}"
                width="14" height="${Math.max(0, barHeight).toFixed(1)}"></rect>`;
    })
    .join("");
  const dots = points
    .map((point, index) => {
      const [x, y] = at(point, index);
      return `<circle class="sat__dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${escapeHtml(
        point.title
      )}: ${point.total} tags, ${point.new} new</title></circle>
      <text class="sat__label" x="${x.toFixed(1)}" y="${height - pad + 16}" text-anchor="middle">${escapeHtml(
        point.title
      )}</text>`;
    })
    .join("");

  const stillClimbing = points[points.length - 1].new > 0;
  $("saturation-note").textContent = stillClimbing
    ? "the last interview still brought new tags"
    : "the last interviews brought nothing new";

  host.innerHTML = `
    <svg class="sat" viewBox="0 0 ${width} ${height}" role="img"
         aria-label="Cumulative distinct tags across interviews">
      <line class="sat__axis" x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}"></line>
      ${bars}
      <polyline class="sat__line" points="${line}"></polyline>
      ${dots}
    </svg>
    <p class="side__note">Bars are tags appearing for the first time in that interview; the
      line is the running total. A curve still climbing at the last participant is the study
      saying it is not finished. It measures the codebook rather than the world — a flat
      curve can equally mean you stopped noticing.</p>`;

  const lonely = semantics.loneliest
    .map((entry) => ctx.state.byRef.get(entry.ref))
    .filter(Boolean);
  $("loneliest").innerHTML = lonely.length
    ? `<div class="qgrid">${lonely.map((q) => ctx.quoteCard(q, { draggable: false })).join("")}</div>`
    : '<p class="empty">Not enough quotes to tell yet.</p>';
}
