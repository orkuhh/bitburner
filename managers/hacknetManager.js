/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog('ALL');
  ns.clearLog();

  ns.print('Starting Hacknet Manager...');

  // Configuration (can be moved to config.js later)
  const purchaseThresholdMultiplier = 10; // Only buy if we have 10x the cost
  const upgradeThresholdMultiplier = 5;  // Only upgrade if we have 5x the cost
  const maxNodes = ns.hacknet.maxNumNodes();
  const maxLevel = 200;
  const maxRam = 64;
  const maxCores = 16;

  while (true) {
    await ns.sleep(1000); // Check every second initially, can adjust later

    const currentMoney = ns.getServerMoneyAvailable('home');
    const numNodes = ns.hacknet.numNodes();

    // --- Purchase New Nodes ---
    const purchaseCost = ns.hacknet.getPurchaseNodeCost();
    if (numNodes < maxNodes && currentMoney > purchaseCost * purchaseThresholdMultiplier) {
      const newNodeIndex = ns.hacknet.purchaseNode();
      if (newNodeIndex !== -1) {
        ns.print(`SUCCESS: Purchased new Hacknet node ${newNodeIndex}. Total: ${numNodes + 1}`);
        continue; // Re-evaluate after purchase
      }
      ns.print('WARN: Failed to purchase node even though conditions seemed met.');
    }

    // --- Upgrade Existing Nodes ---
    let upgradedSomething = false;
    for (let i = 0; i < numNodes; i++) {
      const nodeStats = ns.hacknet.getNodeStats(i);

      // Upgrade Level
      const levelCost = ns.hacknet.getLevelUpgradeCost(i, 1);
      if (nodeStats.level < maxLevel && currentMoney > levelCost * upgradeThresholdMultiplier) {
        if (ns.hacknet.upgradeLevel(i, 1)) {
          ns.print(`SUCCESS: Upgraded level for node ${i} to ${nodeStats.level + 1}.`);
          upgradedSomething = true;
          break; // Re-evaluate after upgrade
        }
      }

      // Upgrade RAM
      const ramCost = ns.hacknet.getRamUpgradeCost(i, 1);
      if (nodeStats.ram < maxRam && currentMoney > ramCost * upgradeThresholdMultiplier) {
        if (ns.hacknet.upgradeRam(i, 1)) {
          ns.print(`SUCCESS: Upgraded RAM for node ${i} to ${nodeStats.ram * 2}.`);
          upgradedSomething = true;
          break; // Re-evaluate after upgrade
        }
      }

      // Upgrade Cores
      const coreCost = ns.hacknet.getCoreUpgradeCost(i, 1);
      if (nodeStats.cores < maxCores && currentMoney > coreCost * upgradeThresholdMultiplier) {
        if (ns.hacknet.upgradeCore(i, 1)) {
          ns.print(`SUCCESS: Upgraded cores for node ${i} to ${nodeStats.cores + 1}.`);
          upgradedSomething = true;
          break; // Re-evaluate after upgrade
        }
      }
    }

    if (upgradedSomething) {
      continue; // Loop restarts to check priorities again
    }

    // If nothing else to do, wait longer before next check
    await ns.sleep(10000);
  }
}

// TODO:
// - Add logic for spending hashes (sell for money, specific upgrades?)
// - More sophisticated upgrade logic (prioritize best ROI?)
// - Integrate with scheduler/central manager
// - Move configuration to config.js
// - Add logging options/verbosity levels 