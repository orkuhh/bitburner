/**
 * managers/gangManager.js
 * Manages gang recruitment, member training, task assignment, and territory warfare.
 */

import { CONFIG, getConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';

// TODO: Define gang configuration in config.js
const GANG_CONFIG = {
    FACTION: "Slum Snakes", // Example: Which gang faction to join
    WANTED_PENALTY_THRESHOLD: 0.05, // Engage in warfare only if penalty is low
    TERRITORY_WARFARE_ENABLED: true,
    RECRUITMENT_ENABLED: true,
    ASCENSION_ENABLED: true,
    DEFAULT_TASK: "Train Combat", // Task for new recruits or idle members
    MONEY_TASK: "Traffick Illegal Arms", // Example money-making task
    RESPECT_TASK: "Terrorism", // Example respect-gaining task
    WANTED_REDUCTION_TASK: "Vigilante Justice",
    MIN_ASCENSION_MULTIPLIER: 1.5, // Minimum multiplier to ascend a member
};

export class GangManager {
    constructor(ns, resourceManager) {
        this.ns = ns;
        this.log = createLogger(ns, 'GangMan');
        this.resourceManager = resourceManager;
        this.gangInfo = null;
    }

    // --- Core Management Loop --- Called by Scheduler
    manageGang() {
        if (!this.ns.gang.inGang()) {
            this.log.info('Not currently in a gang. Attempting to join...');
            if (this.ns.gang.createGang(GANG_CONFIG.FACTION)) {
                 this.log.info(`Successfully created gang with faction ${GANG_CONFIG.FACTION}`);
            } else {
                this.log.info('Could not create/join gang. Need Karma? Correct faction?');
                return; // Cannot manage if not in gang
            }
        }

        // Update gang info each cycle
        this.gangInfo = this.ns.gang.getGangInformation();
        if (!this.gangInfo) {
            this.log.error('Failed to get gang information.');
            return;
        }
        
        this.log.info(`Managing gang ${this.gangInfo.faction} (Respect: ${this.ns.formatNumber(this.gangInfo.respect)}, Wanted: ${this.gangInfo.wantedLevel.toFixed(2)}/${this.gangInfo.wantedPenalty.toFixed(3)} Pen)`);

        // 1. Recruitment
        if (GANG_CONFIG.RECRUITMENT_ENABLED) {
            this.recruitMembers();
        }

        // 2. Ascension
        if (GANG_CONFIG.ASCENSION_ENABLED) {
            this.ascendMembers();
        }

        // 3. Task Assignment
        this.assignTasks();

        // 4. Equipment Purchase (Placeholder)
        this.purchaseEquipment();

        // 5. Territory Warfare
        if (GANG_CONFIG.TERRITORY_WARFARE_ENABLED) {
            this.manageWarfare();
        }

        this.log.info('Gang management cycle complete.');
    }

    // --- Recruitment ---
    recruitMembers() {
        while (this.ns.gang.canRecruitMember()) {
            const memberCount = this.ns.gang.getMemberNames().length;
            const newName = `member-${memberCount}`;
            this.log.info(`Recruiting new member: ${newName}`);
            if (!this.ns.gang.recruitMember(newName)) {
                 this.log.error(`Failed to recruit ${newName}.`);
                 break; // Stop trying if recruitment fails
            }
        }
    }

    // --- Ascension ---
    ascendMembers() {
        const members = this.ns.gang.getMemberNames();
        for (const memberName of members) {
            const ascResult = this.ns.gang.getAscensionResult(memberName);
            if (!ascResult) continue; // Cannot ascend (e.g., training)
            
            // Calculate total multiplier (simple check)
            const multiplier = (ascResult.hack || 1) * (ascResult.str || 1) * (ascResult.def || 1) * (ascResult.dex || 1) * (ascResult.agi || 1) * (ascResult.cha || 1);

            if (multiplier >= GANG_CONFIG.MIN_ASCENSION_MULTIPLIER) {
                 this.log.info(`Ascending member ${memberName} (Multiplier: ${multiplier.toFixed(2)}x)`);
                 if (this.ns.gang.ascendMember(memberName)) {
                     this.log.info(`Ascended ${memberName}.`);
                     // Optionally set back to training immediately?
                     // this.ns.gang.setMemberTask(memberName, GANG_CONFIG.DEFAULT_TASK);
                 } else {
                     this.log.error(`Failed to ascend ${memberName}.`);
                 }
            }
        }
    }

    // --- Task Assignment ---
    assignTasks() {
        const members = this.ns.gang.getMemberNames();
        const numMembers = members.length;
        const gangInfo = this.gangInfo; // Use cached info from start of cycle
        let assignedToWantedReduction = 0;

        for (const memberName of members) {
            // Prioritize reducing wanted level if high penalty
            if (gangInfo.wantedPenalty < (1 - GANG_CONFIG.WANTED_PENALTY_THRESHOLD) && gangInfo.wantedLevel > 1) {
                this.log.debug(`Assigning ${memberName} to ${GANG_CONFIG.WANTED_REDUCTION_TASK} (Wanted: ${gangInfo.wantedLevel.toFixed(1)})`);
                this.ns.gang.setMemberTask(memberName, GANG_CONFIG.WANTED_REDUCTION_TASK);
                assignedToWantedReduction++;
                continue; 
            }
            
            // Simple strategy: 
            // - Some focus on respect/money
            // - Others train if needed
            // TODO: Improve strategy based on stats, goals, gang power
            const memberInfo = this.ns.gang.getMemberInformation(memberName);
            
            // If member just ascended or is weak, train
            // A better check would look at specific stat thresholds
            if (memberInfo.hack_asc_mult < 1.1 && memberInfo.str_asc_mult < 1.1) { // Example weak check
                 if (memberInfo.task !== GANG_CONFIG.DEFAULT_TASK) {
                    this.log.debug(`Assigning ${memberName} to default training: ${GANG_CONFIG.DEFAULT_TASK}`);
                    this.ns.gang.setMemberTask(memberName, GANG_CONFIG.DEFAULT_TASK);
                 }
                 continue;
            }

            // Example: Split remaining members between money and respect tasks
            // This needs refinement - currently might assign everyone to one task
            if (numMembers > 0 && members.indexOf(memberName) < numMembers / 2) { // First half on money
                 if (memberInfo.task !== GANG_CONFIG.MONEY_TASK) {
                    this.log.debug(`Assigning ${memberName} to money task: ${GANG_CONFIG.MONEY_TASK}`);
                    this.ns.gang.setMemberTask(memberName, GANG_CONFIG.MONEY_TASK);
                 }
            } else { // Second half on respect
                if (memberInfo.task !== GANG_CONFIG.RESPECT_TASK) {
                    this.log.debug(`Assigning ${memberName} to respect task: ${GANG_CONFIG.RESPECT_TASK}`);
                    this.ns.gang.setMemberTask(memberName, GANG_CONFIG.RESPECT_TASK);
                }
            }
        }
        if (assignedToWantedReduction > 0) {
             this.log.info(`${assignedToWantedReduction}/${numMembers} members assigned to wanted reduction.`);
        }
    }

    // --- Equipment Purchase (Placeholder) ---
    purchaseEquipment() {
        // TODO: Get list of all equipment, check member stats, buy best affordable upgrades
        // this.log.debug('Equipment purchase logic placeholder.');
        const allEquip = this.ns.gang.getEquipmentNames();
        // Check money, iterate members, check owned equip, buy upgrades...
    }

    // --- Territory Warfare ---
    manageWarfare() {
        const gangInfo = this.gangInfo;
        if (gangInfo.territoryWarfareEngaged) {
             this.log.debug('Territory warfare already engaged.');
             return;
        }

        // Only engage if wanted penalty is low and have decent number of members
        if (gangInfo.wantedPenalty >= (1 - GANG_CONFIG.WANTED_PENALTY_THRESHOLD) && this.ns.gang.getMemberNames().length >= 6) {
             // Check potential power against other gangs
             const otherGangs = this.ns.gang.getOtherGangInformation();
             let canWin = false;
             for (const name in otherGangs) {
                 if (name === gangInfo.faction) continue;
                 if (otherGangs[name].power < gangInfo.power) {
                     // Simple check: engage if our power > any other gang's power
                     canWin = true;
                     break;
                 }
             }

             if (canWin) {
                this.log.info(`Engaging territory warfare (Power: ${gangInfo.power.toFixed(2)}, Wanted Pen: ${gangInfo.wantedPenalty.toFixed(3)})`);
                if (!this.ns.gang.setTerritoryWarfare(true)) {
                    this.log.error('Failed to engage territory warfare.');
                }
             } else {
                 // this.log.debug('Not strong enough to likely win territory warfare.');
                 // Ensure warfare is off if we decided not to engage
                 if (gangInfo.territoryWarfareEngaged) this.ns.gang.setTerritoryWarfare(false);
             }
        } else {
             // Ensure warfare is off if wanted penalty too high or too few members
             // this.log.debug(`Not engaging warfare (Wanted Pen: ${gangInfo.wantedPenalty.toFixed(3)}, Members: ${this.ns.gang.getMemberNames().length})`);
             if (gangInfo.territoryWarfareEngaged) this.ns.gang.setTerritoryWarfare(false);
        }
    }
} 