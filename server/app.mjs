import {createServer} from "http";
import next from "next";
import nextConfig from "../next.config.js"
import {Server} from "socket.io";
import {GPTScript, RunEventType} from "@gptscript-ai/gptscript";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import os from "os";

dotenv.config({path: ['../.env', '../.env.local']});

const AGENT = 1;
const USER = 2;
const STATE_FILE = "state.json";
let runningScript = null;
let serverRunning = false;
let gptscriptInitialized = false;
let gptscriptInitPromise = null;

export const startAppServer = ({dev, hostname, port, dir}) => {
    const address = `http://${hostname}:${port ?? 3000}`;

    return new Promise((resolve, reject) => {
        if (serverRunning) {
            console.log(`server already running at ${address}`);
            return resolve(address);
        }

        const app = next({
            dev: dev,
            hostname: hostname,
            port: port,
            conf: nextConfig,
            dir: dir,
            customServer: true,
        });
        const handler = app.getRequestHandler();

        const gptscript = new GPTScript({
            DefaultModelProvider: 'github.com/gptscript-ai/gateway-provider'
        });

        if (!gptscriptInitialized) {
            gptscriptInitPromise = initGPTScriptConfig(gptscript)
                .then(() => {
                    gptscriptInitialized = true;
                    console.log('GPTScript config initialized');
                })
                .catch((err) => {
                    console.error('Error initializing GPTScript config:', err);
                    reject(err);
                });
        }

        Promise.resolve(gptscriptInitPromise).then(() => {
            setInterval(() => {
                initGPTScriptConfig(gptscript)
                    .catch(err => {
                        console.error('Error updating GPTScript config:', err);
                    });
            }, 30 * 60 * 1000); // Pull the config from GitHub every 30 minutes

            app.prepare().then(() => {
                const httpServer = createServer(handler);
                const io = new Server(httpServer);

                io.on("connection", (socket) => {
                    io.emit("message", "connected");
                    socket.on("run", async (location, tool, args, scriptWorkspace, threadID) => {
                        if (runningScript) {
                            await runningScript.close();
                            runningScript = null;
                        }
                        try {
                            dismount(socket);
                            await mount(location, tool, args, scriptWorkspace, socket, threadID, gptscript);
                        } catch (e) {
                            socket.emit("error", e);
                        }
                    });
                });

                httpServer.once("error", (err) => {
                    reject(err);
                });

                httpServer.listen(port, () => {
                    serverRunning = true;
                    console.log(`> Server is ready at ${address}`);
                    resolve(address);
                });
            }).catch((err) => {
                reject(err);
            });
        });
    });
};

const mount = async (location, tool, args, scriptWorkspace, socket, threadID, gptscript) => {
    const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? process.env.GPTSCRIPT_WORKSPACE_DIR;
    const THREADS_DIR = process.env.THREADS_DIR ?? path.join(WORKSPACE_DIR, "threads");

    let script;
    if (typeof location === "string") {
        script = await gptscript.parse(location, true);
    } else {
        script = location;
    }


    const opts = {
        input: JSON.stringify(args || {}),
        disableCache: process.env.DISABLE_CACHE === "true",
        workspace: scriptWorkspace,
        prompt: true,
        confirm: true,
    };

    if (tool) opts.subTool = tool;

    let state = {};
    let statePath = '';
    if (threadID) statePath = path.join(THREADS_DIR, threadID, STATE_FILE);
    try {
        state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        if (state && state.chatState) {
            opts.chatState = state.chatState;
            // also load the tools defined the states so that when running a thread that has tools added in state, we don't lose them
            for (let block of script) {
                if (block.type === "tool") {
                    if (!block.tools) block.tools = [];
                    block.tools = [...new Set([...block.tools || [], ...(state.tools || [])])];
                    break;
                }
            }
            socket.emit("loaded", {messages: state.messages, tools: state.tools || []});
        }
    } catch (e) {
    }

    // Start the script
    let runningScript = null;
    socket.on("interrupt", async () => {
        if (runningScript) runningScript.close();
    });
    socket.on('disconnect', () => {
        if (runningScript) runningScript.close();
        runningScript = null;
    });

    if (!threadID || !state.chatState) {
        runningScript = await gptscript.evaluate(script, opts)
        socket.emit("running");

        runningScript.on(RunEventType.Event, (data) => socket.emit('progress', {
            frame: data,
            state: runningScript.calls
        }));
        runningScript.on(RunEventType.Prompt, async (data) => socket.emit("promptRequest", {
            frame: data,
            state: runningScript.calls
        }));
        runningScript.on(RunEventType.CallConfirm, (data) => socket.emit("confirmRequest", {
            frame: data,
            state: runningScript.calls
        }));
        socket.on("promptResponse", async (data) => await gptscript.promptResponse(data));
        socket.on("confirmResponse", async (data) => await gptscript.confirm(data));

        // Wait for the run to finish and emit any errors that occur. Specifically look for the "Run has been aborted" error
        // as this is a marker of an interrupt.
        runningScript.text()
            .then((output) => {
                if (!runningScript) return;

                if (!state.messages) state.messages = [];
                state.messages.push({type: AGENT, message: output});
                state.chatState = runningScript.currentChatState();

                if (threadID) {
                    fs.writeFile(statePath, JSON.stringify(state), (err) => {
                        if (err) {
                            socket.emit("error", err)
                        }
                    });
                }
            })
            .catch((e) => e && e != "Run has been aborted" && socket.emit("error", e))

    } else {
        socket.emit("running"); // temp
        socket.emit("resuming");
    }

    socket.on("addTool", async (tool) => {
        if (runningScript) {
            await runningScript.close();
            runningScript = null;
        }

        // find the root tool and then add the new tool
        for (let block of script) {
            if (block.type === "tool") {
                if (!block.tools) block.tools = [];
                block.tools = [...new Set([...block.tools || [], tool])];
                break;
            }
        }

        socket.emit("addingTool");

        const loaded = await gptscript.load(script, true);
        const newTools = toChatStateTools(loaded?.program?.toolSet)
        const currentState = JSON.parse(state.chatState);
        currentState.continuation.state.completion.tools = newTools;

        opts.chatState = JSON.stringify(currentState);
        state.chatState = JSON.stringify(currentState);
        state.tools = [...new Set([...state.tools || [], tool])];


        if (threadID) {
            fs.writeFile(statePath, JSON.stringify(state), (err) => {
                if (err) {
                    socket.emit("error", err);
                }
            });
        }

        socket.emit("toolAdded", state.tools);

    });

    socket.on("removeTool", async (tool) => {
        if (runningScript) {
            await runningScript.close();
            runningScript = null;
        }

        // find the root tool and then remove the tool
        for (let block of script) {
            if (block.type === "tool") {
                if (!block.tools) break;
                const stateTools = (state.tools || []).filter(t => t !== tool);
                block.tools = [...new Set(block.tools, ...stateTools)];
                break;
            }
        }

        /*
            note(tylerslaton)

            this is a hacky way to remove a tool from the chat state. When GPTScript does a run, it will
            automatically map all of the needed tools. These maps will also be in the chatState object.
            However, we cannot build these mappings unless we run the script.

            Why do we need to do this? Because the chatState of the current script has all of the past
            messages and tools used for this chat. As such, we need to merge the current tools/messages
            with the new tool mappings for the removed tool. If you're reading this and think its bad like
            I do but have a better solution please please please throw a PR up.
        */
        socket.emit("removingTool");

        const currentState = JSON.parse(state.chatState);

        opts.chatState = undefined; // Clear the chat state so that we can get the new tool mappings
        opts.input = 'do nothing'; // Ensure the LLM doesn't try to call tools without input
        const newStateRun = await gptscript.evaluate(script, opts);

        newStateRun.on(RunEventType.CallConfirm, (frame) => {
            let response;
            if (!frame.error && frame.toolCategory === "provider") {
                // Auto-confirm gateway provider
                response = {
                    id: frame.id,
                    accept: true,
                };
            } else {
                // Deny all other tool run requests
                response = {
                    id: frame.id,
                    accept: false,
                    message: 'do nothing'
                };
            }

            gptscript.confirm(response);
        });

        await newStateRun.text();
        await newStateRun.close();

        const newState = JSON.parse(newStateRun.currentChatState());
        currentState.continuation.state.completion.tools = newState.continuation.state.completion.tools;

        opts.chatState = JSON.stringify(currentState);
        state.tools = state.tools.filter(t => t !== tool);

        if (threadID) {
            fs.writeFile(statePath, JSON.stringify(state), (err) => {
                if (err) {
                    socket.emit("error", err);
                }
            });
        }

        socket.emit("toolRemoved", state.tools);
    });

    // If the user sends a message, we continue and setup the next chat's event listeners
    socket.on('userMessage', async (message, newThreadId) => {
        if (newThreadId) {
            threadID = newThreadId;
            statePath = path.join(THREADS_DIR, threadID, STATE_FILE);
        }

        // Remove any previous promptResponse or confirmResponse listeners
        socket.removeAllListeners("promptResponse");
        socket.removeAllListeners("confirmResponse");

        // If there is not a running script, that means we're loading a thread and have been waiting
        // for the user to send a message.
        if (!runningScript) {
            opts.input = message;
            runningScript = await gptscript.evaluate(script, opts);
        } else {
            runningScript = runningScript.nextChat(message);
        }

        
        runningScript.on(RunEventType.Event, (data) => socket.emit('progress', {
            frame: data,
            state: runningScript.calls
        }));
        runningScript.on(RunEventType.Prompt, async (data) => socket.emit("promptRequest", {
            frame: data,
            state: runningScript.calls
        }));
        runningScript.on(RunEventType.CallConfirm, (data) => socket.emit("confirmRequest", {
            frame: data,
            state: runningScript.calls
        }));
        socket.on("promptResponse", async (data) => await gptscript.promptResponse(data));
        socket.on("confirmResponse", async (data) => await gptscript.confirm(data));

        // Wait for the run to finish and emit any errors that occur
        runningScript.text()
            .then((output) => {
                if (!runningScript) return;
                if (!state.messages) state.messages = [];
                state.messages.push(
                    {type: USER, message: message},
                    {type: AGENT, message: output}
                )

                state.chatState = runningScript.currentChatState();

                if (threadID) {
                    fs.writeFile(statePath, JSON.stringify(state), (err) => {
                        if (err) {
                            socket.emit("error", err);
                        }
                    });
                }
            })
            .catch((e) => e && e != "Run has been aborted" && socket.emit("error", e));
    });

}

// Only one script is allowed to run at a time in this system. This function is to dismount and
// previously mounted listeners.
const dismount = (socket) => {
    socket.removeAllListeners("promptResponse");
    socket.removeAllListeners("confirmResponse");
    socket.removeAllListeners("userMessage");
    socket.removeAllListeners("disconnect");
}

function kebabToCamelCase(str) {
    return str.replace(/-./g, match => match.charAt(1).toUpperCase());
}

function toChatStateTools(toolSet) {
    return Object.entries(toolSet)
        .filter(([key]) => !key.startsWith("inline:"))
        .map(([key, tool]) => ({
            function: {
                toolID: key,
                name: kebabToCamelCase(tool.name || ""),
                description: tool.description,
                parameters: tool.arguments || {},
            }
        }));
}

const initGPTScriptConfig = async (gptscript) => {
    // Run a non-LLM no-op script to ensure the GPTScript config exists
    const run = await gptscript.evaluate({
        instructions: '#!sys.echo noop'
    })
    await run.text()
    await run.close()

    const configPath = gptscriptConfigPath();

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (err) {
        console.error('Error reading config file:', err);
        return;
    }

    const response = await fetch('https://raw.githubusercontent.com/gptscript-ai/gateway-config/main/config.json')
    const defaultConfig = await response.json()

    // Update the config object with default values if they don't exist
    config = {
        ...defaultConfig,
        ...config,
        integrations: {
            ...defaultConfig.integrations,
            ...config.integrations
        }
    };

    // Write the updated config back to the file
    fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8', (writeErr) => {
        if (writeErr) {
            console.error('Error writing config file:', writeErr);
            return;
        }
        console.log('Config file updated successfully');
    });
}

function gptscriptConfigPath() {
    const homeDir = os.homedir();
    let configDir;

    if (os.platform() === 'darwin') {
        configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, 'Library', 'Application Support')
    } else if (os.platform() === 'win32') {
        configDir = path.join(homeDir, 'AppData', 'Local');
    } else if (os.platform() === 'linux') {
        configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    } else {
        throw new Error('Unsupported platform');
    }

    return path.join(configDir, 'gptscript', 'config.json');
}
