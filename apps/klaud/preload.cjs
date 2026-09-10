const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("klaud", Object.freeze({
  onboardingInspect: () => ipcRenderer.invoke("klaud:onboarding-inspect"),
  onboardingPrepare: options => ipcRenderer.invoke("klaud:onboarding-prepare", options),
  onboardingComplete: () => ipcRenderer.invoke("klaud:onboarding-complete"),
  openAccountAuth: url => ipcRenderer.invoke("klaud:open-account-auth", url),
  status: () => ipcRenderer.invoke("klaud:status"),
  connect: options => ipcRenderer.invoke("klaud:connect", options),
  request: (operation, input) => ipcRenderer.invoke("klaud:request", operation, input),
  run: input => ipcRenderer.invoke("klaud:run", input),
  cancel: () => ipcRenderer.invoke("klaud:cancel"),
  toolResult: input => ipcRenderer.invoke("klaud:tool-result", input),
  confirm: id => ipcRenderer.invoke("klaud:confirm", id),
  onEvent: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("klaud:event", listener);
    return () => ipcRenderer.removeListener("klaud:event", listener);
  },
}));
