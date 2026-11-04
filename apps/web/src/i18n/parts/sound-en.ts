// The sound popover's words (#44, #45): sound, music and vibration, in English. A part of the
// catalog that loads with its panel, not with the page (copy-parts.ts): the keys keep their place,
// so `t` reads them as it reads the rest.
export const copy = {
  sound: {
    title: "Sound",
    off: "Sound: off",
    on: "Sound: on",
    waiting: "Sound: on, from your first click or key press",
    enable: "Play sound effects",
    hint: "A card placed, the reveal, a consensus and the timer’s last seconds. Saved on this device.",
    musicEnable: "Play background music",
    musicHint:
      "Calm original loops while the vote is open, fading out at the reveal. Saved on this device.",
    mood: "Mood",
    moods: {
      dusk: "Dusk",
      tide: "Tide",
      embers: "Embers",
    },
    volume: "Volume",
    level: "{{level, number(style: percent; maximumFractionDigits: 0)}}",
  },
  haptics: {
    enable: "Vibrate",
    hint: "A short vibration when you vote and at the reveal.",
  },
} as const;
