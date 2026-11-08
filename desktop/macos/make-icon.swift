// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Renders MixOS Launcher's icon set from the MixOS logo: the mark, centred on
// a white rounded square laid out like every other macOS app icon. Run by
// build.sh, so the icon is always drawn from the repo's own public/logo.png:
//
//   swift make-icon.swift <logo.png> <AppIcon.iconset>

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3,
  let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
  let logo = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write("Usage: swift make-icon.swift <logo.png> <AppIcon.iconset>\n".data(using: .utf8)!)
  exit(1)
}
let iconset = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

/// One square icon, `pixels` wide. Apple's grid for a 1024 icon is an 824
/// square with a 185 corner radius, centred; everything here scales from it.
func render(_ pixels: Int) -> CGImage? {
  let size = CGFloat(pixels)
  guard let context = CGContext(
    data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  ) else { return nil }
  context.interpolationQuality = .high

  let inset = size * (100.0 / 1024.0)
  let tile = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
  let radius = size * (185.0 / 1024.0)
  let shape = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)

  // A soft shadow under the tile, as macOS draws its own icons; skipped at
  // the smallest sizes, where it only muddies the edge.
  if pixels >= 64 {
    context.saveGState()
    context.setShadow(offset: CGSize(width: 0, height: -size * 0.01), blur: size * 0.02,
                      color: CGColor(gray: 0, alpha: 0.25))
    context.addPath(shape)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fillPath()
    context.restoreGState()
  }
  context.addPath(shape)
  context.setFillColor(CGColor(gray: 1, alpha: 1))
  context.fillPath()

  // The mark at 62% of the tile, keeping its own proportions.
  let aspect = CGFloat(logo.height) / CGFloat(logo.width)
  let width = tile.width * 0.62
  let height = width * aspect
  context.draw(logo, in: CGRect(x: tile.midX - width / 2, y: tile.midY - height / 2, width: width, height: height))
  return context.makeImage()
}

func write(_ image: CGImage, _ name: String) {
  let url = iconset.appendingPathComponent(name)
  guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    return
  }
  CGImageDestinationAddImage(destination, image, nil)
  CGImageDestinationFinalize(destination)
}

// The names iconutil expects. The logo is 256 px wide, so 512@2x (1024) is
// left out rather than drawn from a blown-up mark.
for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1)] {
  guard let image = render(points * scale) else { exit(1) }
  write(image, scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png")
}
