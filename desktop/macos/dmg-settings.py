# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# dmgbuild settings for MixOS Launcher's installer: the window a person sees
# when they open the .dmg — the app on the left, Applications on the right,
# the arrow between them drawn into the background by make-dmg-background.swift.
#
# build.sh passes every path and number with -D, from the one set of layout
# values it also hands the background renderer, so the icons sit on the arrow.
#
# dmgbuild writes the window's layout into the image's .DS_Store directly,
# rather than asking Finder to arrange a mounted window over AppleScript the
# way most DMG tools do. That needs no Automation permission and no window
# server, so it builds the same on a laptop, over SSH and in CI.

import os.path

app = defines["app"]
app_name = os.path.basename(app)

files = [app]
symlinks = {"Applications": "/Applications"}
hide_extensions = [app_name]

# The disk's own icon in Finder's sidebar and on the desktop: the app's.
icon = defines["volume_icon"]

# background.png; dmgbuild finds background@2x.png beside it and joins the two
# into one Retina-ready TIFF.
background = defines["background"]

# window_rect is Finder's whole window, title bar included — measured: a
# 660 x 420 rect opens a window whose frame is 660 x 420 — while the
# background and the icon positions are the area under it. So the window is
# that much taller, and the background shows in full. If a macOS draws a
# taller title bar, the background's bottom margin absorbs the difference.
TITLE_BAR = 28
width = int(defines["width"])
height = int(defines["height"])
window_rect = ((200, 120), (width, height + TITLE_BAR))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

icon_size = 128
text_size = 13
icon_y = int(defines["icon_y"])
icon_locations = {
    app_name: (int(defines["app_x"]), icon_y),
    "Applications": (int(defines["apps_x"]), icon_y),
}

format = "UDZO"
