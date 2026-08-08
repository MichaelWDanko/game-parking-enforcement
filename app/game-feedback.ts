export type FeedbackCue =
  | "start"
  | "error"
  | "lookup"
  | "ticket"
  | "boot"
  | "objective"
  | "incident"
  | "finish";

export type WorldPosition = {
  x: number;
  y?: number;
  z: number;
};

type CueNote = {
  frequency: number;
  duration: number;
  offset?: number;
  type?: OscillatorType;
  gain?: number;
};

const CUE_NOTES: Record<FeedbackCue, readonly CueNote[]> = {
  start: [
    { frequency: 440, duration: 0.08, type: "square" },
    { frequency: 660, duration: 0.15, offset: 0.09, type: "square" },
  ],
  error: [{ frequency: 150, duration: 0.2, type: "sawtooth", gain: 0.07 }],
  lookup: [{ frequency: 520, duration: 0.08, type: "square", gain: 0.065 }],
  ticket: [
    { frequency: 740, duration: 0.08, type: "square" },
    { frequency: 920, duration: 0.12, offset: 0.07, type: "square" },
  ],
  boot: [
    { frequency: 260, duration: 0.08, type: "square", gain: 0.1 },
    { frequency: 390, duration: 0.16, offset: 0.09, type: "square", gain: 0.1 },
  ],
  objective: [
    { frequency: 660, duration: 0.1, type: "triangle" },
    { frequency: 880, duration: 0.1, offset: 0.09, type: "triangle" },
    { frequency: 1100, duration: 0.2, offset: 0.18, type: "triangle" },
  ],
  incident: [
    { frequency: 330, duration: 0.1, type: "square", gain: 0.07 },
    { frequency: 440, duration: 0.18, offset: 0.12, type: "square", gain: 0.07 },
  ],
  finish: [
    { frequency: 392, duration: 0.16, type: "sine" },
    { frequency: 523, duration: 0.3, offset: 0.13, type: "sine" },
  ],
};

type HapticActuator = {
  playEffect?: (
    effect: "dual-rumble",
    options: {
      duration: number;
      strongMagnitude: number;
      weakMagnitude: number;
    },
  ) => unknown;
  pulse?: (value: number, duration: number) => unknown;
};

type GamepadHaptics = {
  vibrationActuator?: HapticActuator | null;
  hapticActuators?: readonly HapticActuator[];
};

type ActiveNote = {
  oscillator: OscillatorNode;
  gain: GainNode;
  panner: PannerNode | null;
};

function ignoreOptionalPromise(result: unknown) {
  void Promise.resolve(result).catch(() => undefined);
}

function setAudioParam(param: AudioParam | undefined, value: number, time: number) {
  if (!param) return false;
  if (typeof param.setTargetAtTime === "function") {
    param.setTargetAtTime(value, time, 0.03);
  } else {
    param.value = value;
  }
  return true;
}

function disconnectNode(node: AudioNode | null) {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // A closed context or an already disconnected node needs no further cleanup.
  }
}

export function firstConnectedGamepad(): Gamepad | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return null;
  }
  try {
    return Array.from(navigator.getGamepads()).find((gamepad): gamepad is Gamepad =>
      Boolean(gamepad?.connected),
    ) ?? null;
  } catch {
    return null;
  }
}

export function pulseGamepad(cue: FeedbackCue) {
  const gamepad = firstConnectedGamepad();
  if (!gamepad) return;

  const isError = cue === "error";
  const isStrong = cue === "boot" || cue === "objective" || cue === "finish";
  const duration = isStrong ? 180 : isError ? 130 : 75;
  const strongMagnitude = isStrong ? 0.72 : isError ? 0.45 : 0.28;
  const weakMagnitude = isError ? 0.8 : isStrong ? 0.55 : 0.35;

  try {
    const haptics = gamepad as unknown as GamepadHaptics;
    const actuator = haptics.vibrationActuator ?? haptics.hapticActuators?.[0];
    if (!actuator) return;
    if (actuator.playEffect) {
      ignoreOptionalPromise(
        actuator.playEffect("dual-rumble", {
          duration,
          strongMagnitude,
          weakMagnitude,
        }),
      );
    } else if (actuator.pulse) {
      ignoreOptionalPromise(
        actuator.pulse(Math.max(strongMagnitude, weakMagnitude), duration),
      );
    }
  } catch {
    // Controller haptics are an optional progressive enhancement.
  }
}

export class GameFeedback {
  private context: AudioContext | null = null;
  private readonly activeNotes = new Set<ActiveNote>();
  private enabled = true;

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  updateListener(position: WorldPosition) {
    if (!this.context) return;
    try {
      const { listener, currentTime } = this.context;
      const positioned = [
        setAudioParam(listener.positionX, position.x, currentTime),
        setAudioParam(listener.positionY, position.y ?? 1.4, currentTime),
        setAudioParam(listener.positionZ, position.z, currentTime),
      ].every(Boolean);
      if (!positioned && typeof listener.setPosition === "function") {
        listener.setPosition(position.x, position.y ?? 1.4, position.z);
      }

      const oriented = [
        setAudioParam(listener.forwardX, 0, currentTime),
        setAudioParam(listener.forwardY, 0, currentTime),
        setAudioParam(listener.forwardZ, -1, currentTime),
        setAudioParam(listener.upX, 0, currentTime),
        setAudioParam(listener.upY, 1, currentTime),
        setAudioParam(listener.upZ, 0, currentTime),
      ].every(Boolean);
      if (!oriented && typeof listener.setOrientation === "function") {
        listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    } catch {
      // Spatial audio is optional and varies across browser audio implementations.
    }
  }

  play(cue: FeedbackCue, position?: WorldPosition) {
    pulseGamepad(cue);
    if (!this.enabled) return;

    try {
      const audio = this.ensureContext();
      if (audio.state === "suspended") ignoreOptionalPromise(audio.resume());
      for (const note of CUE_NOTES[cue]) this.playNote(audio, note, position);
    } catch {
      // Sound must never block play when a browser denies audio output.
    }
  }

  dispose() {
    const context = this.context;
    this.context = null;
    for (const activeNote of [...this.activeNotes]) {
      try {
        activeNote.oscillator.stop();
      } catch {
        // The note may already have stopped.
      }
      this.releaseNote(activeNote);
    }
    if (!context || context.state === "closed") return;
    try {
      ignoreOptionalPromise(context.close());
    } catch {
      // Closing an optional audio context must not affect game teardown.
    }
  }

  private ensureContext(): AudioContext {
    if (this.context?.state === "closed") this.context = null;
    if (!this.context) {
      const AudioContextConstructor = typeof AudioContext === "function"
        ? AudioContext
        : (globalThis as typeof globalThis & {
            webkitAudioContext?: typeof AudioContext;
          }).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error("Web Audio is unavailable");
      this.context = new AudioContextConstructor();
    }
    return this.context;
  }

  private playNote(audio: AudioContext, note: CueNote, position?: WorldPosition) {
    const startAt = audio.currentTime + (note.offset ?? 0);
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const activeNote: ActiveNote = { oscillator, gain, panner: null };
    this.activeNotes.add(activeNote);
    oscillator.addEventListener("ended", () => this.releaseNote(activeNote), { once: true });
    try {
      oscillator.type = note.type ?? "sine";
      oscillator.frequency.setValueAtTime(note.frequency, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(note.gain ?? 0.09, startAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.duration);
      oscillator.connect(gain);

      if (position) {
        const panner = audio.createPanner();
        activeNote.panner = panner;
        panner.panningModel = "HRTF";
        panner.distanceModel = "inverse";
        panner.refDistance = 4;
        panner.maxDistance = 90;
        panner.rolloffFactor = 0.85;
        const positioned = [
          setAudioParam(panner.positionX, position.x, startAt),
          setAudioParam(panner.positionY, position.y ?? 1, startAt),
          setAudioParam(panner.positionZ, position.z, startAt),
        ].every(Boolean);
        if (!positioned && typeof panner.setPosition === "function") {
          panner.setPosition(position.x, position.y ?? 1, position.z);
        }
        gain.connect(panner).connect(audio.destination);
      } else {
        gain.connect(audio.destination);
      }

      oscillator.start(startAt);
      oscillator.stop(startAt + note.duration + 0.02);
    } catch (error) {
      this.releaseNote(activeNote);
      throw error;
    }
  }

  private releaseNote(activeNote: ActiveNote) {
    if (!this.activeNotes.delete(activeNote)) return;
    disconnectNode(activeNote.oscillator);
    disconnectNode(activeNote.gain);
    disconnectNode(activeNote.panner);
  }
}
