"""
Stable per-user, per-machine key material for the encrypted fallbacks.

The shared core derives it from os.getlogin() / USERNAME / hostname. On
Linux os.getlogin() fails without a controlling terminal (autostart),
USERNAME is not set, and the hostname can change with the network, so the
key would differ between launches and the local DB could not be opened.
Here: the account name from the password database plus /etc/machine-id,
which is fixed for the life of the installation.
"""

import os
import pwd

MACHINE_ID_PATHS = ('/etc/machine-id', '/var/lib/dbus/machine-id')


def username():
    return pwd.getpwuid(os.getuid()).pw_name


def machine_id(candidate_paths=MACHINE_ID_PATHS):
    for path in candidate_paths:
        try:
            with open(path, encoding='ascii') as f:
                value = f.read().strip()
        except OSError:
            continue
        if value:
            return value
    return None


def key_material(machine_id_paths=MACHINE_ID_PATHS):
    """String the core hashes into its encryption key on Linux."""
    mid = machine_id(machine_id_paths) or f'uid-{os.getuid()}'
    return f'{username()}@{mid}'
