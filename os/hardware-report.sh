#!/usr/bin/env bash
# What this computer's hardware looks like to Linux: the checks for Leafdeck OS on real machines (Yoga Book 9 first).
# Prints a short report and saves it to ~/leafdeck-hardware-report.txt.
out="$HOME/leafdeck-hardware-report.txt"
{
  ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
  no() { printf '  \033[33m✗\033[0m %s\n' "$*"; }
  echo "Leafdeck OS hardware report — $(date '+%Y-%m-%d %H:%M')"
  echo "Model:  $(cat /sys/class/dmi/id/sys_vendor 2>/dev/null) $(cat /sys/class/dmi/id/product_version 2>/dev/null) ($(cat /sys/class/dmi/id/product_name 2>/dev/null))"
  echo "System: $(. /etc/os-release; echo "$PRETTY_NAME"), kernel $(uname -r)"
  echo "CPU:    $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs)"
  echo

  echo "Graphics and screens"
  for d in /sys/class/drm/card*-*; do
    [ -f "$d/status" ] || continue
    s=$(cat "$d/status"); m=$(head -1 "$d/modes" 2>/dev/null)
    [ "$s" = connected ] && ok "$(basename "$d"): connected, ${m:-no modes}" || echo "    $(basename "$d"): $s"
  done
  drv=$(basename "$(readlink -f /sys/class/drm/card0/device/driver 2>/dev/null)" 2>/dev/null)
  [ -n "$drv" ] && ok "GPU driver: $drv" || no "No GPU driver found"
  echo

  echo "Touch, pen and keyboard"
  devs=$(grep -E '^N: Name=' /proc/bus/input/devices | cut -d'"' -f2)
  echo "$devs" | grep -iqE 'touch' && ok "Touchscreen(s): $(echo "$devs" | grep -iE 'touch' | grep -viE 'pad' | paste -sd ', ' -)" || no "No touchscreen found"
  echo "$devs" | grep -iqE 'pen|stylus|wacom' && ok "Pen: $(echo "$devs" | grep -iE 'pen|stylus|wacom' | head -2 | paste -sd ', ' -)" || no "No pen found"
  echo "$devs" | grep -iqE 'touchpad' && ok "Touchpad" || no "No touchpad found"
  echo "$devs" | grep -iqE 'keyboard' && ok "Keyboard(s): $(echo "$devs" | grep -i keyboard | head -3 | paste -sd ', ' -)" || no "No keyboard found"
  echo

  echo "Network"
  if command -v nmcli >/dev/null; then
    nmcli -t -f DEVICE,TYPE,STATE device | while IFS=: read -r dev type state; do
      case "$type" in wifi|ethernet) [ "$state" = connected ] && ok "$type ($dev): connected" || echo "    $type ($dev): $state" ;; esac
    done
    nmcli -t -f TYPE device | grep -q '^wifi$' || no "No Wi-Fi adapter found"
  fi
  # Read from the kernel: bluetoothctl can wait forever when the Bluetooth service isn't running.
  ls /sys/class/bluetooth/ 2>/dev/null | grep -q hci && ok "Bluetooth adapter" || no "No Bluetooth adapter found"
  echo

  echo "Sound"
  if command -v wpctl >/dev/null && timeout 5 wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -qE '[0-9]+\.'; then
    ok "Outputs: $(timeout 5 wpctl status 2>/dev/null | sed -n '/Sinks:/,/Sources:/p' | grep -E '[0-9]+\.' | sed -E 's/.*[0-9]+\. //; s/\[vol.*//' | xargs | cut -c1-120)"
    echo "    (Play a sound in Settings → Sound to check the speakers actually make noise.)"
  else
    no "No sound output found"
  fi
  echo

  echo "Camera"
  ls /dev/video* >/dev/null 2>&1 && ok "Video devices: $(ls /dev/video* | wc -l)" || no "No camera device (common on Intel Core Ultra laptops: it needs the IPU6 driver)"
  echo

  echo "Power"
  bat=$(ls -d /sys/class/power_supply/BAT* 2>/dev/null | head -1)
  [ -n "$bat" ] && ok "Battery: $(cat "$bat/capacity")%, $(cat "$bat/status")" || no "No battery found"
  grep -q mem /sys/power/state 2>/dev/null && ok "Sleep: supported ($(cat /sys/power/mem_sleep 2>/dev/null))" || no "Sleep: not supported"
  ls /sys/class/backlight/ 2>/dev/null | grep -q . && ok "Brightness control: $(ls /sys/class/backlight | paste -sd ', ' -)" || no "No brightness control"
  ls /sys/bus/iio/devices/ 2>/dev/null | grep -q . && ok "Sensors (rotation, light): $(ls /sys/bus/iio/devices | wc -l)" || echo "    No rotation or light sensors found"
} | tee "$out"
echo
echo "Saved to $out"
