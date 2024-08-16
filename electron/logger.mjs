import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import chalk from 'chalk';

const colors = {
    trace: chalk.grey,
    debug: chalk.cyanBright,
    info: chalk.greenBright,
    warn: chalk.yellowBright,
    error: chalk.redBright
};

export class Logger {
    constructor(logDir) {
        this.logger = createLogger({
            level: 'debug',
            handleExceptions: true,
            handleRejections: true,
            format: format.combine(
                // Wrap top-level format in a combine to enable composition with transport formats.
                // The formats defined here will be added to all transports.
                format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            ),
            transports: [
                new DailyRotateFile({
                    dirname: logDir,
                    filename: '%DATE%.log',
                    datePattern: 'YYYY-MM-DD',
                    maxSize: '20m',
                    maxFiles: '14d',
                    zippedArchive: true,
                    format: format.combine(
                        format.uncolorize(),
                        format.json({
                            deterministic: true,
                            space: 2,
                            maximumDepth: 100,
                        }),
                    ),
                }),
                new transports.Console({
                    format: format.combine(
                        format.printf(({ timestamp, level, message }) => {
                            // Use chalk to colorize the log level since winston's format.colorize() can't set the level
                            // color when used in conjunction with format.printf.
                            const levelColor = colors[level] || chalk.reset;
                            return `${chalk.magentaBright(timestamp)} [${levelColor(level.toUpperCase())}]: ${message}`;
                        }),
                    )
                })
            ]
        });

        // const methods = ['debug', 'info', 'warn', 'error'];
        const methods = ['debug', 'info', 'warn', 'error'];

        // Dynamically assign top-level methods and functions property.
        // This allows access to the instance methods if the logger's methods are used to overwrite another logging
        // implementations methods/functions.
        // e.g. overwriting standard console logging
        // ```
        // Object.assign(console, logger.functions)
        // ```
        this.functions = {};
        methods.forEach(method => {
            this[method] = this.logger[method].bind(this.logger);
            this.functions[method] = this[method];
        });

        // Map console.log to logger.info instead of logger.log
        this.functions.log = this.info.bind(this);
        this.log = this.logger.log;

        // Map console.trace to logger.debug
        this.functions.trace = this.debug.bind(this)
        this.trace = this.debug.bind(this)
    }
}
