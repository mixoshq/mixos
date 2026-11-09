// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Renders the background of MixOS Launcher's installer window: the MixOS mark
// and name, an arrow from where Finder shows the app to where it shows the
// Applications folder, and the one sentence that explains it. build.sh passes
// the window size and icon positions it also gives dmgbuild, so the arrow and
// the icons cannot drift apart:
//
//   swift make-dmg-background.swift <logo.png> <out-dir> <width> <height> <app-x> <apps-x> <icon-y>
//
// Writes background.png and background@2x.png; build.sh joins them into one
// TIFF so a Retina screen gets the sharp one.

import AppKit

let args = CommandLine.arguments
guard args.count == 8, let logo = NSImage(contentsOfFile: args[1]),
  let width = Double(args[3]), let height = Double(args[4]),
  let appX = Double(args[5]), let appsX = Double(args[6]), let iconY = Double(args[7])
else {
  FileHandle.standardError.write(
    "Usage: swift make-dmg-background.swift <logo.png> <out-dir> <width> <height> <app-x> <apps-x> <icon-y>\n"
      .data(using: .utf8)!)
  exit(1)
}
let outDir = URL(fileURLWithPath: args[2])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

/// Finder positions icons by their centres, from the top left, in points.
/// Everything below is laid out in those same points, at `scale`.
func render(scale: CGFloat) -> NSBitmapImageRep {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  let context = NSGraphicsContext(bitmapImageRep: rep)!
  NSGraphicsContext.current = context
  let cg = context.cgContext
  // Top-left origin, in points, like Finder.
  cg.translateBy(x: 0, y: height * scale)
  cg.scaleBy(x: scale, y: -scale)
  NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: true)

  // A quiet light ground: Finder draws the icon labels over it.
  NSGradient(colors: [NSColor(white: 1, alpha: 1), NSColor(srgbRed: 0.945, green: 0.957, blue: 0.973, alpha: 1)])!
    .draw(in: NSRect(x: 0, y: 0, width: width, height: height), angle: 90)

  // The mark and the name, centred together at the top.
  let title = NSAttributedString(string: "MixOS Launcher", attributes: [
    .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
    .foregroundColor: NSColor(srgbRed: 0.12, green: 0.14, blue: 0.16, alpha: 1),
  ])
  let markHeight: CGFloat = 34
  let markWidth = markHeight * logo.size.width / logo.size.height
  let gap: CGFloat = 12
  let headerWidth = markWidth + gap + title.size().width
  let headerX = (width - headerWidth) / 2
  let headerY: CGFloat = 58
  logo.draw(
    in: NSRect(x: headerX, y: headerY - markHeight / 2, width: markWidth, height: markHeight),
    from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
  title.draw(at: NSPoint(x: headerX + markWidth + gap, y: headerY - title.size().height / 2))

  // The arrow, in the mark's own teal-to-violet, between the two icons.
  let start = NSPoint(x: appX + 84, y: iconY)
  let end = NSPoint(x: appsX - 84, y: iconY)
  let arrow = NSBezierPath()
  arrow.move(to: start)
  arrow.line(to: end)
  arrow.move(to: NSPoint(x: end.x - 16, y: end.y - 14))
  arrow.line(to: end)
  arrow.line(to: NSPoint(x: end.x - 16, y: end.y + 14))
  arrow.lineWidth = 6
  arrow.lineCapStyle = .round
  arrow.lineJoinStyle = .round
  cg.saveGState()
  cg.addPath(arrow.cgPath.copy(strokingWithWidth: 6, lineCap: .round, lineJoin: .round, miterLimit: 10))
  cg.clip()
  NSGradient(
    starting: NSColor(srgbRed: 0.18, green: 0.77, blue: 0.78, alpha: 1),
    ending: NSColor(srgbRed: 0.43, green: 0.42, blue: 0.94, alpha: 1)
  )!.draw(in: NSRect(x: start.x, y: iconY - 20, width: end.x - start.x, height: 40), angle: 0)
  cg.restoreGState()

  // What to do, under the icons and their labels.
  func centred(_ text: String, size: CGFloat, weight: NSFont.Weight, gray: CGFloat, y: CGFloat) {
    let string = NSAttributedString(string: text, attributes: [
      .font: NSFont.systemFont(ofSize: size, weight: weight),
      .foregroundColor: NSColor(white: gray, alpha: 1),
    ])
    string.draw(at: NSPoint(x: (width - string.size().width) / 2, y: y - string.size().height / 2))
  }
  centred("Drag MixOS Launcher into Applications", size: 15, weight: .medium, gray: 0.24, y: iconY + 122)
  // The app is not notarized, so a downloaded copy is stopped the first time.
  // Since macOS 15 the way past that is in System Settings, not Control-click.
  centred(
    "Downloaded it? If macOS won’t open it the first time: System Settings › Privacy & Security › Open Anyway.",
    size: 11, weight: .regular, gray: 0.55, y: height - 30)

  NSGraphicsContext.current = nil
  return rep
}

for (scale, name) in [(1.0, "background.png"), (2.0, "background@2x.png")] {
  let rep = render(scale: CGFloat(scale))
  rep.size = NSSize(width: width, height: height)
  try rep.representation(using: .png, properties: [:])!.write(to: outDir.appendingPathComponent(name))
}
