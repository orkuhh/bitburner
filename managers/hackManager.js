/**
 * managers/hackManager.js
 * Manages all hacking-related activities, including target selection,
 * batch calculation, scheduling, and execution across available resources.
 */

import { CONFIG, getConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { formatRam, formatNumber } from '../lib/utilities.js';

export class HackManager {
    constructor(ns, resourceManager) {
        this.ns = ns;
        this.log = createLogger(ns, 'HackMan');
        this.resourceManager = resourceManager; // Reference to the resource manager
        this.activeTarget = null; // Store the target we are actively batching
        this.targetBatches = new Map(); // Key: target, Value: { config, lastLaunchTime, count }
        this.batchCounter = 0;
        this.isSeeding = false; // Flag to manage initial seeding phase
        this.lastTargetCheckCycle = 0; // Track scheduler cycles for periodic check
        this.targetCheckInterval = 10; // Re-evaluate best target every 10 cycles
        this.prepQueue = new Set(); // Targets currently being prepped

        this.ramCosts = {
            hack: ns.getScriptRam(CONFIG.HACK_WORKER),
            grow: ns.getScriptRam(CONFIG.GROW_WORKER),
            weak: ns.getScriptRam(CONFIG.WEAKEN_WORKER),
        };

        if (this.ramCosts.hack === 0 || this.ramCosts.grow === 0 || this.ramCosts.weak === 0) {
            this.log.error('One or more worker scripts have 0 RAM cost or are missing! Check config.js paths.');
            // Consider throwing an error or having a failed state
        }
        this.log.info(`Worker RAM costs: H=${formatRam(ns, this.ramCosts.hack)}, G=${formatRam(ns, this.ramCosts.grow)}, W=${formatRam(ns, this.ramCosts.weak)}`);
    }

    // --- Core Management Loop --- Called by Scheduler
    async manageHacking(cycle = 0) { // Accept current scheduler cycle number
        this.log.info('Starting hacking management cycle...');

        // Prevent overlapping seeding attempts
        if (this.isSeeding) {
            this.log.info('Currently seeding batches for a target. Skipping cycle.');
            return;
        }

        // --- Target Evaluation & Selection ---
        let forceRetarget = false;
        if (this.activeTarget) {
            const batchState = this.targetBatches.get(this.activeTarget);
            // Check if drained (only if config exists)
            if (batchState?.config) {
                 const money = this.ns.getServerMoneyAvailable(this.activeTarget);
                 const neededToHack = batchState.config.hackAmount; // Need to add hackAmount to config
                 if (money < neededToHack) {
                     this.log.info(`Target ${this.activeTarget} drained below hack amount ($${formatNumber(this.ns, money)} < $${formatNumber(this.ns, neededToHack)}). Forcing retarget.`);
                     forceRetarget = true;
                 }
            }
            // Periodic re-evaluation
            if (!forceRetarget && (cycle - this.lastTargetCheckCycle >= this.targetCheckInterval)) {
                this.log.info('Periodic target re-evaluation...');
                const bestPossibleTarget = this.selectTarget();
                 if (bestPossibleTarget && bestPossibleTarget !== this.activeTarget) {
                    // TODO: Add smarter comparison logic (e.g., is new target significantly better?)
                    this.log.info(`Found potentially better target ${bestPossibleTarget}. Current: ${this.activeTarget}. Forcing retarget.`);
                     forceRetarget = true;
                 } 
                 this.lastTargetCheckCycle = cycle;
            }
        }

        if (!this.activeTarget || forceRetarget) {
             const target = this.selectTarget();
             if (!target) {
                 this.log.warn('No suitable target found.');
                 this.activeTarget = null; // Ensure it stays null
                 this.targetBatches.clear();
                 return; 
             }
             if (target !== this.activeTarget) {
                 this.log.info(`Switching active target from ${this.activeTarget} to ${target}`);
                 this.activeTarget = target;
                 this.targetBatches.clear(); // Clear old batch state when switching targets
                 this.lastTargetCheckCycle = cycle; // Reset check timer on new target
             }
        }

        const target = this.activeTarget;
        if (!target) { 
            this.log.info('No active target this cycle.');
            return; 
        } // Exit if target selection failed entirely

        // 2. Prep Target if Necessary / Check Prep Queue
        if (this.prepQueue.has(target)) {
            this.log.info(`Target ${target} is still in the prep queue. Skipping batching.`);
            return; // Don't batch while prepping
        }
        if (!this.isTargetPrepped(target)) {
            this.log.warn(`Target ${target} needs prepping. Adding to prep queue.`);
            if (!this.prepQueue.has(target)) { // Add only if not already prepping
                this.targetBatches.delete(target); // Stop batching
                this.prepQueue.add(target); // Add to prep queue
                // Run prep asynchronously, don't await it here
                this.prepTarget(target).catch(e => this.log.error(`Prep task failed for ${target}: ${e}`)); 
            }
            return;
        }

        // 3. Get or Calculate Batch Configuration & Initiate Seeding
        let batchState = this.targetBatches.get(target);
        if (!batchState) {
            const config = this.calculateBatchConfig(target);
            if (!config) return;

            const { totalFreeRam } = this.resourceManager.getNetworkRamStats();
            const maxDepthRam = Math.max(1, Math.floor(totalFreeRam / config.ramPerBatch));
            const depthTime = Math.max(1, Math.floor(config.weakenTime / config.interval));
            const depth = Math.max(1, Math.min(maxDepthRam, depthTime));

            batchState = {
                config: config,
                depth: depth,
                lastLaunchTime: 0, 
                count: 0,
                ramLimit: maxDepthRam,
                timeLimit: depthTime,
                isFullySeeded: false // New flag
            };
            this.targetBatches.set(target, batchState);
            this.log.info(`Calculated config for ${target}: Depth=${depth} (RAM=${maxDepthRam}, Time=${depthTime}), Interval=${config.interval}ms`);
            
            // --- Initiate Seeding Phase --- 
            this.isSeeding = true;
            this.log.info(`--- Starting seed phase for ${target} (Depth: ${depth}) ---`);
            try {
                for (let i = 0; i < depth; i++) {
                    this.log.info(`Seeding batch ${i + 1}/${depth}...`);
                    const executed = this.executeBatch(config);
                    if (executed) {
                        batchState.lastLaunchTime = Date.now(); // Update time for each seed launch
                        batchState.count++;
                        if (i < depth - 1) { // Sleep between seed launches, but not after the last one
                           this.log.debug(`Seed: Sleeping for ${config.interval}ms...`);
                           await this.ns.sleep(config.interval);
                        }
                    } else {
                        this.log.error(`Seed phase failed on batch ${i + 1}/${depth}. Aborting seed.`);
                        // Clear state? Mark target as failed? For now, just stop seeding.
                        this.targetBatches.delete(target);
                        this.activeTarget = null; // Force target re-selection next cycle
                        this.isSeeding = false;
                        return; // Exit cycle
                    }
                }
                batchState.isFullySeeded = true;
                this.log.info(`--- Seed phase complete for ${target} (${batchState.count} batches launched) ---`);
            } catch (e) {
                this.log.error(`Exception during seeding: ${e}`);
            } finally {
                 this.isSeeding = false; // Ensure flag is reset even on error
            }
             // After seeding, continue to regular scheduling logic in the *next* cycle
             return; 
        }

        // 4. Regular Batch Scheduling (only if fully seeded)
        if (batchState.isFullySeeded) {
            const { config, lastLaunchTime } = batchState;
            const now = Date.now();
            if (now >= lastLaunchTime + config.interval) {
                this.log.info(`Interval elapsed for ${target}. Launching maintenance batch #${batchState.count + 1}`);
                const executed = this.executeBatch(config);
                if (executed) {
                    batchState.lastLaunchTime = now; 
                    batchState.count++;
                    this.log.info(`Launched maintenance batch ${batchState.count} for ${target}`);
                } else {
                    this.log.warn(`Failed to execute maintenance batch for ${target}. Will retry next cycle.`);
                }
            } else {
                 this.log.debug(`Skipping maintenance batch launch for ${target}. Time until next: ${((lastLaunchTime + config.interval) - now).toFixed(0)}ms`);
            }
        } else {
            // Should not happen if seeding logic is correct, but log just in case
            this.log.warn(`Target ${target} has state but is not fully seeded. Waiting for seeding to complete.`);
        }

        this.log.info('Hacking management cycle complete.');
    }

    // --- Target Selection Logic ---
    selectTarget() {
        const myLevel = this.ns.getHackingLevel();
        const potentialTargets = this.resourceManager.getServers()
            .filter(s => s.hasRoot && 
                         this.ns.getServerMaxMoney(s.hostname) >= CONFIG.HACK_MIN_TARGET_MONEY && 
                         this.ns.getServerRequiredHackingLevel(s.hostname) <= myLevel)
            .map(s => s.hostname);

        if (potentialTargets.length === 0) {
            this.log.warn('No viable targets found (rooted, min money, hack level).');
            return null;
        }

        // Simple sort: Max Money
        // TODO: Add more sophisticated scoring (hack time, growth rate, security level)
        potentialTargets.sort((a, b) => this.ns.getServerMaxMoney(b) - this.ns.getServerMaxMoney(a));
        return potentialTargets[0]; // Return the best single target for now
    }

    // --- Target Prepping ---
    isTargetPrepped(target) {
        const sec = this.ns.getServerSecurityLevel(target);
        const minSec = this.ns.getServerMinSecurityLevel(target);
        const money = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);
        return sec <= minSec + CONFIG.HACK_PREP_SEC_BUFFER && money >= maxMoney * 0.99; // Allow tiny buffer
    }

    // --- Target Prepping ---
    async prepTarget(target) {
        const prepId = `prep-${target}-${Date.now()}`;
        this.log.info(`[${prepId}] Starting async prep for ${target}`);
        const spacer = getConfig(this.ns, 'HACK_DEFAULT_SPACER');
        const prepSecBuffer = getConfig(this.ns, 'HACK_PREP_SEC_BUFFER');
        try {
            let attempts = 0;
            const maxAttempts = 10; // Prevent infinite loops
            while (attempts < maxAttempts) {
                attempts++;
                const currentSec = this.ns.getServerSecurityLevel(target);
                const minSec = this.ns.getServerMinSecurityLevel(target);
                const currentMoney = this.ns.getServerMoneyAvailable(target);
                const maxMoney = this.ns.getServerMaxMoney(target);
                const secThreshold = minSec + prepSecBuffer;

                this.log.info(`[${prepId}] Prep Attempt ${attempts}: Sec=${currentSec.toFixed(2)}/${secThreshold.toFixed(2)}, Money=$${formatNumber(this.ns, currentMoney)}/$${formatNumber(this.ns, maxMoney)}`);

                // Step 1: Weaken if necessary
                if (currentSec > secThreshold) {
                    const weakenNeeded = currentSec - minSec; // Weaken down to absolute minimum
                    const threads = Math.max(1, Math.ceil(this.ns.weakenAnalyze(weakenNeeded)));
                    const weakenTime = this.ns.getWeakenTime(target);
                    this.log.info(`[${prepId}] Weaken needed (${weakenNeeded.toFixed(2)}). Launching ${threads} threads (ETA: ${(weakenTime / 1000).toFixed(1)}s)...`);
                    const success = this.executePrepTask(CONFIG.WEAKEN_WORKER, target, threads, prepId);
                    if (!success) throw new Error(`[${prepId}] Failed launch weaken`);
                    this.log.info(`[${prepId}] Waiting for weaken...`);
                    await this.ns.sleep(weakenTime + spacer * 2); 
                    continue; 
                }

                // Step 2: Grow if necessary
                if (currentMoney < maxMoney) {
                    const growMultiplier = maxMoney / Math.max(1, currentMoney); // Avoid div by zero
                    const threads = Math.max(1, Math.ceil(this.ns.growthAnalyze(target, growMultiplier)));
                    const growTime = this.ns.getGrowTime(target);
                    this.log.info(`[${prepId}] Grow needed (x${growMultiplier.toFixed(2)}). Launching ${threads} threads (ETA: ${(growTime / 1000).toFixed(1)}s)...`);
                    const success = this.executePrepTask(CONFIG.GROW_WORKER, target, threads, prepId);
                    if (!success) throw new Error(`[${prepId}] Failed launch grow`);
                    this.log.info(`[${prepId}] Waiting for grow...`);
                    await this.ns.sleep(growTime + spacer * 2); 
                    continue; 
                }
                
                // If we reach here, prep is done
                this.log.info(`[${prepId}] Prep complete for ${target}.`);
                return; // Exit successfully
            }
            // If loop finishes without returning, max attempts reached
            throw new Error(`[${prepId}] Max prep attempts (${maxAttempts}) reached for ${target}.`);
        } catch (e) {
            this.log.error(`[${prepId}] Error during prep for ${target}: ${e.message || e}`);
            // Rethrow or handle as needed - ensures finally block runs
            throw e; 
        } finally {
            this.prepQueue.delete(target); 
            this.log.info(`[${prepId}] Removed ${target} from prep queue.`);
        }
    }
    
    // Helper for launching prep tasks (Correctly placed outside prepTarget)
    executePrepTask(script, target, threads, prepId) {
        const ramCost = this.ns.getScriptRam(script);
        if (ramCost <= 0) { this.log.error(`[${prepId}] Script ${script} RAM is zero!`); return false; }
        
        let overallSuccess = true;
        const assignments = this.resourceManager.findServersForThreads(ramCost, threads);
        if (assignments.length === 0) {
            this.log.warn(`[${prepId}] Could not find any servers for ${threads} threads of ${script}`);
            // This might be okay if other parts of the batch run, but indicates RAM pressure
            // overallSuccess = false; // Decide if this constitutes overall batch failure
            return overallSuccess;
        }

        for (const assign of assignments) {
            const pid = this.ns.exec(script, assign.hostname, assign.threads, target, 0, prepId);
            if (pid <= 0) {
                this.log.error(`[${prepId}] FAILED prep exec...`);
                overallSuccess = false;
            }
        }

        return overallSuccess;
    }

    // --- Batch Calculation ---
    calculateBatchConfig(target) {
        const spacer = getConfig(this.ns, 'HACK_DEFAULT_SPACER');
        const hackPct = getConfig(this.ns, 'HACK_DEFAULT_PCT');

        const hackTime = this.ns.getHackTime(target);
        const growTime = this.ns.getGrowTime(target);
        const weakenTime = this.ns.getWeakenTime(target);

        const maxTime = Math.max(hackTime, growTime, weakenTime);
        const batchPeriod = maxTime + 4 * spacer;
        const interval = 4 * spacer;

        const maxMoney = this.ns.getServerMaxMoney(target);
        const currentMoney = this.ns.getServerMoneyAvailable(target);
        // Prevent division by zero or negative hacks if money is somehow 0
        if (maxMoney <= 0 || currentMoney <= 0) {
            this.log.warn(`Target ${target} has zero or negative money ($${formatNumber(this.ns, maxMoney)}). Cannot calculate batch.`);
            return null;
        }

        const hackAmount = maxMoney * hackPct;
        const hackThreads = Math.max(1, Math.floor(this.ns.hackAnalyzeThreads(target, hackAmount)));
        const secGainHack = this.ns.hackAnalyzeSecurity(hackThreads);
        const weaken1Threads = Math.max(1, Math.ceil(this.ns.weakenAnalyze(secGainHack)));
        
        // Calculate growth multiplier needed, avoid issues if hack takes more than available
        const moneyAfterHack = Math.max(1, currentMoney - hackAmount); // Ensure positive floor
        const growthMultiplier = maxMoney / moneyAfterHack;
        const growThreads = Math.max(1, Math.ceil(this.ns.growthAnalyze(target, growthMultiplier)));
        
        const secGainGrow = this.ns.growthAnalyzeSecurity(growThreads);
        const weaken2Threads = Math.max(1, Math.ceil(this.ns.weakenAnalyze(secGainGrow)));

        const hackDelay = batchPeriod - hackTime - 3 * spacer;
        const weaken1Delay = batchPeriod - weakenTime - 2 * spacer;
        const growDelay = batchPeriod - growTime - spacer;
        const weaken2Delay = batchPeriod - weakenTime;

        const ramPerBatch = hackThreads * this.ramCosts.hack +
                            growThreads * this.ramCosts.grow +
                            (weaken1Threads + weaken2Threads) * this.ramCosts.weak;

        this.log.info(`Batch Calc (${target}): Period=${batchPeriod.toFixed(0)}ms, Interval=${interval}ms`);
        this.log.info(`Threads -> H:${hackThreads}, W1:${weaken1Threads}, G:${growThreads}, W2:${weaken2Threads} (RAM: ${formatRam(this.ns, ramPerBatch)})`);
        
        return {
            target, hackThreads, weaken1Threads, growThreads, weaken2Threads,
            hackDelay, weaken1Delay, growDelay, weaken2Delay,
            interval, ramPerBatch, weakenTime,
            hackAmount // Store the calculated hack amount for drain checks
        };
    }

    // --- Batch Scheduling & Execution ---
    // Removed scheduleBatches - logic moved into manageHacking

    // executeBatch now returns true on success, false on critical failure
    executeBatch(config) {
        const batchId = this.batchCounter++;
        this.log.info(`Executing batch ${batchId} for ${config.target}`);

        const tasks = [
            // Order matters for calculation, but exec is near-simultaneous
            { name: "H", script: CONFIG.HACK_WORKER, threads: config.hackThreads, delay: config.hackDelay, ram: this.ramCosts.hack },
            { name: "W1", script: CONFIG.WEAKEN_WORKER, threads: config.weaken1Threads, delay: config.weaken1Delay, ram: this.ramCosts.weak },
            { name: "G", script: CONFIG.GROW_WORKER, threads: config.growThreads, delay: config.growDelay, ram: this.ramCosts.grow },
            { name: "W2", script: CONFIG.WEAKEN_WORKER, threads: config.weaken2Threads, delay: config.weaken2Delay, ram: this.ramCosts.weak },
        ];

        let overallSuccess = true;
        for (const task of tasks) {
            if (task.threads <= 0) continue;
            if (task.ram <= 0) {
                this.log.error(`Script ${task.script} RAM is zero! Cannot execute.`);
                overallSuccess = false;
                continue;
            }

            const assignments = this.resourceManager.findServersForThreads(task.ram, task.threads);
            if (assignments.length === 0) {
                this.log.warn(`[B${batchId}-${task.name}] Could not find any servers for ${task.threads} threads of ${task.script}`);
                // This might be okay if other parts of the batch run, but indicates RAM pressure
                // overallSuccess = false; // Decide if this constitutes overall batch failure
                continue; 
            }

            let executedThreads = 0;
            for (const assign of assignments) {
                const pid = this.ns.exec(task.script, assign.hostname, assign.threads, config.target, task.delay, batchId);
                if (pid > 0) {
                    this.log.debug(`[B${batchId}-${task.name}] Launched ${assign.threads}t on ${assign.hostname} (PID ${pid})`);
                    executedThreads += assign.threads;
                } else {
                    this.log.error(`[B${batchId}-${task.name}] FAILED exec: ${assign.threads}t on ${assign.hostname}. Check RAM.`);
                    // If even one exec fails, we consider the batch potentially compromised
                    overallSuccess = false; 
                }
            }

             if (executedThreads < task.threads) {
                 this.log.warn(`[B${batchId}-${task.name}] Assigned only ${executedThreads}/${task.threads} threads.`);
                 // Not necessarily a failure, but indicates lack of resources.
             }
        }
        return overallSuccess;
    }
} 