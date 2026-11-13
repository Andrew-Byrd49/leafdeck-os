#!/usr/bin/env python3
"""Real frames per second on each screen, for the Performance widget.

Leafdeck's own requestAnimationFrame rate says nothing about the screen (it stays near 60 while a screen shows 25, and
while nothing is being drawn at all), so this watches the kernel's display state: every new picture on a screen is a new
framebuffer on that screen's primary plane. It needs no root and doesn't disturb the compositor; it only reads.

Each line on stdin is a number of seconds to watch; each reply is one line of JSON, {"eDP-1": 58, "eDP-2": 3}, in frames
per second, or {} if the screens can't be read. It only polls while answering, and it ends when stdin closes.
"""
import ctypes
import fcntl
import glob
import json
import os
import re
import struct
import sys
import time

SET_CLIENT_CAP = 0x4010640D
GET_PLANE_RESOURCES = 0xC01064B5
GET_PROPERTY = 0xC04064AA
GET_OBJ_PROPERTIES = 0xC02064B9
CAP_UNIVERSAL_PLANES = 2
CAP_ATOMIC = 3
OBJECT_PLANE = 0xEEEEEEEE
OBJECT_CONNECTOR = 0xC0C0C0C0
PRIMARY = 1

# Often enough to see every frame of a 120 Hz screen (8.3 ms apart).
POLL_SECONDS = 0.003


class Card:
    def __init__(self, path):
        self.name = os.path.basename(path)
        self.fd = os.open(path, os.O_RDWR | os.O_CLOEXEC)
        self.prop_names = {}
        for cap in (CAP_UNIVERSAL_PLANES, CAP_ATOMIC):
            fcntl.ioctl(self.fd, SET_CLIENT_CAP, bytearray(struct.pack('QQ', cap, 1)), True)

    def prop_name(self, prop):
        if prop not in self.prop_names:
            b = bytearray(64)
            struct.pack_into('QQI', b, 0, 0, 0, prop)
            fcntl.ioctl(self.fd, GET_PROPERTY, b, True)
            self.prop_names[prop] = b[24:56].split(b'\0')[0].decode()
        return self.prop_names[prop]

    def props(self, obj, kind):
        b = bytearray(32)
        struct.pack_into('QQIII', b, 0, 0, 0, 0, obj, kind)
        fcntl.ioctl(self.fd, GET_OBJ_PROPERTIES, b, True)
        n = struct.unpack_from('I', b, 16)[0]
        ids = (ctypes.c_uint32 * n)()
        values = (ctypes.c_uint64 * n)()
        struct.pack_into('QQIII', b, 0, ctypes.addressof(ids), ctypes.addressof(values), n, obj, kind)
        fcntl.ioctl(self.fd, GET_OBJ_PROPERTIES, b, True)
        return {self.prop_name(ids[i]): values[i] for i in range(n)}

    def planes(self):
        b = bytearray(struct.pack('QI4x', 0, 0))
        fcntl.ioctl(self.fd, GET_PLANE_RESOURCES, b, True)
        n = struct.unpack('QI4x', b)[1]
        ids = (ctypes.c_uint32 * n)()
        b = bytearray(struct.pack('QI4x', ctypes.addressof(ids), n))
        fcntl.ioctl(self.fd, GET_PLANE_RESOURCES, b, True)
        return list(ids)

    def crtcs(self):
        """{crtc id: connector name} for the screens that are on. Names and ids come from sysfs because asking the kernel
        for a connector makes it probe the display, which is slow and can make a panel flicker."""
        out = {}
        for d in glob.glob(f'/sys/class/drm/{self.name}-*/'):
            try:
                with open(d + 'status') as f:
                    if f.read().strip() != 'connected':
                        continue
                with open(d + 'connector_id') as f:
                    connector = int(f.read())
                crtc = self.props(connector, OBJECT_CONNECTOR).get('CRTC_ID')
            except (OSError, ValueError):
                continue
            if crtc:
                out[crtc] = os.path.basename(d.rstrip('/')).split('-', 1)[1]
        return out


class Watch:
    """One screen's primary plane, read with a single call per poll."""

    def __init__(self, card, plane, props):
        names = list(props)
        self.fd = card.fd
        self.index = names.index('FB_ID')
        n = len(names)
        self.ids = (ctypes.c_uint32 * n)()
        self.values = (ctypes.c_uint64 * n)()
        self.buf = bytearray(32)
        struct.pack_into('QQIII', self.buf, 0, ctypes.addressof(self.ids), ctypes.addressof(self.values), n, plane, OBJECT_PLANE)

    def framebuffer(self):
        fcntl.ioctl(self.fd, GET_OBJ_PROPERTIES, self.buf, True)
        return self.values[self.index]


def cards():
    found = []
    for path in sorted(glob.glob('/dev/dri/card*')):
        if re.fullmatch(r'/dev/dri/card\d+', path):
            try:
                found.append(Card(path))
            except OSError:
                pass
    return found


def screens(open_cards):
    """{screen name: Watch}. Looked up for every sample, so a monitor plugged in or removed just shows up or goes."""
    out = {}
    for card in open_cards:
        crtcs = card.crtcs()
        for plane in card.planes():
            props = card.props(plane, OBJECT_PLANE)
            if props.get('type') == PRIMARY and props.get('CRTC_ID') in crtcs:
                out[crtcs[props['CRTC_ID']]] = Watch(card, plane, props)
    return out


def sample(open_cards, seconds):
    watches = screens(open_cards)
    last = {name: w.framebuffer() for name, w in watches.items()}
    flips = dict.fromkeys(watches, 0)
    start = time.monotonic()
    while time.monotonic() - start < seconds:
        time.sleep(POLL_SECONDS)
        for name, w in watches.items():
            fb = w.framebuffer()
            if fb != last[name]:
                # 0 is the screen going dark, not a frame.
                if fb and last[name]:
                    flips[name] += 1
                last[name] = fb
    elapsed = time.monotonic() - start
    return {name: round(flips[name] / elapsed) for name in sorted(flips)}


def main():
    open_cards = cards()
    for line in sys.stdin:
        try:
            seconds = min(2.0, max(0.1, float(line)))
            reply = sample(open_cards, seconds)
        except (OSError, ValueError):
            reply = {}
        print(json.dumps(reply), flush=True)


if __name__ == '__main__':
    main()
