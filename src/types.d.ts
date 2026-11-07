export {};

declare global {
  interface Window {
    frameforge?: {
      isDesktop: boolean;
      getRenderFonts?: () => Promise<{ regular: string; bold: string; malayalamRegular?: string; malayalamBold?: string }>;
      exportNative: (payload: {
        bytes: Uint8Array;
        extension: string;
        start: number;
        duration: number;
        kind: 'video' | 'audio';
        speed: number;
        volume: number;
        filter: string;
        brightness: number;
        contrast: number;
        saturation: number;
      }) => Promise<{ canceled?: boolean; filePath?: string; error?: string }>;
      exportTimeline?: (payload: {
        files: Array<{ name: string; data: Uint8Array | string }>;
        args: string[];
        duration: number;
        projectName: string;
      }) => Promise<{ canceled?: boolean; filePath?: string; error?: string }>;
      probeMediaAudio?: (assets: Array<{ id: string; name: string; bytes: Uint8Array }>) => Promise<{ audioAssetIds?: string[]; error?: string }>;
      onRenderProgress?: (callback: (progress: number) => void) => (() => void);
      saveProject?: (content: string) => Promise<{ canceled?: boolean; filePath?: string; error?: string }>;
      openProject?: () => Promise<{ canceled?: boolean; content?: string; filePath?: string; error?: string }>;
    };
  }
}
