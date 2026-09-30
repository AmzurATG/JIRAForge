
class TimeTrackerExtension {
    enable() {
        this._service = new TimeTrackerService(ExtensionUtils.getCurrentExtension().path);
        this._service.enable();
    }

    disable() {
        if (this._service)
            this._service.disable();
        this._service = null;
    }
}

function init() {
    return new TimeTrackerExtension();
}
