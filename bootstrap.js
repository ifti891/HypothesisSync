/**
 * Hypothesis Sync for Zotero 7
 * bootstrap.js — registers the plugin, adds a Tools menu entry,
 * and wires up the sync command.
 */

var HypothesisSync;

function install() {}
function uninstall() {}

function startup({ id, version, rootURI }) {
  Services.scriptloader.loadSubScript(rootURI + "hypothesisSync.js");
  HypothesisSync.init();
}

function shutdown() {
  if (HypothesisSync) HypothesisSync.uninit();
}

