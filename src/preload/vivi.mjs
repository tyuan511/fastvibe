import { contextBridge, ipcRenderer } from "electron";

const viviApi = {
  /**
   * Load the Vivi 3D model from the main process.
   */
  async loadModel() {
    return ipcRenderer.invoke("vivi:load-model");
  },

  /**
   * Listen for mood changes from the main process.
   */
  onMoodChange(callback) {
    ipcRenderer.on("vivi:set-mood", (event, mood) => callback(mood));
  },

  /**
   * Listen for settings updates from the main process.
   */
  onSettingsChange(callback) {
    ipcRenderer.on("vivi:update-settings", (event, settings) => callback(settings));
  },

  /**
   * Request current state.
   */
  async getState() {
    return ipcRenderer.invoke("vivi:get-state");
  },

  /**
   * Report Vivi window ready.
   */
  async reportReady() {
    return ipcRenderer.invoke("vivi:window-ready");
  },
};

contextBridge.exposeInMainWorld("fastvibe", {
  vivi: viviApi,
});
