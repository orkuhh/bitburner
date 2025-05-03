/**
 * managers/resourceManager.js
 * Manages knowledge of network servers and their RAM resources.
 */

import { CONFIG, getConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { scanServers, formatRam, formatNumber } from '../lib/utilities.js';

// List of essential worker scripts to ensure exist on usable servers
const WORKER_SCRIPTS = [
    CONFIG.HACK_WORKER,
    CONFIG.GROW_WORKER,
    CONFIG.WEAKEN_WORKER,
    CONFIG.PREP_WORKER,
];

export class ResourceManager {
    constructor(ns) {
        this.ns = ns;
        this.log = createLogger(ns, 'ResMan');
        this.servers = [];
        this.reservedRam = new Map();
        this.workerScripts = WORKER_SCRIPTS;
        this.updateServerList();
    }

    // Scan network and update list of usable servers (rooted, has RAM)
    async updateServerList() {
        this.log.info('Updating server list and provisioning workers...');
        const allServers = scanServers(this.ns);
        const usableServers = [];
        const newlyReserved = new Map();

        for (const hostname of allServers) {
            if (!this.ns.hasRootAccess(hostname)) continue;
            const maxRam = this.ns.getServerMaxRam(hostname);
            if (maxRam <= 0) continue;

            const serverData = {
                hostname,
                maxRam,
                hasRoot: true,
            };

            let provisioned = true;
            if (hostname !== 'home') {
                for (const script of this.workerScripts) {
                    if (!this.ns.fileExists(script, hostname)) {
                        this.log.info(`Copying ${script} to ${hostname}...`);
                        if (!(await this.ns.scp(script, hostname, "home"))) {
                            this.log.error(`Failed to copy ${script} to ${hostname}. Marking as unusable.`);
                            provisioned = false;
                            break;
                        }
                    }
                }
            }
            
            if (!this.reservedRam.has(hostname)) {
                this.reservedRam.set(hostname, 0);
            }
            newlyReserved.set(hostname, this.reservedRam.get(hostname));

            if (provisioned) {
                usableServers.push(serverData);
            }
        }

        this.servers = usableServers;
        this.reservedRam = newlyReserved;

        this.log.info(`Found ${this.servers.length} usable servers.`);
        this.logTotalRam();
    }

    // Get the current list of usable servers
    getServers() {
        return this.servers;
    }

    // Calculate total and free RAM across the network
    getNetworkRamStats() {
        let totalMaxRam = 0;
        let totalUsedRam = 0;
        let totalReservedRam = 0;

        const homeReserve = getConfig(this.ns, 'HOME_RESERVE_RAM');

        for (const server of this.servers) {
            const maxRam = server.maxRam;
            const usedRam = this.ns.getServerUsedRam(server.hostname);
            const reservedRam = this.reservedRam.get(server.hostname) || 0;
            
            totalMaxRam += maxRam;
            totalUsedRam += usedRam;
            totalReservedRam += reservedRam;

            const actualAvailable = maxRam - usedRam;
            if (reservedRam > actualAvailable) {
                this.log.warn(`Reservation mismatch on ${server.hostname}: Reserved ${formatRam(this.ns, reservedRam)}, but only ${formatRam(this.ns, actualAvailable)} available (Max ${formatRam(this.ns, maxRam)}, Used ${formatRam(this.ns, usedRam)}). Adjusting reservation down.`);
                this.reservedRam.set(server.hostname, Math.max(0, actualAvailable));
                totalReservedRam = Array.from(this.reservedRam.values()).reduce((a, b) => a + b, 0);
            }
        }

        // Calculate free RAM: Max - Used - Reserved
        const totalEffectivelyUsed = totalUsedRam + totalReservedRam;
        let totalFreeRam = totalMaxRam - totalEffectivelyUsed;

        const homeServer = this.servers.find(s => s.hostname === 'home');
        if (homeServer) {
            const homeUsed = this.ns.getServerUsedRam('home');
            const homeReserved = this.reservedRam.get('home') || 0;
            const homeEffectivelyAvailable = homeServer.maxRam - homeUsed - homeReserved;
            const applicableHomeReserve = Math.min(homeEffectivelyAvailable, homeReserve);
            totalFreeRam = Math.max(0, totalFreeRam - applicableHomeReserve);
        }
        
        return { 
            totalMaxRam,
            totalUsedRam,
            totalReservedRam,
            totalFreeRam
        };
    }

    logTotalRam() {
        const stats = this.getNetworkRamStats();
        this.log.info(`Network RAM: ${formatRam(this.ns, stats.totalFreeRam)} free / ${formatRam(this.ns, stats.totalMaxRam)} total ` +
                      `(Used: ${formatRam(this.ns, stats.totalUsedRam)}, Reserved: ${formatRam(this.ns, stats.totalReservedRam)})`);
    }

    // Find the best server(s) to run a script with given RAM requirement
    findBestServer(requiredRam) {
        this.log.warn("findBestServer is deprecated. Use findServersForThreads.");
        const assignments = this.findServersForThreads(requiredRam, 1);
        return assignments.length > 0 ? assignments[0].hostname : null;
    }

    // Find multiple servers to distribute threads across
    // Returns an array of { hostname, threads }
    findServersForThreads(scriptRam, totalThreads) {
        if (scriptRam <= 0 || totalThreads <= 0) return [];

        const homeReserve = getConfig(this.ns, 'HOME_RESERVE_RAM');
        const assignments = [];
        let threadsAssigned = 0;

        const serverAvailability = this.servers.map(server => {
            const usedRam = this.ns.getServerUsedRam(server.hostname);
            const reservedRam = this.reservedRam.get(server.hostname) || 0;
            let availableRam = server.maxRam - usedRam - reservedRam;
            
            if (server.hostname === 'home') {
                const homeBuffer = Math.min(server.maxRam - usedRam - reservedRam, homeReserve);
                availableRam = Math.max(0, availableRam - homeBuffer);
            } else {
                availableRam = Math.max(0, availableRam);
            }

            return { hostname: server.hostname, availableRam };
        }).sort((a, b) => b.availableRam - a.availableRam);

        for (const server of serverAvailability) {
            if (threadsAssigned >= totalThreads) break;
            if (server.availableRam < scriptRam) continue;

            const possibleThreads = Math.floor(server.availableRam / scriptRam);
            const threadsToAssign = Math.min(possibleThreads, totalThreads - threadsAssigned);

            if (threadsToAssign > 0) {
                assignments.push({ hostname: server.hostname, threads: threadsToAssign });
                threadsAssigned += threadsToAssign;
                server.availableRam -= threadsToAssign * scriptRam;
            }
        }

        if (threadsAssigned < totalThreads) {
            this.log.warn(`Could only find hosts for ${threadsAssigned}/${totalThreads} threads (Script RAM: ${formatRam(this.ns, scriptRam)}).`);
        }

        return assignments;
    }

    // Reserve RAM based on assignments from findServersForThreads
    // Returns true if successful, false otherwise
    reserveRamBlocks(assignments, scriptRam) {
        if (!assignments || assignments.length === 0 || scriptRam <= 0) return true;

        for (const assign of assignments) {
            const hostname = assign.hostname;
            const threads = assign.threads;
            const ramToReserve = threads * scriptRam;

            const usedRam = this.ns.getServerUsedRam(hostname);
            const currentReservation = this.reservedRam.get(hostname) || 0;
            const serverInfo = this.servers.find(s => s.hostname === hostname);
            const maxRam = serverInfo ? serverInfo.maxRam : 0;
            
            let availableRam = maxRam - usedRam - currentReservation;
            if (hostname === 'home') {
                const homeReserve = getConfig(this.ns, 'HOME_RESERVE_RAM');
                const homeBuffer = Math.min(maxRam - usedRam - currentReservation, homeReserve);
                availableRam = Math.max(0, availableRam - homeBuffer);
            } else {
                availableRam = Math.max(0, availableRam);
            }

            if (availableRam < ramToReserve) {
                this.log.error(`Failed to reserve ${formatRam(this.ns, ramToReserve)} on ${hostname}. Available: ${formatRam(this.ns, availableRam)}. Reservation cancelled.`);
                return false;
            }
        }

        for (const assign of assignments) {
            const hostname = assign.hostname;
            const ramToReserve = assign.threads * scriptRam;
            this.reservedRam.set(hostname, (this.reservedRam.get(hostname) || 0) + ramToReserve);
            this.log.debug(`Reserved ${formatRam(this.ns, ramToReserve)} on ${hostname}. New reservation: ${formatRam(this.ns, this.reservedRam.get(hostname))}`);
        }
        return true;
    }

    // Release RAM previously reserved
    releaseRamBlocks(assignments, scriptRam) {
        if (!assignments || assignments.length === 0 || scriptRam <= 0) return;

        for (const assign of assignments) {
            const hostname = assign.hostname;
            const ramToRelease = assign.threads * scriptRam;
            const currentReservation = this.reservedRam.get(hostname) || 0;
            const newReservation = Math.max(0, currentReservation - ramToRelease);
            this.reservedRam.set(hostname, newReservation);
            this.log.debug(`Released ${formatRam(this.ns, ramToRelease)} on ${hostname}. New reservation: ${formatRam(this.ns, newReservation)}`);
        }
    }
}

/** 
 * Singleton instance of the ResourceManager.
 * We only want one script managing this state.
 * Use ns.exec to run this, and ports or files to communicate.
 * For now, we just provide the class, the scheduler will instantiate it.
 */
// Example of how it *could* be run as a singleton service:
/*
export async function main(ns) {
    ns.disableLog('ALL');
    const log = createLogger(ns, 'ResManSvc');
    log.info('Resource Manager Service Started');
    const manager = new ResourceManager(ns);
    const port = ns.getPortHandle(1); // Example port
    port.clear();

    while (true) {
        manager.updateServerList(); // Periodically update
        const stats = manager.getNetworkRamStats();
        // Write stats to port/file for other scripts
        port.tryWrite(JSON.stringify(stats)); 
        await ns.sleep(CONFIG.SCAN_INTERVAL || 60000);
    }
}
*/ 