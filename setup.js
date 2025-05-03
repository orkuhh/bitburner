    // --- START CONFIGURATION ---
    
    // !!! IMPORTANT: Replace this with the base URL to the raw content of your repository !!!
    // Example: "https://raw.githubusercontent.com/YourUsername/YourRepoName/main/"
    const repoBaseUrl = "https://raw.githubusercontent.com/orkuhh/bitburner/main/"; 

    // If your branch is not 'main', change it here
    const branch = "main"; 

    // --- END CONFIGURATION ---

    // Removed the placeholder check as the URL is now set directly

    // Ensure the base URL ends with a slash
    const baseUrl = repoBaseUrl.endsWith('/') ? repoBaseUrl : `${repoBaseUrl}/`;

    const filesToDownload = [
        // Core files
    ];