declare module '@novnc/novnc' {
  /** Minimal noVNC client surface used by the live screen. */
  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: unknown);
    disconnect(): void;
    focus(): void;
    scaleViewport: boolean;
    viewOnly: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    addEventListener(type: string, listener: (event: Event) => void): void;
  }
}
