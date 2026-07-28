import { setTimeout as sleep } from "node:timers/promises";

import logUpdate from "log-update";

// The runner's startup flourish: the devbox IS the agent. An isometric
// crate sits asleep, wakes up — eyes blink open on its face while sparkles
// pop around it — and types the wordmark into its own shell prompt. The art
// is uncolored terminal text and the animation is motion-only; frame
// rendering (line clearing, cursor hide/restore) comes from log-update, so
// no escape codes are hand-rolled anywhere.

const wordmark = "devboxes";
const faceWidth = 19;

const frameMs = 55;

// One flourish per process: `connect` hands off to `credentials setup`, which
// plays the intro too — the second call must be a no-op, not a rerun.
let played = false;

type Eyes = "closed" | "half" | "open";

export const playIntro = async (tagline = "Runs Devboxes tasks in containers on your machine.") => {
  if (played) return;
  played = true;

  const eyeRows: Record<Eyes, string> = {
    closed: "      ━   ━        ",
    half: "      ─   ─        ",
    open: "      ●   ●        ",
  };

  // An isometric devbox with shaded top and side faces; eyes and a shell
  // prompt live on the front. Diagonals step two columns per row so every
  // edge stays aligned. Sparkles sit in the margins at fixed positions.
  const scene = (input: {
    eyes: Eyes;
    sparkles: boolean;
    typed: string;
    cursor: string;
    tagline: string;
  }) => {
    const face = ` ❯ ${input.typed}${input.cursor}`.padEnd(faceWidth, " ").slice(0, faceWidth);
    const [s1, s2, s3, s4] = input.sparkles ? ["✧", "✦", "✦", "·"] : [" ", " ", " ", " "];
    const rows = [
      "         ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
      `   ${s1}   ▄▀▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄▀█`,
      `     ▄▀▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▄▀▒▒█  ${s2}`,
      "     ▛▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▜▒▒▒█",
      `  ${s3}  ▌${eyeRows[input.eyes]}▐▒▒▒█`,
      `     ▌${face}▐▒▒▒█  ${s4}`,
      "     ▌                   ▐▒▄▀",
      "     ▙▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▟▀",
    ];
    return `${rows.join("\n")}\n\n${input.tagline}`;
  };

  // Piped and CI runs get no banner at all — decoration in captured logs is
  // noise; a real terminal that cannot animate still gets the static frame.
  if (!process.stdout.isTTY || process.env.CI) return;
  const staticFrame = `${scene({
    eyes: "open",
    sparkles: true,
    typed: wordmark,
    cursor: "",
    tagline,
  })}\n`;
  if (process.env.TERM === "dumb") {
    process.stdout.write(staticFrame);
    return;
  }

  try {
    // Asleep → eyes blink open with sparkles → the box types its own prompt
    // → the cursor blinks → the tagline follows underneath.
    logUpdate(scene({ eyes: "closed", sparkles: false, typed: "", cursor: "", tagline: "" }));
    await sleep(frameMs * 6);
    for (const eyes of ["half", "open", "half", "open"] as const) {
      logUpdate(scene({ eyes, sparkles: eyes === "open", typed: "", cursor: "", tagline: "" }));
      await sleep(frameMs * 2);
    }
    for (let typed = 1; typed <= wordmark.length; typed += 1) {
      logUpdate(
        scene({
          eyes: "open",
          sparkles: true,
          typed: wordmark.slice(0, typed),
          cursor: "▌",
          tagline: "",
        }),
      );
      await sleep(frameMs);
    }
    for (let blink = 0; blink < 3; blink += 1) {
      logUpdate(
        scene({
          eyes: "open",
          sparkles: true,
          typed: wordmark,
          cursor: blink % 2 === 0 ? " " : "▌",
          tagline: "",
        }),
      );
      await sleep(frameMs * 2);
    }
    for (let visible = 5; visible < tagline.length + 5; visible += 5) {
      logUpdate(
        scene({
          eyes: "open",
          sparkles: true,
          typed: wordmark,
          cursor: "",
          tagline: tagline.slice(0, visible),
        }),
      );
      await sleep(frameMs);
    }
    logUpdate(scene({ eyes: "open", sparkles: true, typed: wordmark, cursor: "", tagline }));
    logUpdate.done();
  } catch {
    // A terminal that rejects frame rendering still gets the static banner.
    logUpdate.clear();
    process.stdout.write(staticFrame);
  }
};
