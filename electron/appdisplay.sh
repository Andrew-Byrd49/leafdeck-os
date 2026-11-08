#!/bin/sh
# Leafdeck OS's app display (electron/appdisplay.cjs starts it as the user unit leafdeck-apps). Programs started from
# Leafdeck's Terminal show their windows here instead of on the real screen, where cage would put them over Leafdeck,
# full screen and across every display. It is a second cage with no screen of its own (the headless backend) and its
# own Xwayland; Leafdeck draws it in an ordinary window, over VNC on a socket only this account can reach.
dir="$XDG_RUNTIME_DIR/leafdeck"

if [ "$1" = "--inside" ]; then
  # Inside the display's cage: give its sockets stable names for Leafdeck and the Terminal, then serve its picture.
  # The link lets Wayland programs started before a restart of the display find the new one.
  ln -sfn "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR/leafdeck-apps"
  printf 'WAYLAND_DISPLAY=leafdeck-apps\nDISPLAY=%s\n' "$DISPLAY" > "$dir/apps.env.new" && mv "$dir/apps.env.new" "$dir/apps.env"
  exec wayvnc --max-fps=60 --socket="$dir/apps.vncctl" --unix-socket "$dir/apps.vnc"
fi

mkdir -p "$dir"
rm -f "$dir/apps.env" "$dir/apps.vnc" "$dir/apps.vncctl"
unset WAYLAND_DISPLAY DISPLAY
export WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1
# In a virtual machine Leafdeck's compositor renders in software (os/leafdeck-session), and so does this one.
[ -n "$LEAFDECK_IN_VM" ] && export WLR_RENDERER=pixman
exec cage -d -- "$0" --inside
