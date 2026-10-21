// Placeholder data for M3 (real house art + hit-testing). Just enough shape
// here to prove the main.ts <-> aw/client.ts wiring during scaffolding.
export interface Hotspot {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
}

export const hotspots: Hotspot[] = [
  { id: "piano", label: "Piano", x: 80, y: 80, width: 120, height: 80, color: 0x8b5a2b },
];
