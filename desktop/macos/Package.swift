// swift-tools-version:5.9
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// MixOS Launcher: a Mac app that runs, watches and sets up local copies of
// MixOS. `./build.sh` wraps the executable into MixOS Launcher.app and a .dmg;
// see README.md.

import PackageDescription

let package = Package(
  name: "MixOSLauncher",
  platforms: [.macOS(.v13)],
  targets: [
    // Everything that isn't UI: running commands with the person's own PATH,
    // reading `npm run status -- --json` and ~/.mixos/instances.json. Tested.
    .target(name: "LauncherCore"),
    .executableTarget(name: "MixOSLauncher", dependencies: ["LauncherCore"]),
    .testTarget(name: "LauncherCoreTests", dependencies: ["LauncherCore"]),
  ]
)
