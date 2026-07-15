/**
 * hypothesisSync.js
 * Core logic: fetch Hypothesis annotations, match to Zotero items,
 * and write highlights + notes into Zotero item notes.
 *
 * SETUP:
 *   1. Replace HYPOTHESIS_API_TOKEN with your token from
 *      https://hypothes.is/profile/developer
 *   2. Replace HYPOTHESIS_USERNAME with your Hypothesis username.
 *   3. Optionally adjust SYNC_INTERVAL_MINUTES.
 */

var HypothesisSync = {

  // ── Configuration ──────────────────────────────────────────────
  API_TOKEN: "YOUR_HYPOTHESIS_API_TOKEN_HERE",
  USERNAME:  "YOUR_HYPOTHESIS_USERNAME_HERE",
  SYNC_INTERVAL_MINUTES: 30,          // set to 0 to disable auto-sync
  NOTE_TAG: "hypothesis-sync",        // tag added to every synced note
  BASE_URL: "https://api.hypothes.is/api",
  // ───────────────────────────────────────────────────────────────

  _menuItem: null,
  _timer: null,

  // ── Lifecycle ──────────────────────────────────────────────────

  init() {
    // Add "Sync Hypothesis Annotations" to the Zotero Tools menu
    this._addMenuItem();

    // Optional: auto-sync on a timer
    if (this.SYNC_INTERVAL_MINUTES > 0) {
      this._timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      this._timer.initWithCallback(
        { notify: () => this.sync() },
        this.SYNC_INTERVAL_MINUTES * 60 * 1000,
        Ci.nsITimer.TYPE_REPEATING_SLACK
      );
    }
  },

  uninit() {
    if (this._timer) { this._timer.cancel(); this._timer = null; }
    this._removeMenuItem();
  },

  // ── Menu ───────────────────────────────────────────────────────

  _addMenuItem() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win) return;

    const doc   = win.document;
    const menu  = doc.getElementById("menu_ToolsPopup");
    if (!menu) return;

    const item  = doc.createElementNS(
      "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      "menuitem"
    );
    item.setAttribute("id",    "hypothesisSyncMenuItem");
    item.setAttribute("label", "Sync Hypothesis Annotations");
    item.addEventListener("command", () => this.sync());

    menu.appendChild(item);
    this._menuItem = item;
  },

  _removeMenuItem() {
    if (this._menuItem) {
      this._menuItem.remove();
      this._menuItem = null;
    }
  },

  // ── Main sync entry point ──────────────────────────────────────

  async sync() {
    if (!this.API_TOKEN || this.API_TOKEN === "YOUR_HYPOTHESIS_API_TOKEN_HERE") {
      this._alert("Hypothesis Sync: Please set your API token in hypothesisSync.js");
      return;
    }

    try {
      this._log("Starting Hypothesis sync…");
      const annotations = await this._fetchAllAnnotations();
      this._log(`Fetched ${annotations.length} annotation(s).`);

      const grouped = this._groupByUrl(annotations);
      let synced = 0;

      for (const [url, anns] of Object.entries(grouped)) {
        const item = await this._findZoteroItemByUrl(url);
        if (item) {
          await this._upsertNote(item, url, anns);
          synced++;
        } else {
          this._log(`No Zotero item found for: ${url}`);
        }
      }

      this._alert(`Hypothesis Sync complete.\n${synced} item(s) updated.`);
    } catch (e) {
      this._log("Sync error: " + e.message);
      this._alert("Hypothesis Sync error:\n" + e.message);
    }
  },

  // ── Hypothesis API ─────────────────────────────────────────────

  async _fetchAllAnnotations() {
    const limit = 200;
    let offset  = 0;
    let all     = [];

    while (true) {
      const url = `${this.BASE_URL}/search?user=acct:${encodeURIComponent(this.USERNAME)}@hypothes.is` +
                  `&limit=${limit}&offset=${offset}&order=asc`;

      const resp = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${this.API_TOKEN}`,
          "Accept":        "application/vnd.hypothesis.v1+json"
        }
      });

      if (!resp.ok) throw new Error(`Hypothesis API error ${resp.status}: ${await resp.text()}`);

      const data = await resp.json();
      const rows = data.rows || [];
      all = all.concat(rows);

      if (rows.length < limit) break;   // no more pages
      offset += limit;
    }

    return all;
  },

  // ── Grouping ───────────────────────────────────────────────────

  _groupByUrl(annotations) {
    const map = {};
    for (const ann of annotations) {
      const uri = ann.uri;
      if (!uri) continue;
      if (!map[uri]) map[uri] = [];
      map[uri].push(ann);
    }
    return map;
  },

  // ── Zotero item lookup ─────────────────────────────────────────

  async _findZoteroItemByUrl(url) {
    // Search all libraries the user has access to
    const libraries = [
      Zotero.Libraries.userLibrary,
      ...Zotero.Libraries.getAll().filter(l => l.libraryType === "group")
    ];

    for (const lib of libraries) {
      const s = new Zotero.Search();
      s.libraryID = lib.libraryID;
      s.addCondition("url", "contains", url);
      const ids = await s.search();
      if (ids.length > 0) {
        return await Zotero.Items.getAsync(ids[0]);
      }
    }
    return null;
  },

  // ── Note creation / update ─────────────────────────────────────

  async _upsertNote(parentItem, url, annotations) {
    // Look for an existing synced note on this item
    const childIDs  = parentItem.getNotes();
    let noteItem    = null;

    for (const id of childIDs) {
      const child = await Zotero.Items.getAsync(id);
      if (child.hasTag(this.NOTE_TAG)) {
        noteItem = child;
        break;
      }
    }

    const html = this._buildNoteHTML(url, annotations);

    if (noteItem) {
      noteItem.setNote(html);
      await noteItem.saveTx();
      this._log(`Updated note for: ${url}`);
    } else {
      noteItem = new Zotero.Item("note");
      noteItem.libraryID = parentItem.libraryID;
      noteItem.parentID  = parentItem.id;
      noteItem.setNote(html);
      noteItem.addTag(this.NOTE_TAG);
      await noteItem.saveTx();
      this._log(`Created note for: ${url}`);
    }
  },

  // ── HTML note builder ──────────────────────────────────────────

  _buildNoteHTML(url, annotations) {
    const escape = s => (s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const syncDate = new Date().toLocaleString();

    let html = `<h2>Hypothesis Annotations</h2>\n`;
    html    += `<p><strong>Source:</strong> <a href="${escape(url)}">${escape(url)}</a><br>`;
    html    += `<strong>Synced:</strong> ${escape(syncDate)}</p>\n<hr>\n`;

    // Sort by document position (text quote selector offset when available)
    const sorted = [...annotations].sort((a, b) => {
      const posA = this._getPosition(a);
      const posB = this._getPosition(b);
      return posA - posB;
    });

    for (const ann of sorted) {
      const quote   = this._getQuote(ann);
      const comment = (ann.text || "").trim();
      const tags    = (ann.tags || []).join(", ");
      const annUrl  = `https://hypothes.is/a/${ann.id}`;
      const created = ann.created ? new Date(ann.created).toLocaleDateString() : "";

      html += `<div style="margin-bottom:1em; padding:0.5em; border-left:3px solid #f0c040;">\n`;

      if (quote) {
        html += `  <blockquote style="color:#555; font-style:italic; margin:0 0 0.4em 0;">"${escape(quote)}"</blockquote>\n`;
      }

      if (comment) {
        html += `  <p style="margin:0.3em 0;">${escape(comment)}</p>\n`;
      }

      let meta = [];
      if (tags)    meta.push(`Tags: <em>${escape(tags)}</em>`);
      if (created) meta.push(`Date: ${escape(created)}`);
      meta.push(`<a href="${escape(annUrl)}">View on Hypothesis</a>`);

      html += `  <p style="font-size:0.85em; color:#888; margin:0.3em 0;">${meta.join(" · ")}</p>\n`;
      html += `</div>\n`;
    }

    return html;
  },

  _getQuote(ann) {
    for (const target of (ann.target || [])) {
      for (const sel of (target.selector || [])) {
        if (sel.type === "TextQuoteSelector" && sel.exact) {
          return sel.exact;
        }
      }
    }
    return null;
  },

  _getPosition(ann) {
    for (const target of (ann.target || [])) {
      for (const sel of (target.selector || [])) {
        if (sel.type === "TextPositionSelector" && sel.start != null) {
          return sel.start;
        }
      }
    }
    return 0;
  },

  // ── Utilities ──────────────────────────────────────────────────

  _log(msg) {
    Zotero.log("[HypothesisSync] " + msg);
  },

  _alert(msg) {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (win) {
      win.alert(msg);
    } else {
      this._log("ALERT: " + msg);
    }
  }
};
