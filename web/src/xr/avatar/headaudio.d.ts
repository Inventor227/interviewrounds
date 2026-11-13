// Types for the parts of @met4citizen/headaudio 1.0.0 we use (the package ships none).
declare module '@met4citizen/headaudio/dist/headaudio.min.mjs' {
  export class HeadAudio extends AudioWorkletNode {
    constructor(
      ctx: BaseAudioContext,
      options?: { processorOptions?: Record<string, unknown>; parameterData?: Record<string, number> },
    );
    /** Active viseme id (HeadAudio order), -1 for silence. */
    visemeActive: number;
    onvalue: ((key: string, value: number) => void) | null;
    onstarted: ((data: unknown) => void) | null;
    onended: ((data: unknown) => void) | null;
    loadModel(url: string, reset?: boolean): Promise<void>;
    update(dtMs: number): void;
    start(): void;
    stop(): void;
  }
}
