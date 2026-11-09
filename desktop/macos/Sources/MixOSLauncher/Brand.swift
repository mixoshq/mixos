// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import AppKit
import SwiftUI

/// The MixOS logo, as build.sh copies it into the app from public/logo.png.
///
/// Run straight from `swift run`, there is no bundle around the binary and so
/// no logo; everything that shows it falls back to a system symbol rather than
/// failing.
enum Brand {
  static let logo: NSImage? = Bundle.main.url(forResource: "MixOSLogo", withExtension: "png")
    .flatMap(NSImage.init(contentsOf:))

  /// The mark as a menu bar template: its shape only, in whatever colour the
  /// menu bar draws templates, so it reads on light and dark bars alike.
  /// `alpha` dims it, for "nothing is running".
  static func menuBarImage(alpha: CGFloat) -> NSImage? {
    guard let logo else { return nil }
    let height: CGFloat = 16
    let size = NSSize(width: height * logo.size.width / logo.size.height, height: height)
    let image = NSImage(size: size, flipped: false) { rect in
      logo.draw(in: rect)
      NSColor.black.withAlphaComponent(alpha).set()
      rect.fill(using: .sourceIn)
      return true
    }
    image.isTemplate = true
    return image
  }
}

/// The logo at a given height, or the fallback symbol when there is none.
struct LogoView: View {
  var height: CGFloat

  var body: some View {
    if let logo = Brand.logo {
      Image(nsImage: logo)
        .resizable()
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(height: height)
        .accessibilityLabel("MixOS")
    } else {
      Image(systemName: "square.grid.3x3")
        .font(.system(size: height * 0.8))
        .foregroundStyle(.secondary)
    }
  }
}
