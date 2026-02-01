/**
 * CLI script to run genre tagging directly (bypasses auth)
 * Usage: npx ts-node src/scripts/tagGenres.ts [--force]
 */

import { startGenreTagging, getGenreTaggingStatus } from "../services/genreTagger";

const force = process.argv.includes("--force");

console.log(`Starting genre tagging (force=${force})...`);

const status = startGenreTagging({ force });

if (!status.running) {
    console.log("Genre tagging is already running or failed to start");
    console.log(status);
    process.exit(1);
}

// Poll for completion
const pollInterval = setInterval(() => {
    const current = getGenreTaggingStatus();
    
    const pct = current.total > 0 
        ? Math.round((current.processed / current.total) * 100) 
        : 0;
    
    console.log(
        `Progress: ${current.processed}/${current.total} (${pct}%) - ` +
        `Success: ${current.success}, Failed: ${current.failed}, Skipped: ${current.skipped}`
    );
    
    if (current.currentAlbum) {
        console.log(`  Current: ${current.currentAlbum}`);
    }
    
    if (!current.running) {
        clearInterval(pollInterval);
        console.log("\nGenre tagging complete!");
        console.log(`  Success: ${current.success}`);
        console.log(`  Failed: ${current.failed}`);
        console.log(`  Skipped: ${current.skipped}`);
        if (current.lastError) {
            console.log(`  Last error: ${current.lastError}`);
        }
        process.exit(0);
    }
}, 5000);
