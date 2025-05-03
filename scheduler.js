/**
 * scheduler.js
 * Main orchestrator for the automation suite.
 * Loads managers, schedules tasks, and coordinates activities.
 */

import { CONFIG } from './config.js';
import { createLogger } from './lib/logger.js';
import { ResourceManager } from './managers/resourceManager.js';
import { HackManager } from './managers/hackManager.js';
import { ServerManager } from './managers/serverManager.js';
// import { FactionManager } from './managers/factionManager.js';
// import { GangManager } from './managers/gangManager.js';
// import { CorpManager } from './managers/corpManager.js';
// Import other managers later (ServerManager, etc.)

const HACKNET_MANAGER_SCRIPT = 'managers/hacknetManager.js';

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog('ALL');
    ns.enableLog('exec'); // Need exec to potentially start other scripts
    ns.tail(); // Open log window

    const log = createLogger(ns, 'Scheduler');
    log.info('--- Automation Suite Scheduler Starting --- ');

    // --- Initialize Managers ---
    log.info('Initializing managers...');
    const resourceManager = new ResourceManager(ns);
    const hackManager = new HackManager(ns, resourceManager);
    const serverManager = new ServerManager(ns, resourceManager);
    // let factionManager = new FactionManager(ns, resourceManager);
    // let gangManager = new GangManager(ns, resourceManager);
    // let corpManager = new CorpManager(ns, resourceManager);
    // ... etc
    log.info('Managers initialized.');

    // --- Ensure Hacknet Manager is Running ---
    if (!ns.isRunning(HACKNET_MANAGER_SCRIPT, 'home')) {
        log.info(`Starting ${HACKNET_MANAGER_SCRIPT}...`);
        const pid = ns.run(HACKNET_MANAGER_SCRIPT, 1); // Run with 1 thread
        if (pid === 0) {
            log.error(`Failed to start ${HACKNET_MANAGER_SCRIPT}. Insufficient RAM on home?`);
        } else {
            log.info(`Started ${HACKNET_MANAGER_SCRIPT} with PID ${pid}.`);
        }
    } else {
        log.info(`${HACKNET_MANAGER_SCRIPT} is already running.`);
    }

    // --- Main Scheduling Loop ---
    log.info('Starting main scheduling loop...');
    let cycle = 0;
    while (true) {
        cycle++;
        log.info(`--- Scheduler Cycle ${cycle} Start ---`);

        try {
            // Task: Update network resource knowledge
            await resourceManager.updateServerList();

            // Task: Manage Hacking Activities (now async)
            await hackManager.manageHacking(cycle);

            // Task: Manage Server Purchases/Upgrades (now async)
            if (CONFIG.SERVER_PURCHASE_ENABLED) {
                await serverManager.manageServers();
            }

            // Task: Manage Factions
            // factionManager.manageFactions();

            // Task: Manage Gang
            // gangManager.manageGang();

            // Task: Manage Corporation
            // corpManager.manageCorporation();

            // ... Add other scheduled tasks from the roadmap ...

        } catch (error) {
            log.error(`Unhandled exception in scheduler cycle: ${error.message}\n${error.stack}`);
        }

        log.info(`--- Scheduler Cycle ${cycle} End ---`);
        const interval = CONFIG.SCAN_INTERVAL || 60000; // Use scan interval for now
        log.info(`Sleeping for ${interval / 1000} seconds...`);
        await ns.sleep(interval);
    }
} 