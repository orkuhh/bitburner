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
import { FactionManager } from './managers/factionManager.js';
import { GangManager } from './managers/gangManager.js';
import { CorpManager } from './managers/corpManager.js';
// Import other managers later (ServerManager, etc.)

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
    const factionManager = new FactionManager(ns, resourceManager);
    const gangManager = new GangManager(ns, resourceManager);
    const corpManager = new CorpManager(ns, resourceManager);
    // ... etc
    log.info('Managers initialized.');

    // --- Main Scheduling Loop ---
    log.info('Starting main scheduling loop...');
    let cycle = 0;
    while (true) {
        cycle++;
        log.info(`--- Scheduler Cycle ${cycle} Start ---`);

        try {
            // Task: Update network resource knowledge
            resourceManager.updateServerList();

            // Task: Manage Hacking Activities (now async)
            await hackManager.manageHacking(cycle);

            // Task: Manage Server Purchases/Upgrades (now async)
            if (CONFIG.SERVER_PURCHASE_ENABLED) {
                await serverManager.manageServers();
            }

            // Task: Manage Factions
            factionManager.manageFactions();

            // Task: Manage Gang
            if (ns.gang.inGang()) {
                gangManager.manageGang();
            }

            // Task: Manage Corporation
            corpManager.manageCorporation();

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