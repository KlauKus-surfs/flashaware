// Two-tone WebAudio beep used when a location goes from a less-severe state
// to a more-severe one. We synthesise inline rather than shipping an audio
// asset so a missing /alert.mp3 in production can't silently disable the cue.
// Browser autoplay policy still blocks the AudioContext until the user has
// interacted with the page — that's fine, the .catch() in resume() swallows
// it and the visual pulse still fires.
export function playAlertBeep(): void {
  try {
    type AudioCtx = typeof AudioContext;
    const Ctx: AudioCtx | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Some browsers create the context in 'suspended' state until the user
    // interacts. resume() is a no-op on already-running contexts.
    ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const beep = (startOffset: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      // Quick attack/decay envelope so the tone doesn't click.
      gain.gain.setValueAtTime(0, now + startOffset);
      gain.gain.linearRampToValueAtTime(0.25, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + 0.2);
    };
    beep(0, 880);
    beep(0.22, 660);
    // Tear down the context once the second tone has finished so we don't
    // accumulate one per alert.
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 600);
  } catch {
    // No-op: if WebAudio is unavailable or blocked, the visual pulse is enough.
  }
}
