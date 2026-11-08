#!/usr/bin/env python3
# Leafdeck OS desktop services on D-Bus, answered by Leafdeck's own UI instead of GTK windows (electron/osdesktop.cjs
# starts it and relays to the UI):
#   - the desktop portal backend (org.freedesktop.impl.portal.desktop.leafdeck): FileChooser, so every "Open…" and
#     "Save…" (a site's upload button, Leafdeck's own pickers, other programs) is Leafdeck's file picker; Print, so
#     every "Print…" is Leafdeck's print sheet; AppChooser, answered without asking; and Access, the "allow this app
#     to…" question (os/leafdeck.portal, os/leafdeck-portals.conf)
#   - the file manager (org.freedesktop.FileManager1): "Show in folder" opens Files
#   - the polkit authentication agent: when a program needs an administrator's password, Leafdeck asks for it
#
#   stdout: one JSON object per line: {"ready": name}, {"error": text}, {"request": {...}}, {"cancel": id},
#           {"show": {"kind": "items"|"folders", "paths": [...]}}, {"reply": seq, ...}
#   stdin:  {"answer": id, "result": {...}} (or "result": null for canceled), {"auth": id, "password": "...", "seq": n}
import grp
import json
import os
import pwd
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import warnings

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

warnings.filterwarnings("ignore", category=DeprecationWarning)  # register_object with plain callbacks (see notify-helper)

PORTAL_NAME = "org.freedesktop.impl.portal.desktop.leafdeck"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
FM_NAME = "org.freedesktop.FileManager1"
FM_PATH = "/org/freedesktop/FileManager1"
AGENT_PATH = "/org/leafdeck/PolicyKit1/AuthenticationAgent"
AGENT_HELPER = next((p for p in ("/usr/lib/polkit-1/polkit-agent-helper-1", "/usr/libexec/polkit-agent-helper-1") if os.path.exists(p)), None)

PORTAL_XML = """
<node>
  <interface name="org.freedesktop.impl.portal.FileChooser">
    <method name="OpenFile">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFile">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="SaveFiles">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.impl.portal.Print">
    <method name="PreparePrint">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="a{sv}" name="settings" direction="in"/><arg type="a{sv}" name="page_setup" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="Print">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="h" name="fd" direction="in"/><arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
  </interface>
  <interface name="org.freedesktop.impl.portal.AppChooser">
    <method name="ChooseApplication">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="as" name="choices" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
    <method name="UpdateChoices">
      <arg type="o" name="handle" direction="in"/><arg type="as" name="choices" direction="in"/>
    </method>
  </interface>
  <interface name="org.freedesktop.impl.portal.Access">
    <method name="AccessDialog">
      <arg type="o" name="handle" direction="in"/><arg type="s" name="app_id" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/><arg type="s" name="title" direction="in"/>
      <arg type="s" name="subtitle" direction="in"/><arg type="s" name="body" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="response" direction="out"/><arg type="a{sv}" name="results" direction="out"/>
    </method>
  </interface>
</node>
"""
REQUEST_XML = """
<node><interface name="org.freedesktop.impl.portal.Request"><method name="Close"/></interface></node>
"""
FM_XML = """
<node>
  <interface name="org.freedesktop.FileManager1">
    <method name="ShowFolders"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItems"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
    <method name="ShowItemProperties"><arg type="as" name="URIs" direction="in"/><arg type="s" name="StartupId" direction="in"/></method>
  </interface>
</node>
"""
AGENT_XML = """
<node>
  <interface name="org.freedesktop.PolicyKit1.AuthenticationAgent">
    <method name="BeginAuthentication">
      <arg type="s" name="action_id" direction="in"/><arg type="s" name="message" direction="in"/>
      <arg type="s" name="icon_name" direction="in"/><arg type="a{ss}" name="details" direction="in"/>
      <arg type="s" name="cookie" direction="in"/><arg type="a(sa{sv})" name="identities" direction="in"/>
    </method>
    <method name="CancelAuthentication"><arg type="s" name="cookie" direction="in"/></method>
  </interface>
</node>
"""

out_lock = threading.Lock()


def out(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


next_id = 1
pending = {}  # id -> {"done": fn(result), "cancel": fn()}


def new_request(kind, params, done, on_close=None):
    """Ask the UI. done(result) gets its answer (None when canceled)."""
    global next_id
    rid = next_id
    next_id += 1
    pending[rid] = {"done": done, "close": on_close}
    out({"request": {"id": rid, "kind": kind, **params}})
    return rid


def cancel_request(rid):
    """The asker gave up (a portal Request.Close, polkit's CancelAuthentication): close the UI's dialog."""
    entry = pending.pop(rid, None)
    if entry:
        out({"cancel": rid})
        entry["done"](None)


# ---------------- the portal ----------------

def path_of(uri_or_bytes):
    if isinstance(uri_or_bytes, (bytes, bytearray, list)):
        b = bytes(uri_or_bytes).rstrip(b"\0")
        return os.fsdecode(b) if b else ""
    s = str(uri_or_bytes)
    if s.startswith("file://"):
        return urllib.parse.unquote(urllib.parse.urlparse(s).path)
    return s


def uri_of(path):
    return "file://" + urllib.parse.quote(path)


def filters_of(raw):
    """a(sa(us)) -> [{"name", "globs": [...], "mimes": [...]}] (type 0 is a glob pattern, 1 a MIME type)."""
    res = []
    for name, rules in raw or []:
        res.append({
            "name": str(name),
            "globs": [str(p) for t, p in rules if t == 0],
            "mimes": [str(p) for t, p in rules if t == 1],
        })
    return res


def filter_variant(f):
    rules = [(0, g) for g in f.get("globs", [])] + [(1, m) for m in f.get("mimes", [])]
    return GLib.Variant("(sa(us))", (f.get("name", ""), rules))


def print_prepared(r):
    """The sheet's choices, the way GTK's print settings look on D-Bus."""
    if not r or "settings" not in r:
        return 1, {}
    variant = lambda v: GLib.Variant("d", float(v)) if isinstance(v, (int, float)) else GLib.Variant("s", str(v))
    return 0, {
        "settings": GLib.Variant("a{sv}", {k: variant(str(v)) for k, v in r["settings"].items()}),
        "page-setup": GLib.Variant("a{sv}", {k: variant(v) for k, v in r.get("pageSetup", {}).items()}),
        "token": GLib.Variant("u", int(r["token"])),
    }


def print_document(conn, handle, invocation, params):
    """A program's finished document, as a file descriptor: keep a copy for `lp` and let Leafdeck print it."""
    _handle, app_id, _parent, title, fd_index, options = params.unpack()
    fds = invocation.get_message().get_unix_fd_list()
    try:
        fd = fds.get(fd_index)
    except (GLib.Error, AttributeError):
        invocation.return_value(GLib.Variant("(ua{sv})", (2, {})))
        return

    def copy():  # the program may hand us a pipe: never hold up the other questions waiting on it
        path = None
        try:
            with os.fdopen(fd, "rb") as src, tempfile.NamedTemporaryFile(prefix="leafdeck-print-", delete=False) as dst:
                path = dst.name
                while chunk := src.read(1 << 20):
                    dst.write(chunk)
        except OSError:
            path = None
        GLib.idle_add(ready, path)

    def ready(path):
        if not path:
            invocation.return_value(GLib.Variant("(ua{sv})", (2, {})))
            return False

        def reply(r):
            try:
                os.unlink(path)
            except OSError:
                pass
            return (0, {}) if r and r.get("printed") else (1, {})

        start(conn, handle, invocation, "print-document", {"app": app_id, "title": title, "file": path, "token": int(options.get("token", 0))}, reply)
        return False

    threading.Thread(target=copy, daemon=True).start()


def choose_app(choices, options):
    """A program opens a file or link: the app it used last or else the computer's first choice, without asking."""
    usable = [c for c in choices if c not in ("org.gnome.Nautilus", "nautilus-autorun-software")]
    if not usable:
        return 2, {}
    last = options.get("last_choice")
    return 0, {"choice": GLib.Variant("s", last if last in usable else usable[0])}


def portal_call(conn, sender, path, iface, method, params, invocation):
    if iface == "org.freedesktop.impl.portal.AppChooser":
        if method == "ChooseApplication":
            _handle, _app_id, _parent, choices, options = params.unpack()
            invocation.return_value(GLib.Variant("(ua{sv})", choose_app(choices, options)))
        else:
            invocation.return_value(None)
        return
    if iface == "org.freedesktop.impl.portal.Print":
        if method == "PreparePrint":
            handle, app_id, _parent, title, _settings, _page_setup, _options = params.unpack()
            start(conn, handle, invocation, "print-settings", {"app": app_id, "title": title}, print_prepared)
        else:
            print_document(conn, params.get_child_value(0).get_string(), invocation, params)
        return
    if iface == "org.freedesktop.impl.portal.Access":
        handle, app_id, _parent, title, subtitle, body, options = params.unpack()
        req = {
            "app": app_id,
            "title": title,
            "subtitle": subtitle,
            "body": body,
            "grant": options.get("grant_label") or "Allow",
            "deny": options.get("deny_label") or "Don’t Allow",
        }
        start(conn, handle, invocation, "access", req, lambda r: (0 if r and r.get("allow") else 1, {}))
        return
    handle, app_id, _parent, title, options = params.unpack()
    raw = params.get_child_value(4)

    def bytestring(key):  # unpack() mangles 'ay' inside a{sv}; read those from the variant itself
        v = raw.lookup_value(key, GLib.VariantType.new("ay"))
        return path_of(v.get_data_as_bytes().get_data()) if v else None

    req = {"app": app_id, "title": title, "accept": options.get("accept_label", ""), "filters": filters_of(options.get("filters"))}
    cur = options.get("current_filter")
    if cur:
        req["currentFilter"] = filters_of([cur])[0]["name"]
    if bytestring("current_folder"):
        req["folder"] = bytestring("current_folder")
    if method == "OpenFile":
        req["multiple"] = bool(options.get("multiple"))
        req["directory"] = bool(options.get("directory"))
        kind = "open-file"
    elif method == "SaveFile":
        req["name"] = options.get("current_name", "")
        if bytestring("current_file"):
            f = bytestring("current_file")
            req["folder"], req["name"] = os.path.dirname(f), os.path.basename(f)
        kind = "save-file"
    else:
        files = raw.lookup_value("files", GLib.VariantType.new("aay"))
        req["files"] = [os.path.basename(path_of(files.get_child_value(i).get_data_as_bytes().get_data())) for i in range(files.n_children())] if files else []
        kind = "save-files"

    def answer(r):
        if not r or not r.get("paths"):
            return 1, {}
        results = {"uris": GLib.Variant("as", [uri_of(p) for p in r["paths"]]), "choices": GLib.Variant("a(ss)", [])}
        chosen = next((f for f in req["filters"] if f["name"] == r.get("filter")), None)
        if chosen:
            results["current_filter"] = filter_variant(chosen)
        return 0, results

    start(conn, handle, invocation, kind, req, answer)


def start(conn, handle, invocation, kind, req, to_reply):
    """Ask the UI for a portal request, with its Request object for Close, and reply to D-Bus with the answer."""
    reg = {"id": None}
    rid_box = {}

    def done(result):
        if reg["id"] is not None:
            conn.unregister_object(reg["id"])
            reg["id"] = None
        invocation.return_value(GLib.Variant("(ua{sv})", to_reply(result)))

    def on_request_call(_c, _s, _p, _i, _m, _params, inv):
        inv.return_value(None)
        cancel_request(rid_box["id"])

    try:
        node = Gio.DBusNodeInfo.new_for_xml(REQUEST_XML)
        reg["id"] = conn.register_object(handle, node.interfaces[0], on_request_call, None, None)
    except GLib.Error:
        reg["id"] = None  # the handle is taken or invalid; the request still works, just can't be closed from outside
    rid_box["id"] = new_request(kind, req, done)


# ---------------- the file manager ----------------

def fm_call(_conn, _sender, _path, _iface, method, params, invocation):
    uris, _startup = params.unpack()
    paths = [p for p in (path_of(u) for u in uris) if p.startswith("/")]
    kind = "folders" if method == "ShowFolders" else "items"
    if paths:
        out({"show": {"kind": kind, "paths": paths[:20]}})
    invocation.return_value(None)


# ---------------- the polkit agent ----------------

auths = {}  # cookie -> {"id": request id, "invocation", "user", "cookie"}


def choose_user(identities):
    """Whose password: yours if you're one of the people allowed (or in the group), otherwise the first one listed."""
    me = os.getuid()
    users = []
    for kind, details in identities:
        if kind == "unix-user" and "uid" in details:
            users.append(int(details["uid"]))
        elif kind == "unix-group" and "gid" in details:
            try:
                g = grp.getgrgid(int(details["gid"]))
            except KeyError:
                continue
            for name in g.gr_mem:
                try:
                    users.append(pwd.getpwnam(name).pw_uid)
                except KeyError:
                    pass
    if not users:
        return None
    uid = me if me in users else users[0]
    try:
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return None


def try_password(user, cookie, password):
    """Run polkit's setuid helper: it checks the password with PAM and tells polkit. Returns (ok, message)."""
    try:
        p = subprocess.Popen([AGENT_HELPER, user], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    except OSError as e:
        return False, str(e)
    p.stdin.write(cookie + "\n")
    p.stdin.flush()
    info = ""
    ok = False
    for line in p.stdout:
        line = line.rstrip("\n")
        if line.startswith("PAM_PROMPT_ECHO_OFF") or line.startswith("PAM_PROMPT_ECHO_ON"):
            p.stdin.write(password + "\n")
            p.stdin.flush()
        elif line.startswith("PAM_ERROR_MSG") or line.startswith("PAM_TEXT_INFO"):
            info = line.split(" ", 1)[1] if " " in line else ""
        elif line == "SUCCESS":
            ok = True
            break
        elif line == "FAILURE":
            break
    try:
        p.stdin.close()
    except OSError:
        pass
    p.wait()
    return ok, info


def agent_call(_conn, _sender, _path, _iface, method, params, invocation):
    if method == "CancelAuthentication":
        (cookie,) = params.unpack()
        a = auths.get(cookie)
        if a:
            cancel_request(a["id"])  # closes the dialog; BeginAuthentication answers Cancelled
        invocation.return_value(None)
        return
    action_id, message, _icon, details, cookie, identities = params.unpack()
    user = choose_user(identities)
    if not user or not AGENT_HELPER:
        invocation.return_dbus_error("org.freedesktop.PolicyKit1.Error.Failed", "No one here can approve this")
        return
    program = details.get("program") or details.get("polkit.message") or ""
    # Who's asking (polkit knows; Leafdeck says why when it's Claude: electron/adminwhy.cjs).
    pids = [int(p) for p in (details.get("polkit.subject-pid"), details.get("polkit.caller-pid")) if p and p.isdigit()]

    def done(result):
        a = auths.pop(cookie, None)
        if not a:
            return
        if result and result.get("ok"):
            invocation.return_value(None)
        else:
            invocation.return_dbus_error("org.freedesktop.PolicyKit1.Error.Cancelled", "Canceled")

    rid = new_request("auth", {"action": action_id, "message": message, "user": user, "program": program, "pids": pids, "me": user == pwd.getpwuid(os.getuid()).pw_name}, done)
    auths[cookie] = {"id": rid, "user": user, "cookie": cookie}


def on_password(rid, seq, password):
    """A password from the UI: try it on a thread (PAM takes a moment, longer after a wrong one), then reply."""
    a = next((x for x in auths.values() if x["id"] == rid), None)
    if not a:
        out({"reply": seq, "ok": False, "error": "This request is gone"})
        return

    def work():
        ok, info = try_password(a["user"], a["cookie"], password)

        def finish():
            out({"reply": seq, "ok": ok, "error": "" if ok else "That password didn’t work. Try again." if not info else info})
            if ok:
                entry = pending.pop(rid, None)
                if entry:
                    entry["done"]({"ok": True})
            return False

        GLib.idle_add(finish)

    threading.Thread(target=work, daemon=True).start()


def session_id(system):
    """This sign-in's logind session: the one Leafdeck runs in, or your graphical session when started outside it."""
    if os.environ.get("XDG_SESSION_ID"):
        return os.environ["XDG_SESSION_ID"]
    login = Gio.DBusProxy.new_sync(system, Gio.DBusProxyFlags.NONE, None, "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", None)
    try:
        (spath,) = login.call_sync("GetSessionByPID", GLib.Variant("(u)", (os.getpid(),)), Gio.DBusCallFlags.NONE, 3000, None).unpack()
    except GLib.Error:
        (upath,) = login.call_sync("GetUser", GLib.Variant("(u)", (os.getuid(),)), Gio.DBusCallFlags.NONE, 3000, None).unpack()
        user = Gio.DBusProxy.new_sync(system, Gio.DBusProxyFlags.NONE, None, "org.freedesktop.login1", upath, "org.freedesktop.login1.User", None)
        sid, _ = user.get_cached_property("Display").unpack()
        return sid
    s = Gio.DBusProxy.new_sync(system, Gio.DBusProxyFlags.NONE, None, "org.freedesktop.login1", spath, "org.freedesktop.login1.Session", None)
    return s.get_cached_property("Id").unpack()


system_bus = None  # held here: GLib keeps only a weak reference, and the agent goes away with the connection


def register_agent():
    global system_bus
    try:
        system = system_bus = Gio.bus_get_sync(Gio.BusType.SYSTEM, None)
        node = Gio.DBusNodeInfo.new_for_xml(AGENT_XML)
        system.register_object(AGENT_PATH, node.interfaces[0], agent_call, None, None)
        sid = session_id(system)
        subject = ("unix-session", {"session-id": GLib.Variant("s", sid)})
        system.call_sync(
            "org.freedesktop.PolicyKit1", "/org/freedesktop/PolicyKit1/Authority", "org.freedesktop.PolicyKit1.Authority",
            "RegisterAuthenticationAgent", GLib.Variant("((sa{sv})ss)", (subject, os.environ.get("LANG", "en_US.UTF-8"), AGENT_PATH)),
            None, Gio.DBusCallFlags.NONE, 5000, None,
        )
        out({"ready": f"polkit agent for session {sid}"})
    except Exception as e:  # noqa: BLE001  (no polkit, or another agent already runs for this session)
        out({"error": f"polkit agent: {e}"})


# ---------------- plumbing ----------------

def on_stdin(source, _cond):
    line = source.readline()
    if not line:  # Leafdeck went away
        loop.quit()
        return False
    try:
        msg = json.loads(line)
    except ValueError:
        return True
    if "answer" in msg:
        entry = pending.pop(int(msg["answer"]), None)
        if entry:
            entry["done"](msg.get("result"))
    elif "auth" in msg:
        on_password(int(msg["auth"]), msg.get("seq"), str(msg.get("password", "")))
    return True


def own(name, path, xml, handler):
    def on_bus(c, _n):
        node = Gio.DBusNodeInfo.new_for_xml(xml)
        for iface in node.interfaces:
            c.register_object(path, iface, handler, None, None)

    Gio.bus_own_name(
        Gio.BusType.SESSION, name, Gio.BusNameOwnerFlags.REPLACE, on_bus,
        lambda _c, n: out({"ready": n}), lambda _c, n: out({"error": f"{n} is taken by another program"}),
    )


loop = GLib.MainLoop()
own(PORTAL_NAME, PORTAL_PATH, PORTAL_XML, portal_call)
own(FM_NAME, FM_PATH, FM_XML, fm_call)
if "--no-agent" not in sys.argv:
    register_agent()
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
loop.run()
