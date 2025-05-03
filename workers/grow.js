/** @param {NS} ns **/
export async function main(ns) {
    const target = ns.args[0] || "missing_target";
    const delay = Number.parseInt(ns.args[1]) || 0;
    const batchId = ns.args[2] || -1;

    if (delay > 0) {
        await ns.sleep(delay);
    }
    await ns.grow(target);
} 