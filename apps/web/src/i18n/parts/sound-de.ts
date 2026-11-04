import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./sound-en.ts";

// The sound popover's words (#44, #45): sound, music and vibration, in German. Loaded with its
// panel when the page speaks German: see copy-parts.ts.
export const copy: CatalogOf<typeof english> = {
  sound: {
    title: "Ton",
    off: "Ton: aus",
    on: "Ton: an",
    waiting: "Ton: an, ab Ihrem ersten Klick oder Tastendruck",
    enable: "Soundeffekte abspielen",
    hint: "Eine gelegte Karte, das Aufdecken, ein Konsens und die letzten Sekunden des Timers. Auf diesem Gerät gespeichert.",
    musicEnable: "Hintergrundmusik abspielen",
    musicHint:
      "Ruhige, eigens komponierte Loops, solange die Abstimmung läuft; beim Aufdecken blenden sie aus. Auf diesem Gerät gespeichert.",
    mood: "Stimmung",
    moods: {
      dusk: "Abend",
      tide: "Gezeiten",
      embers: "Glut",
    },
    volume: "Lautstärke",
    level: "{{level, number(style: percent; maximumFractionDigits: 0)}}",
  },
  haptics: {
    enable: "Vibration",
    hint: "Eine kurze Vibration bei Ihrer Stimme und beim Aufdecken.",
  },
};
