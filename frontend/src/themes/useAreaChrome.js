/* Keeping a theme's name readable at every zoom.
 *
 * Everything on the plane scales with the zoom except an area's title bar, which
 * stays the size it would be in a sidebar. A quote shrinking as you pull back is
 * fine -- you are not reading it from there -- but a theme's *name* is what you
 * navigate by, and a plane whose labels go illegible exactly when you zoom out to
 * see all of them has given up the thing it was for.
 *
 * Deliberately imperative and deliberately outside React: this runs on every
 * wheel tick, and a version that re-rendered to re-measure would be a write, a
 * forced reflow and a read per area per frame.
 */

import { useCallback, useRef } from "react";

//: Screen widths at which a title bar gives something up, in the order it gives
//: them. Measured rather than guessed: what fits depends on the area's width
//: *and* the zoom, and an area seen at 45% is only a couple of hundred pixels
//: across however wide it is on the plane.
const TIGHT = 340;
const CRAMPED = 250;
const BARE = 190;

//: The title's size on screen, and the floor it is allowed to fall to when a
//: single long word will not fit an area however it is wrapped.
const TITLE_PX = 13;
const TITLE_MIN_PX = 9;

export function useAreaChrome(surface) {
  //: An offscreen context, for asking how wide a word is without laying anything
  //: out. Measuring the real field instead would mean a write, a forced reflow
  //: and a read per area on every wheel tick.
  const ruler = useRef(null);
  if (!ruler.current) {
    ruler.current = document.createElement("canvas").getContext("2d");
  }

  const widestWord = useCallback((text, font) => {
    ruler.current.font = font;
    return text
      .split(/\s+/)
      .reduce((widest, word) => Math.max(widest, ruler.current.measureText(word).width), 0);
  }, []);

  /**
   * Let a long name wrap, and shrink it only when even that will not do.
   *
   * Zoomed far out there is genuinely not the width for "Nobody opens the
   * spreadsheet" on one line, so the field wraps -- which is why it is a
   * textarea and not an input -- and its height is followed here rather than by
   * `field-sizing`, which is too new to depend on.
   *
   * Wrapping runs out too. Below about a quarter zoom an area is a hundred
   * pixels across and a single word can be wider than that, and then there are
   * only three things you can do to it: cut it, break it mid-word, or make it
   * smaller. Smaller is the only one that leaves it readable.
   */
  const fitTitles = useCallback(() => {
    for (const field of surface.current?.querySelectorAll(".area__title") || []) {
      field.style.fontSize = "";
      // The bar is laid out at z times the area's width and drawn back at 1/z,
      // so its layout pixels *are* screen pixels. No conversion, at any zoom.
      const room = field.clientWidth;
      const needed = widestWord(field.value, getComputedStyle(field).font);
      if (room > 0 && needed > room) {
        field.style.fontSize = `${Math.max(TITLE_MIN_PX, TITLE_PX * (room / needed))}px`;
      }

      field.style.height = "auto";
      // scrollHeight is content plus padding; the box is border-box. Without the
      // borders back the field lands two pixels short and clips its last line.
      const borders = field.offsetHeight - field.clientHeight;
      field.style.height = `${field.scrollHeight + borders}px`;
    }
  }, [surface, widestWord]);

  /**
   * Make room for the theme's name by dropping everything less important.
   *
   * The bar does not scale, so zooming out does not shrink it -- it runs out of
   * area to sit in instead, and something has to yield. The name never does.
   *
   * The order of sacrifice is: the note and the recording spread, then the
   * count, and only on a bar too narrow to press anything, the buttons. Losing
   * the second row also pulls the bar back inside the room reserved for it and
   * stops it covering the top row of cards. Zooming in brings it all back.
   */
  const fitChrome = useCallback(() => {
    const root = surface.current;
    if (!root) return;
    const z = Number(getComputedStyle(root).getPropertyValue("--z")) || 1;

    for (const node of root.querySelectorAll(".area")) {
      const width = node.offsetWidth * z;
      node.classList.toggle("area--tight", width < TIGHT);
      node.classList.toggle("area--cramped", width < CRAMPED);
      node.classList.toggle("area--bare", width < BARE);
    }
    fitTitles();

    // How tall the area has to be to hold its own title bar.
    //
    // The two live in different units, and that is the whole of the arithmetic
    // here. The bar renders one layout pixel to one screen pixel, because its
    // 1/z undoes the surface's z. The area does not: its height is in canvas
    // units and renders at z of that. So a bar of H pixels needs H / z canvas
    // units under it, and using H directly -- as is tempting -- leaves the box
    // short by exactly the zoom.
    //
    // Rolled up, that *is* the height: the area is its bar and nothing else.
    // Otherwise it is a floor, reached only when zoom or a wrapped name has made
    // the bar taller than the box, and an area seen from a distance becomes a
    // labelled tile. Neither is written down; zooming in undoes both.
    for (const node of root.querySelectorAll(".area")) {
      const chrome = node.querySelector(".area__chrome");
      if (!chrome) continue;
      const needed = `${chrome.offsetHeight / z}px`;
      if (node.classList.contains("area--collapsed")) {
        node.style.height = needed;
        node.style.minHeight = "";
      } else {
        node.style.minHeight = needed;
      }
    }
  }, [surface, fitTitles]);

  return { fitChrome, fitTitles };
}
