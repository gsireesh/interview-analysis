/* A text field that is typed in here and can also change somewhere else.
 *
 * A theme's name appears on the canvas and on the board at once, and renaming it
 * in one has to show up in the other. An uncontrolled field with a defaultValue
 * cannot do that -- it takes the value once and never looks again, so the two
 * views quietly disagree about what a theme is called.
 *
 * So the field holds its own draft while it is being typed in, and takes the
 * incoming value whenever that changes underneath it. Committing on blur rather
 * than on every keystroke is what keeps this from writing a request per letter.
 */

import { useEffect, useRef, useState } from "react";

export default function SyncedField({ as = "input", value, onCommit, ...rest }) {
  const [draft, setDraft] = useState(value ?? "");
  const editing = useRef(false);

  // Take the outside value, unless the caret is in here -- pulling the text out
  // from under someone mid-sentence is worse than being briefly out of date.
  useEffect(() => {
    if (!editing.current) setDraft(value ?? "");
  }, [value]);

  const Tag = as;
  return (
    <Tag
      {...rest}
      value={draft}
      onFocus={() => {
        editing.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        editing.current = false;
        if (draft !== (value ?? "")) onCommit(draft);
      }}
    />
  );
}
