import type { WledState } from '../wledClient.js';

export const EFFECT_MODE = 'effect';

// WLED fx IDs verified against `GET /json/effects` (WLED 16.0.1).
// Google allows max 18 settings per mode.
export const EFFECTS = [
  { setting: 'solid', label: 'Solid', synonyms: ['solid', 'static', 'plain'], fx: 0 },
  { setting: 'blink', label: 'Blink', synonyms: ['blink', 'flash'], fx: 1 },
  { setting: 'breathe', label: 'Breathe', synonyms: ['breathe', 'pulse'], fx: 2 },
  { setting: 'wipe', label: 'Wipe', synonyms: ['wipe'], fx: 3 },
  { setting: 'colorloop', label: 'Color Loop', synonyms: ['color loop', 'colors', 'cycle colors'], fx: 8 },
  { setting: 'rainbow', label: 'Rainbow', synonyms: ['rainbow'], fx: 9 },
  { setting: 'theater', label: 'Theater', synonyms: ['theater', 'theater chase', 'cinema'], fx: 13 },
  { setting: 'pacifica', label: 'Pacifica', synonyms: ['pacifica', 'ocean', 'waves'], fx: 101 },
  { setting: 'chase', label: 'Chase', synonyms: ['chase', 'running'], fx: 28 },
  { setting: 'fireworks', label: 'Fireworks', synonyms: ['fireworks'], fx: 42 },
  { setting: 'rain', label: 'Rain', synonyms: ['rain', 'drizzle'], fx: 43 },
  { setting: 'pride', label: 'Pride', synonyms: ['pride', 'flowing rainbow'], fx: 63 },
  { setting: 'fire', label: 'Fire', synonyms: ['fire', 'flame'], fx: 66 },
  { setting: 'noise', label: 'Noise', synonyms: ['noise'], fx: 70 },
  { setting: 'meteor', label: 'Meteor', synonyms: ['meteor', 'comet', 'shooting star'], fx: 76 },
  { setting: 'ripple', label: 'Ripple', synonyms: ['ripple'], fx: 79 },
  { setting: 'twinklefox', label: 'Twinkle', synonyms: ['twinkle', 'twinklefox', 'twinkly'], fx: 80 },
  { setting: 'candle', label: 'Candle', synonyms: ['candle', 'flicker'], fx: 88 },
] as const;

export const TRAITS = [
  'action.devices.traits.OnOff',
  'action.devices.traits.Brightness',
  'action.devices.traits.ColorSetting',
  'action.devices.traits.Modes',
];

export const ATTRIBUTES = {
  colorModel: 'rgb',
  commandOnlyColorSetting: false,
  availableModes: [
    {
      name: EFFECT_MODE,
      name_values: [{ name_synonym: ['effect', 'mode', 'animation'], lang: 'en' }],
      settings: EFFECTS.map((e) => ({
        setting_name: e.setting,
        setting_values: [{ setting_synonym: [...e.synonyms], lang: 'en' }],
      })),
      ordered: false,
    },
  ],
};

export const toGoogleBrightness = (bri: number): number =>
  Math.max(0, Math.min(100, Math.round(bri / 2.55)));

export const toWledBrightness = (pct: number): number =>
  Math.max(0, Math.min(255, Math.round(pct * 2.55)));

export const rgbToSpectrum = ([r, g, b]: number[]): number =>
  ((r & 255) << 16) + ((g & 255) << 8) + (b & 255);

export const spectrumToRgb = (n: number): [number, number, number] => [
  (n >> 16) & 255,
  (n >> 8) & 255,
  n & 255,
];

export const fxForSetting = (setting: string): number | undefined =>
  EFFECTS.find((e) => e.setting === setting.toLowerCase())?.fx;

interface Segment {
  col?: number[][];
  fx?: number;
}

export function stateToGoogle(state: WledState): Record<string, unknown> {
  const seg = (state.seg?.[0] ?? {}) as Segment;
  const rgb = seg.col?.[0];
  const effect = EFFECTS.find((e) => e.fx === seg.fx);
  return {
    online: true,
    on: state.on ?? false,
    brightness: toGoogleBrightness(state.bri ?? 0),
    ...(rgb && rgb.length >= 3 ? { color: { spectrumRgb: rgbToSpectrum(rgb) } } : {}),
    ...(effect ? { currentModeSettings: { [EFFECT_MODE]: effect.setting } } : {}),
  };
}
