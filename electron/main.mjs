import {app, BrowserWindow} from "electron";
import {getPort} from 'get-port-please'
import {startAppServer} from '../server/app.mjs'
import {join, dirname} from "path";
import {homedir} from "os";
import {existsSync, mkdirSync} from "fs";

const dir = dirname(app.getAppPath())

console.info('Server Dir', dir)

function getCacheDir(appName) {
    const platform = process.platform;
    let cacheDir;

    if (platform === 'win32') {
        cacheDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), appName);
    } else if (platform === 'darwin') {
        cacheDir = join(homedir(), 'Library', 'Caches', appName);
    } else {
        // Default to XDG standard for Linux and other Unix-like systems
        cacheDir = join(process.env.XDG_CACHE_HOME || join(os.homedir(), '.cache'), appName);
    }

    return cacheDir;
}

const appName = 'gptscript-ui'; // Replace with your app's name
const cacheDir = getCacheDir(appName);

console.info(`cacheDir: ${cacheDir}`)

// Ensure the directory exists
if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
}

app.on("ready", async () => {
    if (app.isPackaged) {
        const port = await getPort({portRange: [30000, 40000]})
        const nextDir = app.getAppPath()
        process.env.GPTSCRIPT_BIN = join(dirname(nextDir), "binaries/gptscript-universal-apple-darwin")
        process.env.SCRIPTS_PATH = join(cacheDir, "scripts")
        process.env.THREADS_DIR = join(cacheDir, "threads")
        process.env.GPTSCRIPT_WORKSPACE_DIR = join(cacheDir, "workspace")

        console.log(`Starting app server for ${nextDir} at ${process.env.GPTSCRIPT_BIN}`)

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
    if (process.platform !== "darwin") {
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
    // win.webContents.openDevTools();
    win.webContents.on("did-fail-load", (e, code, desc) => {
        win.webContents.reloadIgnoringCache();
    });
}
