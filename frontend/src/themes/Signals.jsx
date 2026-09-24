/* Is the study finished, and what refuses to group with anything.
 *
 * The grounded-theory question, drawn as the curve it actually is: cumulative
 * distinct tags against interviews, in the order they were recorded. A curve
 * still climbing at the last participant is the study saying it is not done. It
 * measures the codebook rather than the world, so a flat curve can equally mean
 * you stopped noticing -- worth reading as a prompt, not a verdict.
 *
 * Nothing here files anything. Every ranking is a proposal a person accepts.
 */

import { useEffect, useState } from "react";
import { api } from "../lib/util.js";
import QuoteCard from "./QuoteCard.jsx";

export default function Signals({ lib, onPlayQuote }) {
  const { byRef, recordings, themes } = lib;
  const [neural, setNeural] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api(`/api/library/signals?neural=${neural ? 1 : 0}`)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [neural]);

  if (error) {
    return (
      <main className="sheet">
        <p className="empty">{error}</p>
      </main>
    );
  }

  const points = data?.saturation?.points || [];
  const lonely = (data?.loneliest || []).map((entry) => byRef.get(entry.ref)).filter(Boolean);
  const stillClimbing = points.length && points[points.length - 1].new > 0;

  return (
    <main className="sheet">
      <header className="sheet__head">
        <h2 className="sheet__title">Are new interviews still finding new tags?</h2>
        <span className="sheet__count">
          {loading
            ? "reading…"
            : stillClimbing
              ? "the last interview still brought new tags"
              : "the last interviews brought nothing new"}
        </span>
      </header>

      {points.length ? <Saturation points={points} total={data.saturation.total_tags} /> : (
        <p className="empty">{loading ? "" : "No recordings."}</p>
      )}

      <p className="side__note">
        Bars are tags appearing for the first time in that interview; the line is the running
        total. A curve still climbing at the last participant is the study saying it is not
        finished. It measures the codebook rather than the world — a flat curve can equally
        mean you stopped noticing.
      </p>

      <header className="sheet__head">
        <h2 className="sheet__title">Quotes least like anything else</h2>
        <span className="sheet__count">negative cases are where a theme's edge is</span>
      </header>

      {/* Which backend decided "least like". Word overlap cannot tell that "it
          never works" and "constantly broken" are the same complaint; the model
          can, and what counts as an outlier changes accordingly. */}
      <label className="board__filter">
        <input
          type="checkbox"
          checked={neural}
          disabled={data ? !data.neural_available : false}
          onChange={(event) => setNeural(event.target.checked)}
        />
        <span>
          {data && !data.neural_available
            ? "use the language model — needs pip install -e '.[neural]'"
            : "use the language model"}
        </span>
      </label>
      <span className="board__hint">
        {loading
          ? neural
            ? "encoding with the language model…"
            : "reading word overlap…"
          : data?.backend === "neural"
            ? "compared by meaning"
            : "compared by word overlap"}
      </span>

      {lonely.length ? (
        <div className="qgrid">
          {lonely.map((quote) => (
            <QuoteCard
              key={quote.ref}
              quote={quote}
              recordings={recordings}
              themes={themes}
              draggable={false}
              onPlay={onPlayQuote}
            />
          ))}
        </div>
      ) : (
        <p className="empty">{loading ? "" : "Not enough quotes to tell yet."}</p>
      )}
    </main>
  );
}

function Saturation({ points, total }) {
  const width = 720;
  const height = 220;
  const pad = 34;
  const top = Math.max(1, total);
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const at = (point, index) => [
    pad + index * stepX,
    height - pad - (point.total / top) * (height - pad * 2),
  ];

  const line = points.map((p, i) => at(p, i).map((n) => n.toFixed(1)).join(",")).join(" ");

  return (
    <svg
      className="sat"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Cumulative distinct tags across interviews"
    >
      <line
        className="sat__axis"
        x1={pad}
        y1={height - pad}
        x2={width - pad}
        y2={height - pad}
      />
      {points.map((point, index) => {
        const [x] = at(point, index);
        const barHeight = (point.new / top) * (height - pad * 2);
        return (
          <rect
            className="sat__bar"
            key={`bar-${point.recording_id}`}
            x={(x - 7).toFixed(1)}
            y={(height - pad - barHeight).toFixed(1)}
            width="14"
            height={Math.max(0, barHeight).toFixed(1)}
          />
        );
      })}
      <polyline className="sat__line" points={line} />
      {points.map((point, index) => {
        const [x, y] = at(point, index);
        return (
          <g key={`dot-${point.recording_id}`}>
            <circle className="sat__dot" cx={x.toFixed(1)} cy={y.toFixed(1)} r="4">
              <title>
                {point.title}: {point.total} tags, {point.new} new
              </title>
            </circle>
            <text
              className="sat__label"
              x={x.toFixed(1)}
              y={height - pad + 16}
              textAnchor="middle"
            >
              {point.title}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
