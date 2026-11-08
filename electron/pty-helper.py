#!/usr/bin/env python3
"""Leafdeck terminal backend: runs a shell on a real pseudo-terminal and relays it over pipes.

Leafdeck (electron/terminal.cjs) talks to this over three pipes, so no native Node module is needed:
  stdin  -> keystrokes for the shell
  stdout <- everything the shell prints (raw bytes, escape codes included)
  fd 3   -> control lines, one JSON object per line: {"cols": 120, "rows": 40}
Exits with the shell's exit status.
"""
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios

shell = os.environ.get("LEAFDECK_TERM_SHELL") or os.environ.get("SHELL") or "/bin/bash"
cwd = os.environ.get("LEAFDECK_TERM_CWD") or os.path.expanduser("~")

pid, master = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["COLORTERM"] = "truecolor"
    os.environ["TERM_PROGRAM"] = "Leafdeck"
    try:
        os.chdir(cwd)
    except OSError:
        pass
    os.execvp(shell, [shell, "-l"])

def set_size(cols, rows):
    try:
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except (OSError, ValueError):
        pass

stdin = sys.stdin.fileno()
stdout = sys.stdout.fileno()
try:
    ctl = 3
    os.fstat(ctl)
except OSError:
    ctl = None

ctl_buf = b""
watch = [master, stdin] + ([ctl] if ctl is not None else [])
while True:
    try:
        ready, _, _ = select.select(watch, [], [])
    except InterruptedError:
        continue
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO:  # the shell exited
                break
            raise
        if not data:
            break
        os.write(stdout, data)
    if stdin in ready:
        data = os.read(stdin, 65536)
        if not data:  # Leafdeck closed the terminal
            os.kill(pid, signal.SIGHUP)
            watch.remove(stdin)
        else:
            os.write(master, data)
    if ctl is not None and ctl in ready:
        chunk = os.read(ctl, 4096)
        if not chunk:
            watch.remove(ctl)
            ctl = None
            continue
        ctl_buf += chunk
        while b"\n" in ctl_buf:
            line, ctl_buf = ctl_buf.split(b"\n", 1)
            try:
                msg = json.loads(line)
                if "cols" in msg and "rows" in msg:
                    set_size(msg["cols"], msg["rows"])
            except ValueError:
                pass

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
