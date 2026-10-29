import type { RundownEngine } from "./rundown-engine.js";

export interface GatewaySseClientOptions {
  gatewayUrl: string;
  engine: RundownEngine;
  fetchFn?: typeof fetch;
  logger?: { info: (...args: any[]) => void; warn: (...args: any[]) => void; error: (...args: any[]) => void };
}

export class GatewaySseClient {
  private readonly gatewayUrl: string;
  private readonly engine: RundownEngine;
  private readonly fetchFn: typeof fetch;
  private readonly logger: GatewaySseClientOptions["logger"];

  private abortController: AbortController | null = null;
  private connected = false;
  private lastMusicState: boolean | null = null;
  private lastSpeechState: boolean | null = null;

  constructor(options: GatewaySseClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, "");
    this.engine = options.engine;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
  }

  isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (this.abortController) return;
    this.abortController = new AbortController();
    void this.runLoop(this.abortController.signal);
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;

    while (!signal.aborted) {
      try {
        const url = `${this.gatewayUrl}/api/v1/events`;
        this.logger?.info?.(`Connecting to Gateway SSE: ${url}`);

        const response = await this.fetchFn(url, {
          headers: { Accept: "text/event-stream" },
          signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`SSE HTTP error ${response.status}`);
        }

        this.connected = true;
        backoffMs = 1000;
        this.logger?.info?.("Connected to Gateway SSE stream");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const block of lines) {
            this.handleSseBlock(block);
          }
        }
      } catch (err) {
        this.connected = false;
        if (signal.aborted) return;
        this.logger?.warn?.(`Gateway SSE connection failed: ${err instanceof Error ? err.message : String(err)}. Reconnecting in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    }
  }

  private handleSseBlock(block: string): void {
    const lines = block.split("\n");
    let eventType = "message";
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataStr += line.slice(5).trim();
      }
    }

    if (!dataStr) return;

    try {
      const payload = JSON.parse(dataStr);
      const type = payload.type ?? eventType;
      const data = payload.data ?? payload;

      if (type === "transcript" && data?.text) {
        void this.engine.onTranscript(String(data.text));
      } else if (type === "pivoice" || type === "pisound") {
        this.handleAudioTelemetry(data);
      }
    } catch {
      // Ignore unparseable frames
    }
  }

  private handleAudioTelemetry(data: any): void {
    const isMusic = Boolean(data?.isMusic ?? data?.classification === "music");
    const isSpeech = Boolean(data?.isSpeech ?? data?.classification === "speech");

    // Music transition
    if (this.lastMusicState !== null) {
      if (!this.lastMusicState && isMusic) {
        void this.engine.onSoundEvent("music_start");
      } else if (this.lastMusicState && !isMusic) {
        void this.engine.onSoundEvent("music_stop");
      }
    }
    this.lastMusicState = isMusic;

    // Speech transition
    if (this.lastSpeechState !== null) {
      if (!this.lastSpeechState && isSpeech) {
        void this.engine.onSoundEvent("speech_start");
      } else if (this.lastSpeechState && !isSpeech) {
        void this.engine.onSoundEvent("speech_stop");
      }
    }
    this.lastSpeechState = isSpeech;

    // Silence
    if (!isMusic && !isSpeech) {
      void this.engine.onSoundEvent("silence");
    }
  }
}
