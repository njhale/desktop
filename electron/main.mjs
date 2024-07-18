import { app, BrowserWindow } from "electron";
import { getPort } from 'get-port-please'
import { startAppServer } from '../server/app.mjs'
import { join, dirname } from "path";

// const dir = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const dir = dirname(app.getAppPath())

console.info('Server Dir', dir)

app.on("ready", async () => {
    if ( app.isPackaged ) {
        const port = await getPort({portRange: [30000, 40000]})
        const nextDir = app.getAppPath()
        console.log(`Starting app server for ${nextDir}`)
        startAppServer({
            dev: false,
            hostname: 'localhost',
            port: port,
            dir: nextDir,
        }).then((url) => {
            console.log(`> App server started for ${nextDir} at ${url}`)
            createWindow(url);
        }).catch((err) => {
            console.error(err)
            process.exit(1)
        })
    }
});

app.on("window-all-closed", () => {
    if(process.platform !== "darwin"){
        app.quit();
    }
});

function createWindow(url) {
    const win = new BrowserWindow({
        width: 1024,
        height: 720,
        webPreferences: {
            preload: join(app.getAppPath(), "electron/preload.js"),
            nodeIntegration: true,
            allowRunningInsecureContent: true,
            webSecurity: false,
            disableBlinkFeatures: "Autofill",
        }
    });

    win.loadURL(url)
    win.webContents.openDevTools();
    win.webContents.on("did-fail-load", (e, code, desc) => {
        win.webContents.reloadIgnoringCache();
    });
}
