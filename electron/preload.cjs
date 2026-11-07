const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameforge', {
  isDesktop: true,
  exportNative: (payload) => ipcRenderer.invoke('save-export', payload),
  getRenderFonts: () => ipcRenderer.invoke('get-render-fonts'),
  exportTimeline: (payload) => ipcRenderer.invoke('export-timeline', payload),
  probeMediaAudio: (assets) => ipcRenderer.invoke('probe-media-audio', { assets }),
  onRenderProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('render-progress', handler);
    return () => ipcRenderer.removeListener('render-progress', handler);
  },
  saveProject: (content) => ipcRenderer.invoke('save-project', content),
  openProject: () => ipcRenderer.invoke('open-project'),
});
