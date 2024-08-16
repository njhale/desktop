import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export class Logger {
    constructor(logDir) {
        this.logger = createLogger({
            level: 'debug',
            handleExceptions: true,
            handleRejections: true,
            format: format.combine(
                format.prettyPrint(),
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),  // Custom timestamp format
                format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
                })
            ),
            transports: [
                new DailyRotateFile({
                    dirname: logDir,
                    filename: '%DATE%.log',
                    datePattern: 'YYYY-MM-DD',
                    maxSize: '20m',
                    maxFiles: '14d',
                    zippedArchive: true,
                    format: format.uncolorize(),
                }),
                new transports.Console({
                    format: format.combine(
                        format.colorize(),
                    )
                })
            ]
        });

        const methods = ['info', 'warn', 'error', 'debug'];

        // Dynamically assign top-level methods and functions property
        this.functions = {};
        methods.forEach(method => {
            this[method] = this.logger[method].bind(this.logger);
            this.functions[method] = this[method];
        });

        // Map console.log to logger.info instead of logger.log
        this.functions.log = this.info.bind(this);
        this.log = this.logger.log;
    }
}
