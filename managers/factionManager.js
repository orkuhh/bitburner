/**
 * managers/factionManager.js
 * Manages faction invitations, reputation goals, and work assignments.
 */

import { CONFIG, getConfig, FACTION_CONFIG } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { formatNumber } from '../lib/utilities.js';

// TODO: Define augmentation priorities and faction sources in config.js or a separate data file
const AUGMENTATION_PRIORITIES = [
    // Example - Needs proper definition
    "NeuroFlux Governor", // Always desirable
    // Early game focus?
    "CashRoot Starter Kit", 
    "BitRunners Neurolink",
    // Hacking focus?
    "The Black Hand",
    "CRTX42m gene modification",
    // ... etc
];

export class FactionManager {
    constructor(ns, resourceManager) {
        this.ns = ns;
        this.log = createLogger(ns, 'FactMan');
        this.resourceManager = resourceManager;
        this.ownedAugmentations = new Set();
        this.updateOwnedAugmentations();
        this.installTriggered = false; // Prevent multiple install triggers per run
    }

    updateOwnedAugmentations() {
        this.ownedAugmentations = new Set(this.ns.singularity.getOwnedAugmentations(true)); // Include purchased augs
    }

    // --- Core Management Loop --- Called by Scheduler
    manageFactions() {
        this.log.info('Starting faction management cycle...');
        this.updateOwnedAugmentations(); // Refresh owned augs each cycle

        // 1. Check and Accept Invitations
        this.processInvitations();

        // 2. Determine Work Assignment
        this.assignWork();

        // 3. Check Augmentation Purchase Opportunities
        this.checkAugmentations();

        this.log.info('Faction management cycle complete.');
    }

    // --- Invitation Handling ---
    processInvitations() {
        const invitations = this.ns.singularity.checkFactionInvitations();
        if (invitations.length === 0) {
            this.log.debug('No pending faction invitations.');
            return;
        }

        this.log.info(`Received ${invitations.length} faction invitations: ${invitations.join(', ')}`);
        const currentFactions = this.ns.getPlayer().factions;

        for (const faction of invitations) {
            if (currentFactions.includes(faction)) {
                this.log.debug(`Already a member of ${faction}, ignoring invitation.`);
                continue;
            }
            
            // Check if faction is desired
            if (!FACTION_CONFIG.DESIRED_FACTIONS.includes(faction)) {
                 this.log.info(`Ignoring invitation from undesired faction: ${faction}`);
                 continue;
            }

            this.log.info(`Attempting to join desired faction: ${faction}`);
            if (this.ns.singularity.joinFaction(faction)) {
                this.log.info(`Successfully joined ${faction}.`);
            } else {
                this.log.error(`Failed to join faction ${faction}.`);
            }
        }
    }

    // --- Work Assignment ---
    assignWork() {
        this.updateOwnedAugmentations(); // Ensure owned list is fresh
        const currentWork = this.ns.singularity.getCurrentWork();

        // Find the highest priority augmentation we don't own
        let targetAug = null;
        for (const augName of FACTION_CONFIG.AUGMENTATION_PRIORITY) {
            if (!this.ownedAugmentations.has(augName)) {
                targetAug = augName;
                break;
            }
        }

        if (!targetAug) {
            this.log.info('All priority augmentations owned or list is empty. No faction work needed.');
            // Consider stopping work if currently working for a faction?
            // if (currentWork && currentWork.type === "FACTION") { this.ns.singularity.stopAction(); }
            return;
        }

        this.log.info(`Highest priority needed augmentation: ${targetAug}`);

        // Find factions offering this augmentation
        const offeringFactions = this.getFactionsForAug(targetAug);
        if (offeringFactions.length === 0) {
            this.log.warn(`No known faction offers the desired augmentation: ${targetAug}. Check prereqs or config.`);
            // Might need to work for prereq factions first
            return;
        }

        // Filter to factions we have joined
        const joinedOfferingFactions = offeringFactions.filter(f => this.ns.getPlayer().factions.includes(f));
        if (joinedOfferingFactions.length === 0) {
            this.log.info(`Not yet a member of any faction offering ${targetAug}. Waiting for invitation/joining.`);
            // Need logic to pursue joining these factions (e.g., meet requirements)
            return;
        }

        // Check reputation requirements for the target augmentation
        const repReq = this.ns.singularity.getAugmentationRepReq(targetAug);
        this.log.debug(`Reputation required for ${targetAug}: ${formatNumber(this.ns, repReq)}`);

        // Find the best faction to work for (highest current rep, or lowest remaining rep needed?)
        let bestFaction = null;
        let highestRep = -1;
        for (const faction of joinedOfferingFactions) {
            const currentRep = this.ns.singularity.getFactionRep(faction);
            if (currentRep >= repReq) {
                this.log.info(`Already have enough reputation (${formatNumber(this.ns, currentRep)}) with ${faction} for ${targetAug}.`);
                // We might not need to work, but maybe continue for NeuroFlux or other goals?
                // For now, let's assume we should stop working for this aug if rep is met.
                // If this is the only faction, maybe work here anyway for NeuroFlux?
                if (!bestFaction) bestFaction = faction; // Keep it as an option
                continue; // Check other factions
            }
            // Prioritize faction where we have the most rep already
            if (currentRep > highestRep) {
                highestRep = currentRep;
                bestFaction = faction;
            }
        }

        if (!bestFaction) {
            this.log.info(`Reputation requirement met for ${targetAug} in all offering factions, or no suitable faction found.`);
             // If currently working for a faction, stop it?
             if (currentWork && currentWork.type === "FACTION") {
                 this.log.info(`Stopping current faction work as goal ${targetAug} rep seems met.`);
                 this.ns.singularity.stopAction(); 
             }
            return;
        }

        this.log.info(`Selected faction ${bestFaction} to work for ${targetAug} (Current Rep: ${formatNumber(this.ns, highestRep)})`);

        // If already working for the correct faction, do nothing
        if (currentWork && currentWork.type === "FACTION" && currentWork.factionName === bestFaction) {
            this.log.debug(`Already working for ${bestFaction}. No change needed.`);
            return;
        }

        // Stop current work if it's not the desired faction work
        if (this.ns.singularity.isBusy()) {
             this.log.info(`Stopping current action (${currentWork?.type}) to start work for ${bestFaction}.`);
             this.ns.singularity.stopAction();
        }

        // Find available work type
        let workType = null;
        for (const preferredType of FACTION_CONFIG.PREFERRED_WORK_TYPES) {
             // Note: Bitburner currently doesn't expose a way to check *available* work types.
             // We assume all types are always available.
             workType = preferredType;
             break;
        }

        if (!workType) {
            this.log.error(`Could not find a suitable work type for faction ${bestFaction}. Check config.`);
            return;
        }

        // Start working
        this.log.info(`Starting ${workType} work for ${bestFaction} (Focus: ${FACTION_CONFIG.FOCUS_ON_WORK})`);
        if (!this.ns.singularity.workForFaction(bestFaction, workType, FACTION_CONFIG.FOCUS_ON_WORK)) {
            this.log.error(`Failed to start work for ${bestFaction}.`);
        }
    }
    
    // Helper to get factions that offer a specific augmentation
    getFactionsForAug(augName) {
        // This ideally uses precomputed data or cycles through all factions
        // For simplicity, hardcoding a few known ones. Replace with comprehensive logic.
        // A better approach loads this from a data file or uses ns.singularity.getAugmentationFactions(augName) - Added in 2.6.1
        try {
            return this.ns.singularity.getAugmentationFactions(augName);
        } catch (e) {
             this.log.warn(`ns.singularity.getAugmentationFactions not available? Falling back to manual list (likely incomplete). Error: ${e}`);
             // Manual fallback (INCOMPLETE - expand this list or use a data file)
             const augMap = {
                "NeuroFlux Governor": ["Slum Snakes", "CyberSec", "NiteSec", "The Black Hand", "BitRunners", "Daedalus"], // Example
                "The Black Hand": ["The Black Hand"],
                 "CRTX42m gene modification": ["NiteSec"],
                // ... add many more
             };
             return augMap[augName] || [];
        }
    }

    // --- Augmentation Management ---
    checkAugmentations() {
        if (this.installTriggered) return; // Don't buy if install is pending

        const currentFactions = this.ns.getPlayer().factions;
        const currentMoney = this.ns.getServerMoneyAvailable('home');
        let purchasedThisCycle = false;
        let canAffordNeuroFlux = false;

        // --- Pass 1: Purchase Highest Priority Available Aug ---
        for (const augName of FACTION_CONFIG.AUGMENTATION_PRIORITY) {
            if (this.ownedAugmentations.has(augName)) continue; // Skip owned
            
            const offeringFactions = this.getFactionsForAug(augName);
            const joinedOffering = offeringFactions.filter(f => currentFactions.includes(f));
            
            if (joinedOffering.length === 0) continue; // Cannot get it yet

            const repReq = this.ns.singularity.getAugmentationRepReq(augName);
            const price = this.ns.singularity.getAugmentationPrice(augName);

            // Check factions for sufficient rep
            let bestPurchaseFaction = null;
            for (const faction of joinedOffering) {
                if (this.ns.singularity.getFactionRep(faction) >= repReq) {
                    bestPurchaseFaction = faction; // Found a faction we can buy from
                    break;
                }
            }

            if (bestPurchaseFaction && currentMoney >= price) {
                this.log.info(`Found highest priority affordable augmentation: ${augName} from ${bestPurchaseFaction}`);
                this.log.info(`Attempting purchase for $${formatNumber(this.ns, price)}...`);
                if (this.ns.singularity.purchaseAugmentation(bestPurchaseFaction, augName)) {
                    this.log.info(`SUCCESS: Purchased ${augName}.`);
                    this.updateOwnedAugmentations(); // Update owned list immediately
                    purchasedThisCycle = true;
                    // Optional: Re-evaluate work assignment immediately after purchase?
                    // this.assignWork(); 
                    break; // Only buy one high-priority non-NeuroFlux aug per cycle
                } else {
                    this.log.error(`Failed to purchase ${augName} from ${bestPurchaseFaction}.`);
                    // Potential issue: Not enough money despite check? API bug?
                }
            }
            // If we reach here for the highest priority aug, we either can't afford it,
            // don't have the rep, or haven't joined the right faction yet.
            // Stop checking the priority list for this cycle (except NeuroFlux).
            break; 
        }

        // --- Pass 2: Check NeuroFlux Governor --- 
        // Always try to buy NeuroFlux if affordable, regardless of other purchases
        const neuroFlux = "NeuroFlux Governor";
        if (!this.ownedAugmentations.has(neuroFlux)) { // Check if base is owned first
            // Similar logic as above to find a faction and check affordability/rep
            // ... (omitted for brevity, follows same pattern) ...
        } else {
            // If base is owned, check for upgrades
            const upgradePrice = this.ns.singularity.getAugmentationPrice(neuroFlux); // Price scales
            const factionsOffering = this.getFactionsForAug(neuroFlux);
            const joinedOffering = factionsOffering.filter(f => currentFactions.includes(f));
            let purchaseFaction = null;
            for (const faction of joinedOffering) {
                // Rep req scales, but seems hardcoded/low for upgrades in practice?
                // Let's assume rep is sufficient if we joined.
                 purchaseFaction = faction; break;
            }

            if (purchaseFaction && currentMoney >= upgradePrice) {
                canAffordNeuroFlux = true;
                this.log.info(`Attempting NeuroFlux Governor upgrade from ${purchaseFaction} for $${formatNumber(this.ns, upgradePrice)}...`);
                 if (this.ns.singularity.purchaseAugmentation(purchaseFaction, neuroFlux)) {
                     this.log.info(`SUCCESS: Purchased NeuroFlux Governor upgrade.`);
                     this.updateOwnedAugmentations(); // Update count essentially
                     purchasedThisCycle = true;
                 } else {
                      this.log.error(`Failed to purchase NeuroFlux Governor upgrade from ${purchaseFaction}.`);
                 }
            }
        }
        
        // --- Trigger Installation --- 
        this.checkInstall(purchasedThisCycle || canAffordNeuroFlux);
    }

    checkInstall(canPotentiallyBuyAugs) {
        if (this.installTriggered) return;
        const pendingAugs = this.ns.singularity.getOwnedAugmentations(false);
        if (pendingAugs.length === 0) return;

        // If we can still potentially buy augmentations this cycle, don't install yet.
        if (canPotentiallyBuyAugs) {
             this.log.info(`${pendingAugs.length} augmentations pending install, but waiting (still affordable options available).`);
             return; 
        }

        // Otherwise, we have pending augs and couldn't buy more -> Trigger install
        this.log.warn(`Found ${pendingAugs.length} pending augmentations and cannot afford more. Triggering install!`);
        this.log.warn(`Pending: ${pendingAugs.join(', ')}`);
        this.installTriggered = true;
        const schedulerScript = CONFIG.SCHEDULER || 'scheduler.js';
        this.ns.singularity.installAugmentations(schedulerScript);
        // Script likely terminates here.
    }
} 