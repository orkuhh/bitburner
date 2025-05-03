/**
 * lib/utilities.js
 * Common utility functions.
 */

/** @param {NS} ns **/
export function scanServers(ns) {
    const visited = new Set(["home"]);
    const queue = ["home"];
    const allServers = ["home"];
    while (queue.length > 0) {
        const host = queue.shift();
        const neighbors = ns.scan(host);
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
                allServers.push(neighbor);
            }
        }
    }
    return allServers;
}

/** Format large numbers */
export function formatNumber(ns, num) {
    return ns.formatNumber(num);
}

/** Format RAM */
export function formatRam(ns, ram) {
    return ns.formatRam(ram);
}

/** Calculate script RAM cost */
export function getScriptRam(ns, script, host = "home") {
    return ns.getScriptRam(script, host);
}

// Add more utilities as needed... 