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
        // this.activeTarget = null; // No longer the single source of truth, but might be used for prioritization later
        this.targetBatches = new Map(); // Key: target, Value: { config, lastLaunchTime, count, depth, ramLimit, timeLimit, isFullySeeded }
        this.batchCounter = 0; // Might need adjustment for multi-target
        // this.isSeeding = false; // Seeding needs rethinking for multiple targets
        this.prepQueue = new Map(); // Key: target, Value: { state ('start', 'prepping', 'failed'), pid, attempts, prepId, host }

        this.ramCosts = {
            hack: ns.getScriptRam(CONFIG.HACK_WORKER),
            grow: ns.getScriptRam(CONFIG.GROW_WORKER),
            weak: ns.getScriptRam(CONFIG.WEAKEN_WORKER),
            prep: ns.getScriptRam(CONFIG.PREP_WORKER), // Add prep worker RAM cost
        };

        if (this.ramCosts.hack === 0 || this.ramCosts.grow === 0 || this.ramCosts.weak === 0 || this.ramCosts.prep === 0) {
            this.log.error('One or more worker scripts (including prep) have 0 RAM cost or are missing! Check config.js paths.');
        }
        this.log.info(`Worker RAM costs: H=${formatRam(ns, this.ramCosts.hack)}, G=${formatRam(ns, this.ramCosts.grow)}, W=${formatRam(ns, this.ramCosts.weak)}, P=${formatRam(ns, this.ramCosts.prep)}`);
    }

    // --- Core Management Loop --- Called by Scheduler
    async manageHacking(cycle = 0) { // Accept current scheduler cycle number
        this.log.info(`Starting hacking management cycle ${cycle}...`);

        // --- Target Evaluation ---
        const potentialTargets = this.selectTarget();
        if (potentialTargets.length === 0) {
            this.log.info('No viable targets found this cycle.');
            return;
        }

        // --- Manage Prep Queue First ---
        const completedPreps = [];
        const failedPreps = [];
        for (const [target, prepState] of this.prepQueue.entries()) {
            this.managePrepCycle(target); // Manage ongoing preps
            // Check if managePrepCycle removed it (completed) or marked as failed
            if (!this.prepQueue.has(target)) {
                completedPreps.push(target);
            } else if (prepState.state === 'failed') {
                failedPreps.push(target);
                this.prepQueue.delete(target); // Remove from queue after logging failure
            }
        }
        if (completedPreps.length > 0) {
            this.log.info(`Prep finished for: ${completedPreps.join(', ')}`);
        }
        if (failedPreps.length > 0) {
            this.log.error(`Prep failed for: ${failedPreps.join(', ')}. Removed from queue.`);
        }

        // --- Process Potential Targets ---
        this.log.info(`Processing ${potentialTargets.length} potential targets...`);
        // Get total FREE ram, not the whole stats object
        const totalFreeRam = this.resourceManager.getNetworkRamStats().totalFreeRam;
        this.log.info(`Initial free network RAM: ${formatRam(this.ns, totalFreeRam)}`)
        const ramUsedThisCycle = 0; // Track RAM used in this cycle

        for (const target of potentialTargets) {
            // 1. Skip if already being prepped or failed recently
            if (this.prepQueue.has(target)) {
                this.log.debug(`Target ${target} is already in the prep queue (State: ${this.prepQueue.get(target).state}). Skipping.`);
                continue;
            }
             // Optional: Add logic here to skip targets that failed prep recently

            // 2. Check if prepping is needed
            if (!this.isTargetPrepped(target)) {
                this.log.info(`Target ${target} needs prepping.`);
                const prepRamNeeded = this.calculatePrepRam(target); // Now returns cost of prepWorker
                if (prepRamNeeded === null || prepRamNeeded === 0) { // null if worker missing, 0 if already prepped
                    this.log.warn(`Prep worker RAM cost is zero or null for ${target}. Skipping.`);
                    continue;
                }
                this.log.debug(`RAM for prep worker on ${target}: ${formatRam(this.ns, prepRamNeeded)}`);

                // Conceptual check if RAM *might* be available
                if (totalFreeRam >= ramUsedThisCycle + prepRamNeeded) { 
                     this.log.info(`Sufficient potential RAM available. Attempting to launch prep worker for ${target}.`);
                     // Add to queue *before* trying to launch. managePrepCycle will handle launch.
                     this.prepQueue.set(target, {
                         state: 'start', // Initial state: needs launching
                         pid: 0,
                         attempts: 0,
                         prepId: `prep-${target}-${Date.now()}`,
                         host: null // Host will be set by managePrepCycle
                     });
                     this.log.info(`[${this.prepQueue.get(target).prepId}] Added ${target} to prep queue. Running managePrepCycle...`);
                     this.managePrepCycle(target); // Attempt to launch immediately
                     // If managePrepCycle fails to launch, it will handle state/attempts
                } else {
                    this.log.info(`Insufficient potential RAM to start prepping ${target} (Needs ${formatRam(this.ns, prepRamNeeded)}, Available ${formatRam(this.ns, totalFreeRam - ramUsedThisCycle)}).`);
                    break; // Stop trying to schedule more preps if RAM is low
                }
                continue; // Move to next target
            }

            // 3. Target is Prepped - Manage Hacking Batches (with Seeding)
            this.log.debug(`Target ${target} is prepped. Managing hack batches.`);
            let batchState = this.targetBatches.get(target);
            const now = Date.now();

            // Calculate config and initial seeding parameters if it's a new target
            if (!batchState) {
                const config = this.calculateBatchConfig(target);
                if (!config) {
                    this.log.warn(`Failed to calculate batch config for prepped target ${target}. Skipping.`);
                    continue;
                }
                
                // Calculate depth based on weaken time and interval
                // Limited by RAM available at calculation time (might need recalculation?)
                const { totalFreeRam } = this.resourceManager.getNetworkRamStats();
                const maxDepthRam = Math.max(1, Math.floor(totalFreeRam / config.ramPerBatch));
                const maxDepthTime = Math.max(1, Math.floor(config.weakenTime / config.interval)); // Batches fitting in weaken time
                const depth = Math.min(maxDepthRam, maxDepthTime);
                this.log.info(`Calculated initial depth for ${target}: ${depth} (RAM Limit: ${maxDepthRam}, Time Limit: ${maxDepthTime})`);

                batchState = {
                    config: config,
                    lastLaunchTime: 0, // Time the last batch component was launched
                    count: 0,          // Total batches launched (including seeds)
                    isSeeding: true,   // Start in seeding phase
                    batchesSeeded: 0,  // How many seed batches have launched
                    depth: depth,      // Target number of overlapping batches
                    ramLimit: maxDepthRam, // Store limits for potential future adjustments
                    timeLimit: maxDepthTime,
                };
                this.targetBatches.set(target, batchState);
                this.log.info(`Initialized batch state for ${target}. Starting seed phase (depth ${depth}).`);
                // Set lastLaunchTime to allow immediate launch of first seed batch
                batchState.lastLaunchTime = now - config.interval; 
            }

            const { config, lastLaunchTime, isSeeding, batchesSeeded, depth } = batchState;
            const interval = config.interval; // Interval between batch launches

            // Check if it's time to launch the next batch (seed or maintenance)
            if (now >= lastLaunchTime + interval - 50) { // Allow small buffer
                let batchType = isSeeding ? 'Seed' : 'Maintenance';
                let currentBatchNumber = isSeeding ? batchesSeeded + 1 : batchState.count + 1;

                if (isSeeding && batchesSeeded >= depth) {
                    this.log.info(`Seeding complete for ${target} (${batchesSeeded}/${depth} batches). Switching to maintenance.`);
                    batchState.isSeeding = false;
                    batchType = 'Maintenance'; // Launch maintenance immediately if interval allows
                    currentBatchNumber = batchState.count + 1; 
                }

                this.log.info(`Attempting ${batchType} Batch #${currentBatchNumber}` + (isSeeding ? `/${depth}` : ``) + ` launch for ${target}.`);
                
                // Execute batch (checks/reserves RAM internally)
                const executed = this.executeBatch(config, totalFreeRam - ramUsedThisCycle);
                
                if (executed) {
                    batchState.lastLaunchTime = now;
                    batchState.count++;
                    this.log.info(`Successfully initiated ${batchType} Batch ${batchState.count} for ${target}.`); 
                    if (batchState.isSeeding) { // Check isSeeding again in case it changed
                        batchState.batchesSeeded++;
                         this.log.info(`Seed progress for ${target}: ${batchState.batchesSeeded}/${depth}`);
                         if (batchState.batchesSeeded >= depth) {
                             batchState.isSeeding = false; // Mark seeding complete
                              this.log.info(`Seeding fully complete for ${target} after launching batch ${batchState.batchesSeeded}.`);
                         }
                    }
                    // NOTE: We assume ResourceManager handles RAM implicitly.
                    // If we wanted to launch multiple batches per cycle (e.g., catch up seeding),
                    // we'd need to update ramUsedThisCycle here and loop/recheck time/RAM.
                    // For now, only one launch attempt per target per cycle.
                } else {
                    this.log.warn(`Failed to execute ${batchType} batch for ${target} (Insufficient RAM or ns.exec failed).`);
                    // If a seed batch fails, should we pause seeding? Or just retry next cycle?
                    // If maintenance fails, we just retry next cycle.
                    // For now, just log and break the outer loop to preserve RAM for higher priority targets.
                    break; // Stop trying subsequent targets if a batch fails
                }
            } else {
                 this.log.debug(`Skipping batch launch for ${target}. Time until next: ${((lastLaunchTime + interval) - now).toFixed(0)}ms`);
            }
        } // End target loop

        this.log.info(`Hacking management cycle ${cycle} complete.`); // Removed RAM log as it's not tracked here directly anymore
    }

    // --- Target Selection Logic ---
    selectTarget() {
        const myLevel = this.ns.getHackingLevel();
        const potentialTargets = this.resourceManager.getServers()
            .filter(s => {
                if (!s.hasRoot) return false;
                if (this.ns.getServerMaxMoney(s.hostname) < CONFIG.HACK_MIN_TARGET_MONEY) return false;
                if (this.ns.getServerRequiredHackingLevel(s.hostname) > myLevel) return false;
                return true;
            })
            .map(s => {
                const hostname = s.hostname;
                const maxMoney = this.ns.getServerMaxMoney(hostname);
                // Use weaken time as a proxy for difficulty/time investment
                const weakenTime = this.ns.getWeakenTime(hostname);
                // Avoid division by zero or excessive scores for near-instant weakens
                const score = maxMoney / Math.max(1, weakenTime); // Use 1ms minimum for calculation
                return { hostname, score };
            });

        if (potentialTargets.length === 0) {
            this.log.warn('No viable targets found (rooted, min money, hack level).');
            return []; // Return empty array if none found
        }

        // Sort by calculated score (higher is better)
        potentialTargets.sort((a, b) => b.score - a.score);
        
        // Log the top few targets and scores
        const topTargetsLog = potentialTargets.slice(0, 5).map(t => `${t.hostname} (${formatNumber(this.ns, t.score, 1)})`).join(', ');
        this.log.info(`Found ${potentialTargets.length} potential targets. Top scores: ${topTargetsLog}`);

        // Return the sorted list of hostnames only
        return potentialTargets.map(t => t.hostname);
    }

    // --- Target Prepping ---
    isTargetPrepped(target) {
        const sec = this.ns.getServerSecurityLevel(target);
        const minSec = this.ns.getServerMinSecurityLevel(target);
        const money = this.ns.getServerMoneyAvailable(target);
        const maxMoney = this.ns.getServerMaxMoney(target);
        return sec <= minSec + CONFIG.HACK_PREP_SEC_BUFFER && money >= maxMoney * 0.99; // Allow tiny buffer
    }

    // --- Target Prepping State Machine (Simplified for Prep Worker) ---
    managePrepCycle(target) {
        const prepState = this.prepQueue.get(target);
        if (!prepState) {
            // This might happen if it finished or failed between the loop start and here
            this.log.debug(`managePrepCycle called for ${target}, but it's no longer in the prepQueue.`);
            return;
        }

        const { prepId } = prepState;
        const maxAttempts = 5; // Max attempts to *launch* the worker

        // State: start - Try to launch the prep worker
        if (prepState.state === 'start') {
             prepState.attempts++;
             if (prepState.attempts > maxAttempts) {
                 this.log.error(`[${prepId}] Prep failed for ${target} after ${maxAttempts} launch attempts. Marking as failed.`);
                 prepState.state = 'failed'; // Mark as failed, will be removed in next cycle's loop
                 return;
             }

             this.log.info(`[${prepId}] Attempt ${prepState.attempts}/${maxAttempts} to launch prep worker for ${target}...`);
             const scriptRam = this.ramCosts.prep;
             const assignments = this.resourceManager.findServersForThreads(scriptRam, 1);

             if (assignments.length > 0) {
                 const host = assignments[0].hostname;
                 this.log.info(`[${prepId}] Found host ${host} for prep worker.`);
                 
                 // Attempt to reserve RAM first
                 if (this.resourceManager.reserveRamBlocks(assignments, scriptRam)) {
                     this.log.info(`[${prepId}] Reserved ${formatRam(this.ns, scriptRam)} on ${host}. Executing prep worker...`);
                     const pid = this.ns.exec(CONFIG.PREP_WORKER, host, 1, target, prepId);

                     if (pid > 0) {
                         prepState.pid = pid;
                         prepState.host = host; // Store host where it runs
                         prepState.state = 'prepping';
                         this.log.info(`[${prepId}] Prep worker launched successfully on ${host} (PID: ${pid}).`);
                     } else {
                         this.log.error(`[${prepId}] Failed to ns.exec prep worker on ${host}. Releasing reservation.`);
                         this.resourceManager.releaseRamBlocks(assignments, scriptRam); // Release RAM if exec failed
                         // Stay in 'start' state to retry next cycle
                     }
                 } else {
                     this.log.warn(`[${prepId}] Failed to reserve RAM for prep worker on ${host} (state may have changed). Will retry next cycle.`);
                     // Stay in 'start' state
                 }
             } else {
                 this.log.warn(`[${prepId}] No suitable host found for prep worker (Needs ${formatRam(this.ns, scriptRam)}). Will retry next cycle.`);
                 // Stay in 'start' state
             }
             return; // End cycle after launch attempt
        }

        // State: prepping - Monitor the running worker
        if (prepState.state === 'prepping') {
            if (!prepState.pid || !prepState.host) {
                this.log.error(`[${prepId}] Invalid state: 'prepping' but no PID or host found! Marking failed.`);
                prepState.state = 'failed';
                return;
            }

            if (this.ns.isRunning(prepState.pid, prepState.host)) {
                this.log.debug(`[${prepId}] Prep worker (PID: ${prepState.pid} on ${prepState.host}) is still running...`);
            } else {
                this.log.info(`[${prepId}] Prep worker (PID: ${prepState.pid} on ${prepState.host}) has finished.`);
                // Worker finished, release the RAM it was using
                const ramReleased = this.ramCosts.prep;
                this.resourceManager.releaseRamBlocks([{ hostname: prepState.host, threads: 1 }], ramReleased);
                this.log.info(`[${prepId}] Released ${formatRam(this.ns, ramReleased)} on ${prepState.host}.`);
                
                // Check if target is actually prepped now
                if (this.isTargetPrepped(target)) {
                    this.log.info(`[${prepId}] Target ${target} is confirmed prepped. Removing from queue.`);
                    this.prepQueue.delete(target); // Success!
                } else {
                    this.log.error(`[${prepId}] Prep worker finished, but target ${target} is NOT prepped! Marking as failed.`);
                    prepState.state = 'failed'; // Mark as failed
                }
            }
            return; // End cycle after checking running process
        }
        
        // State: failed - Should be handled by the main loop, but log if somehow called
        if (prepState.state === 'failed') {
             this.log.warn(`[${prepId}] managePrepCycle called for failed prep state on ${target}.`);
             return;
        }

        // Should not be reached
        this.log.error(`[${prepId}] Target ${target} in unknown prep state: ${prepState.state}`);
        prepState.state = 'failed'; // Mark as failed if state is broken
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

    // --- Batch Execution (Needs update for reserveRamBlocks) ---
    executeBatch(config, availableRam) { 
        this.log.info(`Executing batch for ${config.target}. RAM per batch: ${formatRam(this.ns, config.ramPerBatch)}`);
        
        const tasks = [
            { script: CONFIG.HACK_WORKER, threads: config.hackThreads, delay: config.hackDelay, ram: this.ramCosts.hack, label: 'H' },
            { script: CONFIG.WEAKEN_WORKER, threads: config.weaken1Threads, delay: config.weaken1Delay, ram: this.ramCosts.weak, label: 'W1' },
            { script: CONFIG.GROW_WORKER, threads: config.growThreads, delay: config.growDelay, ram: this.ramCosts.grow, label: 'G' },
            { script: CONFIG.WEAKEN_WORKER, threads: config.weaken2Threads, delay: config.weaken2Delay, ram: this.ramCosts.weak, label: 'W2' },
        ];
        let allTasksLaunched = true;
        let allReservationsMade = true;
        const batchId = `${config.target}-${Date.now()}`; 
        const reservations = []; // Store reservations made for potential rollback

        for (const task of tasks) {
            if (task.threads <= 0) continue;
            const requiredRamForTask = task.threads * task.ram;
            const assignments = this.resourceManager.findServersForThreads(task.ram, task.threads);
            
            if (assignments.length === 0 || assignments.reduce((sum, a) => sum + a.threads, 0) < task.threads) {
                this.log.error(`Batch ${batchId} (${task.label}): Failed to find sufficient hosts for ${task.threads} threads (${formatRam(this.ns, requiredRamForTask)} RAM).`);
                allTasksLaunched = false;
                allReservationsMade = false; // Mark so we don't try to launch
                break; 
            }

            // Try to reserve RAM for this task component
            if (!this.resourceManager.reserveRamBlocks(assignments, task.ram)) {
                this.log.error(`Batch ${batchId} (${task.label}): Failed to RESERVE RAM for ${task.threads} threads. Aborting batch.`);
                allTasksLaunched = false;
                allReservationsMade = false; // Mark so we don't try to launch
                break;
            }
            reservations.push({ assignments, ram: task.ram }); 
            this.log.info(`Batch ${batchId} (${task.label}): Reserved RAM for ${task.threads} threads.`);

            this.log.info(`Batch ${batchId} (${task.label}): Assigning ${task.threads} threads across ${assignments.length} hosts.`);
            for (const assignment of assignments) {
                const pid = this.ns.exec(
                    task.script,
                    assignment.hostname,
                    assignment.threads,
                    config.target,
                    task.delay, // Pass delay
                    batchId, // Pass batch identifier
                    Math.random() // Unique arg to allow multiple calls
                );
                if (pid === 0) {
                    this.log.error(`Batch ${batchId} (${task.label}): Failed ns.exec on ${assignment.hostname} for ${assignment.threads} threads.`);
                    allTasksLaunched = false;
                    // Don't break inner loop, try other assignments, but batch is failed
                }
            }
            if (!allTasksLaunched) {
                // If any ns.exec failed for this task component, the whole batch is compromised
                this.log.error(`Batch ${batchId} (${task.label}): ns.exec failed for one or more assignments. Aborting batch launch.`);
                break; 
            }
        }

        // --- Post-execution Handling ---
        if (allTasksLaunched && allReservationsMade) {
             this.log.info(`Batch ${batchId} successfully launched all components.`);
             // RAM is reserved, scripts will release implicitly on finish (or manager could track PIDs/release later)
             return true;
        } else {
             this.log.error("Batch " + batchId + " failed to launch completely (Reservation or ns.exec failed). Releasing any reservations made.");
             // Release any RAM that *was* successfully reserved before the failure
             for (const res of reservations) {
                 this.resourceManager.releaseRamBlocks(res.assignments, res.ram);
             }
             return false;
        }
    }

    // --- Calculate RAM needed for next prep step (Simplified) ---
    calculatePrepRam(target) {
        // Just return the cost of the prep worker script
        if (this.isTargetPrepped(target)) {
            return 0; // Already prepped, no RAM needed
        }
        if (this.ramCosts.prep > 0) {
            return this.ramCosts.prep;
        } else {
            this.log.error(`Prep worker RAM cost is 0! Check config and script.`);
            return null; // Indicate error
        }
    }
} 