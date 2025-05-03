/**
 * config.js
 * Central configuration settings for the automation suite.
 */

export const CONFIG = {
    // --- General Settings ---
    LOG_LEVEL: 'INFO', // DEBUG, INFO, WARN, ERROR
    HOME_RESERVE_RAM: 32, // GB RAM to keep free on 'home'
    SCAN_INTERVAL: 60 * 1000, // ms between network scans (1 minute)

    // --- Hacking Settings ---
    HACK_TARGET_COUNT: 1, // Number of targets to hack simultaneously (initially 1)
    HACK_DEFAULT_PCT: 0.10, // Default percentage of money to hack (10%)
    HACK_DEFAULT_SPACER: 100, // ms spacer between batch tasks
    HACK_MIN_TARGET_MONEY: 1_000_000, // Minimum max money for a server to be considered a target
    HACK_PREP_SEC_BUFFER: 1, // Allow security this much above minimum during prep
    HACK_WEAKEN_THREADS_PER_GB: 12.5, // Approx threads per GB for weaken (used for rough RAM estimates)

    // --- Server Management ---
    SERVER_PURCHASE_ENABLED: true,
    SERVER_PURCHASE_TIER_RAM: 64, // Initial RAM target for purchased servers
    SERVER_MAX_COUNT: 25,

    // --- Script Names (for consistency) ---
    // Workers
    HACK_WORKER: 'workers/hack.js',      // Args: target, delay, batchId
    GROW_WORKER: 'workers/grow.js',      // Args: target, delay, batchId
    WEAKEN_WORKER: 'workers/weaken.js',    // Args: target, delay, batchId
    // Managers & Libraries
    SCHEDULER: 'scheduler.js',
    RESOURCE_MANAGER: 'managers/resourceManager.js',
    HACK_MANAGER: 'managers/hackManager.js',
    SERVER_MANAGER: 'managers/serverManager.js',
    LOGGER: 'lib/logger.js',
    UTILS: 'lib/utilities.js',
    AUG_DATA: 'data/augmentations.js', // Path to augmentation data
    // Add other script paths as needed...
};

// --- Faction & Augmentation Settings ---
export const FACTION_CONFIG = {
    // Factions to automatically join if invited (add more as needed)
    DESIRED_FACTIONS: [
        "CyberSec", "Tian Di Hui", "Netburners", "NiteSec", "The Black Hand",
        "BitRunners", "Daedalus", /* Add city factions, endgame factions etc. */
    ],
    // Augmentation purchase order (simplified list, ideally generated/prioritized)
    AUGMENTATION_PRIORITY: [
        "NeuroFlux Governor", // Always buy levels of this
        "CashRoot Starter Kit",
        // Hacking / Money
        "BitRunners Neurolink", 
        "CRTX42m gene modification",
        "Neural-Retention Enhancement",
        "Neuroreceptor Management Implant",
        // More Hacking
        "The Black Hand",
        // Add combat, utility, company, charisma augs based on goals
    ],
    // Work types preference order (will try first available)
    PREFERRED_WORK_TYPES: [
        ns.enums.FactionWorkType.hacking, // Generally best for rep
        ns.enums.FactionWorkType.field, 
        ns.enums.FactionWorkType.security,
    ],
    FOCUS_ON_WORK: true, // Whether to focus work for faster rep gain
};

// Helper to get config value, maybe add validation later
export function getConfig(ns, key) {
    if (CONFIG[key] === undefined) {
        ns.tprint(`WARN: Config key '${key}' not found in config.js`);
        return null;
    }
    return CONFIG[key];
} 