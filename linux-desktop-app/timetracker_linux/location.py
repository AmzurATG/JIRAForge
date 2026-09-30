"""
Office detection inputs on Linux: Wi-Fi SSID and the real LAN address.

`socket.gethostbyname(socket.gethostname())` returns 127.0.1.1 on
Debian/Ubuntu (hostname mapped in /etc/hosts), so subnet matching never
worked there; the default-route interface address is used instead.
"""

import ipaddress
import socket
import subprocess

from .childenv import clean_env

NM = 'org.freedesktop.NetworkManager'
NM_PATH = '/org/freedesktop/NetworkManager'
NMCLI_TIMEOUT_S = 3


def ssid_from_networkmanager(system_bus):
    active = system_bus.get_property(NM, NM_PATH, NM, 'ActiveConnections')
    for connection in active:
        conn_type = system_bus.get_property(NM, connection, f'{NM}.Connection.Active', 'Type')
        if conn_type != '802-11-wireless':
            continue
        for device in system_bus.get_property(NM, connection, f'{NM}.Connection.Active', 'Devices'):
            ap = system_bus.get_property(NM, device, f'{NM}.Device.Wireless', 'ActiveAccessPoint')
            if ap and ap != '/':
                ssid = system_bus.get_property(NM, ap, f'{NM}.AccessPoint', 'Ssid')
                return bytes(ssid).decode('utf-8', 'replace') or None
    return None


def parse_nmcli_ssid(output):
    """`nmcli -t -f ACTIVE,SSID dev wifi` → SSID of the active network (colons are escaped)."""
    for line in output.splitlines():
        active, sep, ssid = line.partition(':')
        if sep and active == 'yes' and ssid:
            return ssid.replace('\\:', ':').replace('\\\\', '\\')
    return None


def ssid_from_nmcli(run=subprocess.run):
    done = run(['nmcli', '-t', '-f', 'ACTIVE,SSID', 'dev', 'wifi'], capture_output=True, text=True,
               timeout=NMCLI_TIMEOUT_S, env=clean_env(), check=False)
    return parse_nmcli_ssid(done.stdout or '') if done.returncode == 0 else None


def get_wifi_ssid(system_bus=None, run=subprocess.run):
    if system_bus is not None:
        try:
            return ssid_from_networkmanager(system_bus)
        except Exception:
            pass
    try:
        return ssid_from_nmcli(run)
    except Exception:
        return None


def default_route_interface(route_table_text):
    """Interface of the IPv4 default route from /proc/net/route text."""
    for line in route_table_text.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 4 and fields[1] == '00000000' and int(fields[3], 16) & 0x2:  # RTF_GATEWAY
            return fields[0]
    return None


def _usable(address):
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    return not (ip.is_loopback or ip.is_link_local or ip.is_unspecified)


def get_local_ip(route_path='/proc/net/route', psutil_module=None, udp_probe=True):
    try:
        with open(route_path, encoding='ascii') as f:
            iface = default_route_interface(f.read())
        if iface:
            if psutil_module is None:
                import psutil as psutil_module
            for addr in psutil_module.net_if_addrs().get(iface, []):
                if addr.family == socket.AF_INET and _usable(addr.address):
                    return addr.address
    except Exception:
        pass
    if udp_probe:
        # No packet is sent: connect() on UDP only selects the outgoing interface.
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect(('192.0.2.1', 9))
                address = sock.getsockname()[0]
                if _usable(address):
                    return address
        except OSError:
            pass
    return None
