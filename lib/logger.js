/**
 * lib/logger.js
 * Simple logger utility.
 */

import { CONFIG } from '../config.js';

const LOG_LEVELS = {
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
};

export class Logger {
    constructor(ns, moduleName = 'CORE') {
        this.ns = ns;
        this.moduleName = moduleName;
        this.logLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] || LOG_LEVELS.INFO;
    }

    _log(level, message, ...args) {
        if (LOG_LEVELS[level] < this.logLevel) {
            return; // Skip logging if below configured level
        }
        const timestamp = new Date().toLocaleTimeString();
        const prefix = `${timestamp} [${level}] ${this.moduleName}:`;
        const formattedMessage = args.length > 0 ? this.ns.sprintf(message, ...args) : message;
        this.ns.print(`${prefix} ${formattedMessage}`);
    }

    debug(message, ...args) {
        this._log('DEBUG', message, ...args);
    }

    info(message, ...args) {
        this._log('INFO', message, ...args);
    }

    warn(message, ...args) {
        this._log('WARN', message, ...args);
    }

    error(message, ...args) {
        this._log('ERROR', message, ...args);
    }
}

/** 
 * Creates a logger instance for a specific module.
 * @param {NS} ns 
 * @param {string} moduleName 
 * @returns {Logger}
 */
export function createLogger(ns, moduleName) {
    return new Logger(ns, moduleName);
} 