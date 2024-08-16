export {};

declare global {
    interface Window {
        overrideConsole: () => void;
    }
}

