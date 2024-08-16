import { app, BrowserWindow } from 'electron';
import { Logger } from './logger.mjs'
import { getPort } from 'get-port-please';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import fixPath from 'fix-path';

// The app is considered to be in dev mode if it's not packaged for production
const dev = !app.isPackaged

// Paths to the app's operational directories
const logDir = app.getPath('logs');
const dataDir = app.getPath('userData');
const appDir = app.getAppPath();
const resourcesDir = dirname(appDir)
const gptscriptBin= process.env.GPTSCRIPT_BIN || join(
    dev ? '' : join(resourcesDir, 'app.asar.unpacked'),
    'node_modules',
    '@gptscript-ai',
    'gptscript',
    'bin',
    `gptscript${process.platform === 'win32' ? '.exe' : ''}`
);
const threadsDir= process.env.THREADS_DIR || join(dataDir, 'threads');
const workspaceDir = process.env.WORKSPACE_DIR || join(dataDir, 'workspace');

// Gateway configuration
const gatewayUrl = process.env.GPTSCRIPT_GATEWAY_URL || 'https://gateway-api.gptscript.ai';

// Setup logger that tees both to stderr/out and rotating log files
const logger = new Logger(logDir);

export async function configure(){
    // Override default console logging
    Object.assign(console, logger.functions)

    // Propagate configuration to app via environment variables
    process.env.GPTSCRIPT_BIN = gptscriptBin;
    process.env.THREADS_DIR = threadsDir;
    process.env.WORKSPACE_DIR = workspaceDir;
    process.env.GPTSCRIPT_GATEWAY_URL = gatewayUrl;

    // Correct PATH environment variable so that tools can see and execute CLIs installed on the system.
    fixPath();

    // Bootstrap directories that must exist at runtime
    ensureDirExists(dataDir);
    ensureDirExists(workspaceDir);

    // Default to headless browsing for tools started by the app
    writeFileSync(
        join(workspaceDir, 'browsersettings.json'),
        JSON.stringify({ headless: true })
    );

    // Get the port (generate a random port in production if unset)
    const port = process.env.PORT || dev
        ? 3000 : await getPort({ portRange: [30000, 40000] })

    return {
        logger,
        dev,
        dir: appDir,
        port,
    }
}

function ensureDirExists(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
