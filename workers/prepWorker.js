/**
 * workers/prepWorker.js
 * Performs the weaken/grow cycle to prepare a target server for hacking.
 * Runs on a host allocated by the ResourceManager.
 */

import { getConfig, CONFIG } from '../config.js'; // Assuming config might be needed
import { createLogger } from '../lib/logger.js'; // Optional: for worker-specific logging
import { formatNumber, formatRam } from '../lib/utilities.js';

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog('ALL');
    // ns.enableLog('exec'); // Might need if it launches other scripts, unlikely
    ns.enableLog('growthAnalyzeSecurity');
    ns.enableLog('growthAnalyze');
    ns.enableLog('weakenAnalyze');
    ns.enableLog('getServerSecurityLevel');
    ns.enableLog('getServerMinSecurityLevel');
    ns.enableLog('getServerMoneyAvailable');
    ns.enableLog('getServerMaxMoney');
    ns.enableLog('grow');
    ns.enableLog('weaken');

    const host = ns.getHostname(); // Get the hostname we are running on
    const target = ns.args[0];
    const prepId = ns.args[1] || `prep-${target}-${Date.now()}`.slice(-10); // Get prepId passed from HackMan

    if (!target) {
        ns.tprint(`[${host}] ERROR: prepWorker.js requires a target server name as argument 1.`);
        return;
    }

    const log = createLogger(ns, `PrepWkr-${target.slice(0,4)}`); 
    log.info(`[${prepId}] Starting prep on host ${host} for target: ${target}`);

    const prepSecBuffer = getConfig(ns, 'HACK_PREP_SEC_BUFFER');
    const prepMoneyMultiplier = getConfig(ns, 'HACK_PREP_MONEY_MULTIPLIER') || 0.99; // Default to 99%
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes max per cycle (prevent infinite loops)
    let lastActionTime = Date.now();

    try {
        while (true) {
            const currentSec = ns.getServerSecurityLevel(target);
            const minSec = ns.getServerMinSecurityLevel(target);
            const currentMoney = ns.getServerMoneyAvailable(target);
            const maxMoney = ns.getServerMaxMoney(target);
            
            const secThreshold = minSec + prepSecBuffer;
            const moneyThreshold = maxMoney * prepMoneyMultiplier;

            log.info(`[${prepId}@${host}] Target State: Sec=${currentSec.toFixed(2)}/${secThreshold.toFixed(2)}, Money=$${formatNumber(ns, currentMoney)}/$${formatNumber(ns, moneyThreshold)}`);

            // Check if prepped
            if (currentSec <= secThreshold && currentMoney >= moneyThreshold) {
                log.info(`[${prepId}@${host}] Target ${target} successfully prepped! Exiting worker.`);
                break; // Prep complete
            }

             // Check for timeout
             if (Date.now() - lastActionTime > maxWaitTime) {
                log.warn(`[${prepId}@${host}] Prep cycle exceeded max wait time (${maxWaitTime / 1000}s). Exiting worker.`);
                break;
            }

            // Determine action
            if (currentSec > secThreshold) {
                log.info(`[${prepId}@${host}] Action: Security too high (${currentSec.toFixed(2)} > ${secThreshold.toFixed(2)}). Weakening...`);
                const weakenTime = ns.getWeakenTime(target);
                log.info(`Estimated weaken time: ${(weakenTime / 1000).toFixed(1)}s`);
                lastActionTime = Date.now();
                await ns.weaken(target);
                log.info(`[${prepId}@${host}] Weaken finished.`);
            } else if (currentMoney < moneyThreshold) {
                log.info(`[${prepId}@${host}] Action: Money too low ($${formatNumber(ns, currentMoney)} < $${formatNumber(ns, moneyThreshold)}). Growing...`);
                const growTime = ns.getGrowTime(target);
                log.info(`Estimated grow time: ${(growTime / 1000).toFixed(1)}s`);
                lastActionTime = Date.now();
                await ns.grow(target);
                log.info(`[${prepId}@${host}] Grow finished.`);
            } else {
                // Should be prepped if we reach here, but loop condition handles it.
                log.warn(`[${prepId}@${host}] Target ${target} in unexpected state. Waiting...`);
                await ns.sleep(5000); // Wait a bit before re-checking
            }
            
            // Small sleep to prevent hogging CPU and allow state updates
            await ns.sleep(100); 
        }
    } catch (e) {
        log.error(`[${prepId}@${host}] Error during prep worker execution: ${e.message}`);
    }
    log.info(`[${prepId}@${host}] Prep worker for ${target} finished.`);
} 