import type { CatalogOf } from "../en.ts";
import type { copy as english } from "./sound-en.ts";

// The sound popover's words (#44, #45): sound, music and vibration, in French. Loaded with its
// panel when the page speaks French: see copy-parts.ts.
export const copy: CatalogOf<typeof english, "many"> = {
  sound: {
    title: "Son",
    off: "Son : désactivé",
    on: "Son : activé",
    waiting: "Son : activé, dès votre premier clic ou votre première touche",
    enable: "Activer les effets sonores",
    hint: "Une carte posée, la révélation, un consensus et les dernières secondes du minuteur. Enregistré sur cet appareil.",
    musicEnable: "Activer la musique de fond",
    musicHint:
      "Des boucles calmes et originales tant que le vote est ouvert, qui s’estompent à la révélation. Enregistré sur cet appareil.",
    mood: "Ambiance",
    moods: {
      dusk: "Soir",
      tide: "Marée",
      embers: "Braises",
    },
    volume: "Volume",
    level: "{{level, number(style: percent; maximumFractionDigits: 0)}}",
  },
  haptics: {
    enable: "Vibration",
    hint: "Une brève vibration quand vous votez et à la révélation.",
  },
};
