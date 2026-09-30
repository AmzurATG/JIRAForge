"""Shared test doubles for D-Bus based services."""


class FakeMessage:
    def __init__(self, body=(), member=None, interface=None, path=None, sender=':1.99'):
        self.body = tuple(body)
        self.member = member
        self.interface = interface
        self.path = path
        self.sender = sender


class FakeHandle:
    def __init__(self, bus, entry):
        self.bus = bus
        self.entry = entry

    def remove(self):
        if self.entry in self.bus.subscriptions:
            self.bus.subscriptions.remove(self.entry)


class FakeBus:
    """Answers calls/properties from dicts; records subscriptions and exports.

    answers:    {(bus_name, interface, method): body tuple | Exception | callable(args)}
    properties: {(bus_name, interface, name): value | Exception}
    """

    def __init__(self, answers=None, properties=None, owners=()):
        self.answers = dict(answers or {})
        self.properties = dict(properties or {})
        self.owners = set(owners)
        self.subscriptions = []
        self.exports = {}
        self.calls = []
        self.signals = []
        self.unique_name = ':1.42'

    def call(self, bus_name, path, interface, method, signature='', args=(), timeout=None):
        self.calls.append((bus_name, path, interface, method, tuple(args)))
        answer = self.answers.get((bus_name, interface, method), LookupError(f'no answer {method}'))
        if callable(answer) and not isinstance(answer, Exception):
            answer = answer(tuple(args))
        if isinstance(answer, Exception):
            raise answer
        return answer

    def get_property(self, bus_name, path, interface, name, timeout=None):
        value = self.properties.get((bus_name, interface, name), LookupError(f'no property {name}'))
        if isinstance(value, Exception):
            raise value
        return value

    def name_has_owner(self, name):
        return name in self.owners

    def subscribe(self, callback, *, interface=None, member=None, path=None, sender=None):
        entry = (interface, member, path, callback)
        self.subscriptions.append(entry)
        return FakeHandle(self, entry)

    def fire(self, interface, member, body=(), path=None):
        """Deliver a signal to matching subscribers."""
        delivered = 0
        for sub_iface, sub_member, sub_path, callback in list(self.subscriptions):
            if sub_iface not in (None, interface) or sub_member not in (None, member):
                continue
            if sub_path is not None and path is not None and sub_path != path:
                continue
            callback(FakeMessage(body, member=member, interface=interface, path=path))
            delivered += 1
        return delivered

    def export(self, path, handler):
        self.exports[path] = handler

        class _H:
            def remove(_self):
                self.exports.pop(path, None)
        return _H()

    def emit_signal(self, path, interface, member, signature='', body=()):
        self.signals.append((path, interface, member, tuple(body)))

    def request_name(self, name):
        self.owners.add(name)
        return True


def run_sync(target, then, budget_s):
    target()
    if then is not None:
        then()
