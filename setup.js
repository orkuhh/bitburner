/**
 * setup.js
 * Downloads all required scripts for the automation framework from a GitHub repository.
 *
 * Usage:
 * 1. wget <URL_TO_THIS_SCRIPT>/setup.js setup.js
 * 2. run setup.js
 */

/** @param {NS} ns **/
export async function main(ns) {
    // --- START CONFIGURATION ---

    // URL to the raw content of your repository
    const repoBaseUrl = "https://raw.githubusercontent.com/orkuhh/bitburner/main/";

    // If your branch is not 'main', change it here (though it's already set above)
    // const branch = "main"; // Included in repoBaseUrl

    // --- END CONFIGURATION ---

    // Ensure the base URL ends with a slash
    const baseUrl = repoBaseUrl.endsWith('/') ? repoBaseUrl : `${repoBaseUrl}/`;

    const filesToDownload = [
        // Core files
        { repoPath: "config.js", gamePath: "config.js" },
        { repoPath: "scheduler.js", gamePath: "scheduler.js" },
        { repoPath: "batcher.js", gamePath: "batcher.js" }, // Added missing batcher

        // Libraries
        { repoPath: "lib/logger.js", gamePath: "lib/logger.js" },
        { repoPath: "lib/utilities.js", gamePath: "lib/utilities.js" },

        // Managers
        { repoPath: "managers/resourceManager.js", gamePath: "managers/resourceManager.js" },
        { repoPath: "managers/hackManager.js", gamePath: "managers/hackManager.js" },
        { repoPath: "managers/serverManager.js", gamePath: "managers/serverManager.js" },
        { repoPath: "managers/factionManager.js", gamePath: "managers/factionManager.js" },
        { repoPath: "managers/gangManager.js", gamePath: "managers/gangManager.js" },
        { repoPath: "managers/corpManager.js", gamePath: "managers/corpManager.js" },

        // Workers
        { repoPath: "workers/hack.js", gamePath: "workers/hack.js" },
        { repoPath: "workers/grow.js", gamePath: "workers/grow.js" },
        { repoPath: "workers/weaken.js", gamePath: "workers/weaken.js" },
        { repoPath: "workers/prepWorker.js", gamePath: "workers/prepWorker.js" },

        // Add any other files/directories you created here
        // Example: { repoPath: "data/augmentations.js", gamePath: "data/augmentations.js" },
    ];

    ns.tprint(`--- Starting Framework Download from ${baseUrl} ---`);
    let successCount = 0;
    let failCount = 0;

    for (const file of filesToDownload) {
        const downloadUrl = baseUrl + file.repoPath;
        const targetPath = file.gamePath;
        ns.tprint(`Downloading ${file.repoPath} to ${targetPath}...`);

        // Overwrite existing files
        if (await ns.wget(downloadUrl, targetPath, "home")) {
            ns.tprint("  -> SUCCESS");
            successCount++;
        } else {
            ns.tprint(`  -> FAILED! Check URL: ${downloadUrl}`);
            failCount++;
            // Optional: Stop on first failure?
            // ns.tprint("ERROR: Download failed. Aborting setup.");
            // return;
        }
        // Small delay to avoid hitting rate limits (if any) and make logs readable
        await ns.sleep(100);
    }

    ns.tprint("--- Download Complete ---");
    ns.tprint(`Successfully downloaded: ${successCount}`);
    ns.tprint(`Failed downloads:      ${failCount}`);

    if (failCount === 0) {
        ns.tprint("Setup successful! You can now run the main orchestrator:");
        ns.tprint("run scheduler.js");
    } else {
        ns.tprint("ERROR: Some files failed to download. Please check the logs and your repository URL/structure.");
    }
}