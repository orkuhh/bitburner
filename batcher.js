/** @param {NS} ns **/
function findBestTarget(ns) {
    const myLevel = ns.getHackingLevel();
    const visited = new Set(["home"]);
    const queue = ["home"];
    const targets = [];
    while (queue.length) {
        const host = queue.shift();
        for (const neighbor of ns.scan(host)) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
                if (
                    ns.hasRootAccess(neighbor) &&
                    ns.getServerMaxMoney(neighbor) > 0 &&
                    ns.getServerRequiredHackingLevel(neighbor) <= myLevel
                ) {
                    targets.push(neighbor);
                }
            }
        }
    }
    if (targets.length === 0) {
        ns.print("WARN: No suitable targets found. Defaulting to n00dles.");
        return "n00dles";
    }
    targets.sort((a, b) => ns.getServerMaxMoney(b) - ns.getServerMaxMoney(a));
    return targets[0];
}

// Insert desync recovery: prep the target to min-security & max-money
async function prepTarget(ns, target, spacer) {
    ns.print(`--- Prepping ${target} ---`);
    const minSec = ns.getServerMinSecurityLevel(target);
    let sec = ns.getServerSecurityLevel(target);
    if (sec > minSec) {
        const threads = Math.ceil(ns.weakenAnalyze(sec - minSec));
        ns.print(`Weaken prep: ${threads} threads`);
        ns.exec("weaken_worker.js", "home", threads, target, 0);
        await ns.sleep(ns.getWeakenTime(target) + spacer);
    }
    const maxMoney = ns.getServerMaxMoney(target);
    let money = ns.getServerMoneyAvailable(target);
    if (money < maxMoney) {
        const mult = maxMoney / money;
        const threads = Math.ceil(ns.growthAnalyze(target, mult));
        ns.print(`Grow prep: ${threads} threads`);
        ns.exec("grow_worker.js", "home", threads, target, 0);
        await ns.sleep(ns.getGrowTime(target) + spacer);
    }
    sec = ns.getServerSecurityLevel(target);
    money = ns.getServerMoneyAvailable(target);
    ns.print(`--- Prepping complete: sec=${sec.toFixed(2)}, money=$${ns.formatNumber(money)} ---`);
}

/** @param {NS} ns **/
export async function main(ns) {
    // Configuration: spacer between finishes, hack percentage
    const spacer = Number.parseInt(ns.args[0]) || 200;
    const hackPct = Number.parseFloat(ns.args[1]) || 0.1;

    ns.tail();
    ns.disableLog("sleep");
    ns.disableLog("getHackTime");
    ns.disableLog("getGrowTime");
    ns.disableLog("getWeakenTime");
    ns.disableLog("exec");

    while (true) {
        // 1) Select best target
        const target = findBestTarget(ns);
        ns.print(`=== Selected target: ${target} ===`);

        // Desync recovery: prep target before seeding
        await prepTarget(ns, target, spacer);

        // 2) Compute task durations
        const hackTime = ns.getHackTime(target);
        const growTime = ns.getGrowTime(target);
        const weakenTime = ns.getWeakenTime(target);

        // 3) Scheduling parameters
        const maxTime = Math.max(hackTime, growTime, weakenTime);
        const batchPeriod = maxTime + 4 * spacer;
        const interval = 4 * spacer;

        // 4) Thread calculation
        const maxMoney = ns.getServerMaxMoney(target);
        const hackAmount = maxMoney * hackPct;
        const hackThreads = Math.max(1, Math.floor(ns.hackAnalyzeThreads(target, hackAmount)));
        const secGainHack = ns.hackAnalyzeSecurity(hackThreads);
        const weaken1Threads = Math.max(1, Math.ceil(ns.weakenAnalyze(secGainHack)));
        const growThreads = Math.max(
            1,
            Math.ceil(ns.growthAnalyze(target, maxMoney / (maxMoney - hackAmount)))
        );
        const secGainGrow = ns.growthAnalyzeSecurity(growThreads);
        const weaken2Threads = Math.max(1, Math.ceil(ns.weakenAnalyze(secGainGrow)));

        ns.print(
            `Threads -> Hack: ${hackThreads}, W1: ${weaken1Threads}, Grow: ${growThreads}, W2: ${weaken2Threads}`
        );

        // 5) Compute delays relative to batch start
        const hackDelay = batchPeriod - hackTime - 3 * spacer;
        const weaken1Delay = batchPeriod - weakenTime - 2 * spacer;
        const growDelay = batchPeriod - growTime - spacer;
        const weaken2Delay = batchPeriod - weakenTime;

        // 6) Determine max overlapping depth
        const ramHack = ns.getScriptRam("hack_worker.js", "home");
        const ramGrow = ns.getScriptRam("grow_worker.js", "home");
        const ramWeak = ns.getScriptRam("weaken_worker.js", "home");
        const ramPerBatch =
            hackThreads * ramHack + growThreads * ramGrow + (weaken1Threads + weaken2Threads) * ramWeak;
        const freeRam = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
        const maxDepthRam = Math.floor(freeRam / ramPerBatch);
        const depthTime = Math.max(1, Math.floor(weakenTime / interval));
        const depth = Math.max(1, Math.min(maxDepthRam, depthTime));

        ns.print(`Config -> period: ${batchPeriod}ms, interval: ${interval}ms, depth: ${depth}`);

        // 7) Batch launcher helper
        function launchBatch() {
            ns.exec("hack_worker.js", "home", hackThreads, target, hackDelay);
            ns.exec(
                "weaken_worker.js",
                "home",
                weaken1Threads,
                target,
                weaken1Delay
            );
            ns.exec("grow_worker.js", "home", growThreads, target, growDelay);
            ns.exec(
                "weaken_worker.js",
                "home",
                weaken2Threads,
                target,
                weaken2Delay
            );
        }

        // 8) Seed initial batches
        ns.print(`Seeding ${depth} batches on ${target}...`);
        for (let i = 0; i < depth; i++) {
            launchBatch();
            if (i < depth - 1) await ns.sleep(interval);
        }

        // 9) Continuous scheduling; switch and recover when drained or desynced
        while (true) {
            await ns.sleep(interval);
            const sec = ns.getServerSecurityLevel(target);
            const minSec = ns.getServerMinSecurityLevel(target);
            const money = ns.getServerMoneyAvailable(target);
            // If security drift or money drained, recover
            if (sec > minSec + 1 || money < hackAmount) {
                ns.print(`Desync detected (sec=${sec.toFixed(2)}, money=$${ns.formatNumber(money)}); recovering...`);
                await prepTarget(ns, target, spacer);
                break;
            }
            launchBatch();
        }
    }
} 