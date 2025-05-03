/**
 * managers/serverManager.js
 * Handles purchasing and managing player-owned servers.
 */

import { CONFIG, getConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { formatNumber, formatRam } from '../lib/utilities.js';

const PURCHASED_SERVER_PREFIX = "pserv-";

export class ServerManager {
    constructor(ns, resourceManager) {
        this.ns = ns;
        this.log = createLogger(ns, 'SrvMan');
        this.resourceManager = resourceManager; // May not be strictly needed, but good for context
    }

    // Helper to copy essential scripts to a new server
    async provisionServer(hostname) {
        this.log.info(`Provisioning ${hostname} with core scripts...`);
        const scriptsToCopy = [
            CONFIG.HACK_WORKER,
            CONFIG.GROW_WORKER,
            CONFIG.WEAKEN_WORKER,
        ];
        let success = true;
        for (const script of scriptsToCopy) {
            if (!await this.ns.scp(script, hostname, "home")) {
                 this.log.error(`Failed to copy ${script} to ${hostname}`);
                 success = false;
                 // Decide if we should stop provisioning on first failure
            }
        }
        if (success) {
            this.log.info(`Finished provisioning ${hostname}.`);
        } else {
             this.log.warn(`Provisioning incomplete for ${hostname}.`);
        }
        // Trigger resource manager update after provisioning?
        // this.resourceManager.updateServerList(); 
        return success;
    }

    // --- Core Management Loop --- Called by Scheduler
    async manageServers() {
        if (!getConfig(this.ns, 'SERVER_PURCHASE_ENABLED')) {
            // this.log.debug('Server purchasing is disabled in config.');
            return;
        }

        const currentMoney = this.ns.getServerMoneyAvailable('home');
        const maxServers = getConfig(this.ns, 'SERVER_MAX_COUNT') || this.ns.getPurchasedServerLimit();
        const purchasedServers = this.ns.getPurchasedServers();
        const targetRam = getConfig(this.ns, 'SERVER_PURCHASE_TIER_RAM') || 8;

        this.log.info(`Managing servers: ${purchasedServers.length}/${maxServers} owned. Target RAM: ${formatRam(this.ns, targetRam)}`);

        // --- Purchase Logic ---
        if (purchasedServers.length < maxServers) {
            const purchaseCost = this.ns.getPurchasedServerCost(targetRam);
            if (currentMoney >= purchaseCost) {
                const hostname = PURCHASED_SERVER_PREFIX + purchasedServers.length;
                this.log.info(`Attempting to purchase server ${hostname} with ${formatRam(this.ns, targetRam)} RAM for $${formatNumber(this.ns, purchaseCost)}...`);
                const result = this.ns.purchaseServer(hostname, targetRam);
                if (result) {
                    this.log.info(`SUCCESS: Purchased server ${result} with ${formatRam(this.ns, targetRam)} RAM.`);
                    await this.provisionServer(result); // Provision after purchase
                } else {
                    this.log.error(`Failed to purchase server ${hostname}. Not enough money? ($${formatNumber(this.ns, currentMoney)} available)`);
                }
            } else {
                this.log.info(`Cannot afford new server ($${formatNumber(this.ns, purchaseCost)}). Need $${formatNumber(this.ns, purchaseCost - currentMoney)} more.`);
            }
            return; // Prioritize buying new servers before upgrading existing ones
        }

        // --- Upgrade Logic (Refined) ---
        this.log.info('Max servers reached. Checking for upgrades...');
        let bestUpgradeAction = null; // { hostname, newRam, cost }

        for (const hostname of purchasedServers) {
            const currentRam = this.ns.getServerMaxRam(hostname);
            const nextRamTier = currentRam * 2; // Try doubling RAM
            // Optional: Add a max RAM cap from config?

            // Check if we can afford to double the RAM
            const upgradeCost = this.ns.getPurchasedServerUpgradeCost(hostname, nextRamTier);
            if (upgradeCost <= 0) { // Can happen if RAM is already maxed or invalid
                // this.log.debug(`Cannot calculate upgrade cost for ${hostname} to ${formatRam(this.ns, nextRamTier)} (maybe maxed out?)`);
                continue; 
            }

            if (currentMoney >= upgradeCost) {
                 // Found an affordable upgrade. Is it the best one so far?
                 // Prioritize cheaper upgrades first
                 if (!bestUpgradeAction || upgradeCost < bestUpgradeAction.cost) {
                     bestUpgradeAction = {
                         hostname: hostname,
                         currentRam: currentRam,
                         newRam: nextRamTier,
                         cost: upgradeCost
                     };
                 }
            }
        }

        // Execute the best affordable upgrade found
        if (bestUpgradeAction) {
             this.log.info(`Found best affordable upgrade: ${bestUpgradeAction.hostname} (${formatRam(this.ns, bestUpgradeAction.currentRam)} -> ${formatRam(this.ns, bestUpgradeAction.newRam)}) for $${formatNumber(this.ns, bestUpgradeAction.cost)}`);
             if (this.ns.upgradePurchasedServer(bestUpgradeAction.hostname, bestUpgradeAction.newRam)) {
                 this.log.info(`SUCCESS: Upgraded ${bestUpgradeAction.hostname} to ${formatRam(this.ns, bestUpgradeAction.newRam)}.`);
                 // Re-provisioning might not be needed for upgrade, but good practice?
                 // await this.provisionServer(bestUpgradeAction.hostname);
             } else {
                  this.log.error(`Failed to upgrade ${bestUpgradeAction.hostname}. Money: $${formatNumber(this.ns, currentMoney)}, Cost: $${formatNumber(this.ns, bestUpgradeAction.cost)}`);
             }
        } else {
            this.log.info('No affordable upgrades found this cycle.');
        }
        
    }
} 