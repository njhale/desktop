const electron = require('electron');
const { contextBridge, ipcRenderer } = electron

contextBridge.exposeInMainWorld('electronAPI', {
  // on: (channel, callback) => {
  //   ipcRenderer.on(channel, callback);
  // },
  send: (channel, args) => {
    ipcRenderer.send(channel, args);
  },
  log: (level, ...args) => {
    ipcRenderer.send('log', level, args.join(' '));
  },
});

contextBridge.exposeInMainWorld('overrideConsole', () => {
  ['debug', 'log', 'info', 'warn', 'error'].forEach((level) => {
    console[level] = (...args) => {
      ipcRenderer.send('log', level, args.join(' '));
    };
  });
});
