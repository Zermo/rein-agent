const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("klaud", Object.freeze({
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
