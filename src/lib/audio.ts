// Retro-futurist console audio engine. Plays the platform-generated SFX clips
// (one ambient spacecraft drone + a set of UI blips) entirely through pooled
// HTMLAudioElements so playback works without cross-origin decode permissions.

export type SfxName =
  | "click"
  | "hover"
  | "confirm"
  | "pause"
  | "glitch"
  | "select"
  | "close"
  | "saber";

const POOL = 4;
const SFX_VOL: Record<SfxName, number> = {
  click: 0.46,
  hover: 0.16,
  confirm: 0.3,
  pause: 0.3,
  glitch: 0.4,
  select: 0.42,
  close: 0.36,
  saber: 0.5,
};

class AudioEngine {
  private manifest: Record<string, string> = {};
  private pools: Partial<Record<SfxName, HTMLAudioElement[]>> = {};
  private cursor: Partial<Record<SfxName, number>> = {};
  private ambient: HTMLAudioElement | null = null;
  private ambientGain = 0.32;
  private fadeTimer: number | null = null;
  enabled = false; // a clip set has loaded
  on = true; // user toggle
  started = false; // ambient engaged after first gesture
  private lastHover = 0;

  load(manifest: Record<string, string>) {
    this.manifest = manifest || {};
    (Object.keys(SFX_VOL) as SfxName[]).forEach((name) => {
      const url = this.manifest[name];
      if (!url) return;
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < POOL; i++) {
        const a = new Audio(url);
        a.preload = "auto";
        a.volume = SFX_VOL[name];
        pool.push(a);
      }
      this.pools[name] = pool;
      this.cursor[name] = 0;
    });
    if (this.manifest.ambient) {
      const a = new Audio(this.manifest.ambient);
      a.loop = true;
      a.preload = "auto";
      a.volume = 0;
      this.ambient = a;
    }
    this.enabled = Object.keys(this.pools).length > 0 || !!this.ambient;
  }

  // Resume audio after the first real user gesture (autoplay policy).
  unlock() {
    if (!this.enabled || this.started || !this.on) return;
    this.started = true;
    if (this.ambient) {
      this.ambient.play().then(() => this.fadeAmbient(this.ambientGain)).catch(() => {
        this.started = false;
      });
    }
  }

  play(name: SfxName) {
    if (!this.enabled || !this.on) return;
    if (name === "hover") {
      const now = performance.now();
      if (now - this.lastHover < 90) return;
      this.lastHover = now;
    }
    const pool = this.pools[name];
    if (!pool || pool.length === 0) return;
    const i = (this.cursor[name] ?? 0) % pool.length;
    this.cursor[name] = i + 1;
    const el = pool[i];
    try {
      el.currentTime = 0;
      el.volume = SFX_VOL[name];
      void el.play().catch(() => {});
    } catch {/* ignore rapid-fire play interrupts */}
  }

  setOn(on: boolean) {
    this.on = on;
    if (!this.enabled) return;
    if (on) {
      if (!this.started) this.unlock();
      else if (this.ambient) {
        void this.ambient.play().catch(() => {});
        this.fadeAmbient(this.ambientGain);
      }
    } else {
      this.fadeAmbient(0, () => this.ambient?.pause());
    }
  }

  private fadeAmbient(target: number, done?: () => void) {
    if (!this.ambient) return;
    if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
    const el = this.ambient;
    const step = () => {
      const cur = el.volume;
      const d = target - cur;
      if (Math.abs(d) < 0.02) {
        el.volume = Math.max(0, Math.min(1, target));
        if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
        done?.();
        return;
      }
      el.volume = Math.max(0, Math.min(1, cur + d * 0.12));
    };
    this.fadeTimer = window.setInterval(step, 40);
  }
}

export const audio = new AudioEngine();

// Wire global delegated UI sounds: press blips on buttons/controls, hover ticks.
export function installUiSounds() {
  const interactive = "button, [role='button'], a[href], input[type='range'], .sfx-tap";
  const sfxOf = (el: Element | null): SfxName => {
    const node = el?.closest("[data-sfx]") as HTMLElement | null;
    const v = node?.dataset.sfx as SfxName | undefined;
    return v ?? "click";
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      audio.unlock();
      const t = (e.target as Element | null)?.closest(interactive);
      if (t) audio.play(sfxOf(t));
    },
    { passive: true, capture: true },
  );
  document.addEventListener(
    "pointerover",
    (e) => {
      const t = (e.target as Element | null)?.closest("button, [role='button'], a[href], .sfx-tap");
      if (t) audio.play("hover");
    },
    { passive: true, capture: true },
  );
}
