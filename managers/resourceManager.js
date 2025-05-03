/**
 * managers/resourceManager.js
 * Manages knowledge of network servers and their RAM resources.
 */

import { CONFIG } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { scanServers, formatRam } from '../lib/utilities.js';

export class ResourceManager {
    constructor(ns) {
        this.ns = ns;
        this.log = createLogger(ns, 'ResMan');
        this.servers = [];
        this.updateServerList();
    }

    // Scan network and update list of usable servers (rooted, has RAM)
    updateServerList() {
        this.log.info('Updating server list...');
        const allServers = scanServers(this.ns);
        this.servers = allServers
            .map(hostname => {
                if (!this.ns.hasRootAccess(hostname)) return null;
                const maxRam = this.ns.getServerMaxRam(hostname);
                if (maxRam <= 0) return null;
                return {
                    hostname,
                    maxRam,
                    usedRam: this.ns.getServerUsedRam(hostname),
                    hasRoot: true,
                };
            })
            .filter(s => s !== null); // Remove non-rooted or RAM-less servers
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
        const homeReserve = CONFIG.HOME_RESERVE_RAM || 0;

        for (const server of this.servers) {
            const maxRam = server.maxRam;
            const usedRam = this.ns.getServerUsedRam(server.hostname); // Re-check used RAM
            server.usedRam = usedRam; // Update cached value
            totalMaxRam += maxRam;
            totalUsedRam += usedRam;
        }

        // Adjust for home reservation
        const homeServer = this.servers.find(s => s.hostname === 'home');
        let totalFreeRam = totalMaxRam - totalUsedRam;
        if (homeServer) {
            const homeAvailable = homeServer.maxRam - homeServer.usedRam;
            const homeReserved = Math.min(homeAvailable, homeReserve);
            totalFreeRam = Math.max(0, totalFreeRam - homeReserved);
        }
        
        return { totalMaxRam, totalUsedRam, totalFreeRam };
    }

    logTotalRam() {
        const { totalMaxRam, totalFreeRam } = this.getNetworkRamStats();
        this.log.info(`Network RAM: ${formatRam(this.ns, totalFreeRam)} free / ${formatRam(this.ns, totalMaxRam)} total`);
    }

    // Find the best server(s) to run a script with given RAM requirement
    findBestServer(requiredRam) {
        const homeReserve = CONFIG.HOME_RESERVE_RAM || 0;
        let bestServer = null;
        let maxAffordableThreads = 0;

        for (const server of this.servers) {
            let availableRam = server.maxRam - this.ns.getServerUsedRam(server.hostname);
            if (server.hostname === 'home') {
                availableRam = Math.max(0, availableRam - homeReserve);
            }

            if (availableRam >= requiredRam) {
                 const threads = Math.floor(availableRam / requiredRam);
                 // Prioritize servers that can run more threads
                 if (threads > maxAffordableThreads) {
                     maxAffordableThreads = threads;
                     bestServer = server.hostname;
                 }
            }
        }

        if (!bestServer) {
            this.log.warn(`No server found with enough free RAM for script needing ${formatRam(this.ns, requiredRam)}`);
        }
        return bestServer;
    }

    // Find multiple servers to distribute threads across
    // Returns an array of { hostname, threads }
    findServersForThreads(scriptRam, totalThreads) {
        if (scriptRam <= 0 || totalThreads <= 0) return [];

        const homeReserve = CONFIG.HOME_RESERVE_RAM || 0;
        const assignments = [];
        let threadsAssigned = 0;

        // Sort servers by available RAM descending (more likely to fit large chunks)
        const sortedServers = [...this.servers].sort((a, b) => {
            const ramA = a.maxRam - this.ns.getServerUsedRam(a.hostname) - (a.hostname === 'home' ? homeReserve : 0);
            const ramB = b.maxRam - this.ns.getServerUsedRam(b.hostname) - (b.hostname === 'home' ? homeReserve : 0);
            return Math.max(0, ramB) - Math.max(0, ramA);
        });

        for (const server of sortedServers) {
            if (threadsAssigned >= totalThreads) break;

            let availableRam = server.maxRam - this.ns.getServerUsedRam(server.hostname);
             if (server.hostname === 'home') {
                availableRam = Math.max(0, availableRam - homeReserve);
            }
            
            const possibleThreads = Math.floor(availableRam / scriptRam);
            if (possibleThreads <= 0) continue;

            const threadsToAssign = Math.min(possibleThreads, totalThreads - threadsAssigned);
            if (threadsToAssign > 0) {
                assignments.push({ hostname: server.hostname, threads: threadsToAssign });
                threadsAssigned += threadsToAssign;
            }
        }

        if (threadsAssigned < totalThreads) {
            this.log.warn(`Could only assign ${threadsAssigned}/${totalThreads} threads for script needing ${formatRam(this.ns, scriptRam)} each.`);
        }

        return assignments;
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