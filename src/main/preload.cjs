const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("timeWallpaper", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  pickFolders: () => ipcRenderer.invoke("folders:pick"),
  scanPhotos: (folders) => ipcRenderer.invoke("photos:scan", folders),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  analyzePhoto: (photoId) => ipcRenderer.invoke("llm:analyze-photo", photoId),
  analyzeDailyTen: (photoIds, options) => ipcRenderer.invoke("llm:analyze-daily-ten", photoIds, options),
  prepareDailyLetter: (options) => ipcRenderer.invoke("llm:prepare-daily-letter", options),
  onWorkflowStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on("workflow:status", listener);
    return () => ipcRenderer.removeListener("workflow:status", listener);
  },
  setWallpaper: (photoId) => ipcRenderer.invoke("wallpaper:set", photoId),
  setWallpaperCycle: (enabled) => ipcRenderer.invoke("wallpaper:cycle-set", enabled)
});
