#!/usr/bin/env python3
# Leafdeck OS notification service: owns org.freedesktop.Notifications on the session bus, so notify-send, Linux apps
# and system services can show notifications in Leafdeck (electron/osnotify.cjs starts it and shows the cards).
#   stdout: one JSON object per line: {"notify": {...}} or {"close": id}
#   stdin:  one JSON object per line: {"closed": id, "reason": 1|2|3} or {"action": id, "key": "..."}
import json
import sys
import warnings

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

# register_object with plain callbacks is deprecated in newer PyGObject, but it is the call that works on every version.
warnings.filterwarnings("ignore", category=DeprecationWarning)

XML = """
<node>
  <interface name="org.freedesktop.Notifications">
    <method name="GetCapabilities"><arg direction="out" type="as"/></method>
    <method name="Notify">
      <arg direction="in" type="s" name="app_name"/>
      <arg direction="in" type="u" name="replaces_id"/>
      <arg direction="in" type="s" name="app_icon"/>
      <arg direction="in" type="s" name="summary"/>
      <arg direction="in" type="s" name="body"/>
      <arg direction="in" type="as" name="actions"/>
      <arg direction="in" type="a{sv}" name="hints"/>
      <arg direction="in" type="i" name="expire_timeout"/>
      <arg direction="out" type="u" name="id"/>
    </method>
    <method name="CloseNotification"><arg direction="in" type="u" name="id"/></method>
    <method name="GetServerInformation">
      <arg direction="out" type="s" name="name"/>
      <arg direction="out" type="s" name="vendor"/>
      <arg direction="out" type="s" name="version"/>
      <arg direction="out" type="s" name="spec_version"/>
    </method>
    <signal name="NotificationClosed"><arg type="u" name="id"/><arg type="u" name="reason"/></signal>
    <signal name="ActionInvoked"><arg type="u" name="id"/><arg type="s" name="action_key"/></signal>
  </interface>
</node>
"""
PATH = "/org/freedesktop/Notifications"
IFACE = "org.freedesktop.Notifications"

conn = None
next_id = 1
live = set()


def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def emit(signal, params):
    if conn:
        conn.emit_signal(None, PATH, IFACE, signal, params)


def on_call(_conn, _sender, _path, _iface, method, params, invocation):
    global next_id
    if method == "GetCapabilities":
        return invocation.return_value(GLib.Variant("(as)", (["body", "actions"],)))
    if method == "GetServerInformation":
        return invocation.return_value(GLib.Variant("(ssss)", ("Leafdeck", "Leafdeck", "1.0", "1.2")))
    if method == "CloseNotification":
        (nid,) = params.unpack()
        if nid in live:
            live.discard(nid)
            out({"close": nid})
            emit("NotificationClosed", GLib.Variant("(uu)", (nid, 3)))
        return invocation.return_value(None)
    if method == "Notify":
        app, replaces, icon, summary, body, actions, hints, timeout = params.unpack()
        nid = replaces if replaces in live else next_id
        if nid == next_id:
            next_id += 1
        live.add(nid)
        urgency = hints.get("urgency", 1)
        out({
            "notify": {
                "id": nid,
                "app": app[:80],
                "icon": icon[:300],
                "summary": summary[:300],
                "body": body[:2000],
                # [key, label, key, label, ...] -> [[key, label], ...]
                "actions": [[actions[i], actions[i + 1]] for i in range(0, len(actions) - 1, 2)][:4],
                "urgency": urgency if isinstance(urgency, int) else 1,  # 0 low, 1 normal, 2 critical
                "timeout": timeout,
                "desktopEntry": str(hints.get("desktop-entry", ""))[:120],
            }
        })
        return invocation.return_value(GLib.Variant("(u)", (nid,)))
    invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)


def on_stdin(source, _cond):
    line = source.readline()
    if not line:  # Leafdeck went away
        loop.quit()
        return False
    try:
        msg = json.loads(line)
    except ValueError:
        return True
    if "action" in msg:
        nid = int(msg["action"])
        emit("ActionInvoked", GLib.Variant("(us)", (nid, str(msg.get("key", "default")))))
        msg = {"closed": nid, "reason": 2}
    if "closed" in msg:
        nid = int(msg["closed"])
        if nid in live:
            live.discard(nid)
            emit("NotificationClosed", GLib.Variant("(uu)", (nid, int(msg.get("reason", 2)))))
    return True


def on_bus(c, _name):
    global conn
    conn = c
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    c.register_object(PATH, node.interfaces[0], on_call, None, None)


def on_name(_c, name):
    out({"ready": name})


def on_lost(_c, name):
    out({"error": f"{name} is already taken by another notification service"})
    loop.quit()


loop = GLib.MainLoop()
Gio.bus_own_name(Gio.BusType.SESSION, IFACE, Gio.BusNameOwnerFlags.NONE, on_bus, on_name, on_lost)
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
loop.run()
