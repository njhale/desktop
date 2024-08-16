import { app, BrowserWindow, ipcMain } from 'electron';
import { startAppServer } from '../server/app.mjs';
import { join, dirname } from 'path';
import { configure } from './config.mjs'
import os from 'os';
app.on('window-all-closed', () => app.quit());
app.on('ready', () => {
     startServer().catch((err) => {
       console.error(err);
       process.exit(1);
     })
});

async function startServer() {
    const {dev, dir, port, logger} = await configure()

    // Forward renderer logs to custom logger
    ipcMain.on('log', (event, level, message) => {
        console[level](message);
    });

    const url = await startAppServer({
      dev,
      hostname: 'localhost',
      port,
      dir,
    });
    await createWindow(url, dir);

    console.log(`> ${!dev ? '' : 'Dev '}Electron app started at ${url}`);
}

async function createWindow(url, dir) {
  const isMac = os.platform() === 'darwin';
  const win = new BrowserWindow({
    width: 1024,
    height: 720,
    frame: !isMac, // Use frame: true for Windows and Linux
    webPreferences: {
      preload: join(dir, 'electron', 'preload.js'),
      nodeIntegration: true,
      spellcheck: false,
      allowRunningInsecureContent: true,
      webSecurity: false,
      disableBlinkFeatures: 'Autofill',
    },
  });

  // Check if the platform is macOS before calling setWindowButtonVisibility
  if (isMac) {
    win.setWindowButtonVisibility(true);
  }

  await win.loadURL(url);

  win.webContents.on('did-fail-load', () =>
    win.webContents.reloadIgnoringCache()
  );
}

