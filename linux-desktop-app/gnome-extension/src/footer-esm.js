
export default class TimeTrackerExtension extends Extension {
    enable() {
        this._service = new TimeTrackerService(this.path);
        this._service.enable();
    }

    disable() {
        if (this._service)
            this._service.disable();
        this._service = null;
    }
}
