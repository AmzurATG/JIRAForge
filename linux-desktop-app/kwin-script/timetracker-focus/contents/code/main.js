// TimeTracker focus reporter for KWin (Plasma 5 and Plasma 6).
//
// Loaded at runtime by the TimeTracker app through org.kde.kwin.Scripting.
// On every focus or title change it calls the app's D-Bus service
// com.amzur.TimeTracker (/com/amzur/TimeTracker/KWin, FocusChanged). The app
// only accepts calls whose sender is KWin itself.

var SERVICE = "com.amzur.TimeTracker";
var PATH = "/com/amzur/TimeTracker/KWin";
var IFACE = "com.amzur.TimeTracker.KWin1";
var plasma6 = typeof workspace.windowActivated !== "undefined";
var watched = null;

function outputOf(w) {
    if (plasma6 && w.output) {
        var g = w.output.geometry;
        return {name: w.output.name || "", x: g.x, y: g.y, width: g.width, height: g.height,
                scale: w.output.devicePixelRatio || 1.0};
    }
    // Plasma 5: screen index + its area
    var area = workspace.clientArea(KWin.ScreenArea, w.screen, workspace.currentDesktop);
    return {name: "screen-" + w.screen, x: area.x, y: area.y, width: area.width, height: area.height, scale: 1.0};
}

function report(w) {
    if (!w || w.specialWindow || w.desktopWindow || w.dock) {
        callDBus(SERVICE, PATH, IFACE, "FocusChanged", "", "", "", 0, "", "", 0, 0, 0, 0, 1.0, false);
        return;
    }
    var o = outputOf(w);
    var id = String(w.internalId !== undefined ? w.internalId : w.windowId);
    callDBus(SERVICE, PATH, IFACE, "FocusChanged",
             w.caption || "", String(w.resourceClass || ""), String(w.desktopFileName || ""),
             w.pid || 0, id, o.name, o.x, o.y, o.width, o.height, o.scale, !!w.minimized);
}

function watch(w) {
    if (watched) {
        try { watched.captionChanged.disconnect(onCaption); } catch (e) {}
    }
    watched = w;
    if (w) {
        w.captionChanged.connect(onCaption);
    }
    report(w);
}

function onCaption() {
    report(watched);
}

if (plasma6) {
    workspace.windowActivated.connect(watch);
    watch(workspace.activeWindow);
} else {
    workspace.clientActivated.connect(watch);
    watch(workspace.activeClient);
}
