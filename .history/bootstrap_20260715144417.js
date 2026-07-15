/**
 * Hypothesis Sync for Zotero 7/9
 * bootstrap.js — Main plugin entry point
 */

var HypothesisSync = null;

async function startup(data, reason) {
  // Import the main plugin code
  const { HypothesisSync: HS } = await import(data.rootURI + "hypothesisSync.js");
  HypothesisSync = HS;
  
  // Initialize the plugin
  HypothesisSync.init();
  
  // Handle existing windows
  const windows = Zotero.getMainWindows();
  for (const win of windows) {
    HypothesisSync.onMainWindowLoad({ window: win });
  }
}

function shutdown(data, reason) {
  if (HypothesisSync) {
    HypothesisSync.uninit();
  }
}

function install(data, reason) {}
function uninstall(data, reason) {}