import { useStore } from "../store/useStore";

let ctx: AudioContext | null = null;

type Cue = "tick" | "trade" | "tp" | "veto" | "kill";
const CUES: Record<Cue, { f: number[]; d: number; type: OscillatorType }> = {
  tick: { f: [880], d: 0.05, type: "sine" },
  trade: { f: [523, 784], d: 0.12, type: "triangle" },
  tp: { f: [523, 659, 784, 1046], d: 0.1, type: "triangle" },
  veto: { f: [220, 165], d: 0.14, type: "sawtooth" },
  kill: { f: [110, 82], d: 0.25, type: "square" },
};

/** Tiny synthesized UI sounds. Silent unless the user enabled sound (off by default). */
export function play(cue: Cue): void {
  if (!useStore.getState().sound) return;
  try {
    ctx = ctx ?? new AudioContext();
    const { f, d, type } = CUES[cue];
    f.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      const t = ctx!.currentTime + i * d;
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + d + 0.02);
    });
  } catch {
    /* audio unavailable */
  }
}
